// sidebar/sidebar.js — логика боковой панели "Email Plugin Overlay" (Pencil 9OOF5).
//
// Архитектура:
//   • При загрузке: chrome.storage.local { backend_url, api_key } → fetch
//     /api/messages?important=1&limit=1 (для AI-секции) и /api/messages?limit=10
//     (для списка проанализированных писем).
//   • WebSocket-сообщения от background SW (chrome.runtime.onMessage):
//       new_message → перезапрос обоих списков
//       updated    → точечное обновление + ререндер
//       ws_status  → обновление индикатора
//   • Кнопки "Ответить / Создать событие / Отложить" — placeholder (toast).
//   • "Отметить всё прочитанным" → PATCH каждое непрочитанное письмо is_read:1.
//   • "Открыть приложение" → chrome.tabs.create на backend_url.
//   • "Свернуть" — postMessage parent { type:'mh_collapse' } (handled by content
//     script gmail.js / yandex.js).

(() => {
  'use strict';

  // ── state ─────────────────────────────────────────────────────────────
  /** @type {Map<number, any>} */
  const messagesById = new Map();
  /** @type {any|null} */
  let topImportant = null;
  let settings = { backend_url: '', api_key: '' };
  let serverOnline = false;

  const $ = (sel) => document.querySelector(sel);

  // ── storage ───────────────────────────────────────────────────────────
  async function loadSettings() {
    const s = await chrome.storage.local.get(['backend_url', 'api_key']);
    settings.backend_url = (s.backend_url || '').replace(/\/+$/, '');
    settings.api_key = s.api_key || '';
  }

  // ── fetch helpers ─────────────────────────────────────────────────────
  async function checkServer() {
    if (!settings.backend_url) return false;
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 3000);
      const res = await fetch(`${settings.backend_url}/api/health`, {
        method: 'GET',
        signal: ctrl.signal,
      });
      clearTimeout(t);
      return res.ok;
    } catch {
      return false;
    }
  }

  async function apiGet(path) {
    if (!settings.api_key) {
      throw new Error('API Key не задан. Открой Options.');
    }
    const res = await fetch(`${settings.backend_url}${path}`, {
      method: 'GET',
      headers: { 'X-API-Key': settings.api_key },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
  }

  async function apiPatch(path, body) {
    if (!settings.api_key) throw new Error('API Key не задан.');
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

  // ── normalisation ─────────────────────────────────────────────────────
  function ensureClassification(m) {
    if (!m) return m;
    if (!m.classification && m.classification_json) {
      try {
        m.classification = JSON.parse(m.classification_json);
      } catch {
        m.classification = null;
      }
    }
    return m;
  }

  // ── refresh ───────────────────────────────────────────────────────────
  async function refresh() {
    if (!settings.backend_url || !settings.api_key) {
      renderListError('Backend URL и/или API Key не заданы. Открой Options.');
      renderAIEmpty('Откройте Options, чтобы подключить backend.');
      return;
    }

    serverOnline = await checkServer();
    if (!serverOnline) {
      messagesById.clear();
      topImportant = null;
      renderListError('Сервер Mail Helper недоступен. Запусти ./setup.sh');
      renderAIEmpty('Сервер недоступен.');
      return;
    }

    try {
      // 1) Top important — для AI-секции.
      const impData = await apiGet('/api/messages?important=1&limit=1');
      const impList = Array.isArray(impData.messages) ? impData.messages : [];
      topImportant = impList[0] ? ensureClassification(impList[0]) : null;
      renderAI();
    } catch (err) {
      renderAIEmpty(`Не удалось загрузить AI-анализ: ${err?.message || err}`);
    }

    try {
      // 2) Список последних 10 писем.
      const data = await apiGet('/api/messages?limit=10');
      const list = Array.isArray(data.messages) ? data.messages : [];
      messagesById.clear();
      for (const m of list) {
        ensureClassification(m);
        messagesById.set(m.id, m);
      }
      renderList();
    } catch (err) {
      renderListError(err?.message || String(err));
    }
  }

  // ── rendering helpers ─────────────────────────────────────────────────
  function escapeHtml(s) {
    if (s === null || s === undefined) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function senderName(m) {
    const raw = m.from_addr || m.from || '';
    if (!raw) return '(unknown)';
    // "Name <email>" → "Name"; иначе вернуть как есть.
    const match = raw.match(/^\s*"?([^"<]+?)"?\s*<.+>\s*$/);
    return match ? match[1].trim() : raw;
  }

  function priorityClass(p) {
    const v = String(p || '').toLowerCase();
    if (v === 'low' || v === 'низкий') return 'mh-pr-badge--low';
    if (v === 'medium' || v === 'mid' || v === 'средний') return 'mh-pr-badge--mid';
    return ''; // high — default red
  }

  function priorityLabel(p) {
    const v = String(p || '').toLowerCase();
    if (v === 'low' || v === 'низкий') return 'Низкий приоритет';
    if (v === 'medium' || v === 'mid' || v === 'средний') return 'Средний приоритет';
    if (v === 'high' || v === 'высокий') return 'Высокий приоритет';
    return 'Высокий приоритет';
  }

  // ── AI section render ─────────────────────────────────────────────────
  function renderAI() {
    const body = $('#mh-ai-body');
    if (!body) return;
    if (!topImportant) {
      renderAIEmpty('Пока нет важных писем для анализа.');
      return;
    }

    const m = topImportant;
    const cls = m.classification || {};
    const summary =
      cls.summary || cls.reason || m.snippet || '(нет краткого содержания)';
    const category = cls.category || '';
    const priority = cls.priority || (m.is_important ? 'high' : '');
    const tags = [];
    if (category) tags.push(category);
    if (Array.isArray(cls.tags)) tags.push(...cls.tags.slice(0, 3));

    const tagHtml = tags
      .map((t) => `<span class="mh-tag">${escapeHtml(t)}</span>`)
      .join('');

    body.innerHTML = `
      <span class="mh-pr-badge ${priorityClass(priority)}">${escapeHtml(priorityLabel(priority))}</span>
      <p class="mh-summary">${escapeHtml(summary)}</p>
      ${tagHtml ? `<div class="mh-tag-row">${tagHtml}</div>` : ''}
      <div class="mh-action-row">
        <button class="mh-action" type="button" data-action="reply">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 17 4 12 9 7"/><path d="M20 18v-2a4 4 0 0 0-4-4H4"/></svg>
          <span>Ответить</span>
        </button>
        <button class="mh-action mh-action--ghost" type="button" data-action="event">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
          <span>Создать событие</span>
        </button>
        <button class="mh-action mh-action--ghost" type="button" data-action="snooze">
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
          <span>Отложить</span>
        </button>
      </div>
    `;

    body.querySelectorAll('[data-action]').forEach((btn) => {
      btn.addEventListener('click', () => {
        toast('В разработке');
      });
    });
  }

  function renderAIEmpty(msg) {
    const body = $('#mh-ai-body');
    if (!body) return;
    body.innerHTML = `<div class="mh-empty mh-empty--inline">${escapeHtml(msg)}</div>`;
  }

  // ── List render ───────────────────────────────────────────────────────
  function getVisibleMessages() {
    const all = Array.from(messagesById.values());
    all.sort((a, b) => {
      if (!!b.is_important !== !!a.is_important) {
        return Number(b.is_important) - Number(a.is_important);
      }
      const da = a.date ? Date.parse(a.date) : 0;
      const db = b.date ? Date.parse(b.date) : 0;
      return (db || 0) - (da || 0);
    });
    return all;
  }

  function renderList() {
    const list = $('#mh-list');
    if (!list) return;
    const items = getVisibleMessages();
    if (items.length === 0) {
      list.innerHTML = `<li class="mh-empty">Нет писем для отображения.</li>`;
      return;
    }
    list.innerHTML = items.map(renderCard).join('');

    list.querySelectorAll('.mh-card').forEach((card) => {
      card.addEventListener('click', () => {
        const id = Number(card.getAttribute('data-id'));
        openMessage(id);
      });
    });
  }

  function renderCard(m) {
    const cls = m.classification || {};
    const category = cls.category || '';
    const desc = cls.summary || cls.reason || m.snippet || '';
    const important = !!m.is_important;
    return `
      <li class="mh-card${important ? ' mh-card--important' : ''}" data-id="${m.id}">
        <div class="mh-card-h">
          <span class="mh-card-from">${escapeHtml(senderName(m))}</span>
          ${category ? `<span class="mh-chip mh-chip--cat">${escapeHtml(category)}</span>` : ''}
        </div>
        <div class="mh-card-subj">${escapeHtml(m.subject || '(без темы)')}</div>
        ${desc ? `<div class="mh-card-desc">${escapeHtml(desc)}</div>` : ''}
      </li>
    `;
  }

  function renderListError(msg) {
    const list = $('#mh-list');
    if (!list) return;
    list.innerHTML = `<li class="mh-empty mh-empty--err">${escapeHtml(msg)}</li>`;
  }

  // ── Actions ───────────────────────────────────────────────────────────
  async function markAllAnalysed() {
    if (!settings.backend_url || !settings.api_key) {
      toast('Backend не настроен', true);
      return;
    }
    const targets = Array.from(messagesById.values()).filter(
      (m) => m.is_read === 0 || m.is_read === false,
    );
    if (targets.length === 0) {
      toast('Нет непрочитанных писем');
      return;
    }
    const btn = $('#mh-mark-all');
    if (btn) btn.disabled = true;
    let ok = 0;
    let fail = 0;
    for (const m of targets) {
      try {
        await apiPatch(`/api/messages/${m.id}`, { is_read: 1 });
        m.is_read = 1;
        ok += 1;
      } catch {
        fail += 1;
      }
    }
    if (btn) btn.disabled = false;
    renderList();
    toast(
      fail === 0
        ? `Отмечено: ${ok}`
        : `Готово ${ok}, ошибок ${fail}`,
      fail > 0,
    );
  }

  function openApp() {
    if (!settings.backend_url) {
      toast('Backend URL не задан', true);
      return;
    }
    try {
      chrome.tabs?.create?.({ url: settings.backend_url });
    } catch (err) {
      // Из iframe sandbox chrome.tabs может быть недоступен — fallback через background.
      try {
        chrome.runtime?.sendMessage?.({
          type: 'open_url',
          url: settings.backend_url,
        });
      } catch {
        toast('Не удалось открыть приложение', true);
      }
    }
  }

  function openMessage(id) {
    try {
      chrome.runtime.sendMessage({ type: 'focus_message', id });
    } catch (err) {
      console.warn('focus_message failed', err);
    }
  }

  function collapsePanel() {
    try {
      window.parent?.postMessage({ type: 'mh_collapse' }, '*');
    } catch {
      /* noop */
    }
  }

  // ── Live updates ──────────────────────────────────────────────────────
  function onRuntimeMessage(msg) {
    if (!msg || typeof msg.type !== 'string') return;
    switch (msg.type) {
      case 'new_message': {
        const data = msg.data || {};
        if (!data.id) return;
        if (data.important) {
          toast(`Новое важное: ${data.subject || '(без темы)'}`);
        }
        // Полный refresh — проще и надёжнее, чем точечная мерж-логика.
        refresh().catch(() => {});
        return;
      }
      case 'updated': {
        const data = msg.data || {};
        if (!data.id) return;
        const m = messagesById.get(data.id);
        if (!m) return;
        if (data.is_read !== undefined) m.is_read = data.is_read ? 1 : 0;
        if (data.is_important !== undefined) m.is_important = data.is_important ? 1 : 0;
        renderList();
        if (topImportant && topImportant.id === data.id) {
          if (data.is_important !== undefined) topImportant.is_important = data.is_important ? 1 : 0;
          if (data.is_read !== undefined) topImportant.is_read = data.is_read ? 1 : 0;
          renderAI();
        }
        return;
      }
      case 'ws_status': {
        const st = msg.data?.state || 'unknown';
        setWsStatus(st);
        if (st === 'connected' && !serverOnline) {
          refresh().catch(() => {});
        }
        return;
      }
      case 'focus_message': {
        const id = msg.id;
        const el = document.querySelector(`.mh-card[data-id="${id}"]`);
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        return;
      }
      default:
        return;
    }
  }

  function setWsStatus(state) {
    const dot = $('#mh-ws-dot');
    if (!dot) return;
    dot.classList.remove('connected', 'connecting', 'disconnected');
    if (state === 'connected') dot.classList.add('connected');
    else if (state === 'connecting') dot.classList.add('connecting');
    else dot.classList.add('disconnected');
  }

  async function requestWsStatus() {
    try {
      const res = await chrome.runtime.sendMessage({ type: 'get_ws_status' });
      if (res && res.state) setWsStatus(res.state);
    } catch {
      /* SW asleep — будет push через ws_status позже */
    }
  }

  // ── Toast ─────────────────────────────────────────────────────────────
  let toastTimer = null;
  function toast(text, isErr = false) {
    let el = document.querySelector('.mh-toast');
    if (!el) {
      el = document.createElement('div');
      el.className = 'mh-toast';
      document.body.appendChild(el);
    }
    el.className = `mh-toast${isErr ? ' err' : ''} show`;
    el.textContent = text;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
  }

  // ── Wiring ────────────────────────────────────────────────────────────
  function wire() {
    $('#mh-mark-all')?.addEventListener('click', () => {
      markAllAnalysed().catch((err) => toast(err?.message || 'Ошибка', true));
    });
    $('#mh-open-app')?.addEventListener('click', (ev) => {
      ev.preventDefault();
      openApp();
    });
    $('#mh-min-btn')?.addEventListener('click', () => collapsePanel());
  }

  // ── Boot ──────────────────────────────────────────────────────────────
  async function boot() {
    wire();
    setWsStatus('connecting');
    try {
      await loadSettings();
    } catch (err) {
      renderListError(`Ошибка чтения storage: ${err?.message || err}`);
      return;
    }
    if (!settings.backend_url || !settings.api_key) {
      renderListError('Backend URL и/или API Key не заданы. Открой Options.');
      renderAIEmpty('Откройте Options, чтобы подключить backend.');
      return;
    }
    chrome.runtime.onMessage?.addListener((msg) => {
      try {
        onRuntimeMessage(msg);
      } catch (err) {
        console.warn('sidebar onMessage error', err);
      }
    });
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
