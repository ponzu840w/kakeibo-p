"""JS側ロジックのテスト(tests/js_harness.js をJSエンジンで実行して検証)。

UIの計算ロジック(定期検出・資金繰り予測・統計)は JS に移っており、
Python 側のテストだけでは触れない。mac/Linux(WSL)/Windows のどれでも
「そのOSに既にあるもの」で動くよう、実行エンジンは次の順で探して使う
(専用ランタイムの追加インストールを必須にしない):

1. jsc … JavaScriptCore のシェル。macOS はOS同梱、Linux/WSL は
   `apt install libjavascriptcoregtk-4.1-bin` 等が PATH に置く
2. node … 入っていれば使う(必須ではない)
3. headless ブラウザ … Windows 標準の Edge や Chrome。webUI を開くのに
   どのみち必要なので、実質すべての環境をカバーする

どれも見つからなければ理由付きでスキップする。環境変数 KAKEIBO_JSC /
KAKEIBO_BROWSER で任意のパスを明示指定できる。

ハーネスは3部構成(読み込み順を全エンジンで揃える):
  tests/js_fixture.js → site/js/(JS_FILES)→ tests/js_harness.js
ブラウザ経路だけ tests/js_harness.html が script タグで同じ順を再現する
(HTML側の並びを変えたら JS_FILES も揃えること)。

実行: python3 -m unittest discover tests(通常のテストと一緒に走る)
"""
import html
import json
import os
import re
import shutil
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
FRAMEWORK_JSC = ("/System/Library/Frameworks/JavaScriptCore.framework"
                 "/Versions/Current/Helpers/jsc")
# 評価順。tests/js_harness.html の script タグと揃える
JS_FILES = ["tests/js_fixture.js", "site/js/core.js", "site/js/stats.js",
            "site/js/schedule.js", "tests/js_harness.js"]

# node で jsc 相当の実行をする最小ラッパ。vm.runInThisContext は
# <script> と同じ Program 評価なので、ファイル先頭の "use strict" でも
# var(DATA 等)がグローバルに残る(素の eval だと残らない)
NODE_WRAPPER = (
    "const vm=require('vm'),fs=require('fs');"
    "globalThis.print=console.log;"
    "for(const f of process.argv.slice(1))"
    "vm.runInThisContext(fs.readFileSync(f,'utf8'),{filename:f});"
)

BROWSER_CANDIDATES = [
    # macOS
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    # Windows(Edge は標準搭載)
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
]
BROWSER_NAMES = ["google-chrome", "google-chrome-stable", "chromium",
                 "chromium-browser", "microsoft-edge", "msedge", "chrome"]


def find_jsc() -> str | None:
    cands = [os.environ.get("KAKEIBO_JSC"), FRAMEWORK_JSC]
    for name in ("jsc", "jsc-6.0", "jsc-4.1", "jsc-4.0"):
        cands.append(shutil.which(name))
    return next((c for c in cands if c and Path(c).exists()), None)


def find_browser() -> str | None:
    cands = [os.environ.get("KAKEIBO_BROWSER"), *BROWSER_CANDIDATES]
    for name in BROWSER_NAMES:
        cands.append(shutil.which(name))
    return next((c for c in cands if c and Path(c).exists()), None)


def run_harness() -> tuple[str, str]:
    """(エンジン名, 出力JSON文字列) を返す。エンジンが無ければ SkipTest。"""
    files = [str(ROOT / f) for f in JS_FILES]
    if jsc := find_jsc():
        r = subprocess.run([jsc, *files], capture_output=True, text=True,
                           cwd=ROOT, timeout=60)
        if r.returncode != 0:
            raise AssertionError(f"jsc 実行失敗:\n{r.stdout}\n{r.stderr}")
        return "jsc", r.stdout
    if node := shutil.which("node"):
        r = subprocess.run([node, "-e", NODE_WRAPPER, "--", *files],
                           capture_output=True, text=True, cwd=ROOT,
                           timeout=60)
        if r.returncode != 0:
            raise AssertionError(f"node 実行失敗:\n{r.stdout}\n{r.stderr}")
        return "node", r.stdout
    if browser := find_browser():
        page = (ROOT / "tests" / "js_harness.html").as_uri()
        r = subprocess.run(
            [browser, "--headless=new", "--disable-gpu",
             "--virtual-time-budget=3000", "--dump-dom", page],
            capture_output=True, text=True, cwd=ROOT, timeout=120)
        m = re.search(r"@@KAKEIBO_RESULT@@(.*?)@@END@@", r.stdout, re.S)
        if not m:
            err = re.search(r"@@KAKEIBO_ERROR@@(.*?)@@END@@", r.stdout, re.S)
            raise AssertionError(
                "ブラウザ実行失敗: "
                + (html.unescape(err.group(1)) if err else
                   f"結果マーカーが無い\n{r.stdout[:500]}\n{r.stderr[:500]}"))
        return "browser", html.unescape(m.group(1))
    raise unittest.SkipTest(
        "JSエンジンが見つからない(jsc / node / Chrome系ブラウザのいずれか。"
        "Linux/WSLは libjavascriptcoregtk-4.1-bin、または KAKEIBO_JSC / "
        "KAKEIBO_BROWSER で明示指定)")


class TestJsLogic(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.out = json.loads(run_harness()[1])

    def test_stats(self):
        s = self.out["stats"]
        self.assertEqual(s["median_even"], 2.5)   # 偶数個は平均(KB.median)
        self.assertEqual(s["median_odd"], 5)
        self.assertEqual(s["mad"], 0)             # [1,1,1,9] の偏差中央値
        self.assertEqual(s["quantile_half"], 5)
        self.assertAlmostEqual(s["xirr"], 0.1, places=4)
        self.assertEqual(s["modeOf"], "b")

    def test_detect_recurring(self):
        self.assertEqual(self.out["curMonth"], "2026-08")
        det = self.out["detectRecurring"]
        # サブスク(3ヶ月×月1回×金額一定)だけが定期として検出される
        names = [d["name"] for d in det]
        self.assertIn("NETFLIX.COM", names)
        sub = next(d for d in det if d["name"] == "NETFLIX.COM")
        self.assertEqual(sub["median"], 500)
        self.assertEqual(sub["months"], 3)
        self.assertEqual(sub["day"], 10)
        self.assertEqual(sub["account"], "bank")
        # メモ化(同一入力で同一参照が返る)を固定する
        self.assertTrue(self.out["detectMemoized"])

    def test_declared_subs(self):
        # 月額降順: 仕送り(fixed) > 厚生年金(fixed) > 動画配信(sub)
        subs = self.out["declaredSubs"]
        self.assertEqual([s["name"] for s in subs],
                         ["実家仕送り", "厚生年金保険料", "動画配信"])
        self.assertEqual([s["kind"] for s in subs], ["fixed", "fixed", "sub"])
        self.assertEqual([s["monthly"] for s in subs], [40000, 20000, 500])
        s = subs[2]
        self.assertEqual(s["name"], "動画配信")
        self.assertEqual(s["day"], 10)
        self.assertTrue(s["active"])
        self.assertEqual(s["account"], "bank")
        self.assertEqual(subs[1]["account"], "kyuyo")   # 控除は清算口座上

    def test_estimate_salary(self):
        sal = self.out["estimateSalary"]
        self.assertEqual(sal["amount"], 300000)
        self.assertEqual(sal["day"], 25)
        self.assertEqual(sal["account"], "bank")
        self.assertEqual(sal["count"], 3)

    def test_recurring_transfers(self):
        # 証券積立(毎月14日・月1回・日が安定)だけが定期振替として検出され、
        # 日がバラバラのチャージ(残高駆動)は検出されない
        rts = self.out["recurringTransfers"]
        self.assertEqual(len(rts), 1)
        rt = rts[0]
        self.assertEqual(rt["name"], "自払 ツミタテ")
        self.assertEqual(rt["counter"], "sec")
        self.assertEqual(rt["account"], "bank")
        self.assertEqual(rt["day"], 14)
        self.assertEqual(rt["months"], 4)
        # 金額は直近3出現月の中央値(3万→6万の増額に追従して6万)
        self.assertEqual(rt["amount"], 60000)
        self.assertTrue(rt["active"])

    def test_baseline_outflow(self):
        # 直近3完了月(2026-05〜07)の「その他流出」= 食費1万+チャージ1万。
        # カード引落(確定請求で投影)・銀行間移動・宣言サブスク・
        # 定期振替(積立)は入らない
        b = self.out["baseline"]
        self.assertEqual(b["monthly"], 20000)
        self.assertEqual(b["account"], "bank")
        self.assertEqual(b["months"], ["2026-05", "2026-06", "2026-07"])

    def test_future_events(self):
        fe = self.out["futureEvents"]
        # 給与: 2026-08-25〜11-25 の4回
        self.assertEqual(fe["salary"]["count"], 4)
        self.assertEqual(fe["salary"]["total"], 4 * 300000)
        # 定期(recurring)= 宣言サブスク+固定費宣言+検出された定期振替(積立)。
        # サブスクは当月分(8/10)が今日より前なので9〜11月の3回、
        # 積立(8/14)と仕送り(8/15)は当月未発生なので当月を含む4回。
        # 法定控除(厚生年金)は給与清算口座上の帳簿値なので投影されない
        self.assertEqual(fe["recurring"]["count"], 3 + 4 + 4)
        self.assertEqual(fe["recurring"]["total"],
                         -(3 * 500 + 4 * 60000 + 4 * 40000))
        # 確定請求はすべて支払済み(過去日)なので card は無く、
        # 未確定月(9〜11月)が直近請求の中央値5万で概算される
        self.assertNotIn("card", fe)
        self.assertEqual(fe["card_est"]["count"], 3)
        self.assertEqual(fe["card_est"]["total"], -3 * 50000)
        # ベースラインは今日から日割りで計上される
        self.assertEqual(fe["baseline"]["first"], "2026-08-11")
        # 月額2万の日割り × (8/11〜11/30) ≒ 2万×(21/31 + 3ヶ月)
        self.assertAlmostEqual(fe["baseline"]["total"],
                               -(20000 * 21 / 31 + 60000), delta=100)

    def test_provisional_net(self):
        # 当月暫定収支 = 収入予定 − 固定費(宣言・現役) − max(判明変動費, 平常)
        p = self.out["provisionalNet"]
        # 完了3ヶ月(5〜7月)の収入中央値。7月は利息300+配当500で320,800だが
        # 中央値なので通常月の32万が立つ。当月の判明収入0より大きい方を採用
        self.assertEqual(p["incomeEst"], 320000)
        self.assertEqual(p["incKnown"], 0)
        self.assertEqual(p["incBase"], 320000)   # UI(見込み内訳)が参照する
        # 固定費 = 仕送り4万 + 厚生年金2万 + サブスク500(現役の宣言合計)
        self.assertEqual(p["fixedEst"], 60500)
        # 8月の判明変動費 = 食費3万 + 現金引出9千(宣言タグ付きは除外)
        self.assertEqual(p["varKnown"], 39000)
        # 平常ペース = 当月・先月を除く6ヶ月(1〜6月)の変動費平均。
        # 3月だけ現金引出+8千(先月7月はカード請求待ちで過小になりうるため窓外)
        self.assertAlmostEqual(p["varBase"], 68000 / 6, places=6)
        # 判明が平常を超えているので判明を採用
        self.assertEqual(p["net"], 320000 - 60500 - 39000)
        # 宣言タグ付き支出の月次合計(7月 = 500 + 4万 + 2万)
        self.assertEqual(self.out["recurringPaidJul"], 60500)

    def test_provisional_net_net_mode(self):
        # 手取りモード: 収入は法定控除後(32万−厚生年金2万)になり、
        # 給与清算口座上の法定控除宣言は固定費予定から除外される
        # (収入側に折込済みのものを固定費でもう一度引かない)
        p = self.out["provisionalNetNet"]
        self.assertEqual(p["incomeEst"], 300000)
        self.assertEqual(p["fixedEst"], 40500)   # 仕送り4万 + サブスク500
        self.assertEqual(p["varKnown"], 39000)   # 変動費はモード不変
        # 法定控除をどちら側で数えても差引は同じ = 総支給モードと一致
        self.assertEqual(p["net"], self.out["provisionalNet"]["net"])

    def test_yield_stats(self):
        # 運用益 = 利息・配当の明細(銀行300 + sec配当500。sec は評価ベースに
        # なったので配当は評価損益に含まれず明細で数える)
        #        + 証券: 評価損益Δ(実測点 pl 0 → +2万) + 残差(metal:
        #          Δ12,500 − 流入10,000 = +2,500)+ DC: Δ(残高−拠出累計)。
        # 銀行→sec の積立振替は評価ベースでは式に入らない(現金は評価額の外)
        y = self.out["yieldStats"]
        self.assertEqual(y["months"], 6)
        self.assertEqual(y["flows"], 800)
        self.assertEqual(y["dcGain"], 2000)          # (53000-51000) - 0
        self.assertEqual(y["secGain"], 22500)        # 評価2万 + metal残差2,500
        self.assertEqual(y["gain"], 25300)
        # 分母 = 月次総資産(2〜8月の7点)の平均(metal が5月から乗り、
        # 7月末は未受渡 −3万が証券から引かれる)
        self.assertEqual(y["avgAssets"], round(4565500 / 7))
        self.assertAlmostEqual(y["annual"], 25300 / (4565500 / 7) * 2,
                               places=9)
        # win 省略 = 残高履歴のある全期間(2025-11〜2026-08 の9ヶ月)。
        # 評価ベースは窓の始点に実測点が無ければ pl 0 起点(投資開始前)
        ya = self.out["yieldStatsAll"]
        self.assertEqual(ya["months"], 9)
        self.assertEqual(ya["secGain"], 22500)
        self.assertEqual(ya["gain"], 25300)
        self.assertEqual(ya["avgAssets"], round(6065500 / 10))
        self.assertAlmostEqual(ya["annual"], 25300 / (6065500 / 10) * (12 / 9),
                               places=9)

    def test_yield_monthly(self):
        # 月次分解: 評価系(証券・残差・DC)はアンカー月にだけ計上、
        # 無い月の変動は持ち越し。2026-02 は評価点があるが pl 0 のまま、
        # 2026-05 は metal のアンカー(流入と相殺で0)、2026-08 に
        # 評価+2万と metal +2,500 がまとめて実現する
        mm = {r["m"]: r for r in self.out["yieldMonthly"]}
        self.assertEqual(len(mm), 9)          # 2025-12〜2026-08
        self.assertEqual(mm["2026-02"]["sec"], 0)
        self.assertEqual(mm["2026-05"]["sec"], 0)
        self.assertIsNone(mm["2026-07"]["sec"])   # アンカー無し=計上なし
        # (未受渡の 07-30 アンカーは残差対象外。数えると7月に −3万が立つ)
        self.assertEqual(mm["2026-08"]["sec"], 22500)
        self.assertEqual(mm["2026-06"]["dc"], 0)
        self.assertEqual(mm["2026-08"]["dc"], 2000)
        self.assertEqual(mm["2026-07"]["flows"], 800)  # 銀行利息+sec配当
        # 成分合計は yieldStats 全期間の gain と一致する(持ち越しで保存)
        tot = sum((r["sec"] or 0) + (r["dc"] or 0) + r["flows"]
                  for r in self.out["yieldMonthly"])
        self.assertEqual(tot, self.out["yieldStatsAll"]["gain"])

    def test_networth_unsettled(self):
        # 未受渡は負債でなく証券グループのマイナス残高(帯が月末だけ膨らまない)
        j = self.out["nwJul"]
        self.assertEqual(j["liab"], 0)
        self.assertEqual(j["sec"], 100000 + 10000 - 30000)

    def test_build_log_view(self):
        v = self.out["buildLogView"]     # 新しい順
        self.assertEqual(len(v), 3)      # repeat行は直前グループに畳まれる
        # 最新: 失敗エントリ。警告類は空なので前回分がすべて「解消」扱い
        self.assertFalse(v[0]["ok"])
        self.assertEqual(v[0]["added"], [])
        self.assertEqual(sorted(v[0]["removed"]), ["スキップ: x", "検証: B"])
        # 中間: 検証Aが消えB+スキップが増えた。info行は差分対象外
        self.assertEqual(sorted(v[1]["added"]), ["スキップ: x", "検証: B"])
        self.assertEqual(v[1]["removed"], ["検証: A"])
        # 最古: repeat 1回を含むので count=2、期間は ts〜tsLast
        self.assertEqual(v[2]["count"], 2)
        self.assertEqual(v[2]["ts"], "2026-08-01 10:00:00")
        self.assertEqual(v[2]["tsLast"], "2026-08-02 10:00:00")
        self.assertEqual(v[2]["added"], [])   # 比較相手のない最古は差分なし

    def test_pair_lanes(self):
        v = self.out["pairLanes"]
        lane = {s["key"]: (s["a"], s["b"], s["lane"]) for s in v["spans"]}
        # 片側だけの x は線にしない
        self.assertEqual(set(lane), {"a", "b", "c", "d", "e", "g", "h", "k"})
        # 入れ子: 短い b が内側(0)、外側の a は1
        self.assertEqual(lane["b"], (1, 3, 0))
        self.assertEqual(lane["a"], (0, 4, 1))
        # 重ならない c は内側を再利用。部分的に重なる d/e は別レーン
        self.assertEqual(lane["c"], (5, 7, 0))
        self.assertEqual(lane["d"], (8, 10, 0))
        self.assertEqual(lane["e"], (9, 11, 1))
        self.assertEqual(v["lanes"], 2)
        sp = {s["key"]: s for s in v["spans"]}
        # 一対多: 多側を束ねて1側へ結ぶので2レーン使う。区間は全行の先頭〜末尾
        g = sp["g"]
        self.assertEqual((g["members"], g["hub"], g["depth"], g["a"], g["b"]),
                         ([12, 13], 14, 2, 12, 14))
        # 1側が多側の間に挟まっても同じ形(多側=15,17、1側=16)
        self.assertEqual((sp["h"]["members"], sp["h"]["hub"], sp["h"]["depth"]),
                         ([15, 17], 16, 2))
        # 1側+多側1行は束ねる必要がなく、ただのペアと同じ1レーン
        self.assertEqual(sp["k"]["depth"], 1)
        # 2レーン使う区間は、重なる区間とレーンを共有しない(d と g は離れている)
        self.assertEqual(lane["g"][2], 0)


if __name__ == "__main__":
    unittest.main()
