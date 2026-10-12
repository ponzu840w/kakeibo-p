"use strict";
// core.js: 定数・状態・共通フォーマッタ・ツールチップ本体。
// 他の全ファイルから参照される基盤(最初に読み込まれる)。
(function () {
  const KB = window.KB = window.KB || {};
  // data.js は容量削減のため source/rule を文字列テーブル参照で持ち、
  // description と同一の raw_description を省略している(build.py)。
  // 最初にここで展開し、以降の全コードは従来どおりの形で扱う
  {
    const st = DATA.string_table;
    if (st) {
      for (const t of DATA.transactions) {
        t.source = st[t.source];
        if (t.rule !== undefined) t.rule = st[t.rule];
        if (t.raw_description === undefined) t.raw_description = t.description;
      }
    }
  }
  const $ = (s) => document.querySelector(s);
  // 負値は「−¥1,000」(UI規約の−表記)。"¥-1,000" を出さないことを
  // ここで保証するので、呼び出し側で符号を場合分けしない
  const fmt = (n) => {
    const v = Math.round(n);
    return (v < 0 ? "−¥" : "¥") + Math.abs(v).toLocaleString("ja-JP");
  };
  const sfmt = (n) => (n >= 0 ? "+" : "−") + fmt(Math.abs(n));
  const cYen = (n) => "¥" + compact(Math.round(n));
  const cssVar = (name) =>
    getComputedStyle(document.documentElement).getPropertyValue(name).trim();

  const TXNS = DATA.transactions;
  // 資産グループの固定表示順と表示名(値の大小で順序が揺れないように)
  const GROUP_ORDER = ["銀行", "証券", "決済・電子マネー", "現金",
                       "年金", "手入力資産", "給与", "その他"];
  const GROUP_LABEL = { "銀行": "銀行残高", "決済・電子マネー": "電子マネー" };
  const glabel = (g) => GROUP_LABEL[g] || g;
  // グループ色は固定スロット(機関のイメージカラーに近づける: ゆうちょ=緑、
  // SBI証券=青)。存在するグループの並び順で色が揺れないようにする
  const GROUP_SLOT = { "銀行": 2, "証券": 1, "決済・電子マネー": 3,
                       "現金": 4, "年金": 7, "手入力資産": 5, "給与": 6 };
  const groupColor = (g) => GROUP_SLOT[g]
    ? cssVar("--cat" + GROUP_SLOT[g]) : cssVar("--cat-other");
  const gsort = (entries, key) => entries.sort((a, b) => {
    const ia = GROUP_ORDER.indexOf(key(a)), ib = GROUP_ORDER.indexOf(key(b));
    return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
  });
  // 純資産推移(と長期投影の実績側・資産構成バー)の積み上げ順(下→上、
  // バーでは左→右)。支出との距離順: 引き出しにくいもの(年金)を底に、
  // 日々の支出に近いもの(現金・電子マネー)ほど天面側に置く。
  // 未知のグループは「その他」の位置に挟む
  const NW_STACK_ORDER = ["年金", "手入力資産", "証券", "銀行", "現金",
                          "決済・電子マネー", "給与", "その他"];
  const nwStackSort = (groups) => [...groups].sort((a, b) => {
    const rank = (g) => {
      const i = NW_STACK_ORDER.indexOf(g);
      return i < 0 ? NW_STACK_ORDER.indexOf("その他") + 0.5 : i;
    };
    return rank(a) - rank(b);
  });

  // 内訳の濃淡階調。バー・ドーナツ・凡例のすべてで同じ表を使う(場所で
  // 濃さが変わると同じ口座を色で追えない)。面倒な色計算は color-mix に
  // 任せ、地の色(--surface)に薄めていく。
  // 階調は4段まで。5番目以降はすべて最薄色になり、色では区別できない
  const shade = (color, i) => {
    const k = [100, 70, 48, 34][Math.min(i, 3)];
    return k === 100 ? color
      : `color-mix(in srgb, ${color} ${k}%, ${cssVar("--surface")})`;
  };
  // 負債の内訳色: --critical の濃淡
  const liabShade = (i) => shade(cssVar("--critical"), i);
  // 支出カテゴリの中分類(rules.toml の category_groups)。チャートは細かい
  // カテゴリでなくこの中分類で束ねる。未登録カテゴリは「その他」に落ちる
  const CAT_GROUPS = DATA.category_groups || {};
  const CAT_GROUP_OF = new Map();
  for (const [g, cats] of Object.entries(CAT_GROUPS))
    for (const c of cats) CAT_GROUP_OF.set(c, g);
  const catGroup = (c) => CAT_GROUP_OF.get(c) || "その他";
  const ACCOUNTS = DATA.accounts;
  const BALS = DATA.balances || {};

  // 手動上書き(カテゴリ・コメント)関連の共有データ。
  // 実際の編集フォーム・保存処理は tab-ledger.js。ここは他ファイルからも
  // 参照される索引と、サーバ配信モードかどうかのフラグ(KB.OVR_SRV)のみ。
  const TX_BY_ID = new Map(TXNS.map((t) => [t.id, t]));
  const OVR_BY_ID = new Map((DATA.overrides || []).map((o) => [o.id, o]));
  KB.OVR_SRV = false;   // main.js の /api/ping 確認後に true になる(ライブ参照専用)
  const HIST = DATA.balance_history || {};
  const months = [...new Set(TXNS.map((t) => t.date.slice(0, 7)))].sort();
  const curMonth = months[months.length - 1] || "";
  const LIQUID_GROUPS = new Set(["銀行", "現金", "決済・電子マネー"]);

  const PRESETS = [
    ["今月", 1], ["3ヶ月", 3], ["6ヶ月", 6], ["12ヶ月", 12], ["全期間", 0],
  ];
  const state = { tab: "summary", months: 12, account: "", category: "",
                  search: "", hideTransfer: false,
                  fOverride: false, fComment: false, fUnmatched: false,   // 明細タブ専用の絞り込み
                  incomeMode: "gross",   // gross=総支給 | net=手取り
                  osc: "cash",           // オシロの既定モード
                  flowMode: "transfer",  // 資金の流れ: transfer=口座間NW | budget=収支サンキー
                  nwWin: 12,             // 純資産推移の表示ウィンドウ(月数、0=全期間)
                  focusTxn: "",          // 明細タブでハイライトする取引ID(ジャンプ導線)
                  ltBase: "auto",        // 長期投影の実績参照期間(auto | 3 | 6 | 12)
                  planHorizon: 3,        // 資金繰り予測の期間(月)
                  planYears: 5 };        // 長期投影の年数
  function loadGlobals() {
    try {
      const g = JSON.parse(localStorage.getItem("kakeibo-globals") || "{}");
      if (g.incomeMode === "net") state.incomeMode = "net";
      if (g.hideTransfer) state.hideTransfer = true;
      if (g.osc === "flow") state.osc = "flow";
      if (typeof g.nwWin === "number" && g.nwWin >= 0) state.nwWin = g.nwWin;
    } catch (e) { /* file:// で localStorage 不可でも動作継続 */ }
  }
  function saveGlobals() {
    try {
      localStorage.setItem("kakeibo-globals", JSON.stringify({
        incomeMode: state.incomeMode,
        hideTransfer: state.hideTransfer,
        osc: state.osc,
        nwWin: state.nwWin,
      }));
    } catch (e) { /* 同上 */ }
  }

  // 収入モード(総支給/手取り): 手取りモードでは給与清算口座の控除(expense)を「収入のマイナス」として
  // 扱う。収入=手取り額になり、社会保険料・税はカテゴリからも消える。
  function effective(t) {
    if (state.incomeMode === "net" && t.type === "expense") {
      const a = ACCOUNTS[t.account];
      // 法定控除(社会保険料・税)だけを収入側で差し引く。社食などの
      // 任意控除は「給料をもらった上で支出した」ものとして支出に残す
      if (a && a.group === "給与" &&
          (t.category === "社会保険料" || t.category === "税金")) {
        return { type: "income", amount: t.amount };
      }
    }
    return t;
  }
  // 月次の収入・支出(現在の収入モードで集計)
  function monthlyTotals(txns) {
    const inc = new Map(), exp = new Map();
    for (const t of txns) {
      const e = effective(t);
      const m = t.date.slice(0, 7);
      if (e.type === "income") inc.set(m, (inc.get(m) || 0) + e.amount);
      else if (e.type === "expense") exp.set(m, (exp.get(m) || 0) - e.amount);
    }
    return { inc, exp };
  }

  function periodMonths() {
    if (!state.months) return months;
    return months.filter((m) => m > shiftMonth(curMonth, -state.months));
  }
  function shiftMonth(ym, delta) {
    if (!ym) return "";
    let [y, m] = ym.split("-").map(Number);
    m += delta;
    while (m <= 0) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    return y + "-" + String(m).padStart(2, "0");
  }
  const monthLabel = (m) => m ? Number(m.slice(5)) + "月" : "今月";
  const daysOf = (m) => {
    const [y, mm] = m.split("-").map(Number);
    return new Date(y, mm, 0).getDate();
  };

  function filteredNoPeriod() {
    return TXNS.filter((t) => {
      if (state.account && t.account !== state.account) return false;
      if (state.category && t.category !== state.category) return false;
      if (state.search &&
          !(t.description + " " + (t.memo || "") + " " + (t.comment || ""))
            .toLowerCase().includes(state.search.toLowerCase())) return false;
      return true;
    });
  }
  function filtered() {
    const ms = new Set(periodMonths());
    return filteredNoPeriod().filter((t) => ms.has(t.date.slice(0, 7)));
  }

  // 資産の合成: 口座ごとの最新アンカー(時点バラバラ)を単純合算する。厳密さより
  // 「いま判明している分の合成」を日付表示とともに正直に見せる方針。
  function composition() {
    const groups = new Map();
    let assets = 0, liabRaw = 0, oldest = "", newest = "";
    for (const [id, b] of Object.entries(BALS)) {
      const a = ACCOUNTS[id];
      if (!a) continue;
      if (!oldest || b.date < oldest) oldest = b.date;
      if (b.date > newest) newest = b.date;
      if (a.kind === "liability") { liabRaw += b.balance; continue; }
      const g = a.group || "その他";
      groups.set(g, (groups.get(g) || 0) + b.balance);
      assets += b.balance;
    }
    return {
      assets, net: assets + liabRaw, liab: Math.max(0, -liabRaw),
      oldest, newest,
      groups: gsort([...groups.entries()], (e) => e[0]),
    };
  }
  const COMP = composition();

  // 月末ごとに「その時点までに判明している最新残高」を口座別にキャリー
  // フォワードして合算した純資産の点列。covered はその月に残高が判明して
  // いる口座数(途中から手入力が増えると総額がジャンプするため、正直に出す)
  function netWorthSeries() {
    const accs = Object.keys(HIST);
    let lo = "", hi = "";
    for (const a of accs) for (const p of HIST[a]) {
      const m = p.date.slice(0, 7);
      if (!lo || m < lo) lo = m;
      if (m > hi) hi = m;
    }
    if (!lo) return [];
    // 含み益の点列(ポートフォリオ取得日ごと)。月末へキャリーフォワードする
    const plHist = (DATA.invest || {}).pl_history || [];
    const out = [];
    // i < 600(50年)は不正な日付データで無限ループしないための上限
    for (let m = lo, i = 0; m <= hi && i < 600; m = shiftMonth(m, 1), i++) {
      const end = m + "-99";
      let assetSum = 0, liab = 0, covered = 0;
      const groups = new Map();
      const liabs = new Map();               // 口座名→負債額(正値)の内訳
      for (const a of accs) {
        let last = null;
        for (const p of HIST[a]) {
          if (p.date <= end) last = p; else break;
        }
        if (!last) continue;
        covered++;
        const acc = ACCOUNTS[a];
        if (acc && acc.kind === "liability") {
          liab += last.balance;
          if (last.balance < 0) {
            const nm = acc.name || a;
            liabs.set(nm, (liabs.get(nm) || 0) - last.balance);
          }
          continue;
        }
        const g = acc ? (acc.group || "その他") : "その他";
        groups.set(g, (groups.get(g) || 0) + last.balance);
        assetSum += last.balance;
      }
      let pl = 0;
      for (const q of plHist) { if (q.date <= end) pl = q.pl; else break; }
      out.push({ month: m, total: assetSum + liab, liab, groups, liabs, pl,
                 covered, of: accs.length });
    }
    return out;
  }
  const NW = netWorthSeries();

  // 純資産点のツールチップ素材。
  // 資産タブの推移チャートと長期予測の実績側で共通。収支系ツールチップと
  // 同じ文法(ドーナツで形、セクション見出し付きの表で正確な額と構成比)。
  // 負債の濃淡は口座ごとに固定したいので、順位表は系列全体から先に作る
  // (月ごとの大小で順位付けすると、隣の月で同じ口座の色が変わって追えない)
  function nwLiabRank(series) {
    const mx = new Map();
    for (const p of series) for (const [nm, v] of p.liabs)
      mx.set(nm, Math.max(mx.get(nm) || 0, v));
    const rank = new Map();
    [...mx.entries()].sort((a, b) => b[1] - a[1])
      .forEach(([nm], i) => rank.set(nm, i));
    return rank;
  }
  function nwTip(p, prev, liabRank) {
    const assets = [...p.groups.values()]
      .reduce((s, v) => s + Math.max(0, v), 0);
    const liab = Math.max(0, -p.liab);
    const pctOf = (v, total) =>
      total > 0 ? Math.round(v / total * 100) + "%" : undefined;
    const rows = [{ name: "純資産", value: fmt(p.total),
                    color: cssVar("--ink"), cls: p.total < 0 ? "neg" : "" }];
    if (prev) {
      const d = p.total - prev.total;
      rows.push({ name: "前月比", value: sfmt(d), cls: d < 0 ? "neg" : "" });
    }
    const groups = gsort([...p.groups.entries()], (e) => e[0])
      .filter(([, v]) => v > 0);
    const wedges = groups.map(([g, v]) =>
      ({ name: glabel(g), value: v, color: groupColor(g) }));
    if (groups.length) {
      rows.push({ header: "資産" },
                 { name: "資産計", value: fmt(assets), pct: "100%" });
      for (const [g, v] of groups) {
        rows.push({ name: glabel(g), value: fmt(v), color: groupColor(g),
                    pct: pctOf(v, assets) });
      }
      const sec = p.groups.get("証券") || 0;
      if (p.pl > 0 && sec > 0) {
        const v = Math.min(p.pl, sec);
        rows.push({ name: "うち含み益(斜線)", value: fmt(v),
                    pct: pctOf(v, assets) });
      }
      // 証券の前月比は評価損益だけでは説明できない(買付・スイープ・受渡の
      // 時点ずれ)ので、含み損益の変化を並べて「それ以外」を読めるようにする
      if (prev && (sec || prev.groups.get("証券"))) {
        const d = sec - (prev.groups.get("証券") || 0);
        const dpl = (p.pl || 0) - (prev.pl || 0);
        rows.push({ name: "証券の前月比", value: sfmt(d), cls: d < 0 ? "neg" : "" },
                  { name: "うち含み損益の変化", value: sfmt(dpl),
                    cls: dpl < 0 ? "neg" : "" });
      }
    }
    const liabW = [...p.liabs]
      .sort((a, b) => liabRank.get(a[0]) - liabRank.get(b[0]))
      .map(([nm, v]) => ({ name: nm, value: v,
                           color: liabShade(liabRank.get(nm)) }));
    if (liab > 0) {
      rows.push({ header: "負債" },
                 { name: "負債計", value: "−" + fmt(liab), pct: "100%",
                   cls: "neg" });
      for (const w of liabW) {
        rows.push({ name: w.name, value: "−" + fmt(w.value), color: w.color,
                    pct: pctOf(w.value, liab), cls: "neg" });
      }
    }
    rows.push({ name: "残高判明", value: p.covered + "/" + p.of + "口座" });
    return { rows, pie: { outer: wedges, liab: liabW } };
  }

  // 投資イベント(DATA.invest.events)の共通述語。
  // action 文字列の判定と手数料の符号の扱いを1箇所に集める(散在させると
  // 手数料の足し引きを呼び出し側ごとに間違える)。分配金再投資は現金の
  // 移動を伴わない内部取引なので、フロー系の集計では isReinvest で除外する
  const isSell = (e) => /売/.test(e.action || "");
  const isReinvest = (e) => /分配金再投資/.test(e.action || "");
  const buyCost = (e) => (e.amount || 0) + (e.fee || 0);   // 買付の現金流出
  const sellProceeds = (e) => Math.abs(e.amount || 0) - (e.fee || 0);  // 売却受取

  // 摘要から店・サービス名相当のキーを取り出す共通の正規化。
  // ドリルダウン・定期支出検出・未分類ランキング・定点観測で同じ束ね方をする
  function watchKey(desc) {
    return (desc || "").replace(/^支払い /, "").split(" - ")[0] || "(摘要なし)";
  }

  // ローカル日付の ISO 文字列。Date#toISOString は UTC 変換で JST の
  // 0〜9時に前日へずれるため、日付文字列は必ずこちらで作る
  function localIso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-` +
      String(d.getDate()).padStart(2, "0");
  }
  const todayIso = () => localIso(new Date());

  function staleness(dateStr, interval) {
    const days = Math.floor(
      (Date.now() - new Date(dateStr + "T00:00:00")) / 864e5);
    // 9999 は build.py 由来の「監視間隔の宣言なし」センチネル。
    // 間隔不明の口座も90日を超えたら警告する
    if (!interval || interval >= 9999) return days > 90 ? "warn" : "";
    if (days > interval * 2) return "crit";
    if (days > interval) return "warn";
    return "ok";
  }

  const tip = $("#tooltip");
  // pie: 扇形配列、または {outer, inner} で二重ドーナツ。さらに {liab} が
  // あれば負債のドーナツを右に並べる(資産と負債は母集団が別なので、
  // 1つのリングに混ぜず左右に分ける)。
  // rows の {header: "..."} はセクション見出し行になる
  function showTip(evt, title, rows, pie) {
    // カーソル直下の図形に縁取り(svgkit.js hlMark。後読みなので KB 経由)。
    // 強調した図形と同じ色のドーナツ扇形・行ラベルにも波及させ、
    // 「バーで触れている部分=ツールチップで太いところ」を全チャートで揃える
    const hlEl = evt && KB.hlMark ? KB.hlMark(evt) : null;
    const hlFill = hlEl ? hlEl.getAttribute("fill") : null;
    if (hlFill && pie) {
      const lists = [pie.outer || pie, pie.inner, pie.liab].filter(Boolean);
      // 呼び出し側が hl を明示している場合(資産構成バー)は上書きしない
      if (!lists.some((ws) => ws.some((w) => w.hl))) {
        for (const ws of lists) for (const w of ws) {
          if (w.color === hlFill) w.hl = true;
        }
      }
    }
    tip.replaceChildren();
    const t = document.createElement("div");
    t.className = "tt-title";
    t.textContent = title;
    tip.appendChild(t);
    // ttDonut は svgkit.js(このファイルの次に読み込まれる)の公開物。
    // トップレベルで destructure すると読み込み順で undefined になるため
    // 呼び出し時に KB 経由で参照する(実行はページ読了後のホバー時)
    const outer = pie && (pie.outer || pie);
    const inner = pie && pie.outer ? pie.inner : null;
    const hasOuter = outer && outer.some((w) => w.value > 0);
    const liabW = pie && pie.liab && pie.liab.some((w) => w.value > 0)
      ? pie.liab : null;
    if (hasOuter && liabW) {
      // 大きい方を96pxとし、小さい方は面積がおおよそ金額比になるよう
      // 直径を√比で縮める。どちらが縮むかは資産・負債の大小で決まる
      // (負債側だけ縮める方式だと、負債>資産の期間で大小の差を表せない)。
      // 読める下限は確保するので目安。正確な額は引き出しラベルと表にある
      const sum = (ws) => ws.reduce((s, w) => s + Math.max(0, w.value), 0);
      const sa = sum(outer), sl = sum(liabW);
      const dSmall = Math.max(48, Math.round(
        96 * Math.sqrt(Math.min(sa, sl) / Math.max(1, sa, sl))));
      const Da = sa >= sl ? 96 : dSmall, Dl = sa >= sl ? dSmall : 96;
      const row = document.createElement("div");
      row.style.cssText = "display:flex;align-items:center;justify-content:center";
      // キャプションは「資産 119万9千」のように総額を併記(負債は赤の−付き)
      const col = (svgEl, cap, total, neg) => {
        const c = document.createElement("div");
        c.appendChild(svgEl);
        const label = document.createElement("div");
        label.className = "tt-cap";
        label.textContent = cap + " ";
        const amt = document.createElement("span");
        amt.className = "tt-cap-v" + (neg ? " neg" : "");
        amt.textContent = (neg ? "−" : "") + compact(total);
        label.appendChild(amt);
        c.appendChild(label);
        return c;
      };
      row.append(col(KB.ttDonut(outer, Da, inner), "資産", sa, false),
                 col(KB.ttDonut(liabW, Dl), "負債", sl, true));
      tip.appendChild(row);
    } else if (hasOuter || liabW) {
      tip.appendChild(hasOuter
        ? KB.ttDonut(outer, 96, inner)
        : KB.ttDonut(liabW, 96));
    }
    for (const r of rows) {
      if (r.header) {
        const h = document.createElement("div");
        h.className = "tt-sec";
        h.textContent = r.header;
        tip.appendChild(h);
        continue;
      }
      const row = document.createElement("div");
      row.className = "tt-row";
      // 強調中の図形に対応する行は太字(display:contents なので子に継承)
      if (hlFill && r.color === hlFill) row.style.fontWeight = "600";
      const key = document.createElement("span");
      key.className = "tt-key";
      key.style.background = r.color || "transparent";
      row.appendChild(key);
      const name = document.createElement("span");
      name.className = "tt-name";
      name.textContent = r.name;
      row.appendChild(name);
      if (r.pct !== undefined) {
        // 構成比の独立カラム(右揃え)。金額カラムと列として揃う
        const pctEl = document.createElement("span");
        pctEl.className = "tt-pct";
        pctEl.textContent = r.pct;
        row.appendChild(pctEl);
      }
      const val = document.createElement("span");
      // cls="neg" で赤字(負債・マイナスの徹底)
      val.className = "tt-val" + (r.cls ? " " + r.cls : "");
      val.textContent = r.value;
      row.appendChild(val);
      tip.appendChild(row);
    }
    tip.style.display = "grid";   // 列レイアウトはCSS(#tooltip)側で定義
    // 画面より大きいツールチップは丸ごと縮小して全内容を見せる
    tip.style.transform = "";
    const r0 = tip.getBoundingClientRect();
    const scale = Math.min(1, (innerWidth - 16) / r0.width,
                              (innerHeight - 16) / r0.height);
    if (scale < 1) tip.style.transform = `scale(${scale})`;
    moveTip(evt);
  }
  function moveTip(evt) {
    const pad = 14, edge = 8;
    let x = evt.clientX + pad, y = evt.clientY + pad;
    const r = tip.getBoundingClientRect();
    // まずカーソルの反対側へ反転を試み、それでも収まらない場合は
    // 画面内にクランプする(巨大なツールチップでも見切れさせない)
    if (x + r.width > innerWidth - edge) x = evt.clientX - r.width - pad;
    if (y + r.height > innerHeight - edge) y = evt.clientY - r.height - pad;
    x = Math.max(edge, Math.min(x, innerWidth - edge - r.width));
    y = Math.max(edge, Math.min(y, innerHeight - edge - r.height));
    // 整数に丸めて置く。トラックパッドの clientX/Y は小数で、そのまま置くと
    // ツールチップがサブピクセル位置に毎フレーム置き直され、中身全体の
    // アンチエイリアスの位相が変わって震えて見える
    tip.style.left = Math.round(x) + "px";
    tip.style.top = Math.round(y) + "px";
  }
  function hideTip() {
    tip.style.display = "none";
    if (KB.hlClear) KB.hlClear();
  }

  // タッチでのツールチップ操作: ホバーの無いタッチでは「タップで表示・別の場所をタップで消える」に
  // 置き換える。タップは pointermove を(ほぼ)発火させないので、タップ位置の
  // 図形へ合成 pointermove を配って各チャートの既存ハンドラを発火させる。
  // タップ直後にブラウザが送る pointerleave での消去は、タッチ表示中だけ
  // 捕捉段階で止める(チャート側の個別ハンドラは変更しない)。
  let touchTipHold = false;
  document.addEventListener("pointerleave", (e) => {
    if (touchTipHold && e.pointerType === "touch") e.stopPropagation();
  }, true);
  document.addEventListener("pointerup", (e) => {
    if (e.pointerType !== "touch") return;
    touchTipHold = false;
    hideTip();
    e.target.dispatchEvent(new PointerEvent("pointermove", {
      clientX: e.clientX, clientY: e.clientY, bubbles: true,
    }));
    // 図形上のタップなら上の dispatch でツールチップが表示されている
    touchTipHold = tip.style.display !== "none";
  });

  function niceStep(maxV) {
    const raw = Math.max(1, maxV) / 4;
    const mag = Math.pow(10, Math.floor(Math.log10(raw)));
    for (const m of [1, 2, 5, 10]) if (raw <= m * mag) return m * mag;
    return 10 * mag;
  }
  // 短縮表記。万単位で切り捨てると合算がずれて見えるので千の位まで持つ
  function compact(v) {
    if (v <= -1) return "−" + compact(-v);
    if (v >= 1e8) return (v / 1e8).toFixed(2).replace(/\.?0+$/, "") + "億";
    if (v >= 1e4) {
      const man = Math.floor(v / 1e4);
      const sen = Math.round((v - man * 1e4) / 1e3);
      if (sen >= 10) return (man + 1).toLocaleString() + "万";
      return man.toLocaleString() + "万" + (sen ? sen + "千" : "");
    }
    return Math.round(v).toLocaleString();
  }
  function truncate(s, n) { return s.length > n ? s.slice(0, n) + "…" : s; }
  function mkTile(parent, label, value, sub, valueCls) {
    const tile = document.createElement("div");
    tile.className = "tile";
    const l = document.createElement("div");
    l.className = "label";
    l.textContent = label;
    const v = document.createElement("div");
    v.className = "value" + (valueCls ? " " + valueCls : "");
    v.textContent = value;
    const s = document.createElement("div");
    s.className = "sub";
    s.textContent = sub;
    tile.append(l, v, s);
    parent.appendChild(tile);
    return tile;
  }
  function note(box, msg) {
    const p = document.createElement("div");
    p.className = "count-note";
    p.textContent = msg;
    box.appendChild(p);
  }
  // 既存の注記要素(.count-note)を1行1項目で埋める。前提が複数あるチャートの
  // 説明を区切り文字で1行に詰め込まず、行として読ませるためのもの。
  // CSS の white-space に依存せず要素で改行する(HTML直書きの注記に影響しない)
  function noteLines(el, lines) {
    el.replaceChildren();
    for (const l of lines.filter(Boolean)) {
      const d = document.createElement("div");
      d.textContent = l;
      el.appendChild(d);
    }
  }

  // ビルドログの表示用整形。
  // build_log.jsonl のレコード列(古い順。無変化ビルドは {ts, repeat} 行)を
  // 表示用グループ(新しい順)に畳む。グループ = 本文エントリ+後続のrepeat群。
  // added/removed は直前(1つ古い)グループとの警告類(warn/verify/skip/
  // cand/fresh)の行差分。info(件数サマリ)は取込のたび変わるので差分対象外
  function buildLogView(records) {
    const NOTE = new Set(["warn", "verify", "skip", "cand", "fresh"]);
    const groups = [];
    for (const r of records || []) {
      const g = groups[groups.length - 1];
      if (r.repeat && g) {
        g.count++;
        g.tsLast = r.ts;
      } else if (!r.repeat) {
        groups.push({ ts: r.ts, tsLast: r.ts, count: 1, ok: r.ok !== false,
                      lines: r.lines || [], error: r.error || "",
                      added: [], removed: [] });
      }
      // 先頭がrepeatのままの欠け(参照先が埋め込み範囲外)は何も表示せずに捨てる
    }
    const notes = (g) =>
      new Set(g.lines.filter((l) => NOTE.has(l.k)).map((l) => l.t));
    for (let i = 1; i < groups.length; i++) {
      const prev = notes(groups[i - 1]), cur = notes(groups[i]);
      groups[i].added = [...cur].filter((t) => !prev.has(t));
      groups[i].removed = [...prev].filter((t) => !cur.has(t));
    }
    return groups.reverse();
  }

  // 明細表で対応する行(振替ペア・給与明細と手取り振込)を結ぶ線の割り当て。
  // keys[i] は表のi行目の pair/settle(無ければ空)、hubs[i] はその行が
  // 一対多の「1」側(手取り振込)か。同じキーの行が表に2行以上あるものを
  // 区間 [a,b] にし、短い順に重ならない最も内側のレーンへ置く。短い順なので
  // 入れ子の区間は内側に収まって交差せず、交差は区間が部分的に重なる組
  // だけに限られる。一対多(1側+多側2行以上)は多側を束ねる線と束から
  // 1側へ向かう線で2レーンを使う(depth=2)
  function pairLanes(keys, hubs = []) {
    const groups = new Map();
    keys.forEach((k, i) => {
      if (!k) return;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(i);
    });
    const spans = [];
    for (const [key, rows] of groups) {
      if (rows.length < 2) continue;
      const hub = rows.find((i) => hubs[i]);
      const members = rows.filter((i) => i !== hub);
      spans.push({ key, rows, hub: hub === undefined ? -1 : hub, members,
                   depth: hub !== undefined && members.length > 1 ? 2 : 1,
                   a: rows[0], b: rows[rows.length - 1] });
    }
    spans.sort((x, y) => (x.b - x.a) - (y.b - y.a) || x.a - y.a);
    const lanes = [];
    const free = (k, s) => (lanes[k] || []).every((o) => o.b < s.a || s.b < o.a);
    for (const s of spans) {
      let lane = 0;
      while (!free(lane, s) || (s.depth === 2 && !free(lane + 1, s))) lane++;
      for (let d = 0; d < s.depth; d++) (lanes[lane + d] ||= []).push(s);
      s.lane = lane;
    }
    return { spans, lanes: lanes.length };
  }

  Object.assign(KB, {
    $, fmt, sfmt, cYen, cssVar, buildLogView,
    TXNS, glabel, groupColor, gsort,
    nwStackSort, shade, liabShade,
    CAT_GROUPS, CAT_GROUP_OF, catGroup, ACCOUNTS, BALS,
    TX_BY_ID, OVR_BY_ID, HIST, months, curMonth, LIQUID_GROUPS,
    PRESETS, state, loadGlobals, saveGlobals,
    effective, monthlyTotals, periodMonths, shiftMonth, monthLabel, daysOf,
    filteredNoPeriod, filtered,
    COMP, NW, nwLiabRank, nwTip,
    staleness, localIso, todayIso,
    isSell, isReinvest, buyCost, sellProceeds,
    watchKey,
    showTip, hideTip,
    niceStep, compact, truncate, mkTile, note, noteLines, pairLanes,
  });
})();
