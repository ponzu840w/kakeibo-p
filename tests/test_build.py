"""パーサ・正規化・重複排除のサンプルベーステスト。

fixtures/ は実ファイルの構造を模した架空データ(個人情報なし)。
実行: python3 -m unittest discover tests -v
"""
import calendar
import contextlib
import io
import os
import shutil
import sys
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import build  # noqa: E402

FX = Path(__file__).resolve().parent / "fixtures"


class TestNormalize(unittest.TestCase):
    def test_halfwidth_kana_and_separate_dakuten_converge(self):
        # ゆうちょCSV(半角カナ)とHTML(全角+分離濁点)が同じ正規形になる
        self.assertEqual(build.normalize_text("自払,ｾｿﾞﾝ"),
                         build.normalize_text("自払　セソ゛ン"))
        self.assertEqual(build.normalize_text("自払,ﾋﾞｭｰｶｰﾄﾞ"),
                         build.normalize_text("自払　ヒ゛ューカート゛"))

    def test_fullwidth_alnum_to_ascii(self):
        self.assertEqual(build.normalize_text("ＲＴ,(PAYPAY)"), "RT (PAYPAY)")
        self.assertEqual(build.normalize_text("自払,DF.ﾍﾟｲﾃﾞｲ"), "自払 DF.ペイデイ")

    def test_wareki(self):
        self.assertEqual(build.wareki_to_iso("8-07-14"), "2026-07-14")
        self.assertEqual(build.wareki_to_iso("7-11-06"), "2025-11-06")
        with self.assertRaises(ValueError):
            build.wareki_to_iso("2026-07-14")

    def test_parse_amount(self):
        self.assertEqual(build.parse_amount("123,456"), 123456)
        self.assertEqual(build.parse_amount("123,456円"), 123456)
        self.assertEqual(build.parse_amount("-500"), -500)
        self.assertIsNone(build.parse_amount("-"))
        self.assertIsNone(build.parse_amount("　"))


class TestSaison(unittest.TestCase):
    def test_parse(self):
        txns, meta = build.parse_saison(FX / "saison_sample.csv")
        self.assertEqual(meta["pay_date"], "2026-06-04")
        self.assertEqual(meta["bill_total"], 4138)
        self.assertEqual(len(txns), 4)
        # 利用=負債増なので符号反転
        self.assertEqual(txns[0].amount, -638)
        # 継続行が直前明細にマージされる
        sub = txns[1]
        self.assertIn("(TESTSHOP.COM)", sub.description)
        self.assertIn("円換算レート", sub.memo)
        # 返品はプラス
        self.assertEqual(txns[3].amount, 200)
        # 明細合計 = 請求額
        self.assertEqual(-sum(t.amount for t in txns), meta["bill_total"])


class TestYucho(unittest.TestCase):
    def test_parse_csv(self):
        txns, _ = build.parse_yucho_csv(FX / "yucho_sample.csv")
        self.assertEqual(len(txns), 3)
        self.assertEqual(txns[0].date, "2026-06-01")
        self.assertEqual(txns[0].amount, -20000)
        self.assertEqual(txns[0].balance, 103456)
        self.assertEqual(txns[0].native_id, "202606010000001")
        self.assertEqual(txns[2].amount, 24138)

    def test_parse_html(self):
        txns, _ = build.parse_yucho_html(FX / "yucho_sample.html")
        # 「通帳の現在高」行は取引ではない
        self.assertEqual(len(txns), 5)
        # 古い順に反転されている
        self.assertEqual(txns[0].date, "2026-04-06")
        self.assertEqual(txns[0].amount, 50000)
        self.assertIn("通帳未記入金合計", txns[0].description)
        # 分離濁点が正規化される
        view = [t for t in txns if "ビューカード" in t.description]
        self.assertEqual(len(view), 1)
        self.assertEqual(view[0].amount, -1000)

    def test_csv_fetched_date(self):
        """ヘッダの「出力日時:令和…」をDL日=取込日として申告する。"""
        _, meta = build.parse_yucho_csv(FX / "yucho_sample.csv")
        self.assertEqual(meta["fetched"],
                         {"account": "yucho", "date": "2026-06-30"})

    def test_csv_html_dedup(self):
        """CSVとHTML(通帳未記入分)の重複期間が増殖しない。"""
        csv_txns, _ = build.parse_yucho_csv(FX / "yucho_sample.csv")
        html_txns, _ = build.parse_yucho_html(FX / "yucho_sample.html")
        merged = build.dedup([csv_txns, html_txns])
        # CSV3件のうち3件がHTML5件と重複 → 計5件
        self.assertEqual(len(merged), 5)
        # 重複時はnative_id持ち(CSV)が残る
        seson = [t for t in merged if t.date == "2026-06-04"]
        self.assertEqual(len(seson), 1)
        self.assertEqual(seson[0].native_id, "202606040000001")


class TestYuchoPaper(unittest.TestCase):
    def test_sniff(self):
        self.assertEqual(build.sniff_format(FX / "yucho_paper_sample.csv"),
                         "yucho_paper")

    def test_parse(self):
        txns, _ = build.parse_yucho_paper(FX / "yucho_paper_sample.csv")
        # 通帳・受取利子・振込・料金・合算の5件(利子/税金の内訳行は読まない)
        self.assertEqual(len(txns), 5)
        descs = [t.description for t in txns]
        self.assertNotIn("利子", descs)
        self.assertNotIn("税金", descs)
        # 受取利子は内訳をネット済みの額面で取り込む
        interest = txns[1]
        self.assertEqual((interest.amount, interest.balance), (19, 10019))
        # 日付なしでも現在高が動く行(振込手数料)は直前の日付を継いで取り込む
        fee = txns[3]
        self.assertEqual(fee.description, "料金")
        self.assertEqual((fee.date, fee.amount, fee.balance),
                         ("2021-10-31", -220, 8095))
        # 合算行は支払・預りのネット
        self.assertEqual(txns[4].amount, -2000)

    def test_balances_are_consistent(self):
        """フィクスチャ全体で残高列と取引額が整合する(#料金行の取込を含め)。"""
        txns, _ = build.parse_yucho_paper(FX / "yucho_paper_sample.csv")
        bal = txns[0].balance
        for t in txns[1:]:
            bal += t.amount
            self.assertEqual(bal, t.balance, t.description)


class TestPayPay(unittest.TestCase):
    def test_parse(self):
        txns, _ = build.parse_paypay(FX / "paypay_sample.csv")
        self.assertEqual(len(txns), 4)
        # 古い順に反転されている
        self.assertEqual(txns[0].date, "2026-05-31")
        self.assertEqual(txns[0].amount, -3000)
        self.assertEqual(txns[0].type, "expense")
        # チャージはチャージ元が摘要に入る
        charge = txns[1]
        self.assertEqual(charge.amount, 20000)
        self.assertIn("チャージ ゆうちょ銀行", charge.description)
        # ポイント獲得は収入ヒント
        point = [t for t in txns if "ポイント" in t.description][0]
        self.assertEqual(point.type, "income")
        self.assertEqual(point.amount, 1)

    def test_same_toriihiki_bango_not_merged(self):
        """支払いとポイント獲得は取引番号が同じでも別明細。"""
        txns, _ = build.parse_paypay(FX / "paypay_sample.csv")
        merged = build.dedup([txns])
        self.assertEqual(len(merged), 4)

    def test_fetched_from_filename(self):
        """既定ファイル名の範囲末尾=明細を要求した日を取込日として申告。
        リネームされていれば黙って無し扱い。"""
        # dir=build.ROOT は必須: パーサは source を ROOT 相対で持つため
        # (path.relative_to(ROOT))、ROOT 外の一時ファイルは ValueError になる
        with tempfile.TemporaryDirectory(dir=build.ROOT) as td:
            p = Path(td) / "Transactions_20250716-20260715.csv"
            shutil.copy(FX / "paypay_sample.csv", p)
            _, meta = build.parse_paypay(p)
        self.assertEqual(meta["fetched"],
                         {"account": "paypay", "date": "2026-07-15"})
        _, meta = build.parse_paypay(FX / "paypay_sample.csv")
        self.assertEqual(meta, {})


class TestSuica(unittest.TestCase):
    def test_sniff(self):
        self.assertEqual(build.sniff_format(FX / "suica_sample.html"),
                         "suica_html")

    def test_parse(self):
        txns, _ = build.parse_suica_html(FX / "suica_sample.html")
        # 「繰」(繰越)行は取引でない
        self.assertEqual(len(txns), 5)
        # 古い順に反転され、selectedの2026/01から年を巻き戻して復元される
        self.assertEqual(txns[0].date, "2025-12-28")
        self.assertEqual(txns[0].description, "オート サンプル駅")
        self.assertEqual(txns[0].amount, 5000)
        self.assertEqual(txns[0].balance, 6000)
        self.assertEqual(txns[1].date, "2025-12-30")
        self.assertEqual(txns[1].description, "入 サンプル駅 出 テスト駅")
        self.assertEqual(txns[-1].date, "2026-01-05")
        self.assertEqual(txns[-1].amount, -300)
        # 半角カナが正規化される
        charge = [t for t in txns if t.amount == 2000][0]
        self.assertEqual(charge.description, "カード モバイル")
        self.assertEqual(charge.date, "2026-01-04")

    def test_overlap_dedup(self):
        """期間の重なる複数保存が(日付,金額,残高)キーで増殖しない。"""
        a, _ = build.parse_suica_html(FX / "suica_sample.html")
        b, _ = build.parse_suica_html(FX / "suica_sample_overlap.html")
        merged = build.dedup([a, b])
        # a:5件 + b:3件 のうち2件(12/30, 12/28オート)が重複 → 6件
        self.assertEqual(len(merged), 6)
        self.assertEqual(len(build.dedup([a, a])), 5)

    def test_fetched_date(self):
        """SingleFileの保存日を取込日として申告する(履歴が26週で消える
        ソースなので、保存日=鮮度が取引日より重要)。"""
        _, meta = build.parse_suica_html(FX / "suica_sample.html")
        self.assertEqual(meta["fetched"],
                         {"account": "suica", "date": "2026-01-08"})


class TestSmbc(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(build.sniff_format(FX / "smbc_sample.csv"), "smbc_csv")
        txns, _ = build.parse_smbc_csv(FX / "smbc_sample.csv")
        # 金額0・摘要空の行は取引でない
        self.assertEqual(len(txns), 1)
        t = txns[0]
        self.assertEqual(t.date, "2026-05-13")  # ゼロ埋めなし日付の正規化
        self.assertEqual(t.amount, 5500)
        self.assertEqual(t.balance, 5500)
        self.assertIn("振込", t.description)


class TestView(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(build.sniff_format(FX / "view_sample.csv"), "view_csv")
        txns, meta = build.parse_view_csv(FX / "view_sample.csv")
        self.assertEqual(meta["account"], "viewcard")
        self.assertEqual(meta["pay_date"], "2026-08-04")
        self.assertEqual(meta["bill_total"], 12000)
        self.assertEqual(len(txns), 3)
        # 利用=負、払戻=正。明細合計 = 請求額
        self.assertEqual(txns[0].amount, -5000)
        self.assertIn("オートチャージ", txns[0].description)
        self.assertEqual(txns[2].amount, 200)
        self.assertEqual(-sum(t.amount for t in txns), meta["bill_total"])


class TestStarbucks(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(build.sniff_format(FX / "starbucks_sample.html"),
                         "starbucks_html")
        txns, _ = build.parse_starbucks_html(FX / "starbucks_sample.html")
        # 0円の発行行はスキップ、古い順に反転
        self.assertEqual(len(txns), 2)
        self.assertEqual(txns[0].date, "2025-09-05")
        self.assertEqual(txns[0].amount, 2000)       # オートチャージ(入金)
        self.assertEqual(txns[1].amount, -500)       # モバイルオーダー(支出)
        self.assertIn("モバイルオーダー&ペイ", txns[1].description)


class TestPaidy(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(build.sniff_format(FX / "paidy_sample.html"),
                         "paidy_html")
        txns, meta = build.parse_paidy_html(FX / "paidy_sample.html")
        # 取引になるのは購入(プラン詳細)と「N月分の支払い」だけ。
        # 「N回あと払い支払額」(2026/05/01)は購入時計上済みの情報行、
        # 「お支払い受領」(2026/07/01, 2026/03/01)は月分行の別表示で捨てる
        self.assertEqual(len(txns), 3)
        self.assertEqual([t.date for t in txns],
                         ["2025-10-01", "2026-05-01", "2026-07-01"])
        # 購入はプラン詳細から購入日に一括計上(ご注文番号=native_idで冪等)
        self.assertEqual(txns[0].amount, -240000)
        self.assertEqual(txns[0].description, "Apple (Apple Online Store)")
        self.assertEqual(txns[0].native_id, "W9999999999")
        self.assertEqual(txns[0].memo, "テストノートPC 13インチ - サンプルカラー")
        # ページ符号は利用者視点なので反転: 支払い=負債減=正
        self.assertEqual(txns[1].amount, 10000)
        self.assertEqual(txns[2].description, "5月分の支払い")
        # 残債(Apple+通常の合計)が保存日時点の負債アンカーになる
        e = meta["entries"][0]
        self.assertEqual(e["account"], "paidy")
        self.assertEqual(e["balance"], -151000)
        self.assertEqual(e["date"], "2026-07-17")
        self.assertEqual(e["note"], "残債")
        # Apple以外の残債は行型未実装なので取込警告が立つ
        self.assertEqual(len(meta["warnings"]), 1)
        self.assertIn("Apple以外", meta["warnings"][0])


class TestNeobank(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(build.sniff_format(FX / "neobank_sample.csv"),
                         "neobank_csv")
        txns, _ = build.parse_neobank_csv(FX / "neobank_sample.csv")
        self.assertEqual(len(txns), 3)
        # 古い順に反転、sbi_hybrid 口座に計上、残高列あり
        self.assertEqual(txns[0].date, "2026-07-01")
        self.assertEqual(txns[0].amount, 12)
        self.assertEqual(txns[-1].amount, -25000)
        self.assertEqual(txns[-1].balance, 10012)
        self.assertEqual(txns[-1].account, "sbi_hybrid")
        self.assertEqual(txns[-1].description, "振替 SBI証券")  # 全角→半角

    def test_daihyo_after_cutoff(self):
        """連携解除(NEOBANK_SBINET_FROM)以降の行は代表口座 sbinet に帰属。"""
        txns, _ = build.parse_neobank_csv(FX / "neobank_daihyo_sample.csv")
        self.assertEqual(len(txns), 1)
        self.assertEqual(txns[0].account, "sbinet")
        self.assertEqual(txns[0].date, "2026-08-14")
        self.assertEqual(txns[0].amount, 9)
        self.assertEqual(txns[0].balance, 9)
        self.assertEqual(txns[0].description, "SBIハイブリッド預金")  # 全角→半角

    def test_fetched_from_filename(self):
        """既定ファイル名 nyushukinmeisai_YYYYMMDD.csv のDL日を取込日に。"""
        with tempfile.TemporaryDirectory(dir=build.ROOT) as td:
            p = Path(td) / "nyushukinmeisai_20260718.csv"
            shutil.copy(FX / "neobank_sample.csv", p)
            _, meta = build.parse_neobank_csv(p)
        self.assertEqual(meta["fetched"],
                         {"account": "sbi_hybrid", "date": "2026-07-18"})


class TestShinsei(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(build.sniff_format(FX / "shinsei_sample.csv"),
                         "shinsei_csv")
        txns, _ = build.parse_shinsei_csv(FX / "shinsei_sample.csv")
        self.assertEqual(len(txns), 2)
        # 古い順に反転、sbi_shinsei 口座に計上、残高列あり
        self.assertEqual(txns[0].date, "2026-08-18")
        self.assertEqual(txns[0].amount, 30000)
        self.assertEqual(txns[0].balance, 30000)
        self.assertEqual(txns[0].account, "sbi_shinsei")
        self.assertEqual(txns[0].description, "SBI証券精算")
        self.assertEqual(txns[-1].amount, -5000)
        self.assertEqual(txns[-1].balance, 25000)

    def test_fetched_from_filename(self):
        """既定ファイル名 JPY_HY_YYYYMMDDhhmmss.csv のDL日を取込日に。"""
        with tempfile.TemporaryDirectory(dir=build.ROOT) as td:
            p = Path(td) / "JPY_HY_20260822190741.csv"
            shutil.copy(FX / "shinsei_sample.csv", p)
            _, meta = build.parse_shinsei_csv(p)
        self.assertEqual(meta["fetched"],
                         {"account": "sbi_shinsei", "date": "2026-08-22"})


class TestPaypal(unittest.TestCase):
    def test_parse(self):
        self.assertEqual(build.sniff_format(FX / "paypal_sample.csv"),
                         "paypal_csv")
        txns, _ = build.parse_paypal_csv(FX / "paypal_sample.csv")
        # JPYのみ・日付順ソート
        self.assertEqual(len(txns), 2)
        self.assertEqual(txns[0].date, "2026-06-01")
        self.assertEqual(txns[0].amount, 5000)
        self.assertEqual(txns[1].amount, -1200)
        self.assertEqual(txns[1].balance, 3800)
        self.assertEqual(txns[1].native_id, "TX123")


class TestDemoKyuyo(unittest.TestCase):
    """架空の給与明細CSV(勤務先系ソースの実装例)。"""
    def test_parse(self):
        self.assertEqual(build.sniff_format(FX / "demo_kyuyo_sample.csv"),
                         "demo_kyuyo")
        txns, meta = build.parse_demo_kyuyo(FX / "demo_kyuyo_sample.csv")
        by_desc = {t.description: t for t in txns}
        self.assertEqual(by_desc["基本給"].amount, 280000)
        self.assertEqual(by_desc["健康保険料"].amount, -15000)
        self.assertNotIn("定勤日数", by_desc)   # 勤務行は明細にしない
        self.assertNotIn("銀行振込額", by_desc)
        self.assertTrue(all(t.account == "kyuyo" for t in txns))
        self.assertTrue(all(t.date == "2026-06-01" for t in txns))
        # 支給 − 控除 = 検算行(銀行振込額)と整合
        self.assertEqual(sum(t.amount for t in txns), 246700)
        # 支給月まるごとのカバー宣言(月初計上の取引日で鮮度を測らない)
        self.assertEqual(meta["cover"],
                         {"account": "kyuyo", "until": "2026-06-30",
                          "label": "2026-06支給"})
        # 勤怠実績は前月・「付与」項目は支給月に帰属(stmt=支給月は冪等キー)
        self.assertEqual(meta["work"], [
            {"month": "2026-05", "kind": "給与", "stmt": "2026-06",
             "items": [{"name": "定勤日数", "value": 20.0},
                       {"name": "時間外時間", "value": 12.5}]},
            {"month": "2026-06", "kind": "給与", "stmt": "2026-06",
             "items": [{"name": "有給付与日数", "value": 20.0}]},
        ])

    def test_checksum_mismatch_raises(self):
        data = (FX / "demo_kyuyo_sample.csv").read_bytes()
        bad = data.replace(b"246700", b"999999")
        with tempfile.NamedTemporaryFile(suffix=".csv", delete=False,
                                         dir=build.ROOT) as f:
            f.write(bad)
            p = Path(f.name)
        try:
            with self.assertRaises(ValueError):
                build.parse_demo_kyuyo(p)
        finally:
            p.unlink()


class TestDemoDc(unittest.TestCase):
    """架空の企業型DCポータルHTML(残高アンカー型ソースの実装例)。"""
    def test_parse(self):
        self.assertEqual(build.sniff_format(FX / "demo_dc_sample.html"),
                         "demo_dc_html")
        txns, meta = build.parse_demo_dc_html(FX / "demo_dc_sample.html")
        self.assertEqual(txns, [])
        self.assertEqual(meta["kind"], "balances")
        self.assertEqual(meta["entries"], [
            {"date": "2026-06-30", "account": "dc", "balance": 1234567,
             "contrib_total": 1000000,
             "note": "DCポータル評価額・拠出累計 1,000,000円"}])

    def test_contrib_total_reaches_balances(self):
        """拠出累計はアンカーに素通しされUIの損益逆算に使える。"""
        _, meta = build.parse_demo_dc_html(FX / "demo_dc_sample.html")
        anchors = build.latest_balances([], None, meta["entries"])
        self.assertEqual(anchors["dc"]["contrib_total"], 1000000)

    def test_amount_missing_raises(self):
        with tempfile.TemporaryDirectory(dir=build.ROOT) as td:
            p = Path(td) / "dc_empty.html"
            p.write_text("<html>デモDCポータル</html>", encoding="utf-8")
            with self.assertRaises(ValueError):
                build.parse_demo_dc_html(p)


class TestSbi(unittest.TestCase):
    def test_cash(self):
        txns, _ = build.parse_sbisec_cash(FX / "sbisec_cash_sample.csv")
        self.assertEqual(len(txns), 4)
        # 古い順に反転されている
        self.assertEqual(txns[0].date, "2026-01-10")
        self.assertEqual(txns[0].amount, -1500)
        haito = [t for t in txns if "配当金" in t.description][0]
        self.assertEqual(haito.amount, 99)
        self.assertEqual(txns[-1].amount, -25000)

    def test_portfolio_undated_falls_back_to_mtime(self):
        """プレフィックスがなければファイル更新時刻を取得日として推定する。"""
        p = FX / "sbi_portfolio_undated.csv"
        ts = datetime(2026, 7, 1, 21, 30).timestamp()
        # mtime 由来の推定なので、commit 済み fixture の mtime をその場で
        # 固定しないと環境依存で落ちる(中身は変えない)
        os.utime(p, (ts, ts))
        _, meta = build.parse_sbi_portfolio(p)
        self.assertEqual(meta["date"], "2026-07-01")
        self.assertIn("推定", meta["note"])

    def test_portfolio(self):
        txns, meta = build.parse_sbi_portfolio(
            FX / "2026-07-16_sbi_portfolio_sample.csv")
        self.assertEqual(txns, [])
        self.assertEqual(meta["date"], "2026-07-16")
        self.assertEqual(len(meta["holdings"]), 2)
        self.assertEqual(meta["total_value"], 14500.5)
        self.assertEqual(meta["total_pl"], 2500.5)
        fund = meta["holdings"][1]
        self.assertEqual(fund["value"], 12000.5)
        self.assertIn("投資信託", fund["section"])

    def test_sbi_value_history(self):
        """資産推移CSV(ヘッダなし2列)はスナップショット形の点列になり、
        残高アンカーと invest.value_history の両方に効く(build 側で合流)。"""
        p = FX / "sbi_value_history_sample.csv"
        self.assertEqual(build.sniff_format(p), "sbi_value_history")
        txns, meta = build.parse_sbi_value_history(p)
        self.assertEqual(txns, [])
        self.assertEqual(meta["kind"], "portfolio_series")
        ps = meta["points"]
        self.assertEqual([e["date"] for e in ps],
                         ["2026-01-03", "2026-01-10", "2026-02-07"])
        self.assertEqual([e["total_value"] for e in ps], [10000, 10500, 25000])
        self.assertTrue(all(e["account"] == "sbisec" for e in ps))
        # 損益は持たない(pl_history に混ざらない)。保有銘柄表対策の空 holdings
        self.assertTrue(all(e.get("total_pl") is None for e in ps))
        self.assertTrue(all(e["holdings"] == [] for e in ps))

    def test_pl_history_points(self):
        """含み益点列: 実測(total_pl)はそのまま、評価額のみの点は
        「評価額 − 約定履歴の累積元本」で導出。再投資・貴金属は元本に入れない。"""
        events = [
            {"date": "2026-01-05", "action": "投信金額買付", "amount": 10000,
             "fee": 0, "kind": "trade"},
            {"date": "2026-01-20", "action": "分配金再投資", "amount": 500,
             "fee": 0, "kind": "trade"},                    # 元本に入らない
            {"date": "2026-02-03", "action": "買付 (スポット取引)",
             "amount": 3000, "fee": 30, "kind": "metal"},   # 貴金属は除外
            {"date": "2026-02-05", "action": "株式現物買", "amount": 20000,
             "fee": 100, "kind": "trade"},
            {"date": "2026-03-01", "action": "株式現物売", "amount": -5000,
             "fee": 50, "kind": "trade"},                   # 元本から4950控除
        ]
        snaps = [
            {"account": "sbisec", "date": "2026-01-10", "total_value": 10800},
            {"account": "sbisec", "date": "2026-02-10", "total_value": 31000},
            {"account": "sbisec", "date": "2026-03-10", "total_value": 27000},
            {"account": "sbisec", "date": "2026-03-20", "total_value": 99999,
             "total_pl": 1234},                             # 実測が優先
        ]
        pts = build.pl_history_points(snaps, events)
        self.assertEqual(pts, [
            {"date": "2026-01-10", "pl": 800},      # 10800 − 10000
            {"date": "2026-02-10", "pl": 900},      # 31000 − 30100
            {"date": "2026-03-10", "pl": 1850},     # 27000 − (30100−4950)
            {"date": "2026-03-20", "pl": 1234},
        ])

    def test_trades(self):
        _, meta = build.parse_sbi_trades(FX / "sbi_trades_sample.csv")
        ev = meta["events"]
        self.assertEqual(len(ev), 2)
        self.assertEqual(ev[0]["amount"], 2000)
        self.assertEqual(ev[0]["deposit"], "NISA(成)")
        self.assertEqual(ev[1]["action"], "投信金額買付")
        self.assertEqual(ev[1]["amount"], 10000)

    def test_metal_skips_unexecuted(self):
        _, meta = build.parse_sbi_metal(FX / "sbi_metal_sample.csv")
        ev = meta["events"]
        self.assertEqual(len(ev), 1)  # 未約定行は拾わない
        self.assertEqual(ev[0]["amount"], 1000)
        self.assertEqual(ev[0]["fee"], 17)
        self.assertEqual(ev[0]["qty"], 2.5)


class TestOrganizeInbox(unittest.TestCase):
    """inbox の自動振り分け。移動・改名のみで中身は不変が原則。
    inbox は raw/ の外(data/ 直下)に置く。"""

    def _dirs(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        raw, inbox = root / "raw", root / "inbox"
        raw.mkdir()
        inbox.mkdir()
        return raw, inbox

    def test_moves_and_prefixes_portfolio(self):
        raw, inbox = self._dirs()
        body = (FX / "sbi_portfolio_undated.csv").read_bytes()
        p = inbox / "New_file.csv"
        p.write_bytes(body)
        ts = datetime(2026, 7, 1, 21, 30).timestamp()
        os.utime(p, (ts, ts))
        notes, left = build.organize_inbox(raw_dir=raw, inbox_dir=inbox)
        self.assertEqual(len(notes), 1)
        self.assertEqual(left, [])
        dest = raw / "sbi" / "2026-07-01_New_file.csv"
        self.assertTrue(dest.exists())
        self.assertFalse(p.exists())
        self.assertEqual(dest.read_bytes(), body)  # 中身は不変

    def test_duplicate_content_removes_inbox_copy(self):
        raw, inbox = self._dirs()
        body = (FX / "saison_sample.csv").read_bytes()
        (raw / "saison").mkdir()
        (raw / "saison" / "SAISON_2601.csv").write_bytes(body)
        p = inbox / "SAISON_2601.csv"
        p.write_bytes(body)
        notes, _ = build.organize_inbox(raw_dir=raw, inbox_dir=inbox)
        self.assertFalse(p.exists())
        self.assertIn("同一内容", notes[0])

    def test_name_collision_keeps_both(self):
        raw, inbox = self._dirs()
        (raw / "saison").mkdir()
        (raw / "saison" / "SAISON_2601.csv").write_bytes(b"different")
        p = inbox / "SAISON_2601.csv"
        p.write_bytes((FX / "saison_sample.csv").read_bytes())
        build.organize_inbox(raw_dir=raw, inbox_dir=inbox)
        self.assertTrue((raw / "saison" / "SAISON_2601-2.csv").exists())
        self.assertEqual((raw / "saison" / "SAISON_2601.csv").read_bytes(),
                         b"different")

    def test_unknown_stays_and_dry_run_moves_nothing(self):
        raw, inbox = self._dirs()
        unknown = inbox / "memo.txt"
        unknown.write_text("ただのメモ", encoding="utf-8")
        p = inbox / "SAISON_2601.csv"
        p.write_bytes((FX / "saison_sample.csv").read_bytes())
        notes, left = build.organize_inbox(raw_dir=raw, inbox_dir=inbox,
                                           dry_run=True)
        self.assertEqual(len(notes), 1)   # 予告は出るが
        self.assertTrue(p.exists())       # 移動しない
        self.assertEqual(left, ["memo.txt"])
        _, left = build.organize_inbox(raw_dir=raw, inbox_dir=inbox)
        self.assertTrue(unknown.exists())  # 判別不能はinboxに残る
        self.assertEqual(left, ["memo.txt"])
        self.assertFalse(p.exists())


class TestSniff(unittest.TestCase):
    def test_binary_file_returns_none(self):
        """PDF等のバイナリは判別不能としてNone(スキップ)。クラッシュしない。"""
        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as f:
            f.write(b"%PDF-1.4\n\xff\xff\xfe\x81 binary")
            p = Path(f.name)
        try:
            self.assertIsNone(build.sniff_format(p))
        finally:
            p.unlink()


class TestFreshness(unittest.TestCase):
    def test_bill_pay_date_counts_as_fresh(self):
        """カード明細は利用日が請求確定まで遅れるので、請求の支払日で鮮度を測る。"""
        accounts = {"saison": {"name": "セゾン", "active": True,
                               "update_interval_days": 35}}
        t = build.Txn(account="saison", date="2026-06-05", amount=-100,
                      description="x", raw_description="x", source="t")
        today = date(2026, 7, 16)
        self.assertEqual(len(build.freshness_warnings([t], accounts, today)), 1)
        bills = [{"account": "saison", "pay_date": "2026-07-04", "bill_total": 1}]
        self.assertEqual(build.freshness_warnings([t], accounts, today, bills), [])

    def test_balance_anchor_counts_as_import(self):
        """取引を持たず残高アンカーだけで取り込む口座(企業型DC等)は、
        アンカー日付を最終取込に数える(「一度も取り込まれていない」に
        誤判定しない)。"""
        accounts = {"dc": {"name": "企業型DC", "active": True,
                           "update_interval_days": 90}}
        today = date(2026, 7, 24)
        # アンカーなし → 未取込警告
        self.assertIn("一度も", build.freshness_warnings(
            [], accounts, today)[0]["message"])
        # アンカーあり → その日付が最終取込
        anchors = [{"date": "2026-07-21", "account": "dc"}]
        rep = build.freshness_report([], accounts, today, anchors=anchors)
        self.assertEqual((rep[0]["last"], rep[0]["days"]), ("2026-07-21", 3))
        self.assertEqual(build.freshness_warnings(
            [], accounts, today, anchors=anchors), [])

    def test_future_pay_date_is_clipped_to_today(self):
        """支払日が未来の請求は「今日取り込んだ」扱い。未来日を最終取込に
        すると「-12日前」のような表示になるため。"""
        accounts = {"saison": {"name": "セゾン", "active": True,
                               "update_interval_days": 35}}
        today = date(2026, 7, 16)
        bills = [{"account": "saison", "pay_date": "2026-08-04",
                  "bill_total": 1}]
        rep = build.freshness_report([], accounts, today, bills)
        self.assertEqual(rep[0]["last"], "2026-07-16")
        self.assertEqual(rep[0]["days"], 0)

    def test_report_separates_date_kinds(self):
        """first/data_end は明細(レコード)のカバレッジ、imported は取込日
        (アンカー・DL日)、cover_until/label は請求由来のカバー(丸めなし)。
        警告判定用の last だけが3種の合成で、カバーの丸めは他を動かさない。"""
        accounts = {"saison": {"name": "セゾン", "active": True,
                               "update_interval_days": 35}}
        txns = [build.Txn(account="saison", date=d, amount=-100,
                          description="x", raw_description="x", source="t")
                for d in ("2025-03-08", "2026-07-08")]
        bills = [{"account": "saison", "pay_date": "2026-08-04",
                  "bill_total": 1}]
        rep = build.freshness_report(txns, accounts, date(2026, 7, 26), bills)
        self.assertEqual(rep[0]["first"], "2025-03-08")
        self.assertEqual(rep[0]["data_end"], "2026-07-08")
        self.assertEqual((rep[0]["cover_until"], rep[0]["cover_label"]),
                         ("2026-08-04", "2026-08請求"))
        self.assertEqual(rep[0]["last"], "2026-07-26")  # 未来支払日→今日に丸め
        # アンカーだけの口座(企業型DC等)は imported のみ。明細範囲は空
        accounts = {"dc": {"name": "DC", "active": True,
                           "update_interval_days": 90}}
        rep = build.freshness_report(
            [], accounts, date(2026, 7, 26),
            anchors=[{"date": "2026-07-21", "account": "dc"},
                     {"date": "2026-07-25", "account": "dc"}])
        self.assertEqual((rep[0]["data_end"], rep[0]["imported"],
                          rep[0]["last"]), ("", "2026-07-25", "2026-07-25"))

    def test_cover_declaration_counts_as_fresh(self):
        """カバー宣言(給与=支給月まるごと等)は、明細のレコード日(月初計上)
        が古くても「末尾の日まで取込済み」として鮮度に数える。"""
        accounts = {"kyuyo": {"name": "給与", "active": True,
                              "update_interval_days": 40}}
        t = build.Txn(account="kyuyo", date="2026-07-01", amount=100,
                      description="x", raw_description="x", source="t")
        today = date(2026, 8, 15)  # 月初計上から45日: カバーなしだと警告
        self.assertEqual(len(build.freshness_warnings([t], accounts, today)), 1)
        covers = [{"account": "kyuyo", "until": "2026-07-31",
                   "label": "2026-07支給"}]
        self.assertEqual(build.freshness_warnings(
            [t], accounts, today, covers=covers), [])
        rep = build.freshness_report([t], accounts, today, covers=covers)
        self.assertEqual((rep[0]["last"], rep[0]["cover_label"]),
                         ("2026-07-31", "2026-07支給"))
        self.assertEqual(rep[0]["data_end"], "2026-07-01")  # レコードは月初のまま

    def test_fetched_date_counts_as_import(self):
        """パーサ申告の取込日(CSVのDL日等)は最終取込に数える。明細末端が
        古くても、取り込んだばかりなら警告しない。"""
        accounts = {"yucho": {"name": "ゆうちょ", "active": True,
                              "update_interval_days": 35}}
        t = build.Txn(account="yucho", date="2026-06-01", amount=-100,
                      description="x", raw_description="x", source="t")
        today = date(2026, 7, 20)
        self.assertEqual(len(build.freshness_warnings([t], accounts, today)), 1)
        fetched = [{"date": "2026-07-18", "account": "yucho"}]
        self.assertEqual(build.freshness_warnings(
            [t], accounts, today, fetched=fetched), [])
        rep = build.freshness_report([t], accounts, today, fetched=fetched)
        self.assertEqual((rep[0]["data_end"], rep[0]["imported"],
                          rep[0]["last"]), ("2026-06-01", "2026-07-18",
                                            "2026-07-18"))

    def test_uistate_mute_and_ack(self):
        """uistate.toml の通知オフは警告を消し、更新確認は取込と同格に数える。"""
        accounts = {"saison": {"name": "セゾン", "active": True,
                               "update_interval_days": 35}}
        t = build.Txn(account="saison", date="2026-06-05", amount=-100,
                      description="x", raw_description="x", source="t")
        today = date(2026, 7, 16)
        self.assertEqual(len(build.freshness_warnings([t], accounts, today)), 1)
        self.assertEqual(build.freshness_warnings(
            [t], accounts, today, uistate={"mute": {"saison": True}}), [])
        self.assertEqual(build.freshness_warnings(
            [t], accounts, today, uistate={"ack": {"saison": "2026-07-10"}}), [])
        stale = build.freshness_warnings(
            [t], accounts, today, uistate={"ack": {"saison": "2026-06-06"}})
        self.assertEqual(len(stale), 1)
        self.assertIn("更新確認 2026-06-06", stale[0]["message"])

    def test_monthly_due(self):
        """直近(今日以前)の月次更新日。月跨ぎ・年跨ぎ・月末丸め。"""
        self.assertEqual(build.monthly_due(date(2026, 7, 18), 18),
                         date(2026, 7, 18))  # 当日はその日
        self.assertEqual(build.monthly_due(date(2026, 8, 5), 18),
                         date(2026, 7, 18))  # 更新日前は前月
        self.assertEqual(build.monthly_due(date(2026, 1, 5), 18),
                         date(2025, 12, 18))  # 年跨ぎ
        self.assertEqual(build.monthly_due(date(2026, 3, 1), 31),
                         date(2026, 2, 28))  # 存在しない日は月末に丸め

    def test_update_day_event_based(self):
        """月次更新日(カード確定日等)の宣言がある口座は、経過日数でなく
        「直近の更新日以降の取込があるか」で判定する(猶予なし)。"""
        accounts = {"saison": {"name": "セゾン", "active": True,
                               "update_interval_days": 35, "update_day": 18}}
        t = build.Txn(account="saison", date="2026-06-20", amount=-100,
                      description="x", raw_description="x", source="t")
        # 更新日前日まではセーフ、当日から即警告
        self.assertEqual(build.freshness_warnings(
            [t], accounts, date(2026, 7, 17)), [])
        warns = build.freshness_warnings([t], accounts, date(2026, 7, 18))
        self.assertEqual(len(warns), 1)
        self.assertIn("2026-07-18", warns[0]["message"])
        # 更新日以降の取込(請求カバー)があれば、明細末端が期待間隔より
        # 古くても警告しない(日数ベース判定は使わない)
        bills = [{"account": "saison", "pay_date": "2026-08-04",
                  "bill_total": 1}]
        self.assertEqual(build.freshness_warnings(
            [t], accounts, date(2026, 8, 10), bills), [])
        # 更新確認(ack)も更新日以降なら取込と同格
        self.assertEqual(build.freshness_warnings(
            [t], accounts, date(2026, 7, 20),
            uistate={"ack": {"saison": "2026-07-19"}}), [])
        self.assertEqual(len(build.freshness_warnings(
            [t], accounts, date(2026, 7, 20),
            uistate={"ack": {"saison": "2026-07-10"}})), 1)

    def test_update_day_month_start(self):
        """月初更新(Paidy=毎月1日確定)の月跨ぎ: 前月末までの取込では
        1日の確定に届かず、当日から警告。"""
        accounts = {"paidy": {"name": "Paidy", "active": True,
                              "update_interval_days": 35, "update_day": 1}}
        covers = [{"account": "paidy", "until": "2026-07-27",
                   "label": "2026-07請求"}]
        self.assertEqual(build.freshness_warnings(
            [], accounts, date(2026, 7, 31), covers=covers), [])
        warns = build.freshness_warnings(
            [], accounts, date(2026, 8, 1), covers=covers)
        self.assertEqual(len(warns), 1)
        self.assertIn("2026-08-01", warns[0]["message"])


class TestSbiMetalReport(unittest.TestCase):
    """SBI貴金属月次報告書PDF → sbi_metal の月末残高アンカー。"""
    def test_sniff(self):
        self.assertEqual(build.sniff_format(FX / "sbi_metal_report_sample.pdf"),
                         "sbi_metal_report")

    def test_parse(self):
        txns, meta = build.parse_sbi_metal_report(
            FX / "sbi_metal_report_sample.pdf")
        self.assertEqual(txns, [])
        self.assertEqual(meta["kind"], "balances")
        # 記載対象日は表のセル(本文中の「YYYY年MM月DD日現在」は拾わない)。
        # 残高は種別行(金・プラチナ・銀・現金)の評価額合計
        self.assertEqual(meta["entries"], [
            {"date": "2026-06-30", "account": "sbi_metal", "balance": 16234,
             "note": "月次報告書評価額"}])
        self.assertNotIn("warnings", meta)

    def test_parse_trades(self):
        """約定明細ページ(3行/約定のレイアウト)→ 投資イベント。
        受渡金額から手数料+消費税を分離し、OrderReferの約定金額に揃える。"""
        _, meta = build.parse_sbi_metal_report(
            FX / "sbi_metal_report_sample.pdf")
        src = "tests/fixtures/sbi_metal_report_sample.pdf"
        self.assertEqual(meta["events"], [
            {"kind": "metal", "date": "2026-06-10", "name": "金", "code": "",
             "action": "買付 (スポット取引)", "deposit": "特定",
             "qty": 0.0625, "price": 16000.0, "fee": 10, "amount": 1000,
             "native_id": "11111111", "source": src},
            {"kind": "metal", "date": "2026-06-20", "name": "銀", "code": "",
             "action": "売却 (スポット取引)", "deposit": "特定",
             "qty": 2.5, "price": 400.0, "fee": 10, "amount": -1000,
             "native_id": "22222222", "source": src}])

    def test_annual_has_no_trades(self):
        """年次報告書の「お取引の総計」は年間集計なのでイベントを作らない。"""
        _, meta = build.parse_sbi_metal_report(
            FX / "sbi_metal_report_annual_sample.pdf")
        self.assertEqual(meta["events"], [])
        self.assertNotIn("warnings", meta)

    def test_parse_annual(self):
        """年次報告書(SJIS16進文字列・行内y揺れ・未保有「--」)も同じ枠で読む。"""
        self.assertEqual(
            build.sniff_format(FX / "sbi_metal_report_annual_sample.pdf"),
            "sbi_metal_report")
        txns, meta = build.parse_sbi_metal_report(
            FX / "sbi_metal_report_annual_sample.pdf")
        self.assertEqual(txns, [])
        # 金2,500 + 現金500(プラチナ・銀は「--」=未保有で0扱い)
        self.assertEqual(meta["entries"], [
            {"date": "2025-12-31", "account": "sbi_metal", "balance": 3000,
             "note": "年次報告書評価額"}])

    def test_other_pdf_is_skipped(self):
        """貴金属報告書以外のPDFは判別されず取込対象外(=スキップ扱い)。"""
        with tempfile.TemporaryDirectory(dir=build.ROOT) as td:
            p = Path(td) / "other.pdf"
            p.write_bytes(b"%PDF-1.4\nunrelated content\n%%EOF\n")
            self.assertIsNone(build.sniff_format(p))


class TestManualBalances(unittest.TestCase):
    def test_sniff(self):
        self.assertEqual(build.sniff_format(FX / "manual_balances_sample.csv"),
                         "manual_balances")

    def test_parse(self):
        txns, meta = build.parse_manual_balances(FX / "manual_balances_sample.csv")
        self.assertEqual(txns, [])
        self.assertEqual(meta["kind"], "balances")
        e = meta["entries"]
        self.assertEqual(len(e), 5)
        # 日付・口座順にソートされる
        self.assertEqual(e[0], {"date": "2026-04-30", "account": "cash",
                                "balance": 15000, "memo": ""})
        # スラッシュ日付も受ける
        smbc = [x for x in e if x["account"] == "smbc"][0]
        self.assertEqual(smbc["date"], "2026-07-10")
        # 負債は負の値で記入
        saison = [x for x in e if x["account"] == "saison"][0]
        self.assertEqual(saison["balance"], -4138)
        self.assertEqual(saison["memo"], "未払残")

    def test_latest_balances_merge(self):
        """手入力アンカーが残高列アンカーと共存し、口座ごと最新が残る。"""
        yucho, _ = build.parse_yucho_csv(FX / "yucho_sample.csv")
        _, meta = build.parse_manual_balances(FX / "manual_balances_sample.csv")
        anchors = build.latest_balances(yucho, None, meta["entries"])
        # ゆうちょは残高列由来(手入力に yucho 行はない)
        self.assertEqual(anchors["yucho"]["date"], "2026-06-25")
        self.assertNotIn("note", anchors["yucho"])
        # 現金は同一口座2点のうち新しい方
        self.assertEqual(anchors["cash"],
                         {"date": "2026-06-30", "balance": 12000, "note": "手入力"})
        self.assertEqual(anchors["saison"]["balance"], -4138)

    def test_balance_history(self):
        yucho, _ = build.parse_yucho_csv(FX / "yucho_sample.csv")
        _, meta = build.parse_manual_balances(FX / "manual_balances_sample.csv")
        hist = build.balance_history(yucho, None, meta["entries"])
        # ゆうちょは取引の残高列から時系列が生える
        self.assertEqual([p["balance"] for p in hist["yucho"]],
                         [103456, 99318, 123456])
        # 現金は手入力2点が古い順
        self.assertEqual([p["date"] for p in hist["cash"]],
                         ["2026-04-30", "2026-06-30"])

    def test_history_contrib_total_passthrough(self):
        """手入力の拠出累計(企業型DC等)は履歴点にも透過する(運用効率KPIが
        過去時点の評価損益 = 残高 − 拠出累計 を逆算するため)。無い点には
        キー自体を出さない。"""
        manual = [
            {"date": "2026-07-01", "account": "dc", "balance": 16002,
             "contrib_total": 16000},
            {"date": "2026-07-20", "account": "dc", "balance": 16167},
            {"date": "2026-08-01", "account": "dc", "balance": 24073,
             "contrib_total": 24000},
        ]
        hist = build.balance_history([], None, manual)
        pts = {p["date"]: p for p in hist["dc"]}
        self.assertEqual(pts["2026-07-01"]["contrib_total"], 16000)
        self.assertNotIn("contrib_total", pts["2026-07-20"])
        self.assertEqual(pts["2026-08-01"]["contrib_total"], 24000)

    def test_no_extrapolation_for_snapshot_accounts(self):
        """評価額スナップショットを持つ口座はフロー外挿しない。フロー再生は
        相場変動を含まず、実測の評価額と混ぜるとノコギリ状の偽の点ができる。"""
        def tx(date, amount):
            return build.Txn(account="sec", date=date, amount=amount,
                             description="入金", raw_description="入金",
                             source="t", type="transfer")
        txns = [tx("2026-01-20", 30000), tx("2026-02-20", 30000)]
        snaps = [{"account": "sec", "date": "2026-01-10", "total_value": 100000},
                 {"account": "sec", "date": "2026-03-10", "total_value": 180000}]
        hist = build.balance_history(txns, snaps, None)
        # 実測2点のみ。1月末・2月末の合成点は作られない
        self.assertEqual([p["date"] for p in hist["sec"]],
                         ["2026-01-10", "2026-03-10"])

    def test_extrapolated_dates_are_real_month_ends(self):
        """フロー外挿の月末は実在日(閏2月含む)。存在しない "-31" を出すと
        UI の日付パースで壊れる。"""
        def tx(date, amount):
            return build.Txn(account="x", date=date, amount=amount,
                             description="d", raw_description="d", source="t")
        txns = [tx("2024-01-15", -100), tx("2024-02-10", -50)]
        manual = [{"date": "2024-03-05", "account": "x", "balance": -1000}]
        hist = build.balance_history(txns, None, manual)
        dates = [p["date"] for p in hist["x"]]
        self.assertIn("2024-01-31", dates)
        self.assertIn("2024-02-29", dates)   # 2024年は閏年
        for d in dates:
            y, m, day = int(d[:4]), int(d[5:7]), int(d[8:10])
            self.assertLessEqual(day, calendar.monthrange(y, m)[1], d)

    def test_accrual_entries(self):
        """accrual 宣言から月末アンカーが累積で合成される(閏月末も暦通り)。"""
        accounts = {"loan": {"name": "架空ローン", "kind": "liability",
                             "accrual": {"start": "2023-11", "end": "2024-03",
                                         "monthly": -10000, "note": "貸与"}},
                    "cash": {"name": "現金", "kind": "asset"}}
        got = build.accrual_entries(accounts)
        self.assertEqual([(e["date"], e["balance"]) for e in got],
                         [("2023-11-30", -10000), ("2023-12-31", -20000),
                          ("2024-01-31", -30000), ("2024-02-29", -40000),
                          ("2024-03-31", -50000)])
        self.assertTrue(all(e["account"] == "loan" and e["note"] == "貸与"
                            for e in got))

    def test_accrual_multi_period(self):
        """複数期間は残高を引き継いで累積する(初回一括→間隔→月次)。"""
        accounts = {"loan": {"name": "架空ローン", "kind": "liability",
                             "accrual": [
                                 {"start": "2025-06", "end": "2025-06",
                                  "monthly": -352000},
                                 {"start": "2025-08", "end": "2025-09",
                                  "monthly": -88000}]}}
        got = build.accrual_entries(accounts)
        self.assertEqual([(e["date"], e["balance"]) for e in got],
                         [("2025-06-30", -352000), ("2025-08-31", -440000),
                          ("2025-09-30", -528000)])

    def test_accrual_manual_precedence(self):
        """同日に手入力残高があれば宣言合成より手入力が勝つ(安定ソート前提)。"""
        accounts = {"loan": {"name": "架空ローン", "kind": "liability",
                             "accrual": {"start": "2024-01", "end": "2024-02",
                                         "monthly": -10000}}}
        accrued = build.accrual_entries(accounts)
        manual = [{"date": "2024-02-29", "account": "loan",
                   "balance": -12345, "note": "手入力"}]
        merged = sorted(accrued + manual,
                        key=lambda e: (e["date"], e["account"]))
        anchors = build.latest_balances([], None, merged)
        self.assertEqual(anchors["loan"]["balance"], -12345)
        hist = build.balance_history([], None, merged)
        self.assertEqual([p["balance"] for p in hist["loan"]],
                         [-10000, -12345])


class TestCardBills(unittest.TestCase):
    """カード請求メタから引落予定と未払残アンカーを合成する。"""

    BILLS = [
        {"account": "saison", "pay_date": "2026-05-07",
         "bill_total": 1000, "source": "a.csv"},
        {"account": "saison", "pay_date": "2026-06-04",
         "bill_total": 2000, "source": "b.csv"},
    ]

    def test_debt_anchors_track_the_next_bill(self):
        """各月末の未払残 = その後で最初に到来する請求。請求切れの当日は0。"""
        got = build.card_debt_anchors(self.BILLS, date(2026, 6, 20))
        self.assertEqual([(e["date"], e["balance"]) for e in got],
                         [("2026-04-30", -1000),    # 5/7請求が未払
                          ("2026-05-31", -2000),    # 6/4請求が未払
                          ("2026-06-20", 0)])       # 次の請求は未取込
        self.assertTrue(all(e["account"] == "saison" for e in got))
        # 0円は「残高0」でなく「次の請求が未取込」なので注記で区別する
        self.assertEqual([e["note"] for e in got],
                         ["確定請求(未引落)", "確定請求(未引落)", "次回請求待ち"])

    def test_debt_anchors_empty_without_bills(self):
        self.assertEqual(build.card_debt_anchors([], date(2026, 6, 20)), [])

    def test_upcoming_lists_unwithdrawn_future_bills(self):
        """未来の未引落請求だけを出す。引落済み・過去分は出さない。"""
        today = date(2026, 5, 1)
        self.assertEqual(
            [(u["account"], u["date"], u["amount"])
             for u in build.upcoming_debits([], self.BILLS, today)],
            [("saison", "2026-05-07", 1000), ("saison", "2026-06-04", 2000)])
        # 5/7請求ぶんが引落済みなら残るのは6/4請求だけ
        paid = build.Txn(account="yucho", date="2026-05-07", amount=-1000,
                         description="自払 セゾン", raw_description="",
                         source="t", type="transfer", counter="saison")
        self.assertEqual(
            [u["date"] for u in build.upcoming_debits([paid], self.BILLS, today)],
            ["2026-06-04"])
        # 支払日を過ぎた請求は検証警告の領分なので引落予定には出さない
        self.assertEqual(build.upcoming_debits([], self.BILLS,
                                               date(2026, 6, 5)), [])

    def test_card_anchors_are_not_extrapolated(self):
        """カードは利用しか取引を持たないので、アンカーから逆再生してはいけない。"""
        txns = [build.Txn(account="saison", date="2026-04-10", amount=-500,
                          description="店", raw_description="", source="t"),
                build.Txn(account="saison", date="2026-05-10", amount=-700,
                          description="店", raw_description="", source="t")]
        anchors = [{"date": "2026-06-30", "account": "saison",
                    "balance": -2000, "note": "確定請求(未引落)"}]
        loose = build.balance_history(txns, None, anchors)
        self.assertGreater(len(loose["saison"]), 1)   # 外挿されてしまう
        strict = build.balance_history(txns, None, anchors,
                                       no_extrapolate={"saison"})
        self.assertEqual([(p["date"], p["balance"]) for p in strict["saison"]],
                         [("2026-06-30", -2000)])


class TestBalanceContinuity(unittest.TestCase):
    """残高列と取引額の積み上げの整合検証(OCR転記ミス・行欠落の検出)。"""

    def tx(self, date, amount, balance=None, acct="yucho"):
        return build.Txn(account=acct, date=date, amount=amount,
                         description="x", raw_description="x", source="t",
                         balance=balance)

    def test_consistent_series_is_silent(self):
        txns = [self.tx("2026-01-01", 1000, 1000),
                self.tx("2026-01-05", -300, 700),
                self.tx("2026-01-05", 100, 800)]   # 同日複数もOK
        self.assertEqual(build.verify_balance_continuity(txns), [])

    def test_gap_is_reported_once_without_cascade(self):
        txns = [self.tx("2026-01-01", 1000, 1000),
                self.tx("2026-01-05", -300, 480),   # 220円足りない(欠落行)
                self.tx("2026-01-10", -100, 380)]   # 以後は実残高に追従して静か
        notes = build.verify_balance_continuity(txns)
        self.assertEqual(len(notes), 1)
        self.assertIn("2026-01-05", notes[0])
        self.assertIn("-220", notes[0])

    def test_balanceless_rows_reset_the_anchor(self):
        # 残高列のないソースが混ざる日は検証不能として飛ばし、誤検知しない
        txns = [self.tx("2026-01-01", 1000, 1000),
                self.tx("2026-01-03", -9999, None),
                self.tx("2026-01-05", -300, 500),
                self.tx("2026-01-08", -100, 400)]
        self.assertEqual(build.verify_balance_continuity(txns), [])

    def test_accounts_without_balance_are_skipped(self):
        txns = [self.tx("2026-01-01", -500, None, acct="sbisec")]
        self.assertEqual(build.verify_balance_continuity(txns), [])

    def test_known_break_is_suppressed(self):
        """宣言した日のズレは警告しない。以後は従来どおり実残高に追従する。"""
        accounts = {"yucho": {"known_balance_breaks": [
            {"date": "2026-01-05", "note": "合算行と個別復元行の重複"}]}}
        txns = [self.tx("2026-01-01", 1000, 1000),
                self.tx("2026-01-05", -300, 480),   # 既知のズレ(-220)
                self.tx("2026-01-10", -100, 380)]   # 追従後は整合
        self.assertEqual(build.verify_balance_continuity(txns, accounts), [])
        # 宣言していない口座・日には効かない
        self.assertEqual(len(build.verify_balance_continuity(txns)), 1)

    def test_stale_known_break_is_reported(self):
        """ズレが出なくなった宣言は死に宣言として逆に警告する。"""
        accounts = {"yucho": {"known_balance_breaks": [
            {"date": "2026-01-05", "note": "解消済みのはず"}]}}
        txns = [self.tx("2026-01-01", 1000, 1000),
                self.tx("2026-01-05", -300, 700)]   # 整合している
        notes = build.verify_balance_continuity(txns, accounts)
        self.assertEqual(len(notes), 1)
        self.assertIn("known_balance_breaks", notes[0])
        self.assertIn("2026-01-05", notes[0])


class TestMergedPeriods(unittest.TestCase):
    """合算行に埋もれた引落は宣言で検証対象外にする(本物の漏れは残す)。"""

    ACCOUNTS = {"yucho": {"name": "ゆうちょ銀行", "merged_periods": [
        {"start": "2025-08-01", "end": "2025-12-31", "note": "合算"}]}}

    def bill(self, pay_date, total=100):
        return {"account": "saison", "pay_date": pay_date,
                "bill_total": total, "source": f"{pay_date}.csv"}

    def test_declaration_explains_only_bills_inside_the_period(self):
        periods = build.merged_periods(self.ACCOUNTS)
        self.assertEqual(periods[0]["account"], "yucho")
        notes, merged = build.verify_card_bills(
            [], [self.bill("2025-09-04"), self.bill("2026-02-04", 200)],
            date(2026, 7, 1), periods)
        self.assertEqual([b["pay_date"] for b in merged], ["2025-09-04"])
        # 期間外は警告のまま——宣言でノイズを消しても本物の漏れは潰さない
        self.assertEqual(len(notes), 1)
        self.assertIn("2026-02-04", notes[0])

    def test_debit_account_scopes_the_declaration(self):
        """宣言の口座とカードの引落口座(debit_account)を照合する。
        別口座引落のカードは合算期間に巻き込まれない。"""
        periods = build.merged_periods(self.ACCOUNTS)
        bills = [self.bill("2025-09-04")]
        # 引落口座が宣言と同じ yucho → 合算で説明がつく
        acc_same = {"saison": {"debit_account": "yucho"}}
        notes, merged = build.verify_card_bills([], bills, date(2026, 7, 1),
                                                periods, acc_same)
        self.assertEqual((len(notes), len(merged)), (0, 1))
        # 引落口座が別(smbc)→ 宣言は効かず警告のまま
        acc_diff = {"saison": {"debit_account": "smbc"}}
        notes, merged = build.verify_card_bills([], bills, date(2026, 7, 1),
                                                periods, acc_diff)
        self.assertEqual((len(notes), len(merged)), (1, 0))
        # debit_account 未宣言 → 従来どおり期間のみで照合
        notes, merged = build.verify_card_bills([], bills, date(2026, 7, 1),
                                                periods, {"saison": {}})
        self.assertEqual((len(notes), len(merged)), (0, 1))

    def test_single_table_declaration_is_accepted(self):
        """[[...]] の配列でなく単一テーブルで書かれていても読む(accrualと同様)。"""
        got = build.merged_periods({"yucho": {"merged_periods": {
            "start": "2025-08-01", "end": "2025-12-31"}}})
        self.assertEqual(len(got), 1)
        self.assertEqual(got[0]["end"], "2025-12-31")

    def test_withdrawn_bill_is_not_counted_as_merged(self):
        periods = [{"account": "yucho", "start": "2025-01-01",
                    "end": "2026-12-31", "note": ""}]
        paid = build.Txn(account="yucho", date="2025-09-04", amount=-100,
                         description="自払 セゾン", raw_description="",
                         source="t", type="transfer", counter="saison")
        notes, merged = build.verify_card_bills(
            [paid], [self.bill("2025-09-04")], date(2026, 7, 1), periods)
        self.assertEqual((notes, merged), ([], []))

    def test_without_declaration_everything_stays_a_warning(self):
        notes, merged = build.verify_card_bills(
            [], [self.bill("2025-09-04")], date(2026, 7, 1))
        self.assertEqual(len(notes), 1)
        self.assertEqual(merged, [])


class TestServeBackup(unittest.TestCase):
    """UI所有TOMLは丸ごと差し替えなので、直前版を .bak に残して復旧できること。"""

    def test_write_atomic_keeps_previous_version(self):
        import serve
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "overrides.toml"
            bak = Path(d) / "overrides.toml.bak"
            serve.Handler._write_atomic(p, b"first\n", backup=True)
            self.assertFalse(bak.exists())      # 初回は退避元がない
            serve.Handler._write_atomic(p, b"second\n", backup=True)
            self.assertEqual(p.read_bytes(), b"second\n")
            self.assertEqual(bak.read_bytes(), b"first\n")
            # backup=False(inbox等)は .bak を作らない
            serve.Handler._write_atomic(p, b"third\n")
            self.assertEqual(bak.read_bytes(), b"first\n")


class TestServeAuth(unittest.TestCase):
    """公開運用のBasic認証と、Hostヘッダ突合のクロスオリジン判定。

    非ローカルのアクセスは認証必須(未設定なら fail-closed)、同一マシンの
    直接アクセスは認証不要。テストから本物の非ローカル接続は作れないので、
    プロキシ経由を表す X-Forwarded-For で非ローカル扱いを再現する。
    実 data/ を触らないよう DATA_DIR を一時ディレクトリに差し替えた
    別サーバ(空きポート)で検証する。
    """

    @classmethod
    def setUpClass(cls):
        import threading
        from http.server import ThreadingHTTPServer

        import serve

        class Quiet(serve.Handler):
            def log_message(self, *args):    # テスト出力を汚さない
                pass

        cls._tmp = tempfile.TemporaryDirectory()
        cls._orig_data_dir = serve.DATA_DIR
        serve.DATA_DIR = Path(cls._tmp.name)
        cls.srv = ThreadingHTTPServer(("127.0.0.1", 0), Quiet)
        cls.srv.auth = "user:pw"
        cls.port = cls.srv.server_address[1]
        threading.Thread(target=cls.srv.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        import serve
        cls.srv.shutdown()
        cls.srv.server_close()
        serve.DATA_DIR = cls._orig_data_dir
        cls._tmp.cleanup()

    def _req(self, path, data=None, headers=None, auth="user:pw"):
        import base64
        import urllib.error
        import urllib.request
        h = dict(headers or {})
        if auth:
            h["Authorization"] = ("Basic "
                                  + base64.b64encode(auth.encode()).decode())
        req = urllib.request.Request(
            f"http://127.0.0.1:{self.port}{path}", data=data, headers=h)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, r.read()
        except urllib.error.HTTPError as e:
            with e:
                return e.code, e.read()

    XFF = {"X-Forwarded-For": "203.0.113.9"}   # プロキシ経由=非ローカルの印

    def test_local_direct_access_needs_no_auth(self):
        self.assertEqual(self._req("/api/ping", auth=None)[0], 200)

    def test_nonlocal_access_requires_auth(self):
        self.assertEqual(
            self._req("/api/ping", auth=None, headers=self.XFF)[0], 401)
        self.assertEqual(
            self._req("/api/ping", auth="user:wrong", headers=self.XFF)[0], 401)
        self.assertEqual(self._req("/api/ping", headers=self.XFF)[0], 200)

    def test_nonlocal_access_fails_closed_without_auth_config(self):
        self.srv.auth = None
        try:
            self.assertEqual(
                self._req("/api/ping", auth=None, headers=self.XFF)[0], 403)
        finally:
            self.srv.auth = "user:pw"

    def test_cross_origin_post_rejected(self):
        code, _ = self._req("/api/uistate", data=b"x = 1",
                            headers={"Origin": "https://evil.example"})
        self.assertEqual(code, 403)

    def test_origin_matching_host_header_accepted(self):
        # 逆プロキシ+独自ドメイン配下を模擬: Origin と Host の突合で許可
        code, _ = self._req("/api/uistate", data=b"x = 1",
                            headers={"Origin": "https://kakeibo.example",
                                     "Host": "kakeibo.example"})
        self.assertEqual(code, 200)
        self.assertEqual(
            (Path(self._tmp.name) / "uistate.toml").read_text("utf-8"),
            "x = 1")


class TestUncategorizedRanking(unittest.TestCase):
    def test_ranks_by_count_then_amount(self):
        """枝番を落として束ね、件数→金額の順に並べる。振替は対象外。"""
        def tx(desc, amount, typ="expense", cat="未分類", d="2026-01-01"):
            return build.Txn(account="paypay", date=d, amount=amount,
                             description=desc, raw_description=desc,
                             source="t", type=typ, category=cat)
        txns = [
            tx("支払い コンビニA - 1234", -100, d="2026-01-05"),
            tx("支払い コンビニA - 9999", -300, d="2026-03-05"),
            tx("店B", -5000),
            tx("分類済み", -900, cat="食費"),
            tx("振替行", -700, typ="transfer", cat="振替"),
        ]
        got = build.uncategorized_ranking(txns)
        self.assertEqual([(r["key"], r["count"], r["amount"]) for r in got],
                         [("コンビニA", 2, 400), ("店B", 1, 5000)])
        self.assertEqual(got[0]["last"], "2026-03-05")

    def test_top_limits_rows(self):
        txns = [build.Txn(account="paypay", date="2026-01-01", amount=-i,
                          description=f"店{i}", raw_description="", source="t",
                          type="expense", category="未分類")
                for i in range(1, 8)]
        self.assertEqual(len(build.uncategorized_ranking(txns, 3)), 3)


class TestPipeline(unittest.TestCase):
    """分類・振替・ペアリングの機構テスト。fixtures/rules_sample.toml を使い、
    実運用の data/rules.toml には依存しない(ルール編集でテストを壊さない・
    data/ の無い環境でも走る)。"""

    def _classified(self, batches):
        txns = build.dedup(batches)
        rules = build.load_rules(FX / "rules_sample.toml")
        build.classify(txns, rules)
        build.pair_transfers(txns)
        build.demote_unpaired_transfers(txns, rules)
        return txns

    def test_idempotent_reimport(self):
        """同じファイルを2回取り込んでも増殖しない。"""
        a, _ = build.parse_saison(FX / "saison_sample.csv")
        b, _ = build.parse_saison(FX / "saison_sample.csv")
        self.assertEqual(len(build.dedup([a, b])), len(build.dedup([a])))

    def test_transfer_classification_and_pairing(self):
        yucho, _ = build.parse_yucho_csv(FX / "yucho_sample.csv")
        paypay, _ = build.parse_paypay(FX / "paypay_sample.csv")
        txns = self._classified([yucho, paypay])
        # ゆうちょ→PayPayチャージが両側とも振替になりペアリングされる
        pp_charge = [t for t in txns if t.account == "paypay" and t.amount == 20000][0]
        yu_out = [t for t in txns if t.account == "yucho" and t.amount == -20000][0]
        self.assertEqual(pp_charge.type, "transfer")
        self.assertEqual(yu_out.type, "transfer")
        self.assertEqual(pp_charge.pair, yu_out.pair)
        self.assertNotEqual(pp_charge.pair, "")
        # セゾン引落は片側だけなので未ペアの振替
        seson = [t for t in txns if "セゾン" in t.description][0]
        self.assertEqual(seson.type, "transfer")
        self.assertEqual(seson.counter, "saison")
        self.assertEqual(seson.pair, "")

    def test_salary_transfer_since(self):
        """2026-04以降のゆうちょ「給与」は清算口座への振替、以前は収入。"""
        yucho, _ = build.parse_yucho_csv(FX / "yucho_sample.csv")
        old = build.Txn(account="yucho", date="2025-10-17", amount=50000,
                        description="給与", raw_description="給与",
                        source="tests")
        txns = self._classified([yucho, [old]])
        new_salary = [t for t in txns if t.description == "給与"
                      and t.date == "2026-06-25"][0]
        old_salary = [t for t in txns if t.date == "2025-10-17"][0]
        self.assertEqual(new_salary.type, "transfer")
        self.assertEqual(new_salary.counter, "kyuyo")
        self.assertEqual(old_salary.type, "income")
        self.assertEqual(old_salary.category, "給与")

    def test_pair_window_extension(self):
        """積立引落(yucho)→定時定額入金(sbisec)の7日ズレを pair_window で救う。"""
        a = build.Txn(account="yucho", date="2026-06-15", amount=-60000,
                      description="自払 AP(SBIシヨウケン",
                      raw_description="", source="tests")
        b = build.Txn(account="sbisec", date="2026-06-22", amount=60000,
                      description="定時定額買付金の入金",
                      raw_description="", source="tests")
        txns = self._classified([[a], [b]])
        self.assertTrue(all(t.type == "transfer" for t in txns))
        self.assertNotEqual(txns[0].pair, "")
        self.assertEqual(txns[0].pair, txns[1].pair)

    def test_suica_charge_rules(self):
        """セゾンのSFチャージはSuica側とペア成立時のみ振替(require_pair)。
        ペア不成立(定期券等・Suica明細のない期間)は支出に降格される。"""
        def sui(date, amount, desc):
            return build.Txn(account="suica", date=date, amount=amount,
                             description=desc, raw_description=desc,
                             source="tests")
        def sai(date, amount):
            return build.Txn(account="saison", date=date, amount=amount,
                             description="モバイルスイカ",
                             raw_description="モバイルスイカ",
                             source="tests", type="expense")
        suica_side = [
            sui("2026-01-14", 2000, "カード モバイル"),   # アプリ内チャージ受け
            sui("2026-02-01", 5000, "オート 新宿"),        # オートチャージ受け
            sui("2026-01-15", -230, "バス等 都営バス"),
            sui("2026-01-16", -561, "入 新宿 出 東京"),
            sui("2026-01-15", -110, "物販"),
        ]
        saison_side = [
            sai("2026-01-14", -2000),    # SFチャージ(suica側+2000と対応)
            sai("2026-01-20", -105010),  # 定期券(ペア不成立→支出に降格)
            sai("2025-12-01", -2000),    # Suica明細のない期間→支出に降格
        ]
        txns = self._classified([suica_side, saison_side])
        by = {(t.account, t.date, t.amount): t for t in txns}
        sai_charge = by[("saison", "2026-01-14", -2000)]
        sui_charge = by[("suica", "2026-01-14", 2000)]
        self.assertEqual(sai_charge.type, "transfer")
        self.assertEqual(sui_charge.type, "transfer")
        self.assertNotEqual(sai_charge.pair, "")
        self.assertEqual(sai_charge.pair, sui_charge.pair)
        self.assertEqual(by[("saison", "2026-01-20", -105010)].type, "expense")
        self.assertEqual(by[("saison", "2025-12-01", -2000)].type, "expense")
        # オートチャージはビューカードへの未ペア振替(収入に数えない)
        auto = by[("suica", "2026-02-01", 5000)]
        self.assertEqual(auto.type, "transfer")
        self.assertEqual(auto.counter, "viewcard")
        self.assertEqual(auto.pair, "")
        # 利用明細の分類
        self.assertEqual(by[("suica", "2026-01-15", -230)].category, "交通")
        self.assertEqual(by[("suica", "2026-01-16", -561)].category, "交通")
        self.assertEqual(by[("suica", "2026-01-15", -110)].category, "物販(Suica)")

    def test_adjustment_excluded_type(self):
        html, _ = build.parse_yucho_html(FX / "yucho_sample.html")
        txns = self._classified([html])
        gassan = [t for t in txns if "通帳未記入金合計" in t.description][0]
        self.assertEqual(gassan.type, "adjustment")


class TestOverrides(unittest.TestCase):
    def _txn(self, **kw):
        base = dict(account="a", date="2026-01-01", amount=-500,
                    description="X", raw_description="X", source="s",
                    type="expense", category="未分類")
        base.update(kw)
        return build.Txn(**base)

    def test_category_and_comment_applied(self):
        ts = [self._txn(id="aaa"),
              self._txn(id="bbb", category="外食", rule="ルールZ")]
        notes = build.apply_overrides(ts, [
            {"id": "aaa", "category": "書籍", "comment": "技術書"},
            {"id": "bbb", "comment": "打ち上げ"}])
        self.assertEqual(notes, [])
        self.assertEqual(ts[0].category, "書籍")
        self.assertEqual(ts[0].comment, "技術書")
        self.assertIn("手動上書き", ts[0].rule)
        # コメントだけの上書きは分類根拠を変えない
        self.assertEqual(ts[1].category, "外食")
        self.assertEqual(ts[1].comment, "打ち上げ")
        self.assertEqual(ts[1].rule, "ルールZ")

    def test_unknown_id_warns(self):
        notes = build.apply_overrides([self._txn(id="aaa")],
                                      [{"id": "zzz", "category": "外食"}])
        self.assertEqual(len(notes), 1)
        self.assertIn("zzz", notes[0])

    def test_comment_in_output_dict(self):
        t = self._txn(id="aaa", comment="手動コメント")
        self.assertEqual(build.txn_to_dict(t)["comment"], "手動コメント")
        # コメントなしならキー自体を出さない(data.js を太らせない)
        self.assertNotIn("comment", build.txn_to_dict(self._txn(id="bbb")))


class TestRecurring(unittest.TestCase):
    """[[recurring]] 宣言(サブスク)のタグ付与・メタ・突合検証。
    fixtures/rules_sample.toml の架空宣言を使う。"""

    def setUp(self):
        self.rules = build.load_rules(FX / "rules_sample.toml")

    def _txn(self, date, amount, desc, **kw):
        base = dict(account="saison", date=date, amount=amount,
                    description=desc, raw_description=desc, source="tests",
                    type="expense", category="未分類")
        base.update(kw)
        return build.Txn(**base)

    def test_tag_first_match_and_type_guard(self):
        rules = self.rules
        ts = [
            self._txn("2026-01-05", -990, "ネオフリックス"),
            self._txn("2026-02-05", -990, "NEOFLIX.COM"),
            self._txn("2026-03-05", -500, "スーパーフリックス"),
            self._txn("2026-01-06", -990, "ネオフリックス", type="transfer"),
            self._txn("2026-01-07", 990, "ネオフリックス", type="income"),
        ]
        build.tag_recurring(ts, rules)
        # 表記揺れの両方が同じ宣言に束なる。最初の一致が勝つ
        # (「ネオフリックス」は後段の '配信すべて' にも一致するが採らない)
        self.assertEqual(ts[0].recurring, "動画配信")
        self.assertEqual(ts[1].recurring, "動画配信")
        self.assertEqual(ts[2].recurring, "配信すべて")
        self.assertEqual(ts[3].recurring, "")   # 振替(カード引落等)は対象外
        self.assertEqual(ts[4].recurring, "")   # 収入は対象外

    def test_tag_after_demotion(self):
        """振替候補から支出に降格された明細もタグ対象になる(呼び出し順)。"""
        rules = self.rules
        sai = build.Txn(account="saison", date="2026-01-20", amount=-105010,
                        description="モバイルスイカ", raw_description="",
                        source="tests", type="expense")
        txns = build.dedup([[sai]])
        build.classify(txns, rules)
        build.pair_transfers(txns)
        build.demote_unpaired_transfers(txns, rules)
        build.tag_recurring(txns, rules)
        self.assertEqual(txns[0].type, "expense")
        self.assertEqual(txns[0].recurring, "定期券")

    def test_meta_cycle_monthly_and_declared(self):
        rules = self.rules
        ts = [self._txn(f"2026-0{m}-05", -990, "ネオフリックス")
              for m in range(1, 5)]
        build.tag_recurring(ts, rules)
        meta = {m["name"]: m for m in build.recurring_meta(ts, rules)}
        self.assertEqual(meta["動画配信"]["cycle"], "monthly")   # 間隔~31日
        self.assertIn("note", meta["動画配信"])                  # note は透過
        self.assertEqual(meta["年会費"]["cycle"], "yearly")      # 宣言優先(実績0でも)
        self.assertNotIn("note", meta["年会費"])

    def test_meta_kind_passthrough(self):
        """kind = "fixed"(固定費宣言)は meta に透過し、無い宣言には
        キー自体を出さない(UI側は kind 省略をサブスク扱いにする)。"""
        rules = self.rules
        ts = [self._txn(f"2026-0{m}-25", -40000, "架空仕送り")
              for m in range(1, 4)]
        build.tag_recurring(ts, rules)
        meta = {m["name"]: m for m in build.recurring_meta(ts, rules)}
        self.assertEqual(meta["架空仕送り"]["kind"], "fixed")
        self.assertNotIn("kind", meta["動画配信"])

    def test_meta_cycle_yearly_inferred(self):
        rules = self.rules
        ts = [self._txn("2024-06-01", -9800, "スーパーフリックス"),
              self._txn("2025-06-02", -9800, "スーパーフリックス"),
              self._txn("2026-06-01", -9800, "スーパーフリックス")]
        build.tag_recurring(ts, rules)
        meta = {m["name"]: m for m in build.recurring_meta(ts, rules)}
        self.assertEqual(meta["配信すべて"]["cycle"], "yearly")  # 間隔~365日

    def test_verify_dead_and_single_occurrence(self):
        rules = self.rules
        ts = [self._txn("2026-01-05", -990, "ネオフリックス")]
        build.tag_recurring(ts, rules)
        notes = "\n".join(build.verify_recurring(ts, rules))
        self.assertIn("'動画配信': 出現1件で周期を推定できない", notes)
        self.assertIn("'配信すべて': 一致する明細が0件", notes)
        # cycle 宣言があっても0件なら死に宣言として出す
        self.assertIn("'年会費': 一致する明細が0件", notes)

    def test_verify_quiet_when_healthy(self):
        rules = self.rules
        ts = ([self._txn(f"2026-0{m}-05", -990, "ネオフリックス")
               for m in range(1, 4)]
              + [self._txn("2026-02-01", -500, "スーパーフリックス"),
                 self._txn("2026-03-01", -500, "スーパーフリックス"),
                 self._txn("2026-04-01", -105010, "モバイルスイカ"),
                 self._txn("2026-05-10", -10000, "架空年会費")])
        build.tag_recurring(ts, rules)
        notes = "\n".join(build.verify_recurring(ts, rules))
        self.assertNotIn("動画配信", notes)
        self.assertNotIn("配信すべて", notes)
        # 出現1件でも cycle 宣言があれば警告しない
        self.assertNotIn("年会費", notes)
        # 出現1件・宣言なしの '定期券' だけが警告される
        self.assertIn("'定期券': 出現1件で周期を推定できない", notes)

    def test_recurring_in_output_dict(self):
        t = self._txn("2026-01-05", -990, "ネオフリックス",
                      id="aaa", recurring="動画配信")
        self.assertEqual(build.txn_to_dict(t)["recurring"], "動画配信")
        # タグなしならキー自体を出さない(data.js を太らせない)
        self.assertNotIn("recurring",
                         build.txn_to_dict(self._txn("2026-01-05", -990, "x")))


class TestDataJsExport(unittest.TestCase):
    """write_data_js の新規 export(card_bills 等)を一時出力先で検証。"""

    def _run(self, **kw):
        import json
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        site = Path(tmp.name)
        for name, val in (("SITE_DIR", site), ("DATA_JS", site / "data.js")):
            orig = getattr(build, name)
            setattr(build, name, val)
            self.addCleanup(lambda n=name, o=orig: setattr(build, n, o))
        args = dict(txns=[], accounts={}, freshness=[], balances={},
                    history={}, invest=[], snapshots=[], catgroups={},
                    overrides=[], uistate={})
        args.update(kw)
        build.write_data_js(**args)
        text = (site / "data.js").read_text(encoding="utf-8")
        self.assertTrue(text.startswith("const DATA = "))
        return json.loads(text[len("const DATA = "):].rstrip().rstrip(";"))

    def test_card_bills_exported_sorted_and_trimmed(self):
        bills = [
            {"account": "saison", "pay_date": "2026-08-04", "bill_total": 12000,
             "source": "raw/x.html", "extra": "捨てられる"},
            {"account": "viewcard", "pay_date": "2026-07-26", "bill_total": 3400},
            {"account": "saison", "pay_date": "", "bill_total": 999},  # 支払日なしは除外
        ]
        data = self._run(bills=bills)
        cb = data["card_bills"]
        self.assertEqual([b["pay_date"] for b in cb],
                         ["2026-07-26", "2026-08-04"])  # 支払日順・欠損は除外
        # 必要キーだけに絞る(source/extra は落とす)
        self.assertEqual(set(cb[0]), {"account", "pay_date", "bill_total"})

    def test_card_bills_absent_when_no_bills(self):
        data = self._run()
        self.assertEqual(data["card_bills"], [])

    def test_accrual_not_exported(self):
        # accrual 宣言は accrual_entries が残高アンカーに変換済みで、
        # data.js の accounts には出さない(JS側に読み手がいない)
        accounts = {
            "loan": {"name": "借入", "kind": "liability", "accrual": [
                {"start": "2025-08", "end": "2026-03", "monthly": -88000,
                 "note": "実行"}]},
        }
        data = self._run(accounts=accounts)
        self.assertNotIn("accrual", data["accounts"]["loan"])

    def test_recurring_exported_and_defaults_empty(self):
        self.assertEqual(self._run()["recurring"], [])
        r = [{"name": "動画配信", "cycle": "monthly", "note": "架空"}]
        self.assertEqual(self._run(recurring=r)["recurring"], r)

    def test_transactions_compressed_with_string_table(self):
        """source/rule は文字列テーブル参照、同一の raw_description は省略。
        core.js 先頭の展開と対になる圧縮形式(ledger/*.jsonl は非圧縮)。"""
        def tx(desc, raw, rule):
            return build.Txn(account="x", date="2026-01-05", amount=-100,
                             description=desc, raw_description=raw,
                             source="raw/x/a.csv", type="expense",
                             category="c", rule=rule, id="i" + desc)
        data = self._run(txns=[tx("カフェ", "カフェ", "ルールA"),
                               tx("パン", "ﾊﾟﾝ", "ルールA")])
        st = data["string_table"]
        t0, t1 = data["transactions"]
        self.assertEqual(st[t0["source"]], "raw/x/a.csv")
        self.assertEqual(st[t0["rule"]], "ルールA")
        self.assertEqual(t0["rule"], t1["rule"])       # 同一文字列は同一index
        self.assertNotIn("raw_description", t0)        # 同一なら省略
        self.assertEqual(t1["raw_description"], "ﾊﾟﾝ")  # 異なれば残す


class TestLatestBalanceExtrapolation(unittest.TestCase):
    """残高列のない口座はアンカー以後の取引で現在残高に追従する(前方外挿)。"""

    @staticmethod
    def tx(date, amount, account="wallet", balance=None):
        return build.Txn(account=account, date=date, amount=amount,
                         description="d", raw_description="d", source="t",
                         balance=balance)

    def test_forward_extrapolation(self):
        txns = [self.tx("2026-01-05", -100), self.tx("2026-01-20", 300),
                self.tx("2026-01-25", -50)]
        manual = [{"date": "2026-01-10", "account": "wallet",
                   "balance": 1000, "note": "手入力"}]
        anchors = build.latest_balances(txns, None, manual)
        # アンカー(01-10)以前の取引は無視、以後の +300-50 だけ積む
        self.assertEqual(anchors["wallet"],
                         {"date": "2026-01-25", "balance": 1250,
                          "note": "手入力+以後の取引"})

    def test_no_transactions_after_anchor(self):
        txns = [self.tx("2026-01-05", -100)]
        manual = [{"date": "2026-01-10", "account": "wallet",
                   "balance": 1000, "note": "手入力"}]
        anchors = build.latest_balances(txns, None, manual)
        self.assertEqual(anchors["wallet"],
                         {"date": "2026-01-10", "balance": 1000,
                          "note": "手入力"})

    def test_no_extrapolate_excludes_cards(self):
        # カードは取引(利用)を積んでも残高にならない(引落は相手口座側)
        txns = [self.tx("2026-01-20", -300, account="card")]
        manual = [{"date": "2026-01-10", "account": "card", "balance": -1000}]
        anchors = build.latest_balances(txns, None, manual,
                                        no_extrapolate={"card"})
        self.assertEqual(anchors["card"]["balance"], -1000)
        self.assertEqual(anchors["card"]["date"], "2026-01-10")

    def test_balance_column_account_not_extrapolated(self):
        # 残高列を持つ口座は列の値が正(取引積み上げで上書きしない)
        txns = [self.tx("2026-01-05", -100, balance=900),
                self.tx("2026-01-20", 300, balance=1200)]
        anchors = build.latest_balances(txns, None, [])
        self.assertEqual(anchors["wallet"]["balance"], 1200)
        self.assertNotIn("note", anchors["wallet"])


class TestCheckReports(unittest.TestCase):
    """--check の点検レポート(死にルール・アンカー無し口座)。"""

    def test_rule_usage_report(self):
        import re as _re
        rules = {"rule": [
            {"pattern": "カフェ", "category": "外食", "_re": _re.compile("カフェ")},
            {"pattern": "ジム", "category": "健康", "_re": _re.compile("ジム"),
             "note": "降格時の安全網"},
        ]}
        t = build.Txn(account="x", date="2026-01-05", amount=-500,
                      description="カフェ ラテ", raw_description="カフェ ラテ",
                      source="t")
        build.classify([t], rules)
        report = build.rule_usage_report(rules)
        self.assertEqual(len(report), 1)
        self.assertIn("ジム", report[0])
        self.assertIn("note: 降格時の安全網", report[0])

    def test_missing_anchor_accounts(self):
        accounts = {
            "wallet": {"name": "ワレット", "kind": "asset",
                       "group": "決済・電子マネー"},
            "kyuyo": {"name": "給与清算", "kind": "asset", "group": "給与"},
            "sbi_metal": {"name": "貴金属", "kind": "asset", "group": "証券"},
        }
        txns = [build.Txn(account=a, date="2026-01-05", amount=-100,
                          description="d", raw_description="d", source="t")
                for a in ("wallet", "kyuyo")]
        invest = [{"kind": "metal", "date": "2026-03-09"}]
        notes = build.missing_anchor_accounts(txns, invest, {}, accounts)
        # 給与グループは除外、wallet と(約定由来の)sbi_metal が出る
        self.assertEqual(len(notes), 2)
        self.assertTrue(any("wallet" in n for n in notes))
        self.assertTrue(any("sbi_metal" in n for n in notes))
        # アンカーがあれば出ない
        notes = build.missing_anchor_accounts(
            txns, invest, {"wallet": {}, "sbi_metal": {}}, accounts)
        self.assertEqual(notes, [])


class TestMissingDataDir(unittest.TestCase):
    """data/ が無いクローン(公開版)では素の build を明示エラーで止める。"""

    def test_main_reports_missing_accounts_toml(self):
        orig, err = build.DATA_DIR, io.StringIO()
        build.DATA_DIR = Path(tempfile.gettempdir()) / "kakeibo-no-such-dir"
        try:
            with contextlib.redirect_stderr(err):
                rc = build.main([])
        finally:
            build.DATA_DIR = orig
        self.assertEqual(rc, 2)
        self.assertIn("accounts.toml", err.getvalue())
        self.assertIn("demo/build_demo.py", err.getvalue())


class TestBuildLog(unittest.TestCase):
    """ビルド実行ログ(追記専用・無変化ビルドはrepeat行に畳む)。"""

    def setUp(self):
        self.td = tempfile.TemporaryDirectory()
        self.addCleanup(self.td.cleanup)
        self.path = Path(self.td.name) / "build_log.jsonl"

    def entry(self, n):
        return {"ok": True, "lines": [{"k": "info", "t": f"取込: {n}件"}]}

    def ts(self, i):
        return datetime(2026, 8, 1, 12, 0, i)

    def test_identical_builds_collapse_into_repeat_rows(self):
        r1 = build.append_build_log(self.entry(5), self.path, self.ts(0))
        r2 = build.append_build_log(self.entry(5), self.path, self.ts(1))
        r3 = build.append_build_log(self.entry(6), self.path, self.ts(2))
        self.assertNotIn("repeat", r1)
        self.assertEqual(r2, {"ts": "2026-08-01 12:00:01", "repeat": True})
        self.assertEqual(r3["lines"][0]["t"], "取込: 6件")   # 変化で本文復帰
        self.assertEqual(len(self.path.read_text().splitlines()), 3)

    def test_repeat_compares_to_last_body_not_last_row(self):
        # 本文→repeat→同内容 でも repeat になる(比較対象は直前の本文)
        build.append_build_log(self.entry(5), self.path, self.ts(0))
        build.append_build_log(self.entry(5), self.path, self.ts(1))
        r = build.append_build_log(self.entry(5), self.path, self.ts(2))
        self.assertTrue(r.get("repeat"))

    def test_failure_entry_is_recorded(self):
        r = build.append_build_log({"ok": False, "error": "Traceback..."},
                                   self.path, self.ts(0))
        self.assertFalse(r["ok"])
        self.assertIn("error", r)

    def test_tail_prepends_body_for_leading_repeat(self):
        build.append_build_log(self.entry(5), self.path, self.ts(0))
        for i in range(1, 4):
            build.append_build_log(self.entry(5), self.path, self.ts(i))
        # 末尾2件だけ切ると先頭がrepeatになる→参照先の本文を1件足して返す
        tail = build.build_log_tail(2, self.path)
        self.assertEqual(len(tail), 3)
        self.assertEqual(tail[0]["lines"][0]["t"], "取込: 5件")
        self.assertTrue(all(r.get("repeat") for r in tail[1:]))

    def test_tail_of_missing_file_is_empty(self):
        self.assertEqual(build.build_log_tail(10, self.path), [])


if __name__ == "__main__":
    unittest.main()
