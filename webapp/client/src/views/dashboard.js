// views/dashboard.js — Панель управления (#/dashboard).
//
// Структура (по макету Pencil 3lY5X):
//   1. Hero header «Панель управления» + subtitle.
//   2. Ряд из 4 StatsCard (всего / важные / автоматизированы / ждут решения)
//      из GET /api/stats.
//   3. Секция «Последний AI‑анализ» — Card с таблицей последних 20 писем
//      (Тема / От / Категория / AI‑сводка / Статус / Дата). GET /api/messages?limit=20.
//   4. Секция «Подключённые аккаунты» — сетка AccountCard из views/accounts.js.
//      GET /api/accounts.
//
// Render-функция экспортируется как `renderDashboard` (динамический import из
// main.js это уже учитывает: если модуль присутствует — будет вызвана она,
// иначе fallback‑placeholder).

import { apiFetch, accountsApi, messagesApi } from '../api.js';
import {
  Card,
  StatsCard,
  SectionHeader,
  Button,
  TagBadge,
  EmptyState,
} from '../components/ui.js';
import { h, formatRelative, statusDot } from './util.js';
import { renderAccountCard, openAccountModal } from './accounts.js';

/* ----------------------------- Stats helpers --------------------------- */

const STATS_DEFINITION = [
  { key: 'total', label: 'Всего писем', icon: 'mail', accent: 'purple' },
  { key: 'important', label: 'Важных', icon: 'alert-triangle', accent: 'orange' },
  { key: 'categorized', label: 'Автоматизировано', icon: 'zap', accent: 'cyan' },
  { key: 'pending', label: 'Ждут решения', icon: 'bookmark', accent: 'red' },
];

function renderStatsRow(target, stats, opts = {}) {
  target.innerHTML = '';
  target.className = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4';
  for (const def of STATS_DEFINITION) {
    const value = opts.error ? '—' : stats?.[def.key] ?? 0;
    target.appendChild(StatsCard({
      label: def.label,
      value: typeof value === 'number' ? value.toLocaleString('ru-RU') : value,
      icon: def.icon,
      accent: def.accent,
    }));
  }
}

/* ----------------------------- Messages table -------------------------- */

function categoryBadge(cls) {
  if (!cls || typeof cls !== 'object') return null;
  if (cls.error) return TagBadge({ label: 'LLM ошибка', variant: 'red' });
  if (cls.important) return TagBadge({ label: 'Важное', variant: 'red' });
  if (Array.isArray(cls.tags) && cls.tags.length > 0) {
    const tag = String(cls.tags[0]);
    const lower = tag.toLowerCase();
    let variant = 'neutral';
    if (lower.includes('встреч')) variant = 'cyan';
    else if (lower.includes('счёт') || lower.includes('finance') || lower.includes('финан')) variant = 'orange';
    else if (lower.includes('promo') || lower.includes('промо') || lower.includes('marketing')) variant = 'purple';
    else if (lower.includes('work') || lower.includes('работ')) variant = 'green';
    return TagBadge({ label: tag, variant });
  }
  return TagBadge({ label: 'Без категории', variant: 'neutral' });
}

function statusCell(message) {
  const cls = message.classification;
  let key = 'idle';
  let label = 'Прочитано';
  if (cls?.error) {
    key = 'error';
    label = 'Ошибка';
  } else if (!message.is_read) {
    key = 'pending';
    label = 'Новое';
  } else if (cls?.important) {
    key = 'warning';
    label = 'Важное';
  } else if (cls) {
    key = 'success';
    label = 'Обработано';
  }
  return h('div', { class: 'inline-flex items-center gap-2' }, [
    statusDot(key),
    h('span', { class: 'text-xs text-[color:var(--color-text-secondary)]', text: label }),
  ]);
}

function renderMessagesTable(host, messages) {
  host.innerHTML = '';
  if (!messages.length) {
    host.appendChild(
      EmptyState({
        icon: 'inbox',
        title: 'Писем пока нет',
        description: 'Подключите почтовый ящик, чтобы здесь появились последние письма с AI‑анализом.',
      }),
    );
    return;
  }

  const table = document.createElement('table');
  table.className = 'w-full text-sm';
  const thead = document.createElement('thead');
  thead.innerHTML = `
    <tr class="text-left text-xs uppercase tracking-wide text-[color:var(--color-text-muted)] border-b border-[color:var(--color-border-subtle)]">
      <th class="py-2 pr-3 font-medium">Тема</th>
      <th class="py-2 pr-3 font-medium">От</th>
      <th class="py-2 pr-3 font-medium">Категория</th>
      <th class="py-2 pr-3 font-medium">AI‑сводка</th>
      <th class="py-2 pr-3 font-medium">Статус</th>
      <th class="py-2 pr-3 font-medium">Дата</th>
    </tr>`;
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  for (const m of messages) {
    const cls = m.classification;
    const tr = document.createElement('tr');
    tr.className = 'border-b border-[color:var(--color-border-subtle)] last:border-0 hover:bg-[color:var(--color-bg-elevated)] transition-colors';
    tr.appendChild(h('td', { class: 'py-2 pr-3 max-w-[18rem]' }, [
      h('div', { class: 'font-medium text-[color:var(--color-text-primary)] truncate', text: m.subject || '(без темы)' }),
    ]));
    tr.appendChild(h('td', { class: 'py-2 pr-3 max-w-[14rem]' }, [
      h('div', { class: 'truncate text-[color:var(--color-text-secondary)]', text: m.from_addr || '—' }),
    ]));
    const catCell = h('td', { class: 'py-2 pr-3' });
    const badge = categoryBadge(cls);
    if (badge) catCell.appendChild(badge);
    tr.appendChild(catCell);
    const summary = cls?.summary || cls?.reason || m.snippet || '';
    tr.appendChild(h('td', { class: 'py-2 pr-3 max-w-[24rem]' }, [
      h('div', { class: 'truncate text-[color:var(--color-text-secondary)]', text: summary }),
    ]));
    tr.appendChild(h('td', { class: 'py-2 pr-3' }, [statusCell(m)]));
    tr.appendChild(h('td', { class: 'py-2 pr-3 text-xs text-[color:var(--color-text-muted)] whitespace-nowrap' }, m.date ? formatRelative(m.date) : '—'));
    tbody.appendChild(tr);
  }
  table.appendChild(tbody);
  host.appendChild(table);
}

/* ----------------------------- Accounts row ---------------------------- */

function renderAccountsGrid(host, accounts, onChanged) {
  host.innerHTML = '';
  if (!accounts.length) {
    host.appendChild(
      EmptyState({
        icon: 'mail',
        title: 'Нет подключённых аккаунтов',
        description: 'Подключите Gmail или Yandex, чтобы начать обработку входящих.',
        cta: Button({
          label: 'Подключить аккаунт',
          icon: 'plus',
          onClick: () => openAccountModal({ onSave: () => onChanged?.() }),
        }),
      }),
    );
    return;
  }
  host.className = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4';
  for (const acc of accounts) {
    host.appendChild(
      renderAccountCard(acc, {
        onConfigure: () => openAccountModal({ existingAccount: acc, onSave: () => onChanged?.() }),
        onDisconnect: async () => {
          // eslint-disable-next-line no-alert
          if (!window.confirm(`Отключить ${acc.email || acc.label || '#' + acc.id}?`)) return;
          try {
            await accountsApi.remove(acc.id);
            onChanged?.();
          } catch (err) {
            // eslint-disable-next-line no-alert
            window.alert('Не удалось отключить: ' + (err?.message || err));
          }
        },
      }),
    );
  }
}

/* ------------------------------- Main render --------------------------- */

export async function renderDashboard(root) {
  root.innerHTML = '';
  const wrap = h('div', { class: 'flex flex-col gap-6' });
  root.appendChild(wrap);

  // 1. Hero header.
  wrap.appendChild(
    SectionHeader({
      title: 'Панель управления',
      subtitle: 'Обзор автоматизации вашей почты',
    }),
  );

  // 2. Stats row (skeleton then data).
  const statsRow = h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4' });
  // skeleton
  for (const def of STATS_DEFINITION) {
    statsRow.appendChild(StatsCard({ label: def.label, value: '…', icon: def.icon, accent: def.accent }));
  }
  wrap.appendChild(statsRow);

  // 3. Recent AI analysis section.
  const messagesHost = document.createElement('div');
  messagesHost.className = 'min-h-[140px]';
  const refreshMsgsBtn = Button({
    label: 'Обновить',
    variant: 'ghost',
    size: 'sm',
    icon: 'check',
    onClick: () => loadMessages(),
  });
  const messagesCard = Card({
    title: 'Последний AI‑анализ',
    subtitle: 'Свежие письма, обработанные классификатором',
    actions: refreshMsgsBtn,
    children: messagesHost,
  });
  wrap.appendChild(messagesCard);

  // 4. Connected accounts.
  const accountsHost = document.createElement('div');
  accountsHost.className = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4';
  const accountsHeader = SectionHeader({
    title: 'Подключённые аккаунты',
    subtitle: 'Активные почтовые ящики и их статус синхронизации',
    actions: Button({
      label: 'Добавить',
      icon: 'plus',
      onClick: () => openAccountModal({ onSave: () => loadAccounts() }),
    }),
  });
  wrap.appendChild(accountsHeader);
  wrap.appendChild(accountsHost);

  /* ------------------- loaders ------------------- */
  async function loadStats() {
    try {
      const stats = await apiFetch('/api/stats');
      renderStatsRow(statsRow, stats);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('dashboard: stats load failed', err);
      renderStatsRow(statsRow, null, { error: true });
    }
  }

  async function loadMessages() {
    messagesHost.innerHTML = '<div class="p-4 text-sm text-[color:var(--color-text-secondary)]">Загрузка…</div>';
    try {
      const resp = await messagesApi.list({ limit: 20 });
      const list = resp.messages || [];
      // Сортируем по дате убыванию.
      list.sort((a, b) => (b.date || 0) - (a.date || 0));
      renderMessagesTable(messagesHost, list);
    } catch (err) {
      messagesHost.innerHTML = '';
      messagesHost.appendChild(
        EmptyState({
          icon: 'alert-triangle',
          title: 'Не удалось загрузить письма',
          description: err?.message || String(err),
        }),
      );
    }
  }

  async function loadAccounts() {
    accountsHost.innerHTML = '<div class="col-span-full text-sm text-[color:var(--color-text-secondary)]">Загрузка…</div>';
    try {
      const resp = await accountsApi.list();
      const list = Array.isArray(resp) ? resp : resp.accounts || [];
      renderAccountsGrid(accountsHost, list, loadAccounts);
    } catch (err) {
      accountsHost.innerHTML = '';
      accountsHost.appendChild(
        EmptyState({
          icon: 'alert-triangle',
          title: 'Не удалось загрузить аккаунты',
          description: err?.message || String(err),
        }),
      );
    }
  }

  // Параллельная инициализация.
  await Promise.all([loadStats(), loadMessages(), loadAccounts()]);
}

export default renderDashboard;
