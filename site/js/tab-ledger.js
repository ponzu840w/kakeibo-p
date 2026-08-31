"use strict";
// tab-ledger.js: 明細タブ(全取引テーブル・行詳細・手動上書きの保存)。
(function () {
  const KB = window.KB;
  const { $, TXNS, ACCOUNTS, TX_BY_ID, OVR_BY_ID, CAT_GROUPS, CAT_GROUP_OF,
          catGroup, state, fmt } = KB;

  // 中分類の色見本(チャートの中分類色と同じ割当)。カテゴリ名だけでは
  // どの中分類かが読めないので、カテゴリを単体で見せる場所に添える
  function catSwatch(group) {
    const sw = document.createElement("span");
    sw.className = "cat-sw";
    sw.style.background = KB.catGroupColor(group);
    return sw;
  }
  // カテゴリ候補を中分類ごとに束ねる。並びは rules.toml の宣言順
  // (= 中分類色 --cat1〜9 の割当順)。未登録カテゴリは「その他」に寄る
  function catOptionGroups() {
    const groups = [];
    const idx = new Map();
    const add = (g, c) => {
      let e = idx.get(g);
      if (!e) {
        e = { group: g, cats: [] };
        idx.set(g, e);
        groups.push(e);
      }
      if (!e.cats.includes(c)) e.cats.push(c);
    };
    for (const [g, cats] of Object.entries(CAT_GROUPS)) for (const c of cats) add(g, c);
    for (const c of [...new Set(TXNS.map((t) => t.category))].filter(Boolean).sort()) {
      if (!CAT_GROUP_OF.has(c)) add("その他", c);
    }
    return groups;
  }

  // 開いているカテゴリ選択は常に1つ。外側クリックと Escape で閉じる
  let openPick = null;
  document.addEventListener("pointerdown", (e) => {
    if (openPick && !openPick.el.contains(e.target)) openPick.close();
  }, true);
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && openPick) openPick.close();
  });
  // メニューは position:fixed(テーブルの overflow に切られないため)なので、
  // スクロール・リサイズのたびに置き直す(画面外に出たら閉じる)
  const repos = () => { if (openPick) openPick.place(); };
  window.addEventListener("scroll", repos, true);
  window.addEventListener("resize", repos);

  // カテゴリ選択(明細の上書きUI)。
  // 既存カテゴリからの選択が主。新規カテゴリの作成ボタンは常に最下部に
  // 見えているが、絞り込み文字列が既存のどれにも一致しないときだけ
  // 活性化する。誤タイプで増えた未知のカテゴリは rules.toml の
  // category_groups に無いため中分類チャートで「その他」に落ちる
  // (= 静かに壊れる)ので、「選ぶ」と「作る」を別の操作に分ける。
  // 戻り値は .txn-edit にそのまま置ける要素で、選択値は getValue() で読む
  function catPicker(initial, canClear) {
    const opts = catOptionGroups();
    const known = new Set(opts.flatMap((g) => g.cats));
    let value = initial || "";

    const el = document.createElement("span");
    el.className = "catpick";
    const cur = document.createElement("button");
    cur.type = "button";
    cur.className = "catpick-cur";
    const menu = document.createElement("div");
    menu.className = "catpick-menu";
    menu.hidden = true;
    const q = document.createElement("input");
    q.className = "catpick-q";
    q.placeholder = "カテゴリを絞り込み";
    const list = document.createElement("div");
    list.className = "catpick-opts";
    const newBox = document.createElement("div");
    newBox.className = "catpick-new";
    menu.append(q, list, newBox);
    el.append(cur, menu);
    el.getValue = () => value;

    function renderCur() {
      cur.replaceChildren();
      const nm = document.createElement("span");
      nm.className = "nm";
      const grp = document.createElement("span");
      grp.className = "catpick-grp-label";
      if (!value) {
        nm.textContent = "(上書きなし)";
        nm.classList.add("empty");
      } else {
        cur.appendChild(catSwatch(catGroup(value)));
        nm.textContent = value;
        if (known.has(value)) {
          grp.textContent = catGroup(value);
        } else {
          grp.textContent = "新規・中分類未登録";
          grp.classList.add("new");
        }
      }
      const chev = document.createElement("span");
      chev.className = "catpick-chev";
      chev.textContent = "▾";
      cur.append(nm, grp, chev);
    }
    function pick(v) {
      value = v;
      renderCur();
      close();
    }
    function renderOpts() {
      const raw = q.value.trim();
      const needle = raw.toLowerCase();
      list.replaceChildren();
      let hits = 0;
      if (canClear && !needle) {
        const row = document.createElement("div");
        row.className = "catpick-opt clear";
        row.textContent = "上書きを解除(ルールの分類に戻す)";
        row.addEventListener("click", () => pick(""));
        list.appendChild(row);
      }
      for (const g of opts) {
        const cats = g.cats.filter((c) => !needle || c.toLowerCase().includes(needle));
        if (!cats.length) continue;
        const h = document.createElement("div");
        h.className = "catpick-grp";
        h.append(catSwatch(g.group), document.createTextNode(g.group));
        list.appendChild(h);
        for (const c of cats) {
          hits++;
          const row = document.createElement("div");
          row.className = "catpick-opt" + (c === value ? " on" : "");
          row.append(catSwatch(g.group), document.createTextNode(c));
          row.addEventListener("click", () => pick(c));
          list.appendChild(row);
        }
      }
      newBox.replaceChildren();
      const b = document.createElement("button");
      b.type = "button";
      b.className = "catpick-mk";
      if (raw && !known.has(raw)) {
        b.textContent = `「${raw}」を新規カテゴリとして作成`;
        b.addEventListener("click", () => pick(raw));
        const w = document.createElement("div");
        w.className = "warn";
        w.textContent = "新規カテゴリは中分類「その他」となる。rules.toml の [category_groups] に追記で更新可能";
        newBox.append(b, w);
      } else {
        // 既存名と一致(またはラッチ前の空欄)の間は押せない案内板として置く
        b.textContent = "新規カテゴリとして作成(名前を上の欄に入力)";
        b.disabled = true;
        newBox.appendChild(b);
        if (!hits) {
          const w = document.createElement("div");
          w.className = "warn";
          w.textContent = "一致するカテゴリがありません";
          newBox.appendChild(w);
        }
      }
    }
    function place() {
      const r = cur.getBoundingClientRect();
      const pad = 8;
      if (r.bottom < 0 || r.top > innerHeight) { close(); return; }
      const below = innerHeight - r.bottom - pad;
      const above = r.top - pad;
      const up = below < 240 && above > below;
      // 高さは画面に収まる限り制限しない(候補が少ないときは中身に合わせて縮む)
      menu.style.maxHeight = Math.max(180, up ? above : below) + "px";
      const w = Math.min(340, innerWidth - pad * 2);
      menu.style.width = w + "px";
      menu.style.left = Math.round(
        Math.max(pad, Math.min(r.left, innerWidth - w - pad))) + "px";
      menu.style.top = up ? "" : Math.round(r.bottom + 4) + "px";
      menu.style.bottom = up ? Math.round(innerHeight - r.top + 4) + "px" : "";
    }
    function close() {
      menu.hidden = true;
      if (openPick === api) openPick = null;
    }
    function open() {
      if (openPick) openPick.close();
      q.value = "";
      renderOpts();
      menu.hidden = false;
      openPick = api;
      place();
      q.focus({ preventScroll: true });
    }
    const api = { el, close, place };
    cur.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (menu.hidden) open(); else close();
    });
    q.addEventListener("input", () => { renderOpts(); place(); });
    q.addEventListener("keydown", (ev) => {
      // Enter は「候補の確定」だけに使う。新規作成は専用ボタン経由に限る
      if (ev.key !== "Enter") return;
      ev.preventDefault();
      const first = list.querySelector(".catpick-opt:not(.clear)");
      if (first) first.click();
    });
    renderCur();
    return el;
  }

  // 手動上書き(カテゴリ・コメント)の保存
  // serve.py 配信下でのみ編集できる。明細タブの詳細展開の「保存」が
  // data/overrides.toml への書込→build→リロードまで一気に行う。
  // file:// で開いた場合は編集フォームを無効化(閲覧専用)する。
  // 有効かどうかは KB.OVR_SRV(main.js の /api/ping 確認後に true になる、
  // ライブ参照が必要な可変フラグなので destructure しない)。
  function ovrTomlText(edits) {
    const merged = new Map(OVR_BY_ID);
    for (const [id, o] of Object.entries(edits)) {
      if (o) merged.set(id, o);
      else merged.delete(id);
    }
    const lines = [
      "# 取引レコード単位の手動上書き(明細タブの編集で生成)",
      "# build.py がレコードIDで突合して分類ルールの後から適用する",
    ];
    for (const [id, o] of merged) {
      const t = TX_BY_ID.get(id);
      lines.push("");
      lines.push(t
        ? `# ${t.date} ${ACCOUNTS[t.account] ? ACCOUNTS[t.account].name : t.account} ${t.description} ${fmt(t.amount)}`
        : "# (現在の取込データに該当レコードなし)");
      lines.push("[[override]]");
      lines.push(`id = ${JSON.stringify(id)}`);
      if (o.category) lines.push(`category = ${JSON.stringify(o.category)}`);
      if (o.comment) lines.push(`comment = ${JSON.stringify(o.comment)}`);
    }
    return lines.join("\n") + "\n";
  }
  // 1レコード分の上書きを保存(entry=nullで上書き削除)して再ビルド
  async function saveOverride(id, entry, btn) {
    const label = btn.textContent;
    btn.disabled = true;
    btn.textContent = "保存して再ビルド中…";
    try {
      const res = await fetch("/api/overrides",
        { method: "POST", body: ovrTomlText({ [id]: entry }) });
      const text = await res.text();
      if (!res.ok) throw new Error(text);
      sessionStorage.setItem("kakeibo-focus-txn", id);
      location.reload();   // 新しい data.js で描き直す
    } catch (e) {
      alert("保存に失敗しました:\n" + e.message);
      btn.disabled = false;
      btn.textContent = label;
    }
  }
  // 行クリックで詳細(分類根拠・原文・ソース等)を展開する。
  // ドリルダウンからのジャンプ(state.focusTxn)はハイライト+詳細を開く
  function txnDetailRow(t) {
    const tr = document.createElement("tr");
    tr.className = "txn-detail";
    const td = document.createElement("td");
    td.colSpan = 5;
    const parts = [];
    if (t.rule) parts.push(["根拠", t.rule]);
    if (t.type === "transfer") {
      const c = ACCOUNTS[t.counter] ? ACCOUNTS[t.counter].name : t.counter;
      parts.push(["振替", c + (t.pair ? "(相手側の明細と突合済)" : "(相手側の明細なし)")]);
    }
    if (t.raw_description && t.raw_description !== t.description) {
      // ルールの pattern は正規化済み摘要に評価される。原文(中点・半角カナ
      // 入り)をコピーしてルールに書くと一致しない事故が実際にあったため
      // (「コナカ・フタタ」)、原文の隣で注意を出す
      parts.push(["原文",
        t.raw_description + "(ルールに書くときは表の摘要=正規化済み表記を使う)"]);
    }
    if (t.memo) parts.push(["メモ", t.memo]);
    parts.push(["ソース", t.source]);
    if (t.native_id) parts.push(["ID", t.native_id]);
    parts.push(["レコードID", t.id]);
    for (const [k, v] of parts) {
      const item = document.createElement("span");
      item.className = "item";
      const key = document.createElement("span");
      key.className = "k";
      key.textContent = k;
      item.appendChild(key);
      item.appendChild(document.createTextNode(v));
      td.appendChild(item);
    }
    // 編集: カテゴリ上書き(収支レコードのみ)とコメント(全レコード)。
    // 「保存」で overrides.toml 書込→build→リロードまで走る。
    // serve.py 配信下でのみ有効(file:// では閲覧専用にグレーアウト)
    const ed = document.createElement("div");
    ed.className = "txn-edit";
    const base = OVR_BY_ID.get(t.id) || {};
    let catIn = null;
    if (t.type === "expense" || t.type === "income") {
      catIn = catPicker(t.category || "", !!base.category);
    }
    const comIn = document.createElement("input");
    comIn.className = "cmt";
    comIn.placeholder = "コメント(自由記入)";
    comIn.value = t.comment || "";
    const save = document.createElement("button");
    save.textContent = "保存";
    save.title = "data/overrides.toml に書き込み、build.py を実行して反映する";
    save.addEventListener("click", (ev) => {
      ev.stopPropagation();
      const o = { id: t.id };
      if (catIn) {
        const v = catIn.getValue().trim();
        // 現分類と違う値、または既存上書きの維持なら記録。空欄=上書き解除
        if (v && (v !== t.category || base.category)) o.category = v;
      } else if (base.category) {
        o.category = base.category;
      }
      const c = comIn.value.trim();
      if (c) o.comment = c;
      // 変更なしなら保存(=再ビルド)を起こさない。両側未設定
      // (undefined === undefined)も「変更なし」とみなす一致判定
      if (o.category === base.category && o.comment === base.comment) return;
      saveOverride(t.id, (o.category || o.comment) ? o : null, save);
    });
    ed.append(...(catIn ? [catIn] : []), comIn, save);
    if (OVR_BY_ID.has(t.id)) {
      const clear = document.createElement("button");
      clear.textContent = "上書きを削除";
      clear.title = "overrides.toml からこのレコードの上書きを消して元の値に戻す";
      clear.addEventListener("click", (ev) => {
        ev.stopPropagation();
        saveOverride(t.id, null, clear);
      });
      ed.appendChild(clear);
    }
    if (!KB.OVR_SRV) {
      for (const el of ed.querySelectorAll("input, button")) el.disabled = true;
      const note = document.createElement("span");
      note.className = "ro-note";
      note.textContent = "編集は python3 serve.py で開くと有効";
      ed.appendChild(note);
    }
    td.appendChild(ed);
    // 支出レコードには「この摘要を定点観測」ボタン(サーバへの書込を
    // 伴わない表示機能なので、編集フォームと違い file:// でも有効。
    // ed とは別枠で無効化しない)
    if (t.type === "expense") {
      const wrap = document.createElement("div");
      wrap.style.marginTop = "6px";
      wrap.appendChild(KB.watchButton(KB.watchKey(t.description), "この摘要を定点観測"));
      td.appendChild(wrap);
    }
    tr.appendChild(td);
    return tr;
  }

  // 明細表に実際に出る行(共通フィルタ済みの txns に明細タブ専用の
  // 絞り込みを重ねて新しい順)。テーブル描画とCSVエクスポートで共有する
  function visibleRows(txns) {
    let rows = [...txns].sort((a, b) => b.date.localeCompare(a.date));
    if (state.hideTransfer) {
      rows = rows.filter((t) => t.type !== "transfer" && t.type !== "adjustment");
    }
    // 明細タブ専用の絞り込み(独立に効く)。上書きあり=カテゴリの手動上書き
    if (state.fOverride) {
      rows = rows.filter((t) => (OVR_BY_ID.get(t.id) || {}).category);
    }
    if (state.fComment) rows = rows.filter((t) => t.comment);
    return rows;
  }

  // 現在の明細表と同じ行(フィルタ結果)をCSVでダウンロードする。
  // Blob + a[download] なので file:// でも動く。Excel想定でBOM付きUTF-8
  function exportCsv() {
    const rows = visibleRows(KB.filtered());
    const esc = (v) => {
      const s = String(v == null ? "" : v);
      return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = ["date", "account", "account_name", "description", "category",
                  "type", "amount", "counter", "memo", "comment", "id"];
    const lines = [head.join(",")];
    for (const t of rows) {
      lines.push([
        t.date, t.account, ACCOUNTS[t.account] ? ACCOUNTS[t.account].name : "",
        t.description, t.category, t.type, t.amount, t.counter || "",
        t.memo || "", t.comment || "", t.id,
      ].map(esc).join(","));
    }
    const blob = new Blob(["\uFEFF" + lines.join("\n") + "\n"],
                          { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `kakeibo-p-${KB.todayIso()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }
  $("#csv-btn").addEventListener("click", exportCsv);

  function renderTable(txns) {
    const tbody = $("#txn-table tbody");
    tbody.replaceChildren();
    const rows = visibleRows(txns);
    let focusRow = null;
    for (const t of rows) {
      const tr = document.createElement("tr");
      tr.className = t.type;
      const td1 = document.createElement("td");
      td1.textContent = t.date;
      const td2 = document.createElement("td");
      td2.textContent = ACCOUNTS[t.account] ? ACCOUNTS[t.account].name : t.account;
      const td3 = document.createElement("td");
      td3.textContent = t.description;
      if (t.comment) {
        const cm = document.createElement("span");
        cm.className = "cmt-mark";
        cm.textContent = "💬";
        cm.title = t.comment;
        td3.appendChild(cm);
      }
      const td4 = document.createElement("td");
      const badge = document.createElement("span");
      badge.className = "badge" + (t.category === "未分類" ? " uncls" : "");
      if (t.type === "transfer") {
        badge.textContent = "振替→"
          + (ACCOUNTS[t.counter] ? ACCOUNTS[t.counter].name : t.counter);
      } else {
        const g = catGroup(t.category);
        badge.title = "中分類: " + g;
        badge.append(catSwatch(g), document.createTextNode(t.category));
      }
      td4.appendChild(badge);
      const td5 = document.createElement("td");
      td5.className = "num" + (t.amount > 0 ? " pos" : t.amount < 0 ? " neg" : "");
      td5.textContent = (t.amount > 0 ? "+" : "") + fmt(t.amount);
      for (const td of [td1, td2, td3, td4, td5]) tr.appendChild(td);
      tr.addEventListener("click", () => {
        const next = tr.nextElementSibling;
        if (next && next.classList.contains("txn-detail")) {
          next.remove();
        } else {
          tr.after(txnDetailRow(t));
        }
      });
      tbody.appendChild(tr);
      if (state.focusTxn && t.id === state.focusTxn) {
        tr.classList.add("focus");
        const detail = txnDetailRow(t);
        detail.classList.add("focus");
        tr.after(detail);
        focusRow = tr;
      }
    }
    $("#txn-count").textContent = `${rows.length}件`;
    if (focusRow) {
      focusRow.scrollIntoView({ block: "center" });
    }
    // 対象行が絞り込みで表に現れなかった場合も必ずクリアする(残留すると
    // 後続の再描画で不意にスクロール・ハイライトされる)
    state.focusTxn = "";
  }

  // 未分類ランキング(ルール追加の候補)
  // 分類を決めるのは rules.toml の人手ルールだけ。ここは「どのルールを書けば
  // 一番効くか」を示すだけで、推測で分類はしない(build.py --check と同じ集計)
  function uncategorizedRanking() {
    const agg = new Map();
    for (const t of TXNS) {
      if (t.category !== "未分類") continue;
      if (t.type !== "income" && t.type !== "expense") continue;
      const key = KB.watchKey(t.description);
      let a = agg.get(key);
      if (!a) agg.set(key, a = { key, count: 0, amount: 0, last: "" });
      a.count++;
      a.amount += Math.abs(t.amount);
      if (t.date > a.last) a.last = t.date;
    }
    // 潰し切るための一覧なので件数は打ち切らない(未分類が残っている限り
    // 行数は未分類の摘要の種類数どまり)
    return [...agg.values()]
      .sort((x, y) => y.count - x.count || y.amount - x.amount);
  }

  function renderUncategorized() {
    const rows = uncategorizedRanking();
    const card = $("#uncls-card");
    card.style.display = rows.length ? "" : "none";
    if (!rows.length) return;
    const total = TXNS.filter((t) => t.category === "未分類"
      && (t.type === "income" || t.type === "expense")).length;
    $("#uncls-summary").textContent =
      `未分類 ${total}件 — ルール追加の候補 ${rows.length}摘要(全件)`;
    const box = $("#uncls-list");
    box.replaceChildren();
    for (const r of rows) {
      const row = document.createElement("div");
      row.className = "uncls-row";
      row.title = `直近 ${r.last}・クリックで絞り込みを解除してこの摘要を検索`;
      const nm = document.createElement("span");
      nm.className = "nm";
      nm.textContent = r.key;
      const n = document.createElement("span");
      n.className = "n";
      n.textContent = r.count + "件";
      const a = document.createElement("span");
      a.className = "a";
      a.textContent = fmt(r.amount);
      row.append(nm, n, a);
      // 期間などの絞り込みが残っていると「押しても表に出ない」ので、
      // 全部落としてから検索する(jumpToSearch)
      row.addEventListener("click", () => KB.jumpToSearch(r.key));
      box.appendChild(row);
    }
  }

  Object.assign(KB, { renderTable, renderUncategorized });
})();
