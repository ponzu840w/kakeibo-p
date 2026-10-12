"use strict";
// stats.js: 汎用の統計ユーティリティ(中央値・MAD・分位点・IRR)。
// 異常検知・投資リターン・長期投影で共通に使う決定論的な計算のみを置く。
(function () {
  const KB = window.KB;

  function median(arr) {
    if (!arr || !arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const n = s.length;
    return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
  }

  // 線形補間による分位点(q=0〜1)
  function quantile(arr, q) {
    if (!arr || !arr.length) return null;
    const s = [...arr].sort((a, b) => a - b);
    const pos = (s.length - 1) * q;
    const lo = Math.floor(pos), hi = Math.ceil(pos);
    if (lo === hi) return s[lo];
    return s[lo] + (s[hi] - s[lo]) * (pos - lo);
  }

  // 中央絶対偏差(MAD)。正規分布換算(×1.4826)はせず生の値を返す
  // (呼び出し側で「中央値±MAD」とそのまま表記する運用に合わせる)
  function mad(arr) {
    if (!arr || !arr.length) return 0;
    const m = median(arr);
    return median(arr.map((v) => Math.abs(v - m)));
  }

  // 金額加重リターン(XIRR)。flows=[{date:"YYYY-MM-DD", amount}]
  // (支出=負、受取=正)。ニュートン法(初期値5%・20回)で解けなければ
  // [-0.95, 10] の二分法にフォールバック。符号が全同一(投資も回収もない)
  // 場合は null。
  // 検算例: 2025-01-01に-100、2026-01-01に+110 → r=10%
  //   f(r) = -100 + 110/(1+r) = 0 → 1+r = 1.1 → r = 0.1 (xirrは0.1を返す)
  function xirr(flows) {
    if (!flows || flows.length < 2) return null;
    const t0 = new Date(flows[0].date).getTime();
    const pts = flows.map((f) => ({
      t: (new Date(f.date).getTime() - t0) / 86400000 / 365,
      amount: f.amount,
    }));
    if (pts.every((p) => p.amount >= 0) || pts.every((p) => p.amount <= 0)) {
      return null;
    }
    const f = (r) => pts.reduce((s, p) => s + p.amount / Math.pow(1 + r, p.t), 0);
    const df = (r) => pts.reduce(
      (s, p) => s - p.t * p.amount / Math.pow(1 + r, p.t + 1), 0);
    let r = 0.05;
    for (let i = 0; i < 20; i++) {
      const d = df(r);
      if (!Number.isFinite(d) || Math.abs(d) < 1e-9) break;
      const next = r - f(r) / d;
      if (!Number.isFinite(next) || next <= -0.999) break;
      if (Math.abs(next - r) < 1e-7) return next;
      r = next;
    }
    // 二分法フォールバック
    let lo = -0.95, hi = 10;
    let flo = f(lo), fhi = f(hi);
    if (!Number.isFinite(flo) || !Number.isFinite(fhi) || flo * fhi > 0) {
      return null;
    }
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2;
      const fm = f(mid);
      if (Math.abs(fm) < 1e-6) return mid;
      if ((fm > 0) === (flo > 0)) { lo = mid; flo = fm; } else { hi = mid; }
    }
    return (lo + hi) / 2;
  }

  // 値が最大のキー(出現回数Mapなら最頻キー)。同数は挿入順で先の方
  // (安定ソート)。空のMapには使えない(呼び出し側が非空を保証する)
  function modeOf(counts) {
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  }

  // 概要サマリ用の集計。
  // 固定費 =[[recurring]] 宣言(サブスク+kind=fixed)にタグの付いた支出、
  // 変動費 = それ以外の支出、の2分割を前提にする。
  // declaredSubs は schedule.js(後読み)なので KB 経由で呼ぶ。

  // 月ごとの「宣言定期支出として支払われた額」(正値)。
  // 変動費 = monthlyTotals().exp − これ。
  function recurringPaidByMonth() {
    const { TXNS, effective } = KB;
    const out = new Map();
    for (const t of TXNS) {
      if (!t.recurring) continue;
      const e = effective(t);
      if (e.type !== "expense") continue;
      const m = t.date.slice(0, 7);
      out.set(m, (out.get(m) || 0) - e.amount);
    }
    return out;
  }

  // 当月暫定収支: 収入予定 − 固定費(宣言・現役) − max(判明変動費, 平常ペース)。
  // 判明分だけを引くと、カード利用分が請求確定まで届かない構造のせいで
  // 月の前半ずっと楽観的な数字が出続ける。変動費に平常ペース(完了6ヶ月平均)
  // の下限を設け、実績が平常を超えたときだけ悪化させることで
  // 「数字が動いた=異常」と読めるようにする。
  // 収入予定は完了3ヶ月の中央値(総支給ベース。給与は即日判明するので
  // 先月も使う)。判明収入が上回る月(賞与等)は判明を使う。
  // 平常変動費の窓は当月・先月を除く(先月はカード請求待ちで支出が
  // まだ過小=平常ペースが下振れするため。貯蓄率の窓と同じ理屈)。
  function provisionalNet() {
    const { TXNS, months, curMonth, monthlyTotals, shiftMonth,
            ACCOUNTS, state } = KB;
    const MT = monthlyTotals(TXNS);
    const paid = recurringPaidByMonth();
    const done = months.filter((m) => m < curMonth);
    const incKnown = MT.inc.get(curMonth) || 0;
    const incBase = median(done.slice(-3).map((m) => MT.inc.get(m) || 0)) || 0;
    const incomeEst = Math.max(incKnown, incBase);
    // 手取りモードでは給与清算口座上の法定控除は収入側に折込済みなので、
    // 固定費予定として二重に引かない(給与グループの宣言を除外)
    const fixedEst = KB.declaredSubs()
      .filter((s) => s.active && (state.incomeMode !== "net" ||
              (ACCOUNTS[s.account] || {}).group !== "給与"))
      .reduce((s, x) => s + x.monthly, 0);
    const varOf = (m) => Math.max(0, (MT.exp.get(m) || 0) - (paid.get(m) || 0));
    const base6 = months
      .filter((m) => m <= shiftMonth(curMonth, -2)).slice(-6);
    const varBase = base6.length
      ? base6.reduce((s, m) => s + varOf(m), 0) / base6.length : 0;
    const varKnown = varOf(curMonth);
    const varEst = Math.max(varKnown, varBase);
    return { incomeEst, incKnown, incBase, fixedEst, varKnown, varBase, varEst,
             net: Math.round(incomeEst - fixedEst - varEst) };
  }

  // 資産全体の運用効率。
  // 運用益の定義(yieldStats / yieldMonthly 共通。KPI・運用カードとも同一):
  //   + 証券(ポートフォリオ口座): Δ(評価額 − 累積元本)。評価額
  //     (value_history=投資商品のみ・現金非含)と元本を同じ実測日で対に
  //     するため、買付余力の現金滞留が式に入らず、入金→買付が期間境界を
  //     またいでも歪まない。元本は売却時に受取額を控除する簡易法で、
  //     実現損益も差の中に残る
  //   + 残差対象口座(証券グループのうちポートフォリオ以外=貴金属・
  //     スイープ預金): Δ残高 − 純流入。純流入は自前の振替明細があれば
  //     その記録(内側)を使い、無い口座だけ相手側の記録(外側)で補う
  //     (二重計上しない)。利息等は残差に含まれるので明細では数えない
  //   + DC: Δ(評価額 − 拠出累計)(拠出累計が履歴にある口座)
  //   + 利息・配当の明細合計(残差対象口座上のものを除く全口座。
  //     証券口座に現金で入る配当は評価損益に含まれないのでここで数える)
  //   効率 = 運用益 ÷ 期間平均総資産 → 年率換算(修正Dietz流の金額加重)
  // 手入力口座(現金・決済等)は利回りゼロとみなし、分母にだけ入る。
  const YIELD_CATS = new Set(["利息", "配当金", "分配金"]);

  // 上の定義の共通部品(窓集計とアンカー月集計で同じ規則を使うための土台)
  function yieldCtx() {
    const { HIST, ACCOUNTS, TXNS, effective } = KB;
    const inv = DATA.invest || {};
    const secIds = new Set(Object.keys(ACCOUNTS).filter((id) =>
      ACCOUNTS[id].kind === "asset" && ACCOUNTS[id].group === "証券"));
    const pfAcct = inv.portfolio && secIds.has(inv.portfolio.account)
      ? inv.portfolio.account : null;
    // 閉鎖口座(active=false)は残差から除く。最終明細が取れず台帳が途中で
    // 切れていることがあり(例: 2026-08のハイブリッド預金は解約で最終
    // スイープ出金の行が存在しない)、内側の振替記録が片側だけ残って残差を
    // 歪める。残高は0の宣言で閉じており、利息明細は flows 側で数えられる。
    // 合成口座(未受渡)も除く。約定・受渡のたびに残高が動くが損益ではない
    const residIds = new Set([...secIds].filter((id) =>
      id !== pfAcct && ACCOUNTS[id].active !== false
      && !ACCOUNTS[id].synthetic));
    // ポートフォリオの評価損益系列(実測日ごと)。貴金属の約定は
    // ポートフォリオの評価額(value_history)に現れないため元本にも入れない
    // (貴金属の損益は残差側が受け持つ)
    const evs = (inv.events || [])
      .filter((e) => !KB.isReinvest(e) && e.kind !== "metal")
      .slice().sort((a, b) => a.date.localeCompare(b.date));
    const costOf = (e) => KB.isSell(e) ? -KB.sellProceeds(e) : KB.buyCost(e);
    const plPts = [];
    let ci = 0, cost = 0;
    for (const q of (inv.value_history || []).slice()
        .sort((a, b) => a.date.localeCompare(b.date))) {
      while (ci < evs.length && evs[ci].date <= q.date) cost += costOf(evs[ci++]);
      plPts.push({ date: q.date, pl: q.value - cost });
    }
    // 履歴のキャリーフォワード参照(key を持つ最新点 ≤ 月末)
    const at = (pts, m, key) => {
      let v = null;
      for (const p of pts) {
        if (p.date > m + "-99") break;
        if (p[key] != null) v = p[key];
      }
      return v;
    };
    const plAt = (m) => {
      let v = 0;
      for (const p of plPts) {
        if (p.date > m + "-99") break;
        v = p.pl;
      }
      return v;
    };
    const dcPts = [], residPts = [];
    for (const [id, pts] of Object.entries(HIST)) {
      if (pts.some((p) => p.contrib_total != null)) dcPts.push(pts);
      else if (residIds.has(id)) residPts.push(pts);
    }
    const dcPl = (m) => dcPts.reduce((s, pts) => {
      const b = at(pts, m, "balance");
      if (b == null) return s;
      const c = at(pts, m, "contrib_total");
      return c == null ? s : s + (b - c);
    }, 0);
    const residBal = (m) =>
      residPts.reduce((s, pts) => s + (at(pts, m, "balance") || 0), 0);
    const ownTransfer = new Set();
    for (const t of TXNS) if (t.type === "transfer") ownTransfer.add(t.account);
    // 明細の月次集計(利息・配当と、残差対象への純流入)
    const flowsBy = new Map(), inflowBy = new Map();
    const addTo = (map, m, v) => map.set(m, (map.get(m) || 0) + v);
    for (const t of TXNS) {
      const m = t.date.slice(0, 7);
      if (t.type === "transfer" && t.counter) {
        if (residIds.has(t.account) && !residIds.has(t.counter)) {
          addTo(inflowBy, m, t.amount);            // 内側の記録
        } else if (!residIds.has(t.account) && residIds.has(t.counter)
                   && !ownTransfer.has(t.counter)) {
          addTo(inflowBy, m, -t.amount);           // 外側の記録で補完
        }
      } else if (!residIds.has(t.account)) {
        const e = effective(t);
        if (e.type === "income" && YIELD_CATS.has(e.category)) {
          addTo(flowsBy, m, e.amount);
        }
      }
    }
    return { plPts, plAt, dcPts, residPts, dcPl, residBal, flowsBy, inflowBy };
  }

  // 窓集計(win ヶ月。省略すると残高履歴のある全期間)
  function yieldStats(win) {
    const { NW, shiftMonth } = KB;
    if (!NW || NW.length < 2) return null;
    const endM = NW[NW.length - 1].month;
    let startIdx = 0;
    if (win) {
      const startM = shiftMonth(endM, -win);
      startIdx = NW.findIndex((p) => p.month >= startM);
      if (startIdx < 0) startIdx = 0;
    }
    if (NW[startIdx].month >= endM) return null;
    const s0 = NW[startIdx].month;
    const spanM = (Number(endM.slice(0, 4)) - Number(s0.slice(0, 4))) * 12
                + (Number(endM.slice(5)) - Number(s0.slice(5)));
    const c = yieldCtx();
    const winSum = (map) => {
      let s = 0;
      for (const [m, v] of map) if (m > s0 && m <= endM) s += v;
      return s;
    };
    const flows = winSum(c.flowsBy);
    const dcGain = c.dcPl(endM) - c.dcPl(s0);
    const secGain = (c.plAt(endM) - c.plAt(s0))
                  + (c.residBal(endM) - c.residBal(s0)) - winSum(c.inflowBy);
    // 分母: 窓内の月次総資産(負債を除く資産側)の平均
    const pts = NW.slice(startIdx);
    const avgAssets =
      pts.reduce((s, p) => s + (p.total - p.liab), 0) / pts.length;
    const gain = Math.round(flows + dcGain + secGain);
    return { gain, flows: Math.round(flows), dcGain: Math.round(dcGain),
             secGain: Math.round(secGain), avgAssets: Math.round(avgAssets),
             months: spanM,
             annual: avgAssets > 0 ? gain / avgAssets * (12 / spanM) : null };
  }

  // 月次分解(運用カード用)。評価系(証券・残差・DC)はアンカーのある月に
  // だけ計上し、無い月の変動は次のアンカー月へ持ち越す(アンカーの無い月に
  // そのまま立てると、実際は評価の動いていない月に損益が見えるため)。
  // sec / dc が null の月は「計上なし」(0円ではない)。
  function yieldMonthly() {
    const { NW } = KB;
    if (!NW || NW.length < 2) return [];
    const c = yieldCtx();
    const anchorMonths = (list) => {
      const s = new Set();
      for (const pts of list) for (const p of pts) s.add(p.date.slice(0, 7));
      return s;
    };
    const plAnchor = new Set(c.plPts.map((p) => p.date.slice(0, 7)));
    const residAnchor = anchorMonths(c.residPts);
    const dcAnchor = anchorMonths(c.dcPts);
    const out = [];
    let pendPl = 0, pendResid = 0, pendDc = 0;
    for (let i = 1; i < NW.length; i++) {
      const m = NW[i].month, prev = NW[i - 1].month;
      pendPl += c.plAt(m) - c.plAt(prev);
      pendResid += c.residBal(m) - c.residBal(prev) - (c.inflowBy.get(m) || 0);
      pendDc += c.dcPl(m) - c.dcPl(prev);
      const row = { m, flows: c.flowsBy.get(m) || 0, sec: null, dc: null };
      let sec = null;
      if (plAnchor.has(m)) { sec = (sec || 0) + pendPl; pendPl = 0; }
      if (residAnchor.has(m)) { sec = (sec || 0) + pendResid; pendResid = 0; }
      if (sec != null) row.sec = Math.round(sec);
      if (dcAnchor.has(m)) { row.dc = Math.round(pendDc); pendDc = 0; }
      out.push(row);
    }
    return out;
  }

  Object.assign(KB, { median, quantile, mad, xirr, modeOf,
                      recurringPaidByMonth, provisionalNet, yieldStats,
                      yieldMonthly });
})();
