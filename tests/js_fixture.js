"use strict";
// JSロジックテストのフィクスチャとエンジン差の吸収(1/2)。
// 読み込み順: js_fixture.js → site/js/core.js → stats.js → schedule.js →
// js_harness.js。順序どおりに評価するのはエンジン側の仕事:
//   jsc(macOS同梱 / Linuxは libjavascriptcoregtk の CLI)
//     … test_js.py がファイル列を引数で渡す
//   node(あれば使う。必須ではない)
//     … test_js.py のラッパが vm.runInThisContext で順に評価
//   ブラウザ(Windows標準のEdge等の headless)
//     … tests/js_harness.html の script タグ順
// このファイルは「無いものだけを補う」。ブラウザでは本物の window/document
// をそのまま使う(素のページなので querySelector は null を返し、core.js の
// トップレベルはそれで動く)。
if (typeof window === "undefined") {
  globalThis.window = globalThis;
}
if (typeof document === "undefined") {
  // DOMの無いシェル用の最小スタブ(core.js のトップレベルが触る分だけ)
  globalThis.document = { querySelector: function () { return null; },
                          addEventListener: function () {} };
}

// ---- フィクスチャ(架空データ。tests/fixtures と同じ流儀) ----
// curMonth=2026-08 になるよう当月の明細を含める。
var DATA = (function () {
  const txns = [];
  let seq = 0;
  const tx = (o) => txns.push(Object.assign({
    id: "t" + (++seq), account: "bank", type: "expense", category: "食費",
    description: "スーパーカケイボ", raw_description: "スーパーカケイボ",
    source: "raw/test", amount: -1000,
  }, o));
  // 食費: 2025-09〜2026-07 に毎月1万(ベースラインの実績)
  for (const m of ["2025-09", "2025-10", "2025-11", "2025-12", "2026-01",
                   "2026-02", "2026-03", "2026-04", "2026-05", "2026-06",
                   "2026-07"]) {
    tx({ date: m + "-15", amount: -10000 });
  }
  // 当月(2026-08)の食費と散発の現金引出(完了月でないので
  // ベースラインの母数には入らない)
  tx({ date: "2026-08-11", amount: -30000 });
  tx({ date: "2026-03-20", amount: -8000, category: "現金引出",
       description: "カード イーネットATM" });
  tx({ date: "2026-08-05", amount: -9000, category: "現金引出",
       description: "カード イーネットATM" });
  // サブスク(宣言タグ付き): 毎月10日に500円
  for (const m of ["2026-05", "2026-06", "2026-07"]) {
    tx({ date: m + "-10", amount: -500, category: "サブスク",
         description: "NETFLIX.COM", recurring: "動画配信" });
  }
  // 給与振込: kyuyo(給与グループ)→ bank への振替(毎月25日に30万)
  for (const m of ["2026-05", "2026-06", "2026-07"]) {
    tx({ date: m + "-25", amount: 300000, type: "transfer", counter: "kyuyo",
         category: "振替", description: "給与" });
  }
  // カード引落: bank → card(確定請求と同額・同日)
  tx({ date: "2026-06-04", amount: -40000, type: "transfer", counter: "card",
       category: "振替", description: "自払 カード" });
  tx({ date: "2026-07-04", amount: -50000, type: "transfer", counter: "card",
       category: "振替", description: "自払 カード" });
  tx({ date: "2026-08-04", amount: -60000, type: "transfer", counter: "card",
       category: "振替", description: "自払 カード" });
  // 電子マネーへのチャージ: 毎月1万だが日がバラバラ(残高駆動)。
  // 定期振替としては検出されず、ベースラインの日割りに残る
  for (const [m, d] of [["2026-05", "08"], ["2026-06", "20"],
                        ["2026-07", "28"]]) {
    tx({ date: m + "-" + d, amount: -10000, type: "transfer",
         counter: "wallet", category: "振替", description: "チャージ" });
  }
  // 証券積立の自動引落: 毎月14日・月1回・途中で3万→6万に増額。
  // 日が安定しているので定期振替として検出され、引落日に点で投影される
  for (const [m, a] of [["2026-04", 30000], ["2026-05", 30000],
                        ["2026-06", 60000], ["2026-07", 60000]]) {
    tx({ date: m + "-14", amount: -a, type: "transfer", counter: "sec",
         category: "振替", description: "自払 ツミタテ" });
  }
  // 銀行間の資金移動(ベースラインから除外されることの検証)
  tx({ date: "2026-06-20", amount: -70000, type: "transfer", counter: "bank2",
       category: "振替", description: "振込 ジブン" });
  // 給与(総支給)と法定控除: kyuyo(清算口座)上で計上。控除は固定費宣言
  // (kind=fixed)のタグ付き=固定費集計に入り、資金繰りには投影されない
  for (const m of ["2026-05", "2026-06", "2026-07"]) {
    tx({ date: m + "-25", amount: 320000, type: "income", account: "kyuyo",
         category: "給与(総支給)", description: "基本給" });
    tx({ date: m + "-25", amount: -20000, account: "kyuyo",
         category: "社会保険料", description: "厚生年金保険料",
         recurring: "厚生年金保険料" });
  }
  // 実家仕送り(銀行からの固定費)。宣言タグ付き=ベースラインから除外され、
  // 資金繰りには個別投影される
  for (const m of ["2026-05", "2026-06", "2026-07"]) {
    tx({ date: m + "-15", amount: -40000, category: "仕送り",
         description: "送った金額 ケンイチ", recurring: "実家仕送り" });
  }
  // 貴金属様の残差対象口座への資金振替(外側の記録のみ。metal は自前の
  // 振替明細を持たない=外側で補完されることの検証用)
  tx({ date: "2026-05-20", amount: -10000, type: "transfer", counter: "metal",
       category: "振替", description: "貴金属口座へ振替" });
  // 利息・配当(運用効率の分子)。sec はポートフォリオ口座(評価ベース)なので
  // 配当も明細で数える。残差対象口座(metal)上の利息・配当があれば除かれる
  tx({ date: "2026-07-01", amount: 300, type: "income", category: "利息",
       description: "利息" });
  tx({ date: "2026-07-05", amount: 500, type: "income", account: "sec",
       category: "配当金", description: "配当金" });
  // 証券への初期入金(積立開始前・6ヶ月窓の外)。全期間の運用効率だけが
  // 流入として数えることの検証用
  tx({ date: "2026-01-10", amount: -100000, type: "transfer", counter: "sec",
       category: "振替", description: "即時入金" });
  return {
    accounts: {
      bank: { name: "架空銀行", kind: "asset", group: "銀行" },
      bank2: { name: "架空銀行2", kind: "asset", group: "銀行" },
      card: { name: "架空カード", kind: "liability",
              group: "クレジットカード" },
      wallet: { name: "架空ペイ", kind: "asset", group: "決済・電子マネー" },
      sec: { name: "架空証券", kind: "asset", group: "証券" },
      metal: { name: "架空貴金属", kind: "asset", group: "証券" },
      unsettled: { name: "未受渡の調整", kind: "asset", group: "証券",
                   synthetic: true },
      kyuyo: { name: "架空給与(清算)", kind: "asset", group: "給与" },
      dc: { name: "架空DC", kind: "asset", group: "年金" },
    },
    balances: {},
    // 運用効率(yieldStats)の検証用。sec はポートフォリオ口座
    // (invest.portfolio.account)なので評価ベース(value_history−累積元本)、
    // metal は残差対象(Δ残高−純流入。流入は銀行側の記録で補完)
    balance_history: {
      bank: [{ date: "2025-11-30", balance: 500000 },
             { date: "2026-02-28", balance: 500000 },
             { date: "2026-08-10", balance: 500000 }],
      sec: [{ date: "2026-02-28", balance: 100000 },
            { date: "2026-08-10", balance: 300000 }],
      metal: [{ date: "2026-05-31", balance: 10000 },
              { date: "2026-08-05", balance: 12500 }],
      // 7月末をまたぐ未受渡。証券グループを減らすが運用益には入らない
      unsettled: [{ date: "2026-07-30", balance: -30000 },
                  { date: "2026-08-03", balance: 0 }],
      dc: [{ date: "2026-06-30", balance: 50000, contrib_total: 50000 },
           { date: "2026-08-05", balance: 53000, contrib_total: 51000 }],
    },
    freshness: [], upcoming: [],
    invest: {
      // sec の評価損益系列: 累積元本は 02-15 に10万・05-15 に+10万。
      // 実測点 02-28(評価10万= pl 0)と 08-10(評価22万= pl +2万)
      portfolio: { account: "sec" },
      events: [
        { date: "2026-02-15", name: "架空投信", action: "買付",
          amount: 100000, fee: 0 },
        { date: "2026-05-15", name: "架空投信", action: "買付",
          amount: 100000, fee: 0 },
      ],
      value_history: [{ date: "2026-02-28", value: 100000 },
                      { date: "2026-08-10", value: 220000 }],
      pl_history: [],
    },
    category_groups: { "食費": ["食費"], "現金・送金": ["現金引出"],
                       "サブスク": ["サブスク"] },
    recurring: [
      { name: "動画配信", cycle: "monthly" },
      { name: "実家仕送り", cycle: "monthly", kind: "fixed" },
      { name: "厚生年金保険料", cycle: "monthly", kind: "fixed" },
    ],
    card_bills: [
      { account: "card", pay_date: "2026-06-04", bill_total: 40000 },
      { account: "card", pay_date: "2026-07-04", bill_total: 50000 },
      { account: "card", pay_date: "2026-08-04", bill_total: 60000 },
    ],
    overrides: [], uistate: {},
    transactions: txns,
  };
})();

