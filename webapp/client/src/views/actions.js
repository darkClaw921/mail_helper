// views/actions.js — Действия и автоматизация (#/actions).
//
// Phase 3 редизайн (Pencil gHHb3):
//   1. SectionHeader «Действия и автоматизация» + Button «+ Создать правило»
//      → перенавигирует на #/actions/new (редактор реализован в actionEditor.js).
//   2. Stats row из 4 StatsCard: Активных правил / Срабатываний сегодня /
//      Писем обработано / Ошибок (последнее = 0 до появления метрики).
//   3. Список rule‑cards: IconTile типа, заголовок, блоки Триггер→Действие,
//      Toggle is_active, кнопки «Изм»/«Удалить».
//   4. Если правил нет — EmptyState с CTA.
//
// CRUD через actionsApi (api.js).

import { actionsApi, promptsApi, apiFetch } from '../api.js';
import {
  SectionHeader,
  StatsCard,
  Card,
  Button,
  IconTile,
  Toggle,
  EmptyState,
  TagBadge,
} from '../components/ui.js';
import { h, formatRelative, showError } from './util.js';

/* ------------------------------ Вспомогательное ------------------------ */

const TYPE_META = {
  telegram: { label: 'Telegram', icon: 'send', accent: 'cyan' },
  webhook: { label: 'Webhook', icon: 'zap', accent: 'orange' },
  forward: { label: 'Пересылка', icon: 'mail', accent: 'purple' },
  browser: { label: 'Browser', icon: 'bell', accent: 'pink' },
  label: { label: 'Метка Gmail', icon: 'bookmark', accent: 'green' },
};

function metaFor(type) {
  return TYPE_META[type] || { label: type || 'Действие', icon: 'zap', accent: 'purple' };
}

function describeConfig(action) {
  const c = action.config || {};
  switch (action.type) {
    case 'telegram':
      return c.chat_id ? `chat_id: ${c.chat_id}` : 'нет chat_id';
    case 'webhook':
      return c.url ? `${c.method || 'POST'} ${c.url}` : 'нет URL';
    case 'forward':
      return c.to_email ? `→ ${c.to_email}` : 'нет адреса';
    case 'browser':
      return c.title || 'browser notification';
    case 'label':
      return c.label_name ? `label: ${c.label_name}` : 'нет label';
    default:
      return action.match_expr || '';
  }
}

/* ------------------------------- Stats row ----------------------------- */

const STAT_DEFS = [
  { key: 'rules_active', label: 'Активных правил', icon: 'zap', accent: 'purple' },
  { key: 'rules_triggered_today', label: 'Срабатываний сегодня', icon: 'bell', accent: 'cyan' },
  { key: 'action_tokens_total', label: 'Токенов на действия', icon: 'brain', accent: 'orange' },
  { key: 'tokens_total', label: 'Токенов всего', icon: 'brain-circuit', accent: 'green' },
];

function renderStatsRow(host, stats, opts = {}) {
  host.innerHTML = '';
  host.className = 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4';
  for (const def of STAT_DEFS) {
    const value = opts.error ? '—' : (stats?.[def.key] ?? 0);
    host.appendChild(
      StatsCard({
        label: def.label,
        value: typeof value === 'number' ? value.toLocaleString('ru-RU') : value,
        icon: def.icon,
        accent: def.accent,
      }),
    );
  }
}

/* ------------------------------- Rule card ----------------------------- */

function renderRuleCard(action, ctx) {
  const { promptsById, onChanged } = ctx;
  const meta = metaFor(action.type);
  const enabled = action.enabled !== 0;
  const promptName = action.prompt_id != null ? promptsById.get(action.prompt_id)?.name : null;

  const triggerChip = h('div', { class: 'flex items-center gap-2 rounded-[var(--radius-md)] bg-[color:var(--color-bg-elevated)] px-3 py-2 min-w-0 max-w-full' }, [
    h('span', { class: 'text-xs uppercase tracking-wide text-[color:var(--color-text-muted)] shrink-0', text: 'Триггер' }),
    h('span', { class: 'text-sm text-[color:var(--color-text-primary)] font-medium truncate', text: promptName ? `Промт «${promptName}»` : (action.match_expr || 'Любое письмо') }),
  ]);
  const arrow = h('span', { class: 'text-[color:var(--color-text-muted)] shrink-0', text: '→' });
  const actionChip = h('div', { class: 'flex items-center gap-2 rounded-[var(--radius-md)] bg-[color:var(--color-bg-elevated)] px-3 py-2 min-w-0 max-w-full' }, [
    h('span', { class: 'text-xs uppercase tracking-wide text-[color:var(--color-text-muted)] shrink-0', text: 'Действие' }),
    h('span', { class: 'text-sm text-[color:var(--color-text-primary)] font-medium shrink-0', text: meta.label }),
    h('span', { class: 'text-xs text-[color:var(--color-text-secondary)] truncate', text: describeConfig(action) }),
  ]);
  const flowRow = h('div', { class: 'flex flex-wrap items-center gap-2 min-w-0 max-w-full' }, [triggerChip, arrow, actionChip]);

  const left = h('div', { class: 'flex items-start gap-3 min-w-0 flex-1 overflow-hidden' }, [
    IconTile({ icon: meta.icon, accent: meta.accent, size: 22 }),
    h('div', { class: 'min-w-0 flex-1 overflow-hidden' }, [
      h('div', { class: 'flex items-center gap-2 min-w-0' }, [
        h('div', { class: 'text-base font-semibold text-[color:var(--color-text-primary)] truncate min-w-0', text: action.name || `Правило #${action.id}` }),
        TagBadge({ label: meta.label, variant: enabled ? 'green' : 'neutral' }),
      ]),
      action.match_expr
        ? h('div', { class: 'mt-1 text-xs font-mono text-[color:var(--color-text-secondary)] truncate', text: action.match_expr })
        : null,
      h('div', { class: 'mt-3 min-w-0' }, [flowRow]),
    ]),
  ]);

  const right = h('div', { class: 'flex items-center gap-2 shrink-0 flex-wrap justify-end' }, [
    Toggle({
      checked: enabled,
      label: enabled ? 'Активно' : 'Выкл',
      onChange: async (next) => {
        try {
          await actionsApi.update(action.id, { enabled: next ? 1 : 0 });
          onChanged?.();
        } catch (err) {
          // eslint-disable-next-line no-alert
          window.alert('Не удалось сохранить: ' + (err?.message || err));
        }
      },
    }),
    Button({
      label: 'Изм',
      variant: 'ghost',
      icon: 'pencil',
      size: 'sm',
      onClick: () => {
        window.location.hash = `#/actions/${action.id}/edit`;
      },
    }),
    Button({
      label: 'Удалить',
      variant: 'danger',
      icon: 'trash',
      size: 'sm',
      onClick: async () => {
        // eslint-disable-next-line no-alert
        if (!window.confirm(`Удалить правило «${action.name || '#' + action.id}»?`)) return;
        try {
          await actionsApi.remove(action.id);
          onChanged?.();
        } catch (err) {
          // eslint-disable-next-line no-alert
          window.alert('Не удалось удалить: ' + (err?.message || err));
        }
      },
    }),
  ]);

  const card = document.createElement('div');
  card.className = 'card flex flex-wrap items-center gap-4 overflow-hidden';
  card.append(left, right);

  // Stats: токены / срабатывания / последний run. Пишется runner.js в action_runs.
  const stats = action.stats || {};
  const runsTotal = Number(stats.runs_total || 0);
  const runsOk = Number(stats.runs_ok || 0);
  const tokensTotal = Number(stats.tokens_total || 0);
  const lastRunAt = stats.last_run_at || action.last_triggered_at || null;
  const statsRow = h('div', { class: 'w-full flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-[color:var(--color-text-muted)] border-t border-[color:var(--color-border-subtle)] pt-2 mt-1' }, [
    h('span', { class: 'font-mono text-[color:var(--color-text-primary)]', text: `${tokensTotal.toLocaleString('ru-RU')} tok` }),
    h('span', {}, `Срабатываний: ${runsTotal.toLocaleString('ru-RU')}${runsTotal ? ` (успех ${runsOk}/${runsTotal})` : ''}`),
    lastRunAt
      ? h('span', {}, `Последнее: ${formatRelative(lastRunAt)}`)
      : h('span', { class: 'italic' }, 'ни разу не запускалось'),
  ]);
  card.appendChild(statsRow);
  return card;
}

/* -------------------------------- Render ------------------------------- */

export async function renderActions(root) {
  root.innerHTML = '';
  const wrap = h('div', { class: 'flex flex-col gap-6' });
  root.appendChild(wrap);

  wrap.appendChild(
    SectionHeader({
      title: 'Действия и автоматизация',
      subtitle: 'Правила, которые срабатывают по результатам AI‑классификации',
      actions: Button({
        label: 'Новое правило',
        icon: 'plus',
        onClick: () => {
          window.location.hash = '#/actions/new';
        },
      }),
    }),
  );

  // Stats skeleton.
  const statsRow = document.createElement('div');
  renderStatsRow(statsRow, null, { error: false });
  wrap.appendChild(statsRow);

  const listHost = h('div', { class: 'flex flex-col gap-3' });
  wrap.appendChild(listHost);

  /* ---------- Loaders ---------- */
  async function loadStats() {
    try {
      const stats = await apiFetch('/api/stats');
      renderStatsRow(statsRow, { ...stats, errors: 0 });
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn('actions: stats load failed', err);
      renderStatsRow(statsRow, null, { error: true });
    }
  }

  async function loadList() {
    listHost.innerHTML = '<div class="text-sm text-[color:var(--color-text-secondary)]">Загрузка…</div>';
    try {
      const [{ actions }, promptsResp] = await Promise.all([
        actionsApi.list(),
        promptsApi.list().catch(() => ({ prompts: [] })),
      ]);
      const promptsById = new Map((promptsResp.prompts || []).map((p) => [p.id, p]));
      listHost.innerHTML = '';
      if (!actions.length) {
        listHost.appendChild(
          EmptyState({
            icon: 'zap',
            title: 'Нет правил автоматизации',
            description: 'Создайте первое правило, чтобы автоматически реагировать на письма.',
            cta: Button({
              label: 'Создать правило',
              icon: 'plus',
              onClick: () => { window.location.hash = '#/actions/new'; },
            }),
          }),
        );
        return;
      }
      for (const action of actions) {
        listHost.appendChild(
          renderRuleCard(action, {
            promptsById,
            onChanged: () => {
              loadList();
              loadStats();
            },
          }),
        );
      }
    } catch (err) {
      listHost.innerHTML = '';
      showError(root, err);
    }
  }

  await Promise.all([loadStats(), loadList()]);
}
