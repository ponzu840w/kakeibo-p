"use strict";
// tab-year.js: 年次タブ。年ごとの収入・支出・貯蓄率・純資産の変化・
// 法定控除(社会保険料・税)・支出のカテゴリ内訳を1画面に置く
// (確定申告・年末の振り返り用の視点。月次は収支タブの領分)。
// 期間・口座・検索フィルタは反映しない(年の全体像が主旨)。
// 収入モード(総支給/手取り)には追従する。
(function () {
  const KB = window.KB;
  const {
    $, TXNS, NW, curMonth, state,
    effective, catGroup, fmt, sfmt, cYen, compact, niceStep,
    mkTile, note, showTip, hideTip,
    scrollChart, rect, text, stackGroup, yAxis, legendKey, nowBand,
  } = KB;

  // 年ごとの集計。income/expense は収入モード反映(effective)、
  // ded は給与清算口座の法定控除の生値(モードに依らず「払った額」)
  function yearAgg() {
    const years = new Map();
    const of = (y) => {
      if (!years.has(y)) {
        years.set(y, { income: 0, expense: 0, byGroup: new Map(),
                       social: 0, tax: 0 });
      }
      return years.get(y);
    };
    for (const t of TXNS) {
      const yr = t.date.slice(0, 4);
      const a = KB.ACCOUNTS[t.account];
      if (a && a.group === "給与" && t.type === "expense") {
        if (t.category === "社会保険料") of(yr).social += -t.amount;
        if (t.category === "税金") of(yr).tax += -t.amount;
      }
      const e = effective(t);
      if (e.type === "income") {
        of(yr).income += e.amount;
      } else if (e.type === "expense") {
        const g = of(yr);
        g.expense += -e.amount;
        const grp = catGroup(t.category);
        g.byGroup.set(grp, (g.byGroup.get(grp) || 0) - e.amount);
      }
    }
    return years;
  }

  // 年末(12月。当年は最新月)の純資産と前年末比。NW は月次点列
  function yearEndNw() {
    const map = new Map();   // "YYYY" → {total, month}
    for (const p of NW) {
      map.set(p.month.slice(0, 4), { total: p.total, month: p.month });
    }
    return map;   // 後勝ち=その年の最終月
  }

  function renderYear() {
    const years = yearAgg();
    const nwEnd = yearEndNw();
    const ys = [...years.keys()].sort();
    if (!ys.length) return;
    const curYear = curMonth.slice(0, 4);

    // KPI(当年の年初来)
    const kpis = $("#yr-kpis");
    kpis.replaceChildren();
    const cy = years.get(curYear);
    if (cy) {
      const net = cy.income - cy.expense;
      mkTile(kpis, `収入(${curYear}年・年初来)`, fmt(cy.income),
             state.incomeMode === "net" ? "手取りベース" : "総支給ベース", "");
      mkTile(kpis, "支出", fmt(cy.expense), "振替・調整除く", "");
      mkTile(kpis, "収支", sfmt(net), `〜${curMonth.slice(5)}月`,
             net >= 0 ? "pos" : "neg");
      mkTile(kpis, "貯蓄率", cy.income > 0
               ? (net / cy.income * 100).toFixed(1) + "%" : "—",
             "年初来 収支÷収入", "");
      const soc = cy.social + cy.tax;
      mkTile(kpis, "法定控除(年初来)", soc > 0 ? "−" + fmt(soc) : "—",
             `社会保険料 ${cYen(cy.social)}・税 ${cYen(cy.tax)}`,
             soc > 0 ? "neg" : "small");
    }

    // 年次テーブル(新しい年が上)
    const tbody = $("#yr-table tbody");
    tbody.replaceChildren();
    for (const y of [...ys].reverse()) {
      const g = years.get(y);
      const net = g.income - g.expense;
      const nw = nwEnd.get(y);
      const prevNw = nwEnd.get(String(Number(y) - 1));
      const dNw = nw && prevNw ? nw.total - prevNw.total : null;
      const tr = document.createElement("tr");
      const cells = [
        [y + "年" + (y === curYear ? "(進行中)" : ""), ""],
        [fmt(g.income), "num"],
        [fmt(g.expense), "num"],
        [sfmt(net), "num " + (net >= 0 ? "pos" : "neg")],
        [g.income > 0 ? (net / g.income * 100).toFixed(1) + "%" : "—", "num"],
        [nw ? fmt(nw.total) : "—", "num" + (nw && nw.total < 0 ? " neg" : "")],
        [dNw != null ? sfmt(dNw) : "—",
         "num " + (dNw != null ? (dNw >= 0 ? "pos" : "neg") : "")],
        [g.social > 0 ? fmt(g.social) : "—", "num"],
        [g.tax > 0 ? fmt(g.tax) : "—", "num"],
      ];
      for (const [v, cls] of cells) {
        const td = document.createElement("td");
        td.textContent = v;
        if (cls) td.className = cls;
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
    $("#yr-note").textContent =
      "収入・支出は収入モード(総支給/手取り)に追従。年末純資産はその年の" +
      "最終判明月(当年は最新月)の純資産。社会保険料・税は給与明細の" +
      "法定控除の生値(モードに依らず実際に払った額)";

    // 年間支出のカテゴリ内訳(中分類の積み上げ棒)
    const box = $("#yr-cat-chart");
    const legend = $("#yr-cat-legend");
    box.replaceChildren();
    legend.replaceChildren();
    const catColor = KB.catGroupColor;
    const cats = [...KB.TREND_SLOTS, "その他"];
    const used = cats.filter((c) => ys.some((y) =>
      (years.get(y).byGroup.get(c) || 0) > 0));
    for (const c of used) legendKey(legend, "background:" + catColor(c), c);
    const padL = 56, padR = 8, padT = 10, padB = 26, H = 260;
    const W = Math.max(320, padL + padR + ys.length * 96);
    const band = (W - padL - padR) / Math.max(1, ys.length);
    const plotH = H - padT - padB;
    const maxV = Math.max(1, ...ys.map((y) => years.get(y).expense));
    const step = niceStep(maxV);
    const top = Math.ceil(maxV / step) * step;
    const y = (v) => padT + plotH * (1 - v / top);
    const sc = scrollChart(W, H, padL);
    const svg = sc.plot;
    yAxis(svg, sc.axis, { y, top, step, x0: padL, x1: W - padR });
    const barW = Math.min(44, band - 24);
    ys.forEach((yr, i) => {
      const g = years.get(yr);
      const bx = padL + band * i + (band - barW) / 2;
      if (yr === curYear) nowBand(svg, padL + band * i, 0, band, H);
      const nonzero = cats.filter((c) => (g.byGroup.get(c) || 0) > 0);
      if (g.expense > 0) {
        const bar = stackGroup(svg, bx, y(0), barW, y(0) - y(g.expense));
        let cum = 0;
        for (const c of nonzero) {
          const v = g.byGroup.get(c);
          rect(bar, bx, y(cum + v), barW, Math.max(1, y(cum) - y(cum + v)),
               catColor(c));
          cum += v;
        }
        text(svg, bx + barW / 2, y(g.expense) - 3, compact(g.expense),
             "bar-label-sm", "middle");
      }
      text(svg, bx + barW / 2, H - 8, yr + "年", "axis-label", "middle");
      const hit = rect(svg, padL + band * i, padT, band, plotH, "transparent");
      hit.addEventListener("pointermove", (evt) => {
        const rows = [
          { name: "支出合計", value: fmt(g.expense), pct: "100%" },
          ...nonzero.map((c) => ({
            name: c, value: fmt(g.byGroup.get(c)), color: catColor(c),
            pct: g.expense > 0
              ? Math.round(g.byGroup.get(c) / g.expense * 100) + "%" : "",
          })),
          { header: "参考" },
          { name: "収入", value: fmt(g.income) },
          { name: "収支", value: sfmt(g.income - g.expense),
            cls: g.income >= g.expense ? "" : "neg" },
        ];
        showTip(evt, yr + "年" + (yr === curYear ? "(進行中)" : ""), rows,
                nonzero.map((c) => ({ name: c, value: g.byGroup.get(c),
                                      color: catColor(c) })));
      });
      hit.addEventListener("pointerleave", hideTip);
    });
    box.appendChild(sc.wrap);
    sc.done();
    if (!ys.some((yr) => years.get(yr).expense > 0)) {
      note(box, "支出データがありません");
    }
  }

  Object.assign(KB, { renderYear });
})();
