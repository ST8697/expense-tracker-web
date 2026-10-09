/**
 * 錢錢管家 App：手機桌面快速記帳。後端是 Apps Script 的 /exec（src/App.js）。
 * 網址與密鑰只存在這支手機（localStorage），不放進程式碼。
 */
(() => {
  const $ = (s) => document.querySelector(s);
  const UNDO_MS = 10 * 60 * 1000;
  const DATE_RE = /^(?:\d{4}\/)?\d{1,2}\/\d{1,2}$/;

  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k)); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* 私密模式等：忽略 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  let cfg = store.get('cfg');                // { url, secret }
  let meta = store.get('meta') || { methods: ['現金', '轉帳'], categories: [], frequent: [] };
  let selected = null;                        // 按鈕選的付款方式（文字裡沒寫時才用）
  let chip = null;                            // 目前帶入的常用項目 { item, method, amount }
  let pending = null;                         // 等選分類的送出內容 { text, method }
  let busy = false;

  const el = {
    setup: $('#setup'), app: $('#app'), entry: $('#entry'), send: $('#send'), error: $('#error'),
    methods: $('#methods'), frequent: $('#frequent'), freqLabel: $('#freq-label'), methodHint: $('#method-hint'),
    result: $('#result'), ask: $('#ask'), askChips: $('#ask-chips'),
    ghostTyped: $('.ghost-typed'), ghostAmount: $('.ghost-amount'),
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

  function shake(node) { node.classList.remove('shake'); void node.offsetWidth; node.classList.add('shake'); }

  function isStandalone() { return window.navigator.standalone === true || matchMedia('(display-mode: standalone)').matches; }

  async function api(body, conf) {
    conf = conf || cfg;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 30000);
    try {
      // 不設 Content-Type → text/plain，瀏覽器不會先送 CORS 預檢（Apps Script 不支援 OPTIONS）
      const res = await fetch(conf.url, { method: 'POST', body: JSON.stringify(Object.assign({ app: 1, secret: conf.secret }, body)), signal: ctrl.signal });
      const json = await res.json();
      if (json.auth) throw new Error('密鑰錯誤，請到 ⚙︎ 設定重新輸入');
      return json;
    } catch (e) {
      if (e.name === 'AbortError') throw new Error('連線逾時，請再按一次重送');
      if (e instanceof TypeError || e instanceof SyntaxError) throw new Error('連線失敗，請確認網路後再按一次重送');
      throw e;
    } finally { clearTimeout(timer); }
  }

  // ---------- 文字分析：[日期] [退款] [付款方式] 項目 金額，或 [日期] 收入/獎金 … ----------

  function analyze(text) {
    const toks = text.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    if (DATE_RE.test(toks[i] || '')) i++;
    if (toks[i] === '收入' || toks[i] === '獎金') return { toks, income: true, at: i, method: null };
    if (toks[i] === '退款') i++;
    return { toks, income: false, at: i, method: meta.methods.indexOf(toks[i]) >= 0 ? toks[i] : null };
  }

  // ---------- 畫面 ----------

  function renderMethods() {
    const a = analyze(el.entry.value);
    const current = a.method || selected;
    el.methods.replaceChildren(...meta.methods.map(m => {
      const b = h('button', 'chip' + (m === current ? ' on' : ''), m);
      b.type = 'button';
      b.onclick = () => pickMethod(m);
      return b;
    }));
    if (current || a.income) el.methodHint.hidden = true;
  }

  function renderFrequent() {
    el.freqLabel.hidden = !meta.frequent.length;
    el.frequent.replaceChildren(...meta.frequent.map(f => {
      const b = h('button', 'chip', f.item);
      b.type = 'button';
      b.append(h('span', 'sub', f.method));
      b.onclick = () => pickFrequent(f);
      return b;
    }));
  }

  function renderGhost() {
    const v = el.entry.value;
    if (chip && v.trim() === chip.item) {
      el.ghostTyped.textContent = v.endsWith(' ') ? v : v + ' ';
      el.ghostAmount.textContent = String(chip.amount);
    } else {
      if (chip && v.trim().indexOf(chip.item) !== 0) chip = null;
      el.ghostTyped.textContent = '';
      el.ghostAmount.textContent = '';
    }
  }

  function showError(msg) {
    el.error.textContent = msg || '';
    el.error.hidden = !msg;
    el.send.textContent = msg ? '重送' : '記一筆';
  }

  function renderRecord(rec) {
    const card = h('section', 'card');
    const head = h('div', 'rec-head');
    head.append(h('span', '', rec.head));
    if (rec.id) {
      const undo = h('button', 'undo', '復原');
      undo.type = 'button';
      undo.onclick = () => doUndo(rec.id, card);
      head.append(undo);
      setTimeout(() => undo.remove(), UNDO_MS);
    }
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
    el.result.replaceChildren(card);
  }

  function renderMessage(text) {
    const card = h('section', 'card');
    card.append(h('div', 'msg', text));
    el.result.replaceChildren(card);
  }

  function renderAsk(ask) {
    el.ask.querySelector('.ask-title').textContent = '「' + ask.item + '」要歸到哪一類？（之後會自動記住）';
    el.askChips.replaceChildren(...ask.categories.map(c => {
      const b = h('button', 'chip', c.emoji + ' ' + c.name);
      b.type = 'button';
      b.onclick = () => send(pending, c.name);
      return b;
    }));
    el.ask.hidden = false;
  }

  function renderAll() { renderMethods(); renderFrequent(); renderGhost(); }

  // ---------- 動作 ----------

  function pickMethod(m) {
    const a = analyze(el.entry.value);
    if (a.method) {
      // 文字裡已寫付款方式 → 直接換掉那個字，按鈕與文字保持一致
      a.toks[a.at] = m;
      el.entry.value = a.toks.join(' ') + (el.entry.value.endsWith(' ') ? ' ' : '');
    } else {
      selected = selected === m ? null : m;
    }
    renderMethods();
  }

  function pickFrequent(f) {
    chip = f;
    el.entry.value = f.item + ' ';
    selected = meta.methods.indexOf(f.method) >= 0 ? f.method : null;
    showError('');
    renderAll();
    el.entry.focus();
  }

  /**
   * 送出前整理：補上沿用的金額；付款方式由伺服器插入（先檢查原文字是不是 LINE 指令）。
   * 看起來是支出（最後有數字）卻沒有付款方式 → 擋下。回傳 { text, method } 或 null。
   */
  function compose() {
    let text = el.entry.value.trim();
    if (!text) { shake(el.entry); return null; }
    if (chip && text === chip.item) text += ' ' + chip.amount;
    const a = analyze(text);
    if (a.income || a.method) return { text, method: null };
    if (!selected && /\d/.test(a.toks[a.toks.length - 1])) {
      el.methodHint.hidden = false;
      shake(el.methods);
      return null;
    }
    return { text, method: selected };
  }

  async function send(req, category) {
    if (busy || !req) return;
    busy = true;
    el.send.disabled = true;
    el.send.textContent = '記帳中…';
    el.ask.querySelectorAll('button').forEach(b => { b.disabled = true; });
    try {
      const r = await api({ action: 'record', text: req.text, method: req.method, category: category || null });
      if (!r.ok) throw new Error(r.error);
      if (r.ask) {
        pending = req;
        renderAsk(r.ask);
        showError('');
        return;
      }
      // 成功：清空，付款方式回到未選（每次都要選）
      renderRecord(r.rec);
      el.entry.value = '';
      selected = null;
      chip = null;
      pending = null;
      el.ask.hidden = true;
      showError('');
      renderAll();
      refreshMeta();
    } catch (e) {
      showError(e.message);
    } finally {
      busy = false;
      el.send.disabled = false;
      if (el.error.hidden) el.send.textContent = '記一筆';
      el.ask.querySelectorAll('button').forEach(b => { b.disabled = false; });
    }
  }

  async function doUndo(id, card) {
    if (busy) return;
    busy = true;
    try {
      const r = await api({ action: 'undo', id });
      if (!r.ok) throw new Error(r.error);
      renderMessage('↩️ 已復原\n' + r.text);
      refreshMeta();
    } catch (e) {
      const p = h('p', 'error', e.message);
      card.append(p);
    } finally { busy = false; }
  }

  async function refreshMeta() {
    try {
      const r = await api({ action: 'meta' });
      if (!r.ok) return;
      meta = r.meta;
      store.set('meta', meta);
      renderAll();
    } catch (e) { /* 背景更新失敗就沿用快取 */ }
  }

  // ---------- 首次設定 / 設定 ----------

  function showSetup() {
    el.app.hidden = true;
    el.setup.hidden = false;
    $('#setup-tip').hidden = isStandalone();
  }

  function showApp() {
    el.setup.hidden = true;
    el.app.hidden = false;
    renderAll();
    refreshMeta();
  }

  $('#setup-form').onsubmit = async (ev) => {
    ev.preventDefault();
    const conf = { url: $('#setup-url').value.trim(), secret: $('#setup-secret').value.trim() };
    const btn = $('#setup-btn');
    const err = $('#setup-err');
    btn.disabled = true;
    btn.textContent = '連線中…';
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
      btn.disabled = false;
      btn.textContent = '連線';
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

  el.entry.addEventListener('input', () => { renderGhost(); renderMethods(); });
  $('#entry-form').onsubmit = (ev) => {
    ev.preventDefault();
    el.ask.hidden = true;
    pending = null;
    send(compose());
  };
  $('#ask-cancel').onclick = () => { el.ask.hidden = true; pending = null; };

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});

  if (cfg && cfg.url && cfg.secret) showApp(); else showSetup();
})();
