// views/prompts.js — Промты (#/prompts).
//
// Phase 3 редизайн (Pencil Ljnbz): 2‑колонка.
//   Левая 350px:  search + список промтов (Card‑элементы с TagBadge
//                  «Активен»/«Встроенный»). Кнопка «+ Новый» в SectionHeader.
//   Правая flex‑1: редактор (Input name, Toggle enabled, Select model,
//                  Textarea «Инструкция для LLM», редактор «Выходные параметры»).
//                  Кнопки «Тестировать» и «Сохранить».
//
// Выходные параметры: список {key,type,description,required}. Из них:
//   1) Бэкенд строит JSON-контракт ответа LLM (classifier.composeSystemPrompt).
//   2) UI действий (#/actions/:id/edit) подсвечивает их как доступные переменные
//      для match_expr и шаблонов сообщений.
// Типы: boolean | string | number | string[] | object.
//
// Важно: пользователь вводит ТОЛЬКО бизнес-инструкцию («важным считай …» и т. п.).
// Системная шапка (формат входа subject/from/body) и JSON-контракт ответа
// добавляются автоматически на бэкенде в classifier.composeSystemPrompt().
// Поле output_schema (raw JSON-schema) в UI скрыто — хранится в БД как advanced-override.
//
// Удаление через меню (кнопка trash) в карточке списка.
// CRUD через api.js promptsApi (list/get/create/update/remove). «Тестировать»
// дёргает POST /api/prompts/:id/test через apiFetch.

import { promptsApi, actionsApi, apiFetch } from '../api.js';
import {
  SectionHeader,
  Card,
  Button,
  TagBadge,
  Input,
  Textarea,
  Select,
  Toggle,
  Modal,
  EmptyState,
} from '../components/ui.js';
import { h, showError, debounce } from './util.js';
import {
  buildActionFields,
  renderMatchExprHelp,
  makeNewRule,
  MESSAGE_PARAMS,
  renderParamChipsFor,
} from './actionEditor.js';
import { icon as renderIcon } from '../components/icons.js';

/* ------------------------------- Константы ----------------------------- */

const DEFAULT_MODEL = 'x-ai/grok-4-fast';
const MODEL_OPTIONS = [
  { value: 'x-ai/grok-4-fast', label: 'xAI · Grok 4.1 Fast' },
  { value: 'openai/gpt-4o-mini', label: 'OpenAI · GPT‑4o mini' },
  { value: 'openai/gpt-4o', label: 'OpenAI · GPT‑4o' },
  { value: 'anthropic/claude-3.5-sonnet', label: 'Anthropic · Claude 3.5 Sonnet' },
  { value: 'openrouter/auto', label: 'OpenRouter · Auto' },
];

// Должны совпадать с OUTPUT_PARAM_TYPES в api/prompts.js.
const PARAM_TYPE_OPTIONS = [
  { value: 'boolean', label: 'boolean' },
  { value: 'string', label: 'string' },
  { value: 'number', label: 'number' },
  { value: 'string[]', label: 'string[]' },
  { value: 'object', label: 'object' },
];

const IDENT_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

// Типы правил маршрутизации — должны совпадать с ACTION_TYPES в api/actions.js
// (сейчас backend принимает telegram | webhook | forward | browser).
const RULE_TYPE_OPTIONS = [
  { value: 'telegram', label: 'Telegram' },
  { value: 'webhook', label: 'Webhook' },
  { value: 'forward', label: 'Пересылка e-mail' },
  { value: 'browser', label: 'Browser notification' },
];

// Иконка + акцент для карточек правил — повторяем стиль actionEditor.js
// (меньший набор, т.к. backend пока не знает про 'label').
// `accent` — токен цвета из design-системы, применяется к иконке в сводке.
const RULE_TYPE_META = {
  telegram: { icon: 'send', label: 'Telegram', accent: 'var(--color-accent-cyan)' },
  webhook: { icon: 'zap', label: 'Webhook', accent: 'var(--color-accent-orange)' },
  forward: { icon: 'mail', label: 'Пересылка', accent: 'var(--color-accent-purple)' },
  browser: { icon: 'bell', label: 'Browser', accent: 'var(--color-accent-pink)' },
};

/**
 * Временный id для только что добавленных (ещё не сохранённых) правил.
 * Используется как ключ рендера и для diff в Ф1.6: правила без `id` или с
 * отрицательным id считаются «новыми» и отправляются через POST.
 */
let tempRuleIdCounter = -1;
function nextTempRuleId() {
  const id = tempRuleIdCounter;
  tempRuleIdCounter -= 1;
  return id;
}

/**
 * Приводит «сырое» правило (из API) к форме для локального state секции.
 * Ключевые поля: id, match_expr, type, config (plain object), enabled.
 */
function normalizeRule(raw) {
  return {
    id: raw?.id ?? null,
    match_expr: typeof raw?.match_expr === 'string' ? raw.match_expr : '1 == 1',
    type: RULE_TYPE_META[raw?.type] ? raw.type : 'telegram',
    config: raw?.config && typeof raw.config === 'object' ? { ...raw.config } : {},
    enabled: raw?.enabled === 0 ? 0 : 1,
    // Ф3 — приоритет выполнения. Больше = раньше. Серверный ORDER BY priority DESC, id ASC.
    priority: Number.isInteger(raw?.priority) ? raw.priority : 0,
    // UI-only: состояние валидации match_expr. state ∈ idle|pending|ok|error.
    // Для уже сохранённых (backend-валидных) правил стартуем из 'ok' — пока
    // пользователь не изменил выражение, оно считается валидным.
    validation: { state: 'ok', error: null },
  };
}

/**
 * «Сериализатор» правила для diff в Ф1.6 — стабильный слепок значимых полей.
 * config сериализуется через JSON.stringify (ключи в объекте пользователь
 * добавляет вручную, порядок стабилен в рамках одной сессии).
 */
function serializeRule(r) {
  return JSON.stringify([
    r.match_expr || '',
    r.type,
    r.enabled ? 1 : 0,
    r.config || {},
    Number.isInteger(r.priority) ? r.priority : 0,
  ]);
}

function makeDefaultParams() {
  return [
    { key: 'important', type: 'boolean', description: 'Важное ли письмо', required: true },
    { key: 'reason', type: 'string', description: 'Причина (<=140 символов)', required: true },
    { key: 'tags', type: 'string[]', description: 'Теги классификации', required: true },
    { key: 'summary', type: 'string', description: '1-2 предложения сути', required: true },
  ];
}

function normalizeParams(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((p) => p && typeof p === 'object' && typeof p.key === 'string' && p.key.trim())
    .map((p) => ({
      key: String(p.key).trim(),
      type: String(p.type || 'string'),
      description: p.description == null ? '' : String(p.description),
      required: p.required === true || p.required === 1,
    }));
}

/* -------------------------------- State ------------------------------- */

const state = {
  prompts: [],
  selectedId: null,
  draft: null, // редактируемый объект (отдельная копия)
  search: '',
  // Правила маршрутизации (actions с prompt_id=draft.id).
  // rules — живой state секции; originalRules — snapshot на момент открытия
  // промта, используется для diff в handler «Сохранить».
  rules: [],
  originalRules: [],
};

let listHostRef = null;
let editorHostRef = null;
// Host секции «Правила маршрутизации» — заполняется при рендере editor'а.
// Держим отдельную ссылку, чтобы renderRulesSection() мог перерисовать
// только её без полного reflow формы промта.
let rulesHostRef = null;

/* ------------------------------- Helpers ------------------------------ */

function previewText(p) {
  return (p.system_prompt || '').replace(/\s+/g, ' ').slice(0, 90);
}

function makeNewDraft() {
  return {
    id: null,
    name: 'Новый промт',
    system_prompt: '',
    output_schema: '',
    output_params: makeDefaultParams(),
    is_default: 0,
    enabled: 1,
    model: DEFAULT_MODEL, // local-only field; backend пока не использует
    // Ф3 — режим выполнения правил: 'all' — все matched, 'first' — только первое.
    match_mode: 'all',
  };
}

function cloneForEdit(p) {
  return {
    id: p.id,
    name: p.name,
    system_prompt: p.system_prompt || '',
    output_schema: p.output_schema || '',
    output_params: normalizeParams(p.output_params),
    is_default: p.is_default ? 1 : 0,
    enabled: p.enabled !== 0 ? 1 : 0,
    model: p.model || DEFAULT_MODEL,
    match_mode: p.match_mode === 'first' ? 'first' : 'all',
  };
}

/**
 * Пересчитать priority у всех rules так, чтобы порядок в UI сверху вниз
 * совпадал с серверным ORDER BY priority DESC, id ASC.
 * Верхнее правило (index=0) получает наибольший priority.
 */
function recomputePriorities() {
  const n = state.rules.length;
  state.rules.forEach((r, idx) => {
    r.priority = n - idx;
  });
}

/* ------------------------------- List render -------------------------- */

function renderList() {
  if (!listHostRef) return;
  listHostRef.innerHTML = '';

  const filtered = state.prompts.filter((p) => {
    if (!state.search) return true;
    const q = state.search.toLowerCase();
    return (p.name || '').toLowerCase().includes(q) || (p.system_prompt || '').toLowerCase().includes(q);
  });

  if (!filtered.length) {
    listHostRef.appendChild(
      h('div', { class: 'p-4 text-sm text-[color:var(--color-text-secondary)]' },
        state.search ? 'Ничего не найдено.' : 'Пока нет промтов.'),
    );
    return;
  }

  for (const p of filtered) {
    const isActive = state.selectedId === p.id;
    const card = document.createElement('button');
    card.type = 'button';
    card.className = [
      'w-full text-left rounded-[var(--radius-md)] border px-3 py-3 transition-colors',
      isActive
        ? 'border-[color:var(--color-accent-purple)] bg-[color:color-mix(in_srgb,var(--color-accent-purple)_8%,transparent)]'
        : 'border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-card)] hover:bg-[color:var(--color-bg-elevated)]',
    ].join(' ');
    const badges = [];
    if (p.enabled !== 0) badges.push(TagBadge({ label: 'Активен', variant: 'green' }));
    if (p.is_default) badges.push(TagBadge({ label: 'Встроенный', variant: 'purple' }));

    card.appendChild(
      h('div', { class: 'flex items-start justify-between gap-2' }, [
        h('div', { class: 'min-w-0 flex-1' }, [
          h('div', { class: 'font-medium text-sm text-[color:var(--color-text-primary)] truncate', text: p.name }),
          h('div', { class: 'mt-1 text-xs text-[color:var(--color-text-secondary)] line-clamp-2', text: previewText(p) }),
        ]),
        h('button', {
          type: 'button',
          class: 'text-[color:var(--color-text-muted)] hover:text-[color:var(--color-accent-red)] p-1',
          'aria-label': 'Удалить',
          onclick: async (e) => {
            e.stopPropagation();
            // eslint-disable-next-line no-alert
            if (!window.confirm(`Удалить промт «${p.name}»?`)) return;
            try {
              await promptsApi.remove(p.id);
              await refresh();
            } catch (err) {
              showError(listHostRef.parentElement, err);
            }
          },
          html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
        }),
      ]),
    );
    if (badges.length) {
      card.appendChild(h('div', { class: 'mt-2 flex flex-wrap gap-1' }, badges));
    }
    card.addEventListener('click', () => {
      state.selectedId = p.id;
      state.draft = cloneForEdit(p);
      // Сбрасываем rules до загрузки, чтобы старые правила прошлого
      // выбранного промта не светились между кликами.
      state.rules = [];
      state.originalRules = [];
      renderList();
      renderEditor();
      // Fire-and-forget: подгружаем правила текущего промта.
      loadRulesForPrompt(p.id).catch(() => { /* tolerated — showError внутри */ });
    });
    listHostRef.appendChild(card);
  }
}

/**
 * Собирает diff state.rules vs state.originalRules и выполняет
 * POST / PATCH / DELETE через `actionsApi`. Все запросы — параллельно через
 * Promise.allSettled: ошибка одного правила не блокирует остальные.
 *
 * Возвращает структуру { errors: string[], created: Map<tempId, realId> }
 * — ошибки агрегированы для showError, created используется для апдейта
 * id'шников в state.rules после сохранения.
 *
 * Никаких запросов не шлёт, если diff пуст (экономия сети при повторном
 * save без изменений).
 */
async function saveRulesBatch(promptId) {
  const errors = [];
  const created = new Map();
  if (promptId == null) return { errors, created };

  const byOrigId = new Map(
    (state.originalRules || [])
      .filter((r) => r.id != null && r.id > 0)
      .map((r) => [r.id, r]),
  );
  const currentIds = new Set(
    state.rules.map((r) => r.id).filter((id) => id != null && id > 0),
  );

  const tasks = []; // { kind, tempId?, id?, promise }

  // CREATE: правила без положительного id (новые, с временным отрицательным id).
  for (const r of state.rules) {
    const isNew = r.id == null || r.id < 0;
    if (!isNew) continue;
    const payload = {
      prompt_id: promptId,
      match_expr: r.match_expr,
      type: r.type,
      config: r.config || {},
      enabled: r.enabled ? 1 : 0,
      priority: Number.isInteger(r.priority) ? r.priority : 0,
    };
    tasks.push({
      kind: 'create',
      tempId: r.id,
      promise: actionsApi.create(payload),
    });
  }

  // UPDATE: правила с id, присутствующие в originalRules, но отличающиеся.
  for (const r of state.rules) {
    if (r.id == null || r.id < 0) continue;
    const orig = byOrigId.get(r.id);
    if (!orig) continue;
    if (serializeRule(r) === serializeRule(orig)) continue;
    const payload = {
      prompt_id: promptId,
      match_expr: r.match_expr,
      type: r.type,
      config: r.config || {},
      enabled: r.enabled ? 1 : 0,
      priority: Number.isInteger(r.priority) ? r.priority : 0,
    };
    // PATCH (update семантически — put/patch оба поддержаны api), используем
    // patch для точечного обновления.
    tasks.push({
      kind: 'update',
      id: r.id,
      promise: actionsApi.patch(r.id, payload),
    });
  }

  // DELETE: правила из originalRules, которых больше нет в state.rules.
  for (const orig of state.originalRules || []) {
    if (orig.id == null || orig.id < 0) continue;
    if (currentIds.has(orig.id)) continue;
    tasks.push({
      kind: 'delete',
      id: orig.id,
      promise: actionsApi.remove(orig.id),
    });
  }

  if (!tasks.length) return { errors, created };

  const results = await Promise.allSettled(tasks.map((t) => t.promise));
  results.forEach((res, i) => {
    const t = tasks[i];
    if (res.status === 'fulfilled') {
      if (t.kind === 'create' && res.value && typeof res.value.id === 'number') {
        created.set(t.tempId, res.value.id);
      }
      return;
    }
    const msg = res.reason?.message || String(res.reason);
    if (t.kind === 'create') errors.push(`Создание правила: ${msg}`);
    else if (t.kind === 'update') errors.push(`Обновление правила #${t.id}: ${msg}`);
    else errors.push(`Удаление правила #${t.id}: ${msg}`);
  });

  return { errors, created };
}

/**
 * Загружает правила, привязанные к `promptId`, в state.rules и снимает
 * snapshot в state.originalRules (для diff при сохранении — см. Ф1.6).
 *
 * - promptId = null (новый промт) → rules=[], originalRules=[].
 * - сетевая ошибка → showError(editorHostRef) и rules=[], чтобы UI не ломался.
 * - после завершения перерисовывает секцию правил.
 */
async function loadRulesForPrompt(promptId) {
  if (promptId == null) {
    state.rules = [];
    state.originalRules = [];
    renderRulesSection();
    return;
  }
  try {
    const raw = await actionsApi.listByPrompt(promptId);
    const normalized = raw.map(normalizeRule);
    // Порядок для UI: сверху — наивысший priority (ORDER BY priority DESC, id ASC).
    normalized.sort((a, b) => {
      const pa = Number.isInteger(a.priority) ? a.priority : 0;
      const pb = Number.isInteger(b.priority) ? b.priority : 0;
      if (pa !== pb) return pb - pa;
      return (a.id ?? 0) - (b.id ?? 0);
    });
    state.rules = normalized.map((r) => ({ ...r, config: { ...r.config } }));
    // structuredClone даёт независимый снимок, даже если пользователь
    // поменяет вложенные объекты в config.
    state.originalRules =
      typeof structuredClone === 'function'
        ? structuredClone(normalized)
        : JSON.parse(JSON.stringify(normalized));
  } catch (err) {
    state.rules = [];
    state.originalRules = [];
    if (editorHostRef) showError(editorHostRef, err);
  }
  renderRulesSection();
}

/* -------------------- Валидация match_expr (Ф2) ----------------------- */

// Tailwind-классы рамки по состоянию validation — вешаем на <input>.
// `border-2` намеренно не ставим, чтобы не «дёргало» размер поля при смене
// состояния (токены подобраны под существующий дизайн — полупрозрачные).
const VALIDATION_BORDER_CLASSES = [
  'border-green-500/40',
  'border-red-500/50',
  'border-amber-500/30',
];

/**
 * Применяет визуал к input'у match_expr по текущему состоянию `validation`:
 *   - ok      → зелёная рамка, errorEl скрыт.
 *   - error   → красная рамка, errorEl виден с текстом ошибки.
 *   - pending → янтарная рамка, errorEl скрыт (subtle-индикатор).
 *   - idle    → без доп. рамки.
 */
function applyValidationStyle(inputEl, errorEl, validation) {
  if (!inputEl || !validation) return;
  for (const c of VALIDATION_BORDER_CLASSES) inputEl.classList.remove(c);
  if (validation.state === 'ok') {
    inputEl.classList.add('border-green-500/40');
  } else if (validation.state === 'error') {
    inputEl.classList.add('border-red-500/50');
  } else if (validation.state === 'pending') {
    inputEl.classList.add('border-amber-500/30');
  }
  if (errorEl) {
    if (validation.state === 'error' && validation.error) {
      errorEl.textContent = validation.error;
      errorEl.classList.remove('hidden');
    } else {
      errorEl.textContent = '';
      errorEl.classList.add('hidden');
    }
  }
}

/**
 * Есть ли хоть одно правило с validation.state === 'error'.
 * Используется для disable-состояния кнопки «Сохранить промт».
 */
function hasInvalidRule() {
  return (state.rules || []).some((r) => r.validation && r.validation.state === 'error');
}

// Ссылка на текущую кнопку Save — обновляется в renderEditor при каждом
// ре-рендере. updateSaveButtonState() использует её для disable/enable.
let saveBtnRef = null;

function updateSaveButtonState() {
  if (!saveBtnRef) return;
  const invalid = hasInvalidRule();
  saveBtnRef.disabled = !!invalid;
  if (invalid) {
    saveBtnRef.setAttribute(
      'title',
      'Исправьте невалидные правила перед сохранением',
    );
  } else {
    saveBtnRef.removeAttribute('title');
  }
}

/* -------------------- Секция «Правила маршрутизации» ------------------- */

/**
 * Рендерит одну карточку правила. Collapsible: клик по шапке сворачивает
 * детали, шапка показывает компактную сводку (обновляется на любое изменение).
 */
function renderRuleCard(rule, idx) {
  // Для UI-локальных «пустых» правил гарантируем временный id как ключ.
  if (rule.id == null) rule.id = nextTempRuleId();
  // Новые rules (из makeNewRule) могут не иметь validation. Дефолтим в 'ok' —
  // '1 == 1' валидно; первый же onInput/blur перепроверит на сервере.
  if (!rule.validation) rule.validation = { state: 'ok', error: null };

  const meta = RULE_TYPE_META[rule.type] || RULE_TYPE_META.telegram;

  // Кратко описывает config выбранного типа — для сводки в шапке.
  function configSummary() {
    const c = rule.config || {};
    switch (rule.type) {
      case 'telegram':
        return c.chat_id ? `chat ${String(c.chat_id).slice(0, 10)}` : 'chat не задан';
      case 'webhook':
        return c.url ? String(c.url).slice(0, 32) : 'URL не задан';
      case 'forward':
        return c.to_email || c.to || 'e-mail не задан';
      case 'browser':
        return c.title || 'без заголовка';
      default:
        return '';
    }
  }

  // Текущее состояние (свёрнуто/развёрнуто) живёт на элементе правила как
  // UI-only флаг (не отправляется в backend).
  if (typeof rule._expanded !== 'boolean') rule._expanded = rule.id < 0; // новые — сразу развёрнуты

  const summaryLabel = h('span', {
    class: 'text-xs font-mono text-[color:var(--color-text-primary)] truncate',
    text: rule.match_expr || '∅',
  });
  const arrow = h('span', { class: 'text-[color:var(--color-text-muted)]', text: '→' });
  const typeIcon = renderIcon(meta.icon, { size: 14 });
  // renderIcon возвращает <svg>; задаём цвет инлайном, чтобы не зависеть от
  // theming-слоя иконок (они унаследуют currentColor через style).
  if (typeIcon && typeIcon.style) typeIcon.style.color = meta.accent;
  const typeLabel = h('span', {
    class: 'inline-flex items-center gap-1 text-xs text-[color:var(--color-text-secondary)]',
  }, [typeIcon, h('span', { text: meta.label })]);
  const cfgLabel = h('span', {
    class: 'text-[11px] text-[color:var(--color-text-muted)] truncate',
    text: configSummary(),
  });

  const chevron = h('span', {
    class: 'text-[color:var(--color-text-muted)] ml-auto',
    text: rule._expanded ? '▾' : '▸',
  });
  const disabledPill = rule.enabled ? null : TagBadge({ label: 'Откл.', variant: 'neutral' });

  const headerContent = h('div', { class: 'flex items-center gap-2 min-w-0 flex-1' }, [
    summaryLabel, arrow, typeLabel, cfgLabel,
    ...(disabledPill ? [disabledPill] : []),
    chevron,
  ]);

  const removeBtn = h('button', {
    type: 'button',
    class: 'text-[color:var(--color-text-muted)] hover:text-[color:var(--color-accent-red)] p-1',
    'aria-label': 'Удалить правило',
    onclick: (e) => {
      e.stopPropagation();
      state.rules.splice(idx, 1);
      recomputePriorities();
      renderRulesSection();
    },
    html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
  });

  // Ф3.4 — кнопки reorder ↑/↓. После свапа пересчитываем priority.
  const canMoveUp = idx > 0;
  const canMoveDown = idx < state.rules.length - 1;
  const baseArrowCls = 'p-1 rounded text-[color:var(--color-text-muted)] hover:text-[color:var(--color-text-primary)] hover:bg-[color:var(--color-bg-elevated)]';
  const disabledArrowCls = 'p-1 rounded text-[color:var(--color-text-muted)] opacity-30 cursor-not-allowed';
  const upBtn = h('button', {
    type: 'button',
    class: canMoveUp ? baseArrowCls : disabledArrowCls,
    'aria-label': 'Переместить вверх',
    title: 'Переместить вверх',
    disabled: !canMoveUp,
    onclick: (e) => {
      e.stopPropagation();
      if (!canMoveUp) return;
      const tmp = state.rules[idx - 1];
      state.rules[idx - 1] = state.rules[idx];
      state.rules[idx] = tmp;
      recomputePriorities();
      renderRulesSection();
    },
    html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>',
  });
  const downBtn = h('button', {
    type: 'button',
    class: canMoveDown ? baseArrowCls : disabledArrowCls,
    'aria-label': 'Переместить вниз',
    title: 'Переместить вниз',
    disabled: !canMoveDown,
    onclick: (e) => {
      e.stopPropagation();
      if (!canMoveDown) return;
      const tmp = state.rules[idx + 1];
      state.rules[idx + 1] = state.rules[idx];
      state.rules[idx] = tmp;
      recomputePriorities();
      renderRulesSection();
    },
    html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>',
  });

  const header = h('div', {
    class: 'w-full flex items-center gap-1 px-2 py-1 rounded-[var(--radius-md)] hover:bg-[color:var(--color-bg-elevated)]',
  }, [
    // Колонка с ↑/↓ отдельно, чтобы клик по ней не сворачивал карточку.
    h('div', { class: 'flex flex-col items-center justify-center' }, [upBtn, downBtn]),
    // Основная шапка — кликабельная, сворачивает/разворачивает.
    h('button', {
      type: 'button',
      class: 'flex-1 flex items-center gap-2 text-left px-1 py-1 min-w-0',
      onclick: () => {
        rule._expanded = !rule._expanded;
        renderRulesSection();
      },
    }, [headerContent]),
  ]);

  // Body собирается только если карточка развёрнута (экономим DOM-узлы).
  const body = h('div', { class: 'flex flex-col gap-3 px-3 pb-3' });
  if (rule._expanded) {
    const matchExprInput = Input({
      label: 'Условие (match_expr)',
      value: rule.match_expr,
      placeholder: '1 == 1',
      hint: 'По умолчанию «1 == 1» — срабатывает на каждое письмо этого промта.',
      onInput: (v) => {
        rule.match_expr = v;
        // Обновляем только шапку без полной перерисовки — дешево и без
        // дёргания курсора в input'е.
        summaryLabel.textContent = rule.match_expr || '∅';
        // Пока дебаунс — подсвечиваем pending-состояние (тонкая рамка).
        rule.validation = { state: 'pending', error: null };
        applyValidationStyle(inputEl, errorEl, rule.validation);
        scheduleValidate();
      },
    });
    // Найти фактический <input> — Input() оборачивает в label+hint.
    const inputEl = matchExprInput.querySelector('input') || matchExprInput;
    // Контейнер для текста ошибки под полем (скрыт по умолчанию).
    const errorEl = h('div', {
      class: 'text-xs text-[color:var(--color-accent-red)] hidden',
    });

    // При blur — немедленно прогоняем валидацию (без задержки), чтобы
    // пользователь сразу увидел результат при переходе между полями.
    inputEl.addEventListener('blur', () => {
      rule.validation = { state: 'pending', error: null };
      applyValidationStyle(inputEl, errorEl, rule.validation);
      runValidateNow();
    });

    // Debounced валидатор — создаётся заново при каждом рендере карточки;
    // при быстрых input'ах успевает «схлопываться» до 1 запроса.
    const debounced = debounce(() => {
      runValidateNow();
    }, 400);

    function scheduleValidate() {
      debounced();
    }

    async function runValidateNow() {
      debounced.cancel();
      const expr = (rule.match_expr || '').trim();
      if (!expr) {
        rule.validation = { state: 'error', error: 'expression is required' };
        applyValidationStyle(inputEl, errorEl, rule.validation);
        updateSaveButtonState();
        return;
      }
      try {
        const resp = await actionsApi.validateExpr({
          expr,
          promptId: state.draft?.id ?? null,
        });
        if (resp && resp.ok) {
          rule.validation = { state: 'ok', error: null };
        } else {
          rule.validation = {
            state: 'error',
            error: (resp && resp.error) || 'validation failed',
          };
        }
      } catch (err) {
        // Сетевая ошибка — не блокируем save, но помечаем как error, чтобы
        // пользователь увидел фидбек. Можно переключить на 'idle' при желании.
        rule.validation = {
          state: 'error',
          error: err?.message || String(err),
        };
      }
      applyValidationStyle(inputEl, errorEl, rule.validation);
      updateSaveButtonState();
    }

    body.appendChild(matchExprInput);
    body.appendChild(errorEl);
    // Начальное применение стиля в соответствии с текущим rule.validation
    // (для уже загруженных rules оно 'ok' — зелёная рамка сразу).
    applyValidationStyle(inputEl, errorEl, rule.validation);
    body.appendChild(renderMatchExprHelp());

    const typeSelect = Select({
      label: 'Тип действия',
      value: rule.type,
      options: RULE_TYPE_OPTIONS,
      onChange: (v) => {
        rule.type = v;
        // При смене типа старый config несовместим — сбрасываем.
        rule.config = {};
        renderRulesSection();
      },
    });
    body.appendChild(typeSelect);

    // Динамические поля config по type через shared helper.
    // onChange из buildActionFields обновляет сводку в шапке: реальный
    // перерендер не нужен (config меняется по ссылке), но сводка обновится.
    const cfgWrap = buildActionFields(
      { type: rule.type, config: rule.config },
      () => { cfgLabel.textContent = configSummary(); },
    );
    body.appendChild(cfgWrap);

    // Шаблон текста сообщения — для типов, где содержимое рендерится в тело
    // уведомления (telegram/webhook). Хранится в rule.config.template.
    // Плейсхолдеры: {subject}, {from}, {to}, {snippet}, {reason}, {summary},
    // {tags}, плюс ключи output_params промта.
    if (rule.type === 'telegram' || rule.type === 'webhook') {
      const hint =
        rule.type === 'telegram'
          ? 'Необязательно. Если пусто — используется стандартный формат. Клик по параметру ниже — вставить плейсхолдер в позицию курсора.'
          : 'Необязательно. Если задан — добавляется в JSON-payload как поле «text». Клик по параметру ниже — вставить плейсхолдер в позицию курсора.';
      const tplField = Textarea({
        label: 'Текст сообщения',
        value: rule.config.template || '',
        rows: 4,
        hint,
        placeholder:
          rule.type === 'telegram'
            ? 'Например: ⚠ {subject} от {from}\n{summary}'
            : 'Например: {subject} — {summary}',
        onInput: (v) => {
          rule.config.template = v;
          cfgLabel.textContent = configSummary();
        },
      });
      body.appendChild(tplField);
      const tplEl = tplField.querySelector('textarea') || tplField;

      // Chips параметров — кликабельные плейсхолдеры, вставляются в textarea.
      // Источник: MESSAGE_PARAMS (subject/from/to/snippet/date) + output_params
      // текущего промта (классификация). Дедуплицируется по key.
      const promptParams = Array.isArray(state.draft?.output_params)
        ? state.draft.output_params.filter((p) => p && p.key)
        : [];
      const seen = new Set();
      const chipParams = [];
      for (const p of [...MESSAGE_PARAMS, ...promptParams]) {
        if (!p.key || seen.has(p.key)) continue;
        seen.add(p.key);
        chipParams.push(p);
      }
      body.appendChild(
        h('div', {}, [
          h('div', {
            class: 'text-xs text-[color:var(--color-text-secondary)]',
            text: 'Доступные параметры (клик — вставить в текст):',
          }),
          renderParamChipsFor(chipParams, {
            prefix: '{',
            suffix: '}',
            getTarget: () => tplEl,
          }),
        ]),
      );
    }

    body.appendChild(Toggle({
      checked: rule.enabled === 1,
      label: 'Правило активно',
      onChange: (v) => {
        rule.enabled = v ? 1 : 0;
        renderRulesSection();
      },
    }));

    body.appendChild(
      h('div', { class: 'flex justify-end' }, [removeBtn]),
    );
  }

  const card = h('div', {
    class: 'rounded-[var(--radius-md)] border border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-card)]',
  }, [header, ...(rule._expanded ? [body] : [])]);

  return card;
}

/**
 * Полный рендер секции «Правила маршрутизации»: плейсхолдер/список карточек
 * + кнопка «+ Правило». Вызывается из renderEditor() и как ре-рендер после
 * любого изменения rules (add/delete/type-change/enabled-toggle).
 */
function renderRulesSection() {
  if (!rulesHostRef) return;
  rulesHostRef.innerHTML = '';

  const header = h('div', { class: 'flex items-center justify-between' }, [
    h('div', { class: 'flex flex-col' }, [
      h('div', {
        class: 'text-sm font-medium text-[color:var(--color-text-primary)]',
        text: 'Правила маршрутизации',
      }),
      h('div', {
        class: 'text-xs text-[color:var(--color-text-secondary)]',
        text: 'Что делать, когда письмо подошло под этот промт. Сохраняются вместе с промтом.',
      }),
    ]),
    Button({
      label: 'Правило',
      variant: 'ghost',
      icon: 'plus',
      size: 'sm',
      onClick: () => {
        const r = makeNewRule();
        r.id = nextTempRuleId();
        r._expanded = true;
        // Новое правило добавляется вниз списка — получает наименьший priority.
        state.rules.push(r);
        recomputePriorities();
        renderRulesSection();
      },
    }),
  ]);
  rulesHostRef.appendChild(header);

  // Ф3.4 — селектор «Режим выполнения» + подсказка при 'first'.
  const currentMode = state.draft?.match_mode === 'first' ? 'first' : 'all';
  const modeSelect = Select({
    label: 'Режим выполнения',
    value: currentMode,
    options: [
      { value: 'all', label: 'Все подходящие' },
      { value: 'first', label: 'Первое подходящее' },
    ],
    onChange: (v) => {
      if (state.draft) state.draft.match_mode = v === 'first' ? 'first' : 'all';
      renderRulesSection();
    },
  });
  rulesHostRef.appendChild(modeSelect);
  if (currentMode === 'first') {
    rulesHostRef.appendChild(
      h('div', {
        class: 'text-xs text-[color:var(--color-text-secondary)] rounded-[var(--radius-md)] border border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-elevated)] px-3 py-2',
        text: 'Правила проверяются сверху вниз, срабатывает первое подходящее. Перетаскивание ↑/↓ меняет приоритет.',
      }),
    );
  }

  if (!state.rules.length) {
    rulesHostRef.appendChild(
      h('div', {
        class: 'text-xs text-[color:var(--color-text-muted)] rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border-subtle)] px-3 py-4 text-center',
        text: 'Правил пока нет. Нажмите «+ Правило», чтобы настроить куда отправлять письма этого промта.',
      }),
    );
    return;
  }

  const list = h('div', { class: 'flex flex-col gap-2' });
  state.rules.forEach((r, idx) => list.appendChild(renderRuleCard(r, idx)));
  rulesHostRef.appendChild(list);

  // Re-sync save-кнопки после каждого рендера секции (add/delete/type-change
  // могут поменять набор error'ов).
  updateSaveButtonState();

  // Дубликат «+ Правило» внизу — удобно при длинном списке, чтобы не
  // скроллить к шапке секции.
  const bottomAdd = h('div', { class: 'flex justify-start' }, [
    Button({
      label: 'Добавить правило',
      variant: 'ghost',
      icon: 'plus',
      size: 'sm',
      onClick: () => {
        const r = makeNewRule();
        r.id = nextTempRuleId();
        r._expanded = true;
        state.rules.push(r);
        recomputePriorities();
        renderRulesSection();
      },
    }),
  ]);
  rulesHostRef.appendChild(bottomAdd);
}

/* -------------------- AI-генерация промта ----------------------------- */

/**
 * Открывает модалку, в которой пользователь описывает задачу текстом,
 * а LLM генерирует полную конфигурацию промта (name, system_prompt, output_params).
 * После генерации результат подставляется в draft и перерисовывается редактор.
 */
function openAiGenerateModal() {
  const descArea = Textarea({
    label: 'Опишите, что должен делать промт',
    rows: 6,
    placeholder:
      'Например: «Классифицировать письма от клиентов по срочности. Важными считать жалобы, запросы на возврат и письма с упоминанием дедлайнов. Добавлять теги: жалоба, возврат, вопрос, запрос, информация.»',
    hint: 'Чем подробнее описание — тем лучше результат. AI сгенерирует имя, инструкцию и выходные параметры.',
  });

  const statusEl = h('div', {
    class: 'text-xs text-[color:var(--color-text-secondary)] hidden',
  });

  const generateBtn = Button({
    label: 'Сгенерировать',
    icon: 'brain-circuit',
    onClick: async () => {
      const ta = descArea.querySelector('textarea');
      const description = (ta?.value || '').trim();
      if (!description) {
        window.alert('Введите описание задачи для промта');
        return;
      }
      if (description.length < 3) {
        window.alert('Описание слишком короткое — минимум 3 символа');
        return;
      }
      generateBtn.disabled = true;
      statusEl.textContent = 'AI генерирует промт… Это может занять до 30 секунд.';
      statusEl.classList.remove('hidden');
      try {
        const result = await promptsApi.generate(description);
        if (!result || !result.ok) {
          throw new Error(result?.message || 'Не удалось сгенерировать промт');
        }
        // Заполняем draft результатами AI.
        state.selectedId = null;
        state.draft = makeNewDraft();
        state.draft.name = result.name || 'AI-промт';
        state.draft.system_prompt = result.system_prompt || '';
        if (Array.isArray(result.output_params) && result.output_params.length) {
          state.draft.output_params = normalizeParams(result.output_params);
        }
        // Заполняем rules из AI-ответа.
        if (Array.isArray(result.rules) && result.rules.length) {
          state.rules = result.rules.map((r) => normalizeRule({
            ...r,
            id: nextTempRuleId(),
            _expanded: true,
          }));
          recomputePriorities();
        } else {
          state.rules = [];
        }
        state.originalRules = [];

        overlay.close();
        renderList();
        renderEditor();
      } catch (err) {
        statusEl.textContent = 'Ошибка: ' + (err?.message || String(err));
        statusEl.classList.remove('hidden');
      } finally {
        generateBtn.disabled = false;
      }
    },
  });

  const overlay = Modal({
    title: 'Создать промт с помощью AI',
    children: [descArea, statusEl],
    footer: [
      Button({ label: 'Отмена', variant: 'ghost', onClick: () => overlay.close() }),
      generateBtn,
    ],
  });
  document.body.appendChild(overlay);
}

/* ------------------------------ Editor render ------------------------- */

function openTestModal(promptId) {
  const subjectInput = Input({ label: 'Тема письма', value: 'Test subject', name: 'subject' });
  const fromInput = Input({ label: 'От', value: 'sender@example.com', name: 'from_addr' });
  const bodyTextarea = Textarea({
    label: 'Тело письма',
    value: 'Здравствуйте! Это тестовое сообщение для прогона промта.',
    rows: 6,
    name: 'body_text',
  });
  const resultBox = document.createElement('pre');
  resultBox.className = 'min-h-[100px] max-h-80 max-w-full overflow-auto whitespace-pre-wrap break-all rounded-[var(--radius-md)] bg-[color:var(--color-bg-elevated)] p-3 text-xs font-mono text-[color:var(--color-text-primary)]';
  resultBox.textContent = 'Результат появится здесь после запуска.';
  const resultLabel = h('div', { class: 'text-sm font-medium text-[color:var(--color-text-primary)]', text: 'Результат' });

  const runBtn = Button({
    label: 'Запустить',
    icon: 'play',
    onClick: async () => {
      const sub = subjectInput.querySelector('input').value;
      const fr = fromInput.querySelector('input').value;
      const bd = bodyTextarea.querySelector('textarea').value;
      resultBox.textContent = 'Выполняется…';
      try {
        const out = await apiFetch(`/api/prompts/${promptId}/test`, {
          method: 'POST',
          body: { message: { subject: sub, from_addr: fr, body_text: bd } },
        });
        resultBox.textContent = JSON.stringify(out, null, 2);
      } catch (err) {
        resultBox.textContent = 'Ошибка: ' + (err?.message || String(err));
      }
    },
  });

  const overlay = Modal({
    title: 'Тестовый прогон промта',
    size: 'lg',
    children: [subjectInput, fromInput, bodyTextarea, resultLabel, resultBox],
    footer: [
      Button({ label: 'Закрыть', variant: 'ghost', onClick: () => overlay.close() }),
      runBtn,
    ],
  });
  document.body.appendChild(overlay);
}

function renderEditor() {
  if (!editorHostRef) return;
  editorHostRef.innerHTML = '';

  if (!state.draft) {
    editorHostRef.appendChild(
      EmptyState({
        icon: 'bookmark',
        title: 'Выберите промт',
        description: 'Выберите промт в списке слева или создайте новый.',
      }),
    );
    return;
  }
  const draft = state.draft;
  const isNew = draft.id === null;

  const nameInput = Input({
    label: 'Имя промта',
    value: draft.name,
    onInput: (v) => { draft.name = v; },
  });
  const toggleEnabled = Toggle({
    checked: draft.enabled !== 0,
    label: 'Промт активен',
    onChange: (v) => { draft.enabled = v ? 1 : 0; },
  });
  const modelSelect = Select({
    label: 'Модель',
    value: draft.model,
    options: MODEL_OPTIONS,
    onChange: (v) => { draft.model = v; },
  });
  const systemPromptArea = Textarea({
    label: 'Инструкция для LLM',
    rows: 10,
    value: draft.system_prompt,
    hint: 'Опишите ТОЛЬКО критерии классификации (что считать важным, какие теги ставить и т. п.). Формат входа (subject/from/body) и структура JSON-ответа добавляются автоматически.',
    onInput: (v) => { draft.system_prompt = v; },
  });

  /* --- Выходные параметры -------------------------------------------- */
  const paramsHost = h('div', { class: 'flex flex-col gap-2' });
  const paramsSection = h('div', { class: 'flex flex-col gap-2' }, [
    h('div', { class: 'flex items-center justify-between' }, [
      h('div', { class: 'flex flex-col' }, [
        h('div', {
          class: 'text-sm font-medium text-[color:var(--color-text-primary)]',
          text: 'Выходные параметры',
        }),
        h('div', {
          class: 'text-xs text-[color:var(--color-text-secondary)]',
          text: 'Поля JSON-ответа LLM. Их имена будут доступны в match_expr и шаблонах сообщений действий.',
        }),
      ]),
      Button({
        label: 'Добавить параметр',
        variant: 'ghost',
        icon: 'plus',
        size: 'sm',
        onClick: () => {
          draft.output_params.push({ key: '', type: 'string', description: '', required: false });
          renderParams();
        },
      }),
    ]),
    paramsHost,
  ]);

  function renderParams() {
    paramsHost.innerHTML = '';
    if (!draft.output_params.length) {
      paramsHost.appendChild(
        h('div', {
          class: 'text-xs text-[color:var(--color-text-muted)] rounded-[var(--radius-md)] border border-dashed border-[color:var(--color-border-subtle)] px-3 py-4 text-center',
          text: 'Нет параметров. Без них будет использован дефолтный контракт (important/reason/tags/summary).',
        }),
      );
      return;
    }
    draft.output_params.forEach((p, idx) => {
      const keyInput = Input({
        label: idx === 0 ? 'Имя поля (key)' : undefined,
        value: p.key,
        placeholder: 'например, priority_level',
        onInput: (v) => { p.key = v; },
      });
      const typeSelect = Select({
        label: idx === 0 ? 'Тип' : undefined,
        value: p.type,
        options: PARAM_TYPE_OPTIONS,
        onChange: (v) => { p.type = v; },
      });
      const descInput = Input({
        label: idx === 0 ? 'Описание' : undefined,
        value: p.description,
        placeholder: 'Подсказка для LLM',
        onInput: (v) => { p.description = v; },
      });
      const reqToggle = Toggle({
        checked: !!p.required,
        label: 'Обязательный',
        onChange: (v) => { p.required = !!v; },
      });
      const removeBtn = h('button', {
        type: 'button',
        class: 'text-[color:var(--color-text-muted)] hover:text-[color:var(--color-accent-red)] p-2 self-end',
        'aria-label': 'Удалить параметр',
        onclick: () => {
          draft.output_params.splice(idx, 1);
          renderParams();
        },
        html: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
      });
      const row = h('div', {
        class: 'grid grid-cols-[1fr_160px_1.3fr_auto_auto] gap-2 items-end rounded-[var(--radius-md)] border border-[color:var(--color-border-subtle)] p-2',
      }, [keyInput, typeSelect, descInput, reqToggle, removeBtn]);
      paramsHost.appendChild(row);
    });
  }
  renderParams();

  const saveBtn = Button({
    label: 'Сохранить',
    icon: 'check',
    onClick: async () => {
      // No-op, если есть невалидные правила (кнопка и так disabled, но подстраховка).
      if (hasInvalidRule()) return;
      if (!draft.name || !draft.name.trim()) {
        window.alert('Укажите имя промта');
        return;
      }
      if (!draft.system_prompt || !draft.system_prompt.trim()) {
        window.alert('Инструкция для LLM не может быть пустой');
        return;
      }
      // Чистим параметры: убираем пустые строки, валидируем ключи, ловим дубли.
      const cleaned = [];
      const seen = new Set();
      for (const p of draft.output_params || []) {
        const key = (p.key || '').trim();
        if (!key) continue;
        if (!IDENT_RE.test(key)) {
          window.alert(`Параметр «${key}»: имя должно начинаться с буквы/подчёркивания и содержать только латиницу/цифры.`);
          return;
        }
        if (seen.has(key)) {
          window.alert(`Параметр «${key}» дублируется.`);
          return;
        }
        seen.add(key);
        cleaned.push({
          key,
          type: p.type || 'string',
          description: p.description || '',
          required: !!p.required,
        });
      }
      const payload = {
        name: draft.name,
        system_prompt: draft.system_prompt,
        output_schema: draft.output_schema || null,
        output_params: cleaned,
        model: draft.model || null,
        enabled: draft.enabled,
        is_default: draft.is_default,
        // Ф3 — режим выполнения правил ('all' | 'first').
        match_mode: draft.match_mode === 'first' ? 'first' : 'all',
      };
      // Перед сохранением синхронизируем priority с фактическим порядком в UI.
      // Это гарантирует, что даже если пользователь ни разу не кликал ↑/↓,
      // новые/старые правила получают корректные приоритеты.
      recomputePriorities();
      saveBtn.disabled = true;
      try {
        let effectivePromptId;
        if (isNew) {
          const createdPrompt = await promptsApi.create(payload);
          state.selectedId = createdPrompt.id;
          effectivePromptId = createdPrompt.id;
        } else {
          await promptsApi.update(draft.id, payload);
          effectivePromptId = draft.id;
        }

        // Параллельно: POST новых / PATCH изменённых / DELETE удалённых правил.
        // refresh() ниже перезагрузит промты и через loadRulesForPrompt()
        // подтянет актуальные id'шники — поэтому created.Map тут не обязательна,
        // но оставляем её пригодной для будущей «оптимистичной» отрисовки.
        const { errors } = await saveRulesBatch(effectivePromptId);

        await refresh();

        if (errors.length) {
          // showError ожидает Error-подобный объект — собираем агрегат.
          const agg = new Error(
            `Промт сохранён, но ${errors.length} ${
              errors.length === 1 ? 'правило' : 'правил(а)'
            } не удалось сохранить:\n— ` + errors.join('\n— '),
          );
          if (editorHostRef) showError(editorHostRef, agg);
        }
      } catch (err) {
        window.alert('Не удалось сохранить: ' + (err?.message || err));
      } finally {
        saveBtn.disabled = false;
      }
    },
  });
  const testBtn = Button({
    label: 'Тестировать',
    variant: 'ghost',
    icon: 'play',
    disabled: isNew,
    onClick: () => {
      if (!draft.id) return;
      openTestModal(draft.id);
    },
  });

  const headerRow = h('div', { class: 'flex flex-wrap items-center justify-between gap-3' }, [
    h('div', { class: 'flex flex-col gap-1' }, [
      h('div', { class: 'text-base font-semibold text-[color:var(--color-text-primary)]', text: isNew ? 'Новый промт' : 'Редактирование промта' }),
      h('div', { class: 'text-xs text-[color:var(--color-text-secondary)]', text: isNew ? 'Заполните поля и нажмите «Сохранить»' : `ID #${draft.id}` }),
    ]),
    h('div', { class: 'flex items-center gap-2' }, [testBtn, saveBtn]),
  ]);

  const grid = h('div', { class: 'grid grid-cols-1 md:grid-cols-2 gap-4' }, [
    nameInput,
    h('div', { class: 'flex items-end' }, [toggleEnabled]),
    modelSelect,
  ]);

  // Секция «Правила маршрутизации» — под output_params.
  // Контейнер создаём здесь, наполнение — через renderRulesSection().
  const rulesHost = h('div', { class: 'flex flex-col gap-3' });
  rulesHostRef = rulesHost;
  // Save-кнопка должна синхронизировать disabled-состояние с валидностью
  // правил: запоминаем ссылку, чтобы validation-коллбэки могли её тоггить.
  saveBtnRef = saveBtn;
  renderRulesSection();
  // Первичная синхронизация — если правила загружены и все валидны, кнопка
  // активна; если хоть одно в error — блокируется.
  updateSaveButtonState();

  const card = Card({
    children: [headerRow, grid, systemPromptArea, paramsSection, rulesHost],
  });
  editorHostRef.appendChild(card);
}

/* -------------------------------- Refresh ----------------------------- */

async function refresh() {
  let promptIdToLoadRules = null;
  try {
    const { prompts } = await promptsApi.list();
    state.prompts = prompts || [];
    if (state.selectedId == null && state.prompts.length) {
      state.selectedId = state.prompts[0].id;
      state.draft = cloneForEdit(state.prompts[0]);
      promptIdToLoadRules = state.selectedId;
    } else if (state.selectedId != null) {
      const updated = state.prompts.find((p) => p.id === state.selectedId);
      if (updated) {
        state.draft = cloneForEdit(updated);
        promptIdToLoadRules = state.selectedId;
      }
    }
  } catch (err) {
    if (listHostRef) showError(listHostRef.parentElement, err);
    return;
  }
  renderList();
  renderEditor();
  // Подгружаем правила для выбранного промта (если он есть и сохранён).
  if (promptIdToLoadRules != null) {
    loadRulesForPrompt(promptIdToLoadRules).catch(() => { /* tolerated */ });
  }
}

/* -------------------------------- Render ------------------------------ */

export async function renderPrompts(root) {
  root.innerHTML = '';
  const wrap = h('div', { class: 'flex flex-col gap-4' });
  root.appendChild(wrap);

  wrap.appendChild(
    SectionHeader({
      title: 'Управление промтами',
      subtitle: 'Системные подсказки для классификации входящих писем',
      actions: h('div', { class: 'flex items-center gap-2' }, [
        Button({
          label: 'Создать с AI',
          variant: 'ghost',
          icon: 'brain-circuit',
          onClick: () => openAiGenerateModal(),
        }),
        Button({
          label: 'Новый промт',
          icon: 'plus',
          onClick: () => {
            state.selectedId = null;
            state.draft = makeNewDraft();
            state.rules = [];
            state.originalRules = [];
            renderList();
            renderEditor();
          },
        }),
      ]),
    }),
  );

  const layout = h('div', { class: 'grid grid-cols-1 lg:grid-cols-[350px_1fr] gap-4 items-start' });
  wrap.appendChild(layout);

  // Левая колонка
  const leftPanel = document.createElement('div');
  leftPanel.className = 'flex flex-col gap-3';
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Поиск промтов…';
  searchInput.className = 'input';
  const initialQ = (typeof window !== 'undefined' && window.__globalSearchQuery) || '';
  if (initialQ) {
    state.search = initialQ;
    searchInput.value = initialQ;
  }
  searchInput.addEventListener('input', (e) => {
    state.search = e.target.value;
    window.__globalSearchQuery = state.search;
    renderList();
  });
  if (window.__promptsSearchHandler) {
    window.removeEventListener('global-search', window.__promptsSearchHandler);
  }
  window.__promptsSearchHandler = (ev) => {
    const q = ev.detail?.q ?? '';
    state.search = q;
    searchInput.value = q;
    renderList();
  };
  window.addEventListener('global-search', window.__promptsSearchHandler);
  leftPanel.appendChild(searchInput);
  const listHost = document.createElement('div');
  listHost.className = 'flex flex-col gap-2 max-h-[70vh] overflow-auto';
  listHostRef = listHost;
  leftPanel.appendChild(Card({ children: listHost }));
  layout.appendChild(leftPanel);

  // Правая колонка
  const editorPanel = document.createElement('div');
  editorPanel.className = 'min-w-0';
  editorHostRef = editorPanel;
  layout.appendChild(editorPanel);

  await refresh();
}
