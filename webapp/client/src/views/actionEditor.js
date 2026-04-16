// views/actionEditor.js — Создание/редактирование правила (#/actions/new и
// #/actions/:id/edit) по макету Pencil boqI6.
//
// Структура:
//   Хедер: «← Назад», заголовок, кнопки «Отменить» и «Сохранить».
//   Body 2-колонка:
//     Левая (main):
//       - Card «Триггер»: Select типа (Совпадение с промтом / Регулярка /
//         Всегда), Select промт (если применимо), Input «Условие».
//       - Card «Действие»: Select тип (telegram/webhook/forward/browser/label),
//         динамические поля config + общий Textarea «Шаблон сообщения».
//     Правая (aside 340px):
//       - Card «Предпросмотр»: chips Prompt → Action.
//       - Card «Доп. настройки»: Toggle Активна, Select приоритет, Toggle
//         Логирование, Input лимит срабатываний/день.
//       - Card «Тестирование»: кнопка «Запустить тест» (POST /api/actions/:id/test).
//
// Сохранение:
//   POST /api/actions  (mode=new)
//   PUT  /api/actions/:id  (mode=edit)
// payload: { name, prompt_id, type, match_expr, config, enabled }.
// config — JSON-объект, собираемый из динамических полей.

import { actionsApi, promptsApi, apiFetch } from '../api.js';
import {
  Card,
  Button,
  Input,
  Textarea,
  Select,
  Toggle,
} from '../components/ui.js';
import { h, showError, debounce } from './util.js';
import { icon as renderIcon } from '../components/icons.js';

/* ------------------------------ Константы ------------------------------ */

const TRIGGER_TYPES = [
  { value: 'prompt', label: 'Совпадение с промтом' },
  { value: 'regex', label: 'Регулярное выражение' },
  { value: 'always', label: 'Всегда' },
];

const ACTION_TYPES = [
  { value: 'telegram', label: 'Отправить уведомление в Telegram' },
  { value: 'webhook', label: 'Вызвать webhook' },
  { value: 'forward', label: 'Переслать письмо' },
  { value: 'browser', label: 'Browser notification' },
  { value: 'label', label: 'Пометить меткой в Gmail' },
];

const PRIORITY_OPTIONS = [
  { value: 'low', label: 'Низкий' },
  { value: 'normal', label: 'Средний' },
  { value: 'high', label: 'Высокий' },
];

const ACTION_ICON = {
  telegram: { icon: 'send', accent: 'cyan' },
  webhook: { icon: 'zap', accent: 'orange' },
  forward: { icon: 'mail', accent: 'purple' },
  browser: { icon: 'bell', accent: 'pink' },
  label: { icon: 'bookmark', accent: 'green' },
};

// Дефолтные параметры классификации — доступны всегда (back-compat), даже если
// у выбранного промта нет своих output_params.
const DEFAULT_PROMPT_PARAMS = [
  { key: 'important', type: 'boolean', description: 'Важное ли письмо' },
  { key: 'reason', type: 'string', description: 'Причина' },
  { key: 'tags', type: 'string[]', description: 'Теги классификации' },
  { key: 'summary', type: 'string', description: '1-2 предложения сути' },
];

/**
 * Параметры письма, доступные как плейсхолдеры в шаблонах сообщений
 * (renderTemplate на сервере). Используются вместе с DEFAULT_PROMPT_PARAMS
 * для chips-подсказок в секции «Правила маршрутизации» (views/prompts.js).
 */
export const MESSAGE_PARAMS = [
  { key: 'subject', type: 'string', description: 'Тема письма' },
  { key: 'from', type: 'string', description: 'Отправитель (from_addr)' },
  { key: 'to', type: 'string', description: 'Получатель (to_addr)' },
  { key: 'snippet', type: 'string', description: 'Короткий превью текста' },
  { key: 'date', type: 'number', description: 'Дата (unix ts)' },
];

/**
 * Вставить text в <input>/<textarea> по позиции курсора (или в конец).
 * Диспатчит 'input' event, чтобы связанный onInput обновил draft.
 * Экспортируется для переиспользования в views/prompts.js.
 */
export function insertAtCursor(el, text) {
  if (!el || typeof el.value !== 'string') return;
  const hasSel = typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number';
  const start = hasSel ? el.selectionStart : el.value.length;
  const end = hasSel ? el.selectionEnd : el.value.length;
  const before = el.value.slice(0, start);
  const after = el.value.slice(end);
  el.value = before + text + after;
  const pos = start + text.length;
  try {
    el.selectionStart = el.selectionEnd = pos;
  } catch {
    /* input type может не поддерживать selection — игнорируем */
  }
  el.focus();
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * Рендерит ряд chips с параметрами. Клик → вставка `${prefix}${key}${suffix}`
 * в target-элемент (input/textarea) по позиции курсора. Если target отсутствует
 * — fallback на clipboard.
 *
 * @param {Array<{key:string,type?:string,description?:string}>} params
 * @param {{ prefix?: string, suffix?: string, getTarget?: () => HTMLElement|null }} opts
 * @returns {HTMLElement}
 */
export function renderParamChipsFor(params, opts = {}) {
  const { prefix = '', suffix = '', getTarget = null } = opts;
  const wrap = h('div', { class: 'flex flex-wrap gap-1 mt-1' });
  if (!Array.isArray(params) || !params.length) return wrap;
  for (const p of params) {
    if (!p || !p.key) continue;
    const value = `${prefix}${p.key}${suffix}`;
    const chip = h('button', {
      type: 'button',
      class:
        'inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[color:var(--color-bg-elevated)] hover:bg-[color:var(--color-bg-surface)] border border-[color:var(--color-border-subtle)] px-2 py-0.5 text-[11px] text-[color:var(--color-text-secondary)]',
      title: `${p.type || ''}${p.description ? ' — ' + p.description : ''} · клик — вставить «${value}»`,
      onclick: () => {
        const target = typeof getTarget === 'function' ? getTarget() : null;
        if (target) {
          insertAtCursor(target, value);
          return;
        }
        try {
          navigator.clipboard?.writeText(value);
        } catch {
          /* noop */
        }
      },
    }, [
      h('span', { class: 'font-mono text-[color:var(--color-text-primary)]', text: value }),
      p.type ? h('span', { class: 'text-[color:var(--color-text-muted)]', text: p.type }) : null,
    ]);
    wrap.appendChild(chip);
  }
  return wrap;
}

/**
 * Собирает объединённый список параметров (дефолты + кастомные из промта),
 * избегая дублей по key. Используется для подсказок в UI.
 */
function mergePromptParams(custom) {
  const seen = new Set();
  const out = [];
  const push = (p) => {
    if (!p || !p.key || seen.has(p.key)) return;
    seen.add(p.key);
    out.push(p);
  };
  DEFAULT_PROMPT_PARAMS.forEach(push);
  (Array.isArray(custom) ? custom : []).forEach(push);
  return out;
}

/* --------------------- Валидация match_expr (Ф2) ---------------------- */

// Tailwind-токены рамки по состоянию validation (совпадают с prompts.js,
// чтобы UX был однородный в обоих редакторах).
const VALIDATION_BORDER_CLASSES = [
  'border-green-500/40',
  'border-red-500/50',
  'border-amber-500/30',
];

/**
 * Применяет визуал к input'у match_expr по validation:
 *   ok → зелёная рамка, errorEl скрыт.
 *   error → красная рамка, errorEl с текстом.
 *   pending → янтарная рамка (subtle).
 *   idle → без акцентной рамки.
 * Логика повторяет applyValidationStyle из views/prompts.js.
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

/* ----------------------------- Helpers --------------------------------- */

function makeNewDraft() {
  return {
    id: null,
    name: '',
    prompt_id: null,
    triggerType: 'prompt',
    match_expr: '1 == 1',
    type: 'telegram',
    config: {},
    enabled: 1,
    // правая колонка — пока локальные поля (не отправляются в backend, нет схемы):
    priority: 'normal',
    logging: 1,
    daily_limit: 100,
    template: '',
    // UI-only: состояние валидации match_expr (Ф2). state ∈ idle|pending|ok|error.
    // Для нового action (match_expr='1 == 1') стартуем с 'ok', первый onInput
    // перевалидирует через сервер.
    validation: { state: 'ok', error: null },
  };
}

/**
 * Из загруженного action собирает draft. Поля типа triggerType/priority/
 * logging/daily_limit/template считываются из config._ui если есть, иначе
 * дефолтятся.
 */
function draftFromAction(action) {
  const cfg = { ...(action.config || {}) };
  const ui = cfg._ui || {};
  delete cfg._ui;
  return {
    id: action.id,
    name: action.name || '',
    prompt_id: action.prompt_id ?? null,
    triggerType: ui.triggerType || (action.prompt_id ? 'prompt' : (action.match_expr ? 'regex' : 'always')),
    match_expr: action.match_expr || '',
    type: action.type,
    config: cfg,
    enabled: action.enabled !== 0 ? 1 : 0,
    priority: ui.priority || 'normal',
    logging: ui.logging !== undefined ? (ui.logging ? 1 : 0) : 1,
    daily_limit: ui.daily_limit ?? 100,
    template: cfg.template || '',
    // Загруженный action уже прошёл серверную валидацию → начинаем с 'ok'.
    validation: { state: 'ok', error: null },
  };
}

/**
 * Фабрика «пустого» правила маршрутизации — используется в секции «Правила
 * маршрутизации» редактора промта (views/prompts.js), чтобы поведение было
 * согласовано с backend-схемой actions (см. api/actions.js).
 *
 * Дефолт `match_expr: '1 == 1'` срабатывает на каждое письмо выбранного
 * промта — пользователь потом уточняет условие.
 */
export function makeNewRule() {
  return {
    match_expr: '1 == 1',
    type: 'telegram',
    config: {},
    enabled: 1,
  };
}

/* ----------------------- Динамические поля action ---------------------- */

export function buildActionFields(draft, onChange) {
  const wrap = h('div', { class: 'flex flex-col gap-3' });
  const c = draft.config;
  switch (draft.type) {
    case 'telegram':
      wrap.appendChild(Input({
        label: 'Telegram chat_id',
        value: c.chat_id || '',
        placeholder: 'например, 123456789',
        onInput: (v) => { c.chat_id = v; onChange(); },
      }));
      break;
    case 'webhook':
      wrap.appendChild(Input({
        label: 'URL',
        value: c.url || '',
        placeholder: 'https://example.com/webhook',
        onInput: (v) => { c.url = v; onChange(); },
      }));
      wrap.appendChild(Select({
        label: 'HTTP метод',
        value: c.method || 'POST',
        options: [
          { value: 'POST', label: 'POST' },
          { value: 'PUT', label: 'PUT' },
          { value: 'GET', label: 'GET' },
        ],
        onChange: (v) => { c.method = v; onChange(); },
      }));
      break;
    case 'forward':
      wrap.appendChild(Input({
        label: 'Email получателя',
        type: 'email',
        value: c.to_email || '',
        placeholder: 'manager@example.com',
        onInput: (v) => { c.to_email = v; onChange(); },
      }));
      break;
    case 'browser':
      wrap.appendChild(Input({
        label: 'Заголовок уведомления',
        value: c.title || '',
        placeholder: 'Например: Важное письмо',
        onInput: (v) => { c.title = v; onChange(); },
      }));
      wrap.appendChild(Input({
        label: 'Текст уведомления',
        value: c.body || '',
        placeholder: 'Например: {subject} от {from}',
        onInput: (v) => { c.body = v; onChange(); },
      }));
      break;
    case 'label':
      // TODO(backend): пока нет реального gmail-action 'label'; UI готов,
      // backend дoбавит позже отдельной задачей.
      wrap.appendChild(Input({
        label: 'Имя метки в Gmail',
        value: c.label_name || '',
        placeholder: 'AI/Importan',
        onInput: (v) => { c.label_name = v; onChange(); },
      }));
      break;
    default:
      break;
  }
  return wrap;
}

/* --------------------------- match_expr help --------------------------- */

/**
 * Справочный блок под полем «Условие (match_expr)».
 * Объясняет на пальцах синтаксис и приводит готовые примеры.
 */
export function renderMatchExprHelp() {
  const box = h('div', {
    class:
      'rounded-[var(--radius-md)] border border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-elevated)] px-3 py-3 flex flex-col gap-2',
  });

  const title = h('div', {
    class: 'text-xs font-semibold text-[color:var(--color-text-primary)]',
    text: 'Как устроено условие',
  });

  const intro = h('div', {
    class: 'text-xs text-[color:var(--color-text-secondary)] leading-relaxed',
    text:
      'Условие — маленькая фраза, которую программа проверяет на каждое письмо ' +
      'после классификации ИИ. Если фраза «правда» — действие срабатывает. ' +
      'Слева от оператора — поле из результата промта, справа — значение.',
  });

  const opsTitle = h('div', {
    class: 'text-xs font-medium text-[color:var(--color-text-primary)] mt-1',
    text: 'Операторы:',
  });
  const ops = h('ul', {
    class: 'text-xs text-[color:var(--color-text-secondary)] pl-4 list-disc leading-relaxed',
  }, [
    h('li', { text: '== / != — равно / не равно' }),
    h('li', { text: '&& — И (оба условия должны быть правдой)' }),
    h('li', { text: '|| — ИЛИ (достаточно одного)' }),
    h('li', { text: '! — НЕ (переворачивает результат)' }),
    h('li', { text: 'tags.includes("слово") — проверяет, есть ли слово в списке тегов' }),
  ]);

  const exTitle = h('div', {
    class: 'text-xs font-medium text-[color:var(--color-text-primary)] mt-1',
    text: 'Примеры:',
  });
  const examples = [
    ['1 == 1', 'всегда срабатывает (дефолт — ловит любое письмо этого промта)'],
    ['important == true', 'только если ИИ пометил письмо как важное'],
    ['tags.includes("счёт")', 'если в тегах есть слово «счёт»'],
    ['important && !tags.includes("spam")', 'важное И не спам'],
    ['important || tags.includes("срочно")', 'важное ИЛИ тег «срочно»'],
  ];
  const exList = h('div', { class: 'flex flex-col gap-1' });
  for (const [code, desc] of examples) {
    exList.appendChild(
      h('div', { class: 'flex flex-col gap-0.5' }, [
        h('code', {
          class:
            'text-xs font-mono text-[color:var(--color-text-primary)] bg-[color:var(--color-bg-surface)] px-2 py-0.5 rounded w-fit',
          text: code,
        }),
        h('span', {
          class: 'text-[11px] text-[color:var(--color-text-muted)] pl-1',
          text: '— ' + desc,
        }),
      ]),
    );
  }

  const note = h('div', {
    class: 'text-[11px] text-[color:var(--color-text-muted)] mt-1 leading-relaxed',
    text:
      'Важно: пиши имя поля напрямую («important»), без префикса «classification.» — ' +
      'он не поддерживается парсером.',
  });

  box.append(title, intro, opsTitle, ops, exTitle, exList, note);
  return box;
}

/* ------------------------------ Preview chips -------------------------- */

function renderPreview(host, draft, prompts) {
  host.innerHTML = '';
  const grid = h('div', { class: 'flex items-center gap-2 flex-wrap' });

  // Trigger chip
  let triggerLabel = '—';
  if (draft.triggerType === 'always') triggerLabel = 'Любое письмо';
  else if (draft.triggerType === 'regex') triggerLabel = `Regex: ${draft.match_expr || '∅'}`;
  else {
    const p = prompts.find((x) => x.id === draft.prompt_id);
    triggerLabel = p ? `Промт «${p.name}»` : 'Промт не выбран';
  }
  const trigChip = h('div', { class: 'inline-flex items-center gap-2 rounded-[var(--radius-md)] bg-[color:var(--color-bg-elevated)] px-3 py-2' }, [
    renderIcon('filter', { size: 14 }),
    h('span', { class: 'text-xs text-[color:var(--color-text-primary)]', text: triggerLabel }),
  ]);
  const arrow = h('span', { class: 'text-[color:var(--color-text-muted)]', text: '→' });
  const meta = ACTION_ICON[draft.type] || { icon: 'zap', accent: 'purple' };
  const actChip = h('div', { class: 'inline-flex items-center gap-2 rounded-[var(--radius-md)] bg-[color:var(--color-bg-elevated)] px-3 py-2' }, [
    renderIcon(meta.icon, { size: 14 }),
    h('span', { class: 'text-xs text-[color:var(--color-text-primary)]', text: ACTION_TYPES.find((t) => t.value === draft.type)?.label || draft.type }),
  ]);
  grid.append(trigChip, arrow, actChip);
  host.appendChild(grid);
}

/* -------------------------- Сборка payload --------------------------- */

function buildPayload(draft) {
  // Собираем match_expr исходя из triggerType.
  let match_expr = draft.match_expr;
  if (draft.triggerType === 'always') {
    match_expr = '1 == 1';
  } else if (draft.triggerType === 'prompt' && !match_expr) {
    // Дефолт: условие, которое всегда срабатывает, если письмо подходит под выбранный промт.
    match_expr = '1 == 1';
  }
  // _ui — храним UI-only поля (priority/logging/daily_limit/triggerType) внутри
  // config._ui, чтобы их можно было восстановить в edit‑режиме.
  const config = { ...(draft.config || {}) };
  if (draft.template) config.template = draft.template;
  config._ui = {
    triggerType: draft.triggerType,
    priority: draft.priority,
    logging: draft.logging ? 1 : 0,
    daily_limit: Number(draft.daily_limit) || 0,
  };
  const payload = {
    name: draft.name || null,
    prompt_id: draft.triggerType === 'prompt' && draft.prompt_id ? draft.prompt_id : null,
    type: draft.type,
    match_expr,
    config,
    enabled: draft.enabled,
  };
  return payload;
}

/* -------------------------------- Render ------------------------------- */

export async function renderActionEditor(root, params = {}) {
  root.innerHTML = '';
  const mode = params.mode === 'edit' ? 'edit' : 'new';
  const id = params.id ? Number(params.id) : null;

  // Загружаем промты + (для edit) действие.
  let prompts = [];
  let draft = makeNewDraft();
  try {
    const promptsResp = await promptsApi.list();
    prompts = promptsResp.prompts || [];
  } catch (err) {
    showError(root, err);
  }
  if (mode === 'edit' && id) {
    try {
      const action = await actionsApi.get(id);
      draft = draftFromAction(action);
    } catch (err) {
      showError(root, err);
      return;
    }
  } else {
    // По умолчанию первый промт.
    if (prompts.length) draft.prompt_id = prompts[0].id;
  }

  // Доступные параметры выбранного промта (для подсказок в match_expr и шаблоне).
  // Обновляется асинхронно при смене prompt_id — promptsApi.list() возвращает краткий
  // вариант без гарантии наличия output_params; дёргаем get(id) при выборе.
  let currentPromptParams = mergePromptParams(
    prompts.find((p) => p.id === draft.prompt_id)?.output_params,
  );

  const wrap = h('div', { class: 'flex flex-col gap-6' });
  root.appendChild(wrap);

  /* ---- Header ---- */
  const headerActions = h('div', { class: 'flex items-center gap-2' });
  const cancelBtn = Button({
    label: 'Отменить',
    variant: 'ghost',
    onClick: () => {
      window.location.hash = '#/actions';
    },
  });
  const saveBtn = Button({
    label: 'Сохранить',
    icon: 'check',
    onClick: () => save(),
  });
  headerActions.append(cancelBtn, saveBtn);

  /**
   * Тоггает disabled-state кнопки «Сохранить» в зависимости от draft.validation.
   * Используется validation-колбэками и при каждой перерисовке triggerBody.
   */
  function updateSaveButtonState() {
    const invalid = draft.validation && draft.validation.state === 'error';
    saveBtn.disabled = !!invalid;
    if (invalid) {
      saveBtn.setAttribute('title', 'Исправьте match_expr перед сохранением');
    } else {
      saveBtn.removeAttribute('title');
    }
  }

  const backBtn = h('button', {
    type: 'button',
    class: 'flex items-center gap-1 text-sm text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]',
    onclick: () => {
      if (window.history.length > 1) window.history.back();
      else window.location.hash = '#/actions';
    },
  });
  backBtn.appendChild(renderIcon('chevron-left', { size: 16 }));
  backBtn.appendChild(h('span', { text: 'Назад' }));

  const titleBlock = h('div', {}, [
    h('h2', {
      class: 'text-xl font-semibold text-[color:var(--color-text-primary)]',
      text: mode === 'edit' ? 'Редактирование правила' : 'Создание нового правила',
    }),
    h('p', {
      class: 'text-sm text-[color:var(--color-text-secondary)] mt-1',
      text: mode === 'edit'
        ? 'Измените триггер, действие или дополнительные настройки правила.'
        : 'Настройте триггер и действия для автоматической обработки писем.',
    }),
  ]);

  wrap.appendChild(
    h('div', { class: 'flex flex-col gap-3' }, [
      backBtn,
      h('div', { class: 'flex flex-wrap items-start justify-between gap-3' }, [titleBlock, headerActions]),
    ]),
  );

  /* ---- Body 2-col ---- */
  const layout = h('div', { class: 'grid grid-cols-1 lg:grid-cols-[1fr_340px] gap-6 items-start' });
  wrap.appendChild(layout);

  /* ---- Left: trigger + action ---- */
  const leftCol = h('div', { class: 'flex flex-col gap-4 min-w-0' });
  layout.appendChild(leftCol);

  const triggerCard = Card({ title: 'Триггер', subtitle: 'Когда срабатывает правило' });
  const triggerBody = h('div', { class: 'flex flex-col gap-3' });
  triggerCard.appendChild(triggerBody);
  leftCol.appendChild(triggerCard);

  const actionCard = Card({ title: 'Действие', subtitle: 'Что выполнить при срабатывании' });
  const actionBody = h('div', { class: 'flex flex-col gap-3' });
  actionCard.appendChild(actionBody);
  leftCol.appendChild(actionCard);

  /* ---- Right: aside ---- */
  const asideCol = h('div', { class: 'flex flex-col gap-4' });
  layout.appendChild(asideCol);

  // Preview card
  const previewBody = h('div', { class: 'flex flex-col gap-2' });
  const previewCard = Card({ title: 'Предпросмотр', subtitle: 'Как пайплайн будет работать' });
  previewCard.appendChild(previewBody);
  asideCol.appendChild(previewCard);

  // Settings card
  const settingsBody = h('div', { class: 'flex flex-col gap-3' });
  asideCol.appendChild(Card({ title: 'Доп. настройки', children: settingsBody }));

  // Test card
  const testResult = h('div', { class: 'min-h-[60px] rounded-[var(--radius-md)] bg-[color:var(--color-bg-elevated)] p-3 text-xs font-mono text-[color:var(--color-text-primary)]', text: 'Результат появится после теста.' });
  const testBtn = Button({
    label: 'Запустить тест',
    icon: 'play',
    disabled: mode === 'new',
    onClick: async () => {
      if (mode === 'new' || !draft.id) return;
      testResult.textContent = 'Выполняется…';
      try {
        const out = await apiFetch(`/api/actions/${draft.id}/test`, { method: 'POST', body: {} });
        testResult.textContent = JSON.stringify(out, null, 2);
      } catch (err) {
        testResult.textContent = 'Ошибка: ' + (err?.message || err);
      }
    },
  });
  asideCol.appendChild(Card({
    title: 'Тестирование',
    subtitle: mode === 'new' ? 'Сначала сохраните правило' : 'Прогнать пайплайн без отправки',
    children: [testBtn, testResult],
  }));

  /* ---- Param chips helper ---- */
  /**
   * Вставляет текст в <input>/<textarea> по позиции курсора (или в конец, если
   * нет selection). Диспатчит 'input' event, чтобы обновился связанный draft.
   */
  function insertAtCursor(el, text) {
    if (!el || typeof el.value !== 'string') return;
    const hasSel = typeof el.selectionStart === 'number' && typeof el.selectionEnd === 'number';
    const start = hasSel ? el.selectionStart : el.value.length;
    const end = hasSel ? el.selectionEnd : el.value.length;
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    el.value = before + text + after;
    const pos = start + text.length;
    try {
      el.selectionStart = el.selectionEnd = pos;
    } catch {
      /* input type может не поддерживать selection — игнорируем */
    }
    el.focus();
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }

  /**
   * Рендерит блок chips «Доступные параметры».
   * @param {string} prefix — что добавить перед именем (например, '{' и '}' для шаблонов).
   * @param {string} suffix
   * @param {() => (HTMLInputElement|HTMLTextAreaElement|null)} [getTarget]
   *   — возвращает элемент, в который вставить параметр по клику.
   *     Если не задан — fallback на clipboard.
   */
  function renderParamChips(prefix = '', suffix = '', getTarget = null) {
    const wrap = h('div', { class: 'flex flex-wrap gap-1 mt-1' });
    if (!currentPromptParams.length) return wrap;
    for (const p of currentPromptParams) {
      const value = `${prefix}${p.key}${suffix}`;
      const chip = h('button', {
        type: 'button',
        class: 'inline-flex items-center gap-1 rounded-[var(--radius-sm)] bg-[color:var(--color-bg-elevated)] hover:bg-[color:var(--color-bg-surface)] border border-[color:var(--color-border-subtle)] px-2 py-0.5 text-[11px] text-[color:var(--color-text-secondary)]',
        title: `${p.type}${p.description ? ' — ' + p.description : ''} · клик — вставить «${value}»`,
        onclick: () => {
          const target = typeof getTarget === 'function' ? getTarget() : null;
          if (target) {
            insertAtCursor(target, value);
            return;
          }
          try {
            navigator.clipboard?.writeText(value);
          } catch {
            /* noop */
          }
        },
      }, [
        h('span', { class: 'font-mono text-[color:var(--color-text-primary)]', text: value }),
        h('span', { class: 'text-[color:var(--color-text-muted)]', text: p.type }),
      ]);
      wrap.appendChild(chip);
    }
    return wrap;
  }

  /**
   * Асинхронно подгружает полный промт (с output_params) и перерендерит панели.
   */
  async function reloadPromptParams(promptId) {
    if (!promptId) {
      currentPromptParams = mergePromptParams([]);
      renderTriggerBody();
      renderActionBody();
      return;
    }
    // 1) fast path — уже есть в списке
    const cached = prompts.find((p) => p.id === promptId);
    if (cached && Array.isArray(cached.output_params)) {
      currentPromptParams = mergePromptParams(cached.output_params);
      renderTriggerBody();
      renderActionBody();
      return;
    }
    // 2) fallback — запрос за полной записью
    try {
      const full = await promptsApi.get(promptId);
      currentPromptParams = mergePromptParams(full?.output_params);
    } catch {
      currentPromptParams = mergePromptParams([]);
    }
    renderTriggerBody();
    renderActionBody();
  }

  /* ---- Renderers ---- */
  function renderTriggerBody() {
    triggerBody.innerHTML = '';
    triggerBody.appendChild(Select({
      label: 'Тип триггера',
      value: draft.triggerType,
      options: TRIGGER_TYPES,
      onChange: (v) => {
        draft.triggerType = v;
        renderTriggerBody();
        renderPreview(previewBody, draft, prompts);
      },
    }));
    if (draft.triggerType === 'prompt') {
      triggerBody.appendChild(Select({
        label: 'Применяемый промт',
        value: draft.prompt_id ? String(draft.prompt_id) : '',
        options: [{ value: '', label: '— выбрать —' }, ...prompts.map((p) => ({ value: String(p.id), label: p.name }))],
        onChange: (v) => {
          draft.prompt_id = v ? Number(v) : null;
          renderPreview(previewBody, draft, prompts);
          reloadPromptParams(draft.prompt_id);
        },
      }));
    }
    if (draft.triggerType !== 'always') {
      // Заранее объявляем плейсхолдеры; заполним после Input().
      let matchExprInputEl = null;
      let errorEl = null;

      // Debounced-валидация создаётся заранее, чтобы onInput мог ссылаться
      // на неё через замыкание (функция-декларация внутри if-блока не видна
      // снаружи в strict mode).
      const isPromptTrigger = draft.triggerType === 'prompt';

      async function runValidateNow() {
        debouncedValidate.cancel();
        if (!isPromptTrigger) return;
        const expr = (draft.match_expr || '').trim();
        if (!expr) {
          draft.validation = { state: 'error', error: 'expression is required' };
          applyValidationStyle(matchExprInputEl, errorEl, draft.validation);
          updateSaveButtonState();
          return;
        }
        try {
          const resp = await actionsApi.validateExpr({
            expr,
            promptId: draft.prompt_id ?? null,
          });
          if (resp && resp.ok) {
            draft.validation = { state: 'ok', error: null };
          } else {
            draft.validation = {
              state: 'error',
              error: (resp && resp.error) || 'validation failed',
            };
          }
        } catch (err) {
          draft.validation = {
            state: 'error',
            error: err?.message || String(err),
          };
        }
        applyValidationStyle(matchExprInputEl, errorEl, draft.validation);
        updateSaveButtonState();
      }

      const debouncedValidate = debounce(() => runValidateNow(), 400);

      const matchExprField = Input({
        label: 'Условие (match_expr)',
        value: draft.match_expr,
        placeholder: '1 == 1',
        hint: draft.triggerType === 'regex'
          ? 'Регулярка/выражение, например: subject =~ /важно/i'
          : 'По умолчанию «1 == 1» — действие срабатывает на каждое письмо этого промта. Замени, если нужен фильтр.',
        onInput: (v) => {
          draft.match_expr = v;
          renderPreview(previewBody, draft, prompts);
          if (isPromptTrigger) {
            draft.validation = { state: 'pending', error: null };
            applyValidationStyle(matchExprInputEl, errorEl, draft.validation);
            debouncedValidate();
          }
        },
      });
      triggerBody.appendChild(matchExprField);
      matchExprInputEl = matchExprField.querySelector('input') || matchExprField;
      errorEl = h('div', {
        class: 'text-xs text-[color:var(--color-accent-red)] hidden',
      });
      triggerBody.appendChild(errorEl);

      if (isPromptTrigger) {
        matchExprInputEl.addEventListener('blur', () => {
          draft.validation = { state: 'pending', error: null };
          applyValidationStyle(matchExprInputEl, errorEl, draft.validation);
          runValidateNow();
        });
        // Первичная отрисовка рамки по текущему validation (для edit ='ok').
        applyValidationStyle(matchExprInputEl, errorEl, draft.validation);
      } else {
        // triggerType === 'regex': наша валидация не применяется — сбрасываем
        // validation до 'ok', чтобы Save не блокировался.
        draft.validation = { state: 'ok', error: null };
      }

      if (isPromptTrigger) {
        triggerBody.appendChild(renderMatchExprHelp());
        triggerBody.appendChild(
          h('div', {}, [
            h('div', {
              class: 'text-xs text-[color:var(--color-text-secondary)]',
              text: 'Доступные параметры (клик — вставить имя в условие):',
            }),
            renderParamChips('', '', () => matchExprInputEl),
          ]),
        );
      }
    } else {
      // triggerType === 'always' — нет поля match_expr → сбрасываем.
      draft.validation = { state: 'ok', error: null };
    }
    updateSaveButtonState();
  }

  function renderActionBody() {
    actionBody.innerHTML = '';
    actionBody.appendChild(Input({
      label: 'Имя правила (опционально)',
      value: draft.name,
      onInput: (v) => { draft.name = v; },
    }));
    actionBody.appendChild(Select({
      label: 'Тип действия',
      value: draft.type,
      options: ACTION_TYPES,
      onChange: (v) => {
        draft.type = v;
        // При смене типа сбрасываем config (кроме _ui), template сохраняем.
        draft.config = {};
        renderActionBody();
        renderPreview(previewBody, draft, prompts);
      },
    }));
    actionBody.appendChild(buildActionFields(draft, () => renderPreview(previewBody, draft, prompts)));
    const templateField = Textarea({
      label: 'Шаблон сообщения',
      hint: 'Переменные письма: {subject}, {from}, {to}, {snippet}. Параметры промта подставляются как {key}.',
      rows: 4,
      value: draft.template,
      onInput: (v) => { draft.template = v; },
    });
    actionBody.appendChild(templateField);
    const templateEl = templateField.querySelector('textarea') || templateField;
    actionBody.appendChild(
      h('div', {}, [
        h('div', {
          class: 'text-xs text-[color:var(--color-text-secondary)]',
          text: 'Параметры промта (клик — вставить placeholder в шаблон):',
        }),
        renderParamChips('{', '}', () => templateEl),
      ]),
    );
  }

  function renderSettingsBody() {
    settingsBody.innerHTML = '';
    settingsBody.appendChild(Toggle({
      checked: draft.enabled === 1,
      label: 'Активна',
      onChange: (v) => { draft.enabled = v ? 1 : 0; },
    }));
    settingsBody.appendChild(Select({
      label: 'Приоритет выполнения',
      value: draft.priority,
      options: PRIORITY_OPTIONS,
      onChange: (v) => { draft.priority = v; },
    }));
    settingsBody.appendChild(Toggle({
      checked: draft.logging === 1,
      label: 'Логирование',
      onChange: (v) => { draft.logging = v ? 1 : 0; },
    }));
    settingsBody.appendChild(Input({
      label: 'Макс. срабатываний/день',
      type: 'number',
      value: String(draft.daily_limit),
      onInput: (v) => { draft.daily_limit = Number(v) || 0; },
    }));
  }

  /* ---- Save ---- */
  async function save() {
    // Блокируем save, если match_expr невалидна (должны поймать дубль через
    // disabled saveBtn, но подстраховываемся на случай программного вызова).
    if (draft.validation && draft.validation.state === 'error') return;
    // Простая валидация
    if (draft.triggerType === 'prompt' && !draft.prompt_id) {
      // eslint-disable-next-line no-alert
      window.alert('Выберите промт для триггера или измените тип триггера.');
      return;
    }
    if (draft.triggerType !== 'always' && !draft.match_expr.trim()) {
      // eslint-disable-next-line no-alert
      window.alert('Заполните условие триггера.');
      return;
    }
    const payload = buildPayload(draft);
    try {
      if (mode === 'edit' && draft.id != null) {
        await actionsApi.update(draft.id, payload);
      } else {
        await actionsApi.create(payload);
      }
      window.location.hash = '#/actions';
    } catch (err) {
      showError(root, err);
    }
  }

  /* ---- Initial render ---- */
  renderTriggerBody();
  renderActionBody();
  renderSettingsBody();
  renderPreview(previewBody, draft, prompts);
  // Fire-and-forget: подгрузить полный промт с output_params.
  if (draft.prompt_id) {
    reloadPromptParams(draft.prompt_id).catch(() => { /* tolerate */ });
  }
}

export default renderActionEditor;
