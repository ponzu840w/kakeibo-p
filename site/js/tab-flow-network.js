"use strict";
// tab-flow-network.js: 収支タブの「資金の流れ」(収支サンキー/口座間
// ネットワーク)と詳細モーダル・明細ジャンプ。tab-flow.js から分割した
// ファイルで、集計の共通部品(catGroupColor・renderDrilldown 等)は
// tab-flow.js が公開するものを使う(tab-flow.js の直後に読み込む)。
(function () {
  const KB = window.KB;
  const {
    $, TXNS, ACCOUNTS, state,
    effective, periodMonths, catGroup, filteredNoPeriod,
    fmt, sfmt, truncate, cssVar, note, mkTile, hideTip,
    isSell, isReinvest, buyCost, sellProceeds,
    TREND_SLOTS, catGroupColor, renderDrilldown,
  } = KB;
  // main.js / tab-ledger.js(後読み込み)の関数は実行時に KB 経由で解決する
  const closeModal = (...a) => KB.closeModal(...a);
  const setTab = (...a) => KB.setTab(...a);
  const render = (...a) => KB.render(...a);
  const renderTable = (...a) => KB.renderTable(...a);

  // 収支: 資金の流れ(サンキー)
  // 収支モード: 期間全体の 収入源 → 家計 → 貯蓄・投資・中分類 → カテゴリ。
  // 口座間モード: 期間内の振替(口座→口座の資金移動)のトレース。
  // どちらも口座・カテゴリ・検索フィルタとは無関係に期間内の全取引から作る
  // (フィルタを効かせると保存則が崩れて図が破綻するため)。
  function renderMoneyFlow() {
    if (state.flowMode === "transfer") { renderAccountFlow(); return; }
    const box = $("#flow-sankey");
    const pmonths = new Set(periodMonths());
    const scope = TXNS.filter((t) => pmonths.has(t.date.slice(0, 7)));
    // 収入源(カテゴリ別、effective 後)
    const incMap = new Map();
    let totalInc = 0, totalExp = 0;
    const expByGroup = new Map();   // 中分類 → Map(カテゴリ → 額)
    for (const t of scope) {
      const e = effective(t);
      if (e.type === "income" && e.amount !== 0) {
        // 手取りモードでは法定控除が「負の収入」になる。給与系カテゴリへ
        // 合流させて差し引かないと、収入ノードに総支給が残ってしまう
        const cat = t.type === "expense"
          ? (t.memo && t.memo.startsWith("賞与") ? "賞与(総支給)" : "給与(総支給)")
          : t.category;
        incMap.set(cat, (incMap.get(cat) || 0) + e.amount);
        totalInc += e.amount;
      } else if (e.type === "expense" && e.amount !== 0) {
        const v = -e.amount;   // 返品(正のexpense)は負で入り相殺される
        totalExp += v;
        const g = catGroup(t.category);
        if (!expByGroup.has(g)) expByGroup.set(g, new Map());
        const gm = expByGroup.get(g);
        gm.set(t.category, (gm.get(t.category) || 0) + v);
      }
    }
    // 相殺しきって負になったカテゴリ(返品超過等)は流量として描けないので
    // 除外する(合計からも戻す)
    for (const [g, gm] of [...expByGroup]) {
      for (const [c, v] of [...gm]) {
        if (v <= 0) { totalExp -= v; gm.delete(c); }
      }
      if (!gm.size) expByGroup.delete(g);
    }
    // 投資(期間内の買付合計)。分配金再投資は現金流出でない内部取引
    // なので除外する(investFlows と同じ扱い)
    let invest = 0;
    for (const e of (DATA.invest || {}).events || []) {
      if (isSell(e) || isReinvest(e)) continue;
      if (pmonths.has(e.date.slice(0, 7))) invest += buyCost(e);
    }
    if (totalInc <= 0 && totalExp <= 0) {
      box.replaceChildren(); note(box, "対象期間のデータがありません"); return;
    }
    const saving = totalInc - totalExp - invest;   // 正=貯蓄・負=取り崩し

    // 収入源ノード。微小な源(総収入の1%未満)や上位6超はまとめて
    // 「その他収入」にし、左端のラベルが潰れないようにする
    let incs = [...incMap.entries()]
      .filter(([, v]) => v >= totalInc * 0.01)
      .sort((a, b) => b[1] - a[1]);
    let restInc = totalInc - incs.reduce((s, [, v]) => s + v, 0);
    if (incs.length > 6) {
      restInc += incs.splice(6).reduce((s, [, v]) => s + v, 0);
    }
    if (restInc > 0) incs.push(["その他収入", restInc]);
    const nodes = [], links = [];
    const incColor = cssVar("--income");
    for (const [name, v] of incs) {
      nodes.push({ id: "src:" + name, col: 0, label: name, value: v, color: incColor });
    }
    if (saving < 0) {
      nodes.push({ id: "src:取り崩し", col: 0, label: "取り崩し",
                   value: -saving, color: cssVar("--critical") });
    }
    // 中間ノード: 投資・貯蓄・各中分類(定義順)
    const middles = [];
    if (invest > 0) middles.push({ id: "mid:投資", label: "投資",
      value: invest, color: KB.groupColor("証券") });
    if (saving > 0) middles.push({ id: "mid:貯蓄", label: "貯蓄",
      value: saving, color: cssVar("--good") });
    const gOrder = [...TREND_SLOTS, "その他"];
    for (const g of gOrder) {
      const gm = expByGroup.get(g);
      if (!gm) continue;
      const gv = [...gm.values()].reduce((s, v) => s + v, 0);
      if (gv <= 0) continue;
      middles.push({ id: "mid:" + g, label: g, value: gv,
                     color: catGroupColor(g), group: g });
    }
    // 合流ノード「家計」。収入源はここへ注ぎ、投資・貯蓄・各中分類はここから
    // 出る。以前は収入源→各中間を収入比で按分していたが、それは「この収入が
    // この支出に使われた」という事実でない対応を示唆する(お金に色はない)
    // うえ、全源×全中間の細いリボンで図が濁るため、1点合流に改めた
    const srcTotal = incs.reduce((s, [, v]) => s + v, 0) + Math.max(0, -saving);
    const srcList = nodes.filter((nd) => nd.col === 0);
    nodes.push({ id: "pool", col: 1, label: "家計", value: srcTotal,
                 color: cssVar("--ink-2") });
    for (const s of srcList) {
      links.push({ source: s.id, target: "pool", value: s.value,
                   color: s.color });
    }
    for (const m of middles) {
      nodes.push({ ...m, col: 2 });
      links.push({ source: "pool", target: m.id, value: m.value,
                   color: m.color });
    }
    // 中分類 → カテゴリ(右列。上位3+その他)
    for (const m of middles) {
      if (!m.group) continue;   // 投資・貯蓄は末端
      let cats = [...expByGroup.get(m.group).entries()].sort((a, b) => b[1] - a[1]);
      if (cats.length > 3) {
        const rest = cats.splice(3).reduce((s, [, v]) => s + v, 0);
        cats.push([m.group + " ほか", rest]);
      }
      for (const [name, v] of cats) {
        const id = "leaf:" + m.group + ":" + name;
        nodes.push({ id, col: 3, label: name, value: v, color: m.color });
        links.push({ source: m.id, target: id, value: v, color: m.color });
      }
    }
    KB.drawSankey(box, { nodes, links }, {
      width: 940, height: 420,
      tipNode: (nd) => [{ name: "金額", value: fmt(nd.value), color: nd.color }],
      tipLink: (lk) => {
        const s = nodes.find((n) => n.id === lk.source);
        const t = nodes.find((n) => n.id === lk.target);
        return [{ name: `${s.label} → ${t.label}`, value: fmt(lk.value),
                  color: lk.color }];
      },
    });
    const pm = [...pmonths].sort();
    $("#flow-note").textContent =
      `${pm[0]}〜${pm[pm.length - 1]} の収支内訳。` +
      "期間設定のみ反映。" +
      "お金に色は付いていないため収支は「家計」で中継。" +
      (saving < 0 ? "収入 < 支出+投資のため不足分を「取り崩し」で表示" :
       "貯蓄=収入−支出−投資");
  }

  // 口座間モードの詳細モーダル
  // ネットワークは絞り込みを無視して全取引から描くため、明細タブへの
  // ジャンプ先が現在のフィルタで隠れていることがある。その場合は
  // 邪魔している条件だけを外し(UIも同期)、図表を描き直してから飛ぶ
  function jumpToTxn(t) {
    closeModal();
    let cleared = false;
    if (state.account && state.account !== t.account) {
      state.account = "";
      $("#f-account").value = "";
      cleared = true;
    }
    if (state.category && state.category !== t.category) {
      state.category = "";
      $("#f-category").value = "";
      cleared = true;
    }
    if (state.search &&
        !(t.description + " " + (t.memo || "") + " " + (t.comment || ""))
          .toLowerCase().includes(state.search.toLowerCase())) {
      state.search = "";
      $("#f-search").value = "";
      cleared = true;
    }
    if (state.hideTransfer &&
        (t.type === "transfer" || t.type === "adjustment")) {
      state.hideTransfer = false;
      KB.syncGlobalsUI();
      cleared = true;
    }
    if (state.fOverride && !KB.OVR_BY_ID.has(t.id)) {
      state.fOverride = false;
      $("#f-override").checked = false;
      cleared = true;
    }
    if (state.fComment && !t.comment) {
      state.fComment = false;
      $("#f-comment").checked = false;
      cleared = true;
    }
    setTab("ledger");
    if (cleared) render();
    state.focusTxn = t.id;
    renderTable(filteredNoPeriod());
  }

  // モーダルの左右どちらかの中身。pane は次のいずれか:
  //   {title, drill: txns}  … 支出ドリルダウン(共通コンポーネント)
  //   {title, sums: [{name, value, color?}]} … 集計行(構成比付き)
  //   {title, items: [{date, name, amt, t?, ev?}], empty?}
  //     … 明細行(金額の大きい順)。t 付きはクリックで明細タブへ、
  //       ev 付きは約定イベント(対応レコードなし)
  function flowPane(box, pane) {
    box.replaceChildren();
    if (pane.drill) { renderDrilldown(pane.drill, box); return; }
    if (pane.sums) {
      const sums = [...pane.sums].filter((r) => r.value > 0)
        .sort((a, b) => b.value - a.value);
      const total = sums.reduce((s, r) => s + r.value, 0);
      if (!total) { note(box, pane.empty || "該当がありません"); return; }
      for (const r of sums) {
        const row = document.createElement("div");
        row.className = "inc-row";
        const sw = document.createElement("span");
        sw.style.cssText = "flex:none;width:12px;height:12px;" +
          "border-radius:3px;align-self:center;background:" +
          (r.color || "transparent");
        const nm = document.createElement("span");
        nm.className = "nm";
        nm.textContent = r.name;
        const pc = document.createElement("span");
        pc.style.cssText = "margin-left:auto;color:var(--ink-2)";
        pc.textContent = Math.round(r.value / total * 100) + "%";
        const a = document.createElement("span");
        a.className = "a";
        a.style.marginLeft = "0";
        a.textContent = fmt(r.value);
        row.append(sw, nm, pc, a);
        box.appendChild(row);
      }
      return;
    }
    const items = [...(pane.items || [])]
      .sort((a, b) => Math.abs(b.amt) - Math.abs(a.amt));
    if (!items.length) { note(box, pane.empty || "該当がありません"); return; }
    for (const it of items.slice(0, 60)) {
      const row = document.createElement("div");
      row.className = "inc-row";
      const d = document.createElement("span");
      d.className = "d";
      d.textContent = it.date;
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = it.name;
      nm.title = it.name;
      const a = document.createElement("span");
      a.className = "a" + (it.amt < 0 ? " neg" : "");
      a.textContent = sfmt(it.amt);
      row.append(d, nm, a);
      if (it.t) {
        row.title = "クリックで明細タブの該当レコードへ";
        row.style.cursor = "pointer";
        row.addEventListener("click", () => jumpToTxn(it.t));
      } else if (it.ev) {
        row.title = "約定イベント(明細タブに対応レコードなし)";
      }
      box.appendChild(row);
    }
    if (items.length > 60) note(box, `他${items.length - 60}件は明細タブで`);
  }

  // 月詳細モーダルの器(#modal-*)を使い回し、見出しと中身を差し替える。
  // kpis = [[ラベル, 値, 追加クラス?], ...]
  function openFlowDetail(title, kpis, left, right) {
    hideTip();
    $("#modal-title").textContent = title;
    const kbox = $("#modal-kpis");
    kbox.replaceChildren();
    for (const [label, value, cls] of kpis) {
      mkTile(kbox, label, value, "", "small" + (cls ? " " + cls : ""));
    }
    $("#modal-prov").style.display = "none";   // 月詳細(当月)専用セクション
    $("#modal-h-left").textContent = left.title;
    $("#modal-h-right").textContent = right.title;
    flowPane($("#modal-income"), left);
    flowPane($("#modal-drill"), right);
    $("#modal-bg").style.display = "";
  }

  // 口座間モード: 段階(列)を作らないネットワーク図。ノード=口座+
  // 「収入」「支出」「投資」の3集約ノード、エッジ=太さ∝金額の矢印。
  //   ・振替は口座ペアごとに差し引き、純流量の向きだけ描く
  //     (行き来する SBI のスイープ等で図が煩雑になるのを防ぐ)
  //   ・投資買付は約定イベントから証券系口座→投資のエッジにする
  //   ・年金グループの口座(企業型DC等)は普通の口座ノード。拠出は
  //     給与からの振替として円に入るだけ(戻らない性質はツールチップの
  //     残高増で読める。専用の壁を設けるほどの流量・意味の分岐がない)
  //   ・負債口座(kind=liability)は負債色(--critical)の普通のノード。
  //     立替や貸付は既存のエッジがそのまま語る(カードが支出へ払い、
  //     銀行がカードへ返す)ので専用の壁は設けない(往復の壁線×口座数で
  //     図が渋滞したための廃止)。未払残の増減はツールチップの
  //     「負債増(借入超過)/負債減(返済超過)」で見せる
  //   ・資産口座の流入と流出の差(残高増/取り崩し)はノードの
  //     ツールチップで見せる(ネットワークは保存則を強制しないため、
  //     サンキーのようなダミーノードで埋める必要がない)
  //   ・収入・支出の内訳は収支モードの領分なのでここでは集約する
  function renderAccountFlow() {
    const box = $("#flow-sankey");
    const pmonths = new Set(periodMonths());
    const scope = TXNS.filter((t) => pmonths.has(t.date.slice(0, 7)));
    const bump = (m, k, v) => m.set(k, (m.get(k) || 0) + v);
    const listPush = (m, k, x) => {
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(x);
    };
    const incByAcc = new Map();  // 口座 → 収入額
    const expByAcc = new Map();  // 口座 → 支出額
    const trans = new Map();     // "from→to" → 金額(後で差し引き)
    const incTxAcc = new Map();  // 口座 → 収入明細(ツールチップ・モーダル用)
    const expTxAcc = new Map();  // 口座 → 支出明細
    const trTx = new Map();      // "from→to" → 振替明細(ペアの片側のみ)
    const seenPairs = new Set();
    for (const t of scope) {
      const e = effective(t);
      // 正負込みで合算する: 手取りモードの法定控除(負の収入)は口座単位で
      // 自然にネットされ収入壁→給与口座の流量が手取りになる。返品
      // (正の支出)も支出側で相殺される
      if (e.type === "income" && e.amount !== 0) {
        bump(incByAcc, t.account, e.amount);
        listPush(incTxAcc, t.account, t);
      } else if (e.type === "expense" && e.amount !== 0) {
        bump(expByAcc, t.account, -e.amount);
        listPush(expTxAcc, t.account, t);
      } else if (t.type === "transfer" && t.counter) {
        if (t.pair) {
          if (seenPairs.has(t.pair)) continue;
          seenPairs.add(t.pair);
        }
        const [from, to] = t.amount < 0
          ? [t.account, t.counter] : [t.counter, t.account];
        bump(trans, from + "→" + to, Math.abs(t.amount));
        listPush(trTx, from + "→" + to, t);
      }
    }
    // 有価証券の買付・売却(約定イベント)。金銀は sbi_metal、他は sbisec
    const investOut = new Map();   // 口座→買付額(現金が有価証券へ)
    const investIn = new Map();    // 口座→売却受取額(有価証券から現金へ)
    const buyEv = new Map();       // 口座→買付イベント
    const sellEv = new Map();      // 口座→売却イベント
    for (const ev of (DATA.invest || {}).events || []) {
      if (!pmonths.has(ev.date.slice(0, 7))) continue;
      // 分配金再投資は現金の移動を伴わない内部取引なので流量に含めない
      if (isReinvest(ev)) continue;
      const acc = ev.kind === "metal" ? "sbi_metal" : "sbisec";
      if (isSell(ev)) {
        bump(investIn, acc, sellProceeds(ev));
        listPush(sellEv, acc, ev);
      } else {
        bump(investOut, acc, buyCost(ev));
        listPush(buyEv, acc, ev);
      }
    }
    // 振替の差し引き(A→B と B→A は純流量の向きだけ残す)
    const netTrans = [];
    const seenPair2 = new Set();
    for (const [k, v] of trans) {
      const [a, b] = k.split("→");
      const pairKey = [a, b].sort().join("|");
      if (seenPair2.has(pairKey)) continue;
      seenPair2.add(pairKey);
      const rev = trans.get(b + "→" + a) || 0;
      const net = v - rev;
      if (Math.abs(net) < 1) continue;   // 往復が正味0円のペアは描かない
      netTrans.push(net > 0 ? { from: a, to: b, v: net }
                            : { from: b, to: a, v: -net });
    }
    if (!netTrans.length && !incByAcc.size && !expByAcc.size) {
      box.replaceChildren();
      note(box, "対象期間のデータがありません");
      $("#flow-note").textContent = "";
      return;
    }
    // 口座ごとの流入・流出(通過額=大きい方をノードの大きさに)。
    // 正味の支出が負(ポイント充当・返品など正の支出行が上回った月)は
    // 「支出の壁から戻る」流入として扱う
    const accIn = new Map(), accOut = new Map();
    for (const [acc, v] of incByAcc) if (v > 0) bump(accIn, acc, v);
    for (const [acc, v] of expByAcc) {
      bump(v >= 0 ? accOut : accIn, acc, Math.abs(v));
    }
    for (const e of netTrans) {
      bump(accOut, e.from, e.v);
      bump(accIn, e.to, e.v);
    }
    for (const [acc, v] of investOut) bump(accOut, acc, v);
    for (const [acc, v] of investIn) bump(accIn, acc, v);
    const accs = [...new Set([...accIn.keys(), ...accOut.keys()])];
    const aname = (id) => (ACCOUNTS[id] || {}).name || id;
    // 負債口座(カード・Paidy・借入等)は負債セクターとして負債色に束ねる
    // (グループ色の意味論はそのまま、負債だけ壁と同じ--criticalで統一)
    const isLiab = (acc) => (ACCOUNTS[acc] || {}).kind === "liability";
    const liabColor = cssVar("--critical");
    const acolor = (id) => isLiab(id)
      ? liabColor : KB.groupColor((ACCOUNTS[id] || {}).group || "");
    const sumOf = (m) => [...m.values()].reduce((s, v) => s + v, 0);
    const nodes = [], edges = [];
    // 給与グループの口座はお金の「発生源」。集約収入ノードから
    // 矢印を受けると「収入→勤務先の給与口座」のような逆向きの図になってしまう
    // (総支給は清算口座への income として計上されるが、それは勤務先から
    // 家計へお金が入った事実の表現)。発生源は最上段バンドに置き、
    // そこから控除=壁・手取り=銀行へ注ぐ形にする。
    // 借入は発生源にしない: 借りたお金は収入でなく負債(赤い円)から届く
    const isSource = (acc) => (ACCOUNTS[acc] || {}).group === "給与";
    // 配色の意味論: シアン=入ってくるお金(収入の壁・発生源とその流れ)、
    // グループ色=口座間の移動、橙=支出、証券青=有価証券の売買。
    // 給与グループのスロット色(橙系)だけは支出と紛らわしいので使わない
    const incColor = cssVar("--income");
    const secColor = KB.groupColor("証券");
    // その他の収入(現金預入・個人間受取・ポイント等)だけを1ノードに集約
    let otherInc = 0;
    for (const [acc, v] of incByAcc) if (!isSource(acc)) otherInc += v;
    const totalInc = sumOf(incByAcc);
    const totalExp = sumOf(expByAcc);
    const totalBuy = sumOf(investOut), totalSell = sumOf(investIn);
    // 上辺の壁「収入」: 発生源(給与系口座・その他収入の集約)へ注ぐ
    nodes.push({ id: "収入", label: "収入", value: totalInc,
                 color: incColor, wall: "top" });
    if (otherInc > 0) {
      nodes.push({ id: "その他収入", label: "その他収入", value: otherInc,
                   color: incColor, band: "top" });
      edges.push({ source: "収入", target: "その他収入", value: otherInc,
                   color: incColor });
    }
    // 口座はグループ順→金額順(決定論の初期配置がそのまま並び順になる)
    for (const [acc] of KB.gsort(
        accs.map((a) => [a, Math.max(accIn.get(a) || 0, accOut.get(a) || 0)])
          .sort((x, y) => y[1] - x[1]),
        ([id]) => (ACCOUNTS[id] || {}).group || "")) {
      nodes.push({ id: "acc:" + acc, label: aname(acc),
                   value: Math.max(accIn.get(acc) || 0, accOut.get(acc) || 0),
                   color: isSource(acc) ? incColor : acolor(acc), acc,
                   ...(isSource(acc) ? { band: "top" } : {}) });
      // 給与系の発生源口座へは収入の壁から総支給を注ぐ
      if (isSource(acc) && incByAcc.get(acc) > 0) {
        edges.push({ source: "収入", target: "acc:" + acc,
                     value: incByAcc.get(acc), color: incColor });
      }
    }
    // 支出はほぼ全口座と繋がるため円だと中央が渋滞する。下辺の壁にして
    // 各口座から垂直に落とす
    nodes.push({ id: "支出", label: "支出", value: totalExp,
                 color: cssVar("--expense"), wall: "bottom" });
    // 有価証券は右辺の壁: 買付で現金が壁へ、売却で現金が壁から戻る
    if (totalBuy > 0 || totalSell > 0) {
      nodes.push({ id: "有価証券", label: "有価証券",
                   value: totalBuy + totalSell, color: secColor,
                   wall: "right" });
      for (const [acc, v] of investOut) {
        edges.push({ source: "acc:" + acc, target: "有価証券", value: v,
                     color: secColor });
      }
      for (const [acc, v] of investIn) {
        edges.push({ source: "有価証券", target: "acc:" + acc, value: v,
                     color: secColor });
      }
    }
    for (const [acc, v] of incByAcc) {
      if (isSource(acc) || v <= 0) continue;  // 発生源口座へは壁から注ぎ済み
      edges.push({ source: "その他収入", target: "acc:" + acc, value: v,
                   color: incColor });
    }
    for (const e of netTrans) {
      edges.push({ source: "acc:" + e.from, target: "acc:" + e.to, value: e.v,
                   color: isSource(e.from) ? incColor : acolor(e.from) });
    }
    for (const [acc, v] of expByAcc) {
      if (v >= 0) {
        edges.push({ source: "acc:" + acc, target: "支出", value: v,
                     color: cssVar("--expense") });
      } else {
        // 戻り超過の月(ポイント充当・返品等): 負の支出を負の太さで
        // 描くと壊れる(√負=NaN)。売却の「壁から戻る」と同じ作法で、
        // 支出の壁からの戻りにする
        edges.push({ source: "支出", target: "acc:" + acc, value: -v,
                     color: cssVar("--expense") });
      }
    }
    // ツールチップ・クリック詳細用の内訳ビルダー
    const pm = [...pmonths].sort();
    const pmLabel = pm.length > 1 ? `${pm[0]}〜${pm[pm.length - 1]}` : pm[0] || "";
    const allTx = (m) => [...m.values()].flat();
    const otherIncTx = () =>
      [...incTxAcc].filter(([a]) => !isSource(a)).flatMap(([, v]) => v);
    // カテゴリ別(収入)/中分類別(支出)の集計 → [{name, value, color?}]
    const catAgg = (txs) => {
      const m = new Map();
      for (const t of txs) {
        m.set(t.category, (m.get(t.category) || 0) + effective(t).amount);
      }
      return [...m].map(([name, value]) => ({ name, value }));
    };
    const grpAgg = (txs) => {
      const m = new Map();
      for (const t of txs) {
        const g = catGroup(t.category);
        m.set(g, (m.get(g) || 0) - effective(t).amount);
      }
      return [...m].map(([name, value]) =>
        ({ name, value, color: catGroupColor(name) }));
    };
    // 金額降順で上限を切り、あふれは「ほかn件」に畳むツールチップ行
    const capRows = (parts, cap, total) => {
      const arr = [...parts].sort((a, b) => b.value - a.value);
      const pct = (v) =>
        total > 0 ? Math.round(v / total * 100) + "%" : undefined;
      const out = arr.slice(0, cap).map((r) =>
        ({ name: r.name, value: fmt(r.value), color: r.color, pct: pct(r.value) }));
      if (arr.length > cap) {
        const rest = arr.slice(cap).reduce((s, r) => s + r.value, 0);
        out.push({ name: `ほか${arr.length - cap}件`, value: fmt(rest),
                   pct: pct(rest) });
      }
      return out;
    };
    const wedges = (parts, cap) => {
      const arr = [...parts].filter((r) => r.value > 0)
        .sort((a, b) => b.value - a.value);
      if (arr.length > cap) {
        const rest = arr.splice(cap).reduce((s, r) => s + r.value, 0);
        arr.push({ name: "ほか", value: rest, color: cssVar("--cat-other") });
      }
      return arr;
    };
    // モーダル・ツールチップの明細アイテム
    const txItem = (t, amt) => ({ date: t.date, name: t.description, amt, t });
    const buyItem = (ev) => ({ date: ev.date,
      name: (ev.name || "") + "(" + (ev.action || "買付") + ")",
      amt: -buyCost(ev), ev });
    const sellItem = (ev) => ({ date: ev.date,
      name: (ev.name || "") + "(" + (ev.action || "売却") + ")",
      amt: sellProceeds(ev), ev });
    // ツールチップの明細行(金額の大きい順に上位だけ)
    const txTipRows = (items, cap) => {
      const arr = [...items].sort((a, b) => Math.abs(b.amt) - Math.abs(a.amt));
      const out = arr.slice(0, cap).map((it) =>
        ({ name: it.date.slice(5) + " " + truncate(it.name, 12),
           value: sfmt(it.amt) }));
      if (arr.length > cap) {
        out.push({ name: `ほか${arr.length - cap}件`,
          value: sfmt(arr.slice(cap).reduce((s, it) => s + it.amt, 0)) });
      }
      return out;
    };
    // 口座ノードの流入・流出の内訳(純流量ベース=矢印と同じ数字)
    const accParts = (acc) => {
      const inn = [], out = [];
      const iv = incByAcc.get(acc) || 0;
      if (iv > 0) inn.push({ name: "収入", value: iv, color: incColor });
      for (const tr of netTrans) {
        if (tr.to === acc) {
          inn.push({ name: "← " + aname(tr.from), value: tr.v,
                     color: isSource(tr.from) ? incColor : acolor(tr.from) });
        }
        if (tr.from === acc) {
          out.push({ name: "→ " + aname(tr.to), value: tr.v,
                     color: acolor(tr.to) });
        }
      }
      const sv = investIn.get(acc) || 0;
      if (sv > 0) inn.push({ name: "売却受取", value: sv, color: secColor });
      const xv = expByAcc.get(acc) || 0;
      if (xv > 0) out.push({ name: "支出", value: xv,
                             color: cssVar("--expense") });
      else if (xv < 0) inn.push({ name: "支出の戻り(充当・返品の超過)",
                                  value: -xv, color: cssVar("--expense") });
      const bv = investOut.get(acc) || 0;
      if (bv > 0) out.push({ name: "買付", value: bv, color: secColor });
      return { inn, out };
    };
    // 口座モーダルの明細(こちらは差し引き前の実際の行き来を全部見せる)
    const trIn = (acc) => [...trTx]
      .filter(([k]) => k.split("→")[1] === acc).flatMap(([, v]) => v);
    const trOut = (acc) => [...trTx]
      .filter(([k]) => k.split("→")[0] === acc).flatMap(([, v]) => v);
    const accInItems = (acc) => [
      ...(incTxAcc.get(acc) || []).map((t) => txItem(t, effective(t).amount)),
      ...trIn(acc).map((t) => txItem(t, Math.abs(t.amount))),
      ...(sellEv.get(acc) || []).map(sellItem),
    ];
    const accOutItems = (acc) => [
      ...(expTxAcc.get(acc) || []).map((t) => txItem(t, effective(t).amount)),
      ...trOut(acc).map((t) => txItem(t, -Math.abs(t.amount))),
      ...(buyEv.get(acc) || []).map(buyItem),
    ];
    // クリックで開く詳細モーダル
    const perMonth = (v) =>
      pm.length > 1 ? [["月平均", fmt(v / pm.length)]] : [];
    const openIncomeDetail = (title, txs) => {
      const sum = txs.reduce((s, t) => s + effective(t).amount, 0);
      openFlowDetail(title, [
        ["合計", fmt(sum)], ["件数", txs.length + "件"], ...perMonth(sum),
      ], { title: "明細(クリックで明細タブへ)",
           items: txs.map((t) => txItem(t, effective(t).amount)),
           empty: "収入がありません" },
         { title: "カテゴリ別", sums: catAgg(txs) });
    };
    const openExpenseDetail = (title, txs) => {
      const sum = txs.reduce((s, t) => s - effective(t).amount, 0);
      openFlowDetail(title, [
        ["合計", fmt(sum)], ["件数", txs.length + "件"], ...perMonth(sum),
      ], { title: "明細(クリックで明細タブへ)",
           items: txs.map((t) => txItem(t, effective(t).amount)),
           empty: "支出がありません" },
         { title: "内訳(クリックで展開)", drill: txs });
    };
    const openAccountDetail = (acc) => {
      const tin = accIn.get(acc) || 0, tout = accOut.get(acc) || 0;
      const d = tin - tout;
      const dLabel = isLiab(acc)
        ? (d >= 0 ? "負債減(返済超過)" : "負債増(借入超過)")
        : (d >= 0 ? "残高増" : "取り崩し・借入");
      openFlowDetail(`${aname(acc)} の資金の流れ(${pmLabel})`, [
        ["流入", fmt(tin)], ["流出", fmt(tout)],
        [dLabel, sfmt(d), d >= 0 ? "pos" : "neg"],
      ], { title: "流入の明細(クリックで明細タブへ)",
           items: accInItems(acc), empty: "流入がありません" },
         { title: "流出の明細(クリックで明細タブへ)",
           items: accOutItems(acc), empty: "流出がありません" });
    };
    const openTransferDetail = (from, to) => {
      const fwd = trTx.get(from + "→" + to) || [];
      const rev = trTx.get(to + "→" + from) || [];
      const sum = (l) => l.reduce((s, t) => s + Math.abs(t.amount), 0);
      openFlowDetail(`${aname(from)} → ${aname(to)} の振替(${pmLabel})`, [
        ["純流量", fmt(sum(fwd) - sum(rev))],
        ["行き", `${fmt(sum(fwd))}(${fwd.length}件)`],
        ...(rev.length ? [["戻り", `${fmt(sum(rev))}(${rev.length}件)`]] : []),
      ], { title: `${aname(from)} → ${aname(to)}(クリックで明細タブへ)`,
           items: fwd.map((t) => txItem(t, Math.abs(t.amount))) },
         { title: `${aname(to)} → ${aname(from)}`,
           items: rev.map((t) => txItem(t, Math.abs(t.amount))),
           empty: "逆方向の振替はありません" });
    };
    const openInvestDetail = (acc) => {
      const pick = (m) => acc ? (m.get(acc) || []) : [...m.values()].flat();
      const buys = pick(buyEv).map(buyItem);
      const sells = pick(sellEv).map(sellItem);
      const bsum = buys.reduce((s, it) => s - it.amt, 0);
      const ssum = sells.reduce((s, it) => s + it.amt, 0);
      openFlowDetail((acc ? aname(acc) + " の" : "") +
        `有価証券の売買(約定・${pmLabel})`, [
        ["買付", fmt(bsum)], ["売却受取", fmt(ssum)],
        ["差引", sfmt(ssum - bsum), ssum >= bsum ? "pos" : "neg"],
      ], { title: "買付", items: buys, empty: "買付がありません" },
         { title: "売却", items: sells, empty: "売却がありません" });
    };

    const hint = "(クリックで明細)";
    KB.drawFlowNetwork(box, { nodes, edges }, {
      width: 940, height: 620,
      tipNode: (nd) => {
        if (nd.id === "収入") {
          const txs = allTx(incTxAcc);
          return { title: nd.label + hint, rows: [
            { name: "合計", value: fmt(totalInc), color: nd.color },
            { name: "件数", value: txs.length + "件" },
            { header: "カテゴリ別" }, ...capRows(catAgg(txs), 5, totalInc),
          ] };
        }
        if (nd.id === "その他収入") {
          const txs = otherIncTx();
          return { title: nd.label + hint, rows: [
            { name: "合計", value: fmt(otherInc), color: nd.color },
            { name: "件数", value: txs.length + "件" },
            { header: "カテゴリ別" }, ...capRows(catAgg(txs), 5, otherInc),
          ] };
        }
        if (nd.id === "支出") {
          const txs = allTx(expTxAcc);
          const agg = grpAgg(txs);
          return { title: nd.label + hint, pie: wedges(agg, 6), rows: [
            { name: "合計", value: fmt(totalExp), color: nd.color },
            { name: "件数", value: txs.length + "件" },
            { header: "中分類別" }, ...capRows(agg, 5, totalExp),
          ] };
        }
        if (nd.id === "有価証券") {
          const evs = [...allTx(buyEv).map(buyItem),
                       ...allTx(sellEv).map(sellItem)];
          return { title: nd.label + hint, rows: [
            { name: "買付(現金→証券)", value: fmt(totalBuy), color: nd.color },
            { name: "売却(証券→現金)", value: fmt(totalSell) },
            { header: "主な約定" }, ...txTipRows(evs, 3),
          ] };
        }
        const tin = accIn.get(nd.acc) || 0, tout = accOut.get(nd.acc) || 0;
        const rows = [
          { name: "流入", value: fmt(tin) },
          { name: "流出", value: fmt(tout) },
        ];
        const d = tin - tout;
        if (Math.abs(d) >= 1) {
          const liab = isLiab(nd.acc);   // 負債口座は差の意味が反転する
          rows.push(d > 0
            ? { name: liab ? "負債減(返済超過)" : "残高増",
                value: fmt(d), color: cssVar("--good") }
            : { name: liab ? "負債増(借入超過)" : "取り崩し・借入",
                value: fmt(-d), color: cssVar("--critical") });
        }
        const p = accParts(nd.acc);
        if (p.inn.length) {
          rows.push({ header: "流入の内訳" }, ...capRows(p.inn, 4, tin));
        }
        if (p.out.length) {
          rows.push({ header: "流出の内訳" }, ...capRows(p.out, 4, tout));
        }
        return { title: nd.label + hint, rows };
      },
      tipLink: (e) => {
        const nm = (id) => id.startsWith("acc:") ? aname(id.slice(4)) : id;
        const title = nm(e.source) + " → " + nm(e.target) + hint;
        const src = e.source.startsWith("acc:") ? e.source.slice(4) : null;
        const dst = e.target.startsWith("acc:") ? e.target.slice(4) : null;
        if (e.target === "支出") {
          const txs = expTxAcc.get(src) || [];
          const agg = grpAgg(txs);
          return { title, pie: wedges(agg, 6), rows: [
            { name: "支出合計", value: fmt(e.value), color: e.color },
            { name: "件数", value: txs.length + "件" },
            { header: "中分類別" }, ...capRows(agg, 4, e.value),
          ] };
        }
        if (e.source === "支出") {   // 戻り超過(ポイント充当・返品等)
          const txs = expTxAcc.get(dst) || [];
          return { title, rows: [
            { name: "戻りの超過(充当・返品等)", value: fmt(e.value),
              color: e.color },
            { name: "件数", value: txs.length + "件" },
            { header: "主な明細" },
            ...txTipRows(txs.map((t) => txItem(t, effective(t).amount)), 3),
          ] };
        }
        if (e.source === "収入" || e.source === "その他収入") {
          const txs = e.target === "その他収入"
            ? otherIncTx() : (incTxAcc.get(dst) || []);
          return { title, rows: [
            { name: "合計", value: fmt(e.value), color: e.color },
            { name: "件数", value: txs.length + "件" },
            { header: "カテゴリ別" }, ...capRows(catAgg(txs), 4, e.value),
          ] };
        }
        if (e.target === "有価証券" || e.source === "有価証券") {
          const buy = e.target === "有価証券";
          const items = buy ? (buyEv.get(src) || []).map(buyItem)
                            : (sellEv.get(dst) || []).map(sellItem);
          return { title, rows: [
            { name: buy ? "買付合計" : "売却受取", value: fmt(e.value),
              color: e.color },
            { name: "件数", value: items.length + "件" },
            { header: "主な約定" }, ...txTipRows(items, 3),
          ] };
        }
        // 口座間の振替(矢印は純流量。行き来があれば両方向も見せる)
        const fwd = (trTx.get(src + "→" + dst) || [])
          .map((t) => txItem(t, Math.abs(t.amount)));
        const rev = (trTx.get(dst + "→" + src) || [])
          .map((t) => txItem(t, -Math.abs(t.amount)));
        const rows = [{ name: "純流量", value: fmt(e.value), color: e.color }];
        if (rev.length) {
          rows.push({ name: `行き(${fwd.length}件)`,
            value: fmt(fwd.reduce((s, it) => s + it.amt, 0)) });
          rows.push({ name: `戻り(${rev.length}件)`,
            value: fmt(-rev.reduce((s, it) => s + it.amt, 0)) });
        } else {
          rows.push({ name: "件数", value: fwd.length + "件" });
        }
        rows.push({ header: "主な明細" }, ...txTipRows([...fwd, ...rev], 3));
        return { title, rows };
      },
      clickNode: (nd) => {
        if (nd.id === "収入") {
          openIncomeDetail(`${pmLabel} の収入`, allTx(incTxAcc));
        } else if (nd.id === "その他収入") {
          openIncomeDetail(`その他収入(${pmLabel})`, otherIncTx());
        } else if (nd.id === "支出") {
          openExpenseDetail(`${pmLabel} の支出`, allTx(expTxAcc));
        } else if (nd.id === "有価証券") {
          openInvestDetail(null);
        } else {
          openAccountDetail(nd.acc);
        }
      },
      clickLink: (e) => {
        const src = e.source.startsWith("acc:") ? e.source.slice(4) : null;
        const dst = e.target.startsWith("acc:") ? e.target.slice(4) : null;
        if (e.target === "支出") {
          openExpenseDetail(`${aname(src)} の支出(${pmLabel})`,
                            expTxAcc.get(src) || []);
        } else if (e.source === "支出") {
          openExpenseDetail(`${aname(dst)} の支出(${pmLabel})`,
                            expTxAcc.get(dst) || []);
        } else if (e.source === "収入" || e.source === "その他収入") {
          if (e.target === "その他収入") {
            openIncomeDetail(`その他収入(${pmLabel})`, otherIncTx());
          } else {
            openIncomeDetail(`${aname(dst)} の収入(${pmLabel})`,
                             incTxAcc.get(dst) || []);
          }
        } else if (e.target === "有価証券") {
          openInvestDetail(src);
        } else if (e.source === "有価証券") {
          openInvestDetail(dst);
        } else {
          openTransferDetail(src, dst);
        }
      },
    });
    $("#flow-note").textContent =
      `${pmLabel} の口座間の資金ネットワーク。` +
      "期間設定のみ反映。" +
      "証券は売り買い別矢印、それ以外は差し引き流量。" +
      "要素にマウスオーバーで内訳、クリックで明細一覧。";
  }

  Object.assign(KB, { renderMoneyFlow, jumpToTxn });
})();
