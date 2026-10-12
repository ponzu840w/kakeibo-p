"use strict";
// schedule.js: サブスク宣言の集計(declaredSubs)と定期収支の自動検出
// (detectRecurring)。計画タブの資金繰り予測・What-if と定期支出テーブル・
// サマリで共有する。定期支出のUIは宣言ベース(declaredSubs)が正で、
// 検出器は定期収入の投影と将来の候補提示に使う。
(function () {
  const KB = window.KB;
  const { ACCOUNTS } = KB;

  // 3ヶ月以上出現・月1〜2回・金額のブレ±35%以内を「定期」とみなす。
  // kind="expense"(既定): 支出側。給与清算口座は毎月出るのが当然なので除外。
  // kind="income": 収入側(仕送り等の定期収入検出用、給与本体は除外)。
  // 返り値の各要素:
  //   name   … 摘要キー(店・サービス名相当)
  //   median … 月額の中央値(絶対値)
  //   months … 出現月数
  //   last   … 最終出現日
  //   day    … 出現日(日にち)の中央値。資金繰り予測の計上日に使う
  //   account… 最頻出現口座
  //   series … Map(YYYY-MM → その月の合計額)。値上げ検出・累計に使う
  //   txns   … 該当明細の配列
  // 1回の renderAll で複数箇所から呼ばれ、mergeAliasGroups が重いため
  // (txns参照, kind) 単位でメモ化する(TXNS はリロードまで不変)
  const recurCache = new Map();
  function detectRecurring(txns, kind) {
    const wantExpense = kind !== "income";
    const cacheKey = wantExpense ? "expense" : "income";
    const hit = recurCache.get(cacheKey);
    if (hit && hit.txns === txns) return hit.result;
    const groups = new Map();
    for (const t of txns) {
      if (wantExpense) {
        if (t.type !== "expense" || t.amount >= 0) continue;
      } else {
        if (t.type !== "income" || t.amount <= 0) continue;
      }
      const acct = ACCOUNTS[t.account];
      if (acct && acct.group === "給与") continue;
      const key = KB.watchKey(t.description);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    mergeAliasGroups(groups);
    const out = [];
    for (const [name, list] of groups) {
      const byMonth = new Map();
      for (const t of list) {
        const m = t.date.slice(0, 7);
        byMonth.set(m, (byMonth.get(m) || 0) + 1);
      }
      if (byMonth.size < 3) continue;
      if ([...byMonth.values()].some((n) => n > 2)) continue;
      const amounts = list.map((t) => Math.abs(t.amount)).sort((a, b) => a - b);
      if (amounts[amounts.length - 1] > amounts[0] * 1.35) continue;
      const median = KB.median(amounts);
      const last = list.map((t) => t.date).sort().pop();
      const days = list.map((t) => Number(t.date.slice(8, 10)));
      const day = Math.round(KB.median(days));
      const accCount = new Map();
      for (const t of list) accCount.set(t.account, (accCount.get(t.account) || 0) + 1);
      const account = KB.modeOf(accCount);
      const series = new Map();
      for (const t of list) {
        const m = t.date.slice(0, 7);
        series.set(m, (series.get(m) || 0) + Math.abs(t.amount));
      }
      out.push({ name, median, months: byMonth.size, last, day, account,
                 series, kind: cacheKey, txns: list });
    }
    out.sort((a, b) => b.median - a.median);
    recurCache.set(cacheKey, { txns, result: out });
    return out;
  }

  // 摘要の表記揺れで同一サービスが二重検出されるのを防ぐ
  // (摘要は改称で揺れる。例: セゾンのNetflixは「ネットフリックス」⇔
  // 「NETFLIX.COM」。放置すると別系列として定期支出に二重計上され、
  // 資金繰り予測も倍になる)。
  // 同一口座・月額中央値±3%・出現月が互いに素・双方2ヶ月以上出現の組を
  // 同一サービスの摘要改称とみなし、最終出現が新しい側の名前へ統合する。
  // 金額も口座も月も一致しうる別サービスは互いに素条件までは満たしにくく、
  // 誤統合よりも「改称で系列が切れて二重計上」の実害の方が大きい判断
  function mergeAliasGroups(groups) {
    const stats = (list) => {
      const ms = new Set(list.map((t) => t.date.slice(0, 7)));
      const perMonth = new Map();
      for (const t of list) {
        const m = t.date.slice(0, 7);
        perMonth.set(m, (perMonth.get(m) || 0) + 1);
      }
      const amounts = list.map((t) => Math.abs(t.amount));
      const accCount = new Map();
      for (const t of list) {
        accCount.set(t.account, (accCount.get(t.account) || 0) + 1);
      }
      return {
        ms,
        monthlyOk: ![...perMonth.values()].some((n) => n > 2),
        median: KB.median(amounts),
        account: KB.modeOf(accCount),
        last: list.map((t) => t.date).sort().pop(),
      };
    };
    let merged = true;
    while (merged) {
      merged = false;
      const names = [...groups.keys()].sort();
      const st = new Map(names.map((n) => [n, stats(groups.get(n))]));
      outer:
      for (let i = 0; i < names.length; i++) {
        const sa = st.get(names[i]);
        if (sa.ms.size < 2 || !sa.monthlyOk) continue;
        for (let j = i + 1; j < names.length; j++) {
          const sb = st.get(names[j]);
          if (sb.ms.size < 2 || !sb.monthlyOk) continue;
          if (sa.account !== sb.account) continue;
          if (Math.abs(sa.median - sb.median) >
              0.03 * Math.max(sa.median, sb.median)) continue;
          if ([...sa.ms].some((m) => sb.ms.has(m))) continue;
          const [keep, drop] = sa.last >= sb.last
            ? [names[i], names[j]] : [names[j], names[i]];
          groups.get(keep).push(...groups.get(drop));
          groups.delete(drop);
          merged = true;
          break outer;   // 統計を取り直して再走査
        }
      }
    }
  }

  // 宣言ベースのサブスク集計。rules.toml [[recurring]] の宣言(DATA.recurring。
  // cycle は build 解決済みで、ここでは再推定しない)と、build がタグ付与した
  // 明細(t.recurring)から系列・投影額・現役判定を導出する。
  // 宣言が表すのは同一性のみで、数字はすべて実績から:
  //   amount  … 投影額。monthly=直近3出現月の月合計の中央値(同月複数請求も
  //             正しく合算)/ yearly=直近出現月の合計。値上げに自動追従する
  //   monthly … 月額換算(yearly は amount/12)。KPI・What-if 用
  //   account … 最新出現の口座(最頻でなく。支払手段を切り替えた直後に投影が
  //             旧口座へ残る事故を防ぐ)
  //   active  … 現役判定。monthly: 直近2ヶ月に出現 / yearly: 直近13ヶ月に出現。
  //             解約は宣言に書かず、出現が止まれば自然に非現役になる
  // 概要タイル・定期支出テーブル・What-if・資金繰り予測は必ずこの1関数を
  // 母集団にする(母集団が分かれると画面ごとに値がズレる)。
  // 入力(TXNS・DATA.recurring)はリロードまで不変なので初回結果をメモ化
  let subsCache = null;
  function declaredSubs() {
    if (subsCache) return subsCache;
    const { TXNS, curMonth, shiftMonth, median } = KB;
    const byName = new Map();
    for (const t of TXNS) {
      if (!t.recurring || t.type !== "expense") continue;
      if (!byName.has(t.recurring)) byName.set(t.recurring, []);
      byName.get(t.recurring).push(t);
    }
    const out = [];
    for (const decl of DATA.recurring || []) {
      const list = (byName.get(decl.name) || [])
        .slice().sort((a, b) => a.date.localeCompare(b.date));
      if (!list.length) continue;   // 明細に現れない宣言は build --check が警告する
      const series = new Map();
      for (const t of list) {
        const m = t.date.slice(0, 7);
        series.set(m, (series.get(m) || 0) + Math.abs(t.amount));
      }
      const ms = [...series.keys()].sort();
      const last = list[list.length - 1].date;
      const days = list.map((t) => Number(t.date.slice(8, 10)));
      const yearly = decl.cycle === "yearly";
      const amount = yearly ? series.get(ms[ms.length - 1])
        : median(ms.slice(-3).map((m) => series.get(m)));
      const activeSince =
        shiftMonth(curMonth, yearly ? -13 : -2) + "-01";
      out.push({
        name: decl.name, note: decl.note || "", cycle: decl.cycle,
        kind: decl.kind || "sub",
        txns: list, series, last, months: ms.length,
        day: Math.round(median(days)),
        account: list[list.length - 1].account,
        amount, monthly: yearly ? amount / 12 : amount,
        active: last >= activeSince,
      });
    }
    out.sort((a, b) => b.monthly - a.monthly);
    subsCache = out;
    return out;
  }

  // 給与の推定(資金繰り予測用)。直近4ヶ月に asset 口座へ入った給与振込
  // (counterが給与グループ・正の額・賞与を除く)から、振込日と金額の
  // 中央値を取る。学生バイト等の別給与も混じるが直近window内なら主給与が
  // 支配的。データ不足(2件未満)なら null を返し、呼び出し側は給与を
  // 投影せず正直に注記する。
  function estimateSalary(todayIso) {
    const { TXNS, ACCOUNTS, median } = KB;
    const since = KB.shiftMonth(todayIso.slice(0, 7), -4) + "-01";
    const deps = TXNS.filter((t) =>
      t.type === "transfer" && t.amount > 0 &&
      (ACCOUNTS[t.counter] || {}).group === "給与" &&
      (ACCOUNTS[t.account] || {}).kind === "asset" &&
      !/賞与/.test(t.description || "") && !/賞与/.test(t.memo || "") &&
      t.date >= since);
    if (deps.length < 2) return null;
    const amount = median(deps.map((t) => t.amount));
    const day = median(deps.map((t) => Number(t.date.slice(8, 10))));
    const accCount = new Map();
    for (const t of deps) accCount.set(t.account, (accCount.get(t.account) || 0) + 1);
    const account = KB.modeOf(accCount);
    return { amount, day: Math.round(day), account, count: deps.length,
             last: deps.map((t) => t.date).sort().pop() };
  }

  // カードの引落元口座(過去にそのカードへの振替が出た asset 口座の最頻値)。
  // 資金繰り予測が確定カード請求(card_bills)をどの口座から引くか決めるのに使う。
  function cardDebitAccounts() {
    const { TXNS, ACCOUNTS } = KB;
    const map = new Map();   // card口座id → Map(引落元 → 件数)
    for (const t of TXNS) {
      if (t.type !== "transfer" || t.amount >= 0 || !t.counter) continue;
      if ((ACCOUNTS[t.account] || {}).kind !== "asset") continue;
      if (!map.has(t.counter)) map.set(t.counter, new Map());
      const m = map.get(t.counter);
      m.set(t.account, (m.get(t.account) || 0) + 1);
    }
    const out = new Map();
    for (const [card, m] of map) {
      out.set(card, KB.modeOf(m));
    }
    return out;
  }

  // 定期振替の検出(資金繰り予測用)。銀行口座からの流出振替のうち
  // 「3ヶ月以上・月1回・引落日が安定(日のMAD≤2)」のものを定期とみなし、
  // 日割りに混ぜず実際の引落日に点として投影できるようにする
  // (実例: SBI証券つみたての自動引落「自払 AP」が毎月14日前後)。
  // カード引落(確定請求で投影)・銀行間の移動・給与は対象外。
  // 金額は宣言サブスクと同じく直近3出現月の中央値(積立額の変更に自動追従)。
  // 日付が不安定なチャージ(残高が減ったら補充する残高駆動)は意図して
  // 拾わない。日を打てないものはベースラインの日割りに残る。
  let rtCache = null;
  function detectRecurringTransfers() {
    if (rtCache) return rtCache;
    const { TXNS, ACCOUNTS, curMonth, shiftMonth, median, mad, watchKey } = KB;
    const groups = new Map();   // 摘要キー→相手口座 ごとの明細
    for (const t of TXNS) {
      if (t.type !== "transfer" || t.amount >= 0 || !t.counter) continue;
      const a = ACCOUNTS[t.account] || {};
      if (a.kind !== "asset" || a.group !== "銀行") continue;
      const c = ACCOUNTS[t.counter] || {};
      if (c.kind === "liability" || c.group === "銀行" ||
          c.group === "給与") continue;
      const key = watchKey(t.description) + "→" + t.counter;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(t);
    }
    const out = [];
    for (const [key, list] of groups) {
      const byMonth = new Map();
      const perMonth = new Map();
      for (const t of list) {
        const m = t.date.slice(0, 7);
        byMonth.set(m, (byMonth.get(m) || 0) + Math.abs(t.amount));
        perMonth.set(m, (perMonth.get(m) || 0) + 1);
      }
      if (byMonth.size < 3) continue;
      if ([...perMonth.values()].some((n) => n > 1)) continue;
      const days = list.map((t) => Number(t.date.slice(8, 10)));
      if (mad(days) > 2) continue;             // 引落日が安定していること
      const ms = [...byMonth.keys()].sort();
      const sorted = list.slice().sort((a, b) => a.date.localeCompare(b.date));
      const last = sorted[sorted.length - 1];
      out.push({
        name: key.split("→")[0], counter: last.counter,
        account: last.account,   // 最新出現の口座(支払元の切替に追従)
        amount: Math.round(median(ms.slice(-3).map((m) => byMonth.get(m)))),
        day: Math.round(median(days)), last: last.date, months: byMonth.size,
        active: last.date >= shiftMonth(curMonth, -2) + "-01",
        txns: list,
      });
    }
    out.sort((a, b) => b.amount - a.amount);
    rtCache = out;
    return out;
  }

  // その他流出のベースライン(資金繰り予測の楽観バイアス対策)。
  // 給与・確定請求・宣言サブスク・定期振替だけの投影では、日々の非定期
  // 支出・PayPay等のチャージが丸ごと抜ける(実測で銀行流出の4割超が
  // 投影外だった)。それら「他の投影で説明されない銀行からの流出」の
  // 直近3完了月の月次中央値を測り、日割りで計上するための入力を返す。
  // 日割りは「毎日使う」という主張ではなく、日を打てない流出の期待値を
  // 期間に均す近似(日を打てるものは detectRecurringTransfers が先に
  // 個別イベントへ昇格させ、ここからは除外される)。
  // 返り値: { monthly, months(参照した完了月), account(最頻流出口座) }。
  // 完了月が2ヶ月未満なら null(呼び出し側が「投影していない」と注記する)。
  function baselineOutflow() {
    const { TXNS, ACCOUNTS, curMonth, months, median } = KB;
    const ms = months.filter((m) => m < curMonth).slice(-3);
    if (ms.length < 2) return null;
    const inMs = new Set(ms);
    const isBank = (id) => {
      const a = ACCOUNTS[id] || {};
      return a.kind === "asset" && a.group === "銀行";
    };
    // 定期振替として個別投影される明細は日割りから除外(二重計上の防止)
    const claimed = new Set();
    for (const s of detectRecurringTransfers()) {
      if (s.active) for (const t of s.txns) claimed.add(t.id);
    }
    const byMonth = new Map(ms.map((m) => [m, 0]));
    const byAcct = new Map();
    for (const t of TXNS) {
      if (t.amount >= 0 || t.type === "adjustment") continue;
      if (!isBank(t.account)) continue;
      const m = t.date.slice(0, 7);
      if (!inMs.has(m)) continue;
      if (t.recurring) continue;               // 宣言サブスクは個別投影済み
      if (claimed.has(t.id)) continue;         // 定期振替は個別投影済み
      if (t.type === "transfer") {
        const c = ACCOUNTS[t.counter] || {};
        if (c.kind === "liability") continue;  // カード引落は請求側で投影
        if (c.group === "銀行") continue;      // 銀行間の移動は流出でない
      }
      byMonth.set(m, byMonth.get(m) - t.amount);
      byAcct.set(t.account, (byAcct.get(t.account) || 0) - t.amount);
    }
    const monthly = median([...byMonth.values()]);
    if (!(monthly > 0)) return null;
    const account = KB.modeOf(byAcct);   // 流出額が最大の銀行口座に帰属
    return { monthly, months: ms, account };
  }

  // 将来キャッシュフロー列。今日から horizonMonths ヶ月先までの
  // [{date, account, amount, label, kind}] を日付順で返す。
  //   kind: "salary" | "card" | "recurring" | "card_est" | "baseline"
  // 合成する5系統(いずれも決定論的。card_est と baseline は実績からの
  // 概算で、凡例・表・注記で推定であることを明示する):
  //   1. サブスク宣言(declaredSubs、現役のみ)・検出ベースの定期収入・
  //      定期振替(detectRecurringTransfers。証券積立の自動引落等)の
  //      うち asset 口座のもの。カード上のサブスクは請求を経て銀行から
  //      引き落とされるため直接は投影しない(二重計上の防止)。
  //   2. 給与: estimateSalary の振込日・金額。賞与は投影しない。
  //   3. 確定カード請求(card_bills)の未来分。引落元は cardDebitAccounts。
  //   4. 未確定のカード請求(card_est): 請求が確定していない未来月を
  //      0円扱いにすると予測が階段状に上がるだけの楽観になるため、
  //      直近請求の中央値で見込む。確定請求がある月はそちらが正。
  //   5. その他流出ベースライン(baseline): baselineOutflow の月次中央値を
  //      日割りで計上する。
  // opts.whatif(任意): { drop:Set<定期支出name> } で What-if を反映する。
  function futureEvents(opts) {
    const { TXNS, ACCOUNTS, shiftMonth, daysOf, curMonth } = KB;
    const today = (opts && opts.today) || KB.todayIso();
    const horizon = (opts && opts.horizonMonths) || 3;
    const whatif = (opts && opts.whatif) || {};
    const drop = whatif.drop || new Set();
    const endMonth = shiftMonth(today.slice(0, 7), horizon);
    const end = endMonth + "-" + String(daysOf(endMonth)).padStart(2, "0");
    const events = [];
    // 対象の未来月(今月〜horizonヶ月先)
    const futureMonths = [];
    for (let m = today.slice(0, 7); m <= endMonth; m = shiftMonth(m, 1)) {
      futureMonths.push(m);
    }
    const clampDay = (m, d) => Math.min(d, daysOf(m));
    const push = (date, account, amount, label, kind) => {
      if (date >= today && date <= end) {
        events.push({ date, account, amount, label, kind });
      }
    };

    // 1a. サブスク宣言(asset口座のみ・現役)。カード上のサブスクは請求を経て
    //     銀行から引き落とされるため直接は投影しない(二重計上の防止)
    for (const s of declaredSubs()) {
      if (!s.active || drop.has(s.name)) continue;   // 非現役 / What-if 解約
      if ((ACCOUNTS[s.account] || {}).kind !== "asset") continue;
      // 法定控除等は給与清算口座上の帳簿値で、現金は動かないため投影しない
      if ((ACCOUNTS[s.account] || {}).group === "給与") continue;
      if (s.cycle === "yearly") {
        // 直近支払の12ヶ月後に1件だけ投影
        const m = shiftMonth(s.last.slice(0, 7), 12);
        const d = m + "-" +
          String(clampDay(m, Number(s.last.slice(8, 10)))).padStart(2, "0");
        push(d, s.account, -s.amount, s.name + "(年払い・宣言)", "recurring");
      } else {
        for (const m of futureMonths) {
          // 当月分が既に(中央値日より早く)支払われていたら投影しない
          // (実残高が既に反映済みのため、投影すると二重計上になる)
          if (m === today.slice(0, 7) && s.last >= m + "-01") continue;
          const d = m + "-" + String(clampDay(m, s.day)).padStart(2, "0");
          push(d, s.account, -s.amount, s.name + "(宣言)", "recurring");
        }
      }
    }
    // 1b. 定期収入(仕送り等)は従来どおり検出ベース(宣言は支出のみ対象)
    for (const s of detectRecurring(TXNS, "income")) {
      if ((ACCOUNTS[s.account] || {}).kind !== "asset") continue;
      if (s.last < shiftMonth(curMonth, -2) + "-01") continue;   // 現役のみ
      for (const m of futureMonths) {
        if (m === today.slice(0, 7) && s.last >= m + "-01") continue;
        const d = m + "-" + String(clampDay(m, s.day)).padStart(2, "0");
        push(d, s.account, s.median, s.name + "(定期検出)", "recurring");
      }
    }
    // 1c. 定期振替(証券積立の自動引落等)。日付が安定した月次の銀行流出は
    //     日割りに均さず、実際の引落日に点として投影する
    for (const s of detectRecurringTransfers()) {
      if (!s.active) continue;
      for (const m of futureMonths) {
        if (m === today.slice(0, 7) && s.last >= m + "-01") continue;
        const d = m + "-" + String(clampDay(m, s.day)).padStart(2, "0");
        push(d, s.account, -s.amount, s.name + "(定期検出)", "recurring");
      }
    }
    // 2. 給与
    const sal = estimateSalary(today);
    if (sal) {
      for (const m of futureMonths) {
        // 今月分が既に振り込まれていたら投影しない(実残高に反映済み)
        if (m === today.slice(0, 7) && sal.last >= m + "-01") continue;
        const d = m + "-" + String(clampDay(m, sal.day)).padStart(2, "0");
        push(d, sal.account, sal.amount, "給与(振込日中央値)", "salary");
      }
    }
    // 3. 確定カード請求
    const debitOf = cardDebitAccounts();
    const billsByCard = new Map();
    for (const b of DATA.card_bills || []) {
      const acc = debitOf.get(b.account);
      if (!acc) continue;
      const name = (ACCOUNTS[b.account] || {}).name || b.account;
      push(b.pay_date, acc, -b.bill_total, name + "請求(確定)", "card");
      if (!billsByCard.has(b.account)) billsByCard.set(b.account, []);
      billsByCard.get(b.account).push(b);
    }
    // 4. 未確定のカード請求(実績中央値)。現役カード(直近2ヶ月に請求あり)
    //    のみ。確定請求が既にある月・確定済み最終請求月以前はスキップ
    for (const [card, bs] of billsByCard) {
      bs.sort((a, b) => a.pay_date.localeCompare(b.pay_date));
      const lastPay = bs[bs.length - 1].pay_date;
      if (lastPay.slice(0, 7) < shiftMonth(curMonth, -2)) continue;
      const est = Math.round(KB.median(bs.slice(-3).map((b) => b.bill_total)));
      const day = Math.round(
        KB.median(bs.slice(-6).map((b) => Number(b.pay_date.slice(8, 10)))));
      const name = (ACCOUNTS[card] || {}).name || card;
      const confirmed = new Set(bs.map((b) => b.pay_date.slice(0, 7)));
      for (const m of futureMonths) {
        if (m <= lastPay.slice(0, 7) || confirmed.has(m)) continue;
        const d = m + "-" + String(clampDay(m, day)).padStart(2, "0");
        push(d, debitOf.get(card), -est,
             name + "請求(実績中央値・未確定)", "card_est");
      }
    }
    // 5. その他流出ベースライン(日割り)
    const base = baselineOutflow();
    if (base) {
      for (const m of futureMonths) {
        const days = daysOf(m);
        const perDay = base.monthly / days;
        for (let d = 1; d <= days; d++) {
          const iso = m + "-" + String(d).padStart(2, "0");
          push(iso, base.account, -Math.round(perDay),
               "その他支出(実績中央値の日割り)", "baseline");
        }
      }
    }
    events.sort((a, b) => a.date.localeCompare(b.date));
    return { events, salary: sal, baseline: base };
  }

  // 検出器群(detectRecurring等)の公開はテストハーネス(tests/js_harness.js)
  // が参照するため残している
  Object.assign(KB, {
    detectRecurring, detectRecurringTransfers, declaredSubs, estimateSalary,
    baselineOutflow, futureEvents,
  });
})();
