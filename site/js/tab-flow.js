"use strict";
// tab-flow.js: 収支タブ(月次収支・オシロスコープ・カテゴリ推移・貯蓄率・
// 支出の内訳ドリルダウン・定期支出・KPI)。
(function () {
  const KB = window.KB;
  const {
    $, TXNS, ACCOUNTS, CAT_GROUPS, state, curMonth, months,
    effective, monthlyTotals, periodMonths, shiftMonth, daysOf,
    catGroup, settleDate,
    fmt, sfmt, compact, truncate, cssVar, niceStep, note,
    showTip, hideTip,
    mkSvg, SVGNS, line, rect, text, vbar, stackGroup, hbarPath, polyline, circle,
    svgDefs, nextSvgSeq, areaBand,
    yAxis, legendKey, monthlyChart, nowBand,
    median,
  } = KB;
  // main.js / tab-flow-network.js(後読み込み)の関数はページ全体が
  // 読み終わってから呼ばれる(クリック等のイベントハンドラ内)ため、
  // KB 経由の遅延参照で解決する
  const openMonthDetail = (...a) => KB.openMonthDetail(...a);
  const render = (...a) => KB.render(...a);
  const jumpToTxn = (...a) => KB.jumpToTxn(...a);

  // 共通チャート: 月次収支(グループ棒)
  function drawMonthly(box, ms, txns, opts) {
    const { h = 240, yoyMap = null } = opts || {};
    box.replaceChildren();
    const agg = new Map(ms.map((m) => [m, { income: 0, expense: 0 }]));
    for (const t of txns) {
      const e = effective(t);
      if (e.type !== "income" && e.type !== "expense") continue;
      const a = agg.get(t.date.slice(0, 7));
      if (!a) continue;
      if (e.type === "income") a.income += e.amount;
      else a.expense += -e.amount;   // 返品は自動で相殺される
    }
    const padL = 56, padT = 10;
    const maxV = Math.max(1, ...[...agg.values()].flatMap((a) => [a.income, a.expense]));
    const step = niceStep(maxV);
    const top = Math.ceil(maxV / step) * step;
    // 赤字月があれば軸を下へ伸ばし、収支線をゼロ線の下に出す(棒は0起点のまま)
    const minNet = Math.min(0, ...[...agg.values()].map((a) => a.income - a.expense));
    const bot = minNet < 0 ? -Math.ceil(-minNet / step) * step : 0;
    const mc = monthlyChart(ms, { h, per: 56, minW: 460, padL, top, bot, step });
    const { svg, y, band, plotH } = mc;
    const barW = Math.min(24, (band - 16) / 2 - 1);
    // 収支線は資産タブの純資産線と同じ --ink(黒/白)。「正味」の線という
    // 意味論をそろえ、収入シアン・支出オレンジのどちらにも寄らない
    const inc = cssVar("--income"), exp = cssVar("--expense"), net = cssVar("--ink");
    ms.forEach((m, i) => {
      const a = agg.get(m);
      const cx = padL + band * i + band / 2;
      if (a.income > 0) vbar(svg, cx - barW - 1, y(0), barW, y(0) - y(a.income), inc);
      if (a.expense > 0) vbar(svg, cx + 1, y(0), barW, y(0) - y(a.expense), exp);
      if (band >= 72) {   // 幅が許せば値を直接書く
        if (a.income > 0) text(svg, cx - barW / 2 - 1, y(a.income) - 3,
                               compact(a.income), "bar-label-sm", "middle");
        if (a.expense > 0) text(svg, cx + barW / 2 + 1, y(a.expense) - 3,
                                compact(a.expense), "bar-label-sm", "middle");
      }
      const hit = rect(svg, padL + band * i, padT, band, plotH, "transparent");
      const handler = (evt) => {
        const rows = [
          { name: "収入", value: fmt(a.income), color: inc },
          { name: "支出", value: fmt(a.expense), color: exp },
          { name: "収支", value: fmt(a.income - a.expense), color: net },
        ];
        if (yoyMap) {
          const prev = yoyMap.get(shiftMonth(m, -12));
          if (prev != null) rows.push({ name: "支出(前年同月)", value: fmt(prev) });
        }
        showTip(evt, m, rows);
      };
      hit.addEventListener("pointermove", handler);
      hit.addEventListener("pointerleave", hideTip);
      hit.style.cursor = "pointer";
      hit.addEventListener("click", (evt) => {
        evt.stopPropagation();
        openMonthDetail(m);
      });
      mc.tick(i);
    });
    // 収支(差額)の折れ線。実績のない月では線を切る(0と誤読させない)
    const segs = [[]];
    ms.forEach((m, i) => {
      const a = agg.get(m);
      if (a.income === 0 && a.expense === 0) {
        if (segs[segs.length - 1].length) segs.push([]);
        return;
      }
      segs[segs.length - 1].push([padL + band * i + band / 2, y(a.income - a.expense)]);
    });
    for (const pts of segs) {
      if (pts.length >= 2) {
        polyline(svg, pts, net, 2).style.pointerEvents = "none";
      }
      for (const [px, py] of pts) {
        circle(svg, px, py, 2.5, net).style.pointerEvents = "none";
      }
    }
    box.appendChild(mc.wrap);
    mc.done();
  }

  function drawCatBars(box, items, opts) {
    const { w = 470, rowH = 26, nameLen = 13, clickFilter = false } = opts || {};
    box.replaceChildren();
    if (!items.length) {
      note(box, "該当する支出がありません");
      return;
    }
    const W = w, padL = 158, padR = 72;
    const H = items.length * rowH + 6;
    const maxV = items[0][1];
    const grand = items.reduce((s, [, v]) => s + v, 0);
    const svg = mkSvg(W, H);
    items.forEach(([name, v], i) => {
      // カテゴリの属する中分類の固定色(推移・内訳と共通)
      const col = catGroupColor(catGroup(name));
      const yc = 3 + rowH * i + rowH / 2;
      const bw = Math.max(2, (W - padL - padR) * (v / maxV));
      text(svg, padL - 8, yc + 4, truncate(name, nameLen), "cat-name", "end");
      hbarPath(svg, padL, yc, bw, 14, col);
      text(svg, padL + bw + 6, yc + 4, compact(v), "bar-label");
      const hit = rect(svg, 0, yc - rowH / 2, W, rowH, "transparent");
      if (clickFilter) hit.style.cursor = "pointer";
      hit.addEventListener("pointermove", (evt) => {
        showTip(evt, name + (clickFilter ? "(クリックで絞り込み)" : ""),
                [{ name: "支出", value: fmt(v), color: col,
                   pct: Math.round(v / grand * 100) + "%" }]);
      });
      hit.addEventListener("pointerleave", hideTip);
      if (clickFilter) hit.addEventListener("click", () => {
        if (name === "その他") return;
        state.category = state.category === name ? "" : name;
        $("#f-category").value = state.category;
        hideTip();
        render();
      });
    });
    box.appendChild(svg);
  }

  function expenseItems(txns, topN) {
    const agg = new Map();
    for (const t of txns) {
      const e = effective(t);
      if (e.type !== "expense") continue;
      agg.set(t.category, (agg.get(t.category) || 0) - e.amount);
    }
    const items = [...agg.entries()].filter(([, v]) => v > 0)
      .sort((a, b) => b[1] - a[1]);
    if (items.length > topN) {
      // 「その他」行が1スロット使うので topN-1 で切る(合計 topN 行)
      const rest = items.splice(topN - 1).reduce((s, [, v]) => s + v, 0);
      items.push(["その他", rest]);
    }
    return items;
  }

  // 月内の資金推移(オシロスコープ重ね描き)
  // 各月を「月初=0」からの累積曲線として同じ日軸(1〜31日)に重ねる。
  // cash: 資産口座(給与清算除く)の入出金の累積。振替・引落・給料日を含む
  //       ので「どこで入金され、どこで落ちるか」の波形が見える。
  // flow: 収入−支出の累積(振替除く・収入モード反映)。発生ベースではなく
  //       対外決済ベース: 給与明細(月初日付)は振込日に置き直して累積する。
  function oscilloSeries(ms, txns, mode) {
    const series = new Map(ms.map((m) => [m, new Array(32).fill(0)]));
    // 月×日ごとの内訳(ツールチップの変化要因表示用)
    const items = new Map(ms.map((m) => [m, Array.from({ length: 32 }, () => [])]));
    for (const t of txns) {
      let amt = null, day = t.date;
      if (mode === "cash") {
        const a = ACCOUNTS[t.account];
        if (a && a.kind === "asset" && a.group !== "給与" &&
            t.type !== "adjustment") {
          amt = t.amount;
        }
      } else {
        const e = effective(t);
        if (e.type === "income" || e.type === "expense") {
          amt = e.amount;
          day = settleDate(t);
        }
      }
      if (amt == null) continue;
      const m = day.slice(0, 7);
      const arr = series.get(m);
      if (!arr) continue;
      const d = Number(day.slice(8, 10));
      arr[d] += amt;
      items.get(m)[d].push({ name: t.description, amt });
    }
    for (const arr of series.values()) {
      for (let d = 1; d <= 31; d++) arr[d] += arr[d - 1];
    }
    return { series, items };
  }

  function drawOscillo(box, ms, txns, mode, h, w) {
    box.replaceChildren();
    if (!ms.length) { note(box, "対象月がありません"); return; }
    const { series, items } = oscilloSeries(ms, txns, mode);
    // 当月はデータのある日まで、過去月はその月の日数まで描く
    let curLast = 1;
    for (const t of txns) {
      if (t.date.slice(0, 7) === curMonth) {
        curLast = Math.max(curLast, Number(t.date.slice(8, 10)));
      }
    }
    const lastDayOf = (m) => m === curMonth ? Math.min(curLast, daysOf(m)) : daysOf(m);
    let minV = 0, maxV = 0;
    for (const m of ms) {
      const arr = series.get(m);
      for (let d = 1; d <= lastDayOf(m); d++) {
        if (arr[d] < minV) minV = arr[d];
        if (arr[d] > maxV) maxV = arr[d];
      }
    }
    const W = w, H = h;
    const padL = 64, padR = 12, padT = 10, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const span = Math.max(1, maxV - minV);
    const step = niceStep(span);
    const top = Math.ceil(Math.max(maxV, 0) / step) * step;
    const bot = Math.floor(Math.min(minV, 0) / step) * step;
    const y = (v) => padT + plotH * (1 - (v - bot) / Math.max(1, top - bot));
    const x = (d) => padL + plotW * ((d - 1) / 30);
    const svg = mkSvg(W, H);
    yAxis(svg, null, { y, bot, top, step, x0: padL, x1: W - padR });
    for (const d of [1, 5, 10, 15, 20, 25, 31]) {
      text(svg, x(d), H - 8, d + "日", "axis-label", "middle");
    }
    // 過去月の中央値バンド: 日ごとの累積を過去月で分位に潰して薄く敷く。
    // 当月の線がこの帯から上下どちらに外れているかで、いつもの月と比べた
    // ペースの速さが読める。月ごとの日数差があるので日単位で母数を数える
    const pastMs = ms.filter((m) => m !== curMonth);
    if (pastMs.length >= 3) {
      const loPts = [], midPts = [], hiPts = [];
      for (let d = 1; d <= 31; d++) {
        const vals = pastMs.filter((m) => d <= lastDayOf(m))
          .map((m) => series.get(m)[d]);
        if (vals.length < 3) break;   // 月末は母数が減るので帯を伸ばさない
        loPts.push([x(d), y(KB.quantile(vals, 0.25))]);
        midPts.push([x(d), y(KB.quantile(vals, 0.5))]);
        hiPts.push([x(d), y(KB.quantile(vals, 0.75))]);
      }
      if (midPts.length >= 2) {
        const band = areaBand(svg, hiPts, loPts, cssVar("--ink-2"), 0.13);
        band.style.pointerEvents = "none";
        polyline(svg, midPts, cssVar("--muted"), 1, "3 3")
          .style.pointerEvents = "none";
      }
    }
    const seq = cssVar("--seq");
    // 当月は太さだけでは残光の最前列と紛れるので色を変える。過去月は
    // 比較対象=分析線の --seq、当月は実測の主役線として前景色
    // (純資産推移の純資産線・給与の手取りラインと同じ役割の使い方)
    const nowCol = cssVar("--ink");
    const n = ms.length;
    // 古い月から描いて新しい月を上に。濃さは新しさに比例(残光表現)
    ms.forEach((m, i) => {
      const arr = series.get(m);
      const lastD = lastDayOf(m);
      const pts = [];
      for (let d = 1; d <= lastD; d++) pts.push([x(d), y(arr[d])]);
      if (pts.length < 2) return;
      const isCur = m === curMonth;
      const thick = isCur || i === n - 1;
      const col = isCur ? nowCol : seq;
      const op = isCur || n === 1 ? 1 : 0.18 + 0.82 * (i / (n - 1));
      const pl = polyline(svg, pts, col, thick ? 2.5 : 1.5);
      pl.setAttribute("stroke-opacity", op.toFixed(2));
      // 太い透明線をヒット領域にして、ホバーで月と値を出す
      const hit = polyline(svg, pts, "transparent", 11);
      hit.style.pointerEvents = "stroke";
      hit.addEventListener("pointermove", (evt) => {
        // hlMark は線(polyline)を縁取らない(svgkit hlGeom が null を
        // 返す)ため、残光線の強調だけはここで自前に行う意図的な例外
        pl.setAttribute("stroke-opacity", "1");
        pl.setAttribute("stroke-width", "3");
        const r = svg.getBoundingClientRect();
        const sx = (evt.clientX - r.left) / r.width * W;
        let d = Math.round(1 + (sx - padL) / plotW * 30);
        d = Math.max(1, Math.min(lastD, d));
        const rows = [
          { name: "月初からの累積", value: sfmt(arr[d]), color: col },
          { name: "この日の変化", value: sfmt(arr[d] - arr[d - 1]) },
        ];
        const its = items.get(m)[d];
        if (its.length) {
          rows.push({ header: "主な変化要因" });
          const top = [...its].sort((a, b) => Math.abs(b.amt) - Math.abs(a.amt));
          for (const it of top.slice(0, 3)) {
            rows.push({
              name: it.name.length > 14 ? it.name.slice(0, 13) + "…" : it.name,
              value: sfmt(it.amt),
            });
          }
          if (top.length > 3) {
            rows.push({
              name: `ほか${top.length - 3}件`,
              value: sfmt(top.slice(3).reduce((s, it) => s + it.amt, 0)),
            });
          }
        }
        showTip(evt, `${m}-${String(d).padStart(2, "0")}`, rows);
      });
      hit.addEventListener("pointerleave", () => {
        pl.setAttribute("stroke-opacity", op.toFixed(2));
        pl.setAttribute("stroke-width", thick ? "2.5" : "1.5");
        hideTip();
      });
      hit.style.cursor = "pointer";
      hit.addEventListener("click", (evt) => {
        evt.stopPropagation();
        openMonthDetail(m);
      });
    });
    box.appendChild(svg);
  }

  // 収支: カテゴリ別支出の推移(積み上げ棒)
  // スロット=中分類(定義順で色を固定)。「その他」は中分類のその他+未登録分
  const TREND_SLOTS = Object.keys(CAT_GROUPS).filter((g) => g !== "その他");
  // 中分類の固定色。カテゴリ別推移・支出の内訳・直近30日で共通に使う
  const catGroupColor = (g) => {
    const i = TREND_SLOTS.indexOf(g);
    // 色スロットは --cat1〜9 の9個。中分類がそれを超えた分は透明になる
    // 事故を防ぐため「その他」色に落とす(build も9個超で警告する)
    return i < 0 || i >= 9 ? cssVar("--cat-other") : cssVar("--cat" + (i + 1));
  };

  function renderTrend(txns) {
    const box = $("#trend-chart");
    const legend = $("#trend-legend");
    box.replaceChildren();
    legend.replaceChildren();
    const ms = periodMonths();
    const catColor = catGroupColor;
    const cats = [...TREND_SLOTS, "その他"];
    const agg = new Map(ms.map((m) => [m, new Map()]));
    for (const t of txns) {
      const e = effective(t);
      if (e.type !== "expense") continue;
      const a = agg.get(t.date.slice(0, 7));
      if (!a) continue;
      const c = catGroup(t.category);
      a.set(c, (a.get(c) || 0) - e.amount);
    }
    for (const c of cats) legendKey(legend, "background:" + catColor(c), c);
    const padL = 56, padT = 10;
    const maxV = Math.max(1, ...ms.map((m) =>
      [...agg.get(m).values()].reduce((s, v) => s + Math.max(0, v), 0)));
    const step = niceStep(maxV);
    const top = Math.ceil(maxV / step) * step;
    const mc = monthlyChart(ms, { h: 260, per: 56, minW: 460, padL, top, step });
    const { svg, y, band, plotH } = mc;
    const barW = Math.min(24, band - 16);
    ms.forEach((m, i) => {
      const a = agg.get(m);
      const bx = padL + band * i + (band - barW) / 2;
      let cum = 0;
      const nonzero = cats.filter((c) => (a.get(c) || 0) > 0);
      const total = nonzero.reduce((s, c) => s + a.get(c), 0);
      const bar = stackGroup(svg, bx, y(0), barW, y(0) - y(total));
      nonzero.forEach((c) => {
        const v = a.get(c);
        rect(bar, bx, y(cum + v), barW, Math.max(1, y(cum) - y(cum + v)),
             catColor(c));
        cum += v;
      });
      if (cum > 0) text(svg, bx + barW / 2, y(cum) - 3, compact(cum),
                        "bar-label-sm", "middle");
      const hit = rect(svg, padL + band * i, padT, band, plotH, "transparent");
      const handler = (evt) => showTip(evt, m,
        [{ name: "支出合計", value: fmt(cum) }],
        nonzero.map((c) => ({ name: c, value: a.get(c), color: catColor(c) })));
      hit.addEventListener("pointermove", handler);
      hit.addEventListener("pointerleave", hideTip);
      hit.style.cursor = "pointer";
      hit.addEventListener("click", (evt) => {
        evt.stopPropagation();
        openMonthDetail(m);
      });
      mc.tick(i);
    });
    box.appendChild(mc.wrap);
    mc.done();
  }

  function renderSavings(txns) {
    const box = $("#savings-chart");
    box.replaceChildren();
    const ms = periodMonths();
    const mt = monthlyTotals(txns);
    const rows = ms.map((m) => {
      const inc = mt.inc.get(m) || 0, exp = mt.exp.get(m) || 0;
      return { m, inc, exp, rate: inc > 0 ? (inc - exp) / inc * 100 : null };
    });
    // 移動平均は率の平均でなく、6ヶ月窓の合算収支÷合算収入(月による収入差に頑健)
    rows.forEach((r, i) => {
      const win = rows.slice(Math.max(0, i - 5), i + 1);
      const sInc = win.reduce((s, w) => s + w.inc, 0);
      const sNet = win.reduce((s, w) => s + w.inc - w.exp, 0);
      r.ma = sInc > 0 ? sNet / sInc * 100 : null;
    });
    if (!rows.some((r) => r.rate != null)) {
      note(box, "収入のある月がありません");
      return;
    }
    // 軸レンジは -100%〜100% に制限。無収入に近い月の率(数万%等)は
    // レンジ外としてバーだけ端に張り付け、数字は書かない(ツールチップで見る)
    const minR = Math.min(0, ...rows.filter((r) => r.rate != null)
      .map((r) => Math.max(-100, r.rate)));
    const lo = Math.floor(minR / 25) * 25;
    const hi = 100;
    const clamp = (v) => Math.max(lo, Math.min(hi, v));
    const padL = 46, padT = 10;
    const mc = monthlyChart(ms, { h: 220, padL, top: hi, bot: lo, step: 25,
                                  fmt: (v) => v + "%" });
    const { svg, y, band, plotH } = mc;
    const barW = Math.min(20, band - 12);
    // 正棒は収入シアン(貯蓄率=収支÷収入という実績の収支量なので、
    // 負棒の支出橙と収支ペアで対にする。--seq の青は分析・予測用)
    // 移動平均は分析線なので --seq(中分類色 --cat4 と紛れない)
    const seq = cssVar("--income"), exp = cssVar("--expense"), ma = cssVar("--seq");
    // -100%を超える赤字(レンジ外)の棒は、切れているのではなく実際は
    // もっと深いことを示すため、角丸なしで下端に向けてフェードアウトさせる
    let fadeUrl = null;
    if (rows.some((r) => r.rate != null && r.rate < lo)) {
      const grad = document.createElementNS(SVGNS, "linearGradient");
      grad.setAttribute("id", "sv-fade-" + nextSvgSeq());
      grad.setAttribute("x1", "0"); grad.setAttribute("y1", "0");
      grad.setAttribute("x2", "0"); grad.setAttribute("y2", "1");
      for (const [off, op] of [[0, 1], [1, 0]]) {
        const st = document.createElementNS(SVGNS, "stop");
        st.setAttribute("offset", off);
        st.setAttribute("stop-color", exp);
        st.setAttribute("stop-opacity", op);
        grad.appendChild(st);
      }
      svgDefs(svg).appendChild(grad);
      fadeUrl = `url(#${grad.getAttribute("id")})`;
    }
    rows.forEach((r, i) => {
      const bx = padL + band * i + (band - barW) / 2;
      if (r.rate != null) {
        const v = clamp(r.rate);
        const color = v >= 0 ? seq : exp;
        if (r.rate < lo) rect(svg, bx, y(0), barW, y(lo) - y(0), fadeUrl);
        else if (v >= 0) vbar(svg, bx, y(0), barW, Math.max(1, y(0) - y(v)), color);
        // down指定の vbar は第3引数が上端(=0線)。y(v)を渡すと棒が
        // 0線から切り離されて下に浮く
        else vbar(svg, bx, y(0), barW, Math.max(1, y(v) - y(0)), color, true);
        // レンジ内の率だけ数字を書く。バー下側のラベルが横軸ラベル領域に
        // かかる場合も省略する
        const ly = v >= 0 ? y(v) - 3 : y(v) + 11;
        if (r.rate >= lo && r.rate <= hi && ly <= mc.H - mc.padB - 2) {
          text(svg, bx + barW / 2, ly,
               Math.round(r.rate) + "%", "bar-label-sm", "middle");
        }
      }
      const hit = rect(svg, padL + band * i, padT, band, plotH, "transparent");
      hit.addEventListener("pointermove", (evt) => {
        const tRows = [
          { name: "収入", value: fmt(r.inc) },
          { name: "支出", value: fmt(r.exp) },
        ];
        if (r.rate != null) {
          tRows.push({ name: "貯蓄率", value: r.rate.toFixed(1) + "%",
                       color: r.rate >= 0 ? seq : exp });
        }
        if (r.ma != null) {
          tRows.push({ name: "6ヶ月移動", value: r.ma.toFixed(1) + "%", color: ma });
        }
        showTip(evt, r.m, tRows);
      });
      hit.addEventListener("pointerleave", hideTip);
      hit.style.cursor = "pointer";
      hit.addEventListener("click", (evt) => {
        evt.stopPropagation();
        openMonthDetail(r.m);
      });
      mc.tick(i);
    });
    const maPts = rows.map((r, i) => r.ma == null ? null
      : [padL + band * i + band / 2, y(clamp(r.ma))]).filter(Boolean);
    if (maPts.length >= 2) polyline(svg, maPts, ma, 2);
    box.appendChild(mc.wrap);
    mc.done();
  }

  // 収支: 支出の内訳(ドリルダウン)
  // カテゴリ → 店・摘要 → 明細行 とクリックで掘れる。「犯人」に到達する導線
  function ddRow(name, value, share, maxV, color) {
    const row = document.createElement("div");
    row.className = "dd-row";
    const tri = document.createElement("span");
    tri.className = "tri";
    tri.textContent = "▶";
    const nm = document.createElement("span");
    nm.className = "dd-name";
    nm.textContent = name;
    nm.title = name;
    const track = document.createElement("span");
    track.className = "dd-track";
    const bar = document.createElement("span");
    bar.className = "dd-bar";
    bar.style.display = "block";
    bar.style.width = Math.max(1, value / maxV * 100) + "%";
    if (color) bar.style.background = color;
    track.appendChild(bar);
    const amt = document.createElement("span");
    amt.className = "dd-amt";
    amt.textContent = fmt(value);
    const pct = document.createElement("span");
    pct.className = "dd-pct";
    pct.textContent = (share * 100).toFixed(0) + "%";
    row.append(tri, nm, track, amt, pct);
    return row;
  }

  // 摘要→明細の下位2層(カテゴリ行の下にぶら下がる部分)
  function buildKeys(container, keysMap, parentTotal, maxG, color) {
    const keys = [...keysMap.entries()].sort((a, b) => b[1].total - a[1].total);
    for (const [name, k] of keys) {
      const r2 = ddRow(name, k.total, k.total / parentTotal, maxG, color);
      const leaves = document.createElement("div");
      leaves.style.display = "none";
      let built2 = false;
      r2.addEventListener("click", (ev) => {
        ev.stopPropagation();
        r2.classList.toggle("open");
        const s2 = r2.classList.contains("open");
        leaves.style.display = s2 ? "" : "none";
        if (!s2 || built2) return;
        built2 = true;
        // この摘要を定点観測で開くボタン(店・サービス単位の推移)
        const wb = KB.watchButton(name, "この摘要を定点観測");
        wb.style.margin = "2px 0 4px 22px";
        leaves.appendChild(wb);
        const rows = [...k.txns].sort((a, b) => b.date.localeCompare(a.date));
        for (const t of rows.slice(0, 50)) {
          const leaf = document.createElement("div");
          leaf.className = "dd-leaf";
          leaf.title = "クリックで明細タブの該当レコードへ(分類根拠を表示)";
          const d = document.createElement("span");
          d.className = "d";
          d.textContent = t.date;
          const acc = document.createElement("span");
          acc.textContent = ACCOUNTS[t.account]
            ? ACCOUNTS[t.account].name : t.account;
          const amt = document.createElement("span");
          amt.className = "a";
          amt.textContent = fmt(-t.amount);
          const go = document.createElement("span");
          go.className = "go";
          go.textContent = "↗";
          leaf.append(d, acc, amt, go);
          leaf.addEventListener("click", (e2) => {
            e2.stopPropagation();
            // jumpToTxn 経由で飛ぶ(フィルタが立っていると対象行が明細表に
            // 現れずフォーカスが黙って失われるため、邪魔な条件を外して飛ぶ)
            jumpToTxn(t);
          });
          leaves.appendChild(leaf);
        }
        if (rows.length > 50) {
          note(leaves, `他${rows.length - 50}件は明細タブで`);
        }
      });
      container.append(r2, leaves);
    }
  }

  function renderDrilldown(txns, box) {
    box = box || $("#drilldown");
    box.replaceChildren();
    // 中分類 → カテゴリ → 摘要 → 明細 の4層。チャートの中分類と同じ括りで
    // 掘り始められるようにする
    const groups = new Map();
    for (const t of txns) {
      const e = effective(t);
      if (e.type !== "expense") continue;
      const v = -e.amount;
      const g = catGroup(t.category);
      if (!groups.has(g)) groups.set(g, { total: 0, cats: new Map() });
      const gr = groups.get(g);
      gr.total += v;
      if (!gr.cats.has(t.category))
        gr.cats.set(t.category, { total: 0, keys: new Map() });
      const c = gr.cats.get(t.category);
      c.total += v;
      const key = KB.watchKey(t.description);
      if (!c.keys.has(key)) c.keys.set(key, { total: 0, txns: [] });
      const k = c.keys.get(key);
      k.total += v;
      k.txns.push(t);
    }
    const items = [...groups.entries()].filter(([, g]) => g.total > 0)
      .sort((a, b) => b[1].total - a[1].total);
    if (!items.length) { note(box, "該当する支出がありません"); return; }
    const grand = items.reduce((s, [, g]) => s + g.total, 0);
    // バーは全階層でトップレベルの最大値を基準にする。名前列が階層分
    // 縮んでバー列のX位置が揃うため、階層ごとに100%の基準を変えると
    // 親より小さい子が同じ長さのバーになって意味が通らない
    const max1 = items[0][1].total;
    for (const [gname, g] of items) {
      // 中分類の固定色を行の色として下位階層まで引き継ぐ
      const col = catGroupColor(gname);
      const row = ddRow(gname, g.total, g.total / grand, max1, col);
      const children = document.createElement("div");
      children.className = "dd-children";
      children.style.display = "none";
      let built = false;
      row.addEventListener("click", () => {
        row.classList.toggle("open");
        const show = row.classList.contains("open");
        children.style.display = show ? "" : "none";
        if (!show || built) return;
        built = true;
        // 中分類が同名カテゴリ1つだけなら段を省いて摘要から
        if (g.cats.size === 1 && g.cats.has(gname)) {
          buildKeys(children, g.cats.get(gname).keys, g.total, max1, col);
          return;
        }
        const cs = [...g.cats.entries()].sort((a, b) => b[1].total - a[1].total);
        for (const [cat, c] of cs) {
          const r2 = ddRow(cat, c.total, c.total / g.total, max1, col);
          const sub = document.createElement("div");
          sub.className = "dd-children";
          sub.style.display = "none";
          let built2 = false;
          r2.addEventListener("click", (ev) => {
            ev.stopPropagation();
            r2.classList.toggle("open");
            const s2 = r2.classList.contains("open");
            sub.style.display = s2 ? "" : "none";
            if (!s2 || built2) return;
            built2 = true;
            buildKeys(sub, c.keys, c.total, max1, col);
          });
          children.append(r2, sub);
        }
      });
      box.append(row, children);
    }
  }

  // 収支: 定期支出(サブスク宣言ベース・値上げ検出)
  // 集計は schedule.js の declaredSubs(rules.toml [[recurring]] 宣言 ×
  // build のタグ付与)に集約。ここではテーブル表示(累計・値上げ検出)を持つ。

  // 直近3ヶ月の月額中央値が、それ以前の月額中央値から3%を超えて変わって
  // いれば改定(値上げ/値下げ)とみなす(3ヶ月未満しか無い/比較対象が
  // ない場合は判定しない)。dir: "up"=値上げ / "down"=値下げ
  function subHike(s) {
    const ms = [...s.series.keys()].sort();
    if (ms.length < 4) return null;
    const recent = median(ms.slice(-3).map((m) => s.series.get(m)));
    const prior = median(ms.slice(0, -3).map((m) => s.series.get(m)));
    if (prior <= 0) return null;
    if (recent > prior * 1.03) return { from: prior, to: recent, dir: "up" };
    if (recent < prior * 0.97) return { from: prior, to: recent, dir: "down" };
    return null;
  }

  function renderSubs(txns) {
    const tbody = $("#subs-table tbody");
    tbody.replaceChildren();
    // 行(月額・周期・出現)は全期間の実績から。累計支払だけは現在の
    // 期間フィルタとの交差(期間を絞って「この期間にいくら払ったか」を見る用)
    // 固定費宣言(kind=fixed)はサブスク表に並べない(概要の固定費集計用)
    const subs = KB.declaredSubs().filter((s) => s.kind !== "fixed");
    $("#subs-card").style.display = subs.length ? "" : "none";
    const inPeriod = new Set(txns.map((t) => t.id));
    for (const s of subs) {
      const cum = s.txns.reduce(
        (sum, t) => sum + (inPeriod.has(t.id) ? Math.abs(t.amount) : 0), 0);
      const tr = document.createElement("tr");
      if (!s.active) tr.classList.add("sub-ended");
      const cells = [
        [s.name, ""],
        [fmt(Math.round(s.monthly)), "num"],
        [s.cycle === "yearly" ? "年払い" : "月払い", ""],
        [s.months + "ヶ月", ""],
        [s.last, ""],
        [fmt(Math.round(s.monthly * 12)), "num"],
        [fmt(cum), "num"],
      ];
      for (const [v, cls] of cells) {
        const td = document.createElement("td");
        td.textContent = v;
        if (cls) td.className = cls;
        tr.appendChild(td);
      }
      // 行クリックで詳細(定点観測モーダルの流用: 月別推移・明細・改定)。
      // 表記揺れ統合後の明細集合(s.txns)をそのまま渡す
      tr.style.cursor = "pointer";
      tr.title = "クリックで詳細(月別推移・明細・改定)";
      tr.addEventListener("click", () => {
        KB.openWatch(s.name,
          { txns: s.txns, hike: subHike(s), title: "定期支出" });
      });
      tbody.appendChild(tr);
    }
    renderSubsHistory();
  }

  // 収支: 定期支出の履歴(月次積み上げエリア)
  // 現金主義: 支払った月に計上し、未払月は0(帯が潰れる)。年払いの尖塔も
  // クレジット消化中の0期間も、財布から出た事実のまま描く(按分しない)。
  // 積み上げ順は出現月数の多い長寿系列が下(ベースロード)、変動の激しい
  // 新参が上澄みに乗る。色は宣言の定義順に --cat1〜9 の固定割当
  // (表示順・件数から導かない。中分類色と同じ流儀)。10本目以降は「その他」。

  // 凡例クリックで一時的に隠している系列(キー=系列名、合算帯は「その他」)。
  // 1系列だけ桁違いに大きいと他が縦軸ごと潰れるため、外して残りを読む用。
  // 描画セッション限り(uistate に永続しない)
  const subsHidden = new Set();

  function renderSubsHistory() {
    const box = $("#subs-history-chart");
    const legend = $("#subs-history-legend");
    box.replaceChildren();
    legend.replaceChildren();
    const ms = periodMonths();
    // 期間内に支払のある系列だけ描く(終了して久しい系列で凡例を汚さない)
    const all = KB.declaredSubs()
      .filter((s) => s.kind !== "fixed" && ms.some((m) => s.series.has(m)));
    $("#subs-history-card").style.display = all.length ? "" : "none";
    if (!all.length) return;
    // 色: 宣言定義順(DATA.recurring)で固定
    const slot = new Map((DATA.recurring || []).map((d, i) => [d.name, i]));
    const colorOf = (name) => slot.get(name) < 9
      ? cssVar(`--cat${slot.get(name) + 1}`) : cssVar("--cat-other");
    // 積み上げ順: 長寿(出現月数)降順、同数なら初出が古い方を下に
    const ordered = all.slice().sort((a, b) =>
      (b.months - a.months) || a.txns[0].date.localeCompare(b.txns[0].date));
    // 10本目以降は「その他」1本に合算(色スロット9個の規約)
    let series = ordered.map((s) => ({
      key: s.name, name: s.name, color: colorOf(s.name),
      vals: ms.map((m) => s.series.get(m) || 0),
    }));
    if (series.length > 9) {
      const rest = series.slice(9);
      series = series.slice(0, 9);
      series.push({
        key: "その他", name: `その他(${rest.length}件)`,
        color: cssVar("--cat-other"),
        vals: ms.map((_, i) => rest.reduce((sum, s) => sum + s.vals[i], 0)),
      });
    }
    // 隠した系列は描画と縦軸から除く(凡例には残す=再表示の導線)
    const shown = series.filter((s) => !subsHidden.has(s.key));
    const totals = ms.map((_, i) => shown.reduce((s, x) => s + x.vals[i], 0));
    const maxV = Math.max(1, ...totals);
    const padL = 46, padT = 10;
    const step = niceStep(maxV);
    const top = Math.ceil(maxV / step) * step;
    const mc = monthlyChart(ms, { h: 220, padL, top, step });
    const { svg, y, band, plotH } = mc;
    // 各系列を下から積む。月内は平坦なプラトー、月境は境界の前後 r ずつを
    // 使った斜面で隣月の水準へ遷移する(垂直の崖にしない)。期間の両端は
    // 外へ向かう斜面を作らず平坦のまま切る。
    // topPts/botPts とも左→右で渡す(areaBand が botPts を内部反転する)。
    // 塗りは他の積み上げ棒と同じくベタ・境界線なし(輪郭線を引くと薄い帯の
    // 線が下の系列のシルエットをなぞって別系列の山に見えてしまう)
    const r = band * 0.25;
    const px0 = (i) => padL + band * i + (i > 0 ? r : 0);
    const px1 = (i) => padL + band * (i + 1) - (i < ms.length - 1 ? r : 0);
    const base = ms.map(() => 0);
    for (const s of shown) {
      const topPts = [], botPts = [];
      ms.forEach((_, i) => {
        topPts.push([px0(i), y(base[i] + s.vals[i])],
                    [px1(i), y(base[i] + s.vals[i])]);
        botPts.push([px0(i), y(base[i])], [px1(i), y(base[i])]);
      });
      areaBand(svg, topPts, botPts, s.color);
      ms.forEach((_, i) => { base[i] += s.vals[i]; });
    }
    // 月境の目盛(縦の点線)。斜面遷移で境界が曖昧になるのを補う。
    // 帯より後に描いて手前に重ねる(後続のヒット領域がさらに上に乗るので
    // ホバーは妨げない)
    for (let i = 1; i < ms.length; i++)
      line(svg, padL + band * i, padT, padL + band * i, mc.H - mc.padB,
           cssVar("--grid"), "3 3");
    // 月バンドのヒット領域: その月の内訳(上の帯から順)+合計とドーナツ
    ms.forEach((m, i) => {
      const hit = rect(svg, padL + band * i, padT, band, plotH, "transparent");
      hit.addEventListener("pointermove", (evt) => {
        const present = shown.filter((s) => s.vals[i] > 0).reverse();
        const rows = present.map((s) => ({
          name: s.name, value: fmt(s.vals[i]), color: s.color,
        }));
        rows.push({ name: "合計", value: fmt(totals[i]) });
        showTip(evt, m, rows,
                present.map((s) => ({ name: s.name, value: s.vals[i],
                                      color: s.color })));
      });
      hit.addEventListener("pointerleave", hideTip);
      mc.tick(i);
    });
    for (const s of series) {
      const key = legendKey(legend, "background:" + s.color, s.name);
      if (subsHidden.has(s.key)) key.classList.add("off");
      key.title = "クリックで表示/非表示(縦軸も追従)";
      key.addEventListener("click", () => {
        if (subsHidden.has(s.key)) subsHidden.delete(s.key);
        else subsHidden.add(s.key);
        renderSubsHistory();
      });
    }
    box.appendChild(mc.wrap);
    mc.done();
  }

  // 収支: 前年同月比(YoY)
  function renderYoY() {
    const box = $("#yoy-chart");
    const legend = $("#yoy-legend");
    box.replaceChildren();
    legend.replaceChildren();
    const modeBtn = $("#yoy-mode button.on");
    const mode = modeBtn ? modeBtn.dataset.k : "expense";
    const MT = monthlyTotals(TXNS);
    const map = mode === "income" ? MT.inc : MT.exp;
    const curYear = Number(curMonth.slice(0, 4));
    const prevYear = curYear - 1;
    const base = mode === "income" ? cssVar("--income") : cssVar("--expense");
    const mm = Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0"));
    const rows = mm.map((m) => ({
      m, cur: map.get(`${curYear}-${m}`) || 0, prev: map.get(`${prevYear}-${m}`) || 0,
    }));
    if (rows.every((r) => !r.cur && !r.prev)) {
      note(box, "比較できるデータがありません"); return;
    }
    const W = 560, H = 240, padL = 46, padR = 8, padT = 22, padB = 26;
    const plotH = H - padT - padB;
    const maxV = Math.max(1, ...rows.flatMap((r) => [r.cur, r.prev]));
    const step = niceStep(maxV);
    const top = Math.ceil(maxV / step) * step;
    const y = (v) => padT + plotH * (1 - v / top);
    const svg = mkSvg(W, H);
    yAxis(svg, null, { y, top, step, x0: padL, x1: W - padR });
    const band = (W - padL - padR) / 12;
    const barW = Math.min(11, (band - 6) / 2);
    rows.forEach((r, i) => {
      const cx = padL + band * i + band / 2;
      // 当月は当年側の棒だけが月の途中(前年と同条件で比べられない)
      if (`${curYear}-${r.m}` === curMonth) {
        nowBand(svg, padL + band * i, 0, band, H);
      }
      // 前年(薄い)を左、当年(濃い)を右
      const prevBar = vbar(svg, cx - barW - 1, y(0), barW, y(0) - y(r.prev), base);
      if (prevBar) prevBar.setAttribute("fill-opacity", "0.35");
      vbar(svg, cx + 1, y(0), barW, y(0) - y(r.cur), base);
      // 差分ラベル(当年 vs 前年)
      if (r.prev > 0 && r.cur > 0) {
        const d = (r.cur - r.prev) / r.prev * 100;
        const t = text(svg, cx, y(Math.max(r.cur, r.prev)) - 4,
          (d >= 0 ? "+" : "") + Math.round(d) + "%", "bar-label-sm", "middle");
        t.setAttribute("fill", (mode === "expense") === (d >= 0)
          ? cssVar("--critical") : cssVar("--good"));
      }
      text(svg, cx, H - 8, Number(r.m) + "月", "axis-label", "middle");
      const hit = rect(svg, padL + band * i, padT, band, plotH, "transparent");
      hit.addEventListener("pointermove", (evt) => {
        showTip(evt, Number(r.m) + "月", [
          { name: curYear + "年", value: fmt(r.cur), color: base },
          { name: prevYear + "年", value: fmt(r.prev) },
          { name: "差", value: sfmt(r.cur - r.prev) },
        ]);
      });
      hit.addEventListener("pointerleave", hideTip);
    });
    box.appendChild(svg);
    // 凡例
    legendKey(legend, `background:${base}`, curYear + "年");
    legendKey(legend, `background:${base};opacity:0.35`, prevYear + "年");
    $("#yoy-note").textContent =
      `${curYear}年と${prevYear}年の同月比較。ラベルは前年比(${mode === "expense" ? "支出増=赤" : "収入増=緑"})`;
  }

  // 収支: 日別の支出ヒートマップ
  function renderHeatmap(txns) {
    const box = $("#heatmap-chart");
    // 日次の支出合計(給与清算口座を除く=控除の月初集中を排除)。生の支出額
    const dayMap = new Map();
    const detail = new Map();   // 日→[{name,amt}]
    for (const t of txns) {
      if (t.type !== "expense" || t.amount >= 0) continue;
      const a = ACCOUNTS[t.account];
      if (a && a.group === "給与") continue;
      const d = t.date;
      dayMap.set(d, (dayMap.get(d) || 0) - t.amount);
      if (!detail.has(d)) detail.set(d, []);
      detail.get(d).push({ name: t.description, amt: -t.amount });
    }
    if (!dayMap.size) { box.replaceChildren(); note(box, "対象の支出がありません"); return; }
    const max = KB.quantile([...dayMap.values()], 0.95) || 1;
    KB.drawHeatmapCal(box, dayMap, {
      color: cssVar("--expense"), max, weekdayAvg: true,
      tipRows: (day, v) => {
        const rows = [{ name: "支出合計", value: fmt(v), color: cssVar("--expense") }];
        const its = (detail.get(day) || []).sort((a, b) => b.amt - a.amt);
        for (const it of its.slice(0, 3)) {
          rows.push({ name: truncate(it.name, 14), value: fmt(it.amt) });
        }
        if (its.length > 3) {
          rows.push({ name: `ほか${its.length - 3}件`,
            value: fmt(its.slice(3).reduce((s, it) => s + it.amt, 0)) });
        }
        return rows;
      },
    });
    $("#heatmap-note").textContent = "色が濃いほど支出が多い日(給与清算の" +
      "控除は除外)。右は曜日別の平均支出(支出のない日も含む全日平均)";
  }

  function renderKpis(txns) {
    let income = 0, expense = 0;
    for (const t of txns) {
      const e = effective(t);
      if (e.type === "income") income += e.amount;
      else if (e.type === "expense") expense += -e.amount;
    }
    $("#kpi-income").textContent = fmt(income);
    $("#kpi-income-sub").textContent = state.incomeMode === "net"
      ? "手取りベース" : "総支給ベース";
    $("#kpi-expense").textContent = fmt(expense);
    const net = income - expense;
    const netEl = $("#kpi-net");
    netEl.textContent = sfmt(net);
    netEl.className = "value " + (net >= 0 ? "pos" : "neg");
    $("#kpi-net-sub").textContent = state.months ? `直近${state.months}ヶ月` : "全期間";
    const rateEl = $("#kpi-rate");
    if (income > 0) {
      const rate = net / income * 100;
      rateEl.textContent = rate.toFixed(1) + "%";
      rateEl.className = "value " + (rate >= 0 ? "" : "neg");
    } else {
      rateEl.textContent = "—";
      rateEl.className = "value";
    }
  }

  Object.assign(KB, {
    drawMonthly, drawCatBars, expenseItems,
    drawOscillo,
    TREND_SLOTS, catGroupColor, renderTrend, renderSavings,
    renderDrilldown,
    subHike, renderSubs, renderKpis,
    renderYoY, renderHeatmap,
  });
})();
