"use strict";
// tab-salary.js: 給与タブ(支給・控除の内訳推移、手取り率の推移)。
(function () {
  const KB = window.KB;
  const {
    $, TXNS, curMonth, shiftMonth, state,
    fmt, cYen, compact, truncate, cssVar, monthLabel, niceStep,
    showTip, hideTip, mkTile, note,
    scrollChart, text, rect, vbar, stackGroup, polyline, circle,
    yAxis, legendKey, monthlyChart, nowBand,
  } = KB;

  // 給与明細(kyuyo清算口座)の徹底分析。給与と賞与はmemoの接頭辞で区別し、
  // 別系列として扱う。フィルタの影響は受けない(常に明細の生値)。
  // KPIタイルだけはグローバル収入モード(総支給/手取り)に追従する。
  // チャート群は支給→控除の分解そのものが主題なので常に総支給ベース。
  // 法定控除(社会保険料・税)と任意控除(社食・DC・組合費等)を区別する
  const dedGroup = (d) =>
    /(年金|健康保険|介護保険|雇用保険|社会保険)/.test(d) ? "社会保険料"
    : /税/.test(d) ? "税" : "任意控除";
  const DED_NAMES = ["社会保険料", "税", "任意控除"];
  const DED_LABEL = { "社会保険料": "社会保険料(法定)", "税": "税(法定)",
                      "任意控除": "任意控除(社食等)" };

  function kyuyoGroups() {
    const out = new Map();   // "YYYY-MM|給与" → 集計
    for (const t of TXNS) {
      if (t.account !== "kyuyo") continue;
      const kind = (t.memo || "").startsWith("賞与") ? "賞与" : "給与";
      const m = t.date.slice(0, 7);
      const k = m + "|" + kind;
      if (!out.has(k)) {
        out.set(k, { month: m, kind, gross: 0, items: new Map(),
                     ded: new Map(), detail: new Map() });
      }
      const g = out.get(k);
      if (t.amount > 0) {
        g.gross += t.amount;
        g.items.set(t.description,
                    (g.items.get(t.description) || 0) + t.amount);
      } else {
        const grp = dedGroup(t.description);
        g.ded.set(grp, (g.ded.get(grp) || 0) - t.amount);
        g.detail.set(t.description,
                     (g.detail.get(t.description) || 0) - t.amount);
      }
    }
    return [...out.values()].sort((a, b) => a.month.localeCompare(b.month));
  }
  const netOf = (g) =>
    g.gross - [...g.ded.values()].reduce((s, v) => s + v, 0);
  // 法定控除(社会保険料・税)のみ引いた手取り。グローバル収入モードの
  // 「手取り」と同じ定義(任意控除は「もらった上で支出した」扱い)
  const legalNetOf = (g) => g.gross - (g.ded.get("社会保険料") || 0)
                                    - (g.ded.get("税") || 0);

  // 支給項目の色スロット(給与・賞与横断の上位5項目+その他)。
  // 控除色(--cat6/4/1)と被らないカテゴリ色を使う
  function salItemSlots(groups) {
    const tot = new Map();
    for (const g of groups) {
      for (const [n, v] of g.items) tot.set(n, (tot.get(n) || 0) + v);
    }
    const slots = [...tot.entries()].sort((a, b) => b[1] - a[1])
      .slice(0, 5).map(([n]) => n);
    const names = [...slots, "その他支給"];
    const colors = [2, 3, 5, 7, 8].map((i) => cssVar("--cat" + i))
      .concat([cssVar("--cat-other")]);
    // 時間外勤務手当はグレー系スロットに落ちると「その他支給」と見分けが
    // つかないため、警告的な意味も込めて真っ赤で固定する
    const colorOf = (n) => n === "時間外勤務手当"
      ? cssVar("--critical") : colors[names.indexOf(n)];
    return { slots, names, colorOf };
  }
  const DED_COLORS = () => ({ "社会保険料": cssVar("--cat6"),
                              "税": cssVar("--cat4"),
                              "任意控除": cssVar("--cat1") });

  // 給与と賞与を1つに束ねた分解チャート。月バンドは等間隔(テンポ維持)で、
  // 賞与のある月だけ給与の隣に賞与の棒が近接して並ぶ。
  // 各棒は 左レーン=支給項目の積み上げ / 右レーン=控除を
  // 総支給の高さから吊り下げ。控除の下端=手取りに線を引き、線の外側に
  // 手取り額を書く(ペア月の給与側は左へ、それ以外は右へはみ出す)
  function drawSalaryCombined(box, payLegend, dedLegend, groups) {
    box.replaceChildren();
    payLegend.replaceChildren();
    dedLegend.replaceChildren();
    // 右肩の3点スイッチ: 給与のみ / 両方 / 控除のみ。
    // 控除のみでは控除を0から積み上げ、控除合計にスケールを合わせて拡大する
    const modeBtn = $("#sal-mode button.on");
    const mode = modeBtn ? modeBtn.dataset.mode : "both";
    const showPay = mode !== "ded", showDed = mode !== "pay";
    const dedTot = (g) => DED_NAMES.reduce((s, n) => s + (g.ded.get(n) || 0), 0);
    const ink = cssVar("--ink");
    const dedColors = DED_COLORS();
    const pal = salItemSlots(groups);
    if (showPay) {
      for (const n of pal.names) {
        legendKey(payLegend, "background:" + pal.colorOf(n), truncate(n, 12));
      }
    }
    if (showDed) {
      for (const n of DED_NAMES) {
        legendKey(dedLegend, "background:" + dedColors[n], DED_LABEL[n] || n);
      }
      if (showPay) {
        legendKey(dedLegend, "height:3px;border-radius:2px;background:" + ink,
                  "手取り");
      }
    }
    // 月ごとに束ねる(給与が先、賞与が隣)
    const byMonth = new Map();
    for (const g of groups) {
      if (!byMonth.has(g.month)) byMonth.set(g.month, []);
      byMonth.get(g.month).push(g);
    }
    const months = [...byMonth.keys()].sort().slice(-13);
    if (!months.length) { note(box, "データがありません"); return; }
    const shown = months.flatMap((m) => byMonth.get(m));
    // 手取り額はラインの下に書くため、右は最小限の余白でよい
    const H = 260, padL = 56, padR = 12, padT = 12, padB = 26;
    const plotH = H - padT - padB;
    const band = 84, entityW = 26, hw = entityW / 2, pairGap = 4;
    const W = padL + months.length * band + padR;
    const maxV = Math.max(1, ...shown.map((g) => showPay ? g.gross : dedTot(g)));
    const step = niceStep(maxV);
    const top = Math.ceil(maxV / step) * step;
    const y = (v) => padT + plotH * (1 - v / top);
    const sc = scrollChart(W, H, padL);
    const svg = sc.plot;
    yAxis(svg, sc.axis, { y, top, step, x0: padL, x1: W - padR });
    months.forEach((m, mi) => {
      if (m === curMonth) nowBand(svg, padL + band * mi, 0, band, H);
      // 月内の支給順に並べる: 賞与(10日頃)が先、給与(25日頃)が後
      const ents = byMonth.get(m)
        .sort((a, b) => (a.kind === "賞与" ? -1 : 1) - (b.kind === "賞与" ? -1 : 1));
      const paired = ents.length > 1;
      const totalW = ents.length * entityW + (ents.length - 1) * pairGap;
      const x0 = padL + band * mi + (band - totalW) / 2;
      ents.forEach((g, ei) => {
        const bx = x0 + ei * (entityW + pairGap);
        const net = netOf(g);
        // 給与のみ/両方は総支給、控除のみは控除合計が棒の高さ
        const barTop = showPay ? g.gross : dedTot(g);
        const bar = stackGroup(svg, bx, y(0), entityW, y(0) - y(barTop));
        if (bar && showPay) {
          // 支給項目の積み上げ(控除表示時は左レーンのみ、非表示時は全幅)
          const payW = showDed ? hw : entityW;
          const vals = new Map();
          for (const [n, v] of g.items) {
            const key = pal.slots.includes(n) ? n : "その他支給";
            vals.set(key, (vals.get(key) || 0) + v);
          }
          let cum = 0;
          for (const n of pal.names) {
            const v = vals.get(n) || 0;
            if (v <= 0) continue;
            rect(bar, bx, y(cum + v), payW, Math.max(1, y(cum) - y(cum + v)),
                 pal.colorOf(n));
            cum += v;
          }
          // 右レーン: 控除を総支給の高さから吊り下げ。
          // 下端(=手取りの水位)から下は空けておく
          if (showDed) {
            let yCur = y(g.gross);
            for (const n of DED_NAMES) {
              const v = g.ded.get(n) || 0;
              if (v <= 0) continue;
              const hgt = Math.max(1, y(0) - y(v));
              rect(bar, bx + hw, yCur, hw, hgt, dedColors[n]);
              yCur += hgt;
            }
          }
        } else if (bar) {
          // 控除のみ: 0から全幅で積み上げ(控除スケールで拡大表示)
          let cum = 0;
          for (const n of DED_NAMES) {
            const v = g.ded.get(n) || 0;
            if (v <= 0) continue;
            rect(bar, bx, y(cum + v), entityW,
                 Math.max(1, y(cum) - y(cum + v)), dedColors[n]);
            cum += v;
          }
        }
        if (barTop > 0) {
          // 棒のトップ値(総支給/控除合計)。ペア月は外側寄せで隣とぶつけない
          const topAnchor = paired ? (ei === 0 ? "end" : "start") : "middle";
          const topX = paired ? (ei === 0 ? bx + entityW : bx) : bx + hw;
          text(svg, topX, y(barTop) - 3, compact(barTop),
               "bar-label-sm", topAnchor);
          // 手取りライン: 棒からちょっとはみ出させ、手取り額はラインの下に
          // 置く。ラインの下でも支給レーン(左半分)には被せない:
          // 控除レーンの下は空なので、通常はそこから右へ書き出す。
          // ペアの左側(賞与)は右隣の給与棒に当たるため線の左端から左へ
          if (showPay && showDed) {
            const flip = paired && ei === 0;
            const x1 = flip ? bx - 6 : bx;
            const x2 = flip ? bx + entityW : bx + entityW + 6;
            polyline(svg, [[x1, y(net)], [x2, y(net)]], ink, 2);
            if (flip) {
              text(svg, x1, y(net) + 11, compact(net), "bar-label-sm", "end");
            } else {
              text(svg, bx + hw, y(net) + 11, compact(net),
                   "bar-label-sm", "start");
            }
          }
        }
        // ツールチップ(ペア月はバンドを給与/賞与で分割)
        const hitX = paired
          ? (ei === 0 ? padL + band * mi : x0 + entityW + pairGap / 2)
          : padL + band * mi;
        const hitW = paired
          ? (ei === 0 ? x0 + entityW + pairGap / 2 - hitX
                      : padL + band * (mi + 1) - hitX)
          : band;
        const hit = rect(svg, hitX, padT, hitW, plotH, "transparent");
        hit.addEventListener("pointermove", (evt) => {
          showSalaryTip(evt, g, pal, dedColors, mode);
        });
        hit.addEventListener("pointerleave", hideTip);
      });
      text(svg, padL + band * mi + band / 2, H - 8,
           m.slice(2).replace("-", "/"), "axis-label", "middle");
    });
    box.appendChild(sc.wrap);
    sc.done();
  }

  // 給与ツールチップ: 内容は3点スイッチに追従する。
  //   両方     … 二重ドーナツ(外=手取り+控除、内=支給項目。総額が同じ
  //              なので同心で意味が通る)+ 支給/控除/手取りの全セクション行
  //   給与のみ … 支給項目の単リング+支給セクションのみ
  //   控除のみ … 控除3群の単リング+控除・手取りセクションのみ
  function showSalaryTip(evt, g, pal, dedColors, mode) {
    const net = netOf(g);
    const showPay = mode !== "ded", showDed = mode !== "pay";
    // 構成比は独立カラムで揃える(ドーナツの%と同じ総支給比)
    const pct = (v) => g.gross > 0
      ? Math.round(v / g.gross * 100) + "%" : "";
    const rows = [];
    const items = [...g.items.entries()].sort((a, b) => b[1] - a[1]);
    if (showPay) {
      rows.push({ header: "支給" },
                { name: "総支給", value: fmt(g.gross), pct: "100%" });
      for (const [n, v] of items.slice(0, 6)) {
        rows.push({ name: truncate(n, 14), value: fmt(v), pct: pct(v),
                    color: pal.colorOf(pal.slots.includes(n) ? n : "その他支給") });
      }
      if (items.length > 6) {
        const rest = items.slice(6).reduce((s, [, v]) => s + v, 0);
        rows.push({ name: `他${items.length - 6}件`, value: fmt(rest),
                    pct: pct(rest) });
      }
    }
    if (showDed) {
      if (!showPay) {
        rows.push({ header: "控除" },
                  { name: "控除合計", value: "−" + fmt(g.gross - net),
                    pct: pct(g.gross - net) });
      }
      const dets = [...g.detail.entries()].sort((a, b) => b[1] - a[1]);
      for (const [header, match] of [
        ["法定控除", (grp) => grp !== "任意控除"],
        ["任意控除", (grp) => grp === "任意控除"],
      ]) {
        const sub = dets.filter(([n]) => match(dedGroup(n)));
        if (!sub.length) continue;
        rows.push({ header });
        for (const [n, v] of sub.slice(0, 6)) {
          rows.push({ name: truncate(n, 14), value: "−" + fmt(v), pct: pct(v),
                      color: dedColors[dedGroup(n)] });
        }
        if (sub.length > 6) {
          const rest = sub.slice(6).reduce((s, [, v]) => s + v, 0);
          rows.push({ name: `他${sub.length - 6}件`, value: "−" + fmt(rest),
                      pct: pct(rest) });
        }
      }
      rows.push({ header: "手取り" });
      // 手取り率は%カラムが兼ねる(独立行は置かない)
      rows.push({ name: "手取り", value: fmt(net), pct: pct(net),
                  color: cssVar("--good") });
    }
    const payWedges = items.map(([n, v]) => ({
      name: n, value: v,
      color: pal.colorOf(pal.slots.includes(n) ? n : "その他支給") }));
    const dedWedges = DED_NAMES.map((n) => ({
      name: DED_LABEL[n] || n, value: g.ded.get(n) || 0,
      color: dedColors[n] }));
    // 両方: 外リング=手取り+控除(項目が少なく引き出しラベル向き)、
    // 内リング=支給項目(中心の穴のラベルへ曲線トラックで結ぶ)
    const pie = mode === "pay" ? payWedges
      : mode === "ded" ? dedWedges
      : { outer: [{ name: "手取り", value: net, color: cssVar("--good") }]
            .concat(DED_NAMES.map((n) => ({ name: n, value: g.ded.get(n) || 0,
                                            color: dedColors[n] }))),
          inner: payWedges };
    showTip(evt, g.month + " " + g.kind, rows, pie);
  }

  // 手取り率の推移。月例給与は2本: 実線=法定控除(社会保険料・税)のみ引いた率、
  // 点線=任意控除も引いた率(振込額ベース)。賞与のある月は給与点の左隣に
  // 賞与点(全控除後)を置き、実線が支給の時系列どおり賞与点を経由する
  function drawSalaryRate(box, groups) {
    box.replaceChildren();
    const sal = groups.filter((g) => g.kind === "給与").slice(-13);
    const bonAll = groups.filter((g) => g.kind === "賞与");
    if (!sal.length && !bonAll.length) { note(box, "データがありません"); return; }
    const rate = (g) => g.gross > 0 ? netOf(g) / g.gross * 100 : null;
    const rateL = (g) => g.gross > 0 ? legalNetOf(g) / g.gross * 100 : null;
    // 月軸は給与と賞与の月の合併(給与のない賞与月も落とさない)
    const ms = [...new Set([...sal, ...bonAll].map((g) => g.month))]
      .sort().slice(-13);
    const bon = bonAll.filter((g) => ms.includes(g.month));
    const all = [...sal.map(rate), ...sal.map(rateL), ...bon.map(rate)]
      .filter((v) => v != null);
    const lo = Math.max(0, Math.floor((Math.min(...all) - 3) / 5) * 5);
    const hi = Math.min(100, Math.ceil((Math.max(...all) + 3) / 5) * 5);
    const W = Math.max(360, ms.length * 48 + 60), H = 200;
    const padL = 46, padR = 14, padT = 10, padB = 26;
    const plotW = W - padL - padR, plotH = H - padT - padB;
    const y = (v) => padT + plotH * (1 - (v - lo) / Math.max(1, hi - lo));
    const sc = scrollChart(W, H, padL);
    const svg = sc.plot;
    yAxis(svg, sc.axis, { y, bot: lo, top: hi, step: 5, x0: padL,
                          x1: W - padR, fmt: (v) => v + "%" });
    const x = (m) => padL + plotW * ((ms.indexOf(m) + 0.5) / ms.length);
    const iNow = ms.indexOf(curMonth);
    if (iNow >= 0) {
      nowBand(svg, padL + plotW * (iNow / ms.length), 0,
              plotW / ms.length, H);
    }
    const dx = -12;  // 賞与は月内で給与より先に支給されるので左隣に置く
    const seq = cssVar("--seq"), bonC = cssVar("--cat4");
    // 実線(法定控除後)は支給の時系列どおり賞与点を経由する
    // (例: 6月給与→7月賞与→7月給与)。賞与には任意控除がないため、
    // 点線(全控除後)は賞与を通らず給与から給与へ直接繋ぐ
    const solidEnts = [
      ...sal.map((g) => ({ px: x(g.month), v: rateL(g) })),
      ...bon.map((g) => ({ px: x(g.month) + dx, v: rate(g) })),
    ].sort((a, b) => a.px - b.px);
    const ptsL = solidEnts.filter((e) => e.v != null)
      .map((e) => [e.px, y(e.v)]);
    if (ptsL.length >= 2) polyline(svg, ptsL, seq, 2);
    const pts = sal.filter((g) => rate(g) != null)
      .map((g) => [x(g.month), y(rate(g))]);
    if (pts.length >= 2) polyline(svg, pts, seq, 2, "4 4");
    for (const m of ms) {
      text(svg, x(m), H - 8, m.slice(2).replace("-", "/"),
           "axis-label", "middle");
    }
    // 各点に率を書く。法定控除後は必ず全控除後より高いので、
    // 上下に書き分ければ2系列のラベルはぶつからない
    const pctLabel = (px, py, v) =>
      text(svg, px, py, Math.round(v) + "%", "bar-label-sm", "middle");
    for (const g of bon) {
      if (rate(g) == null) continue;
      const c = circle(svg, x(g.month) + dx, y(rate(g)), 4, bonC);
      attachRateTip(c, g);
      // 率は点の左下に右詰めで置く(上だと点線側と混み合う)。賞与は別系列
      // なので同月の給与ラベルと高さが揃うことがあり、真下・中央揃えだと
      // 全控除後ラベル(点の真下)と重なって潰れる。右端を点のxに寄せれば
      // 給与ラベルのx範囲と交わらない
      text(svg, x(g.month) + dx - 2, y(rate(g)) + 15,
           Math.round(rate(g)) + "%", "bar-label-sm", "end");
    }
    for (const g of sal) {
      // 実線側は塗り点(率は点の上)、点線側は白抜き点(率は点の下)。
      // ツールチップはどちらも同内容
      if (rateL(g) != null) {
        attachRateTip(circle(svg, x(g.month), y(rateL(g)), 3, seq), g);
        pctLabel(x(g.month), y(rateL(g)) - 6, rateL(g));
      }
      if (rate(g) != null) {
        const c = circle(svg, x(g.month), y(rate(g)), 3, cssVar("--surface"));
        c.setAttribute("stroke", seq);
        c.setAttribute("stroke-width", "1.5");
        attachRateTip(c, g);
        pctLabel(x(g.month), y(rate(g)) + 14, rate(g));
      }
    }
    function attachRateTip(el, g) {
      el.style.cursor = "default";
      el.addEventListener("pointermove", (evt) => {
        const rows = [{ name: "総支給", value: fmt(g.gross), pct: "100%" }];
        if (legalNetOf(g) === netOf(g)) {
          // 任意控除なし(賞与など): 法定=全控除なので1行にまとめる
          if (rate(g) != null) {
            rows.push({ name: "手取り", value: fmt(netOf(g)),
                        pct: rate(g).toFixed(1) + "%" });
          }
        } else {
          if (rateL(g) != null) {
            rows.push({ name: "法定控除後", value: fmt(legalNetOf(g)),
                        pct: rateL(g).toFixed(1) + "%" });
          }
          if (rate(g) != null) {
            rows.push({ name: "全控除後(振込)", value: fmt(netOf(g)),
                        pct: rate(g).toFixed(1) + "%" });
          }
        }
        showTip(evt, g.month + " " + g.kind, rows);
      });
      el.addEventListener("pointerleave", hideTip);
    }
    box.appendChild(sc.wrap);
    sc.done();
  }

  // 勤務内容等(給与明細の転記)
  // 家計の集計外だが、明細に載っている情報は捨てず全部見せる方針
  // (build が meta["work"] → data.js salary_work に転記)。項目名は
  // 会社の記載に追従する(名前を仮定しない)。チャートだけは
  // 「時間外時間」を含む項目の合計を月次で追う(いちばん変動して読みたい値)。
  // month は勤怠の対象月=支給月の前月(パーサが付け替える。根拠は
  // parsers.py parse_kyuyo の docstring)
  function renderWork(gs) {
    const allRows = (DATA.salary_work || []).filter((w) => w.kind === "給与")
      .slice().sort((a, b) => a.month.localeCompare(b.month));
    const card = $("#work-card");
    card.style.display = allRows.length ? "" : "none";
    if (!allRows.length) return;
    // 在籍前の対象月(最初の給与支給月より前。入社月明細の前月に出る
    // 所定値だけの行)は勤怠実績が存在しない。チャートからは除き、
    // 表では行を残してグレーアウトする
    const salMs = gs.filter((g) => g.kind === "給与")
      .map((g) => g.month);
    const firstSal = salMs.length ? salMs[0] : "";
    const preHire = (m) => firstSal && m < firstSal;
    const rows = allRows.filter((w) => !preHire(w.month));
    const fmtV = (v) => v == null ? "—"
      : Number.isInteger(v) ? v.toLocaleString()
      : v.toLocaleString(undefined, { maximumFractionDigits: 2 });
    // 時間外時間の推移。色は内訳チャートの「時間外勤務手当」と同じ
    // --critical(真っ赤)で揃え、対応する残業代(翌月支給の時間外勤務手当)を
    // 時間の上に添える
    const box = $("#work-chart");
    box.replaceChildren();
    const ot = rows.map((w) => w.items
      .filter((it) => it.name.includes("時間外時間"))
      .reduce((s, it) => s + it.value, 0));
    const ms = rows.map((w) => w.month);
    // 勤怠対象月mの残業代は m+1 月支給の給与明細に載る
    const otPay = new Map(gs.filter((g) => g.kind === "給与")
      .map((g) => [g.month, g.items.get("時間外勤務手当") || 0]));
    if (rows.length) {
      const maxV = Math.max(1, ...ot);
      const step = niceStep(maxV);
      const top = Math.ceil(maxV / step) * step;
      // padT はラベル2段(残業代+時間)のぶん余白を取る
      const padL = 40, padT = 26;
      const mc = monthlyChart(ms, { h: 190, per: 56, minW: 320, padL, padT,
                                    top, step, fmt: (v) => v + "h" });
      const otCol = cssVar("--critical");
      const barW = Math.min(26, mc.band - 16);
      ms.forEach((m, i) => {
        const bx = padL + mc.band * i + (mc.band - barW) / 2;
        if (ot[i] > 0) {
          vbar(mc.svg, bx, mc.y(0), barW, mc.y(0) - mc.y(ot[i]), otCol);
          text(mc.svg, bx + barW / 2, mc.y(ot[i]) - 3,
               fmtV(ot[i]) + "h", "bar-label-sm", "middle");
          const pay = otPay.get(shiftMonth(m, 1));
          if (pay) {
            text(mc.svg, bx + barW / 2, mc.y(ot[i]) - 14,
                 compact(pay), "bar-label-sm", "middle");
          }
        }
        // ホバーでその月の勤務内容等の全項目
        const hit = rect(mc.svg, padL + mc.band * i, padT, mc.band, mc.plotH,
                         "transparent");
        hit.addEventListener("pointermove", (evt) => {
          const tRows = rows[i].items.map((it) => ({
            name: it.name, value: fmtV(it.value),
            color: it.name.includes("時間外時間") ? otCol : undefined,
          }));
          const pay = otPay.get(shiftMonth(m, 1));
          if (pay) tRows.push({ name: "残業代(翌月支給)", value: fmt(pay),
                                color: otCol });
          showTip(evt, m + " の勤務内容等(翌月支給)", tRows);
        });
        hit.addEventListener("pointerleave", hideTip);
        mc.tick(i);
      });
      box.appendChild(mc.wrap);
      mc.done();
    }
    // 休暇取得の推移(年次休暇+半日休暇0.5日換算)。時間外と同じ足場。
    // 「付与」を含む項目(有給付与日数等)は取得実績ではないので入れない
    // のため使わない
    const vbox = $("#vac-chart");
    vbox.replaceChildren();
    const vac = rows.map((w) => {
      const g = (kw) => w.items.filter((it) => it.name.includes(kw))
        .reduce((s, it) => s + it.value, 0);
      return { full: g("年次休暇日数"), half: g("半日休暇回数") };
    });
    const vd = vac.map((v) => v.full + v.half * 0.5);
    if (rows.length) {
      const maxV = Math.max(1, ...vd);
      const step = niceStep(maxV);
      const top = Math.ceil(maxV / step) * step;
      const padL = 40, padT = 10;
      const mc = monthlyChart(ms, { h: 180, per: 56, minW: 320, padL,
                                    top, step, fmt: (v) => v + "日" });
      const seq = cssVar("--seq");
      const barW = Math.min(26, mc.band - 16);
      ms.forEach((m, i) => {
        const bx = padL + mc.band * i + (mc.band - barW) / 2;
        if (vd[i] > 0) {
          vbar(mc.svg, bx, mc.y(0), barW, mc.y(0) - mc.y(vd[i]), seq);
          text(mc.svg, bx + barW / 2, mc.y(vd[i]) - 3,
               fmtV(vd[i]) + "日", "bar-label-sm", "middle");
        }
        const hit = rect(mc.svg, padL + mc.band * i, padT, mc.band, mc.plotH,
                         "transparent");
        hit.addEventListener("pointermove", (evt) => {
          showTip(evt, m + " の休暇取得(翌月支給の明細より)", [
            { name: "年次休暇", value: fmtV(vac[i].full) + "日" },
            { name: "半日休暇", value: fmtV(vac[i].half) + "回" },
            { name: "計", value: fmtV(vd[i]) + "日", color: seq },
          ]);
        });
        hit.addEventListener("pointerleave", hideTip);
        mc.tick(i);
      });
      vbox.appendChild(mc.wrap);
      mc.done();
    }
    // 全項目の表(列=最新月の記載順を先頭に、過去月にしか無い項目を後置。
    // 行=月の新しい順)。初出順だと初月だけの項目(付与系等)が
    // 前に来て主要列が右に追いやられる
    const cols = [];
    for (const w of [...allRows].reverse()) {
      for (const it of w.items) if (!cols.includes(it.name)) cols.push(it.name);
    }
    const thead = $("#work-table thead");
    thead.replaceChildren();
    const hr = document.createElement("tr");
    for (const h of ["月", ...cols]) {
      const th = document.createElement("th");
      th.textContent = h;
      if (h !== "月") th.style.textAlign = "right";
      hr.appendChild(th);
    }
    thead.appendChild(hr);
    const tbody = $("#work-table tbody");
    tbody.replaceChildren();
    for (const w of [...allRows].reverse()) {
      const map = new Map(w.items.map((it) => [it.name, it.value]));
      const tr = document.createElement("tr");
      if (preHire(w.month)) tr.className = "pre-hire";   // 在籍前(実績なし)
      const tdm = document.createElement("td");
      tdm.textContent = w.month;
      tdm.style.whiteSpace = "nowrap";
      tr.appendChild(tdm);
      for (const c of cols) {
        const td = document.createElement("td");
        td.className = "num";
        td.textContent = fmtV(map.has(c) ? map.get(c) : null);
        tr.appendChild(td);
      }
      tbody.appendChild(tr);
    }
  }

  function renderSalaryTab() {
    const gs = kyuyoGroups();
    if (!gs.length) {
      document.querySelector('#tabs button[data-tab="salary"]').style.display = "none";
      return;
    }
    const kpis = $("#sal-kpis");
    kpis.replaceChildren();
    const sal = gs.filter((g) => g.kind === "給与");
    const bon = gs.filter((g) => g.kind === "賞与");
    // 手取りモードでは主数字を法定控除後(=収支タブの収入と同じ定義)に
    // 切り替え、総支給・振込額(全控除後)はsubに退避する
    const isNet = state.incomeMode === "net";
    // 式でないsubは・で横並びにしてもどうせ折り返すので、1行1項目で置く
    // (式用のぶら下げインデント(.tile .sub の既定)も外す)
    const sub2 = (tile, ...lines) => {
      const s = tile.querySelector(".sub");
      s.classList.add("plain");
      s.replaceChildren();
      for (const l of lines) {
        const d = document.createElement("div");
        d.textContent = l;
        s.appendChild(d);
      }
    };
    const latest = sal[sal.length - 1];
    if (latest) {
      const net = netOf(latest);
      if (isNet) {
        sub2(mkTile(kpis, `手取り月収(${monthLabel(latest.month)}の給与)`,
                    fmt(legalNetOf(latest)), "", ""),
             `総支給 ${cYen(latest.gross)}`, `振込 ${cYen(net)}`);
      } else {
        sub2(mkTile(kpis, `月収(${monthLabel(latest.month)}の給与)`,
                    fmt(latest.gross), "", ""),
             `手取り ${cYen(net)}`,
             "手取り率 " + (latest.gross > 0
                ? (net / latest.gross * 100).toFixed(1) + "%" : "—"));
      }
    }
    // 実績合算の窓 = 給与明細が届いている最新月までの12ヶ月。当月基準に
    // すると給与到着前は1ヶ月分欠けて過小になるため基準を最新給与月に置く。
    // 暦年の年初来は年末調整・源泉徴収票との照合以外に使い道が薄く、
    // 暦年集計は年次タブが受け持つので、こちらは移動12ヶ月で経常を見る
    const baseMonth = latest ? latest.month : curMonth;
    const inR12 = (g) =>
      g.month > shiftMonth(baseMonth, -12) && g.month <= baseMonth;
    const bon12 = bon.filter(inR12);
    // 年収換算(他者との比較・記入用)。実績12ヶ月合計は就労開始直後だと
    // 数ヶ月分しか入らず過小なので、直近3ヶ月の給与平均×12+賞与実績
    // (直近12ヶ月)の換算で出し、根拠を明記する
    const r3 = sal.slice(-3);
    if (r3.length) {
      const avgOf = (f) => r3.reduce((s, g) => s + f(g), 0) / r3.length;
      const bonOf = (f) => bon12.reduce((s, g) => s + f(g), 0);
      const grossY = avgOf((g) => g.gross) * 12 + bonOf((g) => g.gross);
      const basis = `直近${r3.length}ヶ月給与平均×12+賞与実績(12ヶ月)`;
      if (isNet) {
        sub2(mkTile(kpis, "年収換算(手取り)",
                    fmt(Math.round(avgOf(legalNetOf) * 12 + bonOf(legalNetOf))),
                    "", ""),
             `総支給 ${cYen(grossY)}`, basis);
      } else {
        sub2(mkTile(kpis, "年収換算(総支給)", fmt(Math.round(grossY)), "", ""),
             `手取り ${cYen(avgOf(netOf) * 12 + bonOf(netOf))}`, basis);
      }
    }
    const r12 = gs.filter(inR12);
    const r12Gross = r12.reduce((s, g) => s + g.gross, 0);
    const r12Net = r12.reduce((s, g) => s + netOf(g), 0);
    if (isNet) {
      sub2(mkTile(kpis, "手取り(直近12ヶ月)",
                  fmt(r12.reduce((s, g) => s + legalNetOf(g), 0)), "", ""),
           `総支給 ${cYen(r12Gross)}`, `振込 ${cYen(r12Net)}(賞与含む)`);
    } else {
      sub2(mkTile(kpis, "総支給(直近12ヶ月)", fmt(r12Gross), "", ""),
           `手取り ${cYen(r12Net)}(賞与含む)`);
    }
    const r12Ded = r12Gross - r12Net;
    const dedSum = (grp) => r12.reduce((s, g) => s + (g.ded.get(grp) || 0), 0);
    sub2(mkTile(kpis, "控除(直近12ヶ月)", r12Ded > 0 ? "−" + fmt(r12Ded) : "—",
                "", r12Ded > 0 ? "neg" : ""),
         `社会保険料 ${cYen(dedSum("社会保険料"))}`, `税 ${cYen(dedSum("税"))}`);
    const bonSum = (f) => bon12.reduce((s, g) => s + f(g), 0);
    const bonTile = mkTile(kpis,
           (isNet ? "手取り賞与" : "賞与") + "(直近12ヶ月)",
           bon12.length
             ? fmt(bonSum(isNet ? legalNetOf : (g) => g.gross)) : "—",
           "支給なし", "");
    if (bon12.length) {
      sub2(bonTile, `${bon12.length}回`, isNet
             ? `総支給 ${cYen(bonSum((g) => g.gross))}`
             : `手取り ${cYen(bonSum(netOf))}`);
    }
    const redraw = () => drawSalaryCombined(
      $("#sal-month-chart"), $("#sal-pay-legend"), $("#sal-ded-legend"), gs);
    redraw();
    for (const b of document.querySelectorAll("#sal-mode button")) {
      b.onclick = () => {           // 代入なので再実行しても重複しない
        $("#sal-mode button.on").classList.remove("on");
        b.classList.add("on");
        redraw();
      };
    }
    drawSalaryRate($("#sal-rate-chart"), gs);
    renderWork(gs);
  }

  Object.assign(KB, { renderSalaryTab });
})();
