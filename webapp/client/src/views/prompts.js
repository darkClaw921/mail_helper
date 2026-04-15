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

import { promptsApi, apiFetch } from '../api.js';
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
import { h, showError } from './util.js';

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
};

let listHostRef = null;
let editorHostRef = null;

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
  };
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
      renderList();
      renderEditor();
    });
    listHostRef.appendChild(card);
  }
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
      };
      saveBtn.disabled = true;
      try {
        if (isNew) {
          const created = await promptsApi.create(payload);
          state.selectedId = created.id;
        } else {
          await promptsApi.update(draft.id, payload);
        }
        await refresh();
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

  const card = Card({ children: [headerRow, grid, systemPromptArea, paramsSection] });
  editorHostRef.appendChild(card);
}

/* -------------------------------- Refresh ----------------------------- */

async function refresh() {
  try {
    const { prompts } = await promptsApi.list();
    state.prompts = prompts || [];
    if (state.selectedId == null && state.prompts.length) {
      state.selectedId = state.prompts[0].id;
      state.draft = cloneForEdit(state.prompts[0]);
    } else if (state.selectedId != null) {
      const updated = state.prompts.find((p) => p.id === state.selectedId);
      if (updated) state.draft = cloneForEdit(updated);
    }
  } catch (err) {
    if (listHostRef) showError(listHostRef.parentElement, err);
    return;
  }
  renderList();
  renderEditor();
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
      actions: Button({
        label: 'Новый промт',
        icon: 'plus',
        onClick: () => {
          state.selectedId = null;
          state.draft = makeNewDraft();
          renderList();
          renderEditor();
        },
      }),
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
  searchInput.addEventListener('input', (e) => {
    state.search = e.target.value;
    renderList();
  });
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
