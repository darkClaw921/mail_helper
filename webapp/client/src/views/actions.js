// View /actions — список actions + форма редактирования.
// config хранится как JSON; в форме редактируется как textarea с JSON.

import { actionsApi } from '../api.js';
import {
  h,
  field,
  input,
  textarea,
  select,
  checkbox,
  button,
  showError,
  escapeHtml,
  formToObject,
} from './util.js';

const TYPES = [
  { value: 'telegram', label: 'telegram' },
  { value: 'webhook', label: 'webhook' },
  { value: 'forward', label: 'forward' },
  { value: 'browser', label: 'browser' },
];

function actionForm({ action = null, onSubmit, onCancel } = {}) {
  const isEdit = !!action;
  const a = action || {};
  const form = h('form', { class: 'space-y-3 rounded bg-white p-4 shadow-sm' });

  form.appendChild(
    h('h2', {
      class: 'text-lg font-semibold',
      text: isEdit ? 'Редактировать action' : 'Новый action',
    }),
  );
  form.appendChild(field('Name (необязательно)', input({ name: 'name', value: a.name ?? '' })));
  form.appendChild(
    field(
      'Prompt ID (необязательно — числовой id промта)',
      input({ name: 'prompt_id', type: 'number', value: a.prompt_id ?? '' }),
    ),
  );
  form.appendChild(field('Type', select({ name: 'type', value: a.type || 'telegram', options: TYPES })));
  form.appendChild(
    field(
      'Match expression',
      input({ name: 'match_expr', value: a.match_expr, placeholder: 'classification.important == true' }),
    ),
  );
  form.appendChild(
    field(
      'Config (JSON)',
      textarea({
        name: 'config',
        rows: 6,
        value: a.config ? JSON.stringify(a.config, null, 2) : '{}',
      }),
    ),
  );
  form.appendChild(h('div', { class: 'flex gap-4' }, [checkbox({ name: 'enabled', checked: a.enabled !== 0, label: 'Enabled' })]));
  form.appendChild(
    h('div', { class: 'flex gap-2' }, [
      button(isEdit ? 'Сохранить' : 'Создать', { type: 'submit' }),
      button('Отмена', { variant: 'secondary', onClick: onCancel }),
    ]),
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = formToObject(form);
    // config: парсим JSON
    try {
      raw.config = raw.config ? JSON.parse(raw.config) : {};
    } catch (err) {
      onSubmit(null, new Error('Некорректный JSON в поле config: ' + err.message));
      return;
    }
    // prompt_id: 0 / пусто -> null
    if (raw.prompt_id === null || raw.prompt_id === 0) raw.prompt_id = null;
    if (raw.name === '') raw.name = null;
    onSubmit(raw);
  });
  return form;
}

export async function renderActions(root) {
  const wrapper = h('div', { class: 'space-y-4' });
  root.appendChild(wrapper);

  const editor = h('div');
  wrapper.appendChild(
    h('div', { class: 'flex items-center justify-between' }, [
      h('h1', { class: 'text-xl font-semibold', text: 'Actions' }),
      button('+ Добавить', {
        onClick: () => {
          editor.innerHTML = '';
          editor.appendChild(
            actionForm({
              onSubmit: async (payload, parseErr) => {
                if (parseErr) return showError(root, parseErr);
                try {
                  await actionsApi.create(payload);
                  editor.innerHTML = '';
                  refresh();
                } catch (err) {
                  showError(root, err);
                }
              },
              onCancel: () => {
                editor.innerHTML = '';
              },
            }),
          );
        },
      }),
    ]),
  );
  wrapper.appendChild(editor);

  const list = h('div', { class: 'rounded bg-white shadow-sm' });
  wrapper.appendChild(list);

  async function refresh() {
    list.innerHTML = '<div class="p-4 text-slate-500">Загрузка…</div>';
    try {
      const { actions } = await actionsApi.list();
      if (!actions.length) {
        list.innerHTML = '<div class="p-4 text-slate-500">Пока нет actions.</div>';
        return;
      }
      list.innerHTML = actions
        .map(
          (a) => `
        <div class="flex items-start justify-between border-b p-3 last:border-0">
          <div class="min-w-0">
            <div class="font-medium">${escapeHtml(a.name || '(без имени)')} <span class="ml-1 rounded bg-slate-100 px-1 text-xs">${escapeHtml(a.type)}</span></div>
            <div class="mt-1 truncate font-mono text-xs text-slate-500">${escapeHtml(a.match_expr || '')}</div>
          </div>
          <div class="space-x-2 whitespace-nowrap">
            <button data-edit="${a.id}" class="text-indigo-600 hover:underline">Edit</button>
            <button data-del="${a.id}" class="text-red-600 hover:underline">Del</button>
          </div>
        </div>`,
        )
        .join('');
      list.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = Number(btn.getAttribute('data-edit'));
          try {
            const a = await actionsApi.get(id);
            editor.innerHTML = '';
            editor.appendChild(
              actionForm({
                action: a,
                onSubmit: async (payload, parseErr) => {
                  if (parseErr) return showError(root, parseErr);
                  try {
                    await actionsApi.update(id, payload);
                    editor.innerHTML = '';
                    refresh();
                  } catch (err) {
                    showError(root, err);
                  }
                },
                onCancel: () => {
                  editor.innerHTML = '';
                },
              }),
            );
          } catch (err) {
            showError(root, err);
          }
        });
      });
      list.querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = Number(btn.getAttribute('data-del'));
          // eslint-disable-next-line no-alert
          if (!window.confirm(`Удалить action #${id}?`)) return;
          try {
            await actionsApi.remove(id);
            refresh();
          } catch (err) {
            showError(root, err);
          }
        });
      });
    } catch (err) {
      list.innerHTML = '';
      showError(root, err);
    }
  }

  refresh();
}
