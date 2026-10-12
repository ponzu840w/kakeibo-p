"use strict";
// main.js: ページ全体のオーケストレーション(最後に読み込まれる)。
// タブ切替・情報鮮度モニタ・取込/再ビルド・月詳細モーダル・サマリ・
// 全体描画(render/renderAll)と起動処理。
// ここで使う他ファイルの関数はすべて自分より先に読み込まれたファイルの
// 公開物なので、通常どおりトップで destructure してよい。
(function () {
  const KB = window.KB;
  const {
    $, ACCOUNTS, TXNS, CAT_GROUPS, catGroup, BALS, COMP, NW, months, curMonth,
    LIQUID_GROUPS, state, PRESETS,
    effective, monthlyTotals, periodMonths, shiftMonth, monthLabel,
    filteredNoPeriod, filtered, saveGlobals, loadGlobals, hideTip,
    mkTile, note, fmt, sfmt, cYen,
    drawCompBar, drawNetWorth, renderAssetKpis, renderAccounts, renderDc,
    renderInvest,
    renderKpis, drawOscillo, drawMonthly, renderDrilldown, renderTrend,
    renderSavings, renderSubs, expenseItems, drawCatBars,
    renderSalaryTab, renderTable,
  } = KB;

  if (location.protocol.startsWith("http")) {
    fetch("/api/ping").then((r) => {
      if (!r.ok) return;
      KB.OVR_SRV = true;
      setupServerTools();
      // 鮮度モニタの状態はサーバの uistate.toml が正(data.jsは前回build時点)
      return fetch("/api/uistate").then((r2) => (r2.ok ? r2.json() : {}))
        .then((ui) => {
          freshState.ack = ui.ack || {};
          freshState.mute = ui.mute || {};
          migrateFreshLocal();
          renderFreshness();
        });
    }).catch(() => {});
  }
  // 取込(inbox投入)と再ビルド(serve.py 配信時のみ)
  // ファイル選択・ページ全体へのD&Dのどちらでも data/inbox に保存し、
  // 再ビルド→再読込する。振り分け結果はリロード後にトーストで見せる
  function setupServerTools() {
    const rebuildBtn = $("#rebuild-btn"), importBtn = $("#import-btn");
    const fileInput = $("#import-file"), overlay = $("#drop-overlay");
    rebuildBtn.style.display = importBtn.style.display = "";
    async function rebuild(noteLines) {
      rebuildBtn.disabled = importBtn.disabled = true;
      rebuildBtn.classList.add("spin");
      try {
        const r = await fetch("/api/rebuild", { method: "POST" });
        const text = await r.text();
        if (!r.ok) throw new Error(text);
        // 振り分け・警告の行だけ拾ってリロード後に見せる
        const picks = text.split("\n").filter((l) =>
          /^(振り分け|警告|スキップ)/.test(l));
        sessionStorage.setItem("kakeibo-build-note",
          [...(noteLines || []), ...picks].join("\n"));
        location.reload();
      } catch (e) {
        alert("再ビルドに失敗しました:\n" + e.message);
        rebuildBtn.disabled = importBtn.disabled = false;
        rebuildBtn.classList.remove("spin");
      }
    }
    async function importFiles(files) {
      if (!files.length || importBtn.disabled) return;
      rebuildBtn.disabled = importBtn.disabled = true;
      rebuildBtn.classList.add("spin");
      const done = [];
      for (const f of files) {
        try {
          const r = await fetch("/api/inbox?name=" + encodeURIComponent(f.name),
                                { method: "POST", body: f });
          if (!r.ok) throw new Error(await r.text());
          done.push("取込: " + f.name);
        } catch (e) {
          alert(`${f.name} の取込に失敗しました:\n${e.message}\n` +
                (done.length ? "取込済み:\n" + done.join("\n") : ""));
          rebuildBtn.disabled = importBtn.disabled = false;
          rebuildBtn.classList.remove("spin");
          return;
        }
      }
      rebuild(done);
    }
    rebuildBtn.addEventListener("click", () => rebuild());
    importBtn.addEventListener("click", () => fileInput.click());
    fileInput.addEventListener("change", () => {
      importFiles([...fileInput.files]);
      fileInput.value = "";
    });
    const hasFiles = (e) =>
      e.dataTransfer && [...e.dataTransfer.types].includes("Files");
    let depth = 0;
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth++;
      overlay.hidden = false;
    });
    window.addEventListener("dragleave", () => {
      if (--depth <= 0) { depth = 0; overlay.hidden = true; }
    });
    window.addEventListener("dragover", (e) => {
      if (hasFiles(e)) e.preventDefault();
    });
    window.addEventListener("drop", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth = 0;
      overlay.hidden = true;
      importFiles([...e.dataTransfer.files]);
    });
  }
  function showToast(text) {
    const t = document.createElement("div");
    t.className = "toast";
    t.textContent = text;
    t.addEventListener("click", () => t.remove());
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 12000);
  }
  // ビルドログモーダル
  // data.js 埋め込みの実行履歴(file:// でも見える)。約束事: 警告があっても
  // この画面を開くまでバッジ等の強調表示はしない(ユーザー方針)
  function setupBuildLog() {
    const bg = $("#buildlog-bg"), list = $("#buildlog-list");
    const el = (tag, cls, text) => {
      const e = document.createElement(tag);
      if (cls) e.className = cls;
      if (text !== undefined) e.textContent = text;
      return e;
    };
    function render() {
      list.replaceChildren();
      const groups = KB.buildLogView(DATA.build_log || []);
      if (!groups.length) {
        list.appendChild(el("p", "count-note",
                            "記録はまだありません(次のビルドから残ります)"));
        return;
      }
      for (const [i, g] of groups.entries()) {
        const d = el("details", "bl-entry" + (g.ok ? "" : " bl-fail"));
        if (i === 0) d.open = true;
        const times = g.count > 1
          ? ` ×${g.count}回(〜${g.tsLast.slice(5, 16)})` : "";
        const diff = [g.added.length && `新規${g.added.length}`,
                      g.removed.length && `解消${g.removed.length}`]
          .filter(Boolean).join("・");
        d.appendChild(el("summary", "",
                         g.ts + times + (g.ok ? "" : " ビルド失敗")
                         + (diff ? `(${diff})` : "")));
        if (g.error) d.appendChild(el("pre", "bl-error", g.error));
        const added = new Set(g.added);
        for (const l of g.lines) {
          const row = el("div", "bl-line bl-" + l.k, l.t);
          if (added.has(l.t)) row.prepend(el("span", "bl-new", "新規"));
          d.appendChild(row);
        }
        for (const t of g.removed) {
          d.appendChild(el("div", "bl-line bl-gone", "解消: " + t));
        }
        list.appendChild(d);
      }
    }
    $("#buildlog-btn").addEventListener("click", () => {
      render();
      bg.style.display = "";
    });
    $("#buildlog-close").addEventListener("click",
                                          () => bg.style.display = "none");
    bg.addEventListener("click", (e) => {
      if (e.target === bg) bg.style.display = "none";
    });
  }
  const TAB_IDS = ["summary", "assets", "salary", "flow", "year", "plan",
                   "ledger"];
  // push=true(既定)でタブ遷移を履歴に積む → ブラウザの戻る/進むで
  // サイト内の遷移を遡れる。hashchange 経由(戻る/進む・手打ち)からの
  // 呼び出しは push=false で再度積まない
  function setTab(id, push = true) {
    state.tab = id;
    document.querySelectorAll("#tabs button").forEach((b) =>
      b.classList.toggle("on", b.dataset.tab === id));
    document.querySelectorAll(".tabbed").forEach((el) =>
      el.classList.toggle("active", el.dataset.tabs.split(" ").includes(id)));
    if (push && location.hash !== "#" + id) {
      history.pushState(null, "", "#" + id);
    }
    // scrollChart 製の月次チャートは非表示タブでは幅0のまま描かれ最新側へ
    // スクロールできないので、タブが可視になった時点で右端(最新月)へスクロールし直す
    document.querySelectorAll(".tabbed.active .hscroll").forEach(
      (s) => { s.scrollLeft = s.scrollWidth; });
  }
  function applyHash() {
    const h = location.hash.replace("#", "");
    setTab(TAB_IDS.includes(h) ? h : "summary", false);
  }
  window.addEventListener("hashchange", applyHash);
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.addEventListener("click", () => setTab(b.dataset.tab)));
  document.querySelectorAll(".card.link").forEach((c) =>
    c.addEventListener("click", () => { hideTip(); setTab(c.dataset.goto); }));
  // サマリタイル行の上の i で脚注を開閉(常時表示にすると縦幅をとるため)
  $("#sum-kpi-info").addEventListener("click", (e) => {
    const note = $("#sum-kpi-note");
    note.hidden = !note.hidden;
    e.currentTarget.classList.toggle("on", !note.hidden);
  });

  // 情報鮮度モニタ
  // build出力の鮮度レポートに、「更新確認」(ack)と「通知オフ」(mute)を
  // 重ねて表示を決める。ackは確認日から期待間隔が過ぎたらまた警告に戻る。
  // 状態は data/uistate.toml に永続化(serve.py 配信下でのみ変更可能。
  // file:// では前回build時点のスナップショットを閲覧するだけ)
  const freshState = {
    ack: { ...(DATA.uistate || {}).ack },
    mute: { ...(DATA.uistate || {}).mute },
  };
  function freshTomlText() {
    const lines = [
      "# 鮮度モニタのUI状態(更新確認ack・通知オフmute。UIの操作で生成)",
      "", "[ack]",
    ];
    for (const [k, v] of Object.entries(freshState.ack))
      lines.push(`${JSON.stringify(k)} = ${JSON.stringify(v)}`);
    lines.push("", "[mute]");
    for (const [k, v] of Object.entries(freshState.mute))
      if (v) lines.push(`${JSON.stringify(k)} = true`);
    return lines.join("\n") + "\n";
  }
  async function saveFresh() {
    try {
      const res = await fetch("/api/uistate",
                              { method: "POST", body: freshTomlText() });
      if (!res.ok) throw new Error(await res.text());
    } catch (e) {
      alert("鮮度モニタ状態の保存に失敗しました:\n" + e.message);
    }
  }
  // localStorage時代(〜2026-07-19)の ack/mute を一度だけ取り込んで捨てる
  function migrateFreshLocal() {
    let old = null;
    try {
      old = JSON.parse(localStorage.getItem("kakeibo-freshness") || "null");
      localStorage.removeItem("kakeibo-freshness");
    } catch (e) { return; }
    if (!old) return;
    let changed = false;
    for (const [k, v] of Object.entries(old.ack || {}))
      if (!freshState.ack[k]) { freshState.ack[k] = v; changed = true; }
    for (const [k, v] of Object.entries(old.mute || {}))
      if (v && !freshState.mute[k]) { freshState.mute[k] = true; changed = true; }
    if (changed) saveFresh();
  }
  let showAllFresh = false;

  // 直近(基準日以前)の月次更新日。dayがその月にない場合は月末に丸める。
  // back=0(当月)が基準日より未来でも back=1(前月)の同日は必ず基準日
  // 以前になるため、2回のループで必ず return する
  function monthlyDue(baseIso, day) {
    const t = new Date(baseIso + "T00:00:00");
    for (let back = 0; back < 2; back++) {
      const y = t.getFullYear(), m = t.getMonth() - back;
      const d = new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));
      if (d <= t) return d;
    }
  }
  function freshRows() {
    const todayIso = KB.todayIso();
    return (DATA.freshness || []).map((r) => {
      // 「更新確認」した日も最終取込と同格に扱う(実データが増えなくても
      // サイトを見て変化なしを確認したなら、期待間隔ぶんは警告しない)
      const eff = [r.last, freshState.ack[r.account] || ""]
        .sort().pop() || "";
      const days = eff
        ? Math.floor((new Date(todayIso) - new Date(eff)) / 864e5) : null;
      let warn, stale, due = "", nextWarn = "";
      if (r.update_day) {
        // 月次更新日の宣言(給料日・カード確定日)は「直近の更新日以降の
        // 取込があるか」で判定(猶予なし)。2回続けて取り込まなかったら強調表示
        const dueD = monthlyDue(todayIso, r.update_day);
        const prevD = monthlyDue(
          KB.localIso(new Date(dueD.getTime() - 864e5)), r.update_day);
        due = KB.localIso(dueD);
        warn = !eff || eff < due;
        stale = !eff || eff < KB.localIso(prevD);
        // 放置すると(次に)警告が出る日: 警告中なら直近の更新日そのもの
        const y = dueD.getFullYear(), m = dueD.getMonth() + 1;
        nextWarn = warn ? due : KB.localIso(new Date(y, m,
          Math.min(r.update_day, new Date(y, m + 1, 0).getDate())));
      } else {
        warn = days === null || days > r.interval;
        stale = days === null || days > 2 * r.interval;
      }
      return { ...r, eff, effDays: days, warn, stale, due, nextWarn,
               muted: !!freshState.mute[r.account] };
    }).sort((a, b) =>
      (a.muted - b.muted) || (b.warn - a.warn) ||
      (b.effDays ?? 1e9) - (a.effDays ?? 1e9));
  }

  function renderFreshness() {
    const rows = freshRows();
    const active = rows.filter((r) => r.warn && !r.muted);
    const okChip = $("#ok-chip");
    const card = $("#warnings-card");
    card.style.display = "";
    okChip.style.display = active.length ? "none" : "";
    $("#warn-summary").textContent = active.length
      ? "⚠ 情報鮮度モニタ: 要更新 " + active.length + "件"
      : "✓ 情報鮮度モニタ: すべて期待間隔内";
    const box = $("#warnings");
    box.replaceChildren();
    const shown = showAllFresh ? rows : active;
    if (shown.length) {
      // 日付4列のヘッダ(グリッドは9列: ●・口座名・日付4列・操作3列)
      for (const h of ["", "", "明細末端", "取込", "経過", "次回目安",
                       "", "", ""]) {
        const s = document.createElement("span");
        s.className = "warn-h";
        s.textContent = h;
        box.appendChild(s);
      }
    }
    for (const r of shown) {
      const row = document.createElement("div");
      row.className = "warn-item" +
        (r.muted ? " muted" : r.warn ? (r.stale ? " stale" : "") : " fresh");
      const icon = document.createElement("span");
      icon.className = "icon";
      row.appendChild(icon);
      let nameEl;
      if (r.url) {
        nameEl = document.createElement("a");
        nameEl.href = r.url;
        nameEl.target = "_blank";
        nameEl.rel = "noopener";
      } else {
        nameEl = document.createElement("strong");
      }
      nameEl.textContent = r.name;
      row.appendChild(nameEl);
      // 意味の違う日付を4列に揃えて出す(ヘッダは renderFreshness 冒頭):
      //   明細末端(レコードの取引日) / 取込(DL・保存日。更新確認・カバー
      //   宣言もここ) / 経過(警告判定と同じ日数) / 次回(放置すると警告が出る日)
      const ack = freshState.ack[r.account] || "";
      const realEff = [r.data_end || "", r.imported || "", ack].sort().pop();
      const covered = !!r.cover_until && r.cover_until > realEff;
      if (r.effDays === null) {
        const c = document.createElement("span");
        c.className = "msg";
        c.textContent = "明細が一度も取り込まれていない";
        c.style.gridColumn = "3 / 7";
        row.appendChild(c);
      } else {
        // カバー中(確定済みの請求・支給月まで取込済み)の経過は構造的な
        // 遅れなので日数を出さない。次回はカバー末尾+期待間隔で安定させる
        // (r.eff は今日に丸まっていて基準にすると毎日ずれる)。
        // 月次更新日の口座は次回=次の更新日(freshRowsで計算済み)
        const dueBase = covered && r.cover_until > r.eff
          ? r.cover_until : r.eff;
        const due = new Date(dueBase + "T00:00:00");
        due.setDate(due.getDate() + r.interval);
        const vals = [
          r.data_end ? `〜${r.data_end}` : "—",
          covered ? `〜${r.cover_label}`
            : ack && ack >= (r.imported || "") ? `確認 ${ack}`
            : r.imported || "—",
          r.update_day && r.warn ? `⚠ ${r.due} 確定分が未取込`
            : covered ? "—"
            : r.warn ? `⚠ ${r.effDays}日前(期待${r.interval}日)`
            : `${r.effDays}日前`,
          // 「〜」は「この日までセーフ」の読み。月次更新日の口座は当日から
          // 即警告なので〜を付けず、警告が出る更新日そのものを出す
          r.update_day ? r.nextWarn : `〜${KB.localIso(due)}`,
        ];
        for (const v of vals) {
          const c = document.createElement("span");
          c.className = "msg";
          c.textContent = v;
          row.appendChild(c);
        }
        if (r.first && r.data_end)
          row.children[2].title =
            `取込済み範囲: ${r.first} 〜 ${r.data_end}`;
        if (covered)
          row.children[3].title =
            `${r.cover_label}分まで取込済み。` + (r.cover_note || "");
      }
      // 操作: 手順 / 更新確認 / 通知トグル。行はグリッドの9列を必ず埋める
      // (該当なしでも空セルを置く)ことで操作列の縦位置を揃える
      const howto = (ACCOUNTS[r.account] || {}).howto;
      let memo = null, memoFill = null;
      const howtoCell = document.createElement("span");
      if (howto) {
        howtoCell.className = "howto-btn";
        howtoCell.textContent = "手順";
        memo = document.createElement("div");
        memo.className = "howto-box";
        memo.textContent = howto;
        memo.style.display = "none";
        // 手順ボックスは状態カラムまでの3列ぶんに畳む。残り3列は
        // フィラーで埋めてグリッドの自動配置(列位置)を崩さない
        memoFill = document.createElement("span");
        memoFill.className = "howto-fill";
        memoFill.style.display = "none";
        howtoCell.addEventListener("click", () => {
          const show = memo.style.display === "none";
          memo.style.display = memoFill.style.display = show ? "" : "none";
        });
      }
      row.appendChild(howtoCell);
      const ackCell = document.createElement("span");
      if (r.warn && !r.muted) {
        ackCell.className = "howto-btn";
        ackCell.textContent = "更新確認";
        if (KB.OVR_SRV) {
          ackCell.title = "サイトを確認して新しい明細がなかった場合に。" +
            (r.update_day ? "次の月次更新日まで警告を止める"
              : "今日から期待間隔ぶん警告を止める");
          ackCell.addEventListener("click", () => {
            freshState.ack[r.account] = KB.todayIso();
            saveFresh();
            renderFreshness();
          });
        } else {
          ackCell.classList.add("off");
          ackCell.title = "変更は python3 serve.py で開いたときのみ";
        }
      }
      row.appendChild(ackCell);
      const mute = document.createElement("label");
      mute.className = "switch sm";
      mute.title = !KB.OVR_SRV ? "変更は python3 serve.py で開いたときのみ"
        : r.muted ? "通知オフ中(クリックでオン)" : "通知オン(クリックでオフ)";
      const muteInput = document.createElement("input");
      muteInput.type = "checkbox";
      muteInput.checked = !r.muted;
      muteInput.disabled = !KB.OVR_SRV;
      muteInput.addEventListener("change", () => {
        freshState.mute[r.account] = !muteInput.checked;
        // 通知を切るなら「更新確認」の効力も一緒に取り消す
        if (!muteInput.checked) delete freshState.ack[r.account];
        saveFresh();
        renderFreshness();
      });
      mute.append(muteInput, document.createElement("i"));
      row.appendChild(mute);
      box.appendChild(row);
      if (memo) box.append(memo, memoFill);
    }
    // さらに展開: 鮮度のいい口座・通知オフの口座も表示
    const more = document.createElement("div");
    more.className = "howto-btn more-btn";
    more.textContent = showAllFresh
      ? "▲ 要更新のみ表示" : "▼ すべての監視口座を表示";
    more.addEventListener("click", () => {
      showAllFresh = !showAllFresh;
      renderFreshness();
    });
    box.appendChild(more);
  }
  renderFreshness();

  // グローバル設定UI
  function syncGlobalsUI() {
    document.querySelectorAll("#income-mode button").forEach((b) =>
      b.classList.toggle("on", b.dataset.mode === state.incomeMode));
    document.querySelectorAll("#osc-mode button").forEach((b) =>
      b.classList.toggle("on", b.dataset.m === state.osc));
    $("#g-hide-transfer").checked = state.hideTransfer;
  }
  document.querySelectorAll("#income-mode button").forEach((b) =>
    b.addEventListener("click", () => {
      state.incomeMode = b.dataset.mode;
      saveGlobals(); syncGlobalsUI(); renderAll();
    }));
  document.querySelectorAll("#osc-mode button").forEach((b) =>
    b.addEventListener("click", () => {
      state.osc = b.dataset.m;
      saveGlobals(); syncGlobalsUI(); render();
    }));
  $("#g-hide-transfer").addEventListener("change", (e) => {
    state.hideTransfer = e.target.checked;
    saveGlobals(); render();
  });

  // フィルタUI
  (function buildFilters() {
    const seg = $("#period-seg");
    for (const [label, m] of PRESETS) {
      const b = document.createElement("button");
      b.textContent = label;
      b.dataset.months = m;
      if (m === state.months) b.classList.add("on");
      b.addEventListener("click", () => {
        state.months = m;
        seg.querySelectorAll("button").forEach((x) => x.classList.remove("on"));
        b.classList.add("on");
        render();
      });
      seg.appendChild(b);
    }
    const accSel = $("#f-account");
    for (const [id, a] of Object.entries(ACCOUNTS)) {
      if (!TXNS.some((t) => t.account === id)) continue;
      const o = document.createElement("option");
      o.value = id;
      o.textContent = a.name;
      accSel.appendChild(o);
    }
    accSel.addEventListener("change", () => { state.account = accSel.value; render(); });
    // カテゴリは中分類(rules.toml の category_groups)で optgroup に束ねる。
    // カテゴリ名だけの平坦な一覧はどの中分類に属するかが読めない
    const catSel = $("#f-category");
    const byGroup = new Map();
    for (const c of [...new Set(TXNS.map((t) => t.category))].filter(Boolean).sort()) {
      const g = catGroup(c);
      if (!byGroup.has(g)) byGroup.set(g, []);
      byGroup.get(g).push(c);
    }
    const gOrder = [...Object.keys(CAT_GROUPS), "その他"];
    for (const g of [...byGroup.keys()]
           .sort((a, b) => gOrder.indexOf(a) - gOrder.indexOf(b))) {
      const og = document.createElement("optgroup");
      og.label = g;
      for (const c of byGroup.get(g)) {
        const o = document.createElement("option");
        o.value = c;
        o.textContent = c;
        og.appendChild(o);
      }
      catSel.appendChild(og);
    }
    catSel.addEventListener("change", () => { state.category = catSel.value; render(); });
    $("#f-search").addEventListener("input", (e) => { state.search = e.target.value; render(); });
    $("#f-override").addEventListener("change", (e) => {
      state.fOverride = e.target.checked; render();
    });
    $("#f-comment").addEventListener("change", (e) => {
      state.fComment = e.target.checked; render();
    });
    $("#f-unmatched").addEventListener("change", (e) => {
      state.fUnmatched = e.target.checked; render();
    });
  })();

  // フィルタUIを state に合わせ直す(state を直接動かす導線のあと始末)
  function syncFilterUI() {
    $("#period-seg").querySelectorAll("button").forEach((b) =>
      b.classList.toggle("on", Number(b.dataset.months) === state.months));
    $("#f-account").value = state.account;
    $("#f-category").value = state.category;
    $("#f-search").value = state.search;
    $("#f-override").checked = state.fOverride;
    $("#f-comment").checked = state.fComment;
    $("#f-unmatched").checked = state.fUnmatched;
  }
  // 摘要で明細タブへ飛ぶ(未分類ランキング等)。対象が現在の絞り込みの
  // 外にいると「クリックしたのに何も出ない」になるため、期間を含む
  // 絞り込みを全部解除してから検索し直す。振替の表示可否(hideTransfer)は
  // ユーザーの永続設定なので触らない
  function jumpToSearch(key) {
    hideTip();
    state.months = 0;
    state.account = "";
    state.category = "";
    state.search = key;
    state.fOverride = false;
    state.fComment = false;
    state.fUnmatched = false;
    syncFilterUI();
    setTab("ledger");
    render();
  }

  // 月詳細モーダル
  // 月次収支・貯蓄率・推移などの棒をクリックすると、その月の収入と支出を
  // 列挙・分析するポップアップを開く(口座・カテゴリ・検索フィルタは引き継ぐ)
  function closeModal() {
    $("#modal-bg").style.display = "none";
  }
  $("#modal-close").addEventListener("click", closeModal);
  $("#modal-bg").addEventListener("click", (e) => {
    if (e.target === $("#modal-bg")) closeModal();
  });
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  // 前年同月比の支出/収入トグル
  for (const b of document.querySelectorAll("#yoy-mode button")) {
    b.addEventListener("click", () => {
      $("#yoy-mode button.on").classList.remove("on");
      b.classList.add("on");
      KB.renderYoY();
    });
  }
  // 資金の流れの 収支/口座間 トグル
  for (const b of document.querySelectorAll("#flow-mode button")) {
    b.addEventListener("click", () => {
      $("#flow-mode button.on").classList.remove("on");
      b.classList.add("on");
      state.flowMode = b.dataset.fm;
      KB.renderMoneyFlow();
    });
  }

  // 概要タイル「当月暫定収支」の見込み内訳(当月の月詳細のみ)。
  // タイルの数字は判明分でなく見込み合成値なので、クリックで来た人が
  // 「各項が予定・判明のどちらで立ったか」をここで追えるようにする
  function renderProvBreakdown(m) {
    const box = $("#modal-prov");
    if (m !== curMonth) { box.style.display = "none"; return; }
    box.replaceChildren();
    box.style.display = "";
    const p = KB.provisionalNet();
    const h = document.createElement("h3");
    h.textContent = "当月暫定収支(着地見込み)の内訳";
    box.appendChild(h);
    const row = (label, value, sub, cls) => {
      const r = document.createElement("div");
      r.className = "prov-row" + (cls ? " " + cls : "");
      const l = document.createElement("span");
      l.className = "l";
      l.textContent = label;
      const s = document.createElement("span");
      s.className = "s";
      s.textContent = sub;
      const a = document.createElement("span");
      a.className = "a";
      a.textContent = value;
      r.append(l, s, a);
      box.appendChild(r);
      return r;
    };
    const vs = (known, base, baseName) => known >= base
      ? `判明 ${cYen(known)} ≥ ${baseName} ${cYen(base)} → 判明を採用`
      : `判明 ${cYen(known)} < ${baseName} ${cYen(base)} → ${baseName}を採用`;
    row("収入予定", fmt(p.incomeEst), vs(p.incKnown, p.incBase, "3ヶ月中央値"));
    const fx = row("固定費予定", "−" + fmt(p.fixedEst),
                   "定期宣言(現役)の月額合算。クリックで一覧へ", "link");
    fx.title = "収支タブの定期支出カードへ";
    fx.addEventListener("click", () => {
      closeModal();
      setTab("flow");
      requestAnimationFrame(() => {
        const el = $("#subs-card");
        if (el) el.scrollIntoView({ block: "start", behavior: "smooth" });
      });
    });
    row("変動費見込み", "−" + fmt(p.varEst), vs(p.varKnown, p.varBase, "平常ペース"));
    row("暫定収支", sfmt(p.net), "", p.net >= 0 ? "pos" : "neg");
    note(box, "上の収支(判明分)と違い、未着のカード請求等を平常ペースで見込んだ着地予想。平常ペース=当月・先月を除く6ヶ月の変動費平均。");
  }

  function openMonthDetail(m) {
    hideTip();
    const scope = filteredNoPeriod().filter((t) => t.date.slice(0, 7) === m);
    $("#modal-title").textContent = m + " の収支";
    // モーダルの器は口座間ネットワークの詳細(tab-flow.js)と共用のため、
    // 見出しを月詳細の既定に戻す
    $("#modal-h-left").textContent = "収入";
    $("#modal-h-right").textContent = "支出の内訳(クリックで展開)";
    // KPI
    let inc = 0, exp = 0;
    for (const t of scope) {
      const e = effective(t);
      if (e.type === "income") inc += e.amount;
      else if (e.type === "expense") exp += -e.amount;
    }
    const kpis = $("#modal-kpis");
    kpis.replaceChildren();
    renderProvBreakdown(m);
    mkTile(kpis, "収入", fmt(inc), "", "small");
    mkTile(kpis, "支出", fmt(exp), "", "small");
    mkTile(kpis, "収支", sfmt(inc - exp), "", "small " + (inc >= exp ? "pos" : "neg"));
    mkTile(kpis, "貯蓄率", inc > 0 ? ((inc - exp) / inc * 100).toFixed(1) + "%" : "—",
           "", "small");
    // 収入の列挙(クリックで明細タブへ)
    const incBox = $("#modal-income");
    incBox.replaceChildren();
    const incTx = scope.map((t) => [t, effective(t)])
      .filter(([, e]) => e.type === "income" && e.amount !== 0)
      .sort((a, b) => b[1].amount - a[1].amount);
    if (!incTx.length) note(incBox, "収入がありません");
    for (const [t, e] of incTx.slice(0, 60)) {
      const row = document.createElement("div");
      row.className = "inc-row";
      row.title = "クリックで明細タブの該当レコードへ";
      const d = document.createElement("span");
      d.className = "d";
      d.textContent = t.date;
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = t.description;
      const a = document.createElement("span");
      a.className = "a" + (e.amount < 0 ? " neg" : "");
      a.textContent = sfmt(e.amount);
      row.append(d, nm, a);
      row.addEventListener("click", () => {
        closeModal();
        state.focusTxn = t.id;
        setTab("ledger");
        renderTable(filteredNoPeriod());
      });
      incBox.appendChild(row);
    }
    if (incTx.length > 60) note(incBox, `他${incTx.length - 60}件は明細タブで`);
    // 支出のドリルダウン(共通コンポーネント)
    renderDrilldown(scope, $("#modal-drill"));
    $("#modal-bg").style.display = "";
  }

  // タイルは6枚固定(純資産・先々月収支実績・当月暫定収支・貯蓄率・
  // 生活防衛資金・運用効率)。sub は1行に収め、前提の説明は下の脚注に
  // 集約する(タイルごとの長文注記で読ませない)。計算は stats.js。
  function renderSummary() {
    const box = $("#sum-kpis");
    box.replaceChildren();
    const MT = monthlyTotals(TXNS);
    const man = (v) => Math.round(v / 1e4) + "万";
    const scYen = (v) => (v < 0 ? "−" : "+") + cYen(Math.abs(v));
    // 式の sub: 折返しは項の間(通常スペース)でだけ起こす。項内の空白は
    // NBSP に変えて「演算子+項」をひと塊に保つ(CSS 側の keep-all とペア)
    const terms = (...ts) => ts.map((s) => s.replace(/ /g, " ")).join(" ");
    // タイルのクリックで専門タブの該当カードへ飛ぶ。月単位のタイル
    // (実績・当月)はタブでなく月詳細モーダル(内訳ドリルダウン)を開く
    const link = (tile, title, fn) => {
      tile.classList.add("link");
      tile.title = title;
      tile.addEventListener("click", fn);
    };
    const gotoCard = (tab, sel) => {
      hideTip();
      setTab(tab);
      // タブが可視になってからでないと座標が取れない
      requestAnimationFrame(() => {
        const el = $(sel);
        if (el) (el.closest(".card") || el)
          .scrollIntoView({ block: "start", behavior: "smooth" });
      });
    };
    // 純資産(判明分の合成)
    let nwSub = COMP.newest
      ? "時点 " + (COMP.oldest === COMP.newest
          ? COMP.newest : COMP.oldest + "〜" + COMP.newest)
      : "残高データなし";
    if (NW.length >= 2) {
      // 負の差は会計流の ▲ で示す(タイル値の赤とは別に、subでも一目で)
      const d = NW[NW.length - 1].total - NW[NW.length - 2].total;
      nwSub = "対前月差 " + (d < 0 ? "▲" + fmt(-d) : sfmt(d));
    }
    link(mkTile(box, "純資産", COMP.newest ? fmt(COMP.net) : "—",
                nwSub, COMP.net < 0 ? "neg" : ""),
         "資産タブの純資産推移へ", () => gotoCard("assets", "#as-networth"));
    // 先々月収支実績。先月はカード明細(請求確定時にまとめて届く)がまだ
    // 揃わず数字が動くため、実績としてはほぼ確定する先々月を見せる
    const prev2 = shiftMonth(curMonth, -2);
    const pInc = MT.inc.get(prev2) || 0, pExp = MT.exp.get(prev2) || 0;
    link(mkTile(box, `先々月収支実績(${monthLabel(prev2)})`, sfmt(pInc - pExp),
                terms(`収入 ${cYen(pInc)}`, `−支出 ${cYen(pExp)}`),
                pInc >= pExp ? "pos" : "neg"),
         `${monthLabel(prev2)}の内訳(月詳細)を開く`,
         () => openMonthDetail(prev2));
    // 当月暫定収支(推定込みの着地見込み。式の前提は脚注)
    const prov = KB.provisionalNet();
    link(mkTile(box, `当月暫定収支(${monthLabel(curMonth)})`, sfmt(prov.net),
                terms(`収入${man(prov.incomeEst)}`, `−固定${man(prov.fixedEst)}`,
                      `−変動${man(prov.varEst)}`),
                prov.net >= 0 ? "pos" : "neg"),
         `${monthLabel(curMonth)}の判明分の内訳(月詳細)を開く`,
         () => openMonthDetail(curMonth));
    // 貯蓄率(確定6ヶ月合算)。窓は賞与サイクル(年2回=約6ヶ月間隔)に
    // 合わせて6ヶ月。7〜8ヶ月にすると賞与を1回含む時期と2回含む時期が
    // 交互に来て値が揺れるため、賞与半サイクルの6が最も安定して応答も速い。
    // 当月・先月は支出が構造的に過小(カード請求ラグ)で貯蓄率が上振れる
    // ため窓に入れない(実績タイルを先々月にしたのと同じ理屈)。
    const done6 = months.filter((m) => m <= prev2).slice(-6);
    const sInc = done6.reduce((s, m) => s + (MT.inc.get(m) || 0), 0);
    const sExp = done6.reduce((s, m) => s + (MT.exp.get(m) || 0), 0);
    link(mkTile(box, "貯蓄率(6ヶ月)",
                sInc > 0 ? ((sInc - sExp) / sInc * 100).toFixed(0) + "%" : "—",
                terms(`収支 ${scYen(sInc - sExp)}`, `÷ 収入 ${cYen(sInc)}`),
                sInc > 0 && sInc < sExp ? "neg" : ""),
         "収支タブの貯蓄率へ", () => gotoCard("flow", "#savings-chart"));
    // 生活防衛資金
    let liquid = 0, hasLiquid = false;
    for (const [id, b] of Object.entries(BALS)) {
      const a = ACCOUNTS[id];
      if (a && a.kind === "asset" && LIQUID_GROUPS.has(a.group)) {
        liquid += b.balance;
        hasLiquid = true;
      }
    }
    const avgExp = done6.length ? sExp / done6.length : 0;
    {
      let defTile;
      if (hasLiquid && avgExp > 0) {
        const cover = liquid / avgExp;
        // 3ヶ月未満=赤 / 3〜6ヶ月=黄 / 6ヶ月以上=緑
        const cls = cover >= 6 ? "pos" : cover >= 3 ? "warn" : "neg";
        defTile = mkTile(box, "生活防衛資金", cover.toFixed(1) + "ヶ月",
                         terms(`流動 ${cYen(liquid)}`,
                               `÷ 支出 ${cYen(avgExp)}/月`), cls);
      } else {
        defTile = mkTile(box, "生活防衛資金", "—",
                         "残高または支出データ不足", "");
      }
      link(defTile, "資産タブの口座と残高へ",
           () => gotoCard("assets", "#accounts-table"));
    }
    // 運用効率(資産全体)。全期間と直近6ヶ月の年率を左右に併記する。
    // 全期=履歴全体の平均的な働き、6ヶ月=今のペース。計算は金額加重
    // (運用益 ÷ 期間平均総資産 ÷ 年数。stats.js yieldStats)
    {
      const tile = document.createElement("div");
      tile.className = "tile";
      const tl = document.createElement("div");
      tl.className = "label";
      tl.textContent = "運用効率(年率換算)";
      const row = document.createElement("div");
      row.className = "split";
      const cell = (y, name) => {
        const c = document.createElement("div");
        const v = document.createElement("div");
        const ok = y && y.annual != null;
        v.className = "value" + (ok && y.gain < 0 ? " neg"
                                 : ok && y.gain > 0 ? " pos" : "");
        v.textContent = ok
          ? (y.annual >= 0 ? "+" : "−")
            + (Math.abs(y.annual) * 100).toFixed(1) + "%" : "—";
        const s = document.createElement("div");
        s.className = "sub";
        s.textContent = name;
        c.append(v, s);
        return c;
      };
      const yAll = KB.yieldStats(), y6 = KB.yieldStats(6);
      row.append(cell(yAll, "全期"), cell(y6, "6ヶ月"));
      // 損益の実額(全期のみ。2行にすると6枚横並び時に縦がはみ出す)
      const gains = document.createElement("div");
      gains.className = "sub split-gains";
      gains.textContent = "全期損益: " + (yAll ? sfmt(yAll.gain) : "—");
      tile.append(tl, row, gains);
      box.appendChild(tile);
      link(tile, "資産タブの運用カードへ", () => gotoCard("assets", "#yield-card"));
    }
    // 前提の脚注(タイル横断で1回だけ。行の上の i ボタンで開閉)
    KB.noteLines($("#sum-kpi-note"), [
      "当月・先月を除く直近6ヶ月実績を収支の平常値・予定値として採用。",
      "当月暫定収支 = 収入予定 − 固定費予定 − 変動費(予定値と当月既知値の大きいほう)。",
      "運用効率 = (利息・配当 + DC・証券の評価損益等)÷ 期間平均総資産 の年率換算(金額加重)。",
    ]);

    drawCompBar($("#sum-comp"));
    drawNetWorth($("#sum-networth"), 240);
    drawMonthly($("#sum-monthly"), months.slice(-12), TXNS, { h: 190, yoyMap: MT.exp });
    drawOscillo($("#sum-osc"), months.slice(-6), TXNS, "cash", 190, 460);
    // 直近30日(最終明細日基準)。暦月だと月初はデータが揃わず少なく見えるため
    const lastDate = TXNS.length ? TXNS[TXNS.length - 1].date : "";
    const cut = new Date(lastDate + "T00:00:00");
    cut.setDate(cut.getDate() - 29);
    const cutIso = KB.localIso(cut);
    drawCatBars($("#sum-top"),
      expenseItems(TXNS.filter((t) => t.date >= cutIso), 7),
      { rowH: 24 });
  }

  // render(): フィルタ・トグルに反応する部分(収支・明細・サマリ)
  // renderAll(): 上記+収入モードの影響を受けない資産系も含む初期化用
  function render() {
    const txns = filtered();
    const yoyMap = new Map();
    for (const t of filteredNoPeriod()) {
      const e = effective(t);
      if (e.type !== "expense") continue;
      const m = t.date.slice(0, 7);
      yoyMap.set(m, (yoyMap.get(m) || 0) - e.amount);
    }
    renderKpis(txns);
    drawOscillo($("#osc-chart"), periodMonths(), txns, state.osc, 280, 920);
    $("#osc-note").textContent = state.osc === "cash"
      ? "口座収支: 資産口座の入出金の累積。振替・カード引落を含むため、月内の口座残高の動きを描画する"
      : "実質収支: 振替・調整を除いた、収入−支出の累積(対外的な収支)。カード利用は利用日、給与明細は手取りの振込日に計上される";
    drawMonthly($("#monthly-chart"), periodMonths(), txns, { yoyMap });
    renderDrilldown(txns);
    renderTrend(txns);
    renderSavings(txns);
    renderSubs(txns);
    KB.renderMoneyFlow();
    KB.renderYoY();
    KB.renderHeatmap(txns);
    KB.renderYear();   // 年次タブは収入モードにのみ追従(フィルタ非依存)
    renderTable(txns);
    renderSummary();
  }
  // 引落予定(サマリ)
  // build が出した「確定済みだが未引落の請求」。カードは利用日から請求確定まで
  // 遅れるため、これは請求が立った分だけの予定(直近の利用は含まない)。
  // 計画タブの資金繰り予測が同じ請求を将来投影に使うのに対し、こちらは
  // 「開いてすぐ見える直近の引落」として粒度を変えて置いている
  function renderUpcoming() {
    const list = DATA.upcoming || [];
    const card = $("#upcoming-card");
    card.style.display = list.length ? "" : "none";
    if (!list.length) return;
    const box = $("#upcoming-list");
    box.replaceChildren();
    const today = KB.todayIso();
    let total = 0;
    for (const u of list) {
      total += u.amount;
      const days = Math.round(
        (new Date(u.date + "T00:00:00") - new Date(today + "T00:00:00")) / 864e5);
      const row = document.createElement("div");
      row.className = "due-row" + (days <= 7 ? " soon" : "");
      const d = document.createElement("span");
      d.className = "d";
      d.textContent = u.date;
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = ACCOUNTS[u.account] ? ACCOUNTS[u.account].name : u.account;
      const inEl = document.createElement("span");
      inEl.className = "in";
      inEl.textContent = days <= 0 ? "本日" : `あと${days}日`;
      const a = document.createElement("span");
      a.className = "a";
      a.textContent = fmt(u.amount);
      row.append(d, nm, inEl, a);
      box.appendChild(row);
    }
    if (list.length > 1) {
      const row = document.createElement("div");
      row.className = "due-row total";
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = `合計 ${list.length}件`;
      const a = document.createElement("span");
      a.className = "a";
      a.textContent = fmt(total);
      row.append(nm, a);
      box.appendChild(row);
    }
  }

  function renderAll() {
    renderAssetKpis();
    drawCompBar($("#as-comp"));
    renderAccounts();
    renderDc();
    drawNetWorth($("#as-networth"), 360);
    KB.renderYield();
    KB.renderRisk();
    renderInvest();
    renderSalaryTab();
    KB.renderPlan();
    renderUpcoming();
    KB.renderUncategorized();
    render();
  }

  $("#generated").textContent = "生成: " + DATA.generated_at;
  loadGlobals();
  syncGlobalsUI();
  setupBuildLog();
  KB.setupPlan();
  renderAll();
  applyHash();
  // 取込・再ビルド後のリロードで振り分け結果を見せる
  const buildNote = sessionStorage.getItem("kakeibo-build-note");
  if (buildNote !== null) {
    sessionStorage.removeItem("kakeibo-build-note");
    showToast(buildNote || "再ビルドしました");
  }
  // 上書き保存後のリロードで編集したレコードに戻る
  const focusAfterSave = sessionStorage.getItem("kakeibo-focus-txn");
  if (focusAfterSave) {
    sessionStorage.removeItem("kakeibo-focus-txn");
    state.focusTxn = focusAfterSave;
    setTab("ledger");
    renderTable(filteredNoPeriod());
  }

  Object.assign(KB, {
    setTab, syncGlobalsUI, syncFilterUI, jumpToSearch,
    closeModal, openMonthDetail, render, renderAll,
  });
})();
