"use strict";
// tab-watch.js: 店・摘要別の定点観測。摘要キー単位の月次推移を
// モーダルで見せる。ドリルダウン・明細の「定点」ボタンから開くほか、
// 定期支出テーブルの行クリック詳細としても流用される。
(function () {
  const KB = window.KB;
  const {
    $, TXNS, ACCOUNTS, months, watchKey,
    fmt, compact, cssVar, niceStep, note, mkTile,
    showTip, hideTip,
    rect, text, vbar, polyline, circle,
  } = KB;

  // 摘要キー→その支出明細(店名一致の全期間)
  function watchTxns(key) {
    return TXNS.filter((t) => t.type === "expense" && t.amount < 0 &&
      watchKey(t.description) === key);
  }

  // 定点観測モーダルを開く。opts で定期支出の詳細ビューとしても使う:
  //   txns  … 明細を差し替える(定期支出は摘要の表記揺れ統合後の集合を持つ)
  //   hike  … 改定情報 {from, to, dir}(subHike の返り値)をKPIに出す
  //   title … 見出しの接頭辞(既定「定点観測」)
  function openWatch(key, opts) {
    opts = opts || {};
    hideTip();
    const txns = opts.txns || watchTxns(key);
    $("#watch-title").textContent = (opts.title || "定点観測") + ": " + key;
    // 月次集計
    const byMonth = new Map();
    for (const t of txns) {
      const m = t.date.slice(0, 7);
      if (!byMonth.has(m)) byMonth.set(m, { sum: 0, cnt: 0 });
      const g = byMonth.get(m);
      g.sum += -t.amount; g.cnt += 1;
    }
    const total = txns.reduce((s, t) => s - t.amount, 0);
    const cnt = txns.length;
    // KPI
    const kpis = $("#watch-kpis");
    kpis.replaceChildren();
    mkTile(kpis, "累計支払", fmt(total), `${cnt}件`, "small");
    mkTile(kpis, "平均単価", cnt ? fmt(total / cnt) : "—", "1件あたり", "small");
    const activeMonths = byMonth.size;
    mkTile(kpis, "月平均", activeMonths ? fmt(total / activeMonths) : "—",
           `出現 ${activeMonths}ヶ月`, "small");
    const last = txns.map((t) => t.date).sort().pop();
    mkTile(kpis, "直近", last || "—", "", "small");
    if (opts.hike) {
      mkTile(kpis, "改定",
             `${compact(opts.hike.from)}→${compact(opts.hike.to)}`,
             opts.hike.dir === "up" ? "値上げ(直近3ヶ月の中央値)"
                                    : "値下げ(直近3ヶ月の中央値)",
             opts.hike.dir === "up" ? "neg" : "small");
    }

    // 描画より先にモーダルを表示する(display:none の間は scrollWidth=0 で
    // 「最新月へスクロール」が効かず、最古側が見えた状態で開いてしまう)
    $("#watch-bg").style.display = "";
    drawWatchChart(byMonth);
    // 直近明細
    const listBox = $("#watch-list");
    listBox.replaceChildren();
    const recent = [...txns].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 40);
    for (const t of recent) {
      const row = document.createElement("div");
      row.className = "inc-row";
      row.title = "クリックで明細タブの該当レコードへ";
      const d = document.createElement("span");
      d.className = "d"; d.textContent = t.date;
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = ACCOUNTS[t.account] ? ACCOUNTS[t.account].name : t.account;
      const a = document.createElement("span");
      a.className = "a neg"; a.textContent = fmt(-t.amount);
      row.append(d, nm, a);
      row.addEventListener("click", () => {
        closeWatch();
        // フィルタが立っていても対象行に届くよう jumpToTxn 経由で飛ぶ
        KB.jumpToTxn(t);
      });
      listBox.appendChild(row);
    }
  }
  function closeWatch() { $("#watch-bg").style.display = "none"; }

  // 月次の支出(棒)+単価(右軸の線)
  function drawWatchChart(byMonth) {
    const box = $("#watch-chart");
    box.replaceChildren();
    // 出現し始めた月から現在までの連続した月軸
    const keys = [...byMonth.keys()].sort();
    if (!keys.length) { note(box, "明細がありません"); return; }
    const ms = months.filter((m) => m >= keys[0]);
    const padL = 48, padR = 44, padT = 12;
    const maxSum = Math.max(1, ...ms.map((m) => (byMonth.get(m) || {}).sum || 0));
    const step = niceStep(maxSum);
    const top = Math.ceil(maxSum / step) * step;
    const unit = (m) => { const g = byMonth.get(m); return g && g.cnt ? g.sum / g.cnt : null; };
    const maxUnit = Math.max(1, ...ms.map((m) => unit(m) || 0));
    const mc = KB.monthlyChart(ms, { h: 220, per: 40, minW: 360,
                                     padL, padR, padT, top, step });
    const { svg, y, band, plotH, W } = mc;
    const uStep = niceStep(maxUnit);
    const uTop = Math.ceil(maxUnit / uStep) * uStep;
    const yu = (v) => padT + plotH * (1 - v / uTop);
    const barW = Math.min(22, band - 12);
    const expc = cssVar("--expense"), seq = cssVar("--seq");
    ms.forEach((m, i) => {
      const g = byMonth.get(m);
      const bx = padL + band * i + (band - barW) / 2;
      if (g && g.sum > 0) {
        vbar(svg, bx, y(0), barW, y(0) - y(g.sum), expc);
      }
      const hit = rect(svg, padL + band * i, padT, band, plotH, "transparent");
      hit.addEventListener("pointermove", (evt) => {
        const rows = [{ name: "支出", value: fmt(g ? g.sum : 0), color: expc }];
        if (g && g.cnt) {
          rows.push({ name: "件数", value: g.cnt + "件" });
          rows.push({ name: "単価", value: fmt(g.sum / g.cnt), color: seq });
        }
        showTip(evt, m, rows);
      });
      hit.addEventListener("pointerleave", hideTip);
      mc.tick(i);
    });
    // 単価の線(右軸)。右軸は相対的な推移を見るためのもので、目盛り・
    // グリッドは意図的に出さない(絶対値はツールチップの「単価」行で読む)
    const upts = ms.map((m, i) => { const u = unit(m);
      return u == null ? null : [padL + band * i + band / 2, yu(u)]; }).filter(Boolean);
    if (upts.length >= 2) polyline(svg, upts, seq, 2);
    for (const [px, py] of upts) circle(svg, px, py, 2.5, seq);
    // 右軸ラベル
    text(svg, W - padR + 6, padT + 4, "単価", "axis-label", "start")
      .setAttribute("fill", seq);
    box.appendChild(mc.wrap);
    mc.done();
  }

  // ドリルダウン摘要行・明細詳細に付ける「定点」ボタン
  function watchButton(key, label) {
    const b = document.createElement("button");
    b.className = "howto-btn watch-btn";
    b.textContent = label || "定点";
    b.title = "この店・摘要を定点観測で開く";
    b.addEventListener("click", (ev) => {
      ev.stopPropagation();
      openWatch(key);
    });
    return b;
  }

  // 閉じる操作
  $("#watch-close").addEventListener("click", closeWatch);
  $("#watch-bg").addEventListener("click", (e) => {
    if (e.target === $("#watch-bg")) closeWatch();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeWatch();
  });

  Object.assign(KB, {
    openWatch, watchButton,
  });
})();
