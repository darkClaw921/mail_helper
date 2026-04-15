// sidebar/sidebar.js — логика боковой панели.
//
// Загрузка:
//   1. читает chrome.storage.local { backend_url, api_key }
//   2. GET {backend_url}/api/messages?<filter>&limit=50 с X-API-Key
//   3. рендерит список, важные сверху
//
// Live-события:
//   chrome.runtime.onMessage — приходит от background SW:
//     { type: 'new_message', data: {...} }   → вставляем сверху
//     { type: 'updated', data: { id, is_read?, is_important? } } → обновляем
//     { type: 'ws_status', data: { state } } → обновляем индикатор
//
// User actions:
//   клик "Mark read"    → PATCH /api/messages/:id { is_read: 1 }
//   клик "Open message" → chrome.runtime.sendMessage({ type:'focus_message', id })
//                         (background откроет Gmail/Yandex, если нужно)
//
// State:
//   messagesById: Map<number, message>
//   currentFilter: 'important' | 'unread' | 'all'

(() => {
  'use strict';

  /** @type {Map<number, any>} */
  const messagesById = new Map();
  let currentFilter = 'important';
  let settings = { backend_url: 'http://localhost:3000', api_key: '' };

  const $ = (sel) => document.querySelector(sel);

  // ── storage ──────────────────────────────────────────────────────────
  async function loadSettings() {
    const s = await chrome.storage.local.get(['backend_url', 'api_key']);
    settings.backend_url = (s.backend_url || 'http://localhost:3000').replace(/\/+$/, '');
    settings.api_key = s.api_key || '';
  }

  // ── fetch ────────────────────────────────────────────────────────────
  async function apiGet(path) {
    if (!settings.api_key) {
      throw new Error('API Key not configured. Open Settings.');
    }
    const res = await fetch(`${settings.backend_url}${path}`, {
      method: 'GET',
      headers: { 'X-API-Key': settings.api_key },
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    return res.json();
  }

  async function apiPatch(path, body) {
    if (!settings.api_key) throw new Error('API Key not configured.');
    const res = await fetch(`${settings.backend_url}${path}`, {
      method: 'PATCH',
      headers: {
        'X-API-Key': settings.api_key,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  // ── filter → query ───────────────────────────────────────────────────
  function buildQuery(filter) {
    const qs = new URLSearchParams();
    qs.set('limit', '50');
    if (filter === 'unread') qs.set('unread', '1');
    if (filter === 'important') qs.set('important', '1');
    return `?${qs.toString()}`;
  }

  async function refresh() {
    const empty = $('#empty-state');
    if (empty) empty.textContent = 'Loading…';

    try {
      const data = await apiGet(`/api/messages${buildQuery(currentFilter)}`);
      const list = Array.isArray(data.messages) ? data.messages : [];
      messagesById.clear();
      for (const m of list) {
        // classification_json may be parsed into .classification already.
        ensureClassification(m);
        messagesById.set(m.id, m);
      }
      render();
    } catch (err) {
      renderError(err?.message || String(err));
    }
  }

  function ensureClassification(m) {
    if (!m.classification && m.classification_json) {
      try {
        m.classification = JSON.parse(m.classification_json);
      } catch {
        m.classification = null;
      }
    }
    return m;
  }

  // ── sorting / filtering ──────────────────────────────────────────────
  function getVisibleMessages() {
    const all = Array.from(messagesById.values());
    const filtered = all.filter((m) => {
      if (currentFilter === 'unread') return m.is_read === 0;
      if (currentFilter === 'important') return m.is_important === 1;
      return true;
    });
    filtered.sort((a, b) => {
      // Important first, then unread, then by date desc.
      if (!!b.is_important !== !!a.is_important) {
        return b.is_important - a.is_important;
      }
      if (!!b.is_read !== !!a.is_read) {
        // unread (is_read=0) ahead of read
        return a.is_read - b.is_read;
      }
      const da = a.date ? Date.parse(a.date) : 0;
      const db = b.date ? Date.parse(b.date) : 0;
      return (db || 0) - (da || 0);
    });
    return filtered;
  }

  // ── rendering ────────────────────────────────────────────────────────
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function formatDate(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    if (sameDay) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function render() {
    const container = $('#messages');
    if (!container) return;
    const list = getVisibleMessages();

    if (list.length === 0) {
      container.innerHTML = `<div class="empty" id="empty-state">No messages.</div>`;
      updateCount(0);
      return;
    }

    const html = list.map(renderOne).join('');
    container.innerHTML = html;
    updateCount(list.length);

    // Wire up click handlers (delegation would also work).
    container.querySelectorAll('[data-action="mark_read"]').forEach((btn) => {
      btn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = Number(btn.getAttribute('data-id'));
        markRead(id).catch((err) => toast(err?.message || 'Mark read failed', true));
      });
    });
    container.querySelectorAll('[data-action="open"]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const id = Number(el.getAttribute('data-id'));
        openMessage(id);
      });
    });
    container.querySelectorAll('.msg').forEach((card) => {
      card.addEventListener('click', (ev) => {
        const id = Number(card.getAttribute('data-id'));
        openMessage(id);
      });
    });
  }

  function renderOne(m) {
    const classification = m.classification || null;
    const reason = classification?.reason || '';
    const category = classification?.category || '';
    const important = m.is_important === 1;
    const unread = m.is_read === 0;

    return `
      <div class="msg${important ? ' important' : ''}${unread ? ' unread' : ''}" data-id="${m.id}">
        <div class="msg-row1">
          ${important ? '<span class="msg-important-dot" title="Important"></span>' : ''}
          <span class="msg-from">${escapeHtml(m.from_addr || m.from || '(unknown)')}</span>
          <span class="msg-date">${escapeHtml(formatDate(m.date))}</span>
        </div>
        <div class="msg-subject">${escapeHtml(m.subject || '(no subject)')}</div>
        <div class="msg-snippet">${escapeHtml(m.snippet || '')}</div>
        ${
          category || reason
            ? `<div class="msg-tags">
                 ${category ? `<span class="tag category">${escapeHtml(category)}</span>` : ''}
                 ${reason ? `<span class="tag reason" title="${escapeHtml(reason)}">${escapeHtml(reason)}</span>` : ''}
               </div>`
            : ''
        }
        <div class="msg-actions">
          ${
            unread
              ? `<button class="msg-action-btn primary" data-action="mark_read" data-id="${m.id}">Mark read</button>`
              : `<span class="tag">read</span>`
          }
          <button class="msg-action-btn" data-action="open" data-id="${m.id}">Open</button>
        </div>
      </div>
    `;
  }

  function renderError(msg) {
    const container = $('#messages');
    container.innerHTML = `<div class="empty error" id="empty-state">${escapeHtml(msg)}</div>`;
  }

  function updateCount(n) {
    $('#count').textContent = `${n} ${n === 1 ? 'message' : 'messages'}`;
  }

  // ── actions ──────────────────────────────────────────────────────────
  async function markRead(id) {
    const m = messagesById.get(id);
    if (!m) return;
    m.is_read = 1; // optimistic
    render();
    try {
      await apiPatch(`/api/messages/${id}`, { is_read: 1 });
      toast('Marked as read');
    } catch (err) {
      // revert on error
      m.is_read = 0;
      render();
      throw err;
    }
  }

  function openMessage(id) {
    try {
      chrome.runtime.sendMessage({ type: 'focus_message', id });
    } catch (err) {
      // best-effort; may fail if SW asleep
      console.warn('focus_message failed', err);
    }
  }

  // ── live updates (runtime messages from background SW) ───────────────
  function onRuntimeMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'new_message': {
        const data = msg.data || {};
        // sidebar/list payload comes from ws hub broadcast; fields:
        // { id, account_id, subject, from, snippet, important, classification }
        if (!data.id) return;
        // Merge/insert minimal record; schedule full refresh to pull body/date.
        messagesById.set(data.id, {
          id: data.id,
          account_id: data.account_id,
          subject: data.subject,
          from_addr: data.from,
          snippet: data.snippet,
          is_read: 0,
          is_important: data.important ? 1 : 0,
          classification: data.classification || null,
          date: new Date().toISOString(),
        });
        render();
        // Background refresh to normalize fields (date, etc.).
        refresh().catch(() => {});
        if (data.important) {
          toast(`New important: ${data.subject || '(no subject)'}`);
        }
        return;
      }
      case 'updated': {
        const data = msg.data || {};
        if (!data.id) return;
        const m = messagesById.get(data.id);
        if (!m) return;
        if (data.is_read !== undefined) m.is_read = data.is_read ? 1 : 0;
        if (data.is_important !== undefined) m.is_important = data.is_important ? 1 : 0;
        render();
        return;
      }
      case 'ws_status': {
        setWsStatus(msg.data?.state || 'unknown');
        return;
      }
      case 'focus_message': {
        // parent dispatched (e.g. from notification click); scroll into view
        const id = msg.id;
        const el = document.querySelector(`.msg[data-id="${id}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      default:
        // ignore unknown
        return;
    }
  }

  // ── WS status indicator ──────────────────────────────────────────────
  function setWsStatus(state) {
    const dot = $('#ws-dot');
    const label = $('#ws-label');
    if (!dot || !label) return;
    dot.classList.remove('connected', 'connecting', 'disconnected');
    if (state === 'connected') {
      dot.classList.add('connected');
      label.textContent = 'live';
    } else if (state === 'connecting') {
      dot.classList.add('connecting');
      label.textContent = 'connecting';
    } else {
      dot.classList.add('disconnected');
      label.textContent = 'offline';
    }
  }

  async function requestWsStatus() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'get_ws_status' });
      if (res && res.state) setWsStatus(res.state);
    } catch {
      // SW might be asleep; it will send ws_status when it wakes
    }
  }

  // ── toast ────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(text, isErr = false) {
    let el = document.querySelector('.toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'toast';
      document.body.appendChild(el);
    }
    el.className = `toast${isErr ? ' err' : ''} show`;
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // ── filter buttons ───────────────────────────────────────────────────
  function wireFilters() {
    document.querySelectorAll('.filter[data-filter]').forEach((btn) => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.filter[data-filter]').forEach((b) =>
          b.classList.remove('active'),
        );
        btn.classList.add('active');
        currentFilter = btn.getAttribute('data-filter');
        refresh();
      });
    });
    $('#refresh-btn')?.addEventListener('click', () => refresh());
    $('#open-options')?.addEventListener('click', () => {
      chrome.runtime.openOptionsPage?.();
    });
  }

  // ── boot ─────────────────────────────────────────────────────────────
  async function boot() {
    wireFilters();
    setWsStatus('connecting');
    try {
      await loadSettings();
    } catch (err) {
      renderError(`Failed to read storage: ${err?.message || err}`);
      return;
    }
    if (!settings.api_key) {
      renderError('API Key not configured. Open Settings.');
      return;
    }
    chrome.runtime.onMessage?.addListener((msg) => {
      try {
        onRuntimeMessage(msg);
      } catch (err) {
        console.warn('sidebar onMessage error', err);
      }
    });
    // React to settings changes live.
    chrome.storage.onChanged?.addListener(async (changes, area) => {
      if (area !== 'local') return;
      if (changes.backend_url || changes.api_key) {
        await loadSettings();
        refresh().catch(() => {});
      }
    });
    await refresh();
    requestWsStatus();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
