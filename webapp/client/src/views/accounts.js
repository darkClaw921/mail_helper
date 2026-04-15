// View /accounts — список аккаунтов IMAP/SMTP + форма создания/редактирования.

import { accountsApi } from '../api.js';
import {
  h,
  field,
  input,
  textarea, // eslint-disable-line no-unused-vars
  checkbox,
  button,
  showError,
  escapeHtml,
  formToObject,
} from './util.js';

const PRESETS = {
  gmail: {
    label: 'Gmail',
    imap_host: 'imap.gmail.com',
    imap_port: 993,
    imap_tls: 1,
    smtp_host: 'smtp.gmail.com',
    smtp_port: 465,
    smtp_tls: 1,
    folder: 'INBOX',
    hint: 'Нужен App Password: https://myaccount.google.com/apppasswords (включи 2FA). Обычный пароль Google не работает.',
  },
  yandex: {
    label: 'Yandex',
    imap_host: 'imap.yandex.ru',
    imap_port: 993,
    imap_tls: 1,
    smtp_host: 'smtp.yandex.ru',
    smtp_port: 465,
    smtp_tls: 1,
    folder: 'INBOX',
    hint: 'Нужен пароль приложения: https://id.yandex.ru/security/app-passwords. В настройках почты включи "Разрешить доступ по IMAP".',
  },
  beget: {
    label: 'Beget',
    imap_host: 'imap.beget.com',
    imap_port: 993,
    imap_tls: 1,
    smtp_host: 'smtp.beget.com',
    smtp_port: 465,
    smtp_tls: 1,
    folder: 'INBOX',
    hint: 'Обычный пароль почтового ящика из панели Beget. Хосты imap/smtp.beget.com (альтернативно — хост вида mail.<твойдомен>).',
  },
};

function accountForm({ account = null, onSubmit, onCancel } = {}) {
  const isEdit = !!account;
  const form = h('form', { class: 'grid grid-cols-2 gap-3 rounded bg-white p-4 shadow-sm' });
  const acc = account || {};

  form.appendChild(
    h('h2', { class: 'col-span-2 text-lg font-semibold', text: isEdit ? 'Редактировать аккаунт' : 'Новый аккаунт' }),
  );

  // Preset-селектор (только для нового аккаунта, чтобы не затирать редактируемые значения случайно)
  const hintBox = h('div', {
    class: 'col-span-2 hidden rounded border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs text-indigo-900',
  });
  if (!isEdit) {
    const presetSelect = h(
      'select',
      {
        class: 'rounded border border-slate-300 bg-white px-2 py-1 text-sm',
        onchange: (e) => applyPreset(e.target.value),
      },
      [
        h('option', { value: '' }, '— пресет —'),
        h('option', { value: 'gmail' }, 'Gmail'),
        h('option', { value: 'yandex' }, 'Yandex'),
        h('option', { value: 'beget' }, 'Beget'),
      ],
    );
    form.appendChild(
      h('div', { class: 'col-span-2 flex items-center gap-2' }, [
        h('span', { class: 'text-sm font-medium text-slate-700', text: 'Быстрое заполнение:' }),
        presetSelect,
      ]),
    );
    form.appendChild(hintBox);
  }

  function setField(name, value) {
    const el = form.elements.namedItem(name);
    if (!el) return;
    if (el.type === 'checkbox') el.checked = !!value;
    else el.value = value ?? '';
  }

  function applyPreset(key) {
    const p = PRESETS[key];
    if (!p) {
      hintBox.classList.add('hidden');
      return;
    }
    setField('label', p.label);
    setField('imap_host', p.imap_host);
    setField('imap_port', p.imap_port);
    setField('imap_tls', p.imap_tls);
    setField('smtp_host', p.smtp_host);
    setField('smtp_port', p.smtp_port);
    setField('smtp_tls', p.smtp_tls);
    setField('folder', p.folder);
    // imap_user/smtp_user заполняем email-ом если он уже введён
    const emailVal = form.elements.namedItem('email')?.value || '';
    if (emailVal) {
      setField('imap_user', emailVal);
      setField('smtp_user', emailVal);
    }
    hintBox.textContent = p.hint;
    hintBox.classList.remove('hidden');
  }

  form.appendChild(field('Label', input({ name: 'label', value: acc.label })));
  form.appendChild(field('Email', input({ name: 'email', type: 'email', value: acc.email })));
  form.appendChild(field('IMAP host', input({ name: 'imap_host', value: acc.imap_host })));
  form.appendChild(field('IMAP port', input({ name: 'imap_port', type: 'number', value: acc.imap_port })));
  form.appendChild(field('IMAP user', input({ name: 'imap_user', value: acc.imap_user })));
  form.appendChild(
    field(
      `IMAP password${acc.has_imap_pass ? ' (задан — пусто = не менять)' : ''}`,
      input({ name: 'imap_pass', type: 'password' }),
    ),
  );
  form.appendChild(field('SMTP host', input({ name: 'smtp_host', value: acc.smtp_host })));
  form.appendChild(field('SMTP port', input({ name: 'smtp_port', type: 'number', value: acc.smtp_port })));
  form.appendChild(field('SMTP user', input({ name: 'smtp_user', value: acc.smtp_user })));
  form.appendChild(
    field(
      `SMTP password${acc.has_smtp_pass ? ' (задан — пусто = не менять)' : ''}`,
      input({ name: 'smtp_pass', type: 'password' }),
    ),
  );
  form.appendChild(field('Folder', input({ name: 'folder', value: acc.folder ?? 'INBOX' })));

  // Первичная синхронизация истории писем.
  // UI: чекбокс + селект (none / all / 10 / 50 / 100 / 500 / custom) + number-input.
  const syncWrap = h('div', { class: 'col-span-2 rounded border border-slate-200 bg-slate-50 p-2' });
  const currentSync = acc.initial_sync_count;
  const wantSync = currentSync !== null && currentSync !== undefined && currentSync !== 0;
  const presetValue = currentSync === -1 ? 'all' : [10, 50, 100, 500].includes(currentSync) ? String(currentSync) : wantSync ? 'custom' : '';

  const syncCheckbox = h('input', { type: 'checkbox', class: 'mr-2', name: '__sync_on' });
  syncCheckbox.checked = wantSync;

  const syncPreset = h('select', { class: 'rounded border border-slate-300 bg-white px-2 py-1 text-sm', name: '__sync_preset' }, [
    h('option', { value: 'all' }, 'Все'),
    h('option', { value: '10' }, 'Последние 10'),
    h('option', { value: '50' }, 'Последние 50'),
    h('option', { value: '100' }, 'Последние 100'),
    h('option', { value: '500' }, 'Последние 500'),
    h('option', { value: 'custom' }, 'Другое число…'),
  ]);
  syncPreset.value = presetValue || 'all';

  const syncCustom = h('input', {
    type: 'number',
    min: '1',
    class: 'w-24 rounded border border-slate-300 px-2 py-1 text-sm',
    name: '__sync_custom',
    placeholder: 'N',
    value: presetValue === 'custom' && typeof currentSync === 'number' ? String(currentSync) : '',
  });

  const syncedBadge = acc.initial_synced
    ? h('span', { class: 'text-xs text-green-700' }, '✓ уже синхронизирован')
    : null;

  const updateSyncUI = () => {
    const on = syncCheckbox.checked;
    syncPreset.disabled = !on;
    syncCustom.style.display = on && syncPreset.value === 'custom' ? 'inline-block' : 'none';
    syncCustom.disabled = !on;
  };
  syncCheckbox.addEventListener('change', updateSyncUI);
  syncPreset.addEventListener('change', updateSyncUI);
  updateSyncUI();

  syncWrap.appendChild(
    h('label', { class: 'flex items-center text-sm font-medium text-slate-700' }, [
      syncCheckbox,
      'Синхронизировать старые письма при первом подключении',
    ]),
  );
  syncWrap.appendChild(
    h('div', { class: 'mt-2 flex items-center gap-2 text-sm' }, [
      h('span', { class: 'text-slate-600' }, 'Количество:'),
      syncPreset,
      syncCustom,
      syncedBadge,
    ]),
  );
  if (isEdit && acc.initial_synced) {
    syncWrap.appendChild(
      h('div', { class: 'mt-1 text-xs text-slate-500' }, 'Изменение этого поля сбросит флаг и повторно синхронизирует историю.'),
    );
  }
  form.appendChild(syncWrap);

  const flags = h('div', { class: 'col-span-2 flex gap-4' }, [
    checkbox({ name: 'imap_tls', checked: acc.imap_tls !== 0, label: 'IMAP TLS' }),
    checkbox({ name: 'smtp_tls', checked: acc.smtp_tls !== 0, label: 'SMTP TLS' }),
    checkbox({ name: 'enabled', checked: acc.enabled !== 0, label: 'Enabled' }),
  ]);
  form.appendChild(flags);

  const controls = h('div', { class: 'col-span-2 flex gap-2' }, [
    button(isEdit ? 'Сохранить' : 'Создать', { type: 'submit', variant: 'primary' }),
    button('Отмена', { variant: 'secondary', onClick: onCancel }),
  ]);
  form.appendChild(controls);

  // При blur email — если imap_user/smtp_user пусты, подставить email.
  const emailEl = form.elements.namedItem('email');
  if (emailEl) {
    emailEl.addEventListener('blur', () => {
      const v = emailEl.value.trim();
      if (!v) return;
      const iu = form.elements.namedItem('imap_user');
      const su = form.elements.namedItem('smtp_user');
      if (iu && !iu.value) iu.value = v;
      if (su && !su.value) su.value = v;
    });
  }

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const raw = formToObject(form);
    // В PUT: не отправляем пустые пароли.
    if (isEdit) {
      if (!raw.imap_pass) delete raw.imap_pass;
      if (!raw.smtp_pass) delete raw.smtp_pass;
    }
    // Собираем initial_sync_count из трёх вспомогательных полей.
    const syncOn = !!raw.__sync_on;
    const preset = raw.__sync_preset;
    const custom = raw.__sync_custom;
    delete raw.__sync_on;
    delete raw.__sync_preset;
    delete raw.__sync_custom;
    if (syncOn) {
      if (preset === 'all') raw.initial_sync_count = -1;
      else if (preset === 'custom') {
        const n = Number(custom);
        raw.initial_sync_count = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
      } else raw.initial_sync_count = Number(preset);
    } else {
      raw.initial_sync_count = null;
    }
    // Пустые строки -> null для необязательных полей (но initial_sync_count уже numeric|null).
    for (const k of Object.keys(raw)) {
      if (raw[k] === '') raw[k] = null;
    }
    onSubmit(raw);
  });

  return form;
}

export async function renderAccounts(root) {
  const wrapper = h('div', { class: 'space-y-4' });
  root.appendChild(wrapper);

  const header = h('div', { class: 'flex items-center justify-between' }, [
    h('h1', { class: 'text-xl font-semibold', text: 'Accounts' }),
    button('+ Добавить', {
      onClick: () => {
        editor.innerHTML = '';
        editor.appendChild(
          accountForm({
            onSubmit: async (payload) => {
              try {
                await accountsApi.create(payload);
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
  ]);
  wrapper.appendChild(header);

  const editor = h('div');
  wrapper.appendChild(editor);

  const tableWrap = h('div', { class: 'overflow-x-auto rounded bg-white shadow-sm' });
  wrapper.appendChild(tableWrap);

  async function refresh() {
    tableWrap.innerHTML = '<div class="p-4 text-slate-500">Загрузка…</div>';
    try {
      const { accounts } = await accountsApi.list();
      if (!accounts.length) {
        tableWrap.innerHTML =
          '<div class="p-4 text-slate-500">Пока нет аккаунтов. Нажмите «Добавить».</div>';
        return;
      }
      const rows = accounts
        .map(
          (a) => `
          <tr class="border-t">
            <td class="px-3 py-2 text-sm">${a.id}</td>
            <td class="px-3 py-2 text-sm">${escapeHtml(a.label)}</td>
            <td class="px-3 py-2 text-sm">${escapeHtml(a.email)}</td>
            <td class="px-3 py-2 text-sm">${escapeHtml(a.imap_host ?? '')}:${escapeHtml(a.imap_port ?? '')}</td>
            <td class="px-3 py-2 text-sm">${a.enabled ? 'on' : 'off'}</td>
            <td class="px-3 py-2 text-sm space-x-2">
              <button data-edit="${a.id}" class="text-indigo-600 hover:underline">Edit</button>
              <button data-del="${a.id}" class="text-red-600 hover:underline">Del</button>
            </td>
          </tr>`,
        )
        .join('');
      tableWrap.innerHTML = `
        <table class="min-w-full">
          <thead class="bg-slate-100 text-left text-sm">
            <tr>
              <th class="px-3 py-2">ID</th>
              <th class="px-3 py-2">Label</th>
              <th class="px-3 py-2">Email</th>
              <th class="px-3 py-2">IMAP</th>
              <th class="px-3 py-2">Enabled</th>
              <th class="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>`;

      tableWrap.querySelectorAll('[data-edit]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = Number(btn.getAttribute('data-edit'));
          try {
            const acc = await accountsApi.get(id);
            editor.innerHTML = '';
            editor.appendChild(
              accountForm({
                account: acc,
                onSubmit: async (payload) => {
                  try {
                    await accountsApi.update(id, payload);
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
      tableWrap.querySelectorAll('[data-del]').forEach((btn) => {
        btn.addEventListener('click', async () => {
          const id = Number(btn.getAttribute('data-del'));
          // eslint-disable-next-line no-alert
          if (!window.confirm(`Удалить аккаунт #${id}?`)) return;
          try {
            await accountsApi.remove(id);
            refresh();
          } catch (err) {
            showError(root, err);
          }
        });
      });
    } catch (err) {
      tableWrap.innerHTML = '';
      showError(root, err);
    }
  }

  refresh();
}
