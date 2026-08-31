#!/usr/bin/env python3
"""家計簿UIのローカル配信+上書き保存サーバ。

    python3 serve.py [--port 8765]
    python3 serve.py --demo     # 架空データ(demo/)で動かす。data/ は触らない

明細タブの上書き編集(カテゴリ・コメント)はこのサーバで開いたときのみ
有効で、行の「保存」が overrides.toml への書込→build→再読込まで行う。
file:// で site/index.html を開くと閲覧専用(編集フォームは無効)。

- GET  /              site/ の静的配信(キャッシュ無効)
- GET  /api/ping      サーバ検知用(UIが編集フォームの有効化を判断)
- GET  /api/uistate   data/uistate.toml の現在値をJSONで返す
- POST /api/overrides ボディ(TOML)を data/overrides.toml に書き、
                      build.py を実行して出力テキストを返す
- POST /api/uistate   ボディ(TOML)を data/uistate.toml に書く
                      (鮮度モニタのack/mute。集計に影響しないので再ビルドなし)
- POST /api/inbox?name=<ファイル名>
                      ボディ(生バイト)を data/inbox/ に保存する。
                      振り分けは次の build(organize_inbox)が行う
- POST /api/rebuild   build.py を実行して出力テキストを返す

UIから書けるのは UI所有ファイル2つ(overrides/uistate)と data/inbox/ への
新規保存だけに限定する。raw/ へは書けない——inbox から raw/ へ移すのは
build の organize_inbox(決定論的・移動改名のみ)であり、rules.toml も
このサーバ経由では触れない。既定では 127.0.0.1 のみで待ち受け、
Origin付きのクロスオリジンPOSTは拒否する。
TOMLは丸ごと差し替えなので、書き換え前の版を <name>.bak に残す。

公開運用(手順の詳細は README「公開運用」):
- 非ローカルのアクセスは Basic認証(--auth USER:PASS か環境変数
  KAKEIBO_AUTH)が必須。認証が未設定なら 403 で拒否する(fail-closed)。
  「非ローカル」はクライアント単位で判定する: 接続元がループバックでない、
  またはプロキシ経由を示すヘッダ(X-Forwarded-For 等)が付いている
  リクエスト。同一マシンからの直接アクセスは認証なしで従来どおり使える。
- 全データが見えるサーバなので、認証なしの非ループバック待受は
  そもそも起動を拒否する。
- TLSは持たない。インターネットに出すときは必ずHTTPS終端する
  リバースプロキシ(Caddy/nginx)か Tailscale 等のトンネルを前置し、
  serve.py 自体は 127.0.0.1 のままにするのが推奨構成
  (平文HTTPでの公開はパスワードも明細も漏れる)。
- クロスオリジン判定は Host ヘッダとの突合なので、プロキシ配下の
  独自ドメインでも編集機能はそのまま動く(プロキシは Host を
  素通しすること。Caddy は既定でそうなる。nginx は
  `proxy_set_header Host $host;`)。
"""
from __future__ import annotations

import argparse
import base64
import hmac
import json
import os
import subprocess
import sys
import threading
import tomllib
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

# model のパス定数は import 時に確定するので、argparse より前に環境変数を立てる
DEMO = "--demo" in sys.argv
if DEMO:
    _root = Path(__file__).resolve().parent
    os.environ.setdefault("KAKEIBO_DATA", str(_root / "demo" / "data"))
    os.environ.setdefault("KAKEIBO_LEDGER", str(_root / "demo" / "ledger"))
    os.environ.setdefault("KAKEIBO_DATA_JS", str(_root / "site" / "data.demo.js"))

from model import DATA_DIR, ROOT, SITE_DIR  # noqa: E402


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(SITE_DIR), **kwargs)

    def end_headers(self):
        # data.js は再ビルドで変わるのでキャッシュさせない
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send_bytes(self, code: int, ctype: str, data: bytes,
                    extra_headers: tuple = ()) -> None:
        self.send_response(code)
        for k, v in extra_headers:
            self.send_header(k, v)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send(self, code: int, text: str) -> None:
        self._send_bytes(code, "text/plain; charset=utf-8",
                         text.encode("utf-8"))

    def _is_local_client(self) -> bool:
        """同一マシンからの直接アクセスかどうか。

        リバースプロキシやトンネル(Caddy/nginx/tailscale serve)経由の
        リクエストは接続元こそ 127.0.0.1 だが、プロキシが付ける転送ヘッダで
        見分けて非ローカル扱いにする(公開経路に認証を必ず通すため)。
        ローカルの直接アクセスが転送ヘッダを自称しても認証を求められる
        だけなので、偽装は安全側にしか倒れない。
        """
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            return False
        return not any(self.headers.get(h) for h in
                       ("X-Forwarded-For", "X-Real-IP", "Forwarded"))

    def _check_auth(self) -> bool:
        """非ローカルのアクセスにBasic認証を課す。

        ローカル(同一マシンの直接アクセス)は素通し。非ローカルは認証必須で、
        認証が未設定なら拒否(fail-closed)。不合格なら応答済みで False。
        """
        if self._is_local_client():
            return True
        auth = getattr(self.server, "auth", None)
        if not auth:
            self._send(403, "Basic認証が未設定のため、非ローカルからの"
                            "アクセスは受け付けません(KAKEIBO_AUTH を設定)")
            return False
        expect = "Basic " + base64.b64encode(auth.encode("utf-8")).decode()
        got = self.headers.get("Authorization", "")
        if hmac.compare_digest(got.encode("utf-8"), expect.encode("utf-8")):
            return True
        self._send_bytes(
            401, "text/plain; charset=utf-8", "認証が必要です".encode("utf-8"),
            (("WWW-Authenticate", 'Basic realm="kakeibo-p", charset="UTF-8"'),))
        return False

    def do_HEAD(self):
        if not self._check_auth():
            return
        super().do_HEAD()

    def do_GET(self):
        if not self._check_auth():
            return
        if self.path == "/api/ping":
            self._send(200, "ok")
            return
        if self.path == "/api/uistate":
            path = DATA_DIR / "uistate.toml"
            try:
                d = tomllib.loads(path.read_text("utf-8")) if path.exists() else {}
            except (OSError, tomllib.TOMLDecodeError):
                d = {}
            self._send_bytes(200, "application/json; charset=utf-8",
                             json.dumps(d, ensure_ascii=False).encode("utf-8"))
            return
        super().do_GET()

    def _same_origin(self) -> bool:
        """クロスオリジンPOSTを拒否する。不許可なら応答済みで False。"""
        # ブラウザ以外(curl)はOriginなし=許可。他サイトからの
        # クロスオリジンPOST(CORSなしでも届いてしまう)は拒否する。
        # Basic認証はブラウザが保存して自動送信するため、公開運用でも
        # この検査がCSRFの防壁になる。待受アドレスと比べる方式だと
        # 逆プロキシ+独自ドメイン配下で編集が全滅するので、ブラウザが
        # 実際に接続した先を表す Host ヘッダと突合する
        origin = self.headers.get("Origin")
        if origin and urlsplit(origin).netloc != self.headers.get("Host"):
            self._send(403, "同一オリジン以外からの書込は受け付けません")
            return False
        return True

    def _read_toml_body(self) -> bytes | None:
        """POSTボディをTOMLとして検証して返す。不正なら応答して None。"""
        if not self._same_origin():
            return None
        n = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(n)
        try:
            tomllib.loads(body.decode("utf-8"))   # 壊れたTOMLを書き込まない
        except (UnicodeDecodeError, tomllib.TOMLDecodeError) as e:
            self._send(400, f"TOMLが不正なため保存しません: {e}")
            return None
        return body

    @staticmethod
    def _write_atomic(path: Path, body: bytes, backup: bool = False) -> None:
        """一時ファイル経由で置き換える。

        backup=True なら直前版を <name>.bak に残す。UI所有のTOMLは1件の編集でも
        ファイルを丸ごと書き直すため、書き損じても直前の状態に戻せるようにする。
        """
        if backup and path.exists():
            path.with_name(path.name + ".bak").write_bytes(path.read_bytes())
        # 一時ファイル名は書込ごとに一意にする。拡張子置換(.tmp)だと
        # foo.csv と foo.html の同時投入で同じ foo.tmp を奪い合う
        tmp = path.with_name(
            f"{path.name}.part-{os.getpid()}-{threading.get_ident()}")
        tmp.write_bytes(body)
        tmp.replace(path)

    def _run_build(self, prefix: str = "") -> None:
        # デモは build_demo.py 経由。demo/data が未生成のクローンでも動く
        script = "demo/build_demo.py" if DEMO else "build.py"
        r = subprocess.run([sys.executable, script], cwd=ROOT,
                           capture_output=True, text=True)
        self._send(200 if r.returncode == 0 else 500,
                   f"{prefix}{r.stdout}{r.stderr}")

    def do_POST(self):
        if not self._check_auth():
            return
        parts = urlsplit(self.path)
        if parts.path == "/api/inbox":
            if not self._same_origin():
                return
            name = parse_qs(parts.query).get("name", [""])[0]
            # パス区切りや隠しファイルを拒否(data/inbox/ 直下の新規保存のみ)。
            # .tmp / .part- は _write_atomic の一時ファイル名を外部から
            # 名乗らせない(進行中の原子的書込との衝突防止)
            if (not name or name != Path(name).name or name.startswith(".")
                    or name.endswith(".tmp") or ".part-" in name):
                self._send(400, f"ファイル名が不正です: {name!r}")
                return
            n = int(self.headers.get("Content-Length", 0))
            if n <= 0 or n > 64 * 1024 * 1024:
                self._send(400, "ボディが空か大きすぎます(上限64MB)")
                return
            inbox = DATA_DIR / "inbox"
            inbox.mkdir(parents=True, exist_ok=True)
            self._write_atomic(inbox / name, self.rfile.read(n))
            self._send(200, f"inbox に保存しました: {name}")
            return
        if parts.path == "/api/rebuild":
            if not self._same_origin():
                return
            self._run_build()
            return
        if self.path == "/api/overrides":
            body = self._read_toml_body()
            if body is None:
                return
            self._write_atomic(DATA_DIR / "overrides.toml", body, backup=True)
            self._run_build("overrides.toml を保存しました\n\n")
            return
        if self.path == "/api/uistate":
            body = self._read_toml_body()
            if body is None:
                return
            # 集計に影響しないので再ビルドはしない(次のbuildでdata.jsにも入る)
            self._write_atomic(DATA_DIR / "uistate.toml", body, backup=True)
            self._send(200, "uistate.toml を保存しました")
            return
        self._send(404, "not found")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--host", default="127.0.0.1",
                    help="待受アドレス(既定 127.0.0.1。外部公開は 0.0.0.0。"
                         "その場合 --auth 必須)")
    ap.add_argument("--demo", action="store_true",
                    help="架空データ(demo/)を読み書きするデモモード。"
                         "実データ(data/)には触らない")
    ap.add_argument("--auth", metavar="USER:PASS",
                    help="Basic認証。環境変数 KAKEIBO_AUTH でも指定できる"
                         "(psに出ないぶん環境変数を推奨)")
    args = ap.parse_args(argv)
    if args.demo:
        if not DATA_DIR.is_dir():   # クローン直後は架空データがまだ無い
            if subprocess.run([sys.executable, "demo/build_demo.py"],
                              cwd=ROOT).returncode != 0:
                return 2
    elif not DATA_DIR.is_dir():
        print(f"{DATA_DIR} が読めない(無いか権限がない)。個人データを置くか、"
              "架空データを見るだけなら --demo を付ける", file=sys.stderr)
        return 2
    auth = args.auth or os.environ.get("KAKEIBO_AUTH")
    if auth and ":" not in auth:
        print("--auth / KAKEIBO_AUTH は USER:PASS 形式で指定してください",
              file=sys.stderr)
        return 2
    local_host = args.host in ("127.0.0.1", "localhost", "::1")
    if not local_host and not auth:
        print("全データが見えるサーバのため、127.0.0.1 以外で待ち受けるには "
              "Basic認証(--auth USER:PASS か環境変数 KAKEIBO_AUTH)が必須です。\n"
              "リバースプロキシやトンネル(Tailscale等)を前置する場合は "
              "--host を既定の 127.0.0.1 のままにしてください。", file=sys.stderr)
        return 2
    srv = ThreadingHTTPServer((args.host, args.port), Handler)
    srv.auth = auth
    if not local_host:
        print("警告: TLSは持ちません。インターネットに公開する場合は必ず "
              "HTTPS終端のリバースプロキシを前置してください"
              "(平文HTTPではパスワードも明細も漏れます)", file=sys.stderr)
    if args.demo:
        print(f"デモモード: {DATA_DIR} を読み書きする(data/ には触らない)")
    shown = "127.0.0.1" if args.host in ("0.0.0.0", "::") else args.host
    print(f"http://{shown}:{args.port} で配信中 (Ctrl+C で終了)")
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
