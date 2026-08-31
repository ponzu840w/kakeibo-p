"use strict";
// svgkit.js: 素SVGの共通部品(角丸棒・積み上げ・ドーナツツールチップ等)。
(function () {
  const KB = window.KB;
  const { cssVar, truncate, compact, curMonth } = KB;

  const SVGNS = "http://www.w3.org/2000/svg";
  function mkSvg(w, h) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", `0 0 ${w} ${h}`);
    s.setAttribute("width", "100%");
    s.style.maxWidth = w + "px";
    s.style.display = "block";
    return s;
  }
  // 縮尺1:1のSVG。横スクロールさせるチャート用(viewBox縮小だと文字が潰れる)
  function mkFixedSvg(w, h) {
    const s = document.createElementNS(SVGNS, "svg");
    s.setAttribute("viewBox", `0 0 ${w} ${h}`);
    s.setAttribute("width", w);
    s.setAttribute("height", h);
    s.style.display = "block";
    return s;
  }
  // 月次(時系列)チャートが「データが増えるほど横に伸び、コンテナ幅で
  // viewBox縮小されて棒も文字も潰れる」のを防ぐ土台。純資産推移と同じく、
  // 幅 padL の固定Y軸(axis)を左に置き、本体(plot、幅 W)だけを横スクロール
  // させて棒の縮尺は一定に保つ。plot は従来どおり左マージン padL を取った
  // 座標系(グリッド線・棒を padL 原点で描く)のまま渡してよい。左端 padL 分は
  // 負マージンでスクローラの外へ逃がし、Y軸の右にグリッド左端をぴたりと寄せる。
  // 呼び出し側の作法: グリッド線は plot に、Y軸の数値ラベルは axis に描き、
  // 返り値の wrap を box に入れてから done() を呼ぶ(最新月=右端へスクロール)。
  function scrollChart(W, H, padL) {
    const plot = mkFixedSvg(W, H);
    plot.style.marginLeft = -padL + "px";
    const axis = mkFixedSvg(padL, H);
    const scroller = document.createElement("div");
    scroller.className = "hscroll";
    scroller.appendChild(plot);
    const wrap = document.createElement("div");
    wrap.className = "hscroll-wrap";
    wrap.append(axis, scroller);
    return {
      plot, axis, wrap,
      done() { scroller.scrollLeft = scroller.scrollWidth; },
    };
  }
  function line(svg, x1, y1, x2, y2, stroke, dash) {
    const l = document.createElementNS(SVGNS, "line");
    l.setAttribute("x1", x1); l.setAttribute("y1", y1);
    l.setAttribute("x2", x2); l.setAttribute("y2", y2);
    l.setAttribute("stroke", stroke); l.setAttribute("stroke-width", "1");
    if (dash) l.setAttribute("stroke-dasharray", dash);
    svg.appendChild(l);
    return l;
  }
  function rect(svg, x, y, w, h, fill) {
    const r = document.createElementNS(SVGNS, "rect");
    r.setAttribute("x", x); r.setAttribute("y", y);
    r.setAttribute("width", Math.max(0, w)); r.setAttribute("height", Math.max(0, h));
    r.setAttribute("fill", fill);
    svg.appendChild(r);
    return r;
  }
  function text(svg, x, y, str, cls, anchor) {
    const t = document.createElementNS(SVGNS, "text");
    t.setAttribute("x", x); t.setAttribute("y", y);
    t.setAttribute("class", cls);
    if (anchor) t.setAttribute("text-anchor", anchor);
    t.textContent = str;
    svg.appendChild(t);
    return t;
  }
  // ラベル幅の見積り(axis-label 11px 時の実測近似。全角=1em・半角=0.62em)
  function estTextW(s) {
    return [...String(s)].reduce(
      (w, ch) => w + (ch.charCodeAt(0) > 0xFF ? 11 : 11 * 0.62), 0);
  }
  // Y軸の数値ラベル+横グリッド線。0線だけ --baseline 色。
  //   svg  … グリッド線の描画先(スクロールする本体)
  //   axis … ラベルの描画先。scrollChart の固定軸を渡す。null なら svg へ
  //   opts … { y(値→座標), bot=0, top, step, x0, x1(グリッドの左右端),
  //            fmt(ラベル。既定 compact), labelX(既定 x0-6) }
  function yAxis(svg, axis, opts) {
    const { y, bot = 0, top, step, x0, x1 } = opts;
    const f = opts.fmt || compact;
    const lx = opts.labelX != null ? opts.labelX : x0 - 6;
    for (let v = bot; v <= top; v += step) {
      line(svg, x0, y(v), x1, y(v),
           v === 0 ? cssVar("--baseline") : cssVar("--grid"));
      text(axis || svg, lx, y(v) + 4, f(v), "axis-label", "end");
    }
  }
  // 凡例キー(スウォッチ+ラベル)。css はスウォッチのスタイル
  // ("background:○○" のほか、線種を表す height/border 指定も可)。
  // opts.value / opts.pct で金額・構成比付き(資産構成バーの凡例)、
  // opts.cls は金額側の追加クラス(neg 等)。返り値にクリック等を付けられる
  function legendKey(parent, css, label, opts) {
    const key = document.createElement("span");
    key.className = "key";
    const sw = document.createElement("span");
    sw.className = "swatch";
    sw.style.cssText += css;
    key.append(sw, document.createTextNode(label));
    if (opts && opts.value) {
      const v = document.createElement("span");
      v.className = "val" + (opts.cls ? " " + opts.cls : "");
      v.textContent = opts.value;
      key.appendChild(v);
    }
    if (opts && opts.pct) {
      const p = document.createElement("span");
      p.className = "pct";
      p.textContent = opts.pct;
      key.appendChild(p);
    }
    parent.appendChild(key);
    return key;
  }
  // 月次グラフの横軸ラベル。間引かずに毎月描き、バンド幅が "25/08" の
  // 横書きに足りないときは斜めにする。斜めラベルは下方向に場所を取るので、
  // 呼び出し側は padB を monthTickPadB(band) で確保すること
  function monthTickPadB(band) { return band < 40 ? 36 : 26; }
  function monthTick(svg, cx, m, band, H) {
    const label = m.slice(2).replace("-", "/");
    if (band >= 40) {
      text(svg, cx, H - 8, label, "axis-label", "middle");
      return;
    }
    const tx = cx + 4, ty = H - 24;
    const t = text(svg, tx, ty, label, "axis-label", "end");
    t.setAttribute("transform", `rotate(-40 ${tx} ${ty})`);
  }
  // 「今」の列(月次チャートは現在月、年次チャートは現在年)を敷く帯。
  // 月軸を monthlyChart 以外で組む所からも同じ見た目になるよう共通化して
  // ある。SVGの先頭へ挿し込むので棒・線・グリッドより必ず背面に来る。
  // 当たり判定を奪わない(=ホバー強調 hlMark の対象にもならない)
  function nowBand(svg, x, y, w, h) {
    const r = rect(svg, x, y, w, h, cssVar("--now-band"));
    r.style.pointerEvents = "none";
    svg.insertBefore(r, svg.firstChild);
    return r;
  }
  // 上角丸の縦棒(yBottom から高さ h)。down指定で下角丸(yBottom=上端)になる
  function vbar(svg, x, yBottom, w, h, color, down) {
    if (h <= 0) return null;
    const r = Math.min(4, h, w / 2);
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d", down
      ? `M${x},${yBottom} v${h - r} q0,${r} ${r},${r} h${w - 2 * r} q${r},0 ${r},${-r} v${-(h - r)} z`
      : `M${x},${yBottom} v${-(h - r)} q0,${-r} ${r},${-r} h${w - 2 * r} q${r},0 ${r},${r} v${h - r} z`);
    p.setAttribute("fill", color);
    svg.appendChild(p);
    return p;
  }
  let _svgSeq = 0;   // pattern等のid衝突回避(表示中でないSVG内のidは参照できない)
  // 他ファイル(tab-assets.js/tab-salary.js)からの採番はこの関数経由で行う。
  // _svgSeq 自体は可変プリミティブなので destructure すると値がコピーされ、
  // ファイルをまたいだ採番が食い違ってしまう
  function nextSvgSeq() { return ++_svgSeq; }
  function svgDefs(svg) {
    let defs = svg.querySelector("defs");
    if (!defs) {
      defs = document.createElementNS(SVGNS, "defs");
      svg.appendChild(defs);
    }
    return defs;
  }
  // 含み益表現の共通部品: SVG用の斜線パターン(fill url)と凡例スウォッチ用CSS
  function stripePattern(svg) {
    const pat = document.createElementNS(SVGNS, "pattern");
    pat.setAttribute("id", "pl-stripe-" + (++_svgSeq));
    pat.setAttribute("width", "4");
    pat.setAttribute("height", "4");
    pat.setAttribute("patternUnits", "userSpaceOnUse");
    pat.setAttribute("patternTransform", "rotate(45)");
    const sl = document.createElementNS(SVGNS, "line");
    sl.setAttribute("x1", 0); sl.setAttribute("y1", 0);
    // 線は高さ4のタイルをわざとはみ出す(y2=7)。45°回転タイルの角まで
    // 覆わないと縞に隙間ができる
    sl.setAttribute("x2", 0); sl.setAttribute("y2", 7);
    sl.setAttribute("stroke", "rgba(255,255,255,.55)");
    sl.setAttribute("stroke-width", "2");
    pat.appendChild(sl);
    svgDefs(svg).appendChild(pat);
    return `url(#${pat.getAttribute("id")})`;
  }
  // ↑のSVGパターンと周期・縞幅・透明度を揃えること(実装が別なので手動同期)
  const stripeCss = (color) =>
    `background:repeating-linear-gradient(45deg,${color} 0 2px,` +
    "rgba(255,255,255,.55) 2px 4px)";
  // ホバー中の図形の強調(全チャート共通)。
  // ツールチップと連動する縁取り。core.js の showTip がホバーイベントを
  // hlMark に渡し、hideTip が hlClear を呼ぶので、個別チャートは何もしなくて
  // よい。強調するのは「カーソル直下の塗られた図形」: ヒット領域が透明な帯
  // (月バンド等)の場合は elementsFromPoint でその真下の棒・セグメントを
  // 探す。形は要素の幾何をなぞる(rect/circle/path)。要素に _hlPath(パス
  // 文字列)があればそれを優先(資産構成バーの端の角丸など、要素の矩形と
  // 輪郭が一致しないとき用。この場合のみクリップ外=SVGルートに描く)。
  // _hlLabel(text要素)があればラベルも太字にする。縁取りの見た目は
  // style.css の .hl-outline(ttDonut の hl と共用)。戻り値は強調した要素
  // (showTip が扇形・行の連動強調に使う)
  let _hlCur = null;
  function hlClear() {
    if (!_hlCur) return;
    for (const n of _hlCur.parts) n.remove();
    if (_hlCur.label) _hlCur.label.style.fontWeight = "";
    _hlCur = null;
  }
  // 塗られた図形(=強調に値する視覚要素)か。軸・グリッド線や透明ヒット
  // 領域を除外する
  function hlPaintedShape(e) {
    if (!e || !e.ownerSVGElement) return false;
    const tag = e.tagName;
    if (tag !== "rect" && tag !== "circle" && tag !== "path") return false;
    const f = e.getAttribute("fill");
    return !!f && f !== "none" && f !== "transparent";
  }
  function hlPickTarget(evt) {
    const t = evt.target;
    if (t && t._hlPath) return t;         // 輪郭の明示指定は最優先
    if (hlPaintedShape(t)) return t;      // ヒット領域自体が塗られた図形
    // 透明ヒット領域なら、同じSVG内でカーソル直下にある塗られた図形
    // (pointer-events:none のラベル・斜線は elementsFromPoint に出ない)
    if (!t || !t.ownerSVGElement || evt.clientX == null) return null;
    for (const e of document.elementsFromPoint(evt.clientX, evt.clientY)) {
      if (e !== t && e.ownerSVGElement === t.ownerSVGElement
          && hlPaintedShape(e)) return e;
    }
    return null;
  }
  // 縁取り・クリップ用に、要素の幾何をなぞる裸の図形を作る
  function hlGeom(el) {
    if (el._hlPath) {
      const o = document.createElementNS(SVGNS, "path");
      o.setAttribute("d", el._hlPath);
      return o;
    }
    if (el.tagName === "rect") {
      const o = document.createElementNS(SVGNS, "rect");
      for (const k of ["x", "y", "width", "height", "rx", "ry"]) {
        const v = el.getAttribute(k);
        if (v != null) o.setAttribute(k, v);
      }
      return o;
    }
    if (el.tagName === "circle") {
      const o = document.createElementNS(SVGNS, "circle");
      for (const k of ["cx", "cy", "r"]) o.setAttribute(k, el.getAttribute(k));
      return o;
    }
    if (el.tagName === "path") {
      const o = document.createElementNS(SVGNS, "path");
      o.setAttribute("d", el.getAttribute("d") || "");
      return o;
    }
    return null;   // 線・面ホバー(polyline等)は縁取りしない
  }
  function hlMark(evt) {
    const t = evt.target;
    const el = hlPickTarget(evt);
    // pointermove の連打を無視(同じ帯でも月バンドが変われば描き直す)
    if (_hlCur && _hlCur.el === el && _hlCur.t === t) return el;
    hlClear();
    if (!el) return null;
    const o = hlGeom(el);
    if (!o) return null;
    o.setAttribute("class", "hl-outline");   // 見た目は style.css 1箇所で持つ
    const parts = [o];
    // 透明な月バンド越しに拾った図形(積み上げエリアの帯など)は全期間に
    // 広がっているので、縁取りをヒット領域の横範囲=その月に絞り、
    // 月境には図形の断面を通る縦線を立てて輪郭を閉じる。棒は元から
    // バンド内に収まっているので実質帯グラフだけに効く(縦線は交差せず
    // 何も描かれない)
    if (el !== t && t.tagName === "rect" && !el._hlPath) {
      const clip = document.createElementNS(SVGNS, "clipPath");
      clip.setAttribute("id", "hl-clip-" + (++_svgSeq));
      const cr = document.createElementNS(SVGNS, "rect");
      cr.setAttribute("x", t.getAttribute("x"));
      cr.setAttribute("width", t.getAttribute("width"));
      cr.setAttribute("y", -1e5);
      cr.setAttribute("height", 2e5);
      clip.appendChild(cr);
      svgDefs(el.ownerSVGElement).appendChild(clip);
      o.setAttribute("clip-path", `url(#${clip.getAttribute("id")})`);
      parts.push(clip);
      // 縦線: バンド境界の全高の縦線を図形自身で切り抜くと断面だけが残る
      const shapeClip = document.createElementNS(SVGNS, "clipPath");
      shapeClip.setAttribute("id", "hl-shape-" + (++_svgSeq));
      shapeClip.appendChild(hlGeom(el));
      svgDefs(el.ownerSVGElement).appendChild(shapeClip);
      const x1 = parseFloat(t.getAttribute("x"));
      const x2 = x1 + parseFloat(t.getAttribute("width"));
      const vl = document.createElementNS(SVGNS, "path");
      vl.setAttribute("d", `M${x1},-99999 V99999 M${x2},-99999 V99999`);
      vl.setAttribute("class", "hl-outline");
      vl.setAttribute("clip-path", `url(#${shapeClip.getAttribute("id")})`);
      el.parentNode.appendChild(vl);
      parts.push(shapeClip, vl);
    }
    // 親に入れると座標系(transform・クリップ)を引き継ぐ。_hlPath は
    // ルート座標前提なのでSVG直下(クリップで角が欠けない)
    (el._hlPath ? el.ownerSVGElement : el.parentNode).appendChild(o);
    if (el._hlLabel) el._hlLabel.style.fontWeight = "800";
    _hlCur = { el, t, parts, label: el._hlLabel || null };
    return el;
  }

  // 図の一部を「奥に引く」ための減光フィルタ(RGBをk倍する)。同じ文法で
  // 描いた面を色を変えずに暗くできるので、実績と予測のように意味だけが
  // 違うものを区別するのに使う(明るい側=主役)。パターン塗りにも効く
  function dimFilter(svg, k) {
    const f = document.createElementNS(SVGNS, "filter");
    f.setAttribute("id", "dim-" + (++_svgSeq));
    f.setAttribute("color-interpolation-filters", "sRGB");
    const m = document.createElementNS(SVGNS, "feColorMatrix");
    m.setAttribute("type", "matrix");
    m.setAttribute("values",
      `${k} 0 0 0 0  0 ${k} 0 0 0  0 0 ${k} 0 0  0 0 0 1 0`);
    f.appendChild(m);
    svgDefs(svg).appendChild(f);
    return `url(#${f.getAttribute("id")})`;
  }
  // 積み上げ棒用: 上角丸の棒型に切り抜いた<g>を返す。中にセグメントを
  // 素のrectで密着して描けば、資産構成バーと同じ「角丸・境界線なし」になる
  function stackGroup(svg, x, yBottom, w, h, down) {
    if (h <= 0) return null;
    const clip = document.createElementNS(SVGNS, "clipPath");
    clip.setAttribute("id", "vclip-" + (++_svgSeq));
    vbar(clip, x, yBottom, w, h, "none", down);
    svgDefs(svg).appendChild(clip);
    const g = document.createElementNS(SVGNS, "g");
    g.setAttribute("clip-path", `url(#${clip.getAttribute("id")})`);
    svg.appendChild(g);
    return g;
  }
  // 右角丸の横棒
  function hbarPath(svg, x, yc, w, h, color) {
    const r = Math.min(4, h / 2, w);
    const p = document.createElementNS(SVGNS, "path");
    p.setAttribute("d",
      `M${x},${yc - h / 2} h${Math.max(0, w - r)} q${r},0 ${r},${r} v${h - 2 * r} q0,${r} ${-r},${r} h${-Math.max(0, w - r)} z`);
    p.setAttribute("fill", color);
    svg.appendChild(p);
    return p;
  }
  function polyline(svg, pts, stroke, width, dash) {
    const p = document.createElementNS(SVGNS, "polyline");
    p.setAttribute("points", pts.map(([x, y]) => x + "," + y).join(" "));
    p.setAttribute("fill", "none");
    p.setAttribute("stroke", stroke);
    p.setAttribute("stroke-width", width || 2);
    p.setAttribute("stroke-linejoin", "round");
    p.setAttribute("stroke-linecap", "round");
    if (dash) p.setAttribute("stroke-dasharray", dash);
    svg.appendChild(p);
    return p;
  }
  function circle(svg, cx, cy, r, fill) {
    const c = document.createElementNS(SVGNS, "circle");
    c.setAttribute("cx", cx); c.setAttribute("cy", cy);
    c.setAttribute("r", r); c.setAttribute("fill", fill);
    svg.appendChild(c);
    return c;
  }
  // 上辺(topPts)と下辺(botPts)で囲む塗り面。扇形バンド(長期投影の
  // 悲観〜楽観帯)・元本vs評価額(投資リターン分析)で共用する汎用部品。
  // 各点は [x, y]。topPts は左→右、botPts も左→右で渡す(内部で反転する)
  function areaBand(svg, topPts, botPts, fill, opacity) {
    const p = document.createElementNS(SVGNS, "path");
    const top = topPts.map((pt) => pt.join(",")).join(" L ");
    const bot = botPts.slice().reverse().map((pt) => pt.join(",")).join(" L ");
    p.setAttribute("d", "M" + top + " L " + bot + " z");
    p.setAttribute("fill", fill);
    if (opacity != null) p.setAttribute("fill-opacity", opacity);
    svg.appendChild(p);
    return p;
  }
  // 月次(時系列)棒チャートの共通足場。横スクロール(scrollChart)に
  // Y軸グリッド(yAxis)とバンド幅の計算をまとめる。呼び出し側は svg に
  // 棒とヒット領域を描き、tick(i) で月ラベルを打ち、最後に
  // box.appendChild(wrap); done() を呼ぶ。
  //   ms   … 月の配列(tick が参照)
  //   opts … { h, per(月あたり幅), minW, padL, padR, padT,
  //            padB(省略時は monthTickPadB(band)), top, bot=0, step,
  //            fmt(Y軸ラベル), noAxis(軸を自前で描く場合 true) }
  //   bot には関数 (plotH)=>値 も渡せる(下向き棒のラベル余白確保など、
  //   確定した描画高さに依存する下限を呼び出し側で決めるため)。
  //   確定値は返り値の bot で受け取る
  function monthlyChart(ms, opts) {
    const { h: H, per = 40, minW = 420, padL = 46, padR = 8, padT = 10,
            top, step, fmt } = opts;
    const W = Math.max(minW, ms.length * per);
    const band = (W - padL - padR) / Math.max(1, ms.length);
    const padB = opts.padB != null ? opts.padB : monthTickPadB(band);
    const plotH = H - padT - padB;
    const bot = (typeof opts.bot === "function" ? opts.bot(plotH)
                 : opts.bot) || 0;
    const y = (v) => padT + plotH * (top - v) / Math.max(1, top - bot);
    const sc = scrollChart(W, H, padL);
    const iNow = ms.indexOf(curMonth);
    if (iNow >= 0) nowBand(sc.plot, padL + band * iNow, 0, band, H);
    if (!opts.noAxis) {
      yAxis(sc.plot, sc.axis, { y, bot, top, step, x0: padL, x1: W - padR, fmt });
    }
    return {
      svg: sc.plot, axis: sc.axis, wrap: sc.wrap, done: sc.done,
      y, band, padB, plotH, W, H, bot,
      tick: (i) => monthTick(sc.plot, padL + band * i + band / 2, ms[i], band, H),
    };
  }

  // 簡易サンキー図(列数はノードの col から自動)。ノードは列ごとに配列順で
  // 縦に積み、値に比例した高さ+固定ギャップ。リンクはベジェのリボンで結ぶ。
  //   data.nodes : [{id, col(0..n), label, value, color}]
  //   data.links : [{source, target, value, color}]
  //   opts       : { width, height, tipNode(node)→rows, tipLink(link)→rows }
  // 交差の最小化はしない(列内の順序は呼び出し側が決める前提)。
  // ラベルの置き方: 両端列はノードの左/右(見切れないよう余白をラベル幅の
  // 見積もりから確保し、縦の衝突は押し下げ/押し上げで解消)。中間列は
  // ノードの上(かぶらないよう中間列だけノード間ギャップを広げる)。
  function drawSankey(box, data, opts) {
    box.replaceChildren();
    opts = opts || {};
    const nodes = data.nodes, links = data.links;
    const byId = new Map(nodes.map((nd) => [nd.id, nd]));
    const nCols = Math.max(...nodes.map((nd) => nd.col)) + 1;
    const cols = Array.from({ length: nCols },
                            (_, c) => nodes.filter((nd) => nd.col === c));
    const W = opts.width || 900;
    const nodeW = 13, padT = 14, padB = 10;
    // 両端列の項目数に応じて縦に伸ばす(1項目あたりラベル1行+余白の17px)。
    // 高さ固定だと項目の多い期間で行間が詰まり、押し出されたラベルと
    // ノードの対応が読めなくなる
    const sideCount = Math.max(cols[0].length, cols[nCols - 1].length, 1);
    const H = Math.max(opts.height || 380, padT + padB + sideCount * 17);
    const labelOf = (nd) => nd.label + " " + KB.compact(nd.value);
    const padLeft = Math.min(240, Math.max(40,
      ...cols[0].map((nd) => estTextW(labelOf(nd)) + 10)));
    const padRight = Math.min(260, Math.max(40,
      ...cols[nCols - 1].map((nd) => estTextW(labelOf(nd)) + 10)));
    // 中間列はラベル(bar-label-sm)がノードの上に載るぶんギャップを広げる。
    // 最終列は小さいノードが連続してもラベル(13px)がノードの横に収まる
    // よう、ギャップ自体を行の高さ近くまで取る
    const gapOf = (c) => c === 0 ? 8 : c === nCols - 1 ? 12 : 18;
    const plotH = H - padT - padB;
    // どの列でもギャップ込みで plotH に収まる縮尺
    const scale = Math.min(...cols.map((cn, c) => {
      const total = cn.reduce((s, nd) => s + nd.value, 0);
      return (plotH - gapOf(c) * Math.max(0, cn.length - 1))
        / Math.max(1, total);
    }));
    const colX = [];
    for (let c = 0; c < nCols; c++) {
      colX.push(padLeft + (W - padRight - nodeW - padLeft)
        * (nCols <= 1 ? 0 : c / (nCols - 1)));
    }
    // 縮尺固定+横スクロール(口座間NWと同じ作法)。狭い画面で viewBox を
    // 縮小するとラベルが読めない大きさになるため、原寸のままスクロールで見せる
    const svg = mkFixedSvg(W, H);
    svg.style.margin = "0 auto";
    // ノードの配置(列ごとに上から積む)。全体を縦中央寄せ
    cols.forEach((cn, c) => {
      const total = cn.reduce((s, nd) => s + nd.value * scale, 0)
        + gapOf(c) * Math.max(0, cn.length - 1);
      let y = padT + (plotH - total) / 2;
      for (const nd of cn) {
        nd._x = colX[c];
        nd._y0 = y;
        nd._h = Math.max(1, nd.value * scale);
        nd._sOff = 0; nd._tOff = 0;
        y += nd._h + gapOf(c);
      }
    });
    // リンク(リボン)を先に描く。source/target の配列順に沿って積むと
    // 同じノード内での交差が最小になる
    const ordered = links.slice().sort((a, b) => {
      const sa = byId.get(a.source), sb = byId.get(b.source);
      if (sa._y0 !== sb._y0) return sa._y0 - sb._y0;
      const ta = byId.get(a.target), tb = byId.get(b.target);
      return ta._y0 - tb._y0;
    });
    for (const lk of ordered) {
      const s = byId.get(lk.source), t = byId.get(lk.target);
      if (!s || !t) continue;
      const h = Math.max(0.6, lk.value * scale);
      const sx = s._x + nodeW, tx = t._x;
      const syT = s._y0 + s._sOff, tyT = t._y0 + t._tOff;
      s._sOff += h; t._tOff += h;
      const mx = (sx + tx) / 2;
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d",
        `M${sx},${syT} C${mx},${syT} ${mx},${tyT} ${tx},${tyT} ` +
        `L${tx},${tyT + h} C${mx},${tyT + h} ${mx},${syT + h} ${sx},${syT + h} Z`);
      p.setAttribute("fill", lk.color || cssVar("--grid"));
      p.setAttribute("fill-opacity", "0.4");
      if (opts.tipLink) {
        p.addEventListener("pointermove", (evt) => {
          KB.showTip(evt, "", opts.tipLink(lk));
        });
        p.addEventListener("pointerleave", KB.hideTip);
      }
      svg.appendChild(p);
    }
    for (const nd of nodes) {
      const r = rect(svg, nd._x, nd._y0, nodeW, nd._h, nd.color || cssVar("--ink-2"));
      r.setAttribute("rx", 3);
      if (opts.tipNode) {
        r.addEventListener("pointermove", (evt) => {
          KB.showTip(evt, nd.label, opts.tipNode(nd));
        });
        r.addEventListener("pointerleave", KB.hideTip);
      }
    }
    // 両端列のラベル。小さいノードが続くとノード中心どうしが行の高さより
    // 近くなるので、上から押し下げ→下端を超えたら下から押し上げで解消する
    const LH = 13;
    const placeSide = (cn, tx, anchor) => {
      const items = cn.map((nd) => ({ nd, y: nd._y0 + nd._h / 2 + 3.5 }))
        .sort((a, b) => a.y - b.y);
      for (let i = 1; i < items.length; i++) {
        if (items[i].y < items[i - 1].y + LH) items[i].y = items[i - 1].y + LH;
      }
      for (let i = items.length - 1; i >= 0; i--) {
        const limit = i === items.length - 1 ? H - 4 : items[i + 1].y - LH;
        if (items[i].y > limit) items[i].y = limit;
      }
      for (const it of items) {
        text(svg, tx(it.nd), it.y, labelOf(it.nd), "axis-label", anchor);
      }
    };
    placeSide(cols[0], (nd) => nd._x - 6, "end");
    placeSide(cols[nCols - 1], (nd) => nd._x + nodeW + 6, "start");
    // 中間列はノードの上に小さく(広げたギャップに収まる)
    for (let c = 1; c < nCols - 1; c++) {
      for (const nd of cols[c]) {
        text(svg, nd._x + nodeW / 2, nd._y0 - 4, labelOf(nd),
             "bar-label-sm", "middle");
      }
    }
    box.appendChild(svg);
  }

  // カレンダーヒートマップ(GitHub の草風)。週=列・曜日=行。
  //   dayMap : Map(YYYY-MM-DD → 値)。値の大きさをセルの濃さにする
  //   opts   : { color, max(満濃度の値。外れ値で潰れないよう分位点を渡す),
  //              start, end(省略時は dayMap の範囲), tipRows(date,val)→rows,
  //              weekdayAvg(true で右に曜日別平均の小横棒) }
  function drawHeatmapCal(box, dayMap, opts) {
    box.replaceChildren();
    opts = opts || {};
    const keys = [...dayMap.keys()].sort();
    if (!keys.length) { KB.note(box, "対象データがありません"); return; }
    const start = opts.start || keys[0];
    const end = opts.end || keys[keys.length - 1];
    const color = opts.color || cssVar("--expense");
    const max = opts.max || Math.max(1, ...dayMap.values());
    const cell = 15, gap = 3, step = cell + gap;
    // 週の起点は start を含む週の日曜
    const d0 = new Date(start + "T00:00:00");
    d0.setDate(d0.getDate() - d0.getDay());
    const dEnd = new Date(end + "T00:00:00");
    const weeks = Math.floor((dEnd - d0) / 86400000 / 7) + 1;
    const padL = 30, padT = 18;
    const gridW = weeks * step;
    const H = padT + 7 * step + 6;
    // 期間が長いと週数が膨れてセルが潰れるため、縮小せず横スクロールに
    // する(月次チャートと同じ作法。右端=最新週へ寄せる)
    const sc = scrollChart(padL + gridW, H, padL);
    const svg = sc.plot;
    // 曜日ラベル(全曜日)は左の固定軸に
    const wd = ["日", "月", "火", "水", "木", "金", "土"];
    for (let r = 0; r < 7; r++) {
      text(sc.axis, padL - 6, padT + r * step + cell - 3, wd[r],
           "axis-label", "end");
    }
    let lastMonth = "";
    const iso = KB.localIso;   // toISOString は UTC 変換で1日ずれる(JST)
    for (let w = 0; w < weeks; w++) {
      for (let r = 0; r < 7; r++) {
        const d = new Date(d0);
        d.setDate(d.getDate() + w * 7 + r);
        const day = iso(d);
        if (day < start || day > end) continue;
        // 月替わりのラベル(その月の最初の週の上に)
        const mo = day.slice(0, 7);
        if (mo !== lastMonth && r <= 1) {
          lastMonth = mo;
          text(svg, padL + w * step, padT - 6,
               Number(day.slice(5, 7)) + "月", "axis-label", "start");
        }
        const v = dayMap.get(day) || 0;
        const x = padL + w * step, y = padT + r * step;
        const rc = rect(svg, x, y, cell, cell, v > 0 ? color : cssVar("--grid"));
        rc.setAttribute("rx", 3);
        if (v > 0) rc.setAttribute("fill-opacity",
          (0.15 + 0.85 * Math.min(1, v / max)).toFixed(3));
        rc.addEventListener("pointermove", (evt) => {
          const rows = opts.tipRows ? opts.tipRows(day, v)
            : [{ name: "支出", value: KB.fmt(v) }];
          KB.showTip(evt, day, rows);
        });
        rc.addEventListener("pointerleave", KB.hideTip);
      }
    }
    if (opts.weekdayAvg) {
      // 曜日別平均はスクロールに追従しない右側の固定パネルに描く。
      // 幅140 = 棒とギャップ+金額ラベル("1万2千"等)が見切れない幅
      const sideW = 140;
      const avgSvg = mkFixedSvg(sideW, H);
      // 母数は期間内の全日(支出のあった日だけで割ると「火曜に平均いくら
      // 使うか」と読まれる数字が実態の1.5〜2倍に膨らむ)
      const sum = new Array(7).fill(0), cnt = new Array(7).fill(0);
      for (let d = new Date(start + "T00:00:00"),
               e = new Date(end + "T00:00:00"); d <= e;
           d.setDate(d.getDate() + 1)) {
        const wdi = d.getDay();
        sum[wdi] += dayMap.get(iso(d)) || 0;
        cnt[wdi]++;
      }
      const avg = sum.map((s, i) => cnt[i] ? s / cnt[i] : 0);
      const amax = Math.max(1, ...avg);
      const bx = 14, bw = sideW - 66;   // 右端にラベル分を残す
      for (let r = 0; r < 7; r++) {
        const y = padT + r * step + cell / 2;
        const w = avg[r] / amax * bw;
        hbarPath(avgSvg, bx, y, Math.max(1, w), 9, color);
        text(avgSvg, bx + bw + 4, y + 3, KB.compact(avg[r]),
             "axis-label", "start");
      }
      text(avgSvg, bx, padT - 6, "曜日平均", "axis-label", "start");
      sc.wrap.appendChild(avgSvg);
    }
    box.appendChild(sc.wrap);
    sc.done();
  }

  // ツールチップ用の小ドーナツ。wedges=[{name,value,color,hl?}]。
  // 凡例を下に並べるのではなく、扇形から引き出し線を伸ばしてラベル付けする。
  // レイアウトは左右に振り分け、縦方向の衝突を最小間隔で解消する簡易版。
  // hl を立てた扇形は枠線+ラベル太字で控えめに強調する(色は変えない)。
  function ttDonut(wedges, size, inner) {
    // 二重ドーナツは中心の穴に内リングのラベル(名前+金額)と
    // 引き出し線トラックを収めるため大きめ
    const D = inner ? Math.max(size || 104, 230) : (size || 104);
    const LH = 26;                      // ラベル1個分の高さ(名前+値の2行)
    // 引き出しラベルは左右に振り分けて縦に積む。高さは「多い側の個数」で
    // 決め(均等割を仮定すると片側に偏ったとき下端で重なる)、左右の
    // ラベル領域は実際に置くラベルの幅に合わせる(固定幅だと資産・負債の
    // ドーナツを横に並べたとき間の余白ばかりが目立つ)
    let nR = 0, nL = 0, wR = 0, wL = 0;
    {
      const pos = wedges.filter((w) => w.value > 0);
      const total = pos.reduce((s, w) => s + w.value, 0);
      let ang = -Math.PI / 2;
      for (const w of pos) {
        const a2 = ang + (total > 0 ? w.value / total : 0) * 2 * Math.PI;
        const lw = Math.max(estTextW(truncate(w.name, 12)),
                            estTextW(compact(w.value)));
        if (Math.cos((ang + a2) / 2) >= 0) { nR++; wR = Math.max(wR, lw); }
        else { nL++; wL = Math.max(wL, lw); }
        ang = a2;
      }
    }
    // ラベル文字は中心から rO+21 ≒ ドーナツ端+19px の位置から始まる
    const sideR = nR ? wR + 24 : 10, sideL = nL ? wL + 24 : 10;
    const W = D + sideL + sideR;
    const H = Math.max(D + 12, Math.max(nR, nL) * LH + 12);
    const cx = sideL + D / 2, cy = H / 2;
    // 内リングあり(二重ドーナツ)なら外リングを薄くして内側に場所を空ける
    const rO = D / 2 - 2, rI = inner ? D * 0.42 : D * 0.3;
    const svg = document.createElementNS(SVGNS, "svg");
    svg.setAttribute("viewBox", `0 0 ${W} ${H}`);
    svg.setAttribute("width", W); svg.setAttribute("height", H);
    svg.style.cssText = "display:block;margin:2px auto 6px";
    // 1リングぶんの扇形を描く。ラベル用の基準角リストを返す
    function ring(ws, rOut, rIn) {
      const pos = ws.filter((w) => w.value > 0);
      const total = pos.reduce((s, w) => s + w.value, 0);
      const items = [];
      if (total <= 0) return items;
      // hl の枠線は全扇形より後に重ねる(隣の扇形の塗りに縁を消されない
      // よう、輪郭だけの path を最後に描く)
      const hlDs = [];
      let ang = -Math.PI / 2;
      for (const w of pos) {
        const a2 = ang + (w.value / total) * 2 * Math.PI;
        const mid = (ang + a2) / 2;
        if (pos.length === 1) {         // 単一構成はリング(退化した扇形を避ける)
          const c = circle(svg, cx, cy, (rOut + rIn) / 2, "none");
          c._wedge = w;   // 単体チャートとして使う呼び出し側のホバー用
          c.setAttribute("stroke", w.color);
          c.setAttribute("stroke-width", rOut - rIn);
          if (w.hl) for (const rr of [rOut, rIn]) {
            circle(svg, cx, cy, rr, "none")
              .setAttribute("class", "hl-outline");
          }
        } else {
          const large = (a2 - ang) > Math.PI ? 1 : 0;
          const p = document.createElementNS(SVGNS, "path");
          p.setAttribute("d",
            `M${cx + rOut * Math.cos(ang)},${cy + rOut * Math.sin(ang)} ` +
            `A${rOut},${rOut} 0 ${large} 1 ${cx + rOut * Math.cos(a2)},${cy + rOut * Math.sin(a2)} ` +
            `L${cx + rIn * Math.cos(a2)},${cy + rIn * Math.sin(a2)} ` +
            `A${rIn},${rIn} 0 ${large} 0 ${cx + rIn * Math.cos(ang)},${cy + rIn * Math.sin(ang)} z`);
          p.setAttribute("fill", w.color);
          p._wedge = w;   // 単体チャートとして使う呼び出し側のホバー用
          svg.appendChild(p);
          if (w.hl) hlDs.push(p.getAttribute("d"));
        }
        // 面積が十分な扇形には構成比を書き込む(リング帯が文字高より細い
        // 小径ドーナツでは省く。はみ出た白文字は背景に溶けて読めない)。
        // 白文字が扇形の外に出ると背景に溶けるため、円弧に沿う向きで
        // リング帯の中に収める。
        // 左右の位置では縦書きになってしまうので、扇形の範囲内で
        // 12時/6時に最も近い角度を選び、なるべく水平に近い向きにする
        const share = w.value / total;
        if (share >= 0.08 && rOut - rIn >= 12) {
          const rm = (rOut + rIn) / 2;
          const m0 = Math.min((a2 - ang) / 2, 14 / rm);
          let th = mid, best = Infinity;
          for (const c of [-Math.PI / 2, Math.PI / 2, Math.PI * 1.5]) {
            const cl = Math.min(Math.max(c, ang + m0), a2 - m0);
            if (Math.abs(cl - c) < best) { best = Math.abs(cl - c); th = cl; }
          }
          let rot = th * 180 / Math.PI + 90;
          while (rot > 90) rot -= 180;    // 下半分は反転して正立させる
          const px = cx + rm * Math.cos(th), py = cy + rm * Math.sin(th);
          const t = text(svg, px, py + 3.5, Math.round(share * 100) + "%",
                         "seg-label", "middle");
          if (w.hl) t.style.fontWeight = "800";
          if (Math.abs(rot) > 1) {
            t.setAttribute("transform", `rotate(${rot} ${px} ${py})`);
          }
        }
        items.push({ ...w, mid });
        ang = a2;
      }
      for (const d of hlDs) {
        const o = document.createElementNS(SVGNS, "path");
        o.setAttribute("d", d);
        o.setAttribute("class", "hl-outline");
        svg.appendChild(o);
      }
      return items;
    }
    // 引き出し線ラベルは外リングのみ。内リングは中心の穴に書く
    const items = ring(wedges, rO, rI).map((it) => ({ ...it, r: rO - 1 }));
    if (!items.length) return svg;
    if (inner) {
      // 内リングは 0.40〜0.32 の帯。外リング内径(0.42)との差 0.02 が
      // 両リングの隙間で、片方だけ変えると重なる
      const rIn = D * 0.32;
      const inItems = ring(inner, D * 0.4, rIn)
        .filter((it) => it.value > 0);
      // 中心の穴に「色ドット+名前+金額」を縦に積む(外ラベルと等価の情報)
      const CLH = 15;
      // 行割当は扇形の高さ(sin)順: 上の扇形ほど上の行にすると、トラックの
      // 移動距離が最短になり線同士も交差しない。線が出入りする側(左右)も
      // 扇形のある側に行ごとに合わせ、ドットはその側の端に置く
      const sorted = inItems.slice()
        .sort((a, b) => Math.sin(a.mid) - Math.sin(b.mid));
      const rows2 = sorted.map((it, i) => {
        const label = truncate(it.name, 6) + " " + compact(it.value);
        const tw = [...label].reduce(
          (s, ch) => s + (ch.charCodeAt(0) > 255 ? 11 : 6), 0);
        const ly = cy - (sorted.length - 1) * CLH / 2 + i * CLH;
        const right = Math.cos(it.mid) >= 0;
        return { it, label, ly, right,
                 dx: cx + 5 + (right ? 1 : -1) * (tw / 2 + 8) };
      });
      // 引き出し線: 扇形から法線方向に少し入り、穴の縁に沿った同心円
      // トラックを回って自分の行の高さまで来たら、行の側から水平にドットへ
      // 入る(色は扇形と同じ)。トラックは穴の縁ぎわに項目ごとに少しずつ
      // ずらして敷き、中央のラベル文字の上を横切らないようにする。
      // 先に線を全部描き、ドット・文字を上に重ねる
      const norm = (a) => {
        while (a > Math.PI) a -= 2 * Math.PI;
        while (a < -Math.PI) a += 2 * Math.PI;
        return a;
      };
      // 弧の長さ(概算)。トラックの割当順を決めるためだけに使う
      const sweepOf = (r) => {
        const dyR = r.ly - cy;
        const w = Math.sqrt(Math.max(0, (rIn - 3) * (rIn - 3) - dyR * dyR));
        return Math.abs(norm(
          Math.atan2(dyR, (r.right ? w : -w)) - r.it.mid));
      };
      // 弧が短い項目ほど縁側(大半径)のトラックを使う。長い弧を内側に
      // 入れ子にすると、他の行の法線スタブや水平区間と交差しない
      const rank = new Map(rows2.slice()
        .sort((a, b) => sweepOf(a) - sweepOf(b)).map((r, i) => [r, i]));
      rows2.forEach((row) => {
        const { it, ly, dx, right } = row;
        const dyR = ly - cy;
        // 行の高さに水平区間を取れて、かつドットまで外向きに戻らず届く
        // 半径は必ず確保する(穴の縁は超えない)
        const rT = Math.min(rIn - 2, Math.max(
          rIn - 3 - rank.get(row) * 4,
          Math.abs(dyR) + 6,
          Math.hypot(Math.abs(dx - cx) + 2, dyR)));
        const a0 = it.mid;
        // トラック上で行の高さに達する行側半分の点が水平区間の起点
        const ex = cx + (right ? 1 : -1)
          * Math.sqrt(Math.max(0, rT * rT - dyR * dyR));
        const da = norm(Math.atan2(dyR, ex - cx) - a0);  // 短い方向に回る
        const a1 = a0 + da;
        const pt = (r, a) => `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
        const p = document.createElementNS(SVGNS, "path");
        p.setAttribute("d", `M${pt(rIn + 2, a0)} L${pt(rT, a0)} ` +
          `A${rT},${rT} 0 0 ${da >= 0 ? 1 : 0} ${pt(rT, a1)} L${dx},${ly}`);
        p.setAttribute("fill", "none");
        p.setAttribute("stroke", it.color);
        p.setAttribute("stroke-width", 1);
        svg.appendChild(p);
      });
      for (const { it, label, ly, dx } of rows2) {
        circle(svg, dx, ly, 3.5, it.color);
        const t = text(svg, cx + 5, ly + 4, label, "axis-label", "middle");
        t.setAttribute("fill", cssVar(it.hl ? "--ink" : "--ink-2"));
        if (it.hl) t.style.fontWeight = "700";
      }
    }
    // 引き出し線ラベル(名前+値の2行): 左右に振り分け →
    // 上から順に最小間隔で押し下げて衝突を避ける
    for (const group of [
      items.filter((i) => Math.cos(i.mid) >= 0),
      items.filter((i) => Math.cos(i.mid) < 0),
    ]) {
      group.sort((a, b) => Math.sin(a.mid) - Math.sin(b.mid));
      // 位置決めは2パス: 上から最小間隔で押し下げ→下端からはみ出したら
      // 間隔を保ったまま押し上げる(片端クランプだけだと下側に密集した
      // ときに後続が同じ位置に張り付いて重なる)
      const lys = [];
      for (let i = 0; i < group.length; i++) {
        const nat = cy + (rO + 6) * Math.sin(group[i].mid);
        lys.push(Math.max(nat, i ? lys[i - 1] + LH : 10, 10));
      }
      for (let i = group.length - 1; i >= 0; i--) {
        lys[i] = Math.min(lys[i],
          i === group.length - 1 ? H - 10 : lys[i + 1] - LH);
      }
      group.forEach((it, gi) => {
        const ly = lys[gi];
        const right = Math.cos(it.mid) >= 0;
        const cosM = Math.cos(it.mid), sinM = Math.sin(it.mid);
        const lx = right ? cx + rO + 10 : cx - rO - 10;
        // 扇形から法線方向(放射方向)にまっすぐ少し出てから、かくっと
        // 曲がってラベルの色ドットに結ぶ。線色は扇形の色で対応を示す
        const dotX = lx + (right ? 4 : -4), dotY = ly - 5;
        polyline(svg, [
          [cx + it.r * cosM, cy + it.r * sinM],
          [cx + (rO + 5) * cosM, cy + (rO + 5) * sinM],
          [dotX, dotY],
        ], it.color, 1);
        // 線の先に色ドット、その外側に名前+金額(中心ラベルと等価の表現)
        circle(svg, dotX, dotY, 3.5, it.color);
        const tx = lx + (right ? 11 : -11);
        const anchor = right ? "start" : "end";
        const nameEl = text(svg, tx, ly - 1, truncate(it.name, 12),
                            "axis-label", anchor);
        nameEl.setAttribute("fill", cssVar(it.hl ? "--ink" : "--ink-2"));
        const valEl = text(svg, tx, ly + 10, compact(it.value),
                           "axis-label", anchor);
        valEl.setAttribute("fill", cssVar(it.hl ? "--ink" : "--muted"));
        if (it.hl) {
          nameEl.style.fontWeight = "700";
          valEl.style.fontWeight = "700";
        }
      });
    }
    return svg;
  }

  Object.assign(KB, {
    SVGNS, mkSvg, mkFixedSvg, scrollChart, line, rect, text, monthTickPadB, monthTick,
    vbar, svgDefs, stripePattern, stripeCss, dimFilter, stackGroup, hbarPath, polyline,
    circle, areaBand, drawHeatmapCal, drawSankey, ttDonut, nextSvgSeq,
    hlMark, hlClear,
    estTextW, yAxis, legendKey, monthlyChart, nowBand,
  });
})();
