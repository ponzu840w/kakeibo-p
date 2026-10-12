"""ソース別パーサとファイル形式の自動判別。

新しいソースを追加するときの手順:
  1. parse_<source>() を書く(返り値は (txns, meta))
  2. sniff_format() に内容ベースの判別を1行足す
  3. PARSERS に登録する
  4. build.py の FORMAT_DIR に振り分け先フォルダを足す(inbox自動整理用)
  5. tests/fixtures/ に架空データのフィクスチャとテストを足す

このリポジトリに入れたくないソース(勤務先関連など)は、リポジトリ直下の
parsers_extra.py(git外・任意)に書いて register() で登録する。手順は同じで、
sniff・PARSERS・FORMAT_DIR への追加を register() が一括で担う。テストは
tests_extra/ に置けば本体のテストと一緒に discover される。
"""
from __future__ import annotations

import calendar
import csv
import io
import re
import zlib
from collections import defaultdict
from datetime import datetime
from html import unescape
from html.parser import HTMLParser
from pathlib import Path
from typing import Callable

from model import ROOT, Txn, normalize_text, parse_amount, read_text, wareki_to_iso

# ---- ローカル拡張ポイント ----
# register() で追加されたソース。判別は組み込みより先に試す(拡張が先勝ち)。
EXTRA_DIRS: dict[str, str] = {}   # 形式キー → raw/ 直下の振り分け先フォルダ
_EXTRA_SNIFFERS: list[tuple[str, Callable[[Path], bool]]] = []


def register(fmt: str, parser: Callable, raw_dir: str,
             sniff: Callable[[Path], bool]) -> None:
    """ローカル拡張ソースの登録(parsers_extra.py から呼ぶ)。

    fmt: 形式キー / parser: parse_<source> 関数 / raw_dir: inbox振り分け先 /
    sniff: このファイルが fmt かを内容で判定する述語(バイナリ等で読めない
    ファイルにも呼ばれるので、拡張側で False を返すこと)。
    """
    PARSERS[fmt] = parser
    EXTRA_DIRS[fmt] = raw_dir
    _EXTRA_SNIFFERS.append((fmt, sniff))


def sniff_format(path: Path) -> str | None:
    """ファイル内容からソース形式を判別する。不明なら None。

    バイナリはテキストとして読めないので None(=スキップ扱い)。
    PDFは既知の帳票(SBI貴金属月次報告書)だけ中身を復号して判別する。
    """
    for fmt, sniff in _EXTRA_SNIFFERS:
        if sniff(path):
            return fmt
    try:
        if path.suffix.lower() == ".pdf":
            data = path.read_bytes()
            if not data.startswith(b"%PDF"):
                return None
            text = "".join(t for pg in _pdf_text_pages(data) for _, _, t in pg)
            if ("お預かり残高等の明細" in text
                    and ("月次報告書" in text or "年次報告書" in text)):
                return "sbi_metal_report"
            return None
        if path.suffix.lower() in (".html", ".htm"):
            head = read_text(path)
            if "ゆうちょダイレクト" in head and "取引年月日" in head:
                return "yucho_html"
            if "モバイルSuica" in head and "利用履歴" in head:
                return "suica_html"
            if "my.paidy.com" in head:
                return "paidy_html"
            if "スターバックス" in head and "payment-history" in head:
                return "starbucks_html"
            if "デモDCポータル" in head:
                return "demo_dc_html"
            return None
        head = read_text(path)[:500]
    except UnicodeDecodeError:
        return None
    if head.startswith("カード名称") and "ＳＡＩＳＯＮ" in head:
        return "saison"
    if head.startswith("お客さま口座情報"):
        return "yucho_csv"
    if head.startswith("取引日,出金金額"):
        return "paypay"
    if head.startswith("デモ給与明細"):
        return "demo_kyuyo"
    if "円貨入出金明細" in head[:50]:
        return "sbisec_cash"
    if "ポートフォリオ一覧" in head[:50]:
        return "sbi_portfolio"
    if "約定履歴照会" in head[:50]:
        return "sbi_trades"
    if head.startswith('"受付番号","注文日時"'):
        return "sbi_metal"
    if head.startswith("日付,口座,残高"):
        return "manual_balances"
    # SBI証券「My資産」の資産推移CSV: ヘッダなし「YYYY/M/D,評価額」の2列のみ。
    # 特徴のない形式なので、先頭2行がともに一致することまで確認する。同形式の
    # 2列CSVを他ソースで扱うことになったら判別を見直すこと
    lines = [l.strip() for l in head.splitlines() if l.strip()]
    if (len(lines) >= 2 and
            all(re.match(r"^\d{4}/\d{1,2}/\d{1,2},\d+$", l)
                for l in lines[:2])):
        return "sbi_value_history"
    if head.startswith("年月日,お引出し,お預入れ"):
        return "smbc_csv"
    if head.startswith("会員番号,"):
        return "view_csv"
    if head.startswith('"日付","内容","出金金額(円)"'):
        return "neobank_csv"
    if head.startswith('"取引日","摘要","出金金額"'):
        return "shinsei_csv"
    if head.startswith('"日付","時間","タイムゾーン"'):
        return "paypal_csv"
    if head.startswith("年月日,取扱店・摘要"):
        return "yucho_paper"
    return None


def parse_saison(path: Path) -> tuple[list[Txn], dict]:
    """セゾンNetアンサーの月次請求CSV。

    構造: メタ3行(カード名称/お支払日/今回ご請求額) + 空行 + 明細表。
    利用日が空の行は直前明細の店名・備考の継続行なのでマージする。
    金額は正=利用(負債増)、負=返品。口座残高への変化としては符号反転する。
    """
    src = str(path.relative_to(ROOT))
    rows = list(csv.reader(io.StringIO(read_text(path))))
    meta: dict = {}
    header_idx = None
    for i, row in enumerate(rows):
        if not row:
            continue
        if row[0] == "お支払日":
            meta["pay_date"] = row[1].replace("/", "-")
        elif row[0] == "今回ご請求額":
            meta["bill_total"] = parse_amount(row[1])
        elif row[0] == "利用日":
            header_idx = i
            break
    if header_idx is None:
        raise ValueError(f"{src}: 明細ヘッダ行が見つからない")

    txns: list[Txn] = []
    for row in rows[header_idx + 1:]:
        if not row or all(c.strip() == "" for c in row):
            continue
        use_date, shop, _kubun, _shiharai, _shimemae, amount_s, remark = (
            (row + [""] * 7)[:7]
        )
        if use_date.strip() == "":
            # 継続行: 店名の続き(住所等)と備考の続きを直前明細へ
            if not txns:
                continue
            prev = txns[-1]
            if shop.strip():
                prev.raw_description += " " + shop.strip()
                prev.description = normalize_text(prev.raw_description)
            if remark.strip():
                prev.memo = (prev.memo + " " + remark.strip()).strip()
            continue
        amount = parse_amount(amount_s)
        if amount is None:
            continue
        txns.append(Txn(
            account="saison",
            date=use_date.replace("/", "-"),
            amount=-amount,      # 利用=負債増を負で表す。返品(負)は正になる
            description=normalize_text(shop),
            raw_description=shop.strip(),
            source=src,
            memo=remark.strip(),
            type="expense",      # カードは返品含め支出側で相殺する
        ))
    return txns, meta


def parse_yucho_csv(path: Path) -> tuple[list[Txn], dict]:
    """ゆうちょダイレクト入出金明細CSV。CP932・古い順・残高列あり。

    ヘッダ部の「出力日時:令和 NN 年 MM 月 DD 日 …」がDL日(取込日として申告)。

    利息の入金は「受取利子(税引後・残高あり)」の行の直後に、「利子」「税金」の
    内訳行が残高空欄で続く(実例 2026-10-01: 604 = 756 − 152)。内訳行も取り込むと
    二重計上になるので、取り込まずに直前行のmemoへ残す。残高空欄の行が続いても、
    その合計が直前行の金額と一致しなければ内訳と断定できないので、通常どおり取り込む。
    """
    src = str(path.relative_to(ROOT))
    text = read_text(path)
    rows = list(csv.reader(io.StringIO(text)))
    header_idx = _header_index(rows, "取引日", src)

    txns: list[Txn] = []
    for row in rows[header_idx + 1:]:
        if not row or row[0].strip() == "":
            continue
        d, native_id, in_s, out_s, d1, d2, bal_s = (row + [""] * 7)[:7]
        if not re.match(r"^\d{8}$", d.strip()):
            continue
        date_iso = f"{d[0:4]}-{d[4:6]}-{d[6:8]}"
        amount_in = parse_amount(in_s)
        amount_out = parse_amount(out_s)
        amount = (amount_in or 0) - (amount_out or 0)
        raw_desc = " ".join(x.strip() for x in (d1, d2) if x.strip())
        txns.append(Txn(
            account="yucho",
            date=date_iso,
            amount=amount,
            description=normalize_text(raw_desc),
            raw_description=raw_desc,
            source=src,
            native_id=native_id.strip(),
            balance=parse_amount(bal_s),
        ))
    txns = _fold_yucho_breakdown(txns)
    m = re.search(r"出力日時[:：]\s*令和\s*(\d+)\s*年\s*(\d+)\s*月"
                  r"\s*(\d+)\s*日", text)
    meta = _fetched("yucho", f"{2018 + int(m.group(1))}-{int(m.group(2)):02d}-"
                    f"{int(m.group(3)):02d}") if m else {}
    return txns, meta


def _fold_yucho_breakdown(txns: list[Txn]) -> list[Txn]:
    out: list[Txn] = []
    i = 0
    while i < len(txns):
        t = txns[i]
        out.append(t)
        j = i + 1
        while j < len(txns) and txns[j].balance is None:
            j += 1
        run = txns[i + 1:j]
        if (run and t.balance is not None
                and sum(r.amount for r in run) == t.amount):
            t.memo = "内訳: " + " / ".join(
                f"{r.raw_description} {r.amount:+,}" for r in run)
            i = j
        else:
            i += 1
    return out


class _YuchoHtmlTable(HTMLParser):
    """取扱内容照会(通帳未記入分)ページの明細テーブルを抽出する。"""

    def __init__(self):
        super().__init__()
        self.rows: list[list[str]] = []
        self._in_td = False
        self._cell: list[str] = []
        self._row: list[str] = []

    def handle_starttag(self, tag, attrs):
        if tag == "td":
            self._in_td = True
            self._cell = []
        elif tag == "tr":
            self._row = []

    def handle_endtag(self, tag):
        if tag == "td":
            self._in_td = False
            self._row.append(" ".join("".join(self._cell).split()))
        elif tag == "tr" and self._row:
            self.rows.append(self._row)

    def handle_data(self, data):
        if self._in_td:
            self._cell.append(data)


def parse_yucho_html(path: Path) -> tuple[list[Txn], dict]:
    """ゆうちょダイレクト「取扱内容照会」保存HTML(通帳未記入分)。

    - 日付は元号名なしの令和和暦(例 8-07-14)。
    - 新しい順に並ぶので古い順に反転してから返す。
    - 「通帳の現在高」行は取引ではないので読み飛ばす。
    - 「通帳未記入金合計 合算 N」行は複数取引の合算。取引として取り込み、
      rules.toml で adjustment 扱いにして収支集計から外す。
    - SingleFileの保存日を取込日として申告する。
    """
    src = str(path.relative_to(ROOT))
    html = read_text(path)
    parser = _YuchoHtmlTable()
    parser.feed(html)
    txns: list[Txn] = []
    for row in parser.rows:
        if len(row) != 5:
            continue
        d, in_s, out_s, desc, bal_s = row
        if "通帳の現在高" in desc:
            continue
        try:
            date_iso = wareki_to_iso(normalize_text(d))
        except ValueError:
            continue
        amount_in = parse_amount(in_s)
        amount_out = parse_amount(out_s)
        if amount_in is None and amount_out is None:
            continue
        amount = (amount_in or 0) - (amount_out or 0)
        txns.append(Txn(
            account="yucho",
            date=date_iso,
            amount=amount,
            description=normalize_text(desc),
            raw_description=desc,
            source=src,
            balance=parse_amount(bal_s),
        ))
    txns.reverse()  # 画面は新しい順
    return txns, _fetched("yucho", _singlefile_date(html, path))


def parse_suica_html(path: Path) -> tuple[list[Txn], dict]:
    """モバイルSuica「SF(電子マネー)利用履歴」の保存HTML。

    - ブラウザのCtrl+S保存(CP932)とSingleFile保存(UTF-8)の両方を内容で受ける。
      サイトはPOST描画のためCtrl+Sでは検索結果が保存されない。過去分の収集は
      SingleFile等で表示中DOMを保存する運用。
    - 行の日付は MM/DD で年がない。「表示対象」セレクトの selected 年月を
      アンカーに、新しい順の並びで月が増えたら年を1つ戻して復元する
      (履歴は最大26週なので12ヶ月を跨ぐ曖昧さはない)。
    - 残高列があるため (日付, 金額, 残高) を実質一意なIDに使い、期間の重なる
      複数保存(1頁最大100件で分割される)をファイル横断で重複排除する。
      同一日に同じ金額・同じ残高が再現するのは往復同額の循環が要るため実質ない。
    - 「繰」(繰越)行は金額がないので取引としては読まない。
    - SingleFileの保存日(なければファイル名の日付)を取込日として申告する。
    """
    src = str(path.relative_to(ROOT))
    html = read_text(path)
    anchor = None
    for opt in re.finditer(r"<option\b[^>]*>", html):
        tag = opt.group(0)
        if "selected" in tag:
            m = re.search(r'value="?(\d{4})/(\d{2})', tag)
            if m:
                anchor = (int(m.group(1)), int(m.group(2)))
                break
    if anchor is None:
        raise ValueError("表示対象の年月(selectedオプション)が見つからない")
    year, prev_month = anchor
    parser = _YuchoHtmlTable()   # 汎用のtdテーブル抽出として流用
    parser.feed(html)
    txns: list[Txn] = []
    occ: dict[tuple, int] = defaultdict(int)
    for row in parser.rows:
        cells = [normalize_text(c) for c in row]
        di = next((i for i, c in enumerate(cells)
                   if re.match(r"^\d{2}/\d{2}$", c)), None)
        if di is None:
            continue
        month, day = int(cells[di][:2]), int(cells[di][3:])
        if month > prev_month:      # 新しい順で月が増えた=年を跨いだ
            year -= 1
        prev_month = month
        kind1, place1, kind2, place2, bal_s, amount_s = (
            (cells[di + 1:di + 7] + [""] * 6)[:6])
        amount = parse_amount(amount_s)
        if amount is None:          # 「繰」(繰越)行など
            continue
        balance = parse_amount(re.sub(r"[¥\\￥]", "", bal_s))
        date_iso = f"{year:04d}-{month:02d}-{day:02d}"
        desc = " ".join(x for x in (kind1, place1, kind2, place2) if x)
        key = (date_iso, amount, balance)
        nid = f"{date_iso}|{amount}|{balance}|{occ[key]}"
        occ[key] += 1
        txns.append(Txn(
            account="suica",
            date=date_iso,
            amount=amount,
            description=desc,
            raw_description=" ".join(x for x in row if x),
            source=src,
            native_id=nid,
            balance=balance,
        ))
    txns.reverse()  # 画面は新しい順
    return txns, _fetched("suica", _singlefile_date(html, path))


def parse_yucho_paper(path: Path) -> tuple[list[Txn], dict]:
    """ゆうちょ紙通帳のOCR起こしCSV(手作業・UTF-8 BOM・古い順・現在高列)。

    形式: 年月日,取扱店・摘要,お支払金額,お預り金額,現在高。
    年月日が空の行は2種類を現在高列の有無で見分ける:
    - 現在高が空: 直前の「受取利子」行の内訳(利子/税金。額面は親行に
      ネット済みで残高は動かない)なので読み飛ばす。
    - 現在高あり: 残高が動く独立取引(例: 振込直後の「料金」=振込手数料)。
      通帳が日付欄を省略して印字するため、直前取引の日付を引き継いで取り込む。
    「合算 N」行は複数取引の合算で、rules.toml で adjustment 扱いにして
    収支集計から外す。過去分の一回きりのデータで、以後増えない。
    """
    src = str(path.relative_to(ROOT))
    rows = list(csv.reader(io.StringIO(read_text(path))))
    txns: list[Txn] = []
    last_date = ""
    for row in rows[1:]:
        if len(row) < 5:
            continue
        d = row[0].strip()
        if re.match(r"^\d{4}-\d{2}-\d{2}$", d):
            last_date = d
        elif last_date and parse_amount(row[4]) is not None:
            d = last_date          # 日付省略の独立取引(料金等)
        else:
            continue               # 受取利子の内訳サブ行・空行
        amount = (parse_amount(row[3]) or 0) - (parse_amount(row[2]) or 0)
        txns.append(Txn(
            account="yucho",
            date=d,
            amount=amount,
            description=normalize_text(row[1]),
            raw_description=row[1].strip(),
            source=src,
            balance=parse_amount(row[4]),
        ))
    return txns, {}


def parse_smbc_csv(path: Path) -> tuple[list[Txn], dict]:
    """三井住友銀行の入出金明細CSV(CP932・新しい順・残高列あり)。

    日付は 2026/5/13 のようにゼロ埋めなし。金額ゼロかつ摘要空の行
    (口座開設時の形跡等)は取引ではないので読み飛ばす。
    """
    src = str(path.relative_to(ROOT))
    rows = list(csv.reader(io.StringIO(read_text(path))))
    txns: list[Txn] = []
    for row in rows[1:]:
        if len(row) < 5:
            continue
        m = re.match(r"^(\d{4})/(\d{1,2})/(\d{1,2})$", row[0].strip())
        if not m:
            continue
        date_iso = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
        amount = (parse_amount(row[2]) or 0) - (parse_amount(row[1]) or 0)
        desc = normalize_text(row[3])
        if amount == 0 and not desc:
            continue
        memo = row[5].strip() if len(row) > 5 else ""
        txns.append(Txn(
            account="smbc",
            date=date_iso,
            amount=amount,
            description=desc,
            raw_description=row[3].strip(),
            source=src,
            balance=parse_amount(row[4]),
            memo=memo,
        ))
    txns.reverse()  # CSVは新しい順
    return txns, {}


def parse_view_csv(path: Path) -> tuple[list[Txn], dict]:
    """ビューカード(VIEW's NET)の月次ご利用明細CSV(CP932)。

    構造: メタ4行(会員番号/対象カード/お支払日/今回お支払金額) + 空行 +
    明細表 + カード番号行(読み飛ばす)。セゾン同様、請求メタを突合検証と
    鮮度判定に使う。金額は 払戻額 − ご利用額(利用=負債増を負で表す)。
    """
    src = str(path.relative_to(ROOT))
    rows = list(csv.reader(io.StringIO(read_text(path))))
    meta: dict = {"account": "viewcard"}
    header_idx = None
    for i, row in enumerate(rows):
        if not row:
            continue
        if row[0] == "お支払日":
            m = re.match(r"(\d{4})年(\d{2})月(\d{2})日", row[1].strip())
            if m:
                meta["pay_date"] = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
        elif row[0] == "今回お支払金額":
            meta["bill_total"] = parse_amount(row[1])
        elif row[0] == "ご利用年月日":
            header_idx = i
            break
    if header_idx is None:
        raise ValueError("明細ヘッダ行が見つからない")
    txns: list[Txn] = []
    for row in rows[header_idx + 1:]:
        if len(row) < 8 or not re.match(r"^\d{4}/\d{2}/\d{2}$", row[0].strip()):
            continue  # カード番号行・空行
        use = parse_amount(row[2])
        refund = parse_amount(row[3])
        amount = (refund or 0) - (use or 0)
        if amount == 0:
            continue
        shiharai = normalize_text(row[5])
        txns.append(Txn(
            account="viewcard",
            date=row[0].replace("/", "-"),
            amount=amount,
            description=normalize_text(row[1]),
            raw_description=row[1].strip(),
            source=src,
            memo="" if shiharai in ("", "1回払") else shiharai,
            type="expense",   # カードは返品含め支出側で相殺する
        ))
    return txns, meta


def parse_starbucks_html(path: Path) -> tuple[list[Txn], dict]:
    """スターバックスカードの利用履歴ページ(SingleFile保存HTML)。

    SPAだが payment-history-* のセマンティックなclassが付いており、
    名称・金額(±¥)・日付を行単位で抽出できる。残高表示はページにない。
    金額0円の行(カード発行等)は取引ではないので読み飛ばす。
    SingleFileの保存日を取込日として申告する。
    """
    src = str(path.relative_to(ROOT))
    html = read_text(path)
    txns: list[Txn] = []
    for m in re.finditer(
            r'payment-history-name[^>]*>(.*?)<p\s+class="?payment-history-amount'
            r'.*?<span[^>]*>\s*(-?)\s*[¥￥]([\d,]+)</span>'
            r'<span[^>]*>(\d{4}/\d{2}/\d{2})', html, re.S):
        name = normalize_text(unescape(re.sub(r"<[^>]+>", " ", m.group(1))))
        amount = int(m.group(3).replace(",", ""))
        if m.group(2):
            amount = -amount
        if amount == 0:
            continue
        txns.append(Txn(
            account="starbucks",
            date=m.group(4).replace("/", "-"),
            amount=amount,
            description=name,
            raw_description=name,
            source=src,
        ))
    txns.reverse()  # 画面は新しい順
    return txns, _fetched("starbucks", _singlefile_date(html, path))


# NEOBANK明細の口座帰属の切替日。2026-08 のスイープ先移行に伴い
# ハイブリッド預金の連携を解除したため、これ以降の日付の行は
# 代表口座(sbinet)のもの(ハイブリッド預金の明細はもう出力できない。
# 既知のハイブリッド預金最終行は 2026-08-05、代表口座の初行は 2026-08-14)。
NEOBANK_SBINET_FROM = "2026-08-14"


def parse_neobank_csv(path: Path) -> tuple[list[Txn], dict]:
    """住信SBIネット銀行(NEOBANK)の入出金明細CSV(CP932・新しい順・残高列あり)。

    ハイブリッド預金の連携解除(2026-08)まで、この口座の用途は
    SBIハイブリッド預金のみ(代表口座は取引がなくCSVを出力できなかった)
    ため sbi_hybrid 口座として取り込む。SBI証券側の
    「SBIハイブリッド預金より/へ自動振替」とペアになる。
    連携解除後は代表口座の明細だけが出力できる(同じCSV形式)ため、
    NEOBANK_SBINET_FROM 以降の日付の行は sbinet 口座に帰属させる
    (実例: 解約時の未払利子 9円が摘要「ＳＢＩハイブリッド預金」で
    代表口座に入金された)。
    DL時の既定ファイル名 nyushukinmeisai_YYYYMMDD.csv の日付がDL日
    (取込日として申告。リネームされていれば警告を出さずに取込日なしとして扱う)。
    """
    src = str(path.relative_to(ROOT))
    rows = list(csv.reader(io.StringIO(read_text(path))))
    txns: list[Txn] = []
    for row in rows[1:]:
        if len(row) < 5 or not re.match(r"^\d{4}/\d{2}/\d{2}$", row[0].strip()):
            continue
        date = row[0].replace("/", "-")
        amount = (parse_amount(row[3]) or 0) - (parse_amount(row[2]) or 0)
        memo = row[5].strip() if len(row) > 5 else ""
        txns.append(Txn(
            account="sbinet" if date >= NEOBANK_SBINET_FROM else "sbi_hybrid",
            date=date,
            amount=amount,
            description=normalize_text(row[1]),
            raw_description=row[1].strip(),
            source=src,
            balance=parse_amount(row[4]),
            memo="" if memo == "-" else memo,
        ))
    txns.reverse()  # CSVは新しい順
    fetched_acct = ("sbinet" if txns and all(t.account == "sbinet"
                                             for t in txns) else "sbi_hybrid")
    meta = _fetched_from_name(fetched_acct,
                              r"nyushukinmeisai_(\d{4})(\d{2})(\d{2})", path)
    return txns, meta


def parse_shinsei_csv(path: Path) -> tuple[list[Txn], dict]:
    """SBI新生銀行の入出金明細CSV(UTF-8 BOM・新しい順・残高列あり)。

    この口座の用途はSBIハイパー預金(SBI証券との連動預金。2026-08に
    SBIハイブリッド預金から移行)のみのため、sbi_shinsei 口座として取り込む。
    スイープは摘要「SBI証券精算」で rules.toml の振替ルールが捕捉する。
    SBI証券の円貨入出金明細側にも対応行(「SBIハイパー預金へ/より自動振替」)が
    出るが、「スィープ専用銀行口座 明細表示」を付けてDLしたときだけ。
    こちらの明細が正で、証券側の行はあってもなくてもよい。
    取引日には未来日(受渡予定)が入ることがある。そのまま取り込む。
    DL既定ファイル名 JPY_HY_YYYYMMDDhhmmss.csv の日付がDL日(取込日として
    申告。リネームされていれば警告を出さずに取込日なしとして扱う)。
    """
    src = str(path.relative_to(ROOT))
    rows = list(csv.reader(io.StringIO(read_text(path))))
    txns: list[Txn] = []
    for row in rows[1:]:
        if len(row) < 5 or not re.match(r"^\d{4}/\d{2}/\d{2}$", row[0].strip()):
            continue
        amount = (parse_amount(row[3]) or 0) - (parse_amount(row[2]) or 0)
        memo = row[5].strip() if len(row) > 5 else ""
        txns.append(Txn(
            account="sbi_shinsei",
            date=row[0].replace("/", "-"),
            amount=amount,
            description=normalize_text(row[1]),
            raw_description=row[1].strip(),
            source=src,
            balance=parse_amount(row[4]),
            memo=memo,
        ))
    txns.reverse()  # CSVは新しい順
    meta = _fetched_from_name("sbi_shinsei", r"JPY_HY_(\d{4})(\d{2})(\d{2})",
                              path)
    return txns, meta


def parse_paypal_csv(path: Path) -> tuple[list[Txn], dict]:
    """PayPalの取引履歴CSV(UTF-8 BOM)。JPYかつ完了の取引のみ取り込む。

    「合計」が手数料込みの残高変化、取引IDが一意キー。ヘッダのみの
    ファイル(取引ゼロ)も正常に0件として扱う。
    """
    src = str(path.relative_to(ROOT))
    reader = csv.DictReader(io.StringIO(read_text(path)))
    txns: list[Txn] = []
    for row in reader:
        if (row.get("通貨") or "").strip() != "JPY":
            continue
        status = (row.get("ステータス") or "").strip()
        if status and status != "完了":
            continue
        d = (row.get("日付") or "").strip()
        m = re.match(r"^(\d{4})/(\d{1,2})/(\d{1,2})$", d)
        if not m:
            continue
        amount = parse_amount(row.get("合計") or "")
        if amount is None:
            continue
        name = (row.get("名前") or "").strip()
        typ = (row.get("タイプ") or "").strip()
        raw_desc = " ".join(x for x in (typ, name) if x)
        txns.append(Txn(
            account="paypal",
            date=f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}",
            amount=amount,
            description=normalize_text(raw_desc),
            raw_description=raw_desc,
            source=src,
            native_id=(row.get("取引ID") or "").strip(),
            balance=parse_amount(row.get("残高") or ""),
            memo=(row.get("時間") or "").strip(),
        ))
    txns.sort(key=lambda t: t.date)   # 並び順はエクスポート設定依存のため揃える
    return txns, {}


# Paidyページの行として解釈するパターン。SPAのclass名はハッシュ化されて
# いるため、タグ除去後のテキストに対して既知の行型のみを決定論的に拾う。
# 新しい行型(通常あと払いの店舗利用等)が現れたらここに追加すること。
_PAIDY_ROW = re.compile(
    r"(\d+回あと払い支払額|お支払い受領|\d+月分の支払い)\s+"
    r"(\d{4}/\d{2}/\d{2})\s+(-?[\d,]+)\s*円(?:\s+(\d+回目/\d+回あと払い))?")
# 分割プラン詳細(モーダル)。見出し→購入店舗→購入日→ご注文番号→商品明細
# →合計、の並びをテキスト化した流れで拾う。見出しは2026-07時点で
# 「分割あと払い（未確定）」、2026-09以降の保存では「一括払い」
_PAIDY_PLAN = re.compile(
    r"(?:分割あと払い(?:（[^）]*）)?|一括払い)\s+(.{1,80}?)\s+"
    r"購入日 (\d{4}/\d{2}/\d{2})\s+"
    r"ご注文番号 (\S+)\s+(.+?)\s+合計 ([\d,]+)\s*円")
# 通常あと払い(Apple以外)の購入一覧。各購入は1つのbuttonに収まり、
# 中身は「店舗 購入日 金額 円 N回あと払い」。2026-10時点のtestidは
# uncaptured-payments-item-N(「未確定」見出しの下)。見出しはbuttonの外
_PAIDY_ITEM = re.compile(
    r'<button[^>]*data-testid="?[^" >]*payments-item-\d+[^>]*>(.*?)</button>',
    re.S)
_PAIDY_ITEM_TEXT = re.compile(
    r"(.+?)\s+(\d{4}/\d{2}/\d{2})\s+([\d,]+)\s*円\s+(\d+回あと払い)")
_SINGLEFILE_DATE = re.compile(
    r"saved date: \w{3} (\w{3}) (\d{1,2}) (\d{4})")
_MONTHS_EN = {m: i + 1 for i, m in enumerate(
    ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
     "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"])}


def _singlefile_date(html: str, path: Path) -> str:
    """SingleFile保存HTMLの保存日(なければファイル名中の日付)をISOで返す。"""
    m = _SINGLEFILE_DATE.search(html)
    if m and m.group(1) in _MONTHS_EN:
        return f"{m.group(3)}-{_MONTHS_EN[m.group(1)]:02d}-{int(m.group(2)):02d}"
    m = re.search(r"(\d{4})_(\d{1,2})_(\d{1,2})", path.name)
    if m:
        return f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    return ""


def _fetched(account: str, date_iso: str) -> dict:
    """取込日(明細をDL・保存した日)のメタ。鮮度モニタが「取込」の日付に使う。
    最終レコードの取引日は取得日より古いのが普通で、鮮度をレコード日で測ると
    実際より古く見える。取得日が分かるソースはこれで正直に申告する。
    日付が取れない・不正なら {} を返す(取込自体は止めない)。"""
    try:
        datetime.strptime(date_iso or "", "%Y-%m-%d")
    except ValueError:
        return {}
    return {"fetched": {"account": account, "date": date_iso}}


def _fetched_from_name(account: str, pattern: str, path: Path) -> dict:
    """DL既定ファイル名の (YYYY)(MM)(DD) 3群から取込日メタを作る。
    リネームされていれば警告を出さずに取込日なしとして扱う。"""
    m = re.match(pattern, path.name)
    return (_fetched(account, f"{m.group(1)}-{m.group(2)}-{m.group(3)}")
            if m else {})


def _header_index(rows: list[list[str]], label: str, src: str) -> int:
    """先頭セルが label の見出し行の添字。無ければ形式変化としてエラー。"""
    for i, row in enumerate(rows):
        if row and row[0].strip() == label:
            return i
    raise ValueError(f"{src}: 明細ヘッダ行({label})が見つからない")


def _html_text(html: str) -> str:
    """HTMLをプレーンテキスト化(script/style除去→タグ除去→空白畳み)。"""
    text = re.sub(r"<script.*?</script>|<style.*?</style>", " ", html,
                  flags=re.S)
    return re.sub(r"\s+", " ", unescape(re.sub(r"<[^>]+>", " ", text)))


def parse_paidy_html(path: Path) -> tuple[list[Txn], dict]:
    """Paidyのご利用明細ページ(SingleFile保存HTML)。CSV提供がないため
    SPAの描画済みDOMをテキスト化して既知の行型だけを拾う。

    - 分割プラン詳細(購入店舗・購入日・ご注文番号・合計)= 購入の支出を
      購入日に一括計上する(カード類と同じ利用時計上)。ご注文番号を
      native_id にするので、詳細が写った保存が raw/ に1枚あれば、以後の
      保存に写らなくても購入行は安定して再生成される。
      **Apple専用プランを組んだら、プラン詳細を開いた状態で保存する**
      (下記のとおり支払額行は取引にしないため、詳細が無いと支出が欠ける)。
    - 通常あと払い(Apple以外)の購入一覧の行 = 購入の支出を購入日に一括
      計上する。ご注文番号が無いので内容キー(日付・金額・店舗)で冪等。
      同じ購入のプラン詳細が同じ保存に写っていても一覧側を正とする
      (詳細の有無で保存ごとに照合キーが変わると二重計上になるため)。
    - 「N回あと払い支払額」= 月次の請求確定の情報行。購入時に全額計上済み
      のため取引にしない(取ると二重計上になる)。
    - 「N月分の支払い」= 口座振替(ゆうちょ側と突合する振替)。
    - 「お支払い受領」= 同じ支払いの「ご利用履歴」欄での別表示。月分行の
      表示が受領より数日遅れる月がある(rules.toml の振替窓の実例)ため、
      その窓で保存すると受領行だけが写り、次の保存の月分行と重複排除キー
      (摘要)が合わず二重計上になる。よって受領行は常に捨て、月分行だけを
      正とする(お支払い履歴は直近3件表示なので月1保存なら漏れない)。
    - ページ上の符号は利用者視点(支払い=マイナス)。口座残高への変化としては
      反転する(購入=負債増=負、支払い=負債減=正)。
    - 「ご利用総額」(分割残債)を負債残高アンカーとして返す。時点は
      SingleFileの保存日時(なければファイル名の日付)。購入一括計上とは
      「購入合計 - 受領済み支払い累計 = 残債」で整合する。
    """
    src = str(path.relative_to(ROOT))
    html = read_text(path)
    text = _html_text(html)
    # 残債(Apple分と通常分の合計)。総額欄が読めたかを覚えておき、
    # 完済(0円)でも0円アンカーを出す(欄自体が無い保存とは区別する)
    debt = 0
    debt_found = False
    non_apple = 0
    for pat in (r"ご利用総額 Apple以外 ([\d,]+) 円",
                r"Apple利用総額 Appleのみ ([\d,]+) 円"):
        m = re.search(pat, text)
        if m:
            debt_found = True
            amt = int(m.group(1).replace(",", ""))
            debt += amt
            if "Apple以外" in pat:
                non_apple = amt
    snap_date = _singlefile_date(html, path)
    # 取引にするのは「N月分の支払い」だけ。「お支払い受領」は同一支払いの
    # 別表示、「N回あと払い支払額」は購入時計上済みの情報行(詳細はdocstring)
    txns = [Txn(
        account="paidy",
        date=m.group(2).replace("/", "-"),
        amount=-int(m.group(3).replace(",", "")),  # ページ符号を反転
        description=normalize_text(m.group(1)),
        raw_description=m.group(1),
        source=src,
        memo=m.group(4) or "",
    ) for m in _PAIDY_ROW.finditer(text) if "月分の支払い" in m.group(1)]
    items_total = 0
    listed = set()
    for b in _PAIDY_ITEM.finditer(html):
        m = _PAIDY_ITEM_TEXT.fullmatch(_html_text(b.group(1)).strip())
        if not m:
            continue
        store, day, total, plan = m.groups()
        amount = int(total.replace(",", ""))
        items_total += amount
        listed.add((day, amount))
        txns.append(Txn(
            account="paidy",
            date=day.replace("/", "-"),
            amount=-amount,
            description=normalize_text(store),
            raw_description=store,
            source=src,
            memo=plan,
        ))
    # 分割プラン詳細から購入を購入日に一括計上(ご注文番号で冪等)
    for m in _PAIDY_PLAN.finditer(text):
        store, day, order_no, items, total = m.groups()
        if (day, int(total.replace(",", ""))) in listed:
            continue
        txns.append(Txn(
            account="paidy",
            date=day.replace("/", "-"),
            amount=-int(total.replace(",", "")),
            description=normalize_text(store),
            raw_description=store,
            source=src,
            native_id=order_no,
            memo=re.sub(r"\s*[\d,]+\s*円", "", items).strip(),  # 商品名
        ))
    txns.sort(key=lambda t: t.date)
    meta = {}
    if debt_found and snap_date:
        meta = {"kind": "balances", "entries": [{
            "date": snap_date, "account": "paidy",
            "balance": -debt, "memo": "", "note": "残債" if debt else "完済",
        }], "source": src}
    if non_apple > items_total:
        # 残債は購入一覧の合計を超えない。超えたら未知の行型(翌月一括払い、
        # 確定後の一覧の形式変化等)で購入が落ちており、支出が気づかないうちに欠ける
        meta["warnings"] = ["ご利用総額(Apple以外)が" f"{non_apple:,}円で、"
                            f"拾えた購入の合計{items_total:,}円を超える。"
                            "未知の行型で購入が落ちている可能性(パーサ要確認)"]
    return txns, meta


def parse_paypay(path: Path) -> tuple[list[Txn], dict]:
    """PayPay取引履歴CSV。UTF-8(BOM)・新しい順・取引番号あり。

    取引内容で弁別する:
      支払い / 送った金額            → expense
      ポイント、残高の獲得 / 受け取った金額 → income
      チャージ                       → 摘要に取引方法(チャージ元)を含めて
                                       rules.toml の振替ルールに委ねる
    支払いとポイント獲得は同じ取引番号を共有するため、
    重複排除キーには取引番号+取引内容+金額を使う(build側)。
    DL時の既定ファイル名 Transactions_YYYYMMDD-YYYYMMDD.csv の範囲末尾は
    「この日までの明細を要求した」日なので、取込日として申告する
    (最終取引日より新しければ「その間は利用なし」の確認になる)。
    """
    src = str(path.relative_to(ROOT))
    reader = csv.DictReader(io.StringIO(read_text(path)))
    txns: list[Txn] = []
    for row in reader:
        kind = (row.get("取引内容") or "").strip()
        if not kind:
            continue
        amount_out = parse_amount(row.get("出金金額（円）") or "")
        amount_in = parse_amount(row.get("入金金額（円）") or "")
        amount = (amount_in or 0) - (amount_out or 0)
        partner = (row.get("取引先") or "").strip()
        method = (row.get("取引方法") or "").strip()
        if kind == "チャージ":
            raw_desc = f"{kind} {method}"       # 例: チャージ ゆうちょ銀行 *****41
        else:
            raw_desc = f"{kind} {partner}".strip()
        type_hint = {
            "支払い": "expense",
            "送った金額": "expense",
            "ポイント、残高の獲得": "income",
            "受け取った金額": "income",
            "チャージ": "",
        }.get(kind, "")
        dt = (row.get("取引日") or "").strip()
        date_iso = dt[:10].replace("/", "-")
        # 取引番号が空の行に ":支払い" のような擬似IDを与えると別取引同士が
        # 同一視されて1件にまとめられてしまうため、空なら汎用キー(dedupのフォールバック)に任せる
        bango = (row.get("取引番号") or "").strip()
        txns.append(Txn(
            account="paypay",
            date=date_iso,
            amount=amount,
            description=normalize_text(raw_desc),
            raw_description=raw_desc,
            source=src,
            native_id=f"{bango}:{kind}" if bango else "",
            memo=f"{method} {dt[11:]}".strip(),
            type=type_hint,
        ))
    txns.reverse()  # CSVは新しい順
    meta = _fetched_from_name(
        "paypay", r"Transactions_\d{8}-(\d{4})(\d{2})(\d{2})", path)
    return txns, meta


def _num(s: str) -> float | None:
    """'95,068.5' '+11.23' '--' '----/--/--' → float | None。"""
    s = (s or "").strip().replace(",", "").lstrip("+")
    if s in ("", "-", "--") or s.startswith("----"):
        return None
    try:
        return float(s)
    except ValueError:
        return None


def parse_sbisec_cash(path: Path) -> tuple[list[Txn], dict]:
    """SBI証券の円貨入出金明細CSV。UTF-8(BOM)・新しい順・残高列なし。

    ハイブリッド預金スイープ・貴金属口座振替・銀行からの入金は
    rules.toml の振替ルールで捕捉する。配当金は収入。
    DL時の既定ファイル名 DetailInquiry_YYYYMMDDhhmmss.csv の日付がDL日
    (取込日として申告)。
    """
    src = str(path.relative_to(ROOT))
    rows = list(csv.reader(io.StringIO(read_text(path))))
    header_idx = _header_index(rows, "入出金日", src)
    txns: list[Txn] = []
    for row in rows[header_idx + 1:]:
        if len(row) < 6 or not re.match(r"^\d{4}/\d{2}/\d{2}$", row[0].strip()):
            continue
        d, _inout, kubun, desc, out_s, in_s = row[:6]
        amount = int(_num(in_s) or 0) - int(_num(out_s) or 0)
        txns.append(Txn(
            account="sbisec",
            date=d.replace("/", "-"),
            amount=amount,
            description=normalize_text(desc),
            raw_description=desc.strip(),
            source=src,
            memo=kubun.strip(),
        ))
    txns.reverse()  # CSVは新しい順
    meta = _fetched_from_name("sbisec",
                              r"DetailInquiry_(\d{4})(\d{2})(\d{2})", path)
    return txns, meta


def parse_sbi_portfolio(path: Path) -> tuple[list[Txn], dict]:
    """SBI証券のポートフォリオ一覧CSV(CP932)。取引ではなく保有スナップショット。

    ファイル内容に日付が一切ないため、取得日は YYYY-MM-DD_ プレフィックスが
    あればそれを、なければファイル更新時刻(=DL時刻)を使う。後者は推定なので
    残高アンカーの note に明記する。リネームなしでも機械的に取込める。
    セクション(株式/投資信託×預り区分)ごとに銘柄行を拾い、
    「総合計」ブロックの評価額を口座残高アンカーに使う。
    """
    src = str(path.relative_to(ROOT))
    m = re.match(r"^(\d{4}-\d{2}-\d{2})_", path.name)
    if m:
        snap_date, date_note = m.group(1), "評価額"
    else:
        snap_date = datetime.fromtimestamp(
            path.stat().st_mtime).strftime("%Y-%m-%d")
        date_note = "評価額・取得日はDL時刻から推定"
    rows = list(csv.reader(io.StringIO(read_text(path))))
    holdings: list[dict] = []
    section = ""
    grand_total = None
    grand_pl = None
    in_grand = False
    for row in rows:
        if not row or not row[0].strip():
            continue
        c0 = row[0].strip()
        if c0 == "総合計":
            in_grand = True
            continue
        if in_grand and _num(c0) is not None:
            grand_total, grand_pl = _num(c0), _num(row[1]) if len(row) > 1 else None
            in_grand = False
            continue
        if re.match(r"^(株式|投資信託)（", c0):
            section = c0
            continue
        if "合計" in c0 or c0 in ("銘柄（コード）", "ファンド名"):
            continue
        # 銘柄行: [名称, 買付日, 数量, 取得単価, 現在値, 前日比, 前日比%, 損益, 損益%, 評価額]
        if section and len(row) >= 10 and _num(row[9]) is not None:
            holdings.append({
                "section": section,
                "name": normalize_text(c0),
                "qty": _num(row[2]),
                "cost": _num(row[3]),
                "price": _num(row[4]),
                "pl": _num(row[7]),
                "pl_pct": _num(row[8]),
                "value": _num(row[9]),
            })
    meta = {
        "kind": "portfolio",
        "account": "sbisec",
        "date": snap_date,
        "note": date_note,
        "holdings": holdings,
        "total_value": grand_total,
        "total_pl": grand_pl,
        "source": src,
    }
    return [], meta


def parse_sbi_value_history(path: Path) -> tuple[list[Txn], dict]:
    """SBI証券「My資産」の資産推移CSV(UTF-8 BOM可)。評価額の点列。

    形式: ヘッダなし「YYYY/M/D,評価額」の2列のみ。ポートフォリオCSV
    (sbi_portfolio)の保存を始める前の過去の評価額推移を埋めるための
    ソース(取引は無い)。各点をスナップショット形(total_value のみ、
    銘柄・損益なし)で返し、build が snapshots に合流させることで
    残高アンカーと invest.value_history(評価額推移チャート)の両方に反映される。
    損益(total_pl)は無いので pl_history(含み益ストライプ)には現れない。

    注意: 数字は「投資商品のみ」の評価額であること(ポートフォリオCSVと
    同じ定義)。My資産画面の総資産グラフは預り金・スイープ(ハイブリッド
    預金)の投資余力を含み、ここに置くと二重計上になるので使わない。
    """
    src = str(path.relative_to(ROOT))
    points: list[dict] = []
    for row in csv.reader(io.StringIO(read_text(path))):
        if not row or not row[0].strip():
            continue
        m = re.match(r"^(\d{4})/(\d{1,2})/(\d{1,2})$", row[0].strip())
        val = parse_amount(row[1]) if len(row) > 1 else None
        if not m or val is None:
            raise ValueError(f"資産推移CSVの行を解釈できない: {row!r}")
        points.append({
            "account": "sbisec",
            "date": f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}",
            "total_value": val,
            "note": "評価額(資産推移CSV)",
            # 最新スナップショットが万一この点になっても保有銘柄表が
            # おかしくならないよう空を明示する(通常はポートフォリオCSVの方が新しい)
            "holdings": [],
            "source": src,
        })
    return [], {"kind": "portfolio_series", "source": src, "points": points}


def parse_sbi_trades(path: Path) -> tuple[list[Txn], dict]:
    """SBI証券の約定履歴照会CSV(CP932)。株式・投信の約定。

    受渡金の動きは円貨入出金明細(スイープ)側で捕捉されるため、
    家計フローには計上せず投資イベントとして返す。
    DL時の既定ファイル名 OrderReferYYYYMMDDhhmmss.csv の日付がDL日
    (取込日として申告)。
    """
    src = str(path.relative_to(ROOT))
    rows = list(csv.reader(io.StringIO(read_text(path))))
    header_idx = _header_index(rows, "約定日", src)
    events: list[dict] = []
    for row in rows[header_idx + 1:]:
        if len(row) < 14 or not re.match(r"^\d{4}/\d{2}/\d{2}$", row[0].strip()):
            continue
        action = row[4].strip()
        amount = _num(row[13])
        settle = row[12].strip()
        events.append({
            "kind": "trade",
            "date": row[0].replace("/", "-"),
            # 受渡日。約定日〜受渡日の買付は評価額(約定日ベース)とスイープ
            # 預金(受渡日ベース)に二重に載るので、build が「未受渡」に合成して相殺する
            **({"settle": settle.replace("/", "-")}
               if re.match(r"^\d{4}/\d{2}/\d{2}$", settle) else {}),
            "name": normalize_text(row[1]),
            "code": row[2].strip(),
            "action": action,
            "deposit": normalize_text(row[6]),
            "qty": _num(row[8]),
            "price": _num(row[9]),
            "fee": _num(row[10]) or 0,
            "amount": (-(amount or 0)) if "売" in action else (amount or 0),
            "source": src,
        })
    meta = {"kind": "invest", "events": events}
    meta.update(_fetched_from_name("sbisec",
                                   r"OrderRefer(\d{4})(\d{2})(\d{2})", path))
    return [], meta


def parse_sbi_metal(path: Path) -> tuple[list[Txn], dict]:
    """SBI証券の金・銀・プラチナ注文照会CSV(UTF-8 BOM)。約定分のみ拾う。

    購入資金は円貨入出金明細の「金・銀・プラチナ取引口座へ振替出金」で
    捕捉されるため、家計フローには計上せず投資イベントとして返す。
    """
    src = str(path.relative_to(ROOT))
    reader = csv.DictReader(io.StringIO(read_text(path)))
    events: list[dict] = []
    for row in reader:
        status = (row.get("注文状況") or "").strip()
        if "約定" not in status or status == "未約定":
            continue
        action = (row.get("取引種別") or "").strip()
        amount = _num((row.get("約定金額") or "").replace("円", ""))
        qty_s = (row.get("約定数量") or "").replace("g", "")
        price_s = (row.get("約定価格/g") or "").replace("円", "")
        events.append({
            "kind": "metal",
            "date": (row.get("約定日時") or "")[:10].replace("/", "-"),
            "name": normalize_text(row.get("商品") or ""),
            "code": "",
            "action": action,
            "deposit": "特定",
            "qty": _num(qty_s),
            "price": _num(price_s),
            "fee": _num((row.get("手数料 (税込)") or "").replace("円", "")) or 0,
            "amount": (-(amount or 0)) if "売" in action else (amount or 0),
            "native_id": (row.get("受付番号") or "").strip(),
            "source": src,
        })
    events.reverse()  # 新しい順→古い順
    return [], {"kind": "invest", "events": events}


def _pdf_unescape(b: bytes) -> bytes:
    """PDF文字列リテラルのエスケープ(\\( \\) \\\\ \\n 8進等)を解決する。"""
    esc = {b"n": b"\n", b"r": b"\r", b"t": b"\t", b"b": b"\b", b"f": b"\f"}
    out = bytearray()
    i = 0
    while i < len(b):
        c = b[i:i + 1]
        if c != b"\\":
            out += c
            i += 1
            continue
        n = b[i + 1:i + 2]
        if n in esc:
            out += esc[n]
            i += 2
        elif n.isdigit():
            j = i + 1
            while j < len(b) and j - i <= 3 and b[j:j + 1].isdigit():
                j += 1
            out.append(int(b[i + 1:j], 8) & 0xFF)
            i = j
        else:
            out += n  # \( \) \\ など: 次の1バイトをそのまま
            i += 2
    return bytes(out)


def _pdf_text_pages(data: bytes) -> list[list[tuple[float, float, str]]]:
    """PDFのFlateストリームから (x, y, 文字列) をページごとに抜く。

    帳票系PDF向けの最小実装。テキスト配置が `1 0 0 1 x y Tm` の絶対指定で、
    文字列は2通り(SBI帳票の世代差):
    - リテラル `(...)Tj`: UTF-16BE(CIDのUniJIS-UCS2系。月次報告書)
    - 16進 `<...>Tj`: Shift-JIS(90ms-RKSJ系。年次報告書)
    前提から外れるストリームは警告を出さずに読み飛ばす(=空)。
    """
    pages: list[list[tuple[float, float, str]]] = []
    for raw in re.findall(rb"stream\r?\n(.*?)endstream", data, re.S):
        try:
            content = zlib.decompress(raw.strip(b"\r\n"))
        except zlib.error:
            continue
        items: list[tuple[float, float, str]] = []
        for m in re.finditer(
                rb"1 0 0 1 ([\d.-]+) ([\d.-]+) Tm[^()<>]*?"
                rb"(?:\(((?:\\.|[^\\()])*)\)|<([0-9A-Fa-f\s]+)>)\s*Tj",
                content, re.S):
            try:
                if m.group(3) is not None:
                    text = _pdf_unescape(m.group(3)).decode("utf-16-be")
                else:
                    text = bytes.fromhex(
                        m.group(4).decode()).decode("cp932")
            except (UnicodeDecodeError, ValueError):
                continue
            text = text.strip()
            if text:
                items.append((float(m.group(1)), float(m.group(2)), text))
        if items:
            pages.append(items)
    return pages


def _metal_balance_entry(items: list[tuple[float, float, str]]) -> dict:
    """報告書の「お預かり残高等の明細」ページ → sbi_metal 残高アンカー1件。"""
    # 記載対象日: セル単独の日付(本文中の「YYYY年MM月DD日現在」と
    # 区別するため fullmatch)
    date = None
    for _, _, t in items:
        m = re.fullmatch(r"(\d{4})年(\d{2})月(\d{2})日", t)
        if m:
            date = f"{m.group(1)}-{m.group(2)}-{m.group(3)}"
            break
    if not date:
        raise ValueError("記載対象日が見つからない")
    # 行の復元: 年次帳票は同一行内でもyが±1pt程度ずれるため、
    # y降順に走査して近い(3pt以内)ものを同じ行に束ねる
    rows: list[tuple[float, list[tuple[float, str]]]] = []
    for x, y, t in sorted(items, key=lambda it: (-it[1], it[0])):
        if rows and abs(rows[-1][0] - y) <= 3:
            rows[-1][1].append((x, t))
        else:
            rows.append((y, [(x, t)]))
    total = 0
    found = False
    for _, cells in rows:
        cells.sort()
        label = cells[0][1]
        if label not in ("金", "銀", "プラチナ", "現金") or len(cells) < 2:
            continue
        found = True
        if cells[-1][1] in ("-", "--"):
            continue  # 未保有の種別
        v = _num(cells[-1][1])
        if v is None:
            raise ValueError(f"{label}の評価額が読み取れない")
        total += round(v)
    if not found:
        raise ValueError("残高明細の種別行が見つからない")
    # note は残高アンカーの根拠としてUIに出る。種別内訳はPDF自体に
    # 残っているのでここでは書かない(長いと口座一覧で見切れる)
    kind = ("年次報告書" if any(t == "年次報告書" for _, _, t in items)
            else "月次報告書")
    return {"date": date, "account": "sbi_metal", "balance": total,
            "note": kind + "評価額"}


# 取引明細の列見出し → 論理列。内手数料と内消費税は同じx(2段見出し)なので
# ひとつの fee 列に束ねて合算する(=OrderReferの「手数料 (税込)」相当)
_METAL_TRADE_COLS = {
    "受付番号": "id", "取引商品": "name", "取引": "deal", "取引種類": "method",
    "積立方法": "tsumitate", "取引区分": "kubun", "約定時間": "dt",
    "約定価格/g": "price", "約定数量(g)": "qty", "受渡金額(円)": "amount",
    "受渡日": "duedate", "内　手数料(円)": "fee", "内　消費税(円)": "fee",
}


def _metal_trade_events(items: list[tuple[float, float, str]],
                        src: str) -> tuple[list[dict], list[str]]:
    """報告書の「約定の明細」ページ → 投資イベント。

    1約定が3行(上=約定日・手数料 / 中=主要セル / 下=約定時刻・消費税)に
    渡るため、受付番号セルを錨に上下11pt(行ピッチ23ptの半分)以内を
    1レコードに束ね、各セルは最も近い列見出しのxに割り当てる。
    """
    heads: dict[str, tuple[float, float]] = {}
    for x, y, t in items:
        if t in _METAL_TRADE_COLS and t not in heads:
            heads[t] = (x, y)
    cols = {_METAL_TRADE_COLS[t]: x for t, (x, _) in heads.items()}
    anchors = []
    if "受付番号" in heads:
        head_y = heads["受付番号"][1]
        anchors = [(x, y, t) for x, y, t in items
                   if y < head_y - 2 and re.fullmatch(r"\d{6,}", t)
                   and abs(x - cols["id"]) < 30]
    if not anchors:
        return [], []   # 約定のない月(見出しだけ or 表なし)
    need = {"id", "name", "kubun", "dt", "price", "qty", "amount"}
    if not need <= set(cols):
        return [], [f"取引明細の見出しが読み取れない(列: {sorted(cols)})"]
    events: list[dict] = []
    warns: list[str] = []
    for _, y0, rid in sorted(anchors, key=lambda a: -a[1]):
        rec: dict[str, list[str]] = defaultdict(list)
        for x, y, t in sorted(items, key=lambda it: (-it[1], it[0])):
            # 行外のセルと、錨にした受付番号セル自身(同じ数字列が他の列に
            # 出た場合は残す)を除く
            if abs(y - y0) > 11 or (t == rid and abs(x - cols["id"]) < 30):
                continue
            key = min(cols, key=lambda k: abs(cols[k] - x))
            rec[key].append(t)
        date = next((t for t in rec.get("dt", ())
                     if re.fullmatch(r"\d{4}/\d{2}/\d{2}", t)), None)
        qty = _num((rec.get("qty") or [""])[0])
        price = _num((rec.get("price") or [""])[0])
        gross = _num((rec.get("amount") or [""])[0])
        kubun = (rec.get("kubun") or [""])[0]
        name = (rec.get("name") or [""])[0]
        if None in (qty, price, gross) or not (date and kubun and name):
            warns.append(f"約定 {rid} の行が読み取れない(スキップ)")
            continue
        fee = round(sum(_num(t) or 0 for t in rec.get("fee", ())))
        gross = round(gross)
        deal = (rec.get("deal") or [""])[0]
        # 受渡金額は手数料・消費税込み。OrderReferの約定金額(手数料抜き)に
        # 合わせて分離する。売却は入金なので符号を反転(実物未確認のため
        # 受渡金額=約定金額−手数料と仮定)
        amount = -(gross + fee) if "売" in kubun else gross - fee
        events.append({
            "kind": "metal", "date": date.replace("/", "-"),
            "name": normalize_text(name), "code": "",
            "action": kubun + (f" ({deal})" if deal else ""),
            "deposit": "特定", "qty": qty, "price": price, "fee": fee,
            "amount": amount, "native_id": rid, "source": src,
        })
    return events, warns


def parse_sbi_metal_report(path: Path) -> tuple[list[Txn], dict]:
    """SBI証券 金・銀・プラチナ取引の月次・年次報告書PDF(電子交付)。

    文字列はFlateストリーム内にUTF-16BE(月次)またはShift-JIS(年次)で
    入っており標準ライブラリだけで復号できる(_pdf_text_pages)。
    - 「お預かり残高等の明細」ページ: 種別行(金・銀・プラチナ・現金)の
      右端セル=評価額を合計し、記載対象日(月末/年末最終営業日)の
      sbi_metal 残高アンカーにする。未保有の種別は「--」(0扱い)。
    - 「約定の明細」ページ(月次のみ): 取引明細を投資イベントとして返す。
      native_id=受付番号はOrderRefer(注文照会CSV)と同一なので、両方
      取り込まれてもbuild側の重複排除で1本化される。年次報告書の
      「お取引の総計」は年間集計で個別約定がないため読まない。
    """
    src = str(path.relative_to(ROOT))
    entry = None
    events: list[dict] = []
    warns: list[str] = []
    for items in _pdf_text_pages(path.read_bytes()):
        texts = {t for _, _, t in items}
        if entry is None and "お預かり残高等の明細" in texts:
            entry = _metal_balance_entry(items)
        elif "約定の明細" in texts:
            evs, ws = _metal_trade_events(items, src)
            events.extend(evs)
            warns.extend(ws)
    if entry is None:
        raise ValueError("お預かり残高等の明細ページが見つからない")
    meta = {"kind": "balances", "source": src, "entries": [entry],
            "events": events}
    if warns:
        meta["warnings"] = warns
    return [], meta


def parse_manual_balances(path: Path) -> tuple[list[Txn], dict]:
    """手入力残高CSV(UTF-8)。取引ではなく残高スナップショット。

    形式: 日付,口座,残高[,メモ] のヘッダ+データ行。
    明細を取れない口座(現金・企業型DC等)や取込前の銀行の残高アンカーを
    人手で与える。負債口座(カード)は未払額を負の値で記入する。
    日付は YYYY-MM-DD または YYYY/MM/DD。口座は accounts.toml のID。
    """
    src = str(path.relative_to(ROOT))
    rows = list(csv.reader(io.StringIO(read_text(path))))
    entries: list[dict] = []
    for row in rows[1:]:
        if not row or not row[0].strip():
            continue
        d, acct, bal_s = (row + [""] * 3)[:3]
        d = d.strip().replace("/", "-")
        if not re.match(r"^\d{4}-\d{2}-\d{2}$", d):
            raise ValueError(f"日付を解釈できない: {d!r}")
        balance = parse_amount(bal_s)
        if balance is None:
            continue
        memo = row[3].strip() if len(row) > 3 else ""
        entries.append({
            "date": d,
            "account": acct.strip(),
            "balance": balance,
            "memo": memo,
            # メモは残高アンカーの根拠として UI に出す(既定は「手入力」)
            **({"note": memo} if memo else {}),
        })
    entries.sort(key=lambda e: (e["date"], e["account"]))
    return [], {"kind": "balances", "entries": entries, "source": src}


# ---- デモソース ----
# 実在しない架空フォーマット。給与明細やDCポータルのような「勤務先系」
# ソースをこのシステムでどう扱うかの実装例で、デモデータ生成
# (demo/build_demo.py)にも使う。実在サービスのパーサを書くときの
# 雛形として、清算口座(kyuyo)型と残高アンカー(balances)型の両方を示す。

def parse_demo_kyuyo(path: Path) -> tuple[list[Txn], dict]:
    """架空の給与明細CSV(UTF-8)。形式:

      デモ給与明細,YYYY/MM,給与|賞与
      支給,<名称>,<金額>
      控除,<名称>,<金額>
      勤務,<名称>,<数値>          … 金銭でない勤怠項目(明細にしない)
      検算,銀行振込額,<金額>       … 支給計−控除計 と照合

    支給・控除を清算口座 kyuyo の収入・支出として月初日で計上する
    (取引日はCSVに支給月しかない)。手取りの入金は銀行側明細が振替として
    担う想定なので取り込まない。検算行と合わなければ ValueError
    (=スキップ扱いで報告)。実際の振込は月内の支給日なので、月初計上の
    取引日で鮮度を測ると古く見える。「支給月まるごと取込済み」を cover と
    して申告し、鮮度モニタはそちらで測る(カード請求の扱いと同型)。

    勤務行は meta["work"] に転記する({month, kind, stmt, items})。勤怠実績は
    締め翌月精算とみなして前月に、「付与」を含む項目(有給付与日数等)は支給月に
    帰属させ、賞与は支給月のまま。stmt=支給月は再取込の冪等キー。
    """
    src = str(path.relative_to(ROOT))
    rows = list(csv.reader(io.StringIO(read_text(path))))
    if not rows or rows[0][0] != "デモ給与明細" or len(rows[0]) < 3:
        raise ValueError(f"{src}: ヘッダ行がデモ給与明細形式でない")
    m = re.match(r"^(\d{4})/(\d{2})$", rows[0][1].strip())
    if not m:
        raise ValueError(f"{src}: 支給月(YYYY/MM)を解釈できない")
    month = f"{m.group(1)}-{m.group(2)}"
    is_shoyo = rows[0][2].strip() == "賞与"

    txns: list[Txn] = []
    work_items: list[dict] = []
    bank_transfer = None
    for row in rows[1:]:
        if len(row) < 3 or not row[0].strip():
            continue
        kind, name, val = row[0].strip(), row[1].strip(), row[2].strip()
        if kind == "勤務":
            try:
                work_items.append({"name": normalize_text(name),
                                   "value": float(val.replace(",", ""))})
            except ValueError:
                continue
            continue
        if kind == "検算":
            bank_transfer = parse_amount(val)
            continue
        if kind not in ("支給", "控除"):
            continue
        amount = parse_amount(val)
        if amount is None:
            continue
        sign = 1 if kind == "支給" else -1
        txns.append(Txn(
            account="kyuyo",
            date=f"{month}-01",
            amount=sign * amount,
            description=normalize_text(name),
            raw_description=name,
            source=src,
            memo=("賞与" if is_shoyo else "給与") + f"明細 {month}",
            type="income" if sign > 0 else "expense",
        ))
    total = sum(t.amount for t in txns)
    if bank_transfer is not None and total != bank_transfer:
        raise ValueError(f"{src}: 支給−控除の合計 {total:,} が"
                         f"銀行振込額 {bank_transfer:,} と合わない")
    last_day = calendar.monthrange(int(month[:4]), int(month[5:7]))[1]
    meta: dict = {"cover": {"account": "kyuyo", "label": f"{month}支給",
                            "until": f"{month}-{last_day:02d}"}}
    if work_items:
        if is_shoyo:
            meta["work"] = [{"month": month, "kind": "賞与",
                             "stmt": month, "items": work_items}]
        else:
            y, mm = int(month[:4]), int(month[5:7])
            prev = f"{y - 1}-12" if mm == 1 else f"{y}-{mm - 1:02d}"
            by_month: dict[str, list[dict]] = {}
            for it in work_items:
                by_month.setdefault(
                    month if "付与" in it["name"] else prev, []).append(it)
            meta["work"] = [{"month": mo, "kind": "給与", "stmt": month,
                             "items": its} for mo, its in by_month.items()]
    return txns, meta


def parse_demo_dc_html(path: Path) -> tuple[list[Txn], dict]:
    """架空の企業型DCポータル(デモDCポータル)の保存HTML。
    取引ではなく残高スナップショット。

    照会日時と資産評価額合計を拾って dc 口座の残高アンカーにする。
    拠出金累計が取れれば contrib_total としてアンカーに付け、UIが
    評価額−拠出累計=評価損益 を逆算する。金額が見つからないページは
    ValueError(=スキップ扱いで報告)。
    """
    src = str(path.relative_to(ROOT))
    text = read_text(path)
    m = re.search(r"照会日時[::]\s*(\d{4})年(\d{1,2})月(\d{1,2})日", text)
    if not m:
        raise ValueError("照会日時が見つからない")
    date = f"{m.group(1)}-{int(m.group(2)):02d}-{int(m.group(3)):02d}"
    m = re.search(r"資産評価額合計.{0,200}?([\d,]+)円", text, re.S)
    if not m:
        raise ValueError("資産評価額合計が見つからない")
    balance = int(m.group(1).replace(",", ""))
    # note は残高アンカーの根拠として UI に出る(既定の「手入力」を上書き)
    entry = {"date": date, "account": "dc", "balance": balance,
             "note": "DCポータル評価額"}
    m = re.search(r"拠出金累計.{0,200}?([\d,]+)円", text, re.S)
    if m:
        contrib = int(m.group(1).replace(",", ""))
        entry["contrib_total"] = contrib
        entry["note"] += f"・拠出累計 {contrib:,}円"
    return [], {"kind": "balances", "source": src, "entries": [entry]}


PARSERS = {
    "saison": parse_saison,
    "yucho_csv": parse_yucho_csv,
    "yucho_html": parse_yucho_html,
    "suica_html": parse_suica_html,
    "yucho_paper": parse_yucho_paper,
    "smbc_csv": parse_smbc_csv,
    "view_csv": parse_view_csv,
    "starbucks_html": parse_starbucks_html,
    "paidy_html": parse_paidy_html,
    "neobank_csv": parse_neobank_csv,
    "shinsei_csv": parse_shinsei_csv,
    "paypal_csv": parse_paypal_csv,
    "paypay": parse_paypay,
    "sbisec_cash": parse_sbisec_cash,
    "sbi_portfolio": parse_sbi_portfolio,
    "sbi_trades": parse_sbi_trades,
    "sbi_value_history": parse_sbi_value_history,
    "sbi_metal": parse_sbi_metal,
    "sbi_metal_report": parse_sbi_metal_report,
    "manual_balances": parse_manual_balances,
    "demo_kyuyo": parse_demo_kyuyo,
    "demo_dc_html": parse_demo_dc_html,
}

# ---- ローカル拡張の読み込み ----
# parsers_extra.py(あれば)が register() で PARSERS・sniff・FORMAT_DIR を拡張する。
# PARSERS 定義後でないと register() で登録できないため、必ずこの位置で import する。
try:
    import parsers_extra  # noqa: F401  (import時に登録が走る)
except ModuleNotFoundError as e:
    if e.name != "parsers_extra":
        raise
