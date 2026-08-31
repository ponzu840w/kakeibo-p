"""共有の基本部品: 正規化・読み込み・Txnデータ型・パス定数。"""
from __future__ import annotations

import os
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent
# KAKEIBO_* 環境変数でデータ一式・出力先を差し替えられる(デモビルド
# demo/build_demo.py が使う。通常運用では未設定のままでよい)
DATA_DIR = Path(os.environ.get("KAKEIBO_DATA")
                or ROOT / "data")  # 個人データ置き場(git外。OneDrive等へのリンク可)
RAW_DIR = DATA_DIR / "raw"
LEDGER_DIR = Path(os.environ.get("KAKEIBO_LEDGER")
                  or ROOT / "ledger")  # 派生物(git外・ローカル)
SITE_DIR = ROOT / "site"
DATA_JS = Path(os.environ.get("KAKEIBO_DATA_JS")
               or SITE_DIR / "data.js")  # 集計データの出力先(派生物)


def normalize_text(s: str) -> str:
    """摘要の正規化。表記ゆれ(全角英数/半角カナ/分離濁点)を吸収する。

    - U+309B/309C(分離濁点・半濁点)を結合文字に置換してから NFKC。
      これで「セソ゛ン」「ｾｿﾞﾝ」がともに「セゾン」になる。
    - 全角英数・記号は半角化(ＲＴ→RT、ＤＦ．→DF.)。
    - カンマ・読点・中点・空白の連続は単一スペースに畳む。
    """
    s = s.replace("゛", "゙").replace("゜", "゚")
    s = unicodedata.normalize("NFKC", s)
    s = re.sub(r"[\s,、･・]+", " ", s)
    return s.strip()


def parse_amount(s: str) -> int | None:
    """'12,345' '12345円' '-500' → int。引数が None・空・'-' なら None。"""
    s = normalize_text(s or "").replace("円", "").replace(" ", "")
    if s in ("", "-"):
        return None
    return int(s)


def wareki_to_iso(s: str) -> str:
    """令和の 'Y-MM-DD' (例 '8-07-14') → '2026-07-14'。

    ゆうちょダイレクトの通帳未記入分画面は元号名なしの令和年で出す。
    令和以外(平成31年以前のデータ)が出てきたら要修正なので範囲チェックする。
    """
    m = re.match(r"^(\d{1,2})-(\d{2})-(\d{2})$", s.strip())
    if not m:
        raise ValueError(f"和暦日付を解釈できない: {s!r}")
    reiwa, month, day = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if not (1 <= reiwa <= 50):
        raise ValueError(f"令和年が範囲外: {s!r}")
    return f"{reiwa + 2018:04d}-{month:02d}-{day:02d}"


def read_text(path: Path) -> str:
    """CP932 / UTF-8(BOM付含む) 混在前提の読み込み。"""
    data = path.read_bytes()
    if data.startswith(b"\xef\xbb\xbf"):
        return data.decode("utf-8-sig")
    try:
        return data.decode("utf-8")
    except UnicodeDecodeError:
        return data.decode("cp932")


@dataclass
class Txn:
    account: str
    date: str                 # ISO YYYY-MM-DD
    amount: int               # 口座残高への符号付き変化(円)。入金 +/出金 -
    description: str          # 正規化済み摘要
    raw_description: str      # 原文摘要
    source: str               # raw/ からの相対パス
    native_id: str = ""       # ソース固有の一意ID(あれば)
    balance: int | None = None  # ソースに残高列があればその値
    memo: str = ""            # パーサ由来の補足(給与の賞与判定などに使用)
    comment: str = ""         # 手動コメント(overrides.toml 由来)
    type: str = ""            # income | expense | transfer | adjustment
    category: str = ""
    counter: str = ""         # 振替の相手口座id
    pair: str = ""            # 相手側明細とマッチングできた振替のペアid
    rule: str = ""            # 分類根拠(適用ルールの説明。UIで表示する)
    recurring: str = ""       # 一致した [[recurring]] 宣言(サブスク)の name
    id: str = ""              # 重複排除キーのハッシュ


