// View /messages — список писем с LLM-классификацией в одном месте.
// Фильтры (все/непрочитанные/важные + по аккаунту), раскрываемые карточки
// с телом письма и полным JSON классификации, mark read/unread, live-обновления
// через WebSocket (/ws?token=<api_key>).

import { accountsApi, messagesApi } from '../api.js';
import { h, button, showError } from './util.js';

const state = {
  messages: [],
  total: 0,
  filter: 'all', // all | unread | important
  accountId: '',
  accounts: [],
  expanded: new Set(),
  ws: null,
};

function classificationBadges(cls) {
  if (!cls || typeof cls !== 'object') return null;
  if (cls.error) {
    return h(
      'div',
      { class: 'mt-1 text-xs text-red-700' },
      `LLM error: ${cls.message || 'unknown'}`,
    );
  }
  const parts = [];
  if (cls.important) {
    parts.push(
      h(
        'span',
        {
          class:
            'rounded bg-amber-100 px-1.5 py-0.5 text-xs font-semibold text-amber-800',
        },
        '★ важное',
      ),
    );
  }
  if (Array.isArray(cls.tags)) {
    for (const tag of cls.tags) {
      parts.push(
        h(
          'span',
          {
            class:
              'rounded bg-slate-200 px-1.5 py-0.5 text-xs text-slate-700',
          },
          String(tag),
        ),
      );
    }
  }
  return parts.length ? h('div', { class: 'flex flex-wrap gap-1 mt-1' }, parts) : null;
}

function messageCard(m, onToggle, onMarkRead, onMarkUnread) {
  const cls = m.classification || null;
  const expanded = state.expanded.has(m.id);
  const readCls = m.is_read ? 'opacity-60' : '';
  const importantBorder = cls?.important
    ? 'border-l-4 border-amber-500'
    : 'border-l-4 border-transparent';

  const header = h(
    'div',
    {
      class: `flex cursor-pointer items-start justify-between gap-3 p-3 ${readCls}`,
      onclick: () => onToggle(m.id),
    },
    [
      h('div', { class: 'flex-1 min-w-0' }, [
        h('div', { class: 'flex items-center gap-2' }, [
          !m.is_read
            ? h('span', { class: 'h-2 w-2 rounded-full bg-indigo-500 flex-shrink-0' })
            : null,
          h('span', { class: 'font-medium truncate', text: m.subject || '(без темы)' }),
        ]),
        h('div', { class: 'mt-0.5 text-xs text-slate-500 truncate' }, [
          (m.from_addr || '—') + ' · ' + (m.date ? new Date(m.date).toLocaleString() : '—'),
        ]),
        cls?.summary
          ? h('div', { class: 'mt-1 text-sm text-slate-700' }, cls.summary)
          : m.snippet
            ? h('div', { class: 'mt-1 text-sm text-slate-600 truncate' }, m.snippet)
            : null,
        cls?.reason
          ? h('div', { class: 'mt-1 text-xs italic text-slate-500' }, '→ ' + cls.reason)
          : null,
        classificationBadges(cls),
      ]),
      h('div', { class: 'flex-shrink-0' }, [
        m.is_read
          ? button('Непрочит.', {
              variant: 'secondary',
              onClick: (e) => {
                e.stopPropagation();
                onMarkUnread(m.id);
              },
            })
          : button('Прочитано', {
              variant: 'secondary',
              onClick: (e) => {
                e.stopPropagation();
                onMarkRead(m.id);
              },
            }),
      ]),
    ],
  );

  const card = h(
    'div',
    {
      class: `rounded bg-white shadow-sm hover:shadow transition ${importantBorder}`,
    },
    [header],
  );

  if (expanded) {
    card.appendChild(renderDetails(m));
  }

  return card;
}

function renderDetails(m) {
  const box = h('div', { class: 'border-t border-slate-200 bg-slate-50 p-3 text-sm' });

  const meta = h('div', { class: 'mb-2 text-xs text-slate-600 grid grid-cols-2 gap-x-4 gap-y-0.5' }, [
    h('div', {}, ['From: ', m.from_addr || '—']),
    h('div', {}, ['To: ', m.to_addr || '—']),
    h('div', {}, ['UID: ', String(m.uid)]),
    h('div', {}, ['Account: #', String(m.account_id)]),
  ]);
  box.appendChild(meta);

  if (m.classification) {
    const pre = h(
      'pre',
      {
        class:
          'mb-2 max-h-40 overflow-auto rounded bg-slate-900 p-2 text-xs text-slate-100',
      },
      JSON.stringify(m.classification, null, 2),
    );
    box.appendChild(h('div', { class: 'mb-1 text-xs font-semibold text-slate-700' }, 'LLM classification:'));
    box.appendChild(pre);
  }

  // Тело письма загружаем по запросу (GET /messages/:id), т.к. список не содержит body.
  const bodyHolder = h('div', { class: 'mt-2' }, h('em', { class: 'text-xs text-slate-500' }, 'loading body…'));
  box.appendChild(bodyHolder);

  messagesApi
    .get(m.id)
    .then((full) => {
      bodyHolder.innerHTML = '';
      if (full.body_text) {
        bodyHolder.appendChild(
          h(
            'pre',
            {
              class:
                'max-h-80 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-2 text-xs text-slate-800',
            },
            full.body_text,
          ),
        );
      } else if (full.body_html) {
        const iframe = h('iframe', {
          class: 'h-80 w-full rounded border border-slate-200 bg-white',
          sandbox: '',
          srcdoc: full.body_html,
        });
        bodyHolder.appendChild(iframe);
      } else {
        bodyHolder.appendChild(h('em', { class: 'text-xs text-slate-500' }, '(тело пусто)'));
      }
    })
    .catch((err) => {
      bodyHolder.innerHTML = '';
      bodyHolder.appendChild(
        h('span', { class: 'text-xs text-red-600' }, 'body load failed: ' + (err?.message || err)),
      );
    });

  return box;
}

function buildQuery() {
  const q = {};
  if (state.filter === 'unread') q.unread = 1;
  if (state.filter === 'important') q.important = 1;
  if (state.accountId) q.account_id = state.accountId;
  q.limit = 100;
  return q;
}

async function reload(root, listHost) {
  try {
    const resp = await messagesApi.list(buildQuery());
    state.messages = resp.messages || [];
    state.total = resp.total ?? state.messages.length;
    renderList(listHost);
  } catch (err) {
    showError(root, err);
  }
}

function renderList(host) {
  host.innerHTML = '';
  if (!state.messages.length) {
    host.appendChild(
      h('div', { class: 'rounded bg-white p-6 text-center text-sm text-slate-500' }, [
        'Писем нет. ',
        'Убедись, что в Accounts добавлен ящик и IMAP IDLE успешно соединился.',
      ]),
    );
    return;
  }
  const onToggle = (id) => {
    if (state.expanded.has(id)) state.expanded.delete(id);
    else state.expanded.add(id);
    renderList(host);
  };
  const onMarkRead = async (id) => {
    try {
      await messagesApi.patch(id, { is_read: 1 });
      const m = state.messages.find((x) => x.id === id);
      if (m) m.is_read = 1;
      renderList(host);
    } catch (err) {
      showError(host, err);
    }
  };
  const onMarkUnread = async (id) => {
    try {
      await messagesApi.patch(id, { is_read: 0 });
      const m = state.messages.find((x) => x.id === id);
      if (m) m.is_read = 0;
      renderList(host);
    } catch (err) {
      showError(host, err);
    }
  };

  // Сортировка: важные → непрочитанные → по дате.
  const sorted = [...state.messages].sort((a, b) => {
    const ai = a.classification?.important ? 1 : 0;
    const bi = b.classification?.important ? 1 : 0;
    if (ai !== bi) return bi - ai;
    if (a.is_read !== b.is_read) return a.is_read - b.is_read;
    return (b.date || 0) - (a.date || 0);
  });

  const list = h('div', { class: 'flex flex-col gap-2' });
  for (const m of sorted) {
    list.appendChild(messageCard(m, onToggle, onMarkRead, onMarkUnread));
  }
  host.appendChild(list);
}

function connectWs(root, listHost) {
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
        // Перечитываем список чтобы получить свежие messages с полными полями.
        reload(root, listHost);
      } else if (payload.type === 'updated') {
        const { id, is_read, is_important } = payload.data || {};
        const m = state.messages.find((x) => x.id === id);
        if (m) {
          if (is_read !== undefined) m.is_read = is_read;
          if (is_important !== undefined) m.is_important = is_important;
          renderList(listHost);
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

export async function renderMessages(root) {
  // Загрузить аккаунты для фильтра.
  try {
    const acc = await accountsApi.list();
    state.accounts = Array.isArray(acc) ? acc : acc.accounts || [];
  } catch (err) {
    showError(root, err);
  }

  const header = h('div', { class: 'mb-4 flex flex-wrap items-center justify-between gap-3' }, [
    h('h1', { class: 'text-xl font-semibold', text: 'Входящие' }),
    h('div', { class: 'flex flex-wrap items-center gap-2' }, [
      // Фильтр статуса
      h(
        'div',
        {
          class:
            'inline-flex overflow-hidden rounded border border-slate-300 bg-white text-sm',
        },
        [
          filterBtn('all', 'Все'),
          filterBtn('unread', 'Непрочитанные'),
          filterBtn('important', 'Важные'),
        ],
      ),
      // Селект аккаунта
      accountSelect(),
      button('Обновить', { variant: 'secondary', onClick: () => reload(root, listHost) }),
    ]),
  ]);

  const counter = h(
    'div',
    { class: 'mb-2 text-xs text-slate-500', id: 'msg-counter' },
    '',
  );

  const listHost = h('div', { class: 'min-h-[120px]' });

  root.appendChild(header);
  root.appendChild(counter);
  root.appendChild(listHost);

  function filterBtn(key, label) {
    const active = state.filter === key;
    return h(
      'button',
      {
        type: 'button',
        class:
          'px-3 py-1.5 ' +
          (active ? 'bg-indigo-600 text-white' : 'hover:bg-slate-50'),
        onclick: () => {
          state.filter = key;
          renderMessages(clearAndReturn(root));
        },
      },
      label,
    );
  }

  function accountSelect() {
    const sel = h(
      'select',
      {
        class:
          'rounded border border-slate-300 bg-white px-2 py-1 text-sm',
        onchange: (e) => {
          state.accountId = e.target.value;
          reload(root, listHost);
        },
      },
      [
        h('option', { value: '' }, 'Все ящики'),
        ...state.accounts.map((a) => {
          const o = h('option', { value: String(a.id) }, a.label + (a.email ? ` (${a.email})` : ''));
          if (String(a.id) === String(state.accountId)) o.selected = true;
          return o;
        }),
      ],
    );
    return sel;
  }

  await reload(root, listHost);
  counter.textContent = `${state.messages.length} из ${state.total}`;
  connectWs(root, listHost);
}

function clearAndReturn(root) {
  root.innerHTML = '';
  return root;
}
