"use strict";
// tab-assets.js: 資産タブ(資産構成・純資産推移・口座一覧・投資)。
(function () {
  const KB = window.KB;
  const {
    $, TXNS, ACCOUNTS, BALS, COMP, HIST, months, state,
    groupColor, glabel, nwLiabRank, nwTip, nwStackSort, shade, liabShade,
    fmt, sfmt, compact, truncate, cssVar,
    showTip, hideTip, saveGlobals, staleness, mkTile, note, niceStep,
    mkSvg, mkFixedSvg, scrollChart, SVGNS, rect, text, line, polyline, stackGroup,
    segRect,
    svgDefs, stripePattern, stripeCss, monthTick, monthTickPadB, nextSvgSeq,
    circle, vbar, areaBand, xirr, yAxis, legendKey, ttDonut,
    hbarPath, monthlyChart, nowBand,
    isSell, isReinvest, buyCost, sellProceeds, effective,
  } = KB;
  // 資産構成・純資産推移の凡例スウォッチ(.legend でなく .comp-legend 配下
  // なのでサイズをインラインで持つ)
  const SW = "width:10px;height:10px;border-radius:3px;";

  // 共通チャート: 資産構成
  // 上段=口座別(グループ色の濃淡)、下段=グループ別の2レーンを密着させ、
  // その下に負債バーを同じ円/pxスケールで描く。全体は枠で囲い、
  // セグメント間に縁取り・角丸は入れない(色の変化だけで区切る)。
  // 幅が足りるセグメントには名前・金額・割合を直接書く。
  // グループの並びは純資産推移の積み上げ順と同じ(左=積み上げの底)。
  function drawCompBar(box) {
    box.replaceChildren();
    const c = COMP;
    if (!c.assets && !c.liab) {
      note(box, "残高データがありません。data/raw/manual/balances.csv に記入してください");
      return;
    }
    // 口座レベルのデータをグループにまとめる
    const groups = new Map();
    const liabs = [];
    for (const [id, b] of Object.entries(BALS)) {
      const a = ACCOUNTS[id];
      if (!a) continue;
      const item = { id, name: a.name, v: Math.abs(b.balance),
                     date: b.date, note: b.note || "" };
      // マイナス残高の資産(未受渡の買付等)は資産の帯に置けないので
      // 負債と同じ下段に並べる
      if (a.kind === "liability" || b.balance < 0) {
        if (b.balance < 0) liabs.push({ ...item, offset: a.kind !== "liability" });
      } else if (b.balance > 0) {
        const g = a.group || "その他";
        if (!groups.has(g)) groups.set(g, { total: 0, accounts: [] });
        groups.get(g).total += b.balance;
        groups.get(g).accounts.push(item);
      }
    }
    const glist = nwStackSort([...groups.keys()])
      .map((g) => [g, groups.get(g)]);
    const assetTotal = glist.reduce((s, [, g]) => s + g.total, 0);
    // ポートフォリオ(含み益の出所)を持つ口座。証券グループでは右端に置き、
    // グループ帯・口座帯のストライプが同じ右端に揃うようにする
    const pf = (DATA.invest || {}).portfolio;
    for (const [gname, g] of glist) {
      g.accounts.sort((a, b) => b.v - a.v);
      // 濃淡は金額順位で固定(並び替えで色が変わると口座を追えない)
      g.accounts.forEach((a, i) => { a.shade = i; });
      if (gname === "証券" && pf) {
        const i = g.accounts.findIndex((a) => a.id === pf.account);
        if (i >= 0) g.accounts.push(...g.accounts.splice(i, 1));
      }
    }
    const liabTotal = liabs.reduce((s, l) => s + l.v, 0);
    liabs.sort((a, b) => b.v - a.v);
    // ホバー用ドーナツ。カーソル下のセグメントは hl を立てて強調する
    // (ttDonut が枠線+太字にする)。濃淡はバーと同じ階調(core.js shade)
    // グループレーン用: 全体に対する各グループの割合
    const groupWedges = (hover) => glist.map(([g2, gg]) => ({
      name: glabel(g2), value: gg.total, color: groupColor(g2),
      hl: g2 === hover,
    }));
    // 口座レーン用: グループ内の口座の割合
    const accountWedges = (g, color, hover) => g.accounts.map((a2) => ({
      name: a2.name, value: a2.v, color: shade(color, a2.shade),
      hl: a2.id === hover,
    }));

    // 実測幅で原寸(1:1)描画する。固定幅+viewBox縮小だと狭い画面で
    // 文字が小さくなって読めないため、文字サイズは維持し、狭い画面ではレーンを太くして
    // 見やすさとタップのしやすさを補う。幅はタブ表示切替・リサイズで
    // 変わるので ResizeObserver で描き直す(非表示中は幅0なので触らない)
    const availW = box.clientWidth;
    const W = Math.max(300, Math.min(920, availW || 920));
    const laneH = W < 480 ? 26 : 19, gap = 7;
    const H = 2 * laneH + (liabTotal > 0 ? gap + laneH : 0) + 2;
    const scale = (W - 2) / Math.max(assetTotal, liabTotal, 1);
    const svg = mkSvg(W, H);
    if (!box._compRO) {
      box._compRO = new ResizeObserver(() => {
        const w2 = Math.max(300, Math.min(920, box.clientWidth || 0));
        if (box.clientWidth && w2 !== box._compW) drawCompBar(box);
      });
      box._compRO.observe(box);
    }
    box._compW = W;
    const seq = nextSvgSeq();
    // 含み益ストライプ(証券グループの右端=ポートフォリオ口座の上に、
    // 評価額のうち含み益分を斜線で)
    const unrealized = pf && pf.total_pl > 0 ? pf.total_pl : 0;
    const stripeFill = stripePattern(svg);
    const defs = svgDefs(svg);
    // 枠の角丸に合わせて中身を切り抜く(セグメント自体は角丸にしない)
    const assetW = Math.max(1, assetTotal * scale);
    const clip = document.createElementNS(SVGNS, "clipPath");
    clip.setAttribute("id", "comp-clip-" + seq);
    const cr = rect(clip, 1, 1, assetW, 2 * laneH, "none");
    cr.setAttribute("rx", 4);
    defs.appendChild(clip);

    // セグメント内ラベル(幅が許す範囲で 名前→名前+金額+割合 と詳しくする)
    function segLabel(x, w, yc, name, v, share) {
      const mid = `${name} ${compact(v)}`;
      const full = share > 0
        ? `${mid} ${(share * 100).toFixed(0)}%` : mid;
      const pick = w >= full.length * 10.5 + 10 ? full
        : w >= mid.length * 10.5 + 10 ? mid
        : w >= name.length * 10.5 + 8 ? name
        : w >= 40 ? truncate(name, Math.floor((w - 14) / 10.5)) : "";
      if (!pick) return;
      const t = text(svg, x + w / 2, yc + 3.7, pick, "seg-label", "middle");
      t.style.pointerEvents = "none";
      return t;
    }
    // ホバー縁取り(svgkit hlMark)用の輪郭パス。バー端(角丸)に接する
    // セグメントは接する角だけ丸め、枠の丸みに縁取りが追従するようにする。
    // 細いセグメントでは半径を幅に合わせて縮める
    const rp = (x2, y2, w2, h2, corners) => {
      const [tl, tr, br, bl] = corners.map(
        (r2) => Math.min(r2, w2 / 2, h2 / 2));
      return `M${x2 + tl},${y2} h${w2 - tl - tr}` +
        (tr ? ` a${tr},${tr} 0 0 1 ${tr},${tr}` : "") +
        ` v${h2 - tr - br}` +
        (br ? ` a${br},${br} 0 0 1 ${-br},${br}` : "") +
        ` h${-(w2 - br - bl)}` +
        (bl ? ` a${bl},${bl} 0 0 1 ${-bl},${-bl}` : "") +
        ` v${-(h2 - bl - tl)}` +
        (tl ? ` a${tl},${tl} 0 0 1 ${tl},${-tl}` : "") + " z";
    };
    const grp = document.createElementNS(SVGNS, "g");
    grp.setAttribute("clip-path", `url(#comp-clip-${seq})`);
    svg.appendChild(grp);
    let x = 1;
    glist.forEach(([gname, g]) => {
      const gw = g.total * scale;
      const color = groupColor(gname);
      // 下段: グループ
      const r = segRect(grp, x, 1 + laneH, gw, laneH, color, "right");
      const isSec = gname === "証券" && unrealized > 0;
      if (isSec) {
        const sw = Math.min(gw, unrealized * scale);
        const s = rect(grp, x + gw - sw, 1 + laneH, sw, laneH, stripeFill);
        s.style.pointerEvents = "none";
      }
      r.addEventListener("pointermove", (evt) => {
        const pctA = (v) => (v / assetTotal * 100).toFixed(1) + "%";
        const rows = [
          { name: "残高", value: fmt(g.total), color, pct: pctA(g.total) },
        ];
        if (isSec) rows.push({ name: "うち含み益(斜線)",
                               value: fmt(unrealized), pct: pctA(unrealized) });
        for (const a of g.accounts) {
          rows.push({ name: "・" + a.name, value: fmt(a.v), pct: pctA(a.v) });
        }
        showTip(evt, glabel(gname), rows, groupWedges(gname));
      });
      r.addEventListener("pointerleave", hideTip);
      r._hlLabel = segLabel(x, gw, 1 + laneH + laneH / 2, glabel(gname),
                            g.total, g.total / assetTotal);
      r._hlPath = rp(x, 1 + laneH, gw, laneH,
                     [0, 0, x + gw >= 1 + assetW - 0.5 ? 4 : 0,
                      x <= 1.01 ? 4 : 0]);
      // 上段: 口座(同グループ色の濃淡。グループ境界と揃うので上下が繋がる)
      let ax = x;
      g.accounts.forEach((a) => {
        const aw = a.v * scale;
        const ar = segRect(grp, ax, 1, aw, laneH, shade(color, a.shade),
                           "right");
        // ポートフォリオ口座(SBI証券)には口座帯にも含み益の斜線を重ねる
        // (真下のグループ帯の斜線と右端が揃う)
        if (pf && a.id === pf.account && unrealized > 0) {
          const sw = Math.min(aw, unrealized * scale);
          const s = rect(grp, ax + aw - sw, 1, sw, laneH, stripeFill);
          s.style.pointerEvents = "none";
        }
        ar.addEventListener("pointermove", (evt) => {
          const rows = [
            { name: "残高", value: fmt(a.v), color,
              pct: (a.v / assetTotal * 100).toFixed(1) + "%" },
            { name: `${glabel(gname)}内の割合`,
              value: (a.v / g.total * 100).toFixed(1) + "%" },
            { name: "時点", pct: "",
              value: a.date + (a.note ? `(${a.note})` : "") },
          ];
          if (pf && a.id === pf.account && unrealized > 0) {
            rows.splice(1, 0, { name: "うち含み益(斜線)",
                                value: fmt(unrealized) });
          }
          showTip(evt, `${a.name}(${glabel(gname)}内)`, rows,
                  accountWedges(g, color, a.id));
        });
        ar.addEventListener("pointerleave", hideTip);
        ar._hlLabel = segLabel(ax, aw, 1 + laneH / 2, a.name, a.v,
                               a.v / assetTotal);
        ar._hlPath = rp(ax, 1, aw, laneH,
                        [ax <= 1.01 ? 4 : 0,
                         ax + aw >= 1 + assetW - 0.5 ? 4 : 0, 0, 0]);
        ax += aw;
      });
      x += gw;
    });
    // 資産バーの枠(=100%の範囲を明示)
    const frame = rect(svg, 1, 1, assetW, 2 * laneH, "none");
    frame.setAttribute("rx", 4);
    frame.setAttribute("stroke", cssVar("--baseline"));
    frame.style.pointerEvents = "none";
    // 負債バー(同スケール・赤系の濃淡)
    if (liabTotal > 0) {
      const ly = 1 + 2 * laneH + gap;
      const lw = Math.max(1, liabTotal * scale);
      const lclip = document.createElementNS(SVGNS, "clipPath");
      lclip.setAttribute("id", "liab-clip-" + seq);
      const lcr = rect(lclip, 1, ly, lw, laneH, "none");
      lcr.setAttribute("rx", 4);
      defs.appendChild(lclip);
      const lg = document.createElementNS(SVGNS, "g");
      lg.setAttribute("clip-path", `url(#liab-clip-${seq})`);
      svg.appendChild(lg);
      const lcolor = cssVar("--critical");
      let lx = 1;
      liabs.forEach((l, li) => {
        const lwseg = l.v * scale;
        const lr = segRect(lg, lx, ly, lwseg, laneH, liabShade(li),
                           "right");
        lr.addEventListener("pointermove", (evt) => {
          // 負債レーンも口座レーンと同じ文法: 負債内の割合ドーナツ+強調
          const wedges = liabs.map((l2, li2) => ({
            name: l2.name, value: l2.v, color: liabShade(li2),
            hl: l2.id === l.id,
          }));
          showTip(evt, l.name, [
            { name: l.offset ? "控除" : "負債", value: "−" + fmt(l.v),
              color: lcolor, cls: "neg",
              pct: (l.v / liabTotal * 100).toFixed(1) + "%" },
            { name: "時点", pct: "",
              value: l.date + (l.note ? `(${l.note})` : "") },
          ], wedges);
        });
        lr.addEventListener("pointerleave", hideTip);
        lr._hlLabel = segLabel(lx, lwseg, ly + laneH / 2, l.name, l.v, 0);
        const le = lx <= 1.01 ? 4 : 0;
        const re = lx + lwseg >= 1 + lw - 0.5 ? 4 : 0;
        lr._hlPath = rp(lx, ly, lwseg, laneH, [le, re, re, le]);
        lx += lwseg;
      });
      const lframe = rect(svg, 1, ly, lw, laneH, "none");
      lframe.setAttribute("rx", 4);
      lframe.setAttribute("stroke", lcolor);
      lframe.setAttribute("stroke-opacity", "0.6");
      lframe.style.pointerEvents = "none";
    }
    box.appendChild(svg);
    const legend = document.createElement("div");
    legend.className = "comp-legend";
    glist.forEach(([name, g]) => {
      legendKey(legend, SW + "background:" + groupColor(name), glabel(name),
                { value: fmt(g.total),
                  pct: (g.total / assetTotal * 100).toFixed(0) + "%" });
      if (name === "証券" && unrealized > 0) {
        // 含み益は証券の内数なので直後に置く(ストライプの地色も証券色)
        legendKey(legend, SW + stripeCss(groupColor("証券")), "うち含み益",
                  { value: fmt(unrealized) });
      }
    });
    // 負債は口座単位で内訳を出す(バーの濃淡と同じ階調。総額はKPIとバーが持つ)
    liabs.forEach((l, li) => {
      legendKey(legend, SW + "background:" + liabShade(li), l.name,
                { value: "−" + fmt(l.v), cls: "neg" });
    });
    box.appendChild(legend);
  }

  // 純資産スタックの共通描画。資産グループを nwStackSort 順に積み上げ、
  // 証券バンドの上端に含み益ストライプを重ね、負債を0から下向きの面で描く。
  // 純資産推移(ここ)と長期投影の実績側(tab-plan)で共用し、2つの
  // チャートの見た目が食い違わないようにする。
  //   points … NW互換の点列([{groups, pl, liab}])
  //   x, y   … 添字→x座標 / 値→y座標
  //   parent … 面の描画先(減光グループ等。パターンdefsは svg 側に付く)
  // 返り値 { order, plStripe } は凡例用(積んだグループ順と、含み益
  // ストライプを描いたか)
  function drawNwStack(svg, parent, points, x, y, opts) {
    const { groupOp = 0.75, debtOp = 0.9 } = opts || {};
    const gset = new Set(COMP.groups.map(([g]) => g));
    for (const p of points) for (const g of p.groups.keys()) gset.add(g);
    const order = nwStackSort(gset);
    const cums = points.map(() => 0);
    let secBand = null;
    for (const g of order) {
      const topPts = [], botPts = [];
      let any = false;
      points.forEach((p, i) => {
        const v = Math.max(0, p.groups.get(g) || 0);
        if (v > 0) any = true;
        botPts.push([x(i), y(cums[i])]);
        cums[i] += v;
        topPts.push([x(i), y(cums[i])]);
      });
      if (!any) continue;
      if (g === "証券") {
        secBand = points.map((p, i) => ({ top: cums[i],
          val: Math.max(0, p.groups.get(g) || 0) }));
      }
      areaBand(parent, topPts, botPts, groupColor(g), groupOp);
    }
    // 含み益ストライプ: 証券バンドの上端側に、評価額のうち含み益分を斜線で
    // 重ねる(資産構成バーと同じ表現。含み益がマイナスの月は描かない)。
    // 全期間を1ポリゴンで描く。高さ0の月は上下辺が一致して見えず、
    // 含み益が判明している月に向かって自然に開く
    const plStripe = !!(secBand &&
      points.some((p, i) => p.pl > 0 && secBand[i].val > 0));
    if (plStripe) {
      areaBand(parent,
               points.map((p, i) => [x(i), y(secBand[i].top)]),
               points.map((p, i) => [x(i),
                 y(secBand[i].top - Math.min(Math.max(p.pl, 0),
                                             secBand[i].val))]),
               stripePattern(svg), null);
    }
    // 負債: 0から下向きの赤い面(資産の積み上げと対称)。負債の代表色は
    // 負債レーン最上位の赤。資産の帯より濃いのは、薄めると
    // 構成バーの2番手(薄めた赤)と見分けがつかなくなるため
    if (points.some((p) => p.liab < 0)) {
      areaBand(parent,
               points.map((p, i) => [x(i), y(Math.min(0, p.liab))]),
               points.map((p, i) => [x(i), y(0)]),
               cssVar("--critical"), debtOp);
    }
    return { order, plStripe };
  }

  // 共通チャート: 純資産の推移(グループ積み上げ+純資産線)
  // 資産グループを積み上げエリアで内訳表示し、負債を引いた純資産を
  // 濃い線で重ねる。色は資産構成バーと同じグループ順で固定。
  // 表示ウィンドウ(state.nwWin ヶ月)がコンテナ幅に収まる縮尺で全期間を
  // 描き、はみ出す過去は横スクロールで遡る。Y軸はスクロールしても固定。
  const NW_PRESETS = [["6ヶ月", 6], ["1年", 12], ["2年", 24], ["全期間", 0]];
  function redrawNetWorth() {
    drawNetWorth($("#sum-networth"), 240);
    const as = $("#as-networth");
    drawNetWorth(as, as._nwH || 360);
  }

  // 変化の内訳カード(純資産推移の月クリック)。
  // 前月の点 → グループ別の増減 → 負債別の増減 → 当月の点 の橋渡し(棒)と、
  // 証券・年金の分解表。証券は 含み損益の変化 / 買付−売却(約定ベース) /
  // 説明できない残差 に割る。残差は隠さず出す(評価額アンカーと約定・受渡の
  // 時点ずれ、鮮度差がそこに現れる)。年金は拠出累計があれば 拠出 / 運用益。
  function renderNwDelta(i) {
    const NW = KB.NW;
    const p = NW[i], prev = NW[i - 1];
    if (!p || !prev) return;
    const card = $("#nw-delta-card");
    card.hidden = false;
    const cur = p.month === KB.curMonth ? `${p.month}(当月途中)` : p.month;
    const dTotal = p.total - prev.total;
    $("#nw-delta-title").textContent =
      `${prev.month} → ${cur} の資産増減内訳: ${sfmt(dTotal)}`;
    // 橋渡しの項目。増減0のグループは省く
    const items = [{ name: prev.month, v: prev.total, level: true, color: cssVar("--ink") }];
    const gkeys = nwStackSort([...new Set([...prev.groups.keys(), ...p.groups.keys()])]);
    for (const g of gkeys) {
      const d = (p.groups.get(g) || 0) - (prev.groups.get(g) || 0);
      if (d) items.push({ name: glabel(g), g, d, color: groupColor(g),
                          from: prev.groups.get(g) || 0, to: p.groups.get(g) || 0 });
    }
    const liabRank = nwLiabRank(NW);
    const lnames = [...new Set([...prev.liabs.keys(), ...p.liabs.keys()])]
      .sort((a, b) => liabRank.get(a) - liabRank.get(b));
    for (const nm of lnames) {
      const d = -((p.liabs.get(nm) || 0) - (prev.liabs.get(nm) || 0));
      if (d) items.push({ name: nm, liab: true, d, color: liabShade(liabRank.get(nm)),
                          from: -(prev.liabs.get(nm) || 0), to: -(p.liabs.get(nm) || 0) });
    }
    items.push({ name: p.month, v: p.total, level: true, color: cssVar("--ink") });
    drawBridge($("#nw-delta-chart"), items);

    // 詳細内訳の表。橋渡し棒と同じ項目を同じ順に並べ、前月の純資産から
    // 足していくと当月の純資産になる形にする。年金・証券は増減を
    // 口座別でなく原因別に割る(証券なら
    // 預金→投信のような内部の移動は打ち消し合うので出さない)。
    // 残差は隠さず出す(取込時点の差・貴金属の値動き等がここに現れる)
    const end = p.month + "-99", pend = prev.month + "-99";
    const lastPt = (acct, e) => {
      let last = null;
      for (const q of (HIST[acct] || [])) { if (q.date <= e) last = q; else break; }
      return last;
    };
    const gDelta = (g) => (p.groups.get(g) || 0) - (prev.groups.get(g) || 0);
    const rows = [];
    const sections = {};
    sections["証券"] = () => {
      const dSec = gDelta("証券");
      const secIds = new Set(Object.keys(ACCOUNTS).filter((id) =>
        ACCOUNTS[id].kind === "asset" && ACCOUNTS[id].group === "証券"));
      if (!dSec || !secIds.size) return;
      // 証券グループの外との振替=入金・出金。グループ内の口座に振替の記録が
      // あればそれを使い、無い口座だけ外側(銀行側)の記録で補う(二重計上防止)
      const ownTransfer = new Set();
      for (const t of TXNS) if (t.type === "transfer") ownTransfer.add(t.account);
      let inflow = 0, income = 0;
      for (const t of TXNS) {
        if (t.date.slice(0, 7) !== p.month) continue;
        const e = effective(t);
        if (e.type === "transfer" && t.counter) {
          if (secIds.has(t.account) && !secIds.has(t.counter)) inflow += t.amount;
          else if (!secIds.has(t.account) && secIds.has(t.counter)
                   && !ownTransfer.has(t.counter)) inflow -= t.amount;
        } else if (secIds.has(t.account)
                   && (e.type === "income" || e.type === "expense")) {
          income += e.amount;
        }
      }
      const dPl = (p.pl || 0) - (prev.pl || 0);
      const pf = (DATA.invest || {}).portfolio;
      const va = pf && lastPt(pf.account, pend), vb = pf && lastPt(pf.account, end);
      rows.push({ name: "入金 − 出金", value: inflow,
                  note: "銀行などとの間の振替" });
      rows.push({ name: "含み損益の変化", value: dPl,
                  note: "評価日 " + (va ? va.date : "—") + " → " + (vb ? vb.date : "—") });
      if (income) rows.push({ name: "配当・利息など", value: income });
      const resid = dSec - inflow - dPl - income;
      rows.push({ name: "残差", value: resid, neutral: true,
                  note: resid ? "評価額と預金の取込時点の差、貴金属の値動き等" : "" });
    };
    sections["年金"] = () => {
      const dPen = gDelta("年金");
      if (!dPen) return;
      for (const [id, a] of Object.entries(ACCOUNTS)) {
        if (a.kind !== "asset" || a.group !== "年金") continue;
        const pa = lastPt(id, pend), pb = lastPt(id, end);
        const d = (pb ? pb.balance : 0) - (pa ? pa.balance : 0);
        if (!d) continue;
        const span = "残高の時点 " + (pa ? pa.date : "—") + " → " + (pb ? pb.date : "—");
        if (!pa) {
          rows.push({ name: "記録開始", value: d, neutral: true,
                      note: `${a.name}: 前月末の記録がない(それまでの累計を含む)` });
        } else if (pb && pa.contrib_total != null && pb.contrib_total != null) {
          const dc = pb.contrib_total - pa.contrib_total;
          rows.push({ name: "拠出", value: dc, note: span });
          rows.push({ name: "運用益", value: d - dc });
        } else {
          rows.push({ name: a.name, value: d, note: span });
        }
      }
    };
    for (const it of items) {
      if (it.level) {
        const label = it.name === KB.curMonth ? `${it.name} の純資産(当月途中)`
          : `${it.name} 末の純資産`;
        rows.push({ level: true, name: label, value: it.v, color: it.color });
        continue;
      }
      // 負債の増減は返済か新たな利用・借入かを書き添える(カードの+は
      // お金が増えたのでなく、前月の請求を払って未払が減ったという意味)
      const name = it.liab ? `${it.name}(${it.d > 0 ? "返済" : "利用・借入"})` : it.name;
      const note = it.liab
        ? `未払残 ${fmt(-it.from)} → ${fmt(-it.to)}`
        : `残高 ${fmt(it.from)} → ${fmt(it.to)}`;
      rows.push({ head: true, name, value: it.d, color: it.color, note });
      if (it.g && sections[it.g]) sections[it.g]();
    }
    const tbl = $("#nw-delta-table");
    tbl.replaceChildren();
    $("#nw-delta-sub").hidden = !rows.length;
    if (rows.length) {
      const table = document.createElement("table");
      const tb = document.createElement("tbody");
      for (const r of rows) {
        const tr = document.createElement("tr");
        tr.className = r.level ? "level" : r.head ? "head" : "child";
        const td1 = document.createElement("td");
        if (r.color) {
          // 橋渡し棒の同じ項目の棒と色で対応づける
          const sw = document.createElement("span");
          sw.className = "swatch";
          sw.style.cssText += "background:" + r.color;
          td1.appendChild(sw);
        }
        td1.append(r.name);
        const td2 = document.createElement("td");
        td2.className = "num" + (r.level || r.neutral || !r.value ? ""
          : r.value < 0 ? " neg" : " pos");
        td2.textContent = r.level ? fmt(r.value) : r.value ? sfmt(r.value) : "¥0";
        const td3 = document.createElement("td");
        td3.className = "note";
        td3.textContent = r.note || "";
        tr.append(td1, td2, td3);
        tb.appendChild(tr);
      }
      table.appendChild(tb);
      tbl.appendChild(table);
    }
    $("#nw-delta-note").textContent =
      "各点は「その月末までに判明している最新の残高」。口座ごとに取込の" +
      "時点が違うため、その差は残差に入る。";
    card.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }

  // 橋渡し棒(ウォーターフォール)。level の項目は0からの棒、それ以外は
  // 直前の水準からの増減を浮かせて描く。棒は vbar(角丸)、値は棒の外側に書く
  function drawBridge(box, items) {
    box.replaceChildren();
    const n = items.length;
    const padL = 64, padR = 16, padT = 22, padB = 34;
    const availW = box.clientWidth || 700;
    const slot = Math.max(56, Math.min(96, (availW - padL - padR) / n));
    const W = padL + slot * n + padR, H = 240;
    const bw = Math.min(48, slot - 14);
    let level = 0;
    const spans = items.map((it) => {
      const from = it.level ? 0 : level;
      const to = it.level ? it.v : level + it.d;
      level = to;
      return { ...it, from, to };
    });
    const vals = spans.flatMap((s2) => [s2.from, s2.to]).concat(0);
    const maxV = Math.max(...vals), minV = Math.min(...vals);
    const step = niceStep(maxV - minV || 1);
    const top = Math.ceil(maxV / step) * step, bot = Math.floor(minV / step) * step;
    const plotH = H - padT - padB;
    const y = (v) => padT + plotH * (1 - (v - bot) / Math.max(1, top - bot));
    const svg = mkFixedSvg(W, H);
    yAxis(svg, svg, { y, bot, top, step, x0: padL, x1: W - padR, labelX: padL - 6 });
    spans.forEach((s2, i) => {
      const xc = padL + slot * i + slot / 2;
      const lo = Math.min(s2.from, s2.to), hi = Math.max(s2.from, s2.to);
      const h = Math.max(2, y(lo) - y(hi));
      const down = s2.to < s2.from;
      const bar = vbar(svg, xc - bw / 2, down ? y(hi) : y(lo), bw, h, s2.color, down);
      const d = s2.level ? s2.to : s2.d;
      const label = (d < 0 ? "−" : s2.level ? "" : "+") + compact(Math.abs(d));
      const ly = down ? y(lo) + 14 : y(hi) - 5;
      const t = text(svg, xc, ly, label, "bar-label", "middle");
      if (bar) bar._hlLabel = t;
      text(svg, xc, H - padB + 16, truncate(s2.name, Math.floor(slot / 11)), "axis-label", "middle");
      if (i < n - 1) {   // 次の棒へ水準をつなぐ細線
        line(svg, xc + bw / 2, y(s2.to), xc + slot - bw / 2, y(s2.to), cssVar("--muted"), "2,2");
      }
      const hit = rect(svg, xc - slot / 2, padT, slot, plotH, "transparent");
      hit.addEventListener("pointermove", (evt) => {
        showTip(evt, s2.name, s2.level
          ? [{ name: "純資産", value: sfmt(s2.to), color: s2.color }]
          : [{ name: "増減", value: sfmt(s2.d), color: s2.color, cls: s2.d < 0 ? "neg" : "" },
             { name: "前月", value: sfmt(s2.from) }, { name: "今月", value: sfmt(s2.to) }]);
      });
      hit.addEventListener("pointerleave", hideTip);
    });
    box.appendChild(svg);
  }

  // 資産タブの純資産推移は隣のリスク評価カードと同じ行に並ぶ。行の高さは
  // 長い方(通常はリスク評価)が決めるので、余った縦をチャートの高さに
  // 充てて行いっぱいまで伸ばす(縮む方向には触らない: 1列積みのモバイルや
  // 純資産側が長い場合は余りが出ず no-op)
  function fitNetWorth() {
    const box = $("#as-networth");
    if (!box.childElementCount || !box.clientHeight) return;
    const top = box.firstElementChild.getBoundingClientRect().top;
    const bottom = box.lastElementChild.getBoundingClientRect().bottom;
    const spare = box.clientHeight - (bottom - top);
    if (spare > 8) drawNetWorth(box, (box._nwH || 360) + spare);
  }
  function drawNetWorth(box, h) {
    box._nwH = h;   // 幅RO・期間切替の再描画が最後の高さを引き継ぐ
    box.replaceChildren();
    if (KB.NW.length < 2) {
      note(box, "残高アンカーが2ヶ月分未満のため推移を描けません。" +
        "手入力残高やポートフォリオCSVを蓄積すると表示されます");
      return;
    }
    const NW = KB.NW;
    // 積み上げ順は共通規約(支出との距離順。core.js nwStackSort)
    // 期間セレクタ(カード全体がタブリンクの場合があるので伝播を止める)
    const head = document.createElement("div");
    head.className = "nw-head";
    const segEl = document.createElement("span");
    segEl.className = "seg small";
    for (const [label, m] of NW_PRESETS) {
      const b = document.createElement("button");
      b.textContent = label;
      if (m === state.nwWin) b.classList.add("on");
      b.addEventListener("click", (e) => {
        e.stopPropagation();
        state.nwWin = m;
        saveGlobals();
        redrawNetWorth();
      });
      segEl.appendChild(b);
    }
    head.appendChild(segEl);
    box.appendChild(head);
    const liabRank = nwLiabRank(NW);
    const H = h;
    // padR は右端の月ラベル("26/07"等、中央揃え)の半幅ぶん確保する
    const padL = 64, padR = 20, padT = 10, insetL = 8;
    const measured = box.clientWidth;
    const availW = Math.max(280, (measured || 920) - padL);
    const n = NW.length;
    const win = state.nwWin > 0 ? Math.min(state.nwWin, n) : n;
    const mstep = (availW - insetL - padR) / Math.max(1, win - 1);
    const W = insetL + mstep * (n - 1) + padR;
    const padB = monthTickPadB(mstep);
    const plotH = H - padT - padB;
    const stackMax = Math.max(1, ...NW.map((p) =>
      [...p.groups.values()].reduce((s, v) => s + Math.max(0, v), 0)));
    const maxV = Math.max(stackMax, ...NW.map((p) => p.total));
    const minV = Math.min(0, ...NW.map((p) => Math.min(p.total, p.liab)));
    const step = niceStep(maxV - minV);
    const top = Math.ceil(maxV / step) * step;
    const bot = Math.floor(minV / step) * step;
    const y = (v) => padT + plotH * (1 - (v - bot) / Math.max(1, top - bot));
    const x = (i) => insetL + mstep * i;
    // Y軸(固定)とプロット(スクロール)を別SVGに分ける
    const axisSvg = mkFixedSvg(padL, H);
    const svg = mkFixedSvg(W, H);
    yAxis(svg, axisSvg, { y, bot, top, step, x0: 0, x1: W, labelX: padL - 6 });
    const { order, plStripe } = drawNwStack(svg, svg, NW, x, y);
    // 純資産線(負債控除後。マイナスもそのまま描く。点は打たない)
    const ink = cssVar("--ink");
    polyline(svg, NW.map((p, i) => [x(i), y(p.total)]), ink, 2);
    // 月ラベルはスペースが許す限り毎月(狭ければ斜め)。斜めでも入らない
    // 密度なら最新月から等間隔に遡って間引く
    const every = Math.max(1, Math.ceil(18 / mstep));
    NW.forEach((p, i) => {
      if (p.month === KB.curMonth) nowBand(svg, x(i) - mstep / 2, 0, mstep, H);
      if ((n - 1 - i) % every === 0) {
        monthTick(svg, x(i), p.month, mstep * every, H);
      }
      const hit = rect(svg, x(i) - mstep / 2, padT, mstep, plotH, "transparent");
      hit.addEventListener("pointermove", (evt) => {
        const { rows, pie } = nwTip(p, i > 0 ? NW[i - 1] : null, liabRank);
        showTip(evt, p.month, rows, pie);
      });
      hit.addEventListener("pointerleave", hideTip);
      if (box._onMonthClick && i > 0) {
        hit.style.cursor = "pointer";
        hit.addEventListener("click", (e) => { e.stopPropagation(); box._onMonthClick(i); });
      }
    });
    const scroller = document.createElement("div");
    scroller.className = "nw-scroll";
    scroller.appendChild(svg);
    const wrap = document.createElement("div");
    wrap.className = "nw-wrap";
    wrap.append(axisSvg, scroller);
    box.appendChild(wrap);
    scroller.scrollLeft = scroller.scrollWidth;  // 初期表示は最新側
    // タブ表示切替や画面リサイズで幅が変わったら縮尺を取り直す
    box._nwW = measured;
    if (!box._nwRO) {
      box._nwRO = new ResizeObserver(() => {
        if (Math.abs(box.clientWidth - box._nwW) > 1) {
          drawNetWorth(box, box._nwH || h);
        }
      });
      box._nwRO.observe(box);
    }
    // 凡例(グループ+純資産線)
    const legend = document.createElement("div");
    legend.className = "comp-legend";
    for (const g of order) {
      if (!NW.some((p) => (p.groups.get(g) || 0) > 0)) continue;
      legendKey(legend, SW + "opacity:.75;background:" + groupColor(g),
                glabel(g));
      if (g === "証券" && plStripe) {
        // 含み益は証券の内数なので直後に置く(資産構成バーの凡例と同じ表現)
        legendKey(legend, SW + stripeCss(groupColor(g)), "うち含み益");
      }
    }
    if (NW.some((p) => p.liab < 0)) {
      legendKey(legend, SW + "opacity:.9;background:" + cssVar("--critical"),
                "負債(下向き)");
    }
    legendKey(legend, "width:12px;height:3px;border-radius:2px;background:" + ink,
              "純資産(負債控除後)");
    box.appendChild(legend);
  }

  function renderAssetKpis() {
    const box = $("#as-kpis");
    box.replaceChildren();
    mkTile(box, "純資産", COMP.newest ? fmt(COMP.net) : "—",
           "資産 − 負債", COMP.net < 0 ? "neg" : "");
    mkTile(box, "総資産", COMP.newest ? fmt(COMP.assets) : "—",
           COMP.newest ? "時点 " + (COMP.oldest === COMP.newest
             ? COMP.newest : COMP.oldest + "〜" + COMP.newest) : "", "");
    mkTile(box, "負債", COMP.liab > 0 ? "−" + fmt(COMP.liab) : "—",
           "カード未払・借入等", COMP.liab > 0 ? "neg" : "");
    const sec = COMP.groups.find(([g]) => g === "証券");
    const riskTile = mkTile(box, "リスク資産比率",
           sec && COMP.assets > 0 ? (sec[1] / COMP.assets * 100).toFixed(0) + "%" : "—",
           "証券評価額 ÷ 総資産", "");
    // 連動要因での分解はリスク評価カードが担う。タイルはそこへの導線
    riskTile.classList.add("link");
    riskTile.title = "リスク評価カードへ";
    riskTile.addEventListener("click", () =>
      $("#risk-card").scrollIntoView({ block: "start", behavior: "smooth" }));
  }

  function renderAccounts() {
    const tbody = $("#accounts-table tbody");
    tbody.replaceChildren();
    const lastDate = {}, firstDate = {};
    for (const t of TXNS) {
      if (!lastDate[t.account] || t.date > lastDate[t.account]) lastDate[t.account] = t.date;
      if (!firstDate[t.account] || t.date < firstDate[t.account]) firstDate[t.account] = t.date;
    }
    for (const [id, a] of Object.entries(ACCOUNTS)) {
      const anchor = BALS[id];
      if (!a.active && !lastDate[id] && !anchor) continue;
      const tr = document.createElement("tr");
      if (a.howto) tr.title = "取得手順: " + a.howto;
      // 口座名+鮮度ドット(残高アンカーの古さ)
      const tdName = document.createElement("td");
      const dot = document.createElement("span");
      dot.className = "dot" +
        (anchor && !a.synthetic ? " " + staleness(anchor.date, a.update_interval_days) : "");
      tdName.appendChild(dot);
      tdName.appendChild(document.createTextNode(a.name));
      tr.appendChild(tdName);
      for (const c of [
        a.group + (a.kind === "liability" ? "(負債)" : ""),
        !lastDate[id] ? "—" : firstDate[id] === lastDate[id] ? lastDate[id]
          : firstDate[id] + " 〜 " + lastDate[id],
      ]) {
        const td = document.createElement("td");
        td.textContent = c;
        tr.appendChild(td);
      }
      const bal = document.createElement("td");
      bal.className = "num" + (anchor && anchor.balance < 0 ? " neg" : "");
      bal.textContent = anchor ? fmt(anchor.balance) : "—";
      tr.appendChild(bal);
      const asof = document.createElement("td");
      if (anchor) {
        asof.textContent = anchor.date + " ";
        if (anchor.note) {
          const b = document.createElement("span");
          b.className = "badge";
          b.textContent = anchor.note;
          asof.appendChild(b);
        }
      } else {
        asof.textContent = "—";
      }
      tr.appendChild(asof);
      const link = document.createElement("td");
      link.className = "acct-link";
      if (a.url) {
        const aEl = document.createElement("a");
        aEl.href = a.url;
        aEl.target = "_blank";
        aEl.rel = "noopener";
        aEl.textContent = "明細DL ↗";
        link.appendChild(aEl);
      }
      tr.appendChild(link);
      tbody.appendChild(tr);
    }
  }

  // 企業型DC(拠出累計アンカーの分解)
  // DCポータルには拠出履歴の明細がないため、スナップショットの拠出累計と
  // 台帳の給与天引き振替(本人分)からの逆算が分解の上限。
  // 本人分は「この口座宛の振替」の合計(dc側に取引はなく相手口座側のみ)。
  function renderDc() {
    const card = $("#dc-card");
    const entries = Object.entries(BALS)
      .filter(([, b]) => b.contrib_total != null);
    if (!entries.length) { card.hidden = true; return; }
    card.hidden = false;
    const kpis = $("#dc-kpis");
    kpis.replaceChildren();
    const names = [];
    for (const [id, b] of entries) {
      names.push((ACCOUNTS[id] || {}).name || id);
      let own = 0;
      for (const t of TXNS) {
        if (t.type === "transfer" && t.counter === id && t.amount < 0) own += -t.amount;
      }
      const emp = b.contrib_total - own;
      const pl = b.balance - b.contrib_total;
      mkTile(kpis, "評価額", fmt(b.balance), b.date + " 時点", "small");
      mkTile(kpis, "拠出累計", fmt(b.contrib_total),
             "うち本人(給与天引き)" + fmt(own), "small");
      mkTile(kpis, "事業主拠出", fmt(emp), "拠出累計 − 本人分の逆算",
             "small" + (emp < 0 ? " neg" : ""));
      mkTile(kpis, "評価損益", sfmt(pl), "評価額 − 拠出累計",
             "small " + (pl >= 0 ? "pos" : "neg"));
    }
    drawDcAlloc($("#dc-alloc"), entries);
    $("#dc-note").textContent =
      names.join("・") + " のスナップショットから逆算した内訳。" +
      "本人分は台帳の振替(給与天引き)の合計、事業主分はその差で、" +
      "分解の解像度は保存の頻度に依存する。";
  }

  // DCの資産配分バー(資産構成バーと同じ「角丸・境界線なし」の1レーン)。
  // 幅が許すセグメントには名前と金額を直接書き、凡例に割合を添える
  function drawDcAlloc(box, entries) {
    box.replaceChildren();
    const withAlloc = entries.filter(([, b]) => b.alloc);
    if (!withAlloc.length) return;
    if (!box._allocRO) {
      box._allocRO = new ResizeObserver(() => {
        const w = Math.max(300, Math.min(920, box.clientWidth || 0));
        if (box.clientWidth && w !== box._allocW) drawDcAlloc(box, entries);
      });
      box._allocRO.observe(box);
    }
    const W = Math.max(300, Math.min(920, box.clientWidth || 920));
    box._allocW = W;
    for (const [id, b] of withAlloc) {
      const segs = Object.entries(b.alloc).map(([cls, v]) =>
        ({ name: cls, v, color: allocBucket(cls).color }));
      const total = segs.reduce((s, g) => s + g.v, 0);
      if (total <= 0) continue;
      const laneH = W < 480 ? 26 : 19;
      const svg = mkSvg(W, laneH + 2);
      const clip = document.createElementNS(SVGNS, "clipPath");
      clip.setAttribute("id", "dc-alloc-clip-" + nextSvgSeq());
      rect(clip, 1, 1, W - 2, laneH, "none").setAttribute("rx", 4);
      svgDefs(svg).appendChild(clip);
      const g = document.createElementNS(SVGNS, "g");
      g.setAttribute("clip-path", `url(#${clip.getAttribute("id")})`);
      svg.appendChild(g);
      let x = 1;
      const wedges = (hover) => segs.map((s2) =>
        ({ name: s2.name, value: s2.v, color: s2.color, hl: s2.name === hover }));
      for (const s2 of segs) {
        const w = s2.v / total * (W - 2);
        const r = segRect(g, x, 1, w, laneH, s2.color, "right");
        // 資産構成バーと同じ段階でラベルを詳しくする(名前→名前+金額)
        const mid = `${s2.name} ${compact(s2.v)}`;
        const pick = w >= mid.length * 10.5 + 10 ? mid
          : w >= s2.name.length * 10.5 + 8 ? s2.name : "";
        if (pick) {
          const t = text(g, x + w / 2, 1 + laneH / 2 + 3.7, pick, "seg-label", "middle");
          t.style.pointerEvents = "none";
          r._hlLabel = t;
        }
        r.addEventListener("pointermove", (evt) => {
          showTip(evt, (ACCOUNTS[id] || {}).name || id, [
            { name: s2.name, value: fmt(s2.v), color: s2.color,
              pct: Math.round(s2.v / total * 100) + "%" },
          ], wedges(s2.name));
        });
        r.addEventListener("pointerleave", hideTip);
        x += w;
      }
      box.appendChild(svg);
      const legend = document.createElement("div");
      legend.className = "comp-legend";
      for (const s2 of segs) {
        legendKey(legend, SW + "background:" + s2.color, s2.name,
                  { value: fmt(s2.v) + " " + Math.round(s2.v / total * 100) + "%" });
      }
      box.appendChild(legend);
    }
  }

  // 運用カード
  // 概要タブ「運用効率」KPIの詳細。yieldStats の3成分(証券=評価損益+
  // 貴金属等の残差・DC・利息配当。定義は stats.js yieldCtx が正)を
  // ほどいて見せる。月次は yieldMonthly(アンカー月計上・持ち越し)。
  // 色は資産グループの固定色(証券・年金)+利息配当はゴールド
  function renderYield() {
    const card = $("#yield-card");
    const yAll = KB.yieldStats();
    if (!yAll) { card.style.display = "none"; return; }
    card.style.display = "";
    const secCol = groupColor("証券"), dcCol = groupColor("年金"),
          flCol = cssVar("--cat4");
    // 成分バー(全期間と直近6ヶ月)。負の成分があるときだけ0軸を右に寄せ、
    // 左向きの棒で示す
    const parts = $("#yield-parts");
    parts.replaceChildren();
    const y6 = KB.yieldStats(6);
    const wins = [[`全期間(${yAll.months}ヶ月)`, yAll]];
    if (y6) wins.push(["直近6ヶ月", y6]);
    const comps = (y) => [["証券", y.secGain, secCol],
                          ["DC年金", y.dcGain, dcCol],
                          ["利息・配当", y.flows, flCol]];
    const maxAbs = Math.max(1, ...wins.flatMap(([, y]) =>
      comps(y).map(([, v]) => Math.abs(v))));
    const hasNeg = wins.some(([, y]) => comps(y).some(([, v]) => v < 0));
    const W = hasNeg ? 520 : 460, rowH = 24, padL = 92, padR = 78;
    const track = W - padL - padR;
    const zeroX = padL + (hasNeg ? Math.round(track * 0.5) : 0);
    const leftW = zeroX - padL, rightW = padL + track - zeroX;
    // 負の棒の最大幅。左端まで伸ばすと額ラベル(端アンカーで棒の左に付く)が
    // 名前列に密着するため、ラベル幅+2文字ぶんの余白を常に確保する
    const negTrack = Math.max(20, leftW - 97);
    for (const [label, y] of wins) {
      const hd = document.createElement("div");
      hd.style.cssText = "font-size:12.5px;color:var(--ink-2);margin:6px 0 2px";
      const rate = y.annual != null
        ? (y.annual >= 0 ? "+" : "−")
          + (Math.abs(y.annual) * 100).toFixed(1) + "%/年" : "—";
      hd.textContent = `${label}: 計 ${sfmt(y.gain)}(${rate})`;
      parts.appendChild(hd);
      // 原寸+横スクロール(狭い画面で viewBox 縮小すると文字が小さくなって読めない)
      const svg = mkFixedSvg(W, comps(y).length * rowH + 4);
      comps(y).forEach(([name, v, col], i) => {
        const yc = 2 + rowH * i + rowH / 2;
        text(svg, padL - 8, yc + 4, name, "cat-name", "end");
        const bw = Math.max(1, Math.abs(v) / maxAbs
                               * (v >= 0 ? rightW : negTrack));
        hbarPath(svg, v >= 0 ? zeroX : zeroX - bw, yc, bw, 13, col);
        text(svg, v >= 0 ? zeroX + bw + 6 : zeroX - bw - 6, yc + 4,
             sfmt(v), "bar-label", v >= 0 ? "start" : "end");
      });
      if (hasNeg) line(svg, zeroX, 2, zeroX, comps(y).length * rowH + 2,
                       cssVar("--baseline"));
      const sc = document.createElement("div");
      sc.className = "chart-scroll";
      sc.appendChild(svg);
      parts.appendChild(sc);
    }
    // 月次推移(積み上げ。上=利益・下=損失。アンカーの無い月の証券・DCは
    // 計上なし=棒に出ない)
    const legend = $("#yield-legend");
    legend.replaceChildren();
    for (const [n, c] of [["証券", secCol], ["DC(年金)", dcCol],
                          ["利息・配当", flCol]]) {
      legendKey(legend, "background:" + c, n);
    }
    const box = $("#yield-monthly");
    box.replaceChildren();
    const mm = KB.yieldMonthly();
    if (!mm.length) { note(box, "残高履歴がありません"); return; }
    const ms = mm.map((r) => r.m);
    const compRows = mm.map((r) => [
      ["証券", r.sec, secCol], ["DC(年金)", r.dc, dcCol],
      ["利息・配当", r.flows, flCol],
    ]);
    const posTot = compRows.map((cs) =>
      cs.reduce((s, [, v]) => s + Math.max(0, v || 0), 0));
    const negTot = compRows.map((cs) =>
      cs.reduce((s, [, v]) => s + Math.min(0, v || 0), 0));
    const maxP = Math.max(1, ...posTot);
    const step = niceStep(maxP);
    const top = Math.ceil(maxP / step) * step;
    // 下側は損の深さに合わせた細かい目盛りで最小限だけ伸ばす
    // (月次買付・売却チャートの売却側と同じ作法)
    const minN = Math.min(0, ...negTot);
    const nStep = minN < 0 ? niceStep(-minN) : 0;
    const bot = minN < 0 ? -Math.ceil(-minN / nStep) * nStep : 0;
    const padL2 = 52, padT = 10;
    const mc = monthlyChart(ms, { h: 200, per: 44, minW: 320, padL: padL2,
                                  top, bot, step, noAxis: true });
    yAxis(mc.svg, mc.axis, { y: mc.y, top, step, x0: padL2, x1: mc.W - 8 });
    if (bot < 0) {
      line(mc.svg, padL2, mc.y(bot), mc.W - 8, mc.y(bot), cssVar("--grid"));
      text(mc.axis, padL2 - 6, mc.y(bot) + 4, "−" + compact(-bot),
           "axis-label", "end");
    }
    const barW = Math.min(22, mc.band - 12);
    ms.forEach((m, i) => {
      const bx = padL2 + mc.band * i + (mc.band - barW) / 2;
      if (posTot[i] > 0) {
        const bar = stackGroup(mc.svg, bx, mc.y(0), barW,
                               mc.y(0) - mc.y(posTot[i]));
        let cum = 0;
        for (const [, v, c] of compRows[i]) {
          if (!v || v <= 0) continue;
          segRect(bar, bx, mc.y(cum + v), barW,
                  Math.max(1, mc.y(cum) - mc.y(cum + v)), c, "up");
          cum += v;
        }
      }
      if (negTot[i] < 0) {
        const bar = stackGroup(mc.svg, bx, mc.y(0), barW,
                               mc.y(negTot[i]) - mc.y(0), true);
        let cum = 0;
        for (const [, v, c] of compRows[i]) {
          if (!v || v >= 0) continue;
          segRect(bar, bx, mc.y(cum), barW,
                  Math.max(1, mc.y(cum + v) - mc.y(cum)), c, "down");
          cum += v;
        }
      }
      const hit = rect(mc.svg, padL2 + mc.band * i, padT, mc.band, mc.plotH,
                       "transparent");
      hit.addEventListener("pointermove", (evt) => {
        const rows = compRows[i].map(([n, v, c]) => ({
          name: n, value: v == null ? "(アンカー無し)" : sfmt(v), color: c,
        }));
        const tot = compRows[i].reduce((s, [, v]) => s + (v || 0), 0);
        rows.push({ name: "計", value: sfmt(tot) });
        showTip(evt, m, rows);
      });
      hit.addEventListener("pointerleave", hideTip);
      mc.tick(i);
    });
    box.appendChild(mc.wrap);
    mc.done();
  }

  // リスク評価カード
  // 資産・負債を「何の価格に連動するか」で束ねる。分類は粗く保つ
  // (ファンドの国別内訳までは割らない=疑似精度を避ける)。
  // 企業型DCはDCポータルの資産配分(資産クラス別評価額)をそのまま使う。
  // シナリオはざっくりの固定想定で、発生確率は主張しない
  // DCの資産クラス → リスク評価のバケツ(外貨連動 / 円建て変動 / 残りは円建て固定)。
  // 色もそのバケツの色を継ぎ、同じバケツ内は濃淡で区別する(リスク評価の
  // 横棒と見比べられるように)
  function allocBucket(cls) {
    const fx = /外国|海外/.test(cls);
    const dom = !fx && /株式/.test(cls);
    const base = fx ? cssVar("--cat7") : dom ? cssVar("--cat1") : cssVar("--cat2");
    return { fx, dom, color: shade(base, /債券/.test(cls) && fx ? 1 : 0) };
  }
  function renderRisk() {
    const card = $("#risk-card");
    if (!COMP.assets && !COMP.liab) { card.style.display = "none"; return; }
    card.style.display = "";
    const holdings = ((DATA.invest || {}).portfolio || {}).holdings || [];
    const isFx = (n) => /オール[・ ]?カントリー|S&P\s?500/i.test(n || "");
    let fx = 0, dom = 0;
    for (const h of holdings) {
      if (isFx(h.name)) fx += h.value || 0;
      else dom += h.value || 0;
    }
    for (const [id, b] of Object.entries(BALS)) {
      const a = ACCOUNTS[id];
      if (!a || a.kind !== "asset" || b.balance <= 0) continue;
      if (b.alloc) {
        // 資産クラス別内訳を持つ口座(DC)。債券・元本確保型は下の
        // 円建て固定(残差)に落ちる
        for (const [cls, v] of Object.entries(b.alloc)) {
          const { fx: f, dom: d } = allocBucket(cls);
          fx += f ? v : 0; dom += d ? v : 0;
        }
      } else if (a.group === "年金") dom += b.balance;
      else if (/金・銀・プラチナ|貴金属/.test(a.name)) fx += b.balance;
    }
    // 残り(預金・現金・電子マネー・証券口座の現金余力等)はすべて円建て固定
    const cash = Math.max(0, COMP.assets - fx - dom);
    const debt = COMP.liab;
    const rows = [
      ["円建て固定(預金等)", cash, cssVar("--cat2"), "インフレで実質減"],
      ["円建て変動(国内株)", dom, cssVar("--cat1"), "国内株価に連動"],
      ["外貨連動(海外株等)", fx, cssVar("--cat7"), "外国株価と為替に連動"],
      ["固定円負債", -debt, cssVar("--critical"), "インフレで実質減"],
    ];
    const boxE = $("#risk-exposure");
    boxE.replaceChildren();
    // コンテナの実測幅に合わせて棒のトラックだけ伸縮させる(文字は原寸のまま。
    // 固定幅だと2fr列やスマホで数px はみ出して横スクロールが出る)。
    // 幅が変わったら描き直す(非表示タブでは幅0なので既定値で描いておく)
    const availW = boxE.clientWidth;
    const W2 = Math.max(300, Math.min(560, availW || 390));
    boxE._riskW = W2;
    if (!boxE._riskRO) {
      boxE._riskRO = new ResizeObserver(() => {
        const w = Math.max(300, Math.min(560, boxE.clientWidth || 0));
        if (boxE.clientWidth && w !== boxE._riskW) renderRisk();
      });
      boxE._riskRO.observe(boxE);
    }
    const rowH = 26, padL = 134, padR = 70;
    const maxV = Math.max(1, cash, dom, fx, debt);
    // 原寸+横スクロール(狭い画面で viewBox 縮小すると文字が小さくなって読めない)
    const svg = mkFixedSvg(W2, rows.length * rowH + 6);
    rows.forEach(([name, v, col, hint], i) => {
      const yc = 3 + rowH * i + rowH / 2;
      text(svg, padL - 8, yc + 4, truncate(name, 16), "cat-name", "end");
      const bw = Math.max(2, Math.abs(v) / maxV * (W2 - padL - padR));
      hbarPath(svg, padL, yc, bw, 14, col);
      text(svg, padL + bw + 6, yc + 4,
           (v < 0 ? "−" : "") + compact(Math.abs(v)), "bar-label");
      const hit = rect(svg, 0, yc - rowH / 2, W2, rowH, "transparent");
      hit.addEventListener("pointermove", (evt) => {
        showTip(evt, name, [
          { name: v < 0 ? "負債" : "残高",
            value: (v < 0 ? "−" : "") + fmt(Math.abs(v)), color: col,
            pct: v >= 0 && COMP.assets > 0
              ? Math.round(v / COMP.assets * 100) + "%" : "" },
          { name: "特性", value: hint, pct: "" },
        ]);
      });
      hit.addEventListener("pointerleave", hideTip);
    });
    boxE.appendChild(svg);
    // シナリオ応答
    const tiles = $("#risk-scenarios");
    tiles.replaceChildren();
    const net = COMP.net;
    // 各軸を同じ10%で揃えた感応度。%は総資産比(純資産が負の期間は
    // 純資産比だと符号が反転して誤読するため)。
    // 国内株だけの急落は日本固有の事象として実在する(2024-08-05 日経平均
    // −12.4% に対し S&P500 は −3%、2013-05-23 −7.3%)ため独立の軸として出す。
    // 海外株安の単独シナリオは置かない: 外貨連動を一括で扱うこのモデルでは
    // 円高10%と同じ数値になり、別のシナリオに見えて情報が増えないため。
    const SCN = [
      ["全面株安10%", { dom: -0.10, fx: -0.10 }],
      ["国内株安10%", { dom: -0.10 }],
      ["円高10%", { fx: -0.10 }],
      ["インフレ10%", { cash: -0.10, debt: -0.10 }],
    ];
    for (const [name, f] of SCN) {
      const d = Math.round((f.dom || 0) * dom + (f.fx || 0) * fx
                         + (f.cash || 0) * cash + (f.debt || 0) * -debt);
      const pct = COMP.assets > 0
        ? `(${d >= 0 ? "+" : "−"}${Math.abs(d / COMP.assets * 100).toFixed(1)}%)`
        : "";
      mkTile(tiles, name, sfmt(d) + pct,
             `純資産 ${sfmt(net)} → ${sfmt(net + d)}`,
             "small " + (d < 0 ? "neg" : d > 0 ? "pos" : ""));
    }
    // 隣の純資産推移チャートを行の高さに合わせる
    fitNetWorth();
    if (!card._fitRO) {
      card._fitRO = new ResizeObserver(fitNetWorth);
      card._fitRO.observe(card);
    }
  }

  function renderInvest() {
    const inv = DATA.invest || { events: [], portfolio: null };
    const card = $("#invest-card");
    if (!inv.events.length && !inv.portfolio) { card.style.display = "none"; return; }
    const ms = months.slice(-12);
    const kpis = $("#invest-kpis");
    kpis.replaceChildren();
    if (inv.portfolio && inv.portfolio.total_value != null) {
      const pl = inv.portfolio.total_pl || 0;
      mkTile(kpis, "評価額", fmt(inv.portfolio.total_value),
             inv.portfolio.date + " 時点", "small");
      mkTile(kpis, "含み損益", sfmt(pl),
             "取得比 " + (inv.portfolio.total_value - pl > 0
               ? (pl / (inv.portfolio.total_value - pl) * 100).toFixed(1) + "%" : "—"),
             "small " + (pl >= 0 ? "pos" : "neg"));
    }
    const msSet = new Set(ms);
    const evts = inv.events.filter((e) => msSet.has(e.date.slice(0, 7)));
    // 分配金再投資は新規拠出でないため買付額に数えない(investFlows と同じ)
    const invested = evts.filter((e) => !isSell(e) && !isReinvest(e))
      .reduce((s, e) => s + buyCost(e), 0);
    mkTile(kpis, "買付額(12ヶ月)", fmt(invested), evts.length + "件の約定", "small");
    // 金額加重リターン(IRR)。全期間のキャッシュフロー+最終評価額で算出
    if (inv.portfolio && inv.portfolio.total_value != null) {
      const flows = investFlows(inv);
      const irr = xirr(flows);
      mkTile(kpis, "金額加重リターン",
             irr == null ? "—" : (irr >= 0 ? "+" : "") + (irr * 100).toFixed(1) + "%",
             "年率(IRR)",
             "small " + (irr != null && irr < 0 ? "neg" : ""));
    }
    // 商品グループの分類(構成比ドーナツ・月次買付・売却で色と名前を共通化)
    const IG = [
      ["オルカン", /オール[・ ]?カントリー/, cssVar("--cat1")],
      ["S&P500", /S&P\s?500/i, cssVar("--cat5")],
      ["日経", /日経/, cssVar("--cat6")],
      ["TOPIX", /TOPIX/, cssVar("--cat2")],
      ["日高配当", /高配当/, cssVar("--cat4")],
      ["個別", null, cssVar("--cat7")],
      ["その他", null, cssVar("--cat-other")],
    ];
    const igColor = new Map(IG.map(([n, , c]) => [n, c]));
    const igFund = (name) => {
      const hit = IG.find(([, re]) => re && re.test(name || ""));
      return hit ? hit[0] : null;
    };
    // 約定イベントは kind=trade が個別株。保有銘柄(ポートフォリオ)には
    // kind が無いので、先頭の4桁銘柄コードで個別株を見分ける
    const igOf = (e) => igFund(e.name) || (e.kind === "trade" ? "個別" : "その他");
    const igOfHolding = (h) =>
      igFund(h.name) || (/^\d{4} /.test(h.name || "") ? "個別" : "その他");

    const holdings = (inv.portfolio ? inv.portfolio.holdings : [])
      .slice().sort((a, b) => (b.value || 0) - (a.value || 0));

    // 投資構成比率(評価額ベース・商品グループ別ドーナツ。ttDonut を
    // 単体チャートとして使い、扇形ホバーでグループ内の銘柄内訳を出す)。
    // 径はコンテナ実測幅から決めるため、タブ表示切替・リサイズで幅が
    // 変わったら描き直す(資産構成バーと同じ ResizeObserver の作法)
    const alloc = $("#invest-alloc-chart");
    const drawAlloc = () => {
    alloc.replaceChildren();
    if (holdings.length) {
      const byIg = new Map();
      for (const h of holdings) {
        const g = igOfHolding(h);
        if (!byIg.has(g)) byIg.set(g, { total: 0, items: [] });
        const b = byIg.get(g);
        b.total += h.value || 0;
        b.items.push(h);
      }
      const totalV = [...byIg.values()].reduce((s, b) => s + b.total, 0);
      const wedges = IG.filter(([n]) => byIg.has(n))
        .map(([n]) => ({ name: n, value: byIg.get(n).total,
                         color: igColor.get(n) }));
      // 狭い画面では径を縮めて引き出しラベルごと収める(ラベル領域は
      // 左右あわせて170px程度。非表示タブでは幅0なので既定220にフォールバック)
      const aw = alloc.clientWidth;
      const donut = ttDonut(wedges,
                            aw ? Math.min(220, Math.max(150, aw - 170)) : 220);
      for (const el of donut.querySelectorAll("path, circle")) {
        const w = el._wedge;
        if (!w) continue;
        el.addEventListener("pointermove", (evt) => {
          const b = byIg.get(w.name);
          showTip(evt, w.name, [
            { name: "評価額", value: fmt(b.total), color: w.color,
              pct: Math.round(b.total / totalV * 100) + "%" },
            ...b.items.map((h) => ({ name: "・" + truncate(h.name, 14),
              value: fmt(h.value),
              pct: Math.round((h.value || 0) / Math.max(1, b.total) * 100) + "%" })),
          ]);
        });
        el.addEventListener("pointerleave", hideTip);
      }
      alloc.appendChild(donut);
    } else {
      note(alloc, "ポートフォリオデータがありません");
    }
    };
    drawAlloc();
    // 再描画は常に最新の render の閉包で(RO自体は1度だけ張る)
    alloc._draw = drawAlloc;
    alloc._allocW = alloc.clientWidth || 0;
    if (!alloc._allocRO) {
      alloc._allocRO = new ResizeObserver(() => {
        const w = alloc.clientWidth;
        if (w && Math.abs(w - (alloc._allocW || 0)) > 1) {
          alloc._allocW = w;
          alloc._draw();
        }
      });
      alloc._allocRO.observe(alloc);
    }

    // 保有銘柄: 上位5行だけカードに出し、全量はフローティングカードで。
    // 同じファンドがNISAの枠ごとに別行で出るので、預り区分を短い札で添える
    const kubunOf = (h) => {
      const s = h.section || "";
      return /つみたて投資枠/.test(s) ? "積" : /成長投資枠/.test(s) ? "成"
        : /特定/.test(s) ? "特" : /一般/.test(s) ? "般" : "";
    };
    const fillHoldings = (tb, list) => {
      tb.replaceChildren();
      for (const h of list) {
        const tr = document.createElement("tr");
        const tds = [
          [h.name, ""],
          [h.cost != null ? h.cost.toLocaleString() : "—", "num"],
          [h.price != null ? h.price.toLocaleString() : "—", "num"],
          [(h.pl >= 0 ? "+" : "−") + Math.abs(h.pl).toLocaleString()
            + (h.pl_pct != null ? ` (${h.pl_pct > 0 ? "+" : ""}${h.pl_pct}%)` : ""),
            "num" + (h.pl >= 0 ? " pos" : " neg")],
          [fmt(h.value), "num"],
        ];
        for (const [v, cls] of tds) {
          const td = document.createElement("td");
          td.textContent = v;
          if (cls) td.className = cls;
          tr.appendChild(td);
        }
        const k = kubunOf(h);
        if (k) {
          const b = document.createElement("span");
          b.className = "badge";
          b.style.marginLeft = "6px";
          b.textContent = k;
          tr.firstChild.appendChild(b);
        }
        tb.appendChild(tr);
      }
    };
    fillHoldings($("#holdings-table tbody"), holdings.slice(0, 5));
    const more = $("#holdings-more");
    more.hidden = holdings.length <= 5;
    if (holdings.length > 5) {
      more.textContent = `▼ さらに表示(全${holdings.length}銘柄)`;
      more.onclick = () => {
        $("#holdings-title").textContent = `保有銘柄(全${holdings.length}銘柄)`;
        fillHoldings($("#holdings-full-table tbody"), holdings);
        $("#holdings-bg").style.display = "";
      };
    }

    // 月次買付・売却チャート: 商品グループ別の積み上げ。売却は下向きに積む
    const box = $("#invest-chart");
    box.replaceChildren();
    const buys = new Map(ms.map((m) => [m, new Map()]));
    const sells = new Map(ms.map((m) => [m, new Map()]));
    for (const e of evts) {
      // 現金の動きを見るチャートなので分配金再投資(内部取引)は含めない
      if (isReinvest(e)) continue;
      const a = (isSell(e) ? sells : buys).get(e.date.slice(0, 7));
      if (!a) continue;
      const g = igOf(e);
      // 買いは手数料込みのコスト、売りは受取額(amountは負で入るので絶対値)
      a.set(g, (a.get(g) || 0) + (isSell(e)
        ? Math.abs(e.amount || 0) : buyCost(e)));
    }
    const sum = (mm) => [...mm.values()].reduce((s, v) => s + v, 0);
    const maxB = Math.max(1, ...ms.map((m) => sum(buys.get(m))));
    const maxS = Math.max(0, ...ms.map((m) => sum(sells.get(m))));
    // 目盛りは買付側の量を基準に取る。売却側は概して小さく、同じ段幅だと
    // 下半分が空白になるため、売却量に合わせた細かい段で最小限だけ伸ばす
    const step = niceStep(maxB);
    const top = Math.ceil(maxB / step) * step;
    const sStep = maxS > 0 ? niceStep(maxS) : 0;
    const padL = 52, padR = 8;
    // 軸は自前: bot が step の倍数でないため、0〜top の目盛りと bot の
    // 補助線を別々に描く
    const mc = monthlyChart(ms, {
      h: 200, per: 40, minW: 320, padL, padR, top, step, noAxis: true,
      // 最深の売却棒の下にラベル1行分(13px)の余白を確保する。足りなければ
      // 目盛りを1段ずつ下へ伸ばす(ラベルを棒の横へ移さない)
      bot: (plotH) => {
        let b = maxS > 0 ? -Math.ceil(maxS / sStep) * sStep : 0;
        while (maxS > 0 && plotH * (-b - maxS) / (top - b) < 13) b -= sStep;
        return b;
      },
    });
    const { svg, y, band, plotH, W, bot } = mc;
    const padT = 10;
    yAxis(svg, mc.axis, { y, top, step, x0: padL, x1: W - padR });
    if (bot < 0) {
      line(svg, padL, y(bot), W - padR, y(bot), cssVar("--grid"));
      text(mc.axis, padL - 6, y(bot) + 4, compact(-bot), "axis-label", "end");
    }
    const barW = Math.min(24, band - 10);
    // 出現するグループだけの凡例をチャートの上に置く
    const used = new Set();
    for (const mm of [...buys.values(), ...sells.values()]) {
      for (const [g, v] of mm) if (v > 0) used.add(g);
    }
    const legend = document.createElement("div");
    legend.className = "legend";
    for (const [n] of IG) {
      if (used.has(n)) legendKey(legend, "background:" + igColor.get(n), n);
    }
    box.appendChild(legend);
    ms.forEach((m, i) => {
      const bx = padL + band * i + (band - barW) / 2;
      const b = buys.get(m), sl = sells.get(m);
      const bTot = sum(b), sTot = sum(sl);
      if (bTot > 0) {
        const bar = stackGroup(svg, bx, y(0), barW, y(0) - y(bTot));
        let cum = 0;
        for (const [n] of IG) {
          const v = b.get(n) || 0;
          if (v <= 0) continue;
          segRect(bar, bx, y(cum + v), barW,
                  Math.max(1, y(cum) - y(cum + v)), igColor.get(n), "up");
          cum += v;
        }
        text(svg, bx + barW / 2, y(bTot) - 3, compact(bTot),
             "bar-label-sm", "middle");
      }
      if (sTot > 0) {
        const bar = stackGroup(svg, bx, y(0), barW, y(-sTot) - y(0), true);
        let cum = 0;
        for (const [n] of IG) {
          const v = sl.get(n) || 0;
          if (v <= 0) continue;
          segRect(bar, bx, y(-cum), barW,
                  Math.max(1, y(-cum - v) - y(-cum)), igColor.get(n), "down");
          cum += v;
        }
        // 下端の余白は目盛り側で確保済み(bot の拡張)なので常に棒の下に書く
        text(svg, bx + barW / 2, y(-sTot) + 11, compact(sTot),
             "bar-label-sm", "middle");
      }
      const hit = rect(svg, padL + band * i, padT, band, plotH, "transparent");
      hit.addEventListener("pointermove", (evt) => {
        const rows = [{ name: "買付合計", value: fmt(bTot) }];
        for (const [n] of IG) {
          const v = b.get(n) || 0;
          if (v > 0) rows.push({ name: n, value: fmt(v), color: igColor.get(n) });
        }
        if (sTot > 0) {
          rows.push({ name: "売却合計", value: "−" + fmt(sTot) });
          for (const [n] of IG) {
            const v = sl.get(n) || 0;
            if (v > 0) rows.push({ name: n + "(売却)", value: "−" + fmt(v),
                                   color: igColor.get(n) });
          }
        }
        showTip(evt, m, rows);
      });
      hit.addEventListener("pointerleave", hideTip);
      mc.tick(i);
    });
    box.appendChild(mc.wrap);
    mc.done();

    drawInvestCost(inv);
    drawDividends(inv);
  }

  // 投資のキャッシュフロー列(IRR用)。買付=支出(負)、売却=受取(正)。
  // 分配金再投資は投資家の新規拠出でない内部取引なので除外する。
  // 最終フローに評価額(スナップショット日に全額回収したと仮定)を足す。
  function investFlows(inv) {
    const flows = [];
    for (const e of inv.events || []) {
      if (isReinvest(e)) continue;
      flows.push({ date: e.date,
                   amount: isSell(e) ? sellProceeds(e) : -buyCost(e) });
    }
    flows.sort((a, b) => a.date.localeCompare(b.date));
    if (inv.portfolio && inv.portfolio.total_value != null) {
      flows.push({ date: inv.portfolio.date, amount: inv.portfolio.total_value });
    }
    return flows;
  }

  // 元本(累積の取得コスト)と評価額の推移。元本は約定ごとの階段線
  // (下の塗りは線の強調で、意味は元本と同じ)、評価額は分かっている点
  // (value_history = ポートフォリオCSV+資産推移CSV)を結んだだけの
  // 素の折れ線で重ねる。両者の差が含み損益。
  function drawInvestCost(inv) {
    const box = $("#invest-cost-chart");
    box.replaceChildren();
    const evs = (inv.events || []).filter((e) => !isReinvest(e))
      .slice().sort((a, b) => a.date.localeCompare(b.date));
    if (!evs.length) { note(box, "約定データがありません"); return; }
    // 約定1件の元本への寄与(売却時は受取額を元本から控除する簡易法)
    const costOf = (e) => isSell(e) ? -sellProceeds(e) : buyCost(e);
    const costPts = [];
    let cost = 0;
    for (const e of evs) {
      cost += costOf(e);
      costPts.push({ date: e.date, cost: Math.max(0, cost) });
    }
    // 評価額の点(value_history。最新ポートフォリオの点も build 済み)
    const valPts = (inv.value_history || [])
      .map((q) => ({ date: q.date, val: q.value }));
    const lastDate = inv.portfolio ? inv.portfolio.date : costPts[costPts.length - 1].date;
    const allDates = [costPts[0].date, lastDate,
                      ...valPts.map((p) => p.date)].sort();
    const t0 = new Date(allDates[0]).getTime();
    const t1 = new Date(allDates[allDates.length - 1]).getTime();
    const W = Math.max(360, 520), H = 200;
    const padL = 52, padR = 10, padT = 10, padB = 24;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const maxV = Math.max(1, ...costPts.map((p) => p.cost),
                          ...valPts.map((p) => p.val),
                          inv.portfolio ? inv.portfolio.total_value : 0);
    const step = niceStep(maxV);
    const top = Math.ceil(maxV / step) * step;
    // 含み益線(評価額−元本)は含み損の期間に負になるため、必要なときだけ
    // 軸を下に伸ばす
    const costAt = (d) => {
      let c = 0;
      for (const p of costPts) {
        if (p.date <= d) c = p.cost;
        else break;
      }
      return c;
    };
    // 下側は含み損の深さに合わせた細かい目盛りで最小限だけ伸ばす
    // (上側の段幅 step だと、数千円の含み損で1段=数十万ぶん空いてしまう。
    // 月次買付・売却チャートの売却側と同じ作法)
    const minPl = Math.min(0, ...valPts.map((p) => p.val - costAt(p.date)));
    const botStep = minPl < 0 ? niceStep(-minPl) : 0;
    const bot = minPl < 0 ? -Math.ceil(-minPl / botStep) * botStep : 0;
    const x = (d) => padL + plotW * ((new Date(d).getTime() - t0) / Math.max(1, t1 - t0));
    const y = (v) => padT + plotH * (top - v) / (top - bot);
    const svg = mkSvg(W, H);
    yAxis(svg, null, { y, top, step, x0: padL, x1: W - padR });
    if (bot < 0) {
      line(svg, padL, y(bot), W - padR, y(bot), cssVar("--grid"));
      text(svg, padL - 6, y(bot) + 4, "−" + compact(-bot), "axis-label", "end");
    }
    // 元本の階段面(最後の点は評価額日まで水平に伸ばす)
    const stepPts = [];
    costPts.forEach((p, i) => {
      if (i > 0) stepPts.push([x(p.date), y(costPts[i - 1].cost)]);
      stepPts.push([x(p.date), y(p.cost)]);
    });
    stepPts.push([x(lastDate), y(costPts[costPts.length - 1].cost)]);
    const csurf = cssVar("--seq");
    // botPts は左→右の順で渡す(areaBand が内部で反転して閉じる)。
    // 逆順で渡すとポリゴンが自己交差し、階段と対角線の間だけが塗られた
    // 意味のない三角形になる
    areaBand(svg, stepPts, [[x(costPts[0].date), y(0)], [x(lastDate), y(0)]],
             csurf, 0.18);
    polyline(svg, stepPts, csurf, 2);
    // 評価額の折れ線。点は打たず、ツールチップは透明な太線をヒット領域に
    // して最寄りの点を出す(最新ポートフォリオの点も value_history に含まれる)
    const vpts = valPts.slice().sort((a, b) => a.date.localeCompare(b.date));
    const ink = cssVar("--ink");
    // 含み益は他所(資産構成・純資産推移)の斜線ストライプと同じ証券色
    // (--cat1)。実測でなく2線の差なので破線にする
    const plc = cssVar("--cat1");
    const tipAt = (evt, p) => {
      const c = costAt(p.date), pl = p.val - c;
      showTip(evt, p.date, [
        { name: "評価額", value: fmt(p.val), color: ink },
        { name: "元本", value: fmt(c), color: csurf },
        { name: "含み益", value: sfmt(pl), color: plc,
          cls: pl < 0 ? "neg" : "" },
      ]);
    };
    // 含み益の折れ線(評価額実測点ごとの 評価額−元本 を結ぶ。区間内の
    // 補間は評価額線と同じ「約定ジャンプ相殺後の線形」に一致する)
    const plPts = vpts.map((p) => [x(p.date), y(p.val - costAt(p.date))]);
    if (plPts.length >= 2) polyline(svg, plPts, plc, 2, "5 4");
    else if (plPts.length === 1) circle(svg, plPts[0][0], plPts[0][1], 3, plc);
    if (vpts.length >= 2) {
      // 実測点をそのまま結ぶと、買付(元本の垂直ジャンプ)の直後に実測点が
      // ない区間で補間線が元本の階段の角を横切る。約定日には評価額も同額
      // だけ垂直に動かし、残り(相場由来の残差)だけを区間内の時間比で
      // 線形に配分する。合成されるのは区間の内側だけで、実測点の値は不変
      const tms = (d) => new Date(d).getTime();
      const pts = [[x(vpts[0].date), y(vpts[0].val)]];
      for (let i = 0; i < vpts.length - 1; i++) {
        const a = vpts[i], b = vpts[i + 1];
        const steps = evs.filter((e) => a.date < e.date && e.date <= b.date);
        const drift = (b.val - a.val)
          - steps.reduce((s, e) => s + costOf(e), 0);
        const span = Math.max(1, tms(b.date) - tms(a.date));
        let jumped = 0;
        for (const e of steps) {
          const f = (tms(e.date) - tms(a.date)) / span;
          const before = a.val + drift * f + jumped;
          pts.push([x(e.date), y(before)]);
          jumped += costOf(e);
          pts.push([x(e.date), y(before + costOf(e))]);
        }
        pts.push([x(b.date), y(b.val)]);
      }
      polyline(svg, pts, ink, 2);
      const hit = polyline(svg, pts, "transparent", 12);
      hit.style.pointerEvents = "stroke";
      hit.addEventListener("pointermove", (evt) => {
        const r = svg.getBoundingClientRect();
        const sx = (evt.clientX - r.left) / r.width * W;
        let best = vpts[0];
        for (const p of vpts) {
          if (Math.abs(x(p.date) - sx) < Math.abs(x(best.date) - sx)) best = p;
        }
        tipAt(evt, best);
      });
      hit.addEventListener("pointerleave", hideTip);
    } else if (vpts.length === 1) {
      // 1点では線が引けないため点で示す
      const p = vpts[0];
      const c = circle(svg, x(p.date), y(p.val), 3.5, ink);
      c.addEventListener("pointermove", (evt) => tipAt(evt, p));
      c.addEventListener("pointerleave", hideTip);
    }
    // 端の日付ラベル
    text(svg, padL, H - 8, allDates[0].slice(2), "axis-label", "start");
    text(svg, W - padR, H - 8, lastDate.slice(2), "axis-label", "end");
    box.appendChild(svg);
  }

  // 配当は約定イベントでなく証券口座への入金(収入)として明細に入る。
  // 銘柄は摘要の「株式配当金(NISA:非課税) 銘柄名」の括弧までを除いて取る
  const divName = (d) => d.replace(/^[^(]*\([^)]*\)\s*/, "").trim() || d;
  // 配当・分配金の入金明細(証券口座の収入で摘要かカテゴリに配当/分配を含む)
  function dividendTxns() {
    return TXNS.filter((t) => {
      const a = ACCOUNTS[t.account];
      return t.type === "income" && t.amount > 0 && a && a.group === "証券"
        && (/配当|分配/.test(t.category) || /配当|分配/.test(t.description));
    });
  }

  // 受取配当・分配金の年次バー。入金明細に加えて投信の「分配金再投資」も
  // 足す(再投資は入金として明細に出ないが、受け取った分配金には違いない)。
  // 受取のなかった年も詰めずに並べる(抜けると推移が読めない)
  function drawDividends(inv) {
    const box = $("#invest-div-chart");
    box.replaceChildren();
    const byYear = new Map();
    const add = (date, amount, name) => {
      const y = date.slice(0, 4);
      if (!byYear.has(y)) byYear.set(y, { total: 0, names: new Map() });
      const g = byYear.get(y);
      g.total += amount;
      g.names.set(name, (g.names.get(name) || 0) + amount);
    };
    for (const t of dividendTxns()) {
      add(t.date, t.amount, divName(t.description));
    }
    for (const e of (inv.events || [])) {
      if (isReinvest(e)) {
        add(e.date, e.amount || 0, (e.name || "投信") + "(再投資)");
      }
    }
    const years = [...byYear.keys()].sort();
    if (!years.length) { note(box, "配当・分配金の記録がありません"); return; }
    const all = [];
    for (let y = Number(years[0]); y <= Number(years[years.length - 1]); y++) {
      all.push(String(y));
    }
    const W = Math.max(280, all.length * 70 + 60), H = 200;
    const padL = 52, padR = 10, padT = 12, padB = 24;
    const plotH = H - padT - padB;
    const maxV = Math.max(1, ...[...byYear.values()].map((g) => g.total));
    const step = niceStep(maxV);
    const top = Math.ceil(maxV / step) * step;
    const y = (v) => padT + plotH * (1 - v / top);
    const band = (W - padL - padR) / all.length;
    const barW = Math.min(40, band - 20);
    const sc = scrollChart(W, H, padL);
    const svg = sc.plot;
    yAxis(svg, sc.axis, { y, top, step, x0: padL, x1: W - padR });
    const col = cssVar("--good");
    all.forEach((yr, i) => {
      const g = byYear.get(yr);
      const v = g ? g.total : 0;
      const bx = padL + band * i + (band - barW) / 2;
      if (yr === KB.curMonth.slice(0, 4)) {
        nowBand(svg, padL + band * i, 0, band, H);
      }
      if (v > 0) {
        vbar(svg, bx, y(0), barW, y(0) - y(v), col);
        text(svg, bx + barW / 2, y(v) - 3, compact(v), "bar-label-sm", "middle");
      }
      text(svg, bx + barW / 2, H - 8, yr + "年", "axis-label", "middle");
      const hit = rect(svg, padL + band * i, padT, band, plotH, "transparent");
      hit.addEventListener("pointermove", (evt) => {
        const rows = [{ name: "配当合計", value: fmt(v), color: col }];
        const names = g ? [...g.names.entries()].sort((a, b) => b[1] - a[1]) : [];
        for (const [n, amt] of names.slice(0, 8)) {
          rows.push({ name: truncate(n, 14), value: fmt(amt),
                      pct: v > 0 ? Math.round(amt / v * 100) + "%" : "" });
        }
        showTip(evt, yr + "年の配当", rows);
      });
      hit.addEventListener("pointerleave", hideTip);
    });
    box.appendChild(sc.wrap);
    sc.done();
  }

  // 保有銘柄の全量フローティングカード(tab-watch と同じ閉じ方の作法)
  const closeHoldings = () => { $("#holdings-bg").style.display = "none"; };
  $("#holdings-close").addEventListener("click", closeHoldings);
  $("#nw-delta-close").addEventListener("click", () => { $("#nw-delta-card").hidden = true; });
  // 資産タブの純資産推移だけ月クリックで変化の内訳を開く(概要タブはホバーのみ)
  $("#as-networth")._onMonthClick = renderNwDelta;
  $("#holdings-bg").addEventListener("click", (e) => {
    if (e.target === $("#holdings-bg")) closeHoldings();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeHoldings();
  });

  Object.assign(KB, {
    drawCompBar, drawNwStack, drawNetWorth,
    renderAssetKpis, renderAccounts, renderDc, renderInvest,
    renderYield, renderRisk,
    investFlows,
  });
})();
