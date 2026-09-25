/* party_id Blocker — LiveChat chat-details widget */
(function () {
  'use strict';

  const CFG = window.LCB_CONFIG || {};
  const TOKEN_KEY = 'lcb_token_v1';
  const REDIRECT_KEY = 'lcb_redirect_at';
  const CONNECT_TIMEOUT_MS = CFG.connectTimeoutMs || 8000;

  const state = {
    phase: 'boot', // boot | setup | outside | auth | login | nochat | loading | ready | error
    token: null,
    widget: null,
    profile: null,
    data: null,
    error: null,
    actionError: null,
    confirming: null, // 'block' | 'unblock'
    busy: false,
    noteDraft: '',
    seq: 0
  };

  // ---------- small helpers ----------

  function h(tag, attrs) {
    const el = document.createElement(tag);
    const a = attrs || {};
    Object.keys(a).forEach(function (k) {
      if (k === 'class') el.className = a[k];
      else if (k === 'text') el.textContent = a[k];
      else if (k.indexOf('on') === 0) el.addEventListener(k.slice(2), a[k]);
      else if (a[k] === true) el.setAttribute(k, '');
      else if (a[k] !== false && a[k] !== null && a[k] !== undefined) el.setAttribute(k, a[k]);
    });
    for (let i = 2; i < arguments.length; i++) {
      const c = arguments[i];
      if (c === null || c === undefined || c === false) continue;
      el.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return el;
  }

  function formatDate(iso) {
    const d = new Date(iso);
    if (!iso || isNaN(d.getTime())) return '';
    return d.toLocaleString('tr-TR', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
  }

  function who(email) {
    return String(email || 'biri').split('@')[0];
  }

  function store(kind) {
    try { return window[kind]; } catch (e) { return null; }
  }
  function sget(kind, k) { try { const s = store(kind); return s ? s.getItem(k) : null; } catch (e) { return null; } }
  function sset(kind, k, v) { try { const s = store(kind); if (s) s.setItem(k, v); } catch (e) { /* ignore */ } }
  function sdel(kind, k) { try { const s = store(kind); if (s) s.removeItem(k); } catch (e) { /* ignore */ } }

  const ATTEMPT_LABEL = {
    BLOCKED: 'Chat kapatıldı ve banlandı',
    PARTIAL: 'Banlandı',
    FAILED: 'Banlanamadı',
    DUPLICATE: 'Tekrar gelen istek',
    DRY_RUN: 'Test modu, işlem yapılmadı'
  };

  const NOTICE_TEXT = {
    blocked: 'Engellendi. En geç 1 dakika içinde devreye girer ve üye bir sonraki chat denemesinde banlanır.',
    unblocked: 'Listeden çıkarıldı. Üyenin mevcut banı sürüyor; kaldırmak için banı LiveChat ayarlarından kaldır.',
    not_blocked: 'Bu üye zaten listede değil.'
  };

  // ---------- auth (Sign in with LiveChat) ----------

  function readToken() {
    try {
      const t = JSON.parse(sget('localStorage', TOKEN_KEY) || 'null');
      if (t && t.token && t.exp > Date.now() + 60000) return t.token;
    } catch (e) { /* ignore */ }
    return null;
  }

  function saveToken(data) {
    const ttl = (parseInt(data.expires_in, 10) || 3600) * 1000;
    sset('localStorage', TOKEN_KEY, JSON.stringify({ token: data.access_token, exp: Date.now() + ttl }));
  }

  function dropToken() { sdel('localStorage', TOKEN_KEY); }

  function makeSdk() {
    return new window.AccountsSDK({
      client_id: CFG.clientId,
      response_type: 'token',
      redirect_uri: window.location.origin + window.location.pathname,
      transaction: { force_local_storage: true }
    });
  }

  function cleanUrl() {
    try {
      window.history.replaceState(null, '', window.location.pathname + window.location.search);
    } catch (e) { /* ignore */ }
  }

  /** Resolves to a token, or null when the user has to click "Giriş yap". */
  async function authenticate() {
    const cached = readToken();
    if (cached) return cached;
    const sdk = makeSdk();
    try {
      const data = await sdk.redirect().authorizeData();
      if (!data || !data.access_token || !sdk.verify(data)) throw new Error('invalid');
      saveToken(data);
      sdel('sessionStorage', REDIRECT_KEY);
      cleanUrl();
      return data.access_token;
    } catch (e) {
      const last = Number(sget('sessionStorage', REDIRECT_KEY) || 0);
      if (Date.now() - last < 60000) return null; // already tried: fall back to the button
      sset('sessionStorage', REDIRECT_KEY, String(Date.now()));
      sdk.redirect().authorize();
      return new Promise(function () {}); // page navigates away
    }
  }

  async function loginWithPopup() {
    state.error = null;
    try {
      const data = await makeSdk().popup().authorize();
      if (!data || !data.access_token) throw new Error('no token');
      saveToken(data);
      sdel('sessionStorage', REDIRECT_KEY);
      state.token = data.access_token;
      afterAuth();
    } catch (e) {
      state.phase = 'login';
      state.error = { message: 'Giriş tamamlanamadı. Açılan pencereye izin verip tekrar dene.' };
      render();
    }
  }

  // ---------- API ----------

  async function api(action, extra) {
    const p = state.profile || {};
    const body = Object.assign({
      action: action,
      token: state.token,
      chat_id: p.chat && p.chat.id,
      customer_id: p.id
    }, extra || {});
    let res;
    try {
      const r = await window.fetch(CFG.apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(body)
      });
      res = await r.json();
    } catch (e) {
      const err = new Error('Sunucuya ulaşılamadı. Bağlantını kontrol edip tekrar dene.');
      err.code = 'network';
      throw err;
    }
    if (!res || !res.ok) {
      const err = new Error((res && res.message) || 'Beklenmeyen bir hata oluştu.');
      err.code = (res && res.error) || 'server_error';
      throw err;
    }
    return res;
  }

  async function callWithReauth(action, extra) {
    try {
      return await api(action, extra);
    } catch (e) {
      if (e.code !== 'unauthorized') throw e;
      dropToken();
      state.token = await authenticate();
      if (!state.token) {
        state.phase = 'login';
        throw e;
      }
      return api(action, extra);
    }
  }

  async function loadStatus() {
    const seq = ++state.seq;
    state.phase = 'loading';
    render();
    try {
      const data = await callWithReauth('status');
      if (seq !== state.seq) return;
      state.data = data;
      state.phase = 'ready';
      state.error = null;
    } catch (e) {
      if (seq !== state.seq) return;
      if (state.phase !== 'login') state.phase = 'error';
      state.error = e;
    }
    render();
  }

  async function act(kind) {
    if (state.busy) return;
    state.busy = true;
    state.actionError = null;
    render();
    try {
      const data = await callWithReauth(kind, { note: state.noteDraft });
      state.data = data;
      state.confirming = null;
      state.noteDraft = '';
    } catch (e) {
      state.actionError = e.message;
    }
    state.busy = false;
    render();
  }

  // ---------- LiveChat widget ----------

  function applyTheme(theme) {
    document.documentElement.setAttribute('data-theme', theme === 'dark' ? 'dark' : 'light');
  }

  function onProfile(p) {
    const valid = !!(p && p.chat && p.chat.id);
    const same = valid && state.profile && state.profile.id === p.id && state.profile.chat.id === p.chat.id;
    state.profile = valid ? p : null;
    if (!state.token) return; // auth/login flow picks the profile up when it finishes
    if (!valid) {
      state.data = null;
      state.phase = 'nochat';
      render();
      return;
    }
    if (same && state.data) return;
    state.data = null;
    state.confirming = null;
    state.actionError = null;
    state.noteDraft = '';
    loadStatus();
  }

  function afterAuth() {
    if (state.profile) loadStatus();
    else { state.phase = 'nochat'; render(); }
  }

  async function boot() {
    if (!CFG.clientId || !CFG.apiUrl || /WIDGET_APP_CLIENT_ID|ADMIN_API_URL/.test(CFG.clientId + CFG.apiUrl)) {
      state.phase = 'setup';
      render();
      return;
    }
    let widget;
    try {
      widget = await Promise.race([
        window.LiveChat.createDetailsWidget(),
        new Promise(function (_, reject) { setTimeout(function () { reject(new Error('timeout')); }, CONNECT_TIMEOUT_MS); })
      ]);
    } catch (e) {
      state.phase = 'outside';
      render();
      return;
    }
    state.widget = widget;
    try { applyTheme(widget.getTheme && widget.getTheme()); } catch (e) { /* ignore */ }
    widget.on('change_theme', function (d) { applyTheme(d && d.theme); });
    widget.on('customer_profile', onProfile);
    const current = widget.getCustomerProfile && widget.getCustomerProfile();
    if (current) state.profile = current.chat && current.chat.id ? current : null;

    state.phase = 'auth';
    render();
    state.token = await authenticate();
    if (!state.token) {
      state.phase = 'login';
      render();
      return;
    }
    afterAuth();
  }

  // ---------- rendering ----------

  function message(text, extra) {
    return [h('p', { class: 'state-msg', text: text }), extra || null];
  }

  function viewPlate(d) {
    const e = d.entry;
    const blocked = d.blocked;
    let meta;
    if (e && e.updated_by) {
      meta = who(e.updated_by) + (blocked ? ' engelledi, ' : ' listeden çıkardı, ') + formatDate(e.updated_at || e.added_at);
    } else if (e) {
      meta = blocked ? 'Listede, eklenme: ' + formatDate(e.added_at) : 'Listede pasif';
    } else {
      meta = 'Listede değil';
    }
    return h('section', { class: 'plate' + (blocked ? ' is-blocked' : ''), 'aria-label': 'Engel durumu' },
      h('p', { class: 'plate-state', text: blocked ? 'Engelli' : 'Engelli değil' }),
      h('p', { class: 'plate-id', text: d.party_id }),
      h('p', { class: 'plate-meta', text: meta }),
      blocked && e && e.note ? h('p', { class: 'plate-note', text: e.note }) : null
    );
  }

  function viewForm(d) {
    const kind = d.blocked ? 'unblock' : 'block';
    const note = h('textarea', {
      id: 'note',
      maxlength: '300',
      placeholder: kind === 'block' ? 'Örneğin: sürekli aynı konuda tekrar yazıyor' : 'Örneğin: TRB talebiyle kaldırıldı',
      oninput: function (ev) { state.noteDraft = ev.target.value; },
      disabled: state.busy
    });
    note.value = state.noteDraft;

    let actions;
    if (state.confirming === kind) {
      actions = h('div', { class: 'actions' },
        h('p', { class: 'confirm-q', text: kind === 'block'
          ? d.party_id + ' engellensin mi?'
          : d.party_id + ' listeden çıkarılsın mı?' }),
        h('button', {
          id: 'confirm',
          class: kind === 'block' ? 'btn-danger' : 'btn-outline',
          disabled: state.busy,
          onclick: function () { act(kind); }
        }, state.busy ? (kind === 'block' ? 'Engelleniyor…' : 'Çıkarılıyor…') : (kind === 'block' ? 'Evet, engelle' : 'Evet, listeden çıkar')),
        h('button', {
          id: 'cancel',
          class: 'btn-text',
          disabled: state.busy,
          onclick: function () { state.confirming = null; render(); }
        }, 'Vazgeç')
      );
    } else {
      actions = h('div', { class: 'actions' },
        h('button', {
          id: 'primary',
          class: kind === 'block' ? 'btn-danger' : 'btn-outline',
          onclick: function () { state.confirming = kind; render(); var c = document.getElementById('confirm'); if (c) c.focus(); }
        }, kind === 'block' ? 'Engelle' : 'Listeden çıkar')
      );
    }

    return h('div', { class: 'form' },
      h('label', { for: 'note', text: kind === 'block' ? 'Engelleme nedeni (isteğe bağlı)' : 'Çıkarma notu (isteğe bağlı)' }),
      note,
      actions,
      state.actionError ? h('p', { class: 'error', role: 'alert', text: state.actionError }) : null,
      h('p', { class: 'hint', text: kind === 'block'
        ? 'Üye her yeni chat denemesinde otomatik banlanır.'
        : 'Listeden çıkarmak mevcut banı kaldırmaz. Banı LiveChat ayarlarından ayrıca kaldır.' })
    );
  }

  function viewAttempts(list) {
    return [
      h('h2', { text: 'Engellenen denemeler' }),
      list && list.length
        ? h.apply(null, ['ul', { class: 'list' }].concat(list.map(function (a) {
          const thread = String(a.chat || '').split('/').pop();
          return h('li', null,
            h('span', { class: 'when', text: formatDate(a.time) }),
            h('span', null, ATTEMPT_LABEL[a.status] || a.status, thread ? h('span', { class: 'sub', text: 'Chat ' + thread }) : null)
          );
        })))
        : h('p', { class: 'empty', text: 'Henüz engellenen deneme yok.' })
    ];
  }

  function viewHistory(list) {
    if (!list || !list.length) return [];
    return [
      h('h2', { text: 'Geçmiş' }),
      h.apply(null, ['ul', { class: 'list' }].concat(list.map(function (x) {
        const verb = x.action === 'BLOCK' ? ' engelledi' : x.action === 'UNBLOCK' ? ' listeden çıkardı' : ' ' + x.action;
        return h('li', null,
          h('span', { class: 'when', text: formatDate(x.time) }),
          h('span', null, who(x.by) + verb, x.note ? h('span', { class: 'sub', text: x.note }) : null)
        );
      })))
    ];
  }

  function viewReady(d) {
    const out = [];
    if (!d.party_id) {
      out.push(h('section', { class: 'plate', 'aria-label': 'Engel durumu' },
        h('p', { class: 'plate-state', text: 'party_id yok' }),
        h('p', { class: 'plate-meta', text: 'Üye giriş yapmadan yazıyor olabilir. party_id olmadan engelleme yapılamaz.' })
      ));
    } else {
      out.push(viewPlate(d));
      if (d.notice && NOTICE_TEXT[d.notice]) out.push(h('p', { class: 'notice', role: 'status', text: NOTICE_TEXT[d.notice] }));
      out.push(viewForm(d));
      out.push.apply(out, viewAttempts(d.attempts));
      out.push.apply(out, viewHistory(d.history));
    }
    if (d.agent && d.agent.email) out.push(h('p', { class: 'foot', text: d.agent.email + ' olarak işlem yapıyorsun.' }));
    return out;
  }

  function retryButton() {
    return h('div', { class: 'actions' }, h('button', { id: 'retry', class: 'btn-outline', onclick: function () { loadStatus(); } }, 'Tekrar dene'));
  }

  function render() {
    const root = document.getElementById('app');
    if (!root) return;
    let nodes;
    switch (state.phase) {
      case 'setup':
        nodes = message('Widget ayarları eksik: config.js içindeki clientId ve apiUrl doldurulmalı.');
        break;
      case 'outside':
        nodes = message('Bu sayfa LiveChat içinde, chat detayları panelinde açılmalı.');
        break;
      case 'auth':
        nodes = message('LiveChat hesabınla doğrulanıyor…');
        break;
      case 'login':
        nodes = message('Devam etmek için LiveChat hesabınla giriş yap.',
          h('div', { class: 'actions' }, h('button', { id: 'login', class: 'btn-outline', onclick: loginWithPopup }, 'LiveChat ile giriş yap')));
        if (state.error && state.error.message && state.error.code !== 'unauthorized') {
          nodes.push(h('p', { class: 'error', role: 'alert', text: state.error.message }));
        }
        break;
      case 'nochat':
        nodes = message('Bir chat açtığında üyenin engel durumu burada görünür.');
        break;
      case 'loading':
        nodes = message('Yükleniyor…');
        break;
      case 'error': {
        const e = state.error || {};
        const isSetup = e.code === 'setup_required';
        nodes = [
          h('p', { class: isSetup ? 'state-msg selectable' : 'error', role: 'alert', text: e.message || 'Beklenmeyen bir hata oluştu.' }),
          isSetup ? null : retryButton()
        ];
        break;
      }
      case 'ready':
        nodes = viewReady(state.data || {});
        break;
      default:
        nodes = message('Yükleniyor…');
    }
    root.setAttribute('aria-busy', state.phase === 'loading' || state.busy ? 'true' : 'false');
    root.replaceChildren.apply(root, nodes.filter(Boolean));
  }

  window.LCB = { state: state, formatDate: formatDate, who: who, boot: boot, render: render };
  if (!window.LCB_NO_BOOT) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
  }
})();
