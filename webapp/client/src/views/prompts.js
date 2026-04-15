// View /prompts — список LLM-промтов + форма редактирования.

import { promptsApi } from '../api.js';
import {
  h,
  field,
  input,
  textarea,
  checkbox,
  button,
  showError,
  escapeHtml,
  formToObject,
} from './util.js';

function promptForm({ prompt = null, onSubmit, onCancel } = {}) {
  const isEdit = !!prompt;
  const p = prompt || {};
  const form = h('form', { class: 'space-y-3 rounded bg-white p-4 shadow-sm' });

  form.appendChild(
    h('h2', {
      class: 'text-lg font-semibold',
      text: isEdit ? 'Редактировать промт' : 'Новый промт',
    }),
  );
  form.appendChild(field('Name', input({ name: 'name', value: p.name })));
  form.appendChild(
    field(
      'System prompt',
      textarea({ name: 'system_prompt', value: p.system_prompt, rows: 8 }),
    ),
  );
  form.appendChild(
    field(
      'Output JSON schema (необязательно)',
      textarea({ name: 'output_schema', value: p.output_schema ?? '', rows: 5 }),
    ),
  );
  const flags = h('div', { class: 'flex gap-4' }, [
    checkbox({ name: 'is_default', checked: !!p.is_default, label: 'Default' }),
    checkbox({ name: 'enabled', checked: p.enabled !== 0, label: 'Enabled' }),
  ]);
  form.appendChild(flags);
  form.appendChild(
    h('div', { class: 'flex gap-2' }, [
      button(isEdit ? 'Сохранить' : 'Создать', { type: 'submit' }),
      button('Отмена', { variant: 'secondary', onClick: onCancel }),
    ]),
  );

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = formToObject(form);
    if (raw.output_schema === '') raw.output_schema = null;
    onSubmit(raw);
  });
  return form;
}

export async function renderPrompts(root) {
  const wrapper = h('div', { class: 'space-y-4' });
  root.appendChild(wrapper);

  const editor = h('div');

  wrapper.appendChild(
    h('div', { class: 'flex items-center justify-between' }, [
      h('h1', { class: 'text-xl font-semibold', text: 'Prompts' }),
      button('+ Добавить', {
        onClick: () => {
          editor.innerHTML = '';
          editor.appendChild(
            promptForm({
              onSubmit: async (payload) => {
                try {
                  await promptsApi.create(payload);
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
      const { prompts } = await promptsApi.list();
      if (!prompts.length) {
        list.innerHTML = '<div class="p-4 text-slate-500">Пока нет промтов.</div>';
        return;
      }
      list.innerHTML = prompts
        .map(
          (p) => `
        <div class="flex items-start justify-between border-b p-3 last:border-0">
          <div class="min-w-0">
            <div class="font-medium">${escapeHtml(p.name)} ${p.is_default ? '<span class="ml-1 rounded bg-indigo-100 px-1 text-xs text-indigo-700">default</span>' : ''}</div>
            <div class="mt-1 truncate text-sm text-slate-500">${escapeHtml((p.system_prompt || '').slice(0, 120))}</div>
          </div>
          <div class="space-x-2 whitespace-nowrap">
            <button data-edit="${p.id}" class="text-indigo-600 hover:underline">Edit</button>
            <button data-del="${p.id}" class="text-red-600 hover:underline">Del</button>
          </div>
        </div>`,
        )
        .join('');
      list.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = Number(btn.getAttribute('data-edit'));
          try {
            const p = await promptsApi.get(id);
            editor.innerHTML = '';
            editor.appendChild(
              promptForm({
                prompt: p,
                onSubmit: async (payload) => {
                  try {
                    await promptsApi.update(id, payload);
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
          if (!window.confirm(`Удалить промт #${id}?`)) return;
          try {
            await promptsApi.remove(id);
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
