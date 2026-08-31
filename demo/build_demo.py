#!/usr/bin/env python3
"""デモデータの生成と、それを使った site/data.demo.js のビルド。

`python3 demo/build_demo.py` で
  1. demo/data/ に架空の家計データ一式(raw明細・accounts.toml・rules.toml)を
     決定論的に生成し(既にあれば再利用。--regen で作り直し)、
  2. 本物のパイプライン(build.py)を KAKEIBO_* 環境変数でそこへ向けて実行し、
  3. 出力を site/data.demo.js に置く。

site/index.html は data.js(実データ)が無いときだけ data.demo.js に
フォールバックするので、クローン直後でも index.html を開けば
ダッシュボードが動く。データはすべて架空で、乱数は固定シード。

生成する世帯像(架空): 都内で働く会社員。給与はデモ給与明細CSV、
生活費はセゾンカード+PayPay、家賃・公共料金はゆうちょ口座振替、
毎月3万円を投信に積立(賞与月は株式も買う。約定履歴・評価額推移・
ポートフォリオの3ファイルを同じ値動きから起こす)、企業型DC
(デモDCポータル)と現金は残高のみ。
"""
from __future__ import annotations

import argparse
import calendar
import json
import os
import random
import subprocess
import sys
from datetime import date, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEMO_DATA = ROOT / "demo" / "data"
DEMO_LEDGER = ROOT / "demo" / "ledger"
OUT_JS = ROOT / "site" / "data.demo.js"

START = (2024, 9)       # 生成期間(この月初〜)
END = (2026, 8)         # (この月の20日まで)
RNG = random.Random(20240901)

INVEST_START = (2025, 1)    # 積立を始めた月
TSUMITATE = 30000           # 投信の毎月積立額
BONUS_INVEST = 100000       # 賞与月に株式へ回す額
BONUS_MONTHS = ((2025, 6), (2025, 12), (2026, 6))
PORTFOLIO_FROM = (2026, 6)  # ポートフォリオCSVを保存し始めた月(以前は評価額推移)
# UIは商品グループを銘柄名の指数名で判別する(tab-assets.js の IG)。
FUND = "デモ・全世界株式(オール・カントリー)"
STOCK, STOCK_CODE = "デモ電機", "9990"


def month_range() -> list[tuple[int, int]]:
    out, (y, m) = [], START
    while (y, m) <= END:
        out.append((y, m))
        y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def last_day(y: int, m: int) -> int:
    return calendar.monthrange(y, m)[1]


def biz_days(y: int, m: int) -> int:
    return sum(1 for d in range(1, last_day(y, m) + 1)
               if date(y, m, d).weekday() < 5)


def prev_month(y: int, m: int) -> tuple[int, int]:
    return (y - 1, 12) if m == 1 else (y, m - 1)


def iso(y: int, m: int, d: int) -> str:
    return f"{y:04d}-{m:02d}-{d:02d}"


# ---- 給与(デモ給与明細CSV) ----------------------------------------------

def salary_month(y: int, m: int) -> tuple[str, int]:
    """月例給与のCSV本文と手取り(銀行振込額)を返す。"""
    base = 280000 + 8000 * max(0, (y - 2025) + (1 if m >= 4 else 0))
    hours = round(RNG.uniform(4, 24) * 2) / 2
    overtime = round(hours * 2100)
    earns = [("基本給", base), ("住宅手当", 20000), ("通勤手当", 8000),
             ("時間外手当", overtime)]
    income_tax = 6000 + round(overtime * 0.1)
    deds = [("健康保険料", 15000), ("厚生年金保険料", 27000),
            ("確定拠出年金掛金", 11000),
            ("所得税", income_tax), ("住民税", 13000)]
    net = sum(v for _, v in earns) - sum(v for _, v in deds)
    py, pm = prev_month(y, m)
    work = [("定勤日数", biz_days(py, pm)), ("時間外時間", hours)]
    if RNG.random() < 0.4:
        work.append(("年次休暇日数", RNG.randint(1, 2)))
    if RNG.random() < 0.25:
        work.append(("半日休暇回数", 1))
    if m == 4:
        work.append(("有給付与日数", 20))    # 「付与」項目は支給月に帰属する
    lines = [f"デモ給与明細,{y}/{m:02d},給与"]
    lines += [f"支給,{n},{v}" for n, v in earns]
    lines += [f"控除,{n},{v}" for n, v in deds]
    lines += [f"勤務,{n},{v}" for n, v in work]
    lines.append(f"検算,銀行振込額,{net}")
    return "\n".join(lines) + "\n", net


def salary_bonus(y: int, m: int) -> tuple[str, int]:
    base = round((280000 + 8000 * (y - 2025 + 1)) * 2.2 / 1000) * 1000
    earns = [("賞与", base)]
    deds = [("健康保険料", round(base * 0.05)),
            ("厚生年金保険料", round(base * 0.0915)),
            ("所得税", round(base * 0.08))]
    net = base - sum(v for _, v in deds)
    lines = [f"デモ給与明細,{y}/{m:02d},賞与"]
    lines += [f"支給,{n},{v}" for n, v in earns]
    lines += [f"控除,{n},{v}" for n, v in deds]
    lines.append(f"検算,銀行振込額,{net}")
    return "\n".join(lines) + "\n", net


# ---- カード(セゾン月次請求CSV) ------------------------------------------

MERCHANTS = [
    # (店名, 単価範囲, 月あたり回数範囲, カテゴリの説明用)
    ("スーパーまるやま", (1200, 5800), (6, 10)),
    ("コンビニQ 駅前店", (300, 1400), (3, 8)),
    ("ドラッグつばき", (600, 3200), (1, 3)),
    ("らーめん一番星", (900, 1400), (1, 4)),
    ("カフェレストランそよかぜ", (1100, 2600), (0, 3)),
    ("書店いろは", (700, 2400), (0, 2)),
]


def card_month(y: int, m: int) -> tuple[list[tuple[str, str, int]], int]:
    """(利用日, 店名, 金額) の明細と合計を返す。"""
    rows: list[tuple[str, str, int]] = []
    for name, (lo, hi), (nlo, nhi) in MERCHANTS:
        for _ in range(RNG.randint(nlo, nhi)):
            d = RNG.randint(1, last_day(y, m))
            rows.append((iso(y, m, d).replace("-", "/"), name,
                         RNG.randint(lo, hi)))
    rows.append((f"{y}/{m:02d}/{RNG.randint(1, 5):02d}",
                 "ネオフリックス(月額)", 1490))
    rows.append((f"{y}/{m:02d}/{RNG.randint(10, 15):02d}",
                 "デモモバイル 通信料", 2970))
    if RNG.random() < 0.15:
        rows.append((f"{y}/{m:02d}/{RNG.randint(1, 28):02d}",
                     "家電のデンキランド", RNG.randint(6000, 42000)))
    rows.sort()
    return rows, sum(a for _, _, a in rows)


def write_saison(y: int, m: int, rows, total: int) -> tuple[str, int]:
    """利用月 (y,m) の請求CSV。支払日は翌々月4日。"""
    py, pm = (y, m + 2) if m <= 10 else (y + 1, m - 10)
    pay = iso(py, pm, 4)
    lines = ["カード名称,ＳＡＩＳＯＮ　ＣＡＲＤ　Ｄｉｇｉｔａｌ",
             f"お支払日,{pay.replace('-', '/')}",
             f"今回ご請求額,{total:010d}", "",
             "利用日,ご利用店名及び商品名,本人・家族区分,支払区分名称,"
             "締前入金区分,利用金額,備考"]
    lines += [f"{d},{name},,1回,,{amount}," for d, name, amount in rows]
    (DEMO_DATA / "raw" / "saison").mkdir(parents=True, exist_ok=True)
    (DEMO_DATA / "raw" / "saison" / f"saison_{y}{m:02d}.csv").write_text(
        "\n".join(lines) + "\n", encoding="utf-8")
    return pay, total


# ---- PayPay --------------------------------------------------------------

PAYPAY_SHOPS = [("カフェあおば", (350, 800)), ("ベーカリーひだまり", (250, 900)),
                ("コンビニQ 駅前店", (150, 1200)), ("自販機", (120, 180)),
                ("デリバリーうまか便", (1300, 2600))]


def paypay_month(y: int, m: int) -> list[tuple[str, str, str, int]]:
    """(日付, 取引内容, 取引先/取引方法, 金額) のリスト(チャージ除く)。"""
    rows = []
    for _ in range(RNG.randint(8, 14)):
        shop, (lo, hi) = RNG.choice(PAYPAY_SHOPS)
        d = RNG.randint(1, last_day(y, m))
        rows.append((iso(y, m, d), "支払い", shop, RNG.randint(lo, hi)))
    return sorted(rows)


# ---- 生成本体 ------------------------------------------------------------

# ---- SBI証券(約定履歴・評価額推移・ポートフォリオ) ----------------------

def _trade_row(d: str, name: str, code: str, market: str, action: str,
               qty, price, amount: int) -> str:
    settle = (date.fromisoformat(d) + timedelta(days=2)).isoformat()
    return (f'"{d.replace("-", "/")}","{name}","{code}","{market}",{action},'
            f'"--"," NISA(つ) ","--",{qty},{price},--,--,'
            f'"{settle.replace("-", "/")}",{amount}')


def _portfolio_csv(units: int, nav: int, fund_cost: int, shares: int,
                   price: int, share_cost: int, share_day: str) -> str:
    """保有スナップショットCSV(株式1銘柄+投信1本+総合計)。"""
    def block(head: str, cols: str, row: str, value: int, pl: int) -> list[str]:
        return [head, cols, row, head.replace("（", "(").replace("）", ")")
                .strip('"') + "合計",
                '"評価額","含み損益","含み損益（％）","前日比","前日比（％）",',
                f"{value},{pl:+d},{pl / max(1, value - pl) * 100:+.2f},"
                f"{round(value * 0.004):+d},+0.40,"]
    fund_value = round(units * nav / 10000)
    fund_pl = fund_value - fund_cost
    fund_unit_cost = round(fund_cost / max(1, units) * 10000)
    share_value = shares * price
    share_pl = share_value - share_cost
    share_unit_cost = round(share_cost / max(1, shares))
    lines = ['"ポートフォリオ一覧",', '"一括表示",', '"総件数：2件",']
    lines += block(
        '"株式（現物/特定預り）",',
        '"銘柄（コード）","買付日","数量","取得単価","現在値","前日比",'
        '"前日比（％）","損益","損益（％）","評価額",',
        f'"{STOCK_CODE} {STOCK}","{share_day.replace("-", "/")}",{shares},'
        f'{share_unit_cost},{price},+10,+0.60,{share_pl:+d},'
        f'{share_pl / max(1, share_cost) * 100:+.2f},{share_value},',
        share_value, share_pl)
    lines += block(
        '"投資信託（金額/NISA預り（つみたて投資枠））",',
        '"ファンド名","買付日","数量","取得単価","現在値","前日比",'
        '"前日比（％）","損益","損益（％）","評価額",',
        f'"{FUND}","----/--/--",{units},{fund_unit_cost},{nav},+12,+0.11,'
        f'{fund_pl:+d},{fund_pl / max(1, fund_cost) * 100:+.2f},{fund_value},',
        fund_value, fund_pl)
    total, total_pl = fund_value + share_value, fund_pl + share_pl
    lines += ['"総合計",',
              '"評価額","含み損益","含み損益（％）","前日比","前日比（％）",',
              f"{total},{total_pl:+d},"
              f"{total_pl / max(1, total - total_pl) * 100:+.2f},+800,+0.10"]
    return "\n".join(lines) + "\n"


def write_sbi(raw: Path, months: list[tuple[int, int]]) -> None:
    """約定履歴・評価額推移・ポートフォリオを同じ値動きから作る。

    3ファイルは同じ保有を別の角度から見たものなので、別々に乱数を振ると
    元本と評価額・残高アンカーが食い違う。ここで1本の系列から起こす。
    評価額推移は「ポートフォリオCSVを保存し始める前」の期間だけを埋める
    (パーサのdocstring参照)。
    """
    nav, price = 10000, 1500        # 投信の基準価額(1万口あたり)・株価
    units = fund_cost = shares = share_cost = 0
    share_day = ""
    trades: list[str] = []
    vlines: list[str] = []
    for y, m in months:
        if (y, m) < INVEST_START:
            continue
        nav = round(nav * (1 + RNG.uniform(-0.018, 0.030)))
        price = round(price * (1 + RNG.uniform(-0.035, 0.05)))
        d = iso(y, m, 2)
        u = round(TSUMITATE / nav * 10000)
        units += u
        fund_cost += TSUMITATE
        trades.append(_trade_row(d, FUND, "", "", "投信金額買付",
                                 u, nav, TSUMITATE))
        if (y, m) in BONUS_MONTHS:
            share_day = iso(y, m, 13)
            n = BONUS_INVEST // price
            shares += n
            share_cost += n * price
            trades.append(_trade_row(share_day, STOCK, STOCK_CODE, "東証",
                                     "株式現物買", n, price, n * price))
        if m in (5, 11):    # 分配金(再投資型なので入金でなく買付として出る)
            amount = round(units * nav / 10000 * 0.004)
            u = round(amount / nav * 10000)
            units += u
            fund_cost += amount
            trades.append(_trade_row(iso(y, m, 18), FUND, "", "",
                                     "投信分配金再投資買付", u, nav, amount))
        end_d = iso(y, m, 20 if (y, m) == END else last_day(y, m))
        if (y, m) < PORTFOLIO_FROM:
            value = round(units * nav / 10000) + shares * price
            vlines.append(f"{end_d.replace('-', '/')},{value}")
        else:
            (raw / "sbi" / f"{end_d}_portfolio.csv").write_text(
                _portfolio_csv(units, nav, fund_cost, shares, price,
                               share_cost, share_day), encoding="utf-8")
    header = [
        "", "約定履歴照会 ", "",
        "商品指定,約定開始年月日,約定終了年月日,明細数,明細指定開始,明細指定終了",
        f'"すべての商品","{INVEST_START[0]}年{INVEST_START[1]:02d}月01日",'
        f'"{END[0]}年{END[1]:02d}月20日","{len(trades)}","1","{len(trades)}"',
        "", "（注）明細数はご指定された期間の合計です。", "",
        "約定日,銘柄,銘柄コード,市場,取引,期限,預り,課税,約定数量,約定単価,"
        "手数料/諸経費等,税額,受渡日,受渡金額/決済損益",
    ]
    dl = iso(END[0], END[1], 20).replace("-", "")
    (raw / "sbi" / f"OrderRefer{dl}120000.csv").write_text(
        "\n".join(header + trades) + "\n", encoding="utf-8")
    (raw / "sbi" / "value_history.csv").write_text(
        "\n".join(vlines) + "\n", encoding="utf-8")


def generate() -> None:
    if DEMO_DATA.exists():
        import shutil
        shutil.rmtree(DEMO_DATA)
    raw = DEMO_DATA / "raw"
    for sub in ("yucho", "saison", "paypay", "demo", "sbi", "manual"):
        (raw / sub).mkdir(parents=True, exist_ok=True)

    months = month_range()
    salary_net: dict[tuple[int, int], int] = {}
    bonus_net: dict[tuple[int, int], int] = {}
    bills: dict[tuple[int, int], int] = {}   # 支払月 → 請求額
    paypay_rows: list[tuple[str, str, str, int]] = []
    paypay_charge: dict[tuple[int, int], int] = {}

    for y, m in months:
        body, net = salary_month(y, m)
        (raw / "demo" / f"kyuyo_{y}{m:02d}.csv").write_text(
            body, encoding="utf-8")
        salary_net[(y, m)] = net
        if m in (6, 12):
            body, bnet = salary_bonus(y, m)
            (raw / "demo" / f"shoyo_{y}{m:02d}.csv").write_text(
                body, encoding="utf-8")
            bonus_net[(y, m)] = bnet
        rows, total = card_month(y, m)
        pay, _ = write_saison(y, m, rows, total)
        bills[(int(pay[:4]), int(pay[5:7]))] = total
        month_pay = paypay_month(y, m)
        paypay_rows += month_pay
        # 月初チャージ額は当月支払い合計を千円単位で丸めて確保(残高は負にならない)
        paypay_charge[(y, m)] = -(-sum(a for *_, a in month_pay) // 1000) * 1000

    # PayPay CSV(全期間1ファイル・新しい順)
    pp_lines = ["取引日,出金金額（円）,入金金額（円）,海外出金金額,通貨,"
                "変換レート（円）,利用国,取引内容,取引先,取引方法,支払い区分,"
                "利用者,取引番号"]
    seq = 0
    pp_all: list[tuple[str, str]] = []
    for y, m in months:
        d = iso(y, m, 1)
        seq += 1
        pp_all.append((d, f"{d} 09:00:00,-,{paypay_charge[(y, m)]},-,-,-,-,"
                       f"チャージ,PayPay,ゆうちょ銀行 *****01,-,-,{seq:020d}"))
    for d, kind, shop, amount in paypay_rows:
        seq += 1
        pp_all.append((d, f"{d.replace('-', '/')} "
                       f"{RNG.randint(8, 21):02d}:{RNG.randint(0, 59):02d}:00,"
                       f"{amount},-,-,-,-,-,{kind},{shop},PayPay残高,-,-,"
                       f"{seq:020d}"))
    pp_all.sort(reverse=True)
    (raw / "paypay" / "paypay_all.csv").write_text(
        "\n".join(pp_lines + [r for _, r in pp_all]) + "\n", encoding="utf-8")

    # ゆうちょCSV(四半期ごと・前月1ヶ月を重複させて冪等取込のデモにする)
    txn_by_day: dict[str, list[tuple[str, str, int]]] = {}

    def add(d: str, d1: str, d2: str, amount: int) -> None:
        txn_by_day.setdefault(d, []).append((d1, d2, amount))

    for y, m in months:
        add(iso(y, m, 1), "ＲＴ", "(PAYPAY)", -paypay_charge[(y, m)])
        if (y, m) >= INVEST_START:
            add(iso(y, m, 1), "振替", "SBIｼｮｳｹﾝ", -TSUMITATE)
        if (y, m) in BONUS_MONTHS:
            add(iso(y, m, 12), "振替", "SBIｼｮｳｹﾝ", -BONUS_INVEST)
        if (y, m) in bills:
            add(iso(y, m, 4), "自払", "ｾｿﾞﾝ", -bills[(y, m)])
        add(iso(y, m, RNG.randint(12, 16)), "自払", "デンキ",
            -RNG.randint(5200, 9200 if m in (1, 2, 8) else 6800))
        add(iso(y, m, RNG.randint(15, 20)), "自払", "ガス",
            -RNG.randint(2400, 6200 if m in (1, 2, 12) else 3600))
        if m % 2 == 0:
            add(iso(y, m, RNG.randint(20, 24)), "自払", "スイドウ",
                -RNG.randint(3900, 4700))
        if m % 2 == 1:
            add(iso(y, m, RNG.randint(5, 25)), "ＡＴＭ", "お引き出し", -20000)
        if m in (3, 9):
            add(iso(y, m, 20), "利息", "", 14)
        add(iso(y, m, 25), "給与", "", salary_net[(y, m)])
        if (y, m) in bonus_net:
            add(iso(y, m, 10), "賞与", "", bonus_net[(y, m)])
        add(iso(y, m, 27), "家賃", "ｶｸｳﾊｲﾂ", -78000)

    days = sorted(txn_by_day)
    days = [d for d in days if d <= iso(END[0], END[1], 20)]
    balance = 412345
    rows_all: list[tuple[str, str]] = []   # (date, csv行)
    for d in days:
        for i, (d1, d2, amount) in enumerate(txn_by_day[d], start=1):
            balance += amount
            nid = d.replace("-", "") + f"{i:07d}"
            in_s = str(amount) if amount > 0 else ""
            out_s = str(-amount) if amount < 0 else ""
            rows_all.append(
                (d, f"{d.replace('-', '')},{nid},{in_s},{out_s},"
                    f"{d1},{d2},{balance},"))

    header = ("取引日,入出金明細ＩＤ,受入金額（円）,払出金額（円）,"
              "詳細１,詳細２,現在（貸付）高,")
    q_start = months[0]
    while q_start <= END:
        qy, qm = q_start
        q_end_m = (qy + 1, qm + 2 - 12) if qm + 2 > 12 else (qy, qm + 2)
        ov_y, ov_m = prev_month(qy, qm)   # 1ヶ月の重複期間
        lo = iso(ov_y, ov_m, 1) if (ov_y, ov_m) >= months[0] else iso(qy, qm, 1)
        hi = iso(q_end_m[0], q_end_m[1], last_day(*q_end_m))
        out_d = min(hi, iso(END[0], END[1], 20))
        wareki = int(out_d[:4]) - 2018
        sel = [r for d, r in rows_all if lo <= d <= hi]
        if sel:
            lines = ["お客さま口座情報",
                     f'現在高：,"{balance}",円,',
                     f"出力日時：令和 {wareki:02d} 年 {int(out_d[5:7]):02d} 月"
                     f" {int(out_d[8:10]):02d} 日 12 時 00 分",
                     "お客さま口座番号：10000-99999999",
                     "照会対象：期間指定",
                     f"明細件数：{len(sel)}",
                     header] + sel
            name = f"yucho_{lo.replace('-', '')}_{hi.replace('-', '')}.csv"
            (raw / "yucho" / name).write_text("\n".join(lines) + "\n",
                                              encoding="utf-8")
        ny, nm = q_end_m
        q_start = (ny + 1, 1) if nm == 12 else (ny, nm + 1)

    # 企業型DC(デモDCポータルHTML): 四半期末+期間末のスナップショット
    dc_dates = [(y, m) for y, m in months if m in (3, 6, 9, 12)] + [END]
    hire = (2024, 4)   # 拠出開始(生成期間より前から積んでいる想定)
    drift = 0.0
    for y, m in dc_dates:
        n_months = (y - hire[0]) * 12 + (m - hire[1]) + 1
        contrib = 22000 * n_months
        drift += RNG.uniform(-0.012, 0.028)
        value = round(contrib * (1 + max(-0.08, drift)))
        d = iso(y, m, 20 if (y, m) == END else last_day(y, m))
        html = ("<!DOCTYPE html>\n<html lang=\"ja\"><head>"
                "<meta charset=\"utf-8\">\n"
                "<title>デモDCポータル - 資産状況</title></head>\n<body>\n"
                "<h1>デモDCポータル</h1>\n"
                f"<p>照会日時: {y}年{int(d[5:7])}月{int(d[8:10])}日 09時00分"
                "</p>\n<table>\n"
                f"<tr><td>資産評価額合計</td><td><b>{value:,}円</b></td></tr>\n"
                f"<tr><td>拠出金累計</td><td><b>{contrib:,}円</b></td></tr>\n"
                "</table>\n</body></html>\n")
        (raw / "demo" / f"dc_{d.replace('-', '')}.html").write_text(
            html, encoding="utf-8")

    write_sbi(raw, months)

    # 現金(手入力残高CSV)
    mlines = ["日付,口座,残高,メモ"]
    for i, (y, m) in enumerate(months):
        if i % 2 == 0:
            d = iso(y, m, RNG.randint(6, 26)) if (y, m) != END \
                else iso(y, m, 15)
            mlines.append(f"{d},cash,{RNG.randint(8, 32) * 1000},財布")
    (raw / "manual" / "balances.csv").write_text(
        "\n".join(mlines) + "\n", encoding="utf-8")

    (DEMO_DATA / "accounts.toml").write_text(ACCOUNTS_TOML, encoding="utf-8")
    (DEMO_DATA / "rules.toml").write_text(RULES_TOML, encoding="utf-8")


ACCOUNTS_TOML = """\
# デモ用の口座台帳(架空)。書式の実例を兼ねる。
[accounts.yucho]
name = "ゆうちょ銀行"
kind = "asset"
group = "銀行"
update_interval_days = 35
howto = "ゆうちょダイレクト → 入出金明細 → CSVダウンロード"

[accounts.saison]
name = "セゾンカード"
kind = "liability"
debit_account = "yucho"
update_interval_days = 40
howto = "Netアンサー → ご利用明細 → CSVダウンロード"

[accounts.paypay]
name = "PayPay"
kind = "asset"
group = "決済・電子マネー"
update_interval_days = 90
howto = "アプリ → 取引履歴のダウンロード"

[accounts.kyuyo]
name = "給与清算"
kind = "asset"
group = "給与"

[accounts.dc]
name = "企業型DC"
kind = "asset"
group = "年金"
update_interval_days = 120
howto = "デモDCポータル → 資産状況を開いてHTML保存"

[accounts.sbisec]
name = "SBI証券"
kind = "asset"
group = "証券"
update_interval_days = 90

[accounts.cash]
name = "現金"
kind = "asset"
group = "現金"
"""

RULES_TOML = """\
# デモ用の分類ルール(架空)。書式の実例を兼ねる。

# ---- 振替(内部移動。収支から除外) ----
# パターンは正規化後の摘要(半角カナ→全角等)に対して評価される
[[transfer]]
account = "yucho"
pattern = '^自払 セゾン$'
counter = "saison"

[[transfer]]
account = "yucho"
pattern = '^RT \\(PAYPAY\\)$'
counter = "paypay"

[[transfer]]
account = "paypay"
pattern = '^チャージ ゆうちょ銀行'
counter = "yucho"

[[transfer]]
account = "yucho"
pattern = '^(給与|賞与)$'
counter = "kyuyo"

[[transfer]]
account = "yucho"
pattern = '^振替 SBIショウケン$'
counter = "sbisec"

[[transfer]]
account = "yucho"
pattern = '^ATM お引き出し$'
counter = "cash"

[[transfer]]
account = "kyuyo"
pattern = '^確定拠出年金掛金$'
counter = "dc"

# ---- 分類 ----
[[rule]]
account = "kyuyo"
pattern = '保険料'
category = "社会保険料"

[[rule]]
account = "kyuyo"
pattern = '所得税|住民税'
category = "税金"

[[rule]]
account = "kyuyo"
pattern = '.'
category = "給与"

[[rule]]
pattern = '^家賃'
category = "住居"

[[rule]]
pattern = '^自払 (デンキ|ガス|スイドウ)$'
category = "水道光熱"

[[rule]]
pattern = 'ネオフリックス'
category = "娯楽・サブスク"

[[rule]]
pattern = 'デモモバイル'
category = "通信"

[[rule]]
pattern = 'スーパーまるやま|コンビニQ|ベーカリー|自販機|デリバリー'
category = "食費"

[[rule]]
pattern = 'らーめん|カフェ'
category = "外食"

[[rule]]
pattern = 'ドラッグつばき'
category = "日用品"

[[rule]]
pattern = '書店いろは'
category = "教養"

[[rule]]
pattern = 'デンキランド'
category = "家電・家具"

[[rule]]
pattern = '^利息$'
category = "利息"
type = "income"

[[rule]]
pattern = '^ポイント'
category = "ポイント"

# ---- サブスク宣言 ----
[[recurring]]
name = "動画配信"
pattern = 'ネオフリックス'

[[recurring]]
name = "携帯回線"
pattern = 'デモモバイル'

[[recurring]]
name = "家賃"
pattern = '^家賃'
kind = "fixed"

# ---- 支出の中分類(チャートの束ね方) ----
[category_groups]
"固定費" = ["住居", "水道光熱", "通信", "娯楽・サブスク"]
"食・日用" = ["食費", "日用品"]
"ゆとり" = ["外食", "教養", "家電・家具"]
"法定控除" = ["社会保険料", "税金"]
"""


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--regen", action="store_true",
                    help="demo/data を作り直す(既定は既存を再利用)")
    ap.add_argument("--out", default=str(OUT_JS),
                    help="出力する data.demo.js のパス")
    args = ap.parse_args(argv)
    if args.regen or not DEMO_DATA.exists():
        generate()
        print(f"生成: {DEMO_DATA.relative_to(ROOT)}")
    out = Path(args.out)
    env = dict(os.environ,
               KAKEIBO_DATA=str(DEMO_DATA),
               KAKEIBO_LEDGER=str(DEMO_LEDGER),
               KAKEIBO_DATA_JS=str(out))
    r = subprocess.run([sys.executable, str(ROOT / "build.py")], env=env)
    if r.returncode != 0:
        return r.returncode
    # data.js(実データ)があるときはそちらを使わせる。const だと再宣言エラーに
    # なるため、未定義のときだけ効くグローバル代入に書き換える。
    # ビルド実行ログは実行時刻メタデータなのでデモには埋め込まない
    js = out.read_text(encoding="utf-8")
    body = js.removeprefix("const DATA = ").rstrip().removesuffix(";")
    data = json.loads(body)
    data["build_log"] = []
    # 生成時刻(時分)は実行環境のメタデータなので日付だけ残す
    data["generated_at"] = str(data.get("generated_at", ""))[:10]
    out.write_text("// デモデータ(架空・自動生成)。実データ site/data.js が"
                   "あればそちらが優先される。\n"
                   "globalThis.DATA ??= "
                   + json.dumps(data, ensure_ascii=False,
                                separators=(",", ":"))
                   + ";\n", encoding="utf-8")
    print(f"出力: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
