/**
 * 錢錢管家：計算機記帳頁。後端是 Apps Script 的 /exec（src/App.js）。
 * 兩種入口共用這一頁：
 * - LINE 圖文選單 → LIFF：網址帶 ?liff=<LIFF ID>&gas=<部署 ID>，用 LINE 的 ID token 驗證，不用輸入密鑰。
 * - 主畫面 PWA：首次輸入 /exec 網址與 APP_SECRET，只存在這支手機（localStorage）。
 */
(() => {
  const $ = (s) => document.querySelector(s);
  const UNDO_MS = 10 * 60 * 1000;
  const DATE_RE = /^(?:\d{4}\/)?\d{1,2}\/\d{1,2}$/;
  const SHORT = { '居家生活': '居家', '醫療保健': '醫療', '訂閱/電信': '訂閱', '人情社交': '人情' };
  const MAX_DIGITS = 8;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 私密模式等：忽略 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  let cfg = store.get('cfg');                 // PWA：{ url, secret }；LIFF：{ url, liff: true }
  let meta = store.get('meta') || { methods: ['現金', '轉帳'], categories: [], frequent: [] };
  let liffMode = false;
  let catsLocked = false;                     // 開頁後一旦操作過，類別就不再換位置
  let busy = false;

  // 計算機狀態
  const st = { mode: 'expense', date: today(), expr: '', note: '', category: null, method: null, chip: null };

  const el = {
    setup: $('#setup'), boot: $('#boot'), app: $('#app'), text: $('#textmode'),
    modes: $('#modes'), btnDate: $('#btn-date'), dateMenu: $('#date-menu'), dateInput: $('#date-input'),
    result: $('#result'), display: $('#display'), expr: $('#expr'), amount: $('#amount'), note: $('#note'),
    freqRow: $('#freq-row'), frequent: $('#frequent'), picks: $('#picks'), cats: $('#cats'), methods: $('#methods'),
    hint: $('#hint'), keypad: $('#keypad'), send: $('#send'),
    tResult: $('#t-result'), tMethods: $('#t-methods'), tHint: $('#t-hint'), entry: $('#entry'), tSend: $('#t-send'), tError: $('#t-error'),
    ask: $('#ask'), askChips: $('#ask-chips'),
  };

  // ---------- 共用 ----------

  function money(n) {
    return (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }

  function h(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  function btn(cls, text, onclick) {
    const b = h('button', cls, text);
    b.type = 'button';
    b.onclick = onclick;
    return b;
  }

  function shake(node) { node.classList.remove('shake'); void node.offsetWidth; node.classList.add('shake'); }

  function isStandalone() { return window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; }

  /** 台灣時間的 yyyy-MM-dd；daysAgo 天前 */
  function today(daysAgo) {
    return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Taipei' }).format(new Date(Date.now() - (daysAgo || 0) * 86400000));
  }

  async function api(body, conf) {
    conf = conf || cfg;
    const auth = conf.liff ? { idToken: window.liff.getIDToken() } : { secret: conf.secret };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      // 不設 Content-Type → text/plain，瀏覽器不會先送 CORS 預檢（Apps Script 不支援 OPTIONS）
      const res = await fetch(conf.url, { method: 'POST', body: JSON.stringify(Object.assign({ app: 1 }, auth, body)), signal: ctrl.signal });
      const json = await res.json();
      if (json.auth && conf.liff) { setTimeout(() => location.reload(), 1200); throw new Error('LINE 登入已過期，重新載入中…'); }
      if (json.auth) throw new Error('密鑰錯誤，請到 ⚙︎ 設定重新輸入');
      return json;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('連線逾時，請再按一次送出');
      if (e instanceof TypeError || e instanceof SyntaxError) throw new Error('連線失敗，請確認網路後再按一次送出');
      throw e;
    } finally { clearTimeout(timer); }
  }

  // ---------- 金額算式：數字與＋ ----------

  function terms() { return st.expr.split('+').filter(Boolean).map(Number); }
  function total() { return terms().reduce((a, b) => a + b, 0); }

  function press(k) {
    const last = st.expr.split('+').pop();
    if (/^\d+$/.test(k)) {
      if (last.length + k.length > MAX_DIGITS) return shake(el.display);
      if (k === '00' && (last === '' || last === '0')) return;
      st.expr = last === '0' ? st.expr.slice(0, -1) + k : st.expr + k;
    } else if (k === '+') {
      if (st.expr && !st.expr.endsWith('+')) st.expr += '+';
    } else if (k === 'back') {
      st.expr = st.expr.slice(0, -1);
    } else if (k === 'clear') {
      st.expr = '';
    }
    renderAmount();
  }

  // ---------- 畫面 ----------

  function renderAmount() {
    const t = total();
    el.expr.innerHTML = '&nbsp;';
    if (st.expr.indexOf('+') >= 0) el.expr.textContent = st.expr.replace(/\+/g, ' + ');
    const ph = !st.expr && st.chip;
    el.amount.textContent = st.expr ? money(t) : ph ? money(st.chip.amount) : '$0';
    el.amount.classList.toggle('ph', !st.expr);
  }

  function renderModes() {
    el.modes.querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.mode === st.mode));
    const income = st.mode === 'income';
    el.picks.classList.toggle('off', income);
    el.freqRow.hidden = income || !meta.frequent.length;
    el.note.placeholder = income ? '備註（選填，空白記成「其他收入」）' : '備註（選填）';
    el.send.textContent = busy ? '…' : st.mode === 'refund' ? '退款' : '送出';
  }

  function renderDate() {
    const d = st.date;
    const label = d === today() ? '今天' : d === today(1) ? '昨天' : d === today(2) ? '前天' : Number(d.slice(5, 7)) + '/' + Number(d.slice(8));
    el.btnDate.textContent = '📅 ' + label + ' ▾';
    el.btnDate.classList.toggle('past', d !== today());
    el.dateInput.max = today();
    el.dateInput.value = d;
  }

  function renderCats() {
    el.cats.replaceChildren(...meta.categories.map(c => {
      const b = btn(c.name === st.category ? 'on' : '', '', () => pick('category', c.name));
      b.append(h('b', '', c.emoji), document.createTextNode(SHORT[c.name] || c.name));
      b.setAttribute('aria-label', c.name);
      return b;
    }));
  }

  function renderMethods() {
    el.methods.style.setProperty('--n', Math.min(7, meta.methods.length));
    el.methods.replaceChildren(...meta.methods.map(m => btn(m === st.method ? 'on' : '', m, () => pick('method', m))));
  }

  function renderFrequent() {
    el.frequent.replaceChildren(...meta.frequent.map(f => btn('', f.item, () => pickFrequent(f))));
    el.freqRow.hidden = st.mode === 'income' || !meta.frequent.length;
  }

  function renderCalc() { renderModes(); renderDate(); renderCats(); renderMethods(); renderFrequent(); renderAmount(); }

  function setHint(msg) { el.hint.textContent = msg || ''; el.hint.hidden = !msg; }

  function recordCard(rec, onUndo, onClose) {
    const card = h('section', 'card');
    const head = h('div', 'rec-head');
    head.append(h('span', '', rec.head));
    const acts = h('span', 'acts');
    if (rec.id) {
      const undo = btn('undo', '復原', () => onUndo(rec.id, card));
      acts.append(undo);
      setTimeout(() => undo.remove(), UNDO_MS);
    }
    if (onClose) acts.append(btn('close', '✕', onClose));
    head.append(acts);
    card.append(head, h('div', 'rec-tag', rec.tag));
    const main = h('div', 'rec-main');
    main.append(h('span', 'rec-item', rec.item), h('span', 'rec-amount' + (rec.positive ? ' pos' : ''), rec.amount));
    card.append(main);
    rec.notes.forEach(n => card.append(h('div', 'rec-note', n)));

    const budget = h('div', 'rec-budget');
    const row = h('div', 'rec-row');
    row.append(h('span', '', '本月剩餘'), h('span', rec.remaining < 0 ? 'neg' : '', money(rec.remaining)));
    const bar = h('div', 'bar');
    const fill = h('i');
    fill.style.width = Math.max(0, Math.min(100, rec.pct)) + '%';
    fill.style.background = rec.pct > 30 ? 'var(--green)' : rec.pct > 10 ? 'var(--orange)' : 'var(--red)';
    bar.append(fill);
    budget.append(row, bar);
    rec.alerts.forEach(a => {
      const p = h('div', 'alert', a.text);
      p.style.color = /E53935/i.test(a.color) ? 'var(--red)' : 'var(--orange)';
      budget.append(p);
    });
    card.append(budget);
    return card;
  }

  function messageCard(text, onClose) {
    const card = h('section', 'card');
    const head = h('div', 'rec-head');
    head.append(h('div', 'msg', text));
    if (onClose) head.append(btn('close', '✕', onClose));
    card.append(head);
    return card;
  }

  function hideResult() { el.result.hidden = true; el.result.replaceChildren(); }
  function showResult(card) { el.result.replaceChildren(card); el.result.hidden = false; }

  // ---------- 計算機動作 ----------

  /** 任何操作：收起結果卡、提示；類別位置從此固定 */
  function touched() { hideResult(); setHint(''); catsLocked = true; el.dateMenu.hidden = true; }

  function pick(kind, value) {
    touched();
    st[kind] = st[kind] === value ? null : value;
    if (kind === 'category') renderCats(); else renderMethods();
  }

  function pickFrequent(f) {
    touched();
    st.chip = f;
    st.note = f.item;
    el.note.value = f.item;
    st.expr = '';
    if (meta.categories.some(c => c.name === f.category)) st.category = f.category;
    if (meta.methods.indexOf(f.method) >= 0) st.method = f.method;
    renderCats(); renderMethods(); renderAmount();
  }

  function setMode(m) {
    touched();
    st.mode = m;
    renderModes();
  }

  function setDate(d) {
    if (!d || d > today()) d = today();
    st.date = d;
    el.dateMenu.hidden = true;
    renderDate();
  }

  async function submit() {
    if (busy) return;
    touched();
    const amount = st.expr ? total() : st.chip ? st.chip.amount : 0;
    if (!(amount > 0)) { shake(el.display); return setHint('請輸入金額'); }
    const income = st.mode === 'income';
    if (!income && (!st.category || !st.method)) {
      shake(el.picks);
      return setHint(!st.category && !st.method ? '請選類別和付款方式' : !st.category ? '請選類別' : '請選付款方式');
    }
    busy = true;
    el.send.disabled = true;
    renderModes();
    try {
      const r = await api({ action: 'entry', mode: st.mode, date: st.date, amount, note: el.note.value.trim(),
        category: income ? null : st.category, method: income ? null : st.method });
      if (!r.ok) throw new Error(r.error);
      showResult(recordCard(r.rec, undo, hideResult));
      // 成功：除了日期全部清空，模式回到支出
      Object.assign(st, { mode: 'expense', expr: '', note: '', category: null, method: null, chip: null });
      el.note.value = '';
      busy = false;
      renderCalc();
      el.amount.classList.remove('flash'); void el.amount.offsetWidth; el.amount.classList.add('flash');
      refreshMeta();
    } catch (e) {
      setHint(e.message);
    } finally {
      busy = false;
      el.send.disabled = false;
      renderModes();
    }
  }

  async function undo(id, card) {
    if (busy) return;
    busy = true;
    try {
      const r = await api({ action: 'undo', id });
      if (!r.ok) throw new Error(r.error);
      const done = messageCard('↩️ 已復原\n' + r.text, () => { hideResult(); el.tResult.replaceChildren(); });
      if (card.parentNode === el.tResult) el.tResult.replaceChildren(done); else showResult(done);
      refreshMeta();
    } catch (e) {
      card.append(h('p', 'error', e.message));
    } finally { busy = false; }
  }

  async function refreshMeta() {
    try {
      const r = await api({ action: 'meta' });
      if (!r.ok) return;
      // 類別順序只在開頁時更新（使用中不換位置）
      if (catsLocked && meta.categories.length) {
        const old = meta.categories.map(c => c.name);
        r.meta.categories.sort((a, b) => (old.indexOf(a.name) + 1 || 99) - (old.indexOf(b.name) + 1 || 99));
      }
      meta = r.meta;
      store.set('meta', meta);
      if (meta.methods.indexOf(st.method) < 0) st.method = null;
      renderCats(); renderMethods(); renderFrequent(); renderTMethods();
    } catch (e) { /* 背景更新失敗就沿用快取 */ }
  }

  // ---------- 文字輸入（沿用 LINE 語法；給分期、外幣等） ----------

  let tSelected = null;                       // 按鈕選的付款方式（文字裡沒寫時才用）
  let tPending = null;                        // 等選分類的送出內容 { text, method }

  /** [日期] [退款] [付款方式] 項目 金額，或 [日期] 收入/獎金 … */
  function analyze(text) {
    const toks = text.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    if (DATE_RE.test(toks[i] || '')) i++;
    if (toks[i] === '收入' || toks[i] === '獎金') return { toks, income: true, at: i, method: null };
    if (toks[i] === '退款') i++;
    return { toks, income: false, at: i, method: meta.methods.indexOf(toks[i]) >= 0 ? toks[i] : null };
  }

  function renderTMethods() {
    const a = analyze(el.entry.value);
    const current = a.method || tSelected;
    el.tMethods.replaceChildren(...meta.methods.map(m => btn('chip' + (m === current ? ' on' : ''), m, () => tPickMethod(m))));
    if (current || a.income) el.tHint.hidden = true;
  }

  function tPickMethod(m) {
    const a = analyze(el.entry.value);
    if (a.method) {
      a.toks[a.at] = m;                       // 文字裡已寫付款方式 → 直接換掉那個字
      el.entry.value = a.toks.join(' ') + (el.entry.value.endsWith(' ') ? ' ' : '');
    } else {
      tSelected = tSelected === m ? null : m;
    }
    renderTMethods();
  }

  function tError(msg) {
    el.tError.textContent = msg || '';
    el.tError.hidden = !msg;
    el.tSend.textContent = msg ? '重送' : '記一筆';
  }

  function tCompose() {
    const text = el.entry.value.trim();
    if (!text) { shake(el.entry); return null; }
    const a = analyze(text);
    if (a.income || a.method) return { text, method: null };
    if (!tSelected && /\d/.test(a.toks[a.toks.length - 1])) {
      el.tHint.hidden = false;
      shake(el.tMethods);
      return null;
    }
    return { text, method: tSelected };
  }

  function renderAsk(ask) {
    el.ask.querySelector('.ask-title').textContent = '「' + ask.item + '」要歸到哪一類？（之後會自動記住）';
    el.askChips.replaceChildren(...ask.categories.map(c => btn('chip', c.emoji + ' ' + c.name, () => tSend(tPending, c.name))));
    el.ask.hidden = false;
  }

  async function tSend(req, category) {
    if (busy || !req) return;
    busy = true;
    el.tSend.disabled = true;
    el.tSend.textContent = '記帳中…';
    el.ask.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const r = await api({ action: 'record', text: req.text, method: req.method, category: category || null });
      if (!r.ok) throw new Error(r.error);
      if (r.ask) { tPending = req; renderAsk(r.ask); tError(''); return; }
      el.tResult.replaceChildren(recordCard(r.rec, undo));
      el.entry.value = '';
      tSelected = null;
      tPending = null;
      el.ask.hidden = true;
      tError('');
      renderTMethods();
      refreshMeta();
    } catch (e) {
      tError(e.message);
    } finally {
      busy = false;
      el.tSend.disabled = false;
      if (el.tError.hidden) el.tSend.textContent = '記一筆';
      el.ask.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  }

  // ---------- 畫面切換 / 設定 ----------

  function only(node) { [el.setup, el.boot, el.app, el.text].forEach(n => { n.hidden = n !== node; }); }

  function showSetup() { only(el.setup); $('#setup-tip').hidden = isStandalone(); }

  function showApp() {
    only(el.app);
    $('#btn-settings').hidden = liffMode;
    renderCalc();
    renderTMethods();
    refreshMeta();
  }

  function bootMessage(msg) { only(el.boot); $('#boot-msg').textContent = msg; }

  $('#setup-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const conf = { url: $('#setup-url').value.trim(), secret: $('#setup-secret').value.trim() };
    const b = $('#setup-btn');
    const err = $('#setup-err');
    b.disabled = true;
    b.textContent = '連線中…';
    err.hidden = true;
    try {
      if (!/^(https:\/\/script\.google(usercontent)?\.com\/.+|http:\/\/(localhost|127\.0\.0\.1)(:\d+)?)\/exec$/.test(conf.url)) throw new Error('網址應該是 https://script.google.com/macros/s/…/exec');
      const r = await api({ action: 'meta' }, conf);
      if (!r.ok) throw new Error(r.error);
      cfg = conf;
      meta = r.meta;
      store.set('cfg', cfg);
      store.set('meta', meta);
      showApp();
    } catch (e) {
      err.textContent = e.message;
      err.hidden = false;
    } finally {
      b.disabled = false;
      b.textContent = '連線';
    }
  };

  const dlg = $('#settings');
  $('#btn-settings').onclick = () => {
    $('#settings-url').textContent = cfg ? cfg.url.replace(/(\/s\/.{6}).+(.{6}\/exec)$/, '$1…$2') : '';
    dlg.showModal();
  };
  $('#btn-close').onclick = () => dlg.close();
  $('#btn-refresh').onclick = () => { refreshMeta(); dlg.close(); };
  $('#btn-reset').onclick = () => {
    if (!confirm('清除後要重新輸入網址與密鑰，確定？')) return;
    store.del('cfg');
    store.del('meta');
    cfg = null;
    dlg.close();
    showSetup();
  };

  // ---------- 事件 ----------

  el.keypad.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.k === 'send') return submit();
    touched();
    press(b.dataset.k);
  });
  el.modes.addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) setMode(b.dataset.mode); });
  el.btnDate.onclick = () => { const open = el.dateMenu.hidden; touched(); el.dateMenu.hidden = !open; };
  el.dateMenu.addEventListener('click', (ev) => { const b = ev.target.closest('button[data-days]'); if (b) setDate(today(Number(b.dataset.days))); });
  el.dateInput.addEventListener('change', () => setDate(el.dateInput.value));
  el.note.addEventListener('focus', touched);
  el.note.addEventListener('input', () => {
    st.note = el.note.value;
    // 改了常用項目的名稱 → 不再沿用上次金額
    if (st.chip && el.note.value.trim() !== st.chip.item) { st.chip = null; renderAmount(); }
  });
  el.note.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') el.note.blur(); });
  document.addEventListener('click', (ev) => {
    if (!el.dateMenu.hidden && !ev.target.closest('#date-menu, #btn-date')) el.dateMenu.hidden = true;
  });

  $('#btn-text').onclick = () => { touched(); only(el.text); renderTMethods(); };
  $('#btn-calc').onclick = () => { only(el.app); };
  el.entry.addEventListener('input', renderTMethods);
  $('#entry-form').onsubmit = (ev) => {
    ev.preventDefault();
    el.ask.hidden = true;
    tPending = null;
    tSend(tCompose());
  };
  $('#ask-cancel').onclick = () => { el.ask.hidden = true; tPending = null; };

  // ---------- 啟動 ----------

  function loadScript(src) {
    return new Promise((ok, fail) => { const s = document.createElement('script'); s.src = src; s.onload = ok; s.onerror = fail; document.head.append(s); });
  }

  async function bootLiff(liffId, gas) {
    bootMessage('載入中…');
    try {
      await loadScript('https://static.line-scdn.net/liff/edge/2/sdk.js');
      await window.liff.init({ liffId });
      if (!window.liff.isLoggedIn()) return window.liff.login({ redirectUri: location.href });
      liffMode = true;
      cfg = { url: 'https://script.google.com/macros/s/' + gas + '/exec', liff: true };
      showApp();
    } catch (e) {
      bootMessage('LINE 載入失敗：' + (e && e.message || e) + '\n請關閉後再開一次。');
    }
  }

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  const q = new URLSearchParams(location.search);
  // LIFF 設定記一份在 LINE 內建瀏覽器，萬一之後的網址沒帶參數也能用
  let lc = q.get('liff') && q.get('gas') ? { liffId: q.get('liff'), gas: q.get('gas') } : null;
  if (lc) store.set('liffCfg', lc); else if (/\bLine\//i.test(navigator.userAgent)) lc = store.get('liffCfg');
  if (lc) bootLiff(lc.liffId, lc.gas);
  else if (cfg && cfg.url && cfg.secret) showApp();
  else showSetup();
})();
