#!/usr/bin/env python3
"""data/raw/ 配下の原本CSV/HTMLから ledger/ と site/data.js を決定論的に再生成する。

使い方:
    python3 build.py          # 全再生成(ledger/ と data.js は毎回全削除→全再生成)
    python3 build.py --check  # 生成せず取込サマリと検証のみ表示(inboxも移動しない)

raw/ への唯一の書込経路は organize_inbox(inbox からの移動・改名のみ。
中身は書き換えない)。テスト互換のため model と parsers の公開名は
build からも参照できるよう再エクスポートしている。
"""
from __future__ import annotations

import argparse
import calendar
import hashlib
import json
import re
import sys
import tomllib
import traceback
from collections import defaultdict
from datetime import date, datetime
from statistics import median

from model import *      # noqa: F401,F403 (再エクスポート込み)
from parsers import *    # noqa: F401,F403


def dedup(batches: list[list[Txn]]) -> list[Txn]:
    """ファイル横断の重複排除。同じファイルを2回置いても、期間の重なる
    ファイルを追加しても増殖しない(冪等取込)。batches はファイルごとの
    パース結果(同日同額の連番はファイル内で閉じて振る必要がある)。

    照合キー:
    - ゆうちょ: (口座, 日付, 金額, 同日同額の連番)。CSVとHTML(通帳未記入分)で
      同じ取引が両方に載り、摘要の表記が媒体で異なる(半角カナ vs 全角+分離濁点)
      上、native_id はCSVにしかないため、摘要・IDをキーに含めない。
      重複時は情報の多い方(native_id持ち=CSV)を残す。
    - ソース固有の一意IDを持つもの(paypay取引番号): (口座, native_id)。
    - その他: (口座, 日付, 金額, 正規化摘要, 連番)。
    連番はファイル内で古い順に振るため、取込範囲が違っても同日内の並びが
    保たれる限り一致する。txn.id は照合キーのハッシュ(再生成しても安定)。
    """
    # ファイルごと・(口座,日付,金額)ごとに古い順で連番を振る
    occ_of: dict[int, int] = {}
    for batch in batches:
        counters: dict[tuple, int] = defaultdict(int)
        for t in batch:
            k = (t.account, t.date, t.amount)
            occ_of[id(t)] = counters[k]
            counters[k] += 1

    kept: dict[str, Txn] = {}
    for t in (t for batch in batches for t in batch):
        occ = occ_of[id(t)]
        if t.account == "yucho":
            match_key = f"yucho|{t.date}|{t.amount}|{occ}"
        elif t.native_id:
            match_key = f"{t.account}|native|{t.native_id}"
        else:
            match_key = f"{t.account}|{t.date}|{t.amount}|{t.description}|{occ}"
        prev = kept.get(match_key)
        if prev is None or (t.native_id and not prev.native_id):
            t.id = hashlib.sha1(match_key.encode("utf-8")).hexdigest()[:16]
            kept[match_key] = t

    out = list(kept.values())
    out.sort(key=lambda t: (t.date, t.account, t.id))
    return out


def load_rules(path=None) -> dict:
    """分類ルールを読む。path 指定はテスト用(fixtureのルールで機構を検証する)。"""
    with open(path or DATA_DIR / "rules.toml", "rb") as f:
        rules = tomllib.load(f)
    for key in ("transfer", "rule", "recurring"):
        for r in rules.get(key, []):
            r["_re"] = re.compile(r["pattern"])
    return rules


def load_overrides() -> list[dict]:
    """レコード単位の手動上書き(data/overrides.toml)。無ければ空。
    UIの明細タブで編集→エクスポートしたファイルをそのまま置く運用。"""
    path = DATA_DIR / "overrides.toml"
    if not path.exists():
        return []
    with open(path, "rb") as f:
        return tomllib.load(f).get("override", [])


def load_uistate() -> dict:
    """鮮度モニタのUI状態(更新確認ack・通知オフmute)。data/uistate.toml。
    serve.py 経由でUIが書く。無ければ空。CLIの鮮度警告もこれを尊重する。"""
    path = DATA_DIR / "uistate.toml"
    if not path.exists():
        return {"ack": {}, "mute": {}}
    with open(path, "rb") as f:
        d = tomllib.load(f)
    return {"ack": d.get("ack", {}), "mute": d.get("mute", {})}


def apply_overrides(txns: list[Txn], overrides: list[dict]) -> list[str]:
    """id 突合でカテゴリ・コメントを上書きする。分類ルールより後段・最優先。
    突合できなかった上書きは警告として返す(取込データの変化で id が
    消えた場合に静かに失われないように)。"""
    by_id = {t.id: t for t in txns}
    notes = []
    for o in overrides:
        t = by_id.get(o.get("id", ""))
        if t is None:
            notes.append(f"上書き先が見つからない: id={o.get('id', '?')}"
                         f" ({o.get('category', '')} {o.get('comment', '')})".rstrip())
            continue
        if o.get("category") and o["category"] != t.category:
            t.rule = ((t.rule + " → ") if t.rule else "") + "手動上書き(overrides.toml)"
            t.category = o["category"]
        if o.get("comment"):
            t.comment = o["comment"]
    return notes


def _rule_applies(rule: dict, t: Txn) -> bool:
    if rule.get("account") and rule["account"] != t.account:
        return False
    if rule.get("since") and t.date < str(rule["since"]):
        return False
    if rule.get("until") and t.date > str(rule["until"]):
        return False
    # 金額条件(符号付き円)。摘要だけで区別できないケース用
    # (例: セゾンの「モバイルスイカ」はSFチャージも定期券購入も同名)
    if "amount_min" in rule and t.amount < rule["amount_min"]:
        return False
    if "amount_max" in rule and t.amount > rule["amount_max"]:
        return False
    return bool(rule["_re"].search(t.description))


def _rule_label(rule: dict) -> str:
    """ルールの人間可読な根拠説明。rules.toml の note があれば優先し、
    なければパターンと条件から機械生成する。UIの明細詳細に表示する。"""
    if rule.get("note"):
        return rule["note"]
    parts = [f"摘要が '{rule['pattern']}' に一致"]
    if rule.get("account"):
        parts.append(f"口座={rule['account']}")
    if rule.get("since"):
        parts.append(f"{rule['since']}以降")
    if rule.get("until"):
        parts.append(f"{rule['until']}まで")
    if "amount_min" in rule:
        parts.append(f"金額≧{rule['amount_min']:,}円")
    if "amount_max" in rule:
        parts.append(f"金額≦{rule['amount_max']:,}円")
    return "・".join(parts)


def _classify_category(t: Txn, rules: dict) -> None:
    """カテゴリ付与とtypeのデフォルト決定(振替判定の後段)。根拠も記録する。"""
    matched = None
    for r in rules.get("rule", []):
        if _rule_applies(r, t):
            r["_hits"] = r.get("_hits", 0) + 1
            t.category = r["category"]
            if r.get("type"):
                t.type = r["type"]
            matched = r
            break
    if matched:
        t.rule = "分類ルール: " + _rule_label(matched)
    else:
        t.rule = ("該当ルールなし" +
                  ("(種別はパーサ判定)" if t.type else "(種別は金額の符号)"))
    # type のデフォルト(パーサのヒントがなければ符号で決める)
    if not t.type:
        t.type = "income" if t.amount > 0 else "expense"
    if not t.category:
        t.category = "未分類"


def classify(txns: list[Txn], rules: dict) -> None:
    """振替判定→カテゴリ付与。決定論的(最初に一致したルールを採用)。"""
    for t in txns:
        matched = False
        for tr in rules.get("transfer", []):
            if _rule_applies(tr, t):
                tr["_hits"] = tr.get("_hits", 0) + 1
                t.type = "transfer"
                t.counter = tr["counter"]
                t.category = "振替"
                t.rule = "振替ルール: " + _rule_label(tr)
                # ペアリング許容日数(ルールで拡張可。積立の引落→入金ズレ等)。
                # _pair_window/_require_pair は dataclass 外の内部属性で、
                # classify→pair→demote 間だけ生き、出力には残らない
                t._pair_window = int(tr.get("pair_window", 3))  # type: ignore[attr-defined]
                t._require_pair = bool(tr.get("require_pair"))  # type: ignore[attr-defined]
                matched = True
                break
        if matched:
            continue
        _classify_category(t, rules)


def demote_unpaired_transfers(txns: list[Txn], rules: dict) -> None:
    """require_pair の振替候補のうちペア不成立のものを振替から降格する。

    両側にデータがあるはずの振替(例: セゾンのSFチャージはSuica側にも
    チャージ行が載る)では、突合できなかった=実は振替でない(同名請求の
    定期券・グリーン券等)と機械的に分かるため、通常の分類に戻す。
    片側しかデータがない振替(カード引落等)に require_pair を付けると
    正しい振替まで支出扱いになるので付けないこと。
    """
    for t in txns:
        if (t.type == "transfer" and not t.pair
                and getattr(t, "_require_pair", False)):
            was = t.rule
            t.type = ""
            t.counter = ""
            t.category = ""
            t.rule = ""
            _classify_category(t, rules)
            t.rule = (was + " / ただし相手側と突合できず振替ではないと判定 / "
                      + t.rule)


def tag_recurring(txns: list[Txn], rules: dict) -> None:
    """[[recurring]] 宣言(サブスク)に一致する支出へ宣言名をタグ付与する。

    宣言が表すのは「これはサブスクである」という同一性のみで、金額・周期・
    現役/終了はすべて実績から導出する(recurring_meta と UI 側)。上から順に
    評価し最初の一致を採用。同名の複数宣言は表記揺れの束ねとして許容。
    振替(カード引落行など)は対象外なので、振替→支出への降格
    (demote_unpaired_transfers)より後に呼ぶこと。
    """
    recs = rules.get("recurring", [])
    if not recs:
        return
    for t in txns:
        if t.type != "expense":
            continue
        for r in recs:
            if r["_re"].search(t.description):
                t.recurring = r["name"]
                break


def _recurring_dates(txns: list[Txn]) -> dict[str, set[str]]:
    """タグ済み明細から宣言name→出現日集合を作る。"""
    dates: dict[str, set[str]] = defaultdict(set)
    for t in txns:
        if t.recurring:
            dates[t.recurring].add(t.date)
    return dates


def recurring_meta(txns: list[Txn], rules: dict) -> list[dict]:
    """UI用のサブスク宣言メタ({name, cycle, note?})。宣言順・name単位。

    cycle は宣言があれば優先し、なければタグ済み明細の出現日間隔の中央値が
    300日超なら "yearly"、それ以外は "monthly" と推定する。推定はここに
    一元化し、UI側では再推定しない(Python/JS の二重実装を避ける)。
    """
    dates = _recurring_dates(txns)
    out: list[dict] = []
    seen: set[str] = set()
    for r in rules.get("recurring", []):
        name = r["name"]
        if name in seen:
            continue
        seen.add(name)
        cycle = r.get("cycle")
        if not cycle:
            ds = sorted(dates.get(name, ()))
            gaps = [(date.fromisoformat(b) - date.fromisoformat(a)).days
                    for a, b in zip(ds, ds[1:])]
            cycle = "yearly" if gaps and median(gaps) > 300 else "monthly"
        d = {"name": name, "cycle": cycle}
        if r.get("kind"):
            d["kind"] = r["kind"]
        if r.get("note"):
            d["note"] = r["note"]
        out.append(d)
    return out


def verify_recurring(txns: list[Txn], rules: dict) -> list[str]:
    """[[recurring]] 宣言と実績の突合。設定ミスを警告として返す。

    - 死に宣言: 一致する明細が0件(パターン誤り、または未取込)
    - 周期推定不能: 出現日が1日以下で cycle 宣言もない(年払いの初回だけを
      monthly と誤推定し、資金繰り予測が12倍になる事故の予防線)
    """
    dates = _recurring_dates(txns)
    order: list[str] = []
    cycles: dict[str, str] = {}
    for r in rules.get("recurring", []):
        if r["name"] not in cycles:
            order.append(r["name"])
        cycles[r["name"]] = cycles.get(r["name"], "") or r.get("cycle", "")
    notes = []
    for name in order:
        n = len(dates.get(name, ()))
        if n == 0:
            notes.append(f"定期宣言 '{name}': 一致する明細が0件(パターン見直し)")
        elif n == 1 and not cycles[name]:
            notes.append(f"定期宣言 '{name}': 出現1件で周期を推定できない"
                         "(monthly扱い。cycle の宣言を推奨)")
    return notes


def rule_usage_report(rules: dict) -> list[str]:
    """一度も一致しなかった振替・分類ルールを返す(--check 用)。

    0件のルールには「消してよい死にルール」と「振替降格時などにだけ出番が
    来る安全網」が混在する。note の有無を併記して判断材料にする(安全網には
    note を書く運用にすると両者を区別できる)。件数は classify 実行時に
    ルール辞書へ記録される(_hits)。
    """
    out = []
    for kind, key in (("振替", "transfer"), ("分類", "rule")):
        for r in rules.get(key, []):
            if r.get("_hits"):
                continue
            note = r.get("note", "")
            out.append(f"{kind}ルール '{r['pattern']}' は一度も一致していない"
                       + (f"(note: {note})" if note
                          else "(note なし。死にルール疑い)"))
    return out


# 投資イベント種別 → 帰属口座(残高アンカー検証用)。イベント自体は
# 口座IDを持たないため、ここで対応を宣言する
INVEST_EVENT_ACCOUNT = {"trade": "sbisec", "metal": "sbi_metal"}


def missing_anchor_accounts(txns: list[Txn], invest: list[dict],
                            balances: dict, accounts: dict) -> list[str]:
    """取引/約定があるのに残高アンカーが無い口座を警告する(--check 用)。

    現金は出ていくのに資産側が純資産・資産構成に一切現れない形になる
    (実例: 貴金属の買付、PayPay残高)。給与グループは月ごとに残高0へ
    戻る清算口座なので除外する。
    """
    used: dict[str, str] = {}
    for t in txns:
        if t.date > used.get(t.account, ""):
            used[t.account] = t.date
    for e in invest:
        acct = INVEST_EVENT_ACCOUNT.get(e.get("kind", ""))
        if acct and e["date"] > used.get(acct, ""):
            used[acct] = e["date"]
    notes = []
    for aid in sorted(used):
        a = accounts.get(aid)
        if not a or a.get("group") == "給与" or aid in balances:
            continue
        notes.append(f"{a['name']}({aid}): 取引/約定があるのに残高アンカーが"
                     f"無く、純資産に現れない(最終取引 {used[aid]})")
    return notes


def pair_transfers(txns: list[Txn]) -> None:
    """振替明細の両側(例: paypayのチャージ行とゆうちょの出金行)を突合する。

    (口座, 相手口座) が互いに逆で金額が正負一致・日付が許容窓
    (既定±3日、ルールの pair_window で拡張可)内のものを
    日付順の貪欲マッチでペアにする。片側しかデータがない振替(セゾン引落等)は
    未ペアのまま残る。残高計算では未ペア振替のみ相手口座に反映すれば
    二重計上にならない。
    """
    open_side: dict[tuple, list[Txn]] = defaultdict(list)
    for t in txns:  # txns は日付順ソート済み
        if t.type != "transfer":
            continue
        want = (t.counter, t.account, -t.amount)
        cands = open_side.get(want, [])
        hit = None
        for c in cands:
            window = max(getattr(t, "_pair_window", 3),
                         getattr(c, "_pair_window", 3))
            if abs((date.fromisoformat(t.date)
                    - date.fromisoformat(c.date)).days) <= window:
                hit = c
                break
        if hit is not None:
            cands.remove(hit)
            pid = min(t.id, hit.id)
            t.pair = pid
            hit.pair = pid
        else:
            open_side[(t.account, t.counter, t.amount)].append(t)


# 投入口。raw/ の外に置く(raw/ は不変の一次資料置き場という原則のため)。
# UI(serve.py /api/inbox)や手動でここに置かれたファイルを build が振り分ける
INBOX_DIR = DATA_DIR / "inbox"

# sniff形式 → 振り分け先フォルダ(raw/ 直下)
FORMAT_DIR = {
    "saison": "saison",
    "yucho_csv": "yucho", "yucho_html": "yucho", "yucho_paper": "yucho",
    "paypay": "paypay",
    "sbisec_cash": "sbi", "sbi_portfolio": "sbi",
    "sbi_trades": "sbi", "sbi_metal": "sbi", "sbi_metal_report": "sbi",
    "sbi_value_history": "sbi",
    "manual_balances": "manual",
    "smbc_csv": "smbc",
    "view_csv": "view",
    "neobank_csv": "neobank-sbi",
    "shinsei_csv": "shinsei-sbi",
    "paypal_csv": "paypal",
    "suica_html": "suica",
    "paidy_html": "paidy",
    "starbucks_html": "starbucks",
    "demo_kyuyo": "demo", "demo_dc_html": "demo",
}
FORMAT_DIR.update(EXTRA_DIRS)  # ローカル拡張(parsers_extra.py)の振り分け先


def organize_inbox(raw_dir: Path | None = None,
                   inbox_dir: Path | None = None,
                   dry_run: bool = False) -> tuple[list[str], list[str]]:
    """data/inbox/ のファイルを内容判別して raw/ 各ソースのフォルダへ移す。

    raw/ への唯一の書込経路(移動・改名のみで中身は不変)。
    - sbi_portfolio は内容に日付がないため、取得日(ファイル更新時刻=DL時刻)
      の YYYY-MM-DD_ プレフィックスをここで付与して永続化する。
    - 判別できないファイルは inbox に残す(leftovers で返し、ビルドが警告)。
    - 移動先に同名がある場合: 内容も同一なら重複DLとみなし inbox 側を削除、
      異なれば -2, -3… を付けて両方残す。
    返り値: (振り分けの記録, 判別できず残ったファイル名)
    """
    raw_dir = raw_dir or RAW_DIR
    inbox = inbox_dir or INBOX_DIR
    notes: list[str] = []
    leftovers: list[str] = []
    if not inbox.is_dir():
        return notes, leftovers
    for p in sorted(inbox.iterdir()):
        if not p.is_file() or p.name.startswith("."):
            continue
        fmt = sniff_format(p)
        if fmt is None or fmt not in FORMAT_DIR:
            leftovers.append(p.name)
            continue
        name = p.name
        if fmt == "sbi_portfolio" and not re.match(r"^\d{4}-\d{2}-\d{2}_", name):
            snap = datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d")
            name = f"{snap}_{name}"
        dest_dir = raw_dir / FORMAT_DIR[fmt]
        dest = dest_dir / name
        if dest.exists() and dest.read_bytes() == p.read_bytes():
            if not dry_run:
                p.unlink()
            notes.append(f"inbox/{p.name}: {FORMAT_DIR[fmt]}/{name} と同一内容のため削除")
            continue
        n = 2
        while dest.exists():
            dest = dest_dir / f"{Path(name).stem}-{n}{Path(name).suffix}"
            n += 1
        if not dry_run:
            dest_dir.mkdir(parents=True, exist_ok=True)
            p.rename(dest)
        notes.append(f"inbox/{p.name} → {FORMAT_DIR[fmt]}/{dest.name}")
    return notes, leftovers


def collect_raw_files() -> list[Path]:
    # .DS_Store 等のドットファイルは取込対象外(organize_inbox と同じ扱い)
    return [p for p in sorted(RAW_DIR.rglob("*"))
            if p.is_file() and not p.name.startswith(".")]


def build_transactions(rules=None) -> tuple[list[Txn], list[dict], list[str],
                                            list[dict], list[dict], list[dict],
                                            list[dict], list[dict], list[dict]]:
    """raw/ 全走査 → パース → 重複排除 → 分類。

    rules は load_rules() 済みの辞書を注入できる(呼び出し元と共有して
    二重読み・二重正規表現コンパイルを避ける)。未指定なら自前で読む。
    返り値: (明細, セゾン請求メタ, スキップ一覧, 投資イベント,
             スナップショット, 手入力残高, 取込日, カバー宣言,
             給与明細の勤務内容等)
    """
    batches: list[list[Txn]] = []
    bills: list[dict] = []       # セゾン等の請求メタ(検証用)
    skipped: list[str] = []
    invest: list[dict] = []      # 約定等の投資イベント(フロー外)
    snapshots: list[dict] = []   # ポートフォリオ等の残高スナップショット
    manual: list[dict] = []      # 手入力残高(現金・DC等のアンカー)
    fetched: list[dict] = []     # 取込日({date, account}。鮮度モニタ用)
    covers: list[dict] = []      # 期間カバー宣言({account, until, label}。
                                 # 給与明細=支給月まるごと等。鮮度モニタ用)
    work: list[dict] = []        # 給与明細の勤務内容等({month, kind, items})
    seen_events: set[str] = set()
    for path in collect_raw_files():
        fmt = sniff_format(path)
        rel = str(path.relative_to(ROOT))
        if fmt is None:
            skipped.append(rel)
            continue
        try:
            txns, meta = PARSERS[fmt](path)
        except Exception as e:   # noqa: BLE001
            # ValueError(パーサ自身の想定内エラー)以外にも、フォーマット
            # 変化による IndexError/KeyError 等でビルド全体を落とさない。
            # raw/ は不変の一次資料なので、読めないファイルは skip に落として
            # 残りを取り込む方が原則に合う。詳細トレースは stderr へ
            traceback.print_exc(file=sys.stderr)
            skipped.append(f"{rel} ({type(e).__name__}: {e})")
            continue
        batches.append(txns)
        # 取込日・カバー宣言は他の meta 種別(kind)と同居できる
        f = meta.get("fetched")
        if f and f.get("date") and f.get("account"):
            fetched.append(f)
        c = meta.get("cover")
        if c and c.get("until") and c.get("account"):
            covers.append(c)
        for w in meta.get("work") or ():
            if w.get("month"):
                work.append(w)
        for w in meta.get("warnings", ()):
            # 非致死の取込警告(行が落ちている可能性等)。取込は続行する
            print(f"警告: {rel}: {w}")
        if meta.get("pay_date") and meta.get("bill_total") is not None:
            meta["source"] = rel
            meta.setdefault("account", DEFAULT_CARD_ACCOUNT)
            bills.append(meta)
        elif meta.get("pay_date"):
            # 支払日だけあって請求額が読めない=形式変化の疑い。黙って
            # 突合・未払残の対象外にせず報告する
            skipped.append(f"{rel} (請求額が読み取れない)")
        elif meta.get("kind") == "portfolio":
            snapshots.append(meta)
        elif meta.get("kind") == "portfolio_series":
            # 資産推移CSV(評価額の点列)。1点ずつスナップショット扱いで合流
            snapshots.extend(meta.get("points", ()))
        elif meta.get("kind") in ("balances", "invest"):
            # 残高アンカーと投資イベントは同居できる(貴金属報告書PDFは
            # 残高と約定明細の両方を持つ)
            manual.extend(meta.get("entries", ()))
            # ファイル横断の重複排除。native_id がなければ内容キーに
            # ファイル内出現連番を足す(同日同銘柄同額の2約定を潰さない。
            # dedup と同じ理屈で、取込範囲が違っても並びが同じなら一致する)
            occ: dict[str, int] = defaultdict(int)
            for ev in meta.get("events", ()):
                base = ev.get("native_id") or "|".join(str(ev.get(k, "")) for k in
                    ("kind", "date", "name", "action", "qty", "amount"))
                key = f"{base}|{occ[base]}"
                occ[base] += 1
                if key in seen_events:
                    continue
                seen_events.add(key)
                invest.append(ev)
    txns = dedup(batches)
    rules = rules or load_rules()
    classify(txns, rules)
    pair_transfers(txns)
    demote_unpaired_transfers(txns, rules)
    tag_recurring(txns, rules)
    invest.sort(key=lambda e: (e["date"], e["name"]))
    manual.sort(key=lambda e: (e["date"], e["account"]))
    # 勤務内容等: 同一明細(stmt=支給月)由来の重複は後勝ちで1件に
    # (同じ明細を2回置いても増殖しない。dedup と同じ冪等の考え方)。
    # その上で同月・同種(給与/賞与)を明細順に結合する(勤怠は前月・
    # 付与項目は支給月に帰属するため、1つの月に複数明細が寄与しうる)。
    # stmt は取込内部のキーで、出力には残さない
    wmap = {(w["month"], w["kind"], w.get("stmt", w["month"])): w
            for w in work}
    wmerged: dict[tuple, dict] = {}
    for k in sorted(wmap):
        w = wmap[k]
        key = (w["month"], w["kind"])
        if key in wmerged:
            wmerged[key]["items"].extend(w["items"])
        else:
            wmerged[key] = {"month": w["month"], "kind": w["kind"],
                            "items": list(w["items"])}
    work = [wmerged[k] for k in sorted(wmerged)]
    return (txns, bills, skipped, invest, snapshots, manual, fetched, covers,
            work)


# 請求メタが account を持たないソース(セゾン)の既定カード口座
DEFAULT_CARD_ACCOUNT = "saison"


def _bill_withdrawn(txns: list[Txn], bill: dict) -> bool:
    """請求(支払日±3日・請求額一致)に対応する引落が明細にあるか。

    引落は支払口座側に「カード宛の振替」として現れる(counter=カード口座、
    金額は出金なので負)。
    """
    acct = bill.get("account", DEFAULT_CARD_ACCOUNT)
    pd = date.fromisoformat(bill["pay_date"])
    return any(
        t.type == "transfer" and t.counter == acct
        and -t.amount == bill["bill_total"]
        and abs((date.fromisoformat(t.date) - pd).days) <= 3
        for t in txns
    )


def verify_balance_continuity(txns: list[Txn],
                              accounts: dict | None = None) -> list[str]:
    """残高列と取引額の積み上げが整合するか口座ごとに検証する。

    紙通帳OCRの転記ミス(列の取り違え)や行の欠落は、ソース由来の絶対値である
    残高列と取引額の積み上げの食い違いとして機械的に検出できる
    (実例: 合算行の支払/預り列逆転、日付なし「料金」行の取り込み漏れ)。

    同日内の取引順は保たれないため、日単位で
    「前日終値 + 当日の取引合計」が当日のいずれかの残高と一致するかを見る
    (順序非依存)。残高列のない取引が混ざる日は起点をリセットして
    検証不能区間として飛ばす(複数ソース混在時の誤検知を避ける)。
    ズレは発生日ごとに1件だけ警告し、以後は実残高に追従して
    連鎖警告にしない。

    原因が分かっていて実害のないズレ(例: 合算行が、後から個別復元された
    期間の取引を含んでいて算術的に重複する)は accounts.toml に宣言して
    抑制する:

        [[accounts.yucho.known_balance_breaks]]
        date = "2024-12-04"
        note = "ズレの原因説明"

    宣言した日にズレが出なくなったら宣言が古いので、逆にその旨を警告する
    (死に宣言の検出。振替ルールの unused 検出と同じ発想)。
    """
    by_acct: dict[str, list[Txn]] = defaultdict(list)
    for t in txns:
        by_acct[t.account].append(t)
    notes: list[str] = []
    for acct, ts in sorted(by_acct.items()):
        if not any(t.balance is not None for t in ts):
            continue
        known = {b["date"]: b for b in
                 (accounts or {}).get(acct, {}).get("known_balance_breaks", [])}
        used: set[str] = set()
        day_txns: dict[str, list[Txn]] = defaultdict(list)
        for t in ts:
            day_txns[t.date].append(t)
        prev_close: int | None = None
        prev_day = ""
        for d in sorted(day_txns):
            dts = day_txns[d]
            if any(t.balance is None for t in dts):
                prev_close = None
                continue
            total = sum(t.amount for t in dts)
            bals = [t.balance for t in dts]
            if prev_close is None:
                # 検証再開の起点。同日複数件だと終値がどれか決められないので
                # 次の1件だけの日から再開する
                prev_close = bals[0] if len(bals) == 1 else None
                prev_day = d
                continue
            expect = prev_close + total
            if expect not in bals:
                close = min(bals, key=lambda b: abs(b - expect))
                if d in known:
                    used.add(d)
                else:
                    notes.append(
                        f"{acct}: 残高列と取引の積み上げが {d} で "
                        f"{close - expect:+,}円 ずれる"
                        f"(直前の整合日 {prev_day} 終値 {prev_close:,}円)")
                expect = close   # 実残高に追従(1つのズレで以後を汚さない)
            prev_close = expect
            prev_day = d
        for d in sorted(set(known) - used):
            notes.append(
                f"{acct}: known_balance_breaks 宣言の {d} にズレが無い"
                "(解消済みなら accounts.toml から消してよい)")
    return notes


BUILD_LOG = DATA_DIR / "build_log.jsonl"


def append_build_log(entry: dict, path: Path | None = None,
                     now: datetime | None = None) -> dict:
    """ビルド実行の結果を追記専用ログ data/build_log.jsonl に記録する。

    いつビルドが走り何を報告したかは raw/ の再ビルドでは再生成できない
    情報なので、ledger/ や data.js(派生物)ではなく uistate.toml と同じ
    「状態ファイル」として data/ に置く。手で編集しない。--check は記録
    しない(読み取り専用の点検が状態を変えないため)。

    entry は {"ok": bool, "lines": [{"k": 種別, "t": 行}...]} または
    {"ok": false, "error": トレースバック}。ts はここで付与する。
    直前の本文エントリと内容(ts以外)が完全一致する場合は本文を繰り返さず
    {"ts", "repeat": true} だけを追記する(無変化ビルドの連続でログを
    肥大させない。UIは直前の本文エントリを参照して1行に畳む)。
    """
    path = path or BUILD_LOG
    prev = None
    if path.exists():
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                rec = json.loads(line)
            except ValueError:
                continue     # 途中クラッシュ等の欠け行は無視して続ける
            if not rec.get("repeat"):
                prev = rec
    ts = (now or datetime.now()).strftime("%Y-%m-%d %H:%M:%S")
    if prev is not None and {k: v for k, v in prev.items() if k != "ts"} == entry:
        rec = {"ts": ts, "repeat": True}
    else:
        rec = {"ts": ts, **entry}
    with open(path, "a", encoding="utf-8") as f:
        f.write(json.dumps(rec, ensure_ascii=False, separators=(",", ":"))
                + "\n")
    return rec


def build_log_tail(n: int = 100, path: Path | None = None) -> list[dict]:
    """data.js に埋め込む直近nレコード。全履歴はファイル側にだけ残す。

    切り出した先頭が repeat 行だと参照先の本文がなく畳めないので、
    その場合は直前の本文エントリを1件だけ先頭に足して返す。
    """
    path = path or BUILD_LOG
    if not path.exists():
        return []
    recs = []
    for line in path.read_text(encoding="utf-8").splitlines():
        try:
            recs.append(json.loads(line))
        except ValueError:
            continue
    tail = recs[-n:]
    if tail and tail[0].get("repeat"):
        base = [r for r in recs[:-n] if not r.get("repeat")]
        if base:
            tail = [base[-1]] + tail
    return tail


def merged_periods(accounts: dict) -> list[dict]:
    """明細が合算行に圧縮され、個別の取引行が欠ける期間の宣言(accounts.toml)。

    紙通帳の「通帳未記入金合計 合算 N」のように、複数の取引が1行に潰れて
    取り込まれる期間がある。その期間の引落は個別行として存在しないので、
    カード請求との突合は原理的に成立しない——取り込み漏れではないのに
    警告が出続け、本物の漏れを埋もれさせる。

    合算行が何日ぶんを畳んだかはデータに書かれておらず取引から復元できない
    ため、accrual と同じく台帳に宣言する:

        [[accounts.yucho.merged_periods]]
        start = "2025-08-01"
        end = "2026-04-06"
        note = "紙通帳の未記入分が合算行に圧縮された期間"

    期間内に個別行が残っていても構わない(突合できた請求は先に除かれる)。
    """
    out: list[dict] = []
    for aid, a in sorted(accounts.items()):
        mp = a.get("merged_periods")
        if not mp:
            continue
        for p in (mp if isinstance(mp, list) else [mp]):
            out.append({"account": aid, "start": str(p["start"]),
                        "end": str(p["end"]), "note": p.get("note", "")})
    return out


def _merged_period_of(periods: list[dict], day: str,
                      account: str | None = None) -> dict | None:
    """day を含む合算期間。account を渡すと宣言の口座とも照合する。"""
    return next((p for p in periods if p["start"] <= day <= p["end"]
                 and (account is None or p["account"] == account)), None)


def verify_card_bills(txns: list[Txn], bills: list[dict],
                      today: date | None = None,
                      periods: list[dict] | None = None,
                      accounts: dict | None = None,
                      ) -> tuple[list[str], list[dict]]:
    """カード請求(支払日+請求額)が引落と突合できるか検証する。

    支払日が未来の請求はまだ引き落とされていないので対象外。
    返り値: (警告, 合算期間の宣言で説明がつく請求)。前者だけが要調査で、
    後者は「個別行が存在しないので突合しようがない」既知の事情。

    合算期間の宣言はカードの引落口座(accounts.toml の debit_account)と
    照合する——別口座引落のカードまで巻き込んで過剰除外しないため。
    debit_account 未宣言のカードは従来どおり期間のみで照合する。
    """
    notes: list[str] = []
    merged: list[dict] = []
    for b in sorted(bills, key=lambda b: b["pay_date"]):
        if today and b["pay_date"] > today.isoformat():
            continue
        if _bill_withdrawn(txns, b):
            continue
        acct = b.get("account", DEFAULT_CARD_ACCOUNT)
        debit = (accounts or {}).get(acct, {}).get("debit_account")
        p = _merged_period_of(periods or [], b["pay_date"], debit)
        if p:
            merged.append({**b, "period": p})
            continue
        notes.append(
            f"{acct}請求 {b['pay_date']} {b['bill_total']:,}円 に対応する"
            f"引落が見つからない ({b['source']})"
        )
    return notes, merged


def upcoming_debits(txns: list[Txn], bills: list[dict],
                    today: date) -> list[dict]:
    """確定済みだがまだ引き落とされていない請求(引落予定)を支払日順に返す。

    支払日が未来の請求が対象。過去日で未引落のものは「引落が見つからない」
    検証警告の領分なのでここには出さない。
    """
    out = []
    for b in sorted(bills, key=lambda b: b["pay_date"]):
        if b["pay_date"] < today.isoformat():
            continue
        if _bill_withdrawn(txns, b):
            continue
        out.append({
            "account": b.get("account", DEFAULT_CARD_ACCOUNT),
            "date": b["pay_date"],
            "amount": b["bill_total"],
            "source": b["source"],
        })
    return out


def card_debt_anchors(bills: list[dict], today: date) -> list[dict]:
    """確定済み・未引落の請求額から、カード負債の残高アンカーを合成する。

    カードの利用明細は「利用」しか持たず引落は支払口座側に出るため、そのままでは
    カードの未払残が純資産に現れない。請求は月次で、ある時点で未引落なのは
    通常「次に到来する請求」1件なので、

        時点tの未払残 = t より後で最初に到来する請求の金額

    とみなして各月末と当日にアンカーを置く。**確定した請求だけ**を数えるので、
    まだ請求が立っていない直近の利用分は含まない(過小評価side)。請求書を
    ダウンロードしていない月は0になるが、それは鮮度モニタが催促する領分。
    """
    if not bills:
        return []
    by_acct: dict[str, list[dict]] = defaultdict(list)
    for b in bills:
        by_acct[b.get("account", DEFAULT_CARD_ACCOUNT)].append(b)
    out: list[dict] = []
    for acct, bs in sorted(by_acct.items()):
        bs.sort(key=lambda b: b["pay_date"])
        # 最初の請求が未払だった月(=その前月)から当日までを埋める
        first = date.fromisoformat(bs[0]["pay_date"])
        y, m = (first.year - 1, 12) if first.month == 1 else (first.year,
                                                              first.month - 1)
        dates: list[date] = []
        # 600ヶ月(50年)で打ち切り: pay_date の異常値による暴走ループの保険
        while len(dates) < 600:
            last = date(y, m, calendar.monthrange(y, m)[1])
            if last >= today:
                break
            dates.append(last)
            y, m = (y + 1, 1) if m == 12 else (y, m + 1)
        dates.append(today)
        for d in dates:
            iso = d.isoformat()
            nxt = next((b for b in bs if b["pay_date"] > iso), None)
            # 0円は「借りがない」ではなく「次の請求をまだ取り込んでいない」。
            # 残高0と読み違えないよう注記で区別する
            out.append({"date": iso, "account": acct,
                        "balance": -nxt["bill_total"] if nxt else 0,
                        "note": "確定請求(未引落)" if nxt else "次回請求待ち"})
    return out


def uncategorized_ranking(txns: list[Txn], top: int = 10) -> list[dict]:
    """未分類のまま残っている摘要を件数順に返す(ルール追加の候補出し)。

    枝番("支払い "接頭辞・" - "以降)を落として束ねる。分類を決めるのは
    rules.toml の人手ルールだけなので、ここでは「どのルールを書けば一番効くか」
    を示すだけで、推測で分類はしない。
    """
    agg: dict[str, dict] = {}
    for t in txns:
        if t.category != "未分類" or t.type not in ("income", "expense"):
            continue
        key = t.description.removeprefix("支払い ").split(" - ")[0] or "(摘要なし)"
        a = agg.setdefault(key, {"key": key, "count": 0, "amount": 0, "last": ""})
        a["count"] += 1
        a["amount"] += abs(t.amount)
        a["last"] = max(a["last"], t.date)
    return sorted(agg.values(), key=lambda a: (-a["count"], -a["amount"]))[:top]


def freshness_report(txns: list[Txn], accounts: dict, today: date,
                     bills: list[dict] | None = None,
                     anchors: list[dict] | None = None,
                     fetched: list[dict] | None = None,
                     covers: list[dict] | None = None) -> list[dict]:
    """鮮度監視対象の全口座について最終取込日と経過日数を返す。

    UI側はこれに「更新確認」「通知オフ」(uistate.toml)を重ねて表示を決める。
    anchors: 取込由来の残高アンカー({date, account})。企業型DCのように
    取引を持たず残高スナップショットだけで取り込む口座は、これを見ないと
    「明細が一度も取り込まれていない」に誤判定される。合成アンカー
    (accrual宣言・カード未払残)は取込ではないので渡さないこと。
    fetched: パーサが申告した取込日({date, account}。DL日・保存日)。
    covers: パーサが申告した期間カバー({account, until, label})。
    「この日まではデータが出揃っている」宣言で、明細のレコード日が構造的に
    遅れる/ずれるソース用(給与明細=支給月まるごと等)。カード請求も
    「支払日までの利用が確定済み」という同型のカバーとして内部で合流する。

    警告判定は last = max(明細末端, 取込日, カバー末尾(未来は今日に丸め))
    で行うが、この3種は意味が違うので表示用に分けて返す:
      first / data_end … 明細(レコード)のカバレッジ範囲。取引日ベース
      imported         … 取込日(残高アンカーの照会日・HTML保存日・CSVのDL日)
      cover_until / cover_label … 最新カバーの末尾(丸めなし)とラベル
                         (「2026-08請求」「2026-07支給」)。UI表示用
    """
    first_by_account: dict[str, str] = {}
    data_end_by_account: dict[str, str] = {}
    for t in txns:
        if t.date > data_end_by_account.get(t.account, ""):
            data_end_by_account[t.account] = t.date
        if t.date < first_by_account.get(t.account, "9999"):
            first_by_account[t.account] = t.date
    imported_by_account: dict[str, str] = {}
    for a in (anchors or []) + (fetched or []):
        d, acct = str(a.get("date", "")), a.get("account", "")
        if acct and d > imported_by_account.get(acct, ""):
            imported_by_account[acct] = d
    last_by_account = {
        acct: max(data_end_by_account.get(acct, ""),
                  imported_by_account.get(acct, ""))
        for acct in set(data_end_by_account) | set(imported_by_account)}
    # カード明細は利用日ベースで請求確定まで1〜2ヶ月遅れるため、最終明細の
    # 利用日だけで測ると取込済みでも警告が出続ける。請求メタの支払日を
    # 「支払日までの利用は確定済み」のカバーに変換し、給与等のカバー宣言と
    # 同列に扱う。カバー末尾も「最新の取込」として数えるが、未来の末尾は
    # 「今日」に丸める(そのままだと「-12日前」のような表示になる)
    # note はUIツールチップの補足文。ソース固有の事情(なぜ以降分がないか)
    # なので、カバーの発生源(パーサ/この請求変換)が文面を持つ
    all_covers = list(covers or []) + [
        {"account": b.get("account", ""),
         "until": str(b.get("pay_date", "")),
         "label": str(b.get("pay_date", ""))[:7] + "請求",
         "note": "以降分は未確定のため取り込みなし。"}
        for b in bills or []]
    cover_by_account: dict[str, dict] = {}
    for c in all_covers:
        acct, until = c.get("account", ""), str(c.get("until", ""))
        if not acct:
            continue
        if until > cover_by_account.get(acct, {}).get("until", ""):
            cover_by_account[acct] = {"until": until,
                                      "label": c.get("label", ""),
                                      "note": c.get("note", "")}
        clipped = min(until, today.isoformat())
        if clipped > last_by_account.get(acct, ""):
            last_by_account[acct] = clipped
    report = []
    for aid, a in accounts.items():
        if not a.get("active", True):
            continue
        # 9999 は「間隔監視なし」のセンチネル(未宣言の口座は監視対象外)
        interval = a.get("update_interval_days", 9999)
        update_day = a.get("update_day", 0)
        if interval >= 9999 and not update_day:
            continue
        last = last_by_account.get(aid, "")
        days = (today - date.fromisoformat(last)).days if last else None
        cov = cover_by_account.get(aid, {})
        report.append({
            "account": aid, "name": a["name"], "url": a.get("url", ""),
            "last": last, "days": days, "interval": interval,
            "update_day": update_day,
            "first": first_by_account.get(aid, ""),
            "data_end": data_end_by_account.get(aid, ""),
            "imported": imported_by_account.get(aid, ""),
            "cover_until": cov.get("until", ""),
            "cover_label": cov.get("label", ""),
            "cover_note": cov.get("note", ""),
        })
    return report


def monthly_due(today: date, day: int) -> date:
    """直近(今日以前)の月次更新日。dayがその月にない場合は月末に丸める。"""
    d = date(today.year, today.month,
             min(day, calendar.monthrange(today.year, today.month)[1]))
    if d <= today:
        return d
    y, m = ((today.year - 1, 12) if today.month == 1
            else (today.year, today.month - 1))
    return date(y, m, min(day, calendar.monthrange(y, m)[1]))


def freshness_warnings(txns: list[Txn], accounts: dict, today: date,
                       bills: list[dict] | None = None,
                       uistate: dict | None = None,
                       anchors: list[dict] | None = None,
                       fetched: list[dict] | None = None,
                       covers: list[dict] | None = None) -> list[dict]:
    """UI状態(uistate.toml)を尊重した鮮度警告。通知オフの口座は出さず、
    「更新確認」した日も最終取込と同格に扱う(UI表示と同じ規則)。"""
    ui = uistate or {}
    ack, mute = ui.get("ack", {}), ui.get("mute", {})
    warnings = []
    for r in freshness_report(txns, accounts, today, bills, anchors, fetched,
                              covers):
        if mute.get(r["account"]):
            continue
        a = str(ack.get(r["account"], ""))
        eff = max(r["last"], a)
        if not eff:
            warnings.append({**r, "message": "明細が一度も取り込まれていない"})
            continue
        # 月次更新日の宣言がある口座(給料日・カード確定日)は「経過日数」
        # でなく「直近の更新日以降の取込があるか」で判定する(猶予なし)
        if r["update_day"]:
            due = monthly_due(today, r["update_day"]).isoformat()
            if eff < due:
                warnings.append({**r, "message":
                    f"月次更新日 {due} 以降の取込がない(最終 {eff})"})
            continue
        days = (today - date.fromisoformat(eff)).days
        if days > r["interval"]:
            src = "更新確認" if a > r["last"] else "最終明細"
            warnings.append({**r, "message":
                f"{src} {eff} から {days}日経過"
                f"(期待 {r['interval']}日以内)"})
    return warnings


def latest_balances(txns: list[Txn],
                    snapshots: list[dict] | None = None,
                    manual: list[dict] | None = None,
                    no_extrapolate: set[str] | None = None) -> dict[str, dict]:
    """残高列・スナップショット・手入力から、口座ごとの最新残高アンカーを得る。

    時点は口座ごとにバラバラでよい(方針: ゆるい合成を日付表示で正直に見せる)。
    同日に複数ソースがある場合は 残高列 < 評価額 < 手入力 の順で後勝ち。

    残高列を持たない口座(PayPay等)は、アンカー以後の取引を積んで現在値に
    追従させる(balance_history の前方外挿と同じ理屈。アンカーを取り直す
    まで現在残高が凍結し、資産構成が古い値のまま合算される問題の対処)。
    no_extrapolate はカードのように取引を積んでも残高にならない口座の除外指定。
    """
    anchors: dict[str, dict] = {}
    for t in txns:
        if t.balance is None:
            continue
        cur = anchors.get(t.account)
        if cur is None or t.date >= cur["date"]:
            anchors[t.account] = {"date": t.date, "balance": t.balance}
    for s in snapshots or []:
        if s.get("total_value") is None:
            continue
        cur = anchors.get(s["account"])
        if cur is None or s["date"] >= cur["date"]:
            anchors[s["account"]] = {
                "date": s["date"],
                "balance": round(s["total_value"]),
                "note": s.get("note") or "評価額",
            }
    for e in manual or []:
        cur = anchors.get(e["account"])
        if cur is None or e["date"] >= cur["date"]:
            anchors[e["account"]] = {
                "date": e["date"],
                "balance": e["balance"],
                "note": e.get("note", "手入力"),
                # 拠出累計(企業型DC等)。UIが評価損益・事業主拠出を
                # 逆算するのに使う。無い口座にはキー自体を出さない
                **({"contrib_total": e["contrib_total"]}
                   if e.get("contrib_total") is not None else {}),
            }
    has_column = set(no_extrapolate or ())
    by_acct: dict[str, list[Txn]] = defaultdict(list)
    for t in txns:
        if t.balance is not None:
            has_column.add(t.account)
        by_acct[t.account].append(t)
    for acct, cur in anchors.items():
        if acct in has_column or acct not in by_acct:
            continue
        after = [t for t in by_acct[acct] if t.date > cur["date"]]
        if not after:
            continue
        cur["balance"] += sum(t.amount for t in after)
        cur["date"] = max(t.date for t in after)
        if cur.get("note"):
            cur["note"] += "+以後の取引"
    return anchors


def balance_history(txns: list[Txn],
                    snapshots: list[dict] | None = None,
                    manual: list[dict] | None = None,
                    no_extrapolate: set[str] | None = None,
                    ) -> dict[str, list[dict]]:
    """口座ごとの残高アンカー時系列(純資産推移チャート用)。

    残高列・スナップショット評価額・手入力を統合し、同一口座・同一日は
    後勝ち(手入力が最優先)で1点に畳む。月次の推移が読めればよい粒度なので、
    同日内の取引順までは追わない。

    no_extrapolate: フロー外挿の対象外にする口座。カードのように「取引が
    利用しか無く、返済は相手口座側に出る」口座は、取引を積んでも残高にならない
    (アンカー側で完結している)ため外挿してはいけない。
    """
    points: dict[str, dict[str, int]] = defaultdict(dict)
    has_column = set(no_extrapolate or ())   # 外挿しない口座(残高列由来を含む)
    for t in txns:
        if t.balance is not None:
            points[t.account][t.date] = t.balance
            has_column.add(t.account)
    for s in snapshots or []:
        if s.get("total_value") is not None:
            points[s["account"]][s["date"]] = round(s["total_value"])
    # 拠出累計(企業型DC等)の時系列。評価損益 = 残高 − 拠出累計 を過去時点
    # でも逆算できるよう、判明している点には履歴側にも載せる(運用効率KPI用)
    contribs: dict[str, dict[str, int]] = defaultdict(dict)
    for e in manual or []:
        points[e["account"]][e["date"]] = e["balance"]
        if e.get("contrib_total") is not None:
            contribs[e["account"]][e["date"]] = e["contrib_total"]
    # フロー外挿: 残高列のない口座(Paidyの残債等)は、最新アンカーから取引を
    # 逆再生/順再生して月末残高を合成する。単一時点のアンカーだけだと
    # 純資産推移に「その月いきなり発生した」ような崖ができるため。
    # 実点(アンカー)が既にある月には合成しない。また評価額スナップショット
    # を持つ口座(証券)は外挿自体をしない。フロー再生は評価損益を含まない
    # ため、実測(評価額)と混ぜるとノコギリ状の偽の上下ができる
    # (SBI資産推移CSVの取込で顕在化した)。点のない月は月末キャリー
    # フォワード(netWorthSeries)が最後の実測値で埋める。
    snap_accts = {s["account"] for s in snapshots or []
                  if s.get("total_value") is not None}
    by_acct: dict[str, list[Txn]] = defaultdict(list)
    for t in txns:
        by_acct[t.account].append(t)
    for acct, series in points.items():
        if acct in has_column or acct not in by_acct or acct in snap_accts:
            continue
        anchor_date = max(series)
        anchor_bal = series[anchor_date]
        atx = by_acct[acct]
        anchored_months = {d[:7] for d in series}
        ms = sorted(({t.date[:7] for t in atx} | {anchor_date[:7]})
                    - anchored_months)
        for m in ms:
            # 実在する月末日を使う(存在しない "-31" を出すと UI の日付
            # パースで壊れる)。文字列比較のフィルタにも同じ値で問題ない
            m_end = f"{m}-{calendar.monthrange(int(m[:4]), int(m[5:7]))[1]:02d}"
            if m_end < anchor_date:      # 後方: アンカーから月末まで巻き戻す
                bal = anchor_bal - sum(t.amount for t in atx
                                       if m_end < t.date <= anchor_date)
            elif m + "-01" > anchor_date:  # 前方: アンカー以後の取引を積む
                bal = anchor_bal + sum(t.amount for t in atx
                                       if anchor_date < t.date <= m_end)
            else:
                continue                 # アンカーと同月は実点に任せる
            series.setdefault(m_end, bal)
    return {
        acct: [{"date": d, "balance": b,
                **({"contrib_total": contribs[acct][d]}
                   if d in contribs.get(acct, {}) else {})}
               for d, b in sorted(series.items())]
        for acct, series in sorted(points.items())
    }


def load_accounts() -> dict:
    with open(DATA_DIR / "accounts.toml", "rb") as f:
        return tomllib.load(f)["accounts"]


def accrual_entries(accounts: dict) -> list[dict]:
    """accounts.toml の accrual 宣言から月次の残高アンカーを合成する。

    明細ソースに現れない残高の積み上がり(借入の実行期間等)を宣言的に
    純資産推移へ反映する仕組み。残高だけを見せる借入元のページからは
    期間中の増え方が復元できず、振込側の明細も合算行に埋もれることが
    あるため、期間と月額はユーザーが台帳に宣言する。複数期間を並べると
    残高を引き継いで累積するので、初回一括や月額変更も表せる:

        [[accounts.loan.accrual]]    # 初回: 4ヶ月分を一括
        start = "2025-06"
        end = "2025-06"
        monthly = -352000
        [[accounts.loan.accrual]]    # 以後は月次
        start = "2025-08"
        end = "2026-03"
        monthly = -88000

    各期間の start〜end の月末に monthly の累積を残高アンカーとして置く。
    期間の間の月はアンカーを置かない(純資産推移のキャリーフォワードが
    直前残高を引き継ぐ)。同日に手入力残高(balances.csv)があれば
    そちらが勝つ。
    """
    out: list[dict] = []
    for aid, a in accounts.items():
        ac = a.get("accrual")
        if not ac:
            continue
        periods = ac if isinstance(ac, list) else [ac]
        bal = 0
        for p in periods:
            y, m = int(p["start"][:4]), int(p["start"][5:7])
            ey, em = int(p["end"][:4]), int(p["end"][5:7])
            # 1200点(100年)で打ち切り: end の宣言ミスによる暴走ループの保険
            while (y, m) <= (ey, em) and len(out) < 1200:
                bal += p["monthly"]
                last = calendar.monthrange(y, m)[1]
                out.append({"date": f"{y:04d}-{m:02d}-{last:02d}",
                            "account": aid, "balance": bal,
                            "note": p.get("note", "積み上げ宣言")})
                y, m = (y + 1, 1) if m == 12 else (y, m + 1)
    return out


def txn_to_dict(t: Txn) -> dict:
    d = {
        "id": t.id, "account": t.account, "date": t.date, "amount": t.amount,
        "description": t.description, "raw_description": t.raw_description,
        "type": t.type, "category": t.category, "source": t.source,
    }
    if t.counter:
        d["counter"] = t.counter
    if t.pair:
        d["pair"] = t.pair
    if t.rule:
        d["rule"] = t.rule
    if t.recurring:
        d["recurring"] = t.recurring
    if t.native_id:
        d["native_id"] = t.native_id
    if t.balance is not None:
        d["balance"] = t.balance
    if t.memo:
        d["memo"] = t.memo
    if t.comment:
        d["comment"] = t.comment
    return d


def write_ledger(txns: list[Txn]) -> None:
    LEDGER_DIR.mkdir(exist_ok=True)
    for old in LEDGER_DIR.glob("*.jsonl"):
        old.unlink()
    by_month: dict[str, list[Txn]] = defaultdict(list)
    for t in txns:
        by_month[t.date[:7]].append(t)
    for month, ts in sorted(by_month.items()):
        with open(LEDGER_DIR / f"{month}.jsonl", "w", encoding="utf-8") as f:
            for t in ts:
                f.write(json.dumps(txn_to_dict(t), ensure_ascii=False) + "\n")


def pl_history_points(snapshots: list[dict], events: list[dict]) -> list[dict]:
    """含み益の点列(純資産推移のストライプ用)。日付順。

    損益(total_pl)を持つスナップショット(ポートフォリオCSV)は実測値を
    そのまま使う。評価額のみの点(資産推移CSV)は「評価額 − 約定履歴からの
    累積元本」で導出して過去側を埋める。元本は簡易法: 買い=約定額+手数料、
    売り=受取額を控除、分配金再投資は除外(新規拠出でない)、貴金属口座
    (kind=metal)の約定は除外(評価額が sbisec のみで貴金属を含まないため)。
    証券会社の取得原価(移動平均法)とは数千円ずれうるが、実測点区間
    (ポートフォリオCSV以降)には影響しない。
    """
    def cost_of(e: dict) -> float:
        act = e.get("action") or ""
        if "分配金再投資" in act:
            return 0
        if "売" in act:
            return -(abs(e.get("amount") or 0) - (e.get("fee") or 0))
        return (e.get("amount") or 0) + (e.get("fee") or 0)

    evs = sorted((e for e in events if e.get("kind") != "metal"),
                 key=lambda e: e["date"])
    out = []
    cost = 0.0
    i = 0
    for s in sorted(snapshots, key=lambda s: s["date"]):
        while i < len(evs) and evs[i]["date"] <= s["date"]:
            cost += cost_of(evs[i])
            i += 1
        if s.get("total_pl") is not None:
            out.append({"date": s["date"], "pl": round(s["total_pl"])})
        elif s.get("total_value") is not None:
            out.append({"date": s["date"],
                        "pl": round(s["total_value"] - cost)})
    return out


def write_data_js(txns: list[Txn], accounts: dict, freshness: list[dict],
                  balances: dict, history: dict, invest: list[dict],
                  snapshots: list[dict], catgroups: dict,
                  overrides: list[dict], uistate: dict,
                  bills: list[dict] | None = None,
                  upcoming: list[dict] | None = None,
                  recurring: list[dict] | None = None,
                  salary_work: list[dict] | None = None,
                  build_log: list[dict] | None = None) -> None:
    SITE_DIR.mkdir(exist_ok=True)
    by_date = sorted(snapshots, key=lambda s: s["date"])
    portfolio = by_date[-1] if by_date else None
    # カード請求(確定分)。資金繰り予測が未来の引落を投影するのに使う。
    # 明細(利用日ベース)からは請求額・支払日を復元できないためここで渡す。
    # 支払日順にし、UI が軽くなるよう必要キーだけに絞る
    card_bills = sorted(
        ({"account": b.get("account", DEFAULT_CARD_ACCOUNT),
          "pay_date": b["pay_date"], "bill_total": b["bill_total"]}
         for b in (bills or []) if b.get("pay_date") and b.get("bill_total")),
        key=lambda b: b["pay_date"])
    # 明細の容量圧縮。source(ユニーク数十種)と rule(同)が全行に重複して
    # data.js の3割超を占めるため文字列テーブル参照にし、description と
    # 同一の raw_description(約4割の行)は省略する。core.js の先頭で
    # 従来の形へ展開するので、UI側の他コードは圧縮を知らない。
    # ledger/*.jsonl は人間が読む側なので圧縮しない(txn_to_dict のまま)
    strings: list[str] = []
    sidx: dict[str, int] = {}

    def intern(s: str) -> int:
        if s not in sidx:
            sidx[s] = len(strings)
            strings.append(s)
        return sidx[s]

    tx_dicts = []
    for t in txns:
        d = txn_to_dict(t)
        d["source"] = intern(d["source"])
        if "rule" in d:
            d["rule"] = intern(d["rule"])
        if d.get("raw_description") == d["description"]:
            del d["raw_description"]
        tx_dicts.append(d)
    data = {
        "generated_at": datetime.now().strftime("%Y-%m-%d %H:%M"),
        "accounts": {
            aid: {
                "name": a["name"], "kind": a["kind"], "group": a.get("group", ""),
                "active": a.get("active", True), "url": a.get("url", ""),
                # 定額返済で減っていく借入(計画タブの完済シミュレーション対象)
                "amortizing": a.get("amortizing", False),
                "update_interval_days": a.get("update_interval_days", 0),
                "howto": a.get("howto", ""),
            } for aid, a in accounts.items()
        },
        "balances": balances,
        "balance_history": history,
        "card_bills": card_bills,
        "freshness": freshness,
        # 確定済みでまだ引き落とされていないカード請求(引落予定ビュー用)
        "upcoming": upcoming or [],
        "invest": {"events": invest, "portfolio": portfolio,
                   # 含み益の時系列(純資産推移のストライプ用)。スナップショット
                   # のある日だけの点列で、チャート側が月末へキャリーフォワード。
                   # 評価額のみの点は約定履歴から導出(pl_history_points)
                   "pl_history": pl_history_points(snapshots, invest),
                   # 評価額の時系列(投資カードの元本×評価額チャート用)。
                   # ポートフォリオCSVと資産推移CSVの両方の点が入る
                   "value_history": [
                       {"date": s["date"], "value": round(s["total_value"])}
                       for s in by_date
                       if s.get("total_value") is not None]},
        "category_groups": catgroups,
        # サブスク宣言(rules.toml [[recurring]])のメタ。明細側の
        # recurring タグと合わせてUIが集計する。cycle は build 解決済み
        "recurring": recurring or [],
        # 給与明細の「勤務内容等」欄の転記(勤怠・単価・ポイント。給与タブ用)
        "salary_work": salary_work or [],
        # 適用済みの手動上書き一覧。UIの保存はこれに1件分の編集を重ねて
        # overrides.toml を丸ごと再生成する(手作業マージ不要)
        "overrides": overrides,
        # 鮮度モニタのUI状態。serve.py 配信下では /api/uistate の
        # 最新値で上書きされる(こちらは file:// 閲覧用のスナップショット)
        "uistate": uistate,
        # 直近のビルド実行ログ(ビルドログモーダル用。file:// でも遡れる
        # よう末尾だけ埋め込む。全履歴は data/build_log.jsonl)
        "build_log": build_log or [],
        "string_table": strings,
        "transactions": tx_dicts,
    }
    # 整形は ledger/*.jsonl の領分。data.js は機械が読むだけなので詰める
    js = ("const DATA = "
          + json.dumps(data, ensure_ascii=False, separators=(",", ":"))
          + ";\n")
    DATA_JS.write_text(js, encoding="utf-8")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true",
                    help="生成せず取込サマリと検証のみ表示")
    args = ap.parse_args(argv)
    if not (DATA_DIR / "accounts.toml").is_file():
        print(f"{DATA_DIR / 'accounts.toml'} が読めない(無いか権限がない)。\n"
              "  個人データを data/ に置くか、架空データを見るだけなら "
              "python3 demo/build_demo.py を実行する", file=sys.stderr)
        return 2
    try:
        return _build(args)
    except Exception:
        # 失敗も履歴に残す(成功時だけ記録すると「失敗した」ことが消える)
        if not args.check:
            append_build_log({"ok": False, "error": traceback.format_exc()})
        raise


def _build(args) -> int:
    lines: list[dict] = []

    def emit(kind: str, text: str) -> None:
        """CLIに印字しつつ、同じ行をビルドログ(build_log.jsonl)にも積む。"""
        print(text)
        lines.append({"k": kind, "t": text})

    accounts = load_accounts()
    rules = load_rules()
    inbox_notes, inbox_left = organize_inbox(dry_run=args.check)
    for n in inbox_notes:
        emit("move", ("振り分け予定: " if args.check else "振り分け: ") + n)
    if args.check and inbox_notes:
        # dry-run は移動しないため、振り分け予定のファイルはこの --check の
        # 取込件数に入っていない(「入っていない」と誤読させない)
        print("(--check は移動しないため上記は今回の取込件数に含まれない)")
    if inbox_left:
        emit("warn", "警告: inbox に形式不明のファイル: " + ", ".join(inbox_left))
    (txns, bills, skipped, invest, snapshots, manual, fetched, covers,
     salary_work) = build_transactions(rules)
    overrides = load_overrides()
    for n in apply_overrides(txns, overrides):
        emit("warn", "警告: " + n)
    if overrides:
        emit("info", f"手動上書き: {len(overrides)}件 (overrides.toml)")
    unknown = sorted({e["account"] for e in manual} - set(accounts))
    if unknown:
        emit("warn", "警告: 手入力残高に未知の口座ID: " + ", ".join(unknown))
        manual = [e for e in manual if e["account"] in accounts]
    today = date.today()
    # 取込由来のアンカー日付(鮮度用)。この後 manual に合成される
    # accrual宣言・カード未払残は「取込」ではないので含めない
    anchor_dates = ([{"date": e["date"], "account": e["account"]}
                     for e in manual]
                    + [{"date": s["date"], "account": s["account"]}
                       for s in snapshots if s.get("account")])
    accrued = accrual_entries(accounts)
    cards = [e for e in card_debt_anchors(bills, today)
             if e["account"] in accounts]
    if accrued or cards:
        # 安定ソートで合成分を先に置き、同日の手入力(balances.csv)を優先する
        manual = sorted(accrued + cards + manual,
                        key=lambda e: (e["date"], e["account"]))
    if accrued:
        emit("info", f"積み上げ宣言アンカー: {len(accrued)}点")
    card_accounts = {e["account"] for e in cards}
    if cards:
        emit("info", f"カード未払残アンカー: {len(cards)}点 "
             f"({', '.join(sorted(card_accounts))})")
    uistate = load_uistate()
    warnings = freshness_warnings(txns, accounts, today, bills, uistate,
                                  anchor_dates, fetched, covers)
    freshness = freshness_report(txns, accounts, today, bills, anchor_dates,
                                 fetched, covers)
    upcoming = upcoming_debits(txns, bills, today)
    balances = latest_balances(txns, snapshots, manual,
                               no_extrapolate=card_accounts)
    history = balance_history(txns, snapshots, manual,
                              no_extrapolate=card_accounts)

    by_acct: dict[str, int] = defaultdict(int)
    by_type: dict[str, int] = defaultdict(int)
    uncls = 0
    for t in txns:
        by_acct[t.account] += 1
        by_type[t.type] += 1
        if t.category == "未分類":
            uncls += 1
    emit("info", f"取込: {len(txns)}件  " +
         "  ".join(f"{k}:{v}" for k, v in sorted(by_acct.items())))
    emit("info",
         "種別: " + "  ".join(f"{k}:{v}" for k, v in sorted(by_type.items())))
    emit("info", f"未分類: {uncls}件")
    for r in uncategorized_ranking(txns, 8):
        emit("cand", f"  ルール追加候補: {r['count']}件 {r['amount']:>9,}円"
             f"  {r['key']}(直近 {r['last']})")
    # 中分類(チャート用)に載っていない支出カテゴリを警告(その他に埋もれるため)
    catgroups = rules.get("category_groups", {})
    covered = {c for cats in catgroups.values() for c in cats}
    uncovered = sorted({t.category for t in txns
                        if t.type == "expense" and t.category} - covered)
    if uncovered:
        emit("warn", "警告: 中分類(category_groups)に未登録の支出カテゴリ: "
             + ", ".join(uncovered))
    # チャートの色スロットは --cat1〜9 の9個(+その他)。超えた分は
    # UI が「その他」色に落とすため、増やしすぎたら統合を促す
    n_slots = len([g for g in catgroups if g != "その他"])
    if n_slots > 9:
        emit("warn", f"警告: 中分類が{n_slots}個あり色スロット(9個)を超過。"
             "超過分はチャートで「その他」色になる(統合を検討)")
    emit("info",
         f"投資イベント: {len(invest)}件  スナップショット: {len(snapshots)}件"
         f"  手入力残高: {len(manual)}点")
    for s in skipped:
        emit("skip", f"スキップ: {s}")
    rec_meta = recurring_meta(txns, rules)
    if rec_meta:
        emit("info", f"サブスク宣言: {len(rec_meta)}件 (rules.toml)")
    for n in verify_recurring(txns, rules):
        emit("verify", f"検証: {n}")
    for n in verify_balance_continuity(txns, accounts):
        emit("verify", f"検証: {n}")
    bill_notes, bill_merged = verify_card_bills(txns, bills, today,
                                                merged_periods(accounts),
                                                accounts)
    for n in bill_notes:
        emit("verify", f"検証: {n}")
    if bill_merged:
        # 合算に埋もれた引落は原理的に突合できない。1行に畳んで、本物の
        # 取り込み漏れ(上の「検証:」行)が埋もれないようにする
        total = sum(b["bill_total"] for b in bill_merged)
        names = ", ".join(accounts[a]["name"] if a in accounts else a
                          for a in sorted({b["period"]["account"]
                                           for b in bill_merged}))
        emit("info", f"合算期間: 引落と突合できない請求 {len(bill_merged)}件"
             f"(計 {total:,}円) — {names} の明細が合算行に圧縮された期間"
             f"として宣言済み")
    for w in warnings:
        emit("fresh", f"鮮度警告: {w['name']}: {w['message']}")
    if args.check:
        # 通常ビルドのたびに出すと騒がしいので、点検用レポートは --check 限定
        for n in rule_usage_report(rules):
            print(f"点検: {n}")
        for n in missing_anchor_accounts(txns, invest, balances, accounts):
            print(f"点検: {n}")

    if not args.check:
        append_build_log({"ok": True, "lines": lines})
        write_ledger(txns)
        write_data_js(txns, accounts, freshness, balances, history,
                      invest, snapshots, catgroups, overrides, uistate,
                      bills, upcoming, rec_meta, salary_work,
                      build_log=build_log_tail())
        months = sorted({t.date[:7] for t in txns})
        print(f"出力: ledger/*.jsonl ({months[0]}〜{months[-1]})" if months
              else "出力: 明細なし")
        try:
            print(f"出力: {DATA_JS.relative_to(ROOT)}")
        except ValueError:
            print(f"出力: {DATA_JS}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
