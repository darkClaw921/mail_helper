// views/messages.js — Входящие (#/inbox).
//
// Phase 3 редизайн: табличный стиль с табами (Все / Непрочитанные / Важные).
// Сохраняет существующий функционал — фильтры, account-selector, mark
// read/unread, raskryvaemye details (тело письма + JSON classification),
// WebSocket auto-update (/ws?token=<api_key>) с обработкой `new_message` и
// `updated`.

import { accountsApi, messagesApi } from '../api.js';
import {
  Card,
  SectionHeader,
  Tabs,
  TagBadge,
  Button,
  EmptyState,
  Select,
} from '../components/ui.js';
import { h, formatRelative, statusDot, showError } from './util.js';

const state = {
  messages: [],
  total: 0,
  filter: 'all', // all | unread | important
  accountId: '',
  accounts: [],
  expanded: new Set(),
  ws: null,
  search: '',
};

let listHostRef = null;
let countersRef = { all: 0, unread: 0, important: 0 };

/* ----------------------------- Хелперы строки -------------------------- */

function tagsFor(cls) {
  if (!cls || typeof cls !== 'object') return [];
  if (cls.error) return [TagBadge({ label: 'LLM ошибка', variant: 'red' })];
  const out = [];
  if (cls.important) out.push(TagBadge({ label: 'Важное', variant: 'red' }));
  if (Array.isArray(cls.tags)) {
    for (const tag of cls.tags.slice(0, 3)) {
      const lower = String(tag).toLowerCase();
      let variant = 'neutral';
      if (lower.includes('встреч')) variant = 'cyan';
      else if (lower.includes('финан') || lower.includes('счёт')) variant = 'orange';
      else if (lower.includes('promo') || lower.includes('marketing')) variant = 'purple';
      else if (lower.includes('work') || lower.includes('работ')) variant = 'green';
      out.push(TagBadge({ label: String(tag), variant }));
    }
  }
  return out;
}

function statusFor(message) {
  const cls = message.classification;
  if (cls?.error) return { key: 'error', label: 'Ошибка' };
  if (!message.is_read) return { key: 'pending', label: 'Новое' };
  if (cls?.important) return { key: 'warning', label: 'Важное' };
  if (cls) return { key: 'success', label: 'Обработано' };
  return { key: 'idle', label: 'Прочитано' };
}

/* ----------------------------- Детали письма --------------------------- */

function renderDetailsRow(m) {
  const row = document.createElement('tr');
  row.dataset.detail = String(m.id);
  const td = document.createElement('td');
  td.colSpan = 6;
  td.className = 'p-0 max-w-0';
  const box = h('div', { class: 'border-l-4 border-[color:var(--color-accent-purple)] bg-[color:var(--color-bg-elevated)] p-4 overflow-hidden max-w-full' });

  const tokensLabel = m.tokens_used != null
    ? `Токены LLM: ${Number(m.tokens_used).toLocaleString('ru-RU')}`
    : 'Токены LLM: —';
  const meta = h('div', { class: 'mb-3 grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-1 text-xs text-[color:var(--color-text-secondary)] break-all' }, [
    h('div', {}, `From: ${m.from_addr || '—'}`),
    h('div', {}, `To: ${m.to_addr || '—'}`),
    h('div', {}, `UID: ${m.uid}`),
    h('div', {}, `Account: #${m.account_id}`),
    h('div', { class: 'sm:col-span-2 font-medium text-[color:var(--color-text-primary)]' }, tokensLabel),
  ]);
  box.appendChild(meta);

  if (m.classification) {
    box.appendChild(h('div', { class: 'mb-1 text-xs font-semibold text-[color:var(--color-text-primary)]' }, 'LLM classification:'));
    box.appendChild(
      h('pre', {
        class: 'mb-3 max-h-40 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-md)] bg-[color:var(--color-text-primary)] p-2 text-xs text-white',
      }, JSON.stringify(m.classification, null, 2)),
    );
  }

  const bodyHolder = h('div', { class: 'mt-2 max-w-full overflow-hidden' }, [
    h('em', { class: 'text-xs text-[color:var(--color-text-secondary)]', text: 'loading body…' }),
  ]);
  box.appendChild(bodyHolder);

  messagesApi
    .get(m.id)
    .then((full) => {
      bodyHolder.innerHTML = '';
      if (full.body_text) {
        bodyHolder.appendChild(
          h('pre', {
            class: 'max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-md)] border border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-card)] p-3 text-xs text-[color:var(--color-text-primary)]',
          }, full.body_text),
        );
      } else if (full.body_html) {
        const iframe = document.createElement('iframe');
        iframe.className = 'h-80 w-full max-w-full rounded-[var(--radius-md)] border border-[color:var(--color-border-subtle)] bg-white';
        iframe.setAttribute('sandbox', '');
        iframe.setAttribute('srcdoc', full.body_html);
        bodyHolder.appendChild(iframe);
      } else {
        bodyHolder.appendChild(h('em', { class: 'text-xs text-[color:var(--color-text-secondary)]', text: '(тело пусто)' }));
      }
    })
    .catch((err) => {
      bodyHolder.innerHTML = '';
      bodyHolder.appendChild(
        h('span', { class: 'text-xs text-red-600', text: 'body load failed: ' + (err?.message || err) }),
      );
    });

  td.appendChild(box);
  row.appendChild(td);
  return row;
}

/* ----------------------------- Рендер таблицы -------------------------- */

function renderTable(host) {
  host.innerHTML = '';
  const filtered = state.messages.filter((m) => {
    if (!state.search) return true;
    const q = state.search.toLowerCase();
    return (
      (m.subject || '').toLowerCase().includes(q) ||
      (m.from_addr || '').toLowerCase().includes(q) ||
      (m.classification?.summary || '').toLowerCase().includes(q)
    );
  });

  if (!filtered.length) {
    const searching = Boolean(state.search);
    host.appendChild(
      EmptyState({
        icon: searching ? 'search' : 'inbox',
        title: searching ? 'Ничего не найдено' : 'Писем нет',
        description: searching
          ? 'Попробуйте изменить поисковый запрос или очистить фильтр.'
          : 'Подключите аккаунт или подождите, пока IMAP IDLE заберёт новые письма.',
      }),
    );
    return;
  }

  const table = document.createElement('table');
  table.className = 'w-full text-sm table-fixed';
  table.style.tableLayout = 'fixed';
  const colgroup = document.createElement('colgroup');
  colgroup.innerHTML = `
    <col style="width:16%" />
    <col style="width:22%" />
    <col style="width:28%" />
    <col style="width:14%" />
    <col style="width:10%" />
    <col style="width:10%" />`;
  table.appendChild(colgroup);
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr class="text-left text-xs uppercase tracking-wide text-[color:var(--color-text-muted)] border-b border-[color:var(--color-border-subtle)]">
      <th class="py-2 pr-3 font-medium">От</th>
      <th class="py-2 pr-3 font-medium">Тема</th>
      <th class="py-2 pr-3 font-medium">Сводка</th>
      <th class="py-2 pr-3 font-medium">Категории</th>
      <th class="py-2 pr-3 font-medium">Статус</th>
      <th class="py-2 pr-3 font-medium whitespace-nowrap">Дата</th>
    </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');

  // Сортировка: важные → непрочитанные → по дате убыванию.
  const sorted = [...filtered].sort((a, b) => {
    const ai = a.classification?.important ? 1 : 0;
    const bi = b.classification?.important ? 1 : 0;
    if (ai !== bi) return bi - ai;
    if (a.is_read !== b.is_read) return a.is_read - b.is_read;
    return (b.date || 0) - (a.date || 0);
  });

  for (const m of sorted) {
    const tr = document.createElement('tr');
    tr.dataset.id = String(m.id);
    const expanded = state.expanded.has(m.id);
    tr.className =
      'border-b border-[color:var(--color-border-subtle)] last:border-0 hover:bg-[color:var(--color-bg-elevated)] cursor-pointer transition-colors' +
      (m.is_read ? ' opacity-80' : '');

    tr.appendChild(h('td', { class: 'py-2 pr-3 max-w-[14rem]' }, [
      h('div', { class: 'truncate text-[color:var(--color-text-primary)]', text: m.from_addr || '—' }),
    ]));
    tr.appendChild(h('td', { class: 'py-2 pr-3 max-w-[18rem]' }, [
      h('div', { class: 'flex items-center gap-2' }, [
        m.is_read ? null : h('span', { class: 'h-2 w-2 rounded-full bg-[color:var(--color-accent-purple)] flex-shrink-0' }),
        h('div', { class: 'truncate font-medium text-[color:var(--color-text-primary)]', text: m.subject || '(без темы)' }),
      ]),
    ]));
    const summary = m.classification?.summary || m.classification?.reason || m.snippet || '';
    tr.appendChild(h('td', { class: 'py-2 pr-3 max-w-[24rem]' }, [
      h('div', { class: 'truncate text-[color:var(--color-text-secondary)]', text: summary }),
    ]));
    const tagsCell = h('td', { class: 'py-2 pr-3' }, [
      h('div', { class: 'flex flex-wrap items-center gap-1' }, tagsFor(m.classification)),
    ]);
    tr.appendChild(tagsCell);
    const stat = statusFor(m);
    const statusCell = h('div', { class: 'flex flex-col gap-0.5' }, [
      h('div', { class: 'inline-flex items-center gap-2' }, [
        statusDot(stat.key),
        h('span', { class: 'text-xs text-[color:var(--color-text-secondary)]', text: stat.label }),
      ]),
      m.tokens_used != null
        ? h('span', {
            class: 'text-[10px] text-[color:var(--color-text-muted)] font-mono',
            text: `${Number(m.tokens_used).toLocaleString('ru-RU')} tok`,
          })
        : null,
    ]);
    tr.appendChild(h('td', { class: 'py-2 pr-3' }, [statusCell]));
    tr.appendChild(h('td', { class: 'py-2 pr-3 text-xs text-[color:var(--color-text-muted)] whitespace-nowrap' },
      m.date ? formatRelative(m.date) : '—'));

    tr.addEventListener('click', () => {
      if (state.expanded.has(m.id)) state.expanded.delete(m.id);
      else state.expanded.add(m.id);
      renderTable(host);
    });

    tbody.appendChild(tr);
    if (expanded) tbody.appendChild(renderDetailsRow(m));
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

/* ----------------------------- Загрузка/фильтр ------------------------- */

function buildQuery() {
  const q = {};
  if (state.filter === 'unread') q.unread = 1;
  if (state.filter === 'important') q.important = 1;
  if (state.accountId) q.account_id = state.accountId;
  q.limit = 200;
  return q;
}

async function reload(root) {
  try {
    const resp = await messagesApi.list(buildQuery());
    state.messages = resp.messages || [];
    state.total = resp.total ?? state.messages.length;
    updateCounters();
    if (listHostRef) renderTable(listHostRef);
  } catch (err) {
    showError(root, err);
  }
}

function updateCounters() {
  countersRef.all = state.messages.length;
  countersRef.unread = state.messages.filter((m) => !m.is_read).length;
  countersRef.important = state.messages.filter((m) => m.classification?.important).length;
}

/* ------------------------------ WebSocket ------------------------------ */

function connectWs(root) {
  try {
    if (state.ws) {
      state.ws.close();
      state.ws = null;
    }
    const apiKey = sessionStorage.getItem('api_key') || '';
    if (!apiKey) return;
    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${window.location.host}/ws?token=${encodeURIComponent(apiKey)}`;
    const ws = new WebSocket(url);
    state.ws = ws;
    ws.addEventListener('message', (ev) => {
      let payload;
      try {
        payload = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (payload.type === 'new_message') {
        reload(root);
      } else if (payload.type === 'updated') {
        const { id, is_read, is_important } = payload.data || {};
        const m = state.messages.find((x) => x.id === id);
        if (m) {
          if (is_read !== undefined) m.is_read = is_read;
          if (is_important !== undefined) m.is_important = is_important;
          updateCounters();
          if (listHostRef) renderTable(listHostRef);
        }
      }
    });
    ws.addEventListener('close', () => {
      state.ws = null;
    });
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn('ws connect failed', err);
  }
}

/* -------------------------------- Render ------------------------------- */

export async function renderMessages(root) {
  root.innerHTML = '';
  // Загрузить аккаунты для фильтра.
  try {
    const acc = await accountsApi.list();
    state.accounts = Array.isArray(acc) ? acc : acc.accounts || [];
  } catch (err) {
    showError(root, err);
  }

  const wrap = h('div', { class: 'flex flex-col gap-4' });
  root.appendChild(wrap);

  // Header — SectionHeader с поиском и account selector справа.
  const accountOptions = [
    { value: '', label: 'Все ящики' },
    ...state.accounts.map((a) => ({
      value: String(a.id),
      label: a.label + (a.email ? ` (${a.email})` : ''),
    })),
  ];

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Поиск по теме, отправителю…';
  searchInput.className = 'input w-80 max-w-full';
  // Подхватываем глобальный query, если он был установлен topbar-поиском.
  const initialQ = (typeof window !== 'undefined' && window.__globalSearchQuery) || '';
  if (initialQ) {
    state.search = initialQ;
    searchInput.value = initialQ;
  }
  searchInput.addEventListener('input', (e) => {
    state.search = e.target.value;
    window.__globalSearchQuery = state.search;
    if (listHostRef) renderTable(listHostRef);
  });
  // Подписка на topbar-поиск. Снимаем предыдущий листенер (переход между views).
  if (window.__messagesSearchHandler) {
    window.removeEventListener('global-search', window.__messagesSearchHandler);
  }
  window.__messagesSearchHandler = (ev) => {
    const q = ev.detail?.q ?? '';
    state.search = q;
    searchInput.value = q;
    if (listHostRef) renderTable(listHostRef);
  };
  window.addEventListener('global-search', window.__messagesSearchHandler);

  const accountSel = Select({
    value: state.accountId,
    options: accountOptions,
    onChange: (v) => {
      state.accountId = v;
      reload(root);
    },
  });

  const header = SectionHeader({
    title: 'Входящие',
    subtitle: 'Письма со всех подключённых ящиков',
    actions: [
      searchInput,
      accountSel,
      Button({ label: 'Обновить', variant: 'ghost', size: 'sm', icon: 'check', onClick: () => reload(root) }),
    ],
  });
  wrap.appendChild(header);

  // Tabs.
  const tabsHost = document.createElement('div');
  wrap.appendChild(tabsHost);

  function renderTabsRow() {
    tabsHost.innerHTML = '';
    tabsHost.appendChild(
      Tabs({
        tabs: [
          { id: 'all', label: 'Все', count: countersRef.all },
          { id: 'unread', label: 'Непрочитанные', count: countersRef.unread },
          { id: 'important', label: 'Важные', count: countersRef.important },
        ],
        active: state.filter,
        onChange: (id) => {
          state.filter = id;
          reload(root).then(renderTabsRow);
        },
      }),
    );
  }
  renderTabsRow();

  // Card+table.
  const tableHost = document.createElement('div');
  tableHost.className = 'min-h-[200px] max-w-full overflow-hidden';
  listHostRef = tableHost;
  const tableCard = Card({ children: tableHost });
  tableCard.classList.add('overflow-hidden', 'max-w-full');
  wrap.appendChild(tableCard);

  await reload(root);
  renderTabsRow();
  connectWs(root);
}
