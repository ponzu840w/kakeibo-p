"use strict";
// svgkit-network.js: 有向フローネットワーク(口座間資金流)の描画。
// 決定論の力学レイアウト+交差評価+壁描画で自己完結するため
// svgkit.js から分割している(svgkit.js の直後に読み込む)。
(function () {
  const KB = window.KB;
  const { SVGNS, cssVar, mkFixedSvg, line, rect, text, circle, estTextW } = KB;

  // 有向フローネットワーク(口座間資金流用)。段階(列)を作らず、
  // ノード=円(大きさ∝通過額)・エッジ=太さ∝金額の曲線+矢印で描く。
  // wall 指定のノードは円でなく辺に沿う壁バーにする:
  //   bottom … 下辺の横長バー。エッジは各ノードから垂直に落とす(支出)
  //   top    … 上辺の横長バー。エッジは各ノードへ垂直に注ぐ(収入)
  //   right  … 右辺の縦長バー。エッジは水平に出入りする(有価証券の
  //            買付=壁へ、売却=壁から。同一ノードと両方向あるので
  //            行きと戻りを少し上下にずらして描く)
  //   left   … 左辺の縦長バー。右壁の鏡像(負債の借入=壁から、返済=壁へ)
  // ほぼ全ノードと繋がる集約ノードを円にすると中央にエッジが密集する
  // ため、壁ならどこからでも最短の直線で届く。
  // 配置は決定論の力学レイアウト: 楕円初期配置(呼び出し側の配列順)から
  // 反発+ばね+中心引力を固定回数だけ反復する。乱数は使わない
  // (同じデータなら常に同じ図)。壁への流量が大きいノードほどその壁へ
  // 引かれ、上=入口・中=経由・下=出口の勾配が自然にできる。
  //   data.nodes : [{id, label, value(通過額), color, wall?, band?}]
  //     band="top" のノードは最上段に固定(x方向だけ動く)
  //   data.edges : [{source, target, value, color}]
  //   opts       : { width, height, tipNode(node), tipLink(edge),
  //                  clickNode(node), clickLink(edge) }
  //     tipNode/tipLink は rows 配列、または {title, rows, pie} を返せる
  //     (pie は showTip のドーナツにそのまま渡る)
  function drawFlowNetwork(box, data, opts) {
    box.replaceChildren();
    opts = opts || {};
    const tipShow = (evt, fallback, res) => {
      if (!res) return;
      if (Array.isArray(res)) KB.showTip(evt, fallback, res);
      else KB.showTip(evt, res.title != null ? res.title : fallback,
                      res.rows || [], res.pie);
    };
    const bindClick = (el, fn, arg) => {
      if (!fn) return;
      el.style.cursor = "pointer";
      el.addEventListener("click", (evt) => {
        evt.stopPropagation();
        KB.hideTip();
        fn(arg);
      });
    };
    const W = opts.width || 940, H = opts.height || 520;
    const nodes = data.nodes, edges = data.edges;
    const wallB = nodes.find((n) => n.wall === "bottom");
    const wallT = nodes.find((n) => n.wall === "top");
    const wallR = nodes.find((n) => n.wall === "right");
    const wallRT = nodes.find((n) => n.wall === "right-top");  // 右壁上部の別枠
    const wallL = nodes.find((n) => n.wall === "left");
    const isRW = (n) => n === wallR || n === wallRT;
    const simNodes = nodes.filter((n) => !n.wall);
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const barTh = 28;                                  // 壁バーの太さ
    const wallY = wallB ? H - barTh - 8 : H - 8;       // 下壁の上辺
    const wallTY = wallT ? 8 + barTh : 0;              // 上壁の下辺
    const hasRight = !!(wallR || wallRT);
    const wallRX = hasRight ? W - barTh - 8 : W;       // 右壁の左辺
    const wallLX = wallL ? 8 + barTh : 0;              // 左壁の右辺
    const topY = wallTY + 56;                          // band="top" の固定y
    const hasTop = nodes.some((n) => n.band === "top");
    const minY = hasTop ? topY + 72 : wallTY + 46;
    const maxX = hasRight ? wallRX - 96 : W - 80;
    const minX = wallL ? wallLX + 96 : 80;
    // 右壁の縦区間。right-top は上端から全長の15%を目安に取り、縦書き
    // ラベルが読める高さを下限にする。right(有価証券)は残りの区間
    const rwY1 = wallT ? wallTY + 10 : 10;
    const rwY2 = wallB ? wallY - 10 : H - 10;
    const rtH = wallRT ? Math.max((rwY2 - rwY1) * 0.15,
      estTextW(wallRT.label + " " + KB.compact(wallRT.value)) + 20) : 0;
    const rtSeg = { y1: rwY1, y2: rwY1 + rtH };
    const rSeg = { y1: wallRT ? rtSeg.y2 + 8 : rwY1, y2: rwY2 };
    // 左壁の縦区間は右壁と同じ上下端(rwY1/rwY2)を使う
    const cx = (minX + maxX) / 2, cy = (topY + wallY) / 2;
    // ノードの次数(壁とのエッジは除く)。葉ノードの検出に使う
    const deg = new Map();
    for (const e of edges) {
      const a = byId.get(e.source), b = byId.get(e.target);
      if (!a || !b || a.wall || b.wall) continue;
      deg.set(a, (deg.get(a) || 0) + 1);
      deg.set(b, (deg.get(b) || 0) + 1);
    }
    // 初期配置は楕円(横長のキャンバスを最初から使う)
    const Rx = (maxX - minX) / 2 - 30, Ry = (wallY - topY) / 2 - 44;
    simNodes.forEach((n, i) => {
      const th = 2 * Math.PI * i / simNodes.length - Math.PI / 2;
      n._x = cx + Rx * Math.cos(th);
      n._y = n.band === "top" ? topY : cy + Ry * Math.sin(th);
    });
    // 葉ノード → 唯一の相手。初期配置とレーン押し出しの向き付けに使う
    const leafPartner = new Map();
    for (const n of simNodes) {
      if (deg.get(n) !== 1) continue;
      const e = edges.find((e2) => {
        const a = byId.get(e2.source), b = byId.get(e2.target);
        return !a.wall && !b.wall && (a === n || b === n);
      });
      const p = byId.get(e.source) === n
        ? byId.get(e.target) : byId.get(e.source);
      leafPartner.set(n, p);
    }
    // 葉ノードは唯一の相手の隣から始める。楕円の遠い位置から始めると、
    // 途中の経路押し出し・斥力の網を(弱いバネでは)越えられず、
    // 無関係な場所に取り残されることがある
    for (const [n, p] of leafPartner) {
      if (n.band === "top") continue;
      n._x = Math.max(minX, Math.min(maxX, p._x + (n._x >= p._x ? 70 : -70)));
      n._y = Math.max(minY, Math.min(wallY - 64, p._y + 70));
    }
    const maxE = Math.max(1, ...edges.map((e) => e.value));
    const maxN = Math.max(1, ...nodes.map((n) => n.value));
    const rOf = (n) => 7 + 15 * Math.sqrt(n.value / maxN);
    // ラベルの半幅(円の下に横書きするため、縦が近いノード同士は
    // この幅までx分離しないと文字が繋がって読める)
    const lhw = (n) => estTextW(n.label) / 2 + 10;
    // 下壁に落とすノード同士はドロップ線が重ならないよう x を強めに分離、
    // 右壁と出入りするノード同士は水平線が重ならないよう y を分離する
    const wallSrc = wallB
      ? [...new Set(edges.filter((e) =>
          byId.get(e.target) === wallB || byId.get(e.source) === wallB)
          .map((e) => byId.get(e.source) === wallB
            ? byId.get(e.target) : byId.get(e.source)))]
      : [];
    const rightPeers = hasRight
      ? [...new Set(edges.filter((e) =>
          isRW(byId.get(e.target)) || isRW(byId.get(e.source)))
          .map((e) => isRW(byId.get(e.source))
            ? byId.get(e.target) : byId.get(e.source)))]
      : [];
    const leftPeers = wallL
      ? [...new Set(edges.filter((e) =>
          byId.get(e.target) === wallL || byId.get(e.source) === wallL)
          .map((e) => byId.get(e.source) === wallL
            ? byId.get(e.target) : byId.get(e.source)))]
      : [];
    const tops = simNodes.filter((n) => n.band === "top");
    for (let it = 0; it < 300; it++) {
      const cool = 1 - it / 300;
      for (const n of simNodes) { n._dx = 0; n._dy = 0; }
      for (let i = 0; i < simNodes.length; i++) {
        for (let j = i + 1; j < simNodes.length; j++) {
          const a = simNodes[i], b = simNodes[j];
          let dx = a._x - b._x, dy = a._y - b._y;
          const d2 = dx * dx + dy * dy || 1;
          const d = Math.sqrt(d2);
          // 反発: 逆二乗+「円が重ならない最小距離」以内では強い斥力
          const dmin = rOf(a) + rOf(b) + 48;
          const f = 9000 / d2 + Math.max(0, dmin - d) * 0.55;
          const ux = dx / d, uy = dy / d;
          a._dx += ux * f; a._dy += uy * f;
          b._dx -= ux * f; b._dy -= uy * f;
          // ラベル行の重なり回避: 縦位置が近い(ラベルが同じ行に並ぶ)
          // ペアは、ラベル幅の和までx方向に異方分離する
          if (Math.abs(dy) < 34) {
            const needX = lhw(a) + lhw(b) - Math.abs(dx);
            if (needX > 0) {
              const s = (dx >= 0 ? 1 : -1) * needX * 0.18;
              a._dx += s; b._dx -= s;
            }
          }
        }
      }
      for (let i = 0; i < wallSrc.length; i++) {
        for (let j = i + 1; j < wallSrc.length; j++) {
          const a = wallSrc[i], b = wallSrc[j];
          const dx = a._x - b._x;
          const gap = 92 - Math.abs(dx);
          if (gap > 0) {
            // 分離の向きも「今いる側」でなく、葉なら「唯一の相手がいる側」
            // へ(s>0 で a が右・b が左)。この分離はレーン押し出しより
            // 強く、誤った側に入った葉はバネでは二度と戻れない
            let sign = dx >= 0 ? 1 : -1;
            const pa = leafPartner.get(a), pb = leafPartner.get(b);
            if (pa && pa !== b) sign = pa._x >= b._x ? 1 : -1;
            else if (pb && pb !== a) sign = pb._x >= a._x ? -1 : 1;
            const s = sign * gap * 0.25;
            a._dx += s; b._dx -= s;
          }
        }
      }
      // 最上段バンドは同じyに並ぶため、ラベルが読める幅までxを分離する
      for (let i = 0; i < tops.length; i++) {
        for (let j = i + 1; j < tops.length; j++) {
          const a = tops[i], b = tops[j];
          const dx = a._x - b._x;
          const gap = 180 - Math.abs(dx);
          if (gap > 0) {
            const s = (dx >= 0 ? 1 : -1) * gap * 0.3;
            a._dx += s; b._dx -= s;
          }
        }
      }
      for (const peers of [rightPeers, leftPeers]) {
        for (let i = 0; i < peers.length; i++) {
          for (let j = i + 1; j < peers.length; j++) {
            const a = peers[i], b = peers[j];
            const dy = a._y - b._y;
            const gap = 52 - Math.abs(dy);
            if (gap > 0) {
              const s = (dy >= 0 ? 1 : -1) * gap * 0.25;
              a._dy += s; b._dy -= s;
            }
          }
        }
      }
      for (const e of edges) {
        const a = byId.get(e.source), b = byId.get(e.target);
        if (a === wallB || b === wallB) {
          // 下壁への流れ: 流量が大きいノードほど下へ引く
          const n = a === wallB ? b : a;
          n._dy += 3.0 * (0.15 + 0.85 * e.value / maxE);
          continue;
        }
        if (isRW(a) || isRW(b)) {
          // 右壁との出入り: 流量が大きいノードほど右へ引く
          const n = isRW(a) ? b : a;
          n._dx += 3.0 * (0.15 + 0.85 * e.value / maxE);
          continue;
        }
        if (a === wallL || b === wallL) {
          // 左壁との出入り: 流量が大きいノードほど左へ引く
          const n = a === wallL ? b : a;
          n._dx -= 3.0 * (0.15 + 0.85 * e.value / maxE);
          continue;
        }
        if (a === wallT || b === wallT) continue;   // 上壁の相手はtopバンド固定
        let dx = b._x - a._x, dy = b._y - a._y;
        const d = Math.hypot(dx, dy) || 1;
        // 太い流れほど強く引き寄せる(繋がりの強さが距離に出る)。
        // ただし葉ノード(口座間のエッジが1本だけ)は流量に関係なく
        // 唯一の相手へしっかり寄せ、自然長も短くする: 距離=繋がりの強さの
        // 意味論はハブ間の話で、細い葉が標準の自然長まで押し戻されると
        // 無関係な線(給与→支出のドロップ等)を跨ぐ位置まで動いてしまう
        const leaf = deg.get(a) === 1 || deg.get(b) === 1;
        const f = (d - (leaf ? 115 : 185)) * 0.025
          * (leaf ? 1 : 0.3 + 0.7 * e.value / maxE);
        dx /= d; dy /= d;
        a._dx += dx * f; a._dy += dy * f;
        b._dx -= dx * f; b._dy -= dy * f;
      }
      // エッジの経路上に無関係なノードが乗らないよう押し出す
      // (描画と同じ2次ベジェの膨らみ込みで距離を測る。壁との直線は
      // 真下/真横の帯を空ける)
      for (const e of edges) {
        const a = byId.get(e.source), b = byId.get(e.target);
        if (a === wallT || b === wallT) continue;   // 上壁の帯は最上段のみ
        if (a === wallB || b === wallB) {
          const n0 = a === wallB ? b : a;
          for (const n of simNodes) {
            if (n === n0) continue;
            if (n._y > n0._y - 10) {
              const dx = n._x - n0._x;
              const need = rOf(n) + 24 - Math.abs(dx);
              if (need > 0) {
                // 押し出す向きは「今いる側」でなく葉なら「唯一の相手が
                // いる側」へ。一方通行の押し出しだと、序盤に誤った側へ
                // 弾かれた葉がレーン境界に閉じ込められ、相手への線が
                // このドロップ線を跨いだまま平衡してしまう
                const p = leafPartner.get(n);
                const dir = (p && p !== n0)
                  ? (p._x >= n0._x ? 1 : -1) : (dx >= 0 ? 1 : -1);
                n._dx += dir * need * 0.3;
              }
            }
          }
          continue;
        }
        if (isRW(a) || isRW(b)) {
          const n0 = isRW(a) ? b : a;
          for (const n of simNodes) {
            if (n === n0) continue;
            if (n._x > n0._x - 10) {
              const dy = n._y - n0._y;
              const need = rOf(n) + 20 - Math.abs(dy);
              if (need > 0) {
                if (n.band === "top") {
                  // 最上段はyが固定でy方向に押し出せないため、xで分離する
                  // (経路上の障害物を左へ、壁と繋がる側を右へ)
                  n._dx -= need * 0.3;
                  n0._dx += need * 0.15;
                } else {
                  // 下壁レーンと同じく、葉は唯一の相手がいる側へ押し出す
                  const p = leafPartner.get(n);
                  const dir = (p && p !== n0)
                    ? (p._y >= n0._y ? 1 : -1) : (dy >= 0 ? 1 : -1);
                  n._dy += dir * need * 0.3;
                }
              }
            }
          }
          continue;
        }
        if (a === wallL || b === wallL) {   // 左壁レーン(右壁の鏡像)
          const n0 = a === wallL ? b : a;
          for (const n of simNodes) {
            if (n === n0) continue;
            if (n._x < n0._x + 10) {
              const dy = n._y - n0._y;
              const need = rOf(n) + 20 - Math.abs(dy);
              if (need > 0) {
                if (n.band === "top") {
                  n._dx += need * 0.3;
                  n0._dx -= need * 0.15;
                } else {
                  const p = leafPartner.get(n);
                  const dir = (p && p !== n0)
                    ? (p._y >= n0._y ? 1 : -1) : (dy >= 0 ? 1 : -1);
                  n._dy += dir * need * 0.3;
                }
              }
            }
          }
          continue;
        }
        for (const n of simNodes) {
          if (n === a || n === b) continue;
          const vx = b._x - a._x, vy = b._y - a._y;
          const L2 = vx * vx + vy * vy || 1;
          const t = Math.max(0, Math.min(1,
            ((n._x - a._x) * vx + (n._y - a._y) * vy) / L2));
          // 描画は垂直方向へ d*0.12 膨らむ2次ベジェ。弦(直線)との距離で
          // 測ると、長い線ほど膨らみの実曲線上にノードが残る(最大で
          // d*0.06 ≒ 長さ400pxの線で24pxずれる)ため、曲線上の点と比べる
          const L = Math.sqrt(L2);
          const bow = 2 * t * (1 - t) * L * 0.12;
          const px = a._x + vx * t - vy / L * bow;
          const py = a._y + vy * t + vx / L * bow;
          const dx = n._x - px, dy = n._y - py;
          const d = Math.hypot(dx, dy) || 1;
          const need = rOf(n) + 26 - d;
          if (need > 0) {
            n._dx += dx / d * need * 0.25;
            n._dy += dy / d * need * 0.25;
          }
        }
      }
      for (const n of simNodes) {
        // 中心引力はxを弱く(横に広く使う)、yはやや強く
        n._dx += (cx - n._x) * 0.003;
        n._dy += (cy - n._y) * 0.008;
        const len = Math.hypot(n._dx, n._dy) || 1;
        const step = Math.min(12, len) * cool;
        n._x = Math.max(minX, Math.min(maxX, n._x + n._dx / len * step));
        n._y = n.band === "top" ? topY
          : Math.max(minY, Math.min(wallY - 64, n._y + n._dy / len * step));
      }
      // 最上段ノードのスロット割当。斥力の壁を挟んで順序が入れ替わる
      // ことは力学では起きないため、x座標の割当だけを並べ替える(間隔は
      // 保たれる)。一般則: 各ノードは繋がる相手(流量加重の重心。壁は
      // その辺のx)に近いスロットが良い。流量の大きいノードから順に、
      // 重心に最も近い空きスロットを取る(貪欲・決定論)。給与→銀行の
      // 太い流れは自然に相手の真上に来て、横断する太い帯が消える。
      // 冷却が終わる前に行い、移動したノードのドロップ線に下段のノードが
      // 乗っていれば残りの反復でレーン回避させる(240 = 全300回の8割
      // 時点。残り60回が再配置後の食い込み解消に充てられる)
      if (it === 240) {
        if (tops.length > 1) {
          const bary = new Map(), wsum = new Map();
          // 相手の代表x: 円は現在位置、右壁=右辺、左壁=左辺。
          // 上下の壁は横位置の情報がないので重心に入れない
          const px = (m) => m.wall
            ? (isRW(m) ? wallRX : m === wallL ? wallLX : null) : m._x;
          const add = (n, x, w) => {
            if (!n || n.band !== "top" || x == null) return;
            bary.set(n, (bary.get(n) || 0) + x * w);
            wsum.set(n, (wsum.get(n) || 0) + w);
          };
          for (const e of edges) {
            const a = byId.get(e.source), b = byId.get(e.target);
            if (!a || !b) continue;
            add(a, px(b), e.value);
            add(b, px(a), e.value);
          }
          const xs = tops.map((n) => n._x).sort((p, q) => p - q);
          const order = [...tops].sort((p, q) =>
            (wsum.get(q) || 0) - (wsum.get(p) || 0));
          const free = xs.map((_, i) => i);
          for (const n of order) {
            const goal = wsum.get(n) ? bary.get(n) / wsum.get(n) : n._x;
            let pick = 0;
            for (let i = 1; i < free.length; i++) {
              if (Math.abs(xs[free[i]] - goal)
                  < Math.abs(xs[free[pick]] - goal)) pick = i;
            }
            n._x = xs[free.splice(pick, 1)[0]];
          }
        }
      }
    }
    // 葉ノードの角度選び: 葉(口座間エッジが1本)は唯一の相手の至近距離
    // (バネの自然長=半径115の円周上)に置くのが大前提で、そのうえで
    // どの角度に置くかだけを離散に選ぶ。力学は交差数を知らないので、
    // 「自分の線(相手への線+壁への線)が他の線と交差しない角度」を
    // 総当たりで探す(交差は線の太さで重み付け。太い幹線を跨ぐ角度ほど
    // 損)。同点は現在位置に近い候補=動かない方を採る(決定論)。
    // 半径を広げたり次数2まで対象にすると、末端が四方に散って
    // クラスタがばらけるため、あくまで角度だけ
    const ori = (ax, ay, bx, by, cx2, cy2) => {
      const v = (bx - ax) * (cy2 - ay) - (by - ay) * (cx2 - ax);
      return v > 1e-6 ? 1 : v < -1e-6 ? -1 : 0;
    };
    const segX = (s, t) => {   // 端点(ノード)を共有する線同士は交差と数えない
      if (s.a === t.a || s.a === t.b || s.b === t.a || s.b === t.b) return false;
      const o1 = ori(s.x1, s.y1, s.x2, s.y2, t.x1, t.y1);
      const o2 = ori(s.x1, s.y1, s.x2, s.y2, t.x2, t.y2);
      const o3 = ori(t.x1, t.y1, t.x2, t.y2, s.x1, s.y1);
      const o4 = ori(t.x1, t.y1, t.x2, t.y2, s.x2, s.y2);
      // 後段の !!(...) は共線・端点接触(ori=0)を交差に数えないための条件
      return o1 !== o2 && o3 !== o4 && !!(o1 && o2 && o3 && o4);
    };
    // 描画と同じ膨らみの2次ベジェを折れ線近似で segs に積む。
    // w は太さの正規化値(交差ペナルティの重み)
    const quadSegs = (x1, y1, x2, y2, a, b, w, segs) => {
      const dx = x2 - x1, dy = y2 - y1, d = Math.hypot(dx, dy) || 1;
      const mx = (x1 + x2) / 2 - dy / d * d * 0.12;
      const my = (y1 + y2) / 2 + dx / d * d * 0.12;
      let px = x1, py = y1;
      for (let i = 1; i <= 6; i++) {
        const t = i / 6, u = 1 - t;
        const qx = u * u * x1 + 2 * t * u * mx + t * t * x2;
        const qy = u * u * y1 + 2 * t * u * my + t * t * y2;
        segs.push({ x1: px, y1: py, x2: qx, y2: qy, a, b, w });
        px = qx; py = qy;
      }
    };
    const wOf = (e) => Math.sqrt(Math.max(0, e.value) / maxE);
    // ノード skip を除いた全エッジの線分近似(壁との線は描画と同じ直線)
    const edgeSegs = (skip) => {
      const segs = [];
      for (const e of edges) {
        const a = byId.get(e.source), b = byId.get(e.target);
        if (a === skip || b === skip) continue;
        const w = wOf(e);
        if (a === wallT || b === wallT) {
          const n0 = a === wallT ? b : a;
          segs.push({ x1: n0._x, y1: wallTY, x2: n0._x, y2: n0._y, a, b, w });
        } else if (a === wallB || b === wallB) {
          const n0 = a === wallB ? b : a;
          segs.push({ x1: n0._x, y1: n0._y, x2: n0._x, y2: wallY, a, b, w });
        } else if (isRW(a) || isRW(b)) {
          const n0 = isRW(a) ? b : a;
          segs.push({ x1: n0._x, y1: n0._y, x2: wallRX, y2: n0._y, a, b, w });
        } else if (a === wallL || b === wallL) {
          const n0 = a === wallL ? b : a;
          segs.push({ x1: n0._x, y1: n0._y, x2: wallLX, y2: n0._y, a, b, w });
        } else {
          quadSegs(a._x, a._y, b._x, b._y, a, b, w, segs);
        }
      }
      return segs;
    };
    for (const [n, p] of leafPartner) {
      if (n.band === "top") continue;
      const others = edgeSegs(n);
      const pe = edges.find((e2) => {
        const a = byId.get(e2.source), b = byId.get(e2.target);
        return !a.wall && !b.wall && (a === n || b === n);
      });
      const myWalls = edges.filter((e2) => {
        const a = byId.get(e2.source), b = byId.get(e2.target);
        return (a === n && b.wall) || (b === n && a.wall);
      });
      const evalAt = (x, y) => {
        const mine = [];
        if (byId.get(pe.source) === n) {
          quadSegs(x, y, p._x, p._y, n, p, wOf(pe), mine);
        } else {
          quadSegs(p._x, p._y, x, y, p, n, wOf(pe), mine);
        }
        for (const e2 of myWalls) {
          const wn = byId.get(e2.source) === n
            ? byId.get(e2.target) : byId.get(e2.source);
          const w = wOf(e2);
          if (wn === wallB) {
            mine.push({ x1: x, y1: y, x2: x, y2: wallY, a: n, b: wn, w });
          } else if (wn === wallT) {
            mine.push({ x1: x, y1: wallTY, x2: x, y2: y, a: n, b: wn, w });
          } else if (isRW(wn)) {
            mine.push({ x1: x, y1: y, x2: wallRX, y2: y, a: n, b: wn, w });
          } else {
            mine.push({ x1: x, y1: y, x2: wallLX, y2: y, a: n, b: wn, w });
          }
        }
        let score = 0;
        for (const s of mine) for (const t of others) {
          if (segX(s, t)) score += 10 + 30 * (s.w + t.w);
        }
        for (const m of simNodes) {   // 他ノード・ラベル行との衝突は重いペナルティ
          if (m === n) continue;
          const dx = x - m._x, dy = y - m._y;
          if (Math.hypot(dx, dy) < rOf(n) + rOf(m) + 44) score += 1000;
          else if (Math.abs(dy) < 34
                   && Math.abs(dx) < lhw(n) + lhw(m)) score += 1000;
        }
        for (const t of others) {     // 他の線の上に乗るのも避ける
          const vx = t.x2 - t.x1, vy = t.y2 - t.y1;
          const L2 = vx * vx + vy * vy || 1;
          const tt = Math.max(0, Math.min(1,
            ((x - t.x1) * vx + (y - t.y1) * vy) / L2));
          if (Math.hypot(x - (t.x1 + vx * tt), y - (t.y1 + vy * tt))
              < rOf(n) + 24) score += 30;
        }
        return score;
      };
      let bx2 = n._x, by2 = n._y, bs = evalAt(n._x, n._y);
      const ring = (r) => {
        for (let k = 0; k < 24; k++) {
          const th = 2 * Math.PI * k / 24;
          const x = Math.max(minX, Math.min(maxX, p._x + r * Math.cos(th)));
          const y = Math.max(minY,
            Math.min(wallY - 64, p._y + r * Math.sin(th)));
          const s = evalAt(x, y)
            + 0.01 * Math.hypot(x - n._x, y - n._y);   // 同点は動かない方
          if (s < bs - 1e-9) { bs = s; bx2 = x; by2 = y; }
        }
      };
      ring(115);
      // 自然長の円周で交差が残るときだけ半径を広げて逃がす(相手の
      // 至近が先客・ラベル・他エッジの扇で塞がっている場合の脱出路。
      // 常に広げると末端が散らばってクラスタがばらける)
      if (bs >= 10) { ring(160); ring(205); ring(255); }
      n._x = bx2; n._y = by2;
    }
    // 仕上げ: 冷却後もエッジ経路・壁レーン上に残ったノードを解消する。
    // 反復中の経路押し出しは力(need×0.25)なので、バネ・斥力との綱引きが
    // 釣り合うと線上のまま平衡してしまう。ここでは残っている食い込みを
    // そのまま動かす決定論の掃引にする(動きがなくなるか上限で停止。
    // 押した先で別の線に乗ることがあるため数回まわす)
    for (let sweep = 0; sweep < 6; sweep++) {
      let moved = 0;
      for (const e of edges) {
        const a = byId.get(e.source), b = byId.get(e.target);
        if (a === wallT || b === wallT) continue;  // 上壁の帯は最上段のみ
        if (a === wallB || b === wallB) {          // 下壁への垂直レーン
          const n0 = a === wallB ? b : a;
          for (const n of simNodes) {
            if (n === n0) continue;
            if (n._y > n0._y - 10) {
              const dx = n._x - n0._x;
              const need = rOf(n) + 24 - Math.abs(dx);
              if (need > 0) {
                n._x = Math.max(minX, Math.min(maxX,
                  n._x + (dx >= 0 ? need : -need)));
                moved++;
              }
            }
          }
          continue;
        }
        if (isRW(a) || isRW(b) || a === wallL || b === wallL) {
          const right = isRW(a) || isRW(b);        // 左右壁への水平レーン
          const n0 = a.wall ? b : a;
          for (const n of simNodes) {
            if (n === n0 || n.band === "top") continue;
            if (right ? n._x <= n0._x - 10 : n._x >= n0._x + 10) continue;
            const dy = n._y - n0._y;
            const need = rOf(n) + 20 - Math.abs(dy);
            if (need > 0) {
              n._y = Math.max(minY, Math.min(wallY - 64,
                n._y + (dy >= 0 ? need : -need)));
              moved++;
            }
          }
          continue;
        }
        for (const n of simNodes) {                // 一般エッジ(2次ベジェ)
          if (n === a || n === b) continue;
          const vx = b._x - a._x, vy = b._y - a._y;
          const L2 = vx * vx + vy * vy || 1;
          const t = Math.max(0, Math.min(1,
            ((n._x - a._x) * vx + (n._y - a._y) * vy) / L2));
          const L = Math.sqrt(L2);
          const bow = 2 * t * (1 - t) * L * 0.12;
          const bx = a._x + vx * t - vy / L * bow;
          const by = a._y + vy * t + vx / L * bow;
          const dx = n._x - bx, dy = n._y - by;
          const d = Math.hypot(dx, dy) || 1;
          const need = rOf(n) + 26 - d;
          if (need > 0) {
            if (n.band === "top") {                // 最上段はxのみ動かせる
              n._x = Math.max(minX, Math.min(maxX,
                n._x + (dx >= 0 ? need : -need)));
            } else {
              n._x = Math.max(minX, Math.min(maxX, n._x + dx / d * need));
              n._y = Math.max(minY, Math.min(wallY - 64, n._y + dy / d * need));
            }
            moved++;
          }
        }
      }
      if (!moved) break;
    }
    // 縮尺固定+横スクロール(他の月次チャートと同じ作法)。狭い画面で
    // viewBox を縮小するとラベルが読めない大きさになるため、図は原寸のまま
    // スクロールで見せる。広い画面では中央寄せ
    const svg = mkFixedSvg(W, H);
    svg.style.margin = "0 auto";
    // 矢印の寸法。線幅wは流量の平方根比例(負値でNaN太さにしない)。
    // 矢の長さs・半幅hwは線幅より広く取り、太い線でも三角が線に埋もれない
    const arrowDims = (e) => {
      const w = 1.5 + 11 * Math.sqrt(Math.max(0, e.value) / maxE);
      return { w, s: Math.max(9, w * 1.9), hw: Math.max(4.5, w * 1.05) };
    };
    // エッジ: 少し膨らませた2次ベジェ+終端ノードの縁に矢印
    for (const e of [...edges].sort((a, b) => b.value - a.value)) {
      const a = byId.get(e.source), b = byId.get(e.target);
      if (a.wall || b.wall) continue;   // 壁との出入りは後で直線に
      const dx = b._x - a._x, dy = b._y - a._y;
      const d = Math.hypot(dx, dy) || 1;
      const nx = -dy / d, ny = dx / d;        // 垂直方向へ膨らむ
      const mx = (a._x + b._x) / 2 + nx * d * 0.12;
      const my = (a._y + b._y) / 2 + ny * d * 0.12;
      // 終端(矢の先)はノード円の縁。線は矢の付け根で止め、太い線でも
      // 三角が線に埋もれないようにする(三角の幅も線より広く取る)
      const hyp = Math.hypot(b._x - mx, b._y - my) || 1;
      const tx = b._x - (b._x - mx) / hyp * (rOf(b) + 2);
      const ty = b._y - (b._y - my) / hyp * (rOf(b) + 2);
      const { w, s, hw } = arrowDims(e);
      const ang = Math.atan2(ty - my, tx - mx);
      const bx2 = tx - s * Math.cos(ang), by2 = ty - s * Math.sin(ang);
      const p = document.createElementNS(SVGNS, "path");
      p.setAttribute("d", `M${a._x},${a._y} Q${mx},${my} ${bx2},${by2}`);
      p.setAttribute("fill", "none");
      p.setAttribute("stroke", e.color || cssVar("--grid"));
      p.setAttribute("stroke-opacity", "0.45");
      p.setAttribute("stroke-width", w);
      p.setAttribute("stroke-linecap", "butt");
      svg.appendChild(p);
      const px2 = -Math.sin(ang), py2 = Math.cos(ang);
      const tri = document.createElementNS(SVGNS, "path");
      tri.setAttribute("d",
        `M${tx},${ty} L${bx2 + px2 * hw},${by2 + py2 * hw} ` +
        `L${bx2 - px2 * hw},${by2 - py2 * hw} z`);
      tri.setAttribute("fill", e.color || cssVar("--grid"));
      tri.setAttribute("fill-opacity", "0.85");
      svg.appendChild(tri);
      if (opts.tipLink || opts.clickLink) {
        const hit = document.createElementNS(SVGNS, "path");
        hit.setAttribute("d", p.getAttribute("d"));
        hit.setAttribute("fill", "none");
        hit.setAttribute("stroke", "transparent");
        hit.setAttribute("stroke-width", Math.max(12, w + 6));
        if (opts.tipLink) {
          hit.addEventListener("pointermove", (evt) => {
            tipShow(evt, "", opts.tipLink(e));
          });
          hit.addEventListener("pointerleave", KB.hideTip);
        }
        bindClick(hit, opts.clickLink, e);
        svg.appendChild(hit);
      }
    }
    // 壁との出入り(直線+矢印)。線は矢の付け根で止める
    const straightArrow = (e, x0, y0, x1, y1) => {
      const { w, s, hw } = arrowDims(e);   // 先端は (x1,y1)
      const d = Math.hypot(x1 - x0, y1 - y0) || 1;
      const ux = (x1 - x0) / d, uy = (y1 - y0) / d;
      const bx2 = x1 - ux * s, by2 = y1 - uy * s;
      const l = line(svg, x0, y0, bx2, by2, e.color || cssVar("--grid"));
      l.setAttribute("stroke-opacity", "0.45");
      l.setAttribute("stroke-width", w);
      l.setAttribute("stroke-linecap", "butt");
      const tri = document.createElementNS(SVGNS, "path");
      tri.setAttribute("d",
        `M${x1},${y1} L${bx2 - uy * hw},${by2 + ux * hw} ` +
        `L${bx2 + uy * hw},${by2 - ux * hw} z`);
      tri.setAttribute("fill", e.color || cssVar("--grid"));
      tri.setAttribute("fill-opacity", "0.85");
      svg.appendChild(tri);
      if (opts.tipLink || opts.clickLink) {
        const hit = line(svg, x0, y0, x1, y1, "transparent");
        hit.setAttribute("stroke-width", Math.max(12, w + 6));
        if (opts.tipLink) {
          hit.addEventListener("pointermove", (evt) => {
            tipShow(evt, "", opts.tipLink(e));
          });
          hit.addEventListener("pointerleave", KB.hideTip);
        }
        bindClick(hit, opts.clickLink, e);
      }
    };
    for (const e of edges) {
      const a = byId.get(e.source), b = byId.get(e.target);
      if (b === wallB) {                        // 下壁へ垂直に落とす
        straightArrow(e, a._x, a._y + rOf(a) + 2, a._x, wallY - 2);
      } else if (a === wallB) {                 // 下壁から戻る(充当・返品超過)
        straightArrow(e, b._x, wallY - 2, b._x, b._y + rOf(b) + 2);
      } else if (a === wallT) {                 // 上壁から垂直に注ぐ
        straightArrow(e, b._x, wallTY + 2, b._x, b._y - rOf(b) - 2);
      } else if (b === wallR || b === wallRT) { // 右壁へ水平に(流入側は上)
        const seg = b === wallRT ? rtSeg : rSeg;
        const y = a._y - 7;
        // 通常は水平線。ノードのyがバーの区間外なら区間内に折れて届ける
        const wy = Math.max(seg.y1 + 8, Math.min(seg.y2 - 8, y));
        straightArrow(e, a._x + rOf(a) + 2, y, wallRX - 2, wy);
      } else if (a === wallR || a === wallRT) { // 右壁から水平に(流出側は下)
        const seg = a === wallRT ? rtSeg : rSeg;
        const y = b._y + 7;
        const wy = Math.max(seg.y1 + 8, Math.min(seg.y2 - 8, y));
        straightArrow(e, wallRX - 2, wy, b._x + rOf(b) + 2, y);
      } else if (b === wallL) {                 // 左壁へ水平に(返済。流入側は上)
        const y = a._y - 7;
        const wy = Math.max(rwY1 + 8, Math.min(rwY2 - 8, y));
        straightArrow(e, a._x - rOf(a) - 2, y, wallLX + 2, wy);
      } else if (a === wallL) {                 // 左壁から水平に(借入。流出側は下)
        const y = b._y + 7;
        const wy = Math.max(rwY1 + 8, Math.min(rwY2 - 8, y));
        straightArrow(e, wallLX + 2, wy, b._x - rOf(b) - 2, y);
      }
    }
    const mkBar = (wallNode, x, y, w2, h2, labelX, labelY, rotate) => {
      const bar = rect(svg, x, y, w2, h2, wallNode.color);
      bar.setAttribute("rx", 8);
      bar.setAttribute("fill-opacity", "0.9");
      if (opts.tipNode) {
        bar.addEventListener("pointermove", (evt) => {
          tipShow(evt, wallNode.label, opts.tipNode(wallNode));
        });
        bar.addEventListener("pointerleave", KB.hideTip);
      }
      bindClick(bar, opts.clickNode, wallNode);
      const t = text(svg, labelX, labelY,
        wallNode.label + " " + KB.compact(wallNode.value), "seg-label", "middle");
      t.style.pointerEvents = "none";   // 壁バー全面でホバー・クリックを受ける
      if (rotate) t.setAttribute("transform", `rotate(90 ${labelX} ${labelY})`);
    };
    // 外側マージンは左右対称に(右壁の外=8pxに左端も合わせる)
    const barX2 = hasRight ? wallRX - 10 : W - 8;   // 横バーは右壁の手前まで
    const barX1 = wallL ? wallLX + 10 : 8;          // 左壁があればその手前から
    if (wallB) {
      mkBar(wallB, barX1, wallY, barX2 - barX1, barTh,
            (barX1 + barX2) / 2, wallY + barTh / 2 + 4);
    }
    if (wallT) {
      mkBar(wallT, barX1, 8, barX2 - barX1, barTh,
            (barX1 + barX2) / 2, 8 + barTh / 2 + 4);
    }
    if (wallRT) {
      mkBar(wallRT, wallRX, rtSeg.y1, barTh, rtSeg.y2 - rtSeg.y1,
            wallRX + barTh / 2 - 4, (rtSeg.y1 + rtSeg.y2) / 2, true);
    }
    if (wallR) {
      mkBar(wallR, wallRX, rSeg.y1, barTh, rSeg.y2 - rSeg.y1,
            wallRX + barTh / 2 - 4, (rSeg.y1 + rSeg.y2) / 2, true);
    }
    if (wallL) {
      mkBar(wallL, 8, rwY1, barTh, rwY2 - rwY1,
            8 + barTh / 2 - 4, (rwY1 + rwY2) / 2, true);
    }
    // ノード+ラベル(名前を円の下に。文字の縁取りで線の上でも読める)
    for (const n of simNodes) {
      const c = circle(svg, n._x, n._y, rOf(n), n.color || cssVar("--ink-2"));
      if (opts.tipNode) {
        c.addEventListener("pointermove", (evt) => {
          tipShow(evt, n.label, opts.tipNode(n));
        });
        c.addEventListener("pointerleave", KB.hideTip);
      }
      bindClick(c, opts.clickNode, n);
      text(svg, n._x, n._y + rOf(n) + 12, n.label,
           "axis-label net-label", "middle");
      text(svg, n._x, n._y + rOf(n) + 24, KB.compact(n.value),
           "bar-label-sm net-label", "middle");
    }
    const scroller = document.createElement("div");
    scroller.className = "hscroll";
    scroller.appendChild(svg);
    box.appendChild(scroller);
  }

  Object.assign(KB, { drawFlowNetwork });
})();
