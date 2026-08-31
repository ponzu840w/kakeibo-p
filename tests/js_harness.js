"use strict";
// JSロジックのテストハーネス本体(2/2)。js_fixture.js と site/js/ の
// 対象ファイルが先に評価されている前提で、計算結果を1つのJSONにして
// print() する(print はエンジン側が用意: jsc=組込み / node=ラッパ注入 /
// ブラウザ=js_harness.html が DOM 書き出し版を定義)。
// 期待値の assert は Python 側(tests/test_js.py)が行う
// (失敗診断を unittest に揃えるため)。検証対象は DOM を使わない
// 純関数だけで、描画は headless ブラウザのスクリーンショット確認が受け持つ。

// ---- 計算結果の収集 ----
const KB = window.KB;
const TODAY = "2026-08-11";
const out = {};

out.stats = {
  median_even: KB.median([1, 2, 3, 4]),
  median_odd: KB.median([5, 1, 9]),
  mad: KB.mad([1, 1, 1, 9]),
  quantile_half: KB.quantile([0, 10], 0.5),
  xirr: KB.xirr([{ date: "2025-01-01", amount: -100 },
                 { date: "2026-01-01", amount: 110 }]),
  modeOf: KB.modeOf(new Map([["a", 2], ["b", 5], ["c", 1]])),
};

out.curMonth = KB.curMonth;

const det = KB.detectRecurring(KB.TXNS, "expense");
out.detectRecurring = det.map((s) => ({
  name: s.name, median: s.median, months: s.months, day: s.day,
  account: s.account,
}));
out.detectMemoized = KB.detectRecurring(KB.TXNS, "expense") === det;

out.declaredSubs = KB.declaredSubs().map((s) => ({
  name: s.name, monthly: s.monthly, day: s.day, active: s.active,
  account: s.account, months: s.months, kind: s.kind,
}));

// 概要サマリの計算(stats.js)
out.recurringPaidJul = KB.recurringPaidByMonth().get("2026-07") || 0;
out.provisionalNet = KB.provisionalNet();
// 手取りモード: 法定控除が収入側に折り込まれ、固定費宣言からは除外される
KB.state.incomeMode = "net";
out.provisionalNetNet = KB.provisionalNet();
KB.state.incomeMode = "gross";
out.yieldStats = KB.yieldStats(6);
out.yieldStatsAll = KB.yieldStats();   // 省略時は残高履歴のある全期間
out.yieldMonthly = KB.yieldMonthly();

const sal = KB.estimateSalary(TODAY);
out.estimateSalary = sal && { amount: sal.amount, day: sal.day,
                              account: sal.account, count: sal.count };

out.recurringTransfers = KB.detectRecurringTransfers().map((s) => ({
  name: s.name, counter: s.counter, account: s.account, amount: s.amount,
  day: s.day, months: s.months, active: s.active,
}));

out.baseline = KB.baselineOutflow();

const fe = KB.futureEvents({ today: TODAY, horizonMonths: 3 });
const byKind = {};
for (const e of fe.events) {
  const k = byKind[e.kind] || (byKind[e.kind] = { count: 0, total: 0,
                                                  first: e.date });
  k.count += 1;
  k.total += e.amount;
}
out.futureEvents = byKind;

// ビルドログの表示整形: repeat畳み込みと前回比の警告差分(新しい順になる)
out.buildLogView = KB.buildLogView([
  { ts: "2026-08-01 10:00:00", ok: true,
    lines: [{ k: "info", t: "取込: 5件" }, { k: "verify", t: "検証: A" }] },
  { ts: "2026-08-02 10:00:00", repeat: true },
  { ts: "2026-08-03 10:00:00", ok: true,
    lines: [{ k: "info", t: "取込: 6件" }, { k: "verify", t: "検証: B" },
            { k: "skip", t: "スキップ: x" }] },
  { ts: "2026-08-04 10:00:00", ok: false, error: "Traceback..." },
]).map((g) => ({ ts: g.ts, tsLast: g.tsLast, count: g.count, ok: g.ok,
                 added: g.added, removed: g.removed }));

print(JSON.stringify(out));
