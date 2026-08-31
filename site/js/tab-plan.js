"use strict";
// tab-plan.js: 計画タブ(資金繰り予測・What-if・純資産の長期投影)。
(function () {
  const KB = window.KB;
  const {
    $, ACCOUNTS, BALS, TXNS, COMP, NW, months, curMonth, state,
    fmt, sfmt, compact, cYen, cssVar, niceStep, note, noteLines, mkTile,
    showTip, hideTip, monthlyTotals, shiftMonth, groupColor,
    liabShade, nwLiabRank, nwTip,
    mkSvg, line, rect, text, polyline, circle, areaBand,
    SVGNS, stripePattern, stripeCss, dimFilter, yAxis, legendKey,
    futureEvents, declaredSubs, daysOf,
    isSell, isReinvest, buyCost,
  } = KB;

  // What-if の状態。資金繰り予測と長期投影の
  // 両方に反映する。集計に影響しないUI状態なので localStorage に持つ。
  //   drop      : 解約する定期支出の name の集合
  //   saving    : 毎月の貯蓄(円)。null=実績(参照期間の月平均)に追従
  //   invest    : うち投資に回す額(円)。null=実績の買付平均に追従
  //   loanRepay : 借入の毎月返済額(円)
  // 貯蓄・投資は「追従(null)か固定値か」の2状態。スライダーを動かすと
  // 固定になり、▲(実績マーカー)のクリックで追従に戻す。
  // 借入返済スライダーの初期値(index.html の value と揃える)。未保存のとき
  // だけ効き、ユーザーが明示的に0(=返済しない)にした場合はその0を尊重する
  const DEFAULT_LOAN_REPAY = 4000;
  const whatif = { drop: new Set(), saving: null, invest: null,
                   loanRepay: DEFAULT_LOAN_REPAY };
  function loadWhatif() {
    try {
      const w = JSON.parse(localStorage.getItem("kakeibo-whatif") || "{}");
      whatif.drop = new Set(w.drop || []);
      whatif.saving = typeof w.saving === "number" ? w.saving : null;
      whatif.invest = typeof w.invest === "number" ? w.invest : null;
      // `|| DEFAULT` だと保存済みの0が既定値に戻ってしまうため型で判定する
      whatif.loanRepay = typeof w.loanRepay === "number"
        ? w.loanRepay : DEFAULT_LOAN_REPAY;
    } catch (e) { /* file:// で不可でも既定値で動く */ }
  }
  function saveWhatif() {
    try {
      localStorage.setItem("kakeibo-whatif", JSON.stringify({
        drop: [...whatif.drop],
        ...(whatif.saving != null ? { saving: whatif.saving } : {}),
        ...(whatif.invest != null ? { invest: whatif.invest } : {}),
        loanRepay: whatif.loanRepay,
      }));
    } catch (e) { /* 同上 */ }
  }

  // 予測の起点にする口座(銀行グループ・資産・残高アンカーあり)。
  // 給与振込もカード引落もここへ落ちるため、この合算残高が
  // 「当面の支払いに足りるか」を最もよく表す。
  function bankAnchors() {
    const out = [];
    for (const [id, a] of Object.entries(ACCOUNTS)) {
      if (a.kind !== "asset" || a.group !== "銀行") continue;
      const b = BALS[id];
      if (!b) continue;
      out.push({ id, name: a.name, start: b.balance, asof: b.date });
    }
    return out;
  }

  function planHorizon() {
    return state.planHorizon || 3;
  }

  function renderPlan() {
    // What-if と長期投影(長期セクション)は銀行残高アンカーの有無に依存しない。
    // 短期セクションが描けない場合でも長期側は必ず描く(セクションが空にならない)
    renderWhatifPanel();
    const kpiBox = $("#plan-kpis");
    kpiBox.replaceChildren();
    const banks = bankAnchors();
    if (!banks.length) {
      $("#cashflow-chart").replaceChildren();
      note($("#cashflow-chart"), "銀行口座の残高アンカーがありません。" +
        "data/raw/manual/balances.csv やゆうちょ明細を取り込むと表示されます");
      $("#cf-note").textContent = "";
      $("#cf-events-card").style.display = "none";
      renderLongterm();
      return;
    }
    $("#cf-events-card").style.display = "";
    const today = KB.todayIso();
    const horizon = planHorizon();
    // イベントは常に3ヶ月分取り、チャートには表示期間内だけを流す。
    // 表(renderCfEvents)は3ヶ月分全部を出し、期間外を薄表示する
    const tableMonths = Math.max(3, horizon);
    // 資金繰りは実際の残高予測なので What-if(解約等)を混ぜない。
    // 仮定は長期予測(renderLongterm)にだけ効かせる
    const { events: allEvents, salary, baseline } = futureEvents({
      horizonMonths: tableMonths, today });
    const startTotal = banks.reduce((s, b) => s + b.start, 0);

    // 合算銀行残高の日次投影列(イベント日に段差)。end までの各日を持つ
    const endMonth = shiftMonth(today.slice(0, 7), horizon);
    const end = endMonth + "-" + String(daysOf(endMonth)).padStart(2, "0");
    const events = allEvents.filter((e) => e.date <= end);
    const dayList = [];
    for (let d = new Date(today + "T00:00:00"); ; d.setDate(d.getDate() + 1)) {
      const iso = KB.localIso(d);
      dayList.push(iso);
      if (iso >= end) break;
    }
    // 銀行口座に効くイベントだけを日付→差分に畳む(Suica等の定期は
    // 銀行残高に直接は響かないので除外され、二重計上を避ける)
    const bankIds = new Set(banks.map((b) => b.id));
    const bankEvents = events.filter((e) => bankIds.has(e.account));
    const deltaByDay = new Map();
    for (const e of bankEvents) {
      deltaByDay.set(e.date, (deltaByDay.get(e.date) || 0) + e.amount);
    }
    let bal = startTotal;
    const series = dayList.map((iso) => {
      bal += deltaByDay.get(iso) || 0;
      return { date: iso, bal };
    });
    const minPt = series.reduce((m, p) => p.bal < m.bal ? p : m, series[0]);
    const endBal = series[series.length - 1].bal;

    // KPI
    mkTile(kpiBox, "銀行残高(現在)", fmt(startTotal),
           banks.length === 1 ? "時点 " + banks[0].asof
             : banks.map((b) => b.name).join("・"), "");
    mkTile(kpiBox, `${horizon}ヶ月先の残高(予測)`, fmt(endBal),
           "現在 " + sfmt(endBal - startTotal), endBal < 0 ? "neg" : "");
    mkTile(kpiBox, "期間中の最低残高", fmt(minPt.bal),
           minPt.date + " 時点", minPt.bal < 0 ? "neg" : "small");
    // ベースライン(日割りの小さな概算)は「大きな引落」の候補にしない
    const nextOut = bankEvents.filter(
      (e) => e.amount < 0 && e.kind !== "baseline")[0];
    mkTile(kpiBox, "次の大きな引落",
           nextOut ? "−" + fmt(-nextOut.amount) : "—",
           nextOut ? `${nextOut.date} ${nextOut.label}` : "予定なし", "small");

    drawCashflow(series, bankEvents, salary, banks, baseline);
    renderCfEvents(allEvents, end);
    renderLongterm();
  }

  // What-if パネル
  function renderWhatifPanel() {
    // サブスクの解約チェック(宣言ベース・現役のみ。固定費宣言は
    // 「解約」の仮定が意味を持たないので並べない)
    const box = $("#whatif-subs");
    box.replaceChildren();
    const subs = declaredSubs().filter((s) => s.active && s.kind !== "fixed");
    if (!subs.length) {
      note(box, "現役のサブスク宣言がありません(rules.toml [[recurring]])");
    }
    for (const s of subs) {
      const row = document.createElement("label");
      row.className = "whatif-sub" + (whatif.drop.has(s.name) ? " dropped" : "");
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = whatif.drop.has(s.name);
      cb.addEventListener("change", () => {
        if (cb.checked) whatif.drop.add(s.name); else whatif.drop.delete(s.name);
        row.classList.toggle("dropped", cb.checked);
        saveWhatif();
        // 解約は長期予測(貯蓄への上乗せ)にだけ効く
        syncWhatifSliders();
        renderLongterm();
      });
      const nm = document.createElement("span");
      nm.textContent = s.name;
      const amt = document.createElement("span");
      amt.className = "amt";
      amt.textContent = fmt(Math.round(s.monthly)) + "/月";
      row.append(cb, nm, amt);
      box.appendChild(row);
    }
    syncWhatifSliders();
  }

  // スライダーの位置・値ラベル・実績マーカー(▲)を現在の状態に合わせる。
  // 追従(null)ならスライダー自体が実績位置に乗り、固定値ならスライダーは
  // 動かさず▲だけが参照期間の実績を指す。
  // 投資率スライダーは表示が率(投資額÷貯蓄額)・内部が額。貯蓄額が変わる
  // と額を維持したまま率の表示位置が動く(projectionInputs が貯蓄額で
  // 頭打ちにするので100%を超えない)
  function syncWhatifSliders() {
    const inp = projectionInputs();
    // ▲マーカー: つまみの可動域(端はつまみ半幅ぶん内側)に合わせて置く
    const setRef = (id, frac, title) => {
      const mk = $(`#${id}-ref`);
      const f = Math.max(0, Math.min(1, frac));
      mk.style.left = `calc(8px + ${(f * 100).toFixed(2)}% - ${(f * 16).toFixed(1)}px)`;
      mk.title = title + "。クリックで実績追従に戻す";
    };
    // 月次貯蓄額
    {
      const el = $("#whatif-saving");
      const min = Number(el.min), max = Number(el.max), step = Number(el.step);
      const val = whatif.saving != null ? whatif.saving
        : Math.round(inp.baseSaving / step) * step;
      el.value = Math.max(min, Math.min(max, val));
      $("#whatif-saving-val").textContent = sfmt(Number(el.value)) + "/月" +
        (whatif.saving != null ? "" : "(実績)");
      setRef("whatif-saving", (inp.baseSaving - min) / (max - min),
             `${inp.baseLabel}の実績 ${sfmt(Math.round(inp.baseSaving))}/月`);
    }
    // 月次貯蓄投資率(左=投資=証券色、右=現金=銀行色)
    {
      const el = $("#whatif-invest");
      const savable = Math.max(0, inp.effSaving);
      const rate = savable > 0 ? inp.monthInvest / savable : 0;
      el.value = Math.round(rate * 100);
      el.style.background = savable > 0
        ? `linear-gradient(to right, ${groupColor("証券")} 0 ${el.value}%, ` +
          `${groupColor("銀行")} ${el.value}% 100%)`
        : "var(--grid)";
      $("#whatif-invest-val").textContent = savable > 0
        ? `${el.value}%(${fmt(Math.round(inp.monthInvest))}/月)` +
          (whatif.invest != null ? "" : "(実績)")
        : "—(貯蓄がマイナス)";
      const refRate = savable > 0 ? inp.baseInvest / savable : 0;
      setRef("whatif-invest", refRate,
             `${inp.baseLabel}の実績 ${fmt(Math.round(inp.baseInvest))}/月` +
             (savable > 0 ? `(${Math.round(Math.min(1, refRate) * 100)}%)` : ""));
    }
    // 返済で減る借入が無い(完済済み・そもそも無い)世帯には返済スライダーごと出さない
    $("#whatif-loan-row").hidden = inp.debtNow <= 0;
    $("#whatif-loan-val").textContent = whatif.loanRepay > 0
      ? fmt(whatif.loanRepay) + "/月" : "しない";
    $("#whatif-loan").value = whatif.loanRepay;
  }

  function drawCashflow(series, bankEvents, salary, banks, baseline) {
    const box = $("#cashflow-chart");
    box.replaceChildren();
    const legend = $("#cf-legend");
    legend.replaceChildren();
    const n = series.length;
    const W = Math.max(680, n * 9), H = 300;
    const padL = 64, padR = 12, padT = 12, padB = 30;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const vals = series.map((p) => p.bal);
    const maxV = Math.max(0, ...vals);
    const minV = Math.min(0, ...vals);
    const step = niceStep(maxV - minV || 1);
    const top = Math.ceil(maxV / step) * step;
    const bot = Math.floor(minV / step) * step;
    const x = (i) => padL + plotW * (i / Math.max(1, n - 1));
    const y = (v) => padT + plotH * (1 - (v - bot) / Math.max(1, top - bot));
    const svg = mkSvg(W, H);
    yAxis(svg, null, { y, bot, top, step, x0: padL, x1: W - padR });
    // 残高が0を割る区間を赤帯で警告
    let danger = false;
    for (let i = 0; i < n; i++) {
      if (series[i].bal < 0) {
        danger = true;
        const x0 = x(Math.max(0, i - 0.5)), x1 = x(Math.min(n - 1, i + 0.5));
        const r = rect(svg, x0, padT, x1 - x0, plotH, cssVar("--critical"));
        r.setAttribute("fill-opacity", "0.12");
        r.style.pointerEvents = "none";
      }
    }
    // 日付の縦目盛り(月初と今日)。初日は日付を書かず「今日」だけにする
    // (同じ座標への重ね書きでラベルが潰れるため)
    let lastMonth = "";
    series.forEach((p, i) => {
      const m = p.date.slice(0, 7);
      if (m !== lastMonth) {
        lastMonth = m;
        if (i === 0) return;
        line(svg, x(i), padT, x(i), H - padB, cssVar("--grid"));
        text(svg, x(i), H - 10, p.date.slice(5).replace("-", "/"),
             "axis-label", "middle");
      }
    });
    text(svg, x(0), H - 10, "今日", "axis-label", "middle");
    // 予測残高の折れ線
    const seq = cssVar("--seq");
    polyline(svg, series.map((p, i) => [x(i), y(p.bal)]), seq, 2.5, "1 0");
    // イベントの点(色分け: 収入=緑・支出=赤・給与=青)+ホバー。
    // ベースラインは毎日の小さな概算なので点を打たない(線の傾きが表現)
    const dayIndex = new Map(series.map((p, i) => [p.date, i]));
    for (const e of bankEvents) {
      if (e.kind === "baseline") continue;
      const i = dayIndex.get(e.date);
      if (i == null) continue;
      const col = e.kind === "salary" ? cssVar("--income")
        : e.amount >= 0 ? cssVar("--good") : cssVar("--critical");
      const c = circle(svg, x(i), y(series[i].bal), 3.5, col);
      c.style.cursor = "default";
      c.addEventListener("pointermove", (evt) => {
        showTip(evt, e.date, [
          { name: e.label, value: sfmt(e.amount), color: col },
          { name: "予測残高", value: fmt(series[i].bal) },
        ]);
      });
      c.addEventListener("pointerleave", hideTip);
    }
    box.appendChild(svg);

    // 凡例
    legendKey(legend, "background:" + seq, "予測残高(銀行合算)");
    legendKey(legend, "background:" + cssVar("--income"), "給与");
    legendKey(legend, "background:" + cssVar("--good"), "その他入金");
    legendKey(legend, "background:" + cssVar("--critical"), "引落・支出");

    // 注記(前提を正直に書く)
    const notes = [];
    const staleBanks = banks.filter((b) => b.asof < KB.todayIso());
    if (staleBanks.length) {
      notes.push("残高は各口座の最新アンカー時点(" +
        staleBanks.map((b) => `${b.name} ${b.asof}`).join("・") +
        ")からの投影");
    }
    if (!salary) {
      notes.push("給与の振込実績が不足しているため給与は投影していない");
    }
    if (baseline) {
      notes.push("引落日が安定した定期振替(証券積立等)は検出して引落日に" +
        "投影。残る日を打てない流出(チャージ・日々の支出)は直近" +
        `${baseline.months.length}ヶ月実績の中央値 ` +
        `${compact(baseline.monthly)}円/月 の日割りで、未確定のカード請求は` +
        "直近請求の中央値で投影(いずれも概算)。残高・最低残高は概算込みの目安");
    } else {
      notes.push("投影は給与・確定請求・定期のみで、日々の非定期支出・" +
        "チャージは実績不足のため含まない(残高・最低残高は楽観寄り)");
    }
    if (danger) {
      notes.unshift("⚠ 期間中に銀行残高が不足する見込み。赤帯の時期に注意");
    }
    noteLines($("#cf-note"), notes);
  }

  // events は常に3ヶ月分。chartEnd(チャートの表示期間の末日)より先の行は
  // 薄表示にして「予定はあるがチャートには出ていない」ことを示す
  function renderCfEvents(events, chartEnd) {
    const tbody = $("#cf-events-table tbody");
    tbody.replaceChildren();
    const kindLabel = { salary: "給与", card: "確定", recurring: "定期",
                       card_est: "概算", baseline: "概算" };
    // ベースラインの日割り行をそのまま並べると表が日次で埋まるため、
    // 月ごとに1行へ畳む(最初の日割り日の位置に月合計で出す)
    const rows = [];
    const baseByMonth = new Map();
    for (const e of events) {
      if (e.kind !== "baseline") { rows.push(e); continue; }
      const m = e.date.slice(0, 7);
      let agg = baseByMonth.get(m);
      if (!agg) {
        agg = { ...e, amount: 0, label: e.label + "・月内合計" };
        baseByMonth.set(m, agg);
        rows.push(agg);
      }
      agg.amount += e.amount;
    }
    events = rows;
    for (const e of events) {
      const tr = document.createElement("tr");
      if (chartEnd && e.date > chartEnd) tr.className = "faint";
      const name = (ACCOUNTS[e.account] || {}).name || e.account;
      const cells = [
        [e.date, ""],
        [name, ""],
        [e.label, ""],
        [kindLabel[e.kind] || e.kind, ""],
        [sfmt(e.amount), "num" + (e.amount >= 0 ? " pos" : " neg")],
      ];
      for (const [v, cls] of cells) {
        const td = document.createElement("td");
        td.textContent = v;
        if (cls) td.className = cls;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    if (!events.length) {
      const tr = document.createElement("tr");
      const td = document.createElement("td");
      td.colSpan = 5;
      td.className = "count-note";
      td.textContent = "予定されている入出金は検出されませんでした";
      tr.appendChild(td);
      tbody.appendChild(tr);
    }
  }

  // 純資産の長期投影
  // 起点=現在の純資産を「投資(証券評価額)」と「その他(現金−負債)」に分解し、
  // 月次フロー(基準期間の完了月の収支平均+What-if差分)を積み上げる。投資分は
  // 月利で複利成長させ、利回りシナリオ(悲観0%/中立3%/楽観5%)で帯を描く。
  function projectionInputs() {
    // 月次フローは「基準期間の完了月の平均(合計÷月数)」を使う。収入が
    // 給与月にまとまって入る家計では中央値は低収入月に張り付き累積を
    // 過小評価するため、実際の資産形成ペースを表す平均を採る。
    // 基準期間(#lt-base): 自動=「現在の給与体制」の開始月以降の完了月
    // (最大12)。単なる初任給以降だと昔の単発バイト月まで含んで就職前の
    // 低収入月に平均が沈むため、直近から途切れず連続している給与月の
    // 先頭を体制の開始とみなす。3・6・12=直近nヶ月固定。
    const MT = monthlyTotals(TXNS);
    const completed = months.filter((m) => m < curMonth);
    const base = state.ltBase || "auto";
    let done, baseLabel;
    if (base === "auto") {
      const salMonths = [...new Set(TXNS.filter((t) =>
        t.type === "income" && t.amount > 0 &&
        (ACCOUNTS[t.account] || {}).group === "給与")
        .map((t) => t.date.slice(0, 7)))].sort();
      let runStart = null;
      let i = salMonths.length - 1;
      // 直近2ヶ月以内に給与があるときだけ「現役の給与体制」とみなす
      if (i >= 0 && salMonths[i] >= shiftMonth(curMonth, -2)) {
        runStart = salMonths[i];
        while (i > 0 && salMonths[i - 1] === shiftMonth(salMonths[i], -1)) {
          i--;
          runStart = salMonths[i];
        }
      }
      done = (runStart ? completed.filter((m) => m >= runStart) : completed)
        .slice(-12);
      baseLabel = runStart && done.length && done[0] >= runStart
        ? `現給与の開始(${runStart})以降${done.length}ヶ月`
        : `直近${done.length}ヶ月`;
    } else {
      done = completed.slice(-Number(base));
      baseLabel = `直近${done.length}ヶ月`;
    }
    const nDone = Math.max(1, done.length);
    const baseSaving = done.reduce((s, m) =>
      s + (MT.inc.get(m) || 0) - (MT.exp.get(m) || 0), 0) / nDone;
    // 直近12完了月の月次買付の平均(0の月も分母に含めて平準化)
    const inv = DATA.invest || { events: [] };
    let buySum = 0;
    const doneSet = new Set(done);
    for (const e of inv.events || []) {
      // 分配金再投資は現金流出でないため月次買付ペースに数えない
      if (isSell(e) || isReinvest(e)) continue;
      if (doneSet.has(e.date.slice(0, 7))) buySum += buyCost(e);
    }
    const baseInvest = buySum / nDone;
    // 起点の分解
    const investNow = (COMP.groups.find(([g]) => g === "証券") || [, 0])[1];
    // 年金(企業型DC等)は明細がなく残高アンカーのみ。拠出累計アンカー
    // (contrib_total)がある口座は 月次拠出 = 拠出累計 ÷ 本人天引きの
    // 実績月数 と概算できる(本人分は台帳の給与天引き振替。資産タブ
    // renderDc と同じ逆算)。拠出は運用益と分離できているので、投資と
    // 同じ利回りシナリオで複利にかけられる。本人天引きは総支給ベースの
    // 収支(=貯蓄実績)の内数なので cashAdd から年金へ付け替え、事業主分
    // は総支給に現れない上乗せとして扱う。拠出累計が無い年金口座の残高は
    // 実績の残高増分ペース(運用込み)の直線で伸ばす(こちらは運用込みの
    // 増分なので複利にはかけない)。増分は年金グループが最初に現れた月→
    // 最新月の端点差平均(アンカー更新が不定期でも端点差なら安定)
    const pensionNow = (COMP.groups.find(([g]) => g === "年金") || [, 0])[1];
    let dcMonthly = 0, dcOwnMonthly = 0, pensionSlope = 0;
    const dcEntries = Object.entries(BALS).filter(([id, b]) =>
      b.contrib_total != null && ((ACCOUNTS[id] || {}).group || "") === "年金");
    if (dcEntries.length) {
      for (const [id, b] of dcEntries) {
        const ownMonths = new Set();
        let own = 0;
        for (const t of TXNS) {
          if (t.type === "transfer" && t.counter === id && t.amount < 0 &&
              t.date <= b.date) {
            own += -t.amount;
            ownMonths.add(t.date.slice(0, 7));
          }
        }
        const nm = Math.max(1, ownMonths.size);
        dcMonthly += b.contrib_total / nm;
        dcOwnMonthly += own / nm;
      }
    } else {
      const penHist = NW.map((p) => p.groups.get("年金") || 0);
      const p0 = penHist.findIndex((v) => v > 0);
      if (p0 >= 0 && penHist.length - 1 > p0) {
        pensionSlope = (penHist[penHist.length - 1] - penHist[p0])
          / (penHist.length - 1 - p0);
      }
    }
    const netNow = COMP.net;
    // 現金・その他資産 − 負債(純額)
    const cashNow = netNow - investNow - pensionNow;
    // 完済シミュレーションの対象は accounts.toml で amortizing を宣言した
    // 借入だけ(カード・Paidy の残債は請求として資金繰りで自動的に返済される)
    let debtNow = 0;
    for (const [id, b] of Object.entries(BALS)) {
      const a = ACCOUNTS[id];
      if (a && a.kind === "liability" && a.amortizing) {
        debtNow += Math.max(0, -b.balance);
      }
    }
    // What-if 反映: スライダーが固定値ならそれを、追従(null)なら実績を使う
    const dropped = declaredSubs()
      .filter((s) => s.active && whatif.drop.has(s.name))
      .reduce((sum, s) => sum + s.monthly, 0);
    const effSaving = (whatif.saving != null ? whatif.saving : baseSaving)
      + dropped;
    // 投資は貯蓄の内数(投資率スライダーの不変量)。実績追従でも、投資が
    // 貯蓄を上回る期間は貯蓄額まで(貯蓄がマイナスなら0)に切り詰める
    const investRaw = whatif.invest != null ? whatif.invest : baseInvest;
    const monthInvest = Math.max(0, Math.min(investRaw, Math.max(0, effSaving)));
    // 非投資分の貯蓄。DC本人天引き分は現金でなく年金バケットに積まれる
    const cashAdd = effSaving - monthInvest - dcOwnMonthly;
    return { investNow, cashNow, debtNow, monthInvest, cashAdd, effSaving,
             baseSaving, baseInvest, dropped, baseLabel,
             pensionNow, pensionSlope, dcMonthly, dcOwnMonthly };
  }

  const RATES = [["悲観", 0], ["中立", 0.03], ["楽観", 0.05]];

  function renderLongterm() {
    const years = state.planYears || 5;
    const n = years * 12;
    const inp = projectionInputs();
    // 非投資分は全シナリオ共通(直線)
    const cash = [];
    for (let t = 0; t <= n; t++) cash.push(inp.cashNow + inp.cashAdd * t);
    // 各利回りシナリオの投資・年金バケット→純資産。年金は拠出が分解
    // できていれば投資と同じ複利、実績増分ペース(運用込み)の直線なら
    // 複利にかけない(dcMonthly と pensionSlope はどちらか一方だけ非0)
    const invScen = {};
    const penScen = {};
    const scen = {};
    for (const [, r] of RATES) {
      const inv = [inp.investNow], pn = [inp.pensionNow];
      const penRate = inp.dcMonthly > 0 ? r / 12 : 0;
      for (let t = 1; t <= n; t++) {
        inv.push(inv[t - 1] * (1 + r / 12) + inp.monthInvest);
        pn.push(Math.max(0,
          pn[t - 1] * (1 + penRate) + inp.dcMonthly + inp.pensionSlope));
      }
      invScen[r] = inv;
      penScen[r] = pn;
      scen[r] = inv.map((v, t) => v + cash[t] + pn[t]);
    }
    // 借入の完済月(返済>0のとき)
    let payoffMonth = null;
    if (whatif.loanRepay > 0 && inp.debtNow > 0) {
      payoffMonth = Math.ceil(inp.debtNow / whatif.loanRepay);
    }
    drawLongterm(scen, invScen, penScen[0.03], n, years, payoffMonth, inp);
  }

  // 実績(純資産の推移と同じ月次系列)を左に前置し、予測をその続きとして
  // 描く。予測部分も実績と同じ文法(資産の積み上げ+0から下向きの負債+
  // 純資産線+含み益ストライプ)で、塗りの濃さも揃える。見分けは「実績側を
  // 減光する」ことで付ける(この画面の主役は予測なので、既知の過去を奥に
  // 引いて未来を明るく残す)。内訳は中立シナリオの単純モデル:
  //   投資  = 複利成長する投資バケット
  //   年金  = 概算した月次拠出(DCの拠出累計÷実績月数)を複利で積む
  //           バケット(拠出が分解できない口座は実績増分ペースの直線)
  //   現金等 = 純資産 − 投資 − 年金 + 負債残(銀行・現金・その他の合算)
  //   負債残 = カード等は横ばい、返済対象の借入だけ返済額ぶん毎月減る
  //   含み益 = 現在の含み益 + 将来リターンの累積(元本積み上げとの差)
  // 積み上げ順は実績側と同じ規約(nwStackSort=支出との距離順)に合わせ、
  // 年金(底)→投資→現金等(天)の順に積む(「今」の境界で帯が入れ替わって
  // 見えないように)
  function drawLongterm(scen, invScen, pen, n, years, payoffMonth, inp) {
    const box = $("#longterm-chart");
    box.replaceChildren();
    const legend = $("#lt-legend");
    legend.replaceChildren();
    // 実績: 直近12ヶ月ぶん(最後の点=ほぼ現在)。月数hは区間数
    const hist = NW.slice(-13);
    const h = Math.max(0, hist.length - 1);
    const padL = 64, padR = 14, padT = 12, padB = 28;
    // 横幅: 1年あたりの幅は短い期間なら余裕をとり(90px)、長い期間では
    // カード幅に収まるまで詰める(下限20px)。年数スライダーを右へ振っても
    // 際限なく横スクロールが伸びないようにする
    const span = h / 12 + years;
    // 非表示タブで描かれると clientWidth が0になるので .wrap 幅から見積もる
    const avail = Math.max(320, box.clientWidth ||
      Math.min(1080, document.body.clientWidth) - 64) - padL - padR;
    const perYear = Math.max(20, Math.min(90, avail / span));
    const W = Math.max(680, Math.round(padL + padR + span * perYear)), H = 320;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    // 目盛りの間隔判定は「実際に1年が何pxになるか」で決める(Wに下限がある
    // ぶん、短い年数では perYear より広がる)
    const pxYear = plotW / span;
    const lo = scen[0], hi = scen[0.05], mid = scen[0.03];
    // 予測の内訳(中立)
    const liabLast = hist.length
      ? Math.max(0, -hist[hist.length - 1].liab) : inp.debtNow;
    const otherLiab = Math.max(0, liabLast - inp.debtNow);
    const debt = [];
    for (let t = 0; t <= n; t++) {
      const sch = whatif.loanRepay > 0
        ? Math.max(0, inp.debtNow - whatif.loanRepay * t) : inp.debtNow;
      debt.push(otherLiab + sch);
    }
    const invMid = invScen[0.03];
    const cashMid = mid.map((v, t) => v - invMid[t] - pen[t] + debt[t]);
    const plNow = Math.max(0, ((DATA.invest || {}).portfolio || {}).total_pl || 0);
    const prin0 = inp.investNow - plNow;
    const plMid = invMid.map((v, t) =>
      Math.max(0, v - (prin0 + inp.monthInvest * t)));
    // Yレンジ: 実績のスタック上端・負債と予測の全シナリオ+スタック上端
    const histTop = hist.map((p) => Math.max(p.total,
      [...p.groups.values()].reduce((s, v) => s + Math.max(0, v), 0)));
    const projTop = mid.map((v, t) => v + debt[t]);
    const maxV = Math.max(0, ...hi, ...projTop, ...histTop);
    const minV = Math.min(0, ...lo,
      ...debt.map((d) => -d), ...hist.map((p) => Math.min(p.total, p.liab)));
    const step = niceStep(maxV - minV || 1);
    const top = Math.ceil(maxV / step) * step, bot = Math.floor(minV / step) * step;
    const x = (t) => padL + plotW * ((t + h) / Math.max(1, h + n));
    const y = (v) => padT + plotH * (1 - (v - bot) / Math.max(1, top - bot));
    const svg = mkSvg(W, H);
    yAxis(svg, null, { y, bot, top, step, x0: padL, x1: W - padR });
    // 年目盛りの縦グリッドも横グリッド(yAxis)と同じく面の奥に敷く
    // (手前に引くと積み上げ面を縞が切って見える)。ラベルは後段の
    // 目盛りループで書く。間隔は実際のpx幅から決める(長い年数では
    // 1年が狭くなり、毎年刻みでは重なるため)
    const tickYr = [1, 2, 5, 10].find((s) => s * pxYear >= 40) || 10;
    for (let yr = tickYr; yr <= years; yr += tickYr) {
      line(svg, x(yr * 12), padT, x(yr * 12), H - padB, cssVar("--grid"));
    }
    // 面ポリゴン(top点列とbottom点列を閉じる)。into で描画先を差し替える
    // (実績は減光グループの中へ)
    const areaPath = (topPts, botPts, fill, opacity, into) => {
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", "M" + topPts.map((q) => q.join(",")).join(" L ") +
        " L " + botPts.slice().reverse().map((q) => q.join(",")).join(" L ") + " z");
      p.setAttribute("fill", fill);
      if (opacity != null) p.setAttribute("fill-opacity", opacity);
      (into || svg).appendChild(p);
      return p;
    };
    // 実績・予測で共通(差は減光だけ)。負債は資産よりやや濃く塗り、
    // 負債レーン最上位の赤がそのまま負債の代表色に見えるようにする
    // (薄めると資産構成バーの2番手=Paidyの淡赤と紛れる)
    const FILL_OP = 0.8, DEBT_OP = 0.9;
    const dimUrl = dimFilter(svg, 0.65);
    // 実績(純資産の推移と同じ描き方。まとめて減光する)
    if (h > 0) {
      const dim = document.createElementNS(SVGNS, "g");
      dim.setAttribute("filter", dimUrl);
      svg.appendChild(dim);
      KB.drawNwStack(svg, dim, hist, (i) => x(i - h), y,
                     { groupOp: FILL_OP, debtOp: DEBT_OP });
    }
    // 予測(同じ文法・同じ濃さ。減光しないぶん手前に見える)
    // 積み順は実績側(nwStackSort)に合わせ 年金(底)→投資→現金等(天)
    const secCol = groupColor("証券"), cashCol = groupColor("銀行");
    const penCol = groupColor("年金");
    const ts = Array.from({ length: n + 1 }, (_, t) => t);
    const invTop = (t) => pen[t] + invMid[t];
    const stkTop = (t) => pen[t] + invMid[t] + Math.max(0, cashMid[t]);
    const hasPen = pen.some((v) => v > 0);
    if (hasPen) {
      areaPath(ts.map((t) => [x(t), y(pen[t])]),
               ts.map((t) => [x(t), y(0)]), penCol, FILL_OP);
    }
    areaPath(ts.map((t) => [x(t), y(invTop(t))]),
             ts.map((t) => [x(t), y(pen[t])]), secCol, FILL_OP);
    areaPath(ts.map((t) => [x(t), y(stkTop(t))]),
             ts.map((t) => [x(t), y(invTop(t))]), cashCol, FILL_OP);
    // 予測の含み益ストライプ(投資バンドの上端側)
    if (plMid.some((v) => v > 0)) {
      areaPath(
        ts.map((t) => [x(t), y(invTop(t))]),
        ts.map((t) => [x(t), y(invTop(t) - Math.min(plMid[t], invMid[t]))]),
        stripePattern(svg));
    }
    // 予測の負債(カード等横ばい+借入は返済で減る)
    if (debt.some((d) => d > 0)) {
      areaPath(ts.map((t) => [x(t), y(-debt[t])]),
               ts.map((t) => [x(t), y(0)]), cssVar("--critical"), DEBT_OP);
    }
    // 帯(悲観〜楽観)と中立線(分析色=予測の印)
    const seq = cssVar("--seq");
    areaBand(svg, ts.map((t) => [x(t), y(hi[t])]),
             ts.map((t) => [x(t), y(lo[t])]), seq, 0.16);
    polyline(svg, ts.map((t) => [x(t), y(mid[t])]), seq, 2.5);
    // 実績の純資産線。最後の点を予測の起点につないで段差を見せない。
    // 面と同じ減光をかけて「実績側は一段暗い」を線でも守る
    if (h > 0) {
      const pts = hist.map((p, i) => [x(i - h), y(p.total)]);
      pts.push([x(0), y(mid[0])]);
      polyline(svg, pts, cssVar("--ink"), 2).setAttribute("filter", dimUrl);
    }
    // 「今」の境界線
    line(svg, x(0), padT, x(0), H - padB, cssVar("--muted"))
      .setAttribute("stroke-dasharray", "4 3");
    text(svg, x(0), padT + 12, "今", "bar-label-sm", "middle")
      .setAttribute("fill", cssVar("--muted"));
    // 目盛り: 実績は月ラベル、予測は年ラベル。どちらも間隔は実際のpx幅から
    // 決める(長い年数を選ぶと1年が狭くなり、毎年ラベルでは重なるため)
    const monthPx = pxYear / 12;
    const histStep = [6, 12].find((m) => m * monthPx >= 34);
    if (h > 0) {
      if (histStep) {
        for (let i = h % histStep; i < h; i += histStep) {
          text(svg, x(i - h), H - 9, hist[i].month.slice(2).replace("-", "/"),
               "axis-label", "middle");
        }
      } else {
        // 詰まっていて刻めないときは実績の開始月だけ示す
        text(svg, x(-h), H - 9, hist[0].month.slice(2).replace("-", "/"),
             "axis-label", "middle");
      }
    }
    for (let yr = tickYr; yr <= years; yr += tickYr) {
      text(svg, x(yr * 12), H - 9, yr + "年", "axis-label", "middle");
    }
    // 借入の完済マーカー
    if (payoffMonth != null && payoffMonth <= n) {
      const px = x(payoffMonth);
      line(svg, px, padT, px, H - padB, cssVar("--good")).setAttribute(
        "stroke-dasharray", "4 3");
      const lbl = text(svg, px, padT + 12, "借入完済", "bar-label-sm", "middle");
      lbl.setAttribute("fill", cssVar("--good"));
    }
    // ホバー: 実績側は推移チャートと同じ素材(nwTip)、予測側はシナリオ+
    // 中立の内訳を同じ文法(ドーナツペア+セクション見出し付きの表)で。
    // ヒット領域は推移チャートと同じ月バンド分割。プロット全面の1枚岩に
    // すると、共通のホバー縁取り(svgkit hlMark)がヒット矩形の横幅に
    // クリップする仕組み上「その月」に絞れず面が全期間縁取りされてしまう
    const liabRank = nwLiabRank(hist);
    const bandW = plotW / Math.max(1, h + n);
    const ltTip = (evt, t) => {
      if (t < 0) {
        const i = t + h;
        const { rows, pie } = nwTip(hist[i], i > 0 ? hist[i - 1] : null,
                                    liabRank);
        showTip(evt, hist[i].month + "(実績)", rows, pie);
      } else {
        const pctOf = (v, total) =>
          total > 0 ? Math.round(v / total * 100) + "%" : undefined;
        const rows = [
          { name: "楽観(年5%)", value: fmt(scen[0.05][t]), color: seq,
            cls: scen[0.05][t] < 0 ? "neg" : "" },
          { name: "中立(年3%)", value: fmt(scen[0.03][t]),
            cls: scen[0.03][t] < 0 ? "neg" : "" },
          { name: "悲観(年0%)", value: fmt(scen[0][t]),
            cls: scen[0][t] < 0 ? "neg" : "" },
        ];
        // 資産の内訳(中立)。表は収支系と同じく計→構成比付きの各行
        const assetsMid = stkTop(t);
        rows.push({ header: "資産(中立)" },
                  { name: "資産計", value: fmt(assetsMid), pct: "100%" },
                  { name: "投資", value: fmt(invMid[t]), color: secCol,
                    pct: pctOf(invMid[t], assetsMid) },
                  { name: "うち含み益(斜線)", value: fmt(plMid[t]),
                    pct: pctOf(plMid[t], assetsMid) },
                  { name: "現金等", value: fmt(cashMid[t]), color: cashCol,
                    pct: pctOf(Math.max(0, cashMid[t]), assetsMid),
                    cls: cashMid[t] < 0 ? "neg" : "" });
        if (hasPen) {
          rows.push({ name: "年金", value: fmt(pen[t]), color: penCol,
                      pct: pctOf(pen[t], assetsMid) });
        }
        // 予測側の負債: 借入(返済で減る)とカード等(横ばい)の2区分
        const liabW = [];
        const sch = debt[t] - otherLiab;   // 返済で減っていく借入の残債
        if (sch > 0) {
          liabW.push({ name: "借入", value: sch, color: liabShade(0) });
        }
        if (otherLiab > 0) {
          liabW.push({ name: "カード等", value: otherLiab,
                       color: liabShade(1) });
        }
        if (debt[t] > 0) {
          rows.push({ header: "負債(中立)" },
                    { name: "負債計", value: "−" + fmt(debt[t]), pct: "100%",
                      cls: "neg" });
          for (const w of liabW) {
            rows.push({ name: w.name, value: "−" + fmt(w.value),
                        color: w.color, pct: pctOf(w.value, debt[t]),
                        cls: "neg" });
          }
        }
        const outer = [
          { name: "投資", value: invMid[t], color: secCol },
          { name: "現金等", value: cashMid[t], color: cashCol },
        ];
        if (hasPen) outer.push({ name: "年金", value: pen[t], color: penCol });
        showTip(evt, t === 0 ? "今" : `${(t / 12).toFixed(1)}年後`, rows,
                { outer, liab: liabW });
      }
    };
    for (let t = -h; t <= n; t++) {
      const hit = rect(svg, x(t) - bandW / 2, padT, bandW, plotH, "transparent");
      hit.addEventListener("pointermove", (evt) => ltTip(evt, t));
      hit.addEventListener("pointerleave", hideTip);
    }
    box.appendChild(svg);

    // 凡例
    legendKey(legend, `background:${cssVar("--ink")};filter:brightness(.5)`,
              "(暗)実績");
    legendKey(legend, "background:" + seq, "中立(年3%)");
    legendKey(legend, `background:${seq};opacity:.3`, "悲観〜楽観(0〜5%)");
    legendKey(legend, `background:${secCol};opacity:${FILL_OP}`, "投資");
    legendKey(legend, `background:${cashCol};opacity:${FILL_OP}`, "現預金");
    if (hasPen) {
      legendKey(legend, `background:${penCol};opacity:${FILL_OP}`, "年金");
    }
    legendKey(legend, `background:${cssVar("--critical")};opacity:${DEBT_OP}`,
              "負債");
    legendKey(legend, stripeCss(secCol), "含み益");

    // 注記(前提)
    const savingSrc = whatif.saving != null
      ? "スライダー指定" : `${inp.baseLabel}の実績平均`;
    const parts = [
      `月次の貯蓄 ${cYen(inp.effSaving)}(${savingSrc}` +
        (inp.dropped ? ` +解約 ${cYen(inp.dropped)}` : "") + ")",
      `うち投資 ${cYen(inp.monthInvest)}/月` +
        (inp.effSaving > 0
          ? `(投資率${Math.round(inp.monthInvest / inp.effSaving * 100)}%・`
          : "(") +
        `${whatif.invest != null ? "スライダー指定" : "実績平均"})を複利運用`,
    ];
    if (payoffMonth != null) {
      parts.push(`借入は月${cYen(whatif.loanRepay)}返済で${(payoffMonth / 12).toFixed(1)}年後に完済(返済自体は純資産を変えない)`);
    }
    if (hasPen) {
      parts.push(inp.dcMonthly > 0
        ? `年金(DC)は拠出累計から概算した月次拠出 ${cYen(Math.round(inp.dcMonthly))}(うち本人天引き ${cYen(Math.round(inp.dcOwnMonthly))} は貯蓄の内数)を投資と同じ利回りシナリオで複利運用`
        : `年金は残高実績の増分ペース ${cYen(Math.round(inp.pensionSlope))}/月で直線に伸ばす(増分は運用込みのため利回りシナリオの対象外)`);
    }
    parts.push("「今」より左は純資産の推移と同じ実績(暗く落としてある)。右は中立シナリオの内訳で、" +
      "利回りは投資分のみに適用。負債はカード等横ばい" +
      (inp.debtNow > 0 ? "・返済対象の借入のみ減少" : "") + "。" +
      "含み益=現在の含み益+中立リターンの累積(単純モデル)");
    noteLines($("#lt-note"), parts);
  }

  // 横断セットアップ(タブ内トグル)。renderPlan 自体は main.js の renderAll から呼ぶ
  function setupPlan() {
    loadWhatif();
    for (const b of document.querySelectorAll("#cf-horizon button")) {
      b.addEventListener("click", () => {
        $("#cf-horizon button.on").classList.remove("on");
        b.classList.add("on");
        state.planHorizon = Number(b.dataset.mo);
        renderPlan();
      });
    }
    $("#lt-years").addEventListener("input", (e) => {
      state.planYears = Number(e.target.value);
      $("#lt-years-val").textContent = state.planYears + "年";
      renderLongterm();
    });
    for (const b of document.querySelectorAll("#lt-base button")) {
      b.addEventListener("click", () => {
        $("#lt-base button.on").classList.remove("on");
        b.classList.add("on");
        state.ltBase = b.dataset.b;
        // 参照期間が変わると▲と追従中のスライダーが新しい実績へ動く
        syncWhatifSliders();
        renderLongterm();
      });
    }
    // 貯蓄・投資スライダー: 動かすと追従をやめて固定値になる。
    // ▲(実績マーカー)のクリックで追従に戻す
    const refollow = (key) => () => {
      whatif[key] = null;
      saveWhatif();
      syncWhatifSliders();
      renderLongterm();
    };
    $("#whatif-saving").addEventListener("input", (e) => {
      whatif.saving = Number(e.target.value);
      saveWhatif();
      syncWhatifSliders();
      renderLongterm();
    });
    $("#whatif-saving-ref").addEventListener("click", refollow("saving"));
    // 投資率: 表示は%、保持は額(いまの貯蓄額 × 率)
    $("#whatif-invest").addEventListener("input", (e) => {
      const savable = Math.max(0, projectionInputs().effSaving);
      whatif.invest = Math.round(savable * Number(e.target.value) / 100);
      saveWhatif();
      syncWhatifSliders();
      renderLongterm();
    });
    $("#whatif-invest-ref").addEventListener("click", refollow("invest"));
    $("#whatif-loan").addEventListener("input", (e) => {
      whatif.loanRepay = Number(e.target.value);
      $("#whatif-loan-val").textContent = whatif.loanRepay > 0
        ? fmt(whatif.loanRepay) + "/月" : "しない";
      saveWhatif();
      renderLongterm();
    });
    $("#whatif-reset").addEventListener("click", () => {
      // 初回訪問時と同じ状態に戻す(貯蓄・投資は実績追従へ、返済額は既定値へ)
      whatif.drop = new Set();
      whatif.saving = null;
      whatif.invest = null;
      whatif.loanRepay = DEFAULT_LOAN_REPAY;
      saveWhatif();
      renderPlan();
    });
  }

  Object.assign(KB, { renderPlan, setupPlan });
})();
