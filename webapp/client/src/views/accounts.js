// views/accounts.js — модуль аккаунтов: AccountCard + Модалка-редактор.
//
// После Phase 3 редизайна это уже не отдельный view, а модуль с двумя
// публичными экспортами:
//
//   - renderAccountCard(account, { onConfigure, onDisconnect }) → HTMLElement
//     Карточка аккаунта (логотип провайдера, email, статус синхронизации,
//     last sync, кнопки «Настроить» и «Отключить»). Используется в
//     dashboard.js и settings.js.
//
//   - openAccountModal({ existingAccount, onSave, onClose }) → HTMLElement
//     Создаёт overlay-модалку с формой IMAP/SMTP. Поддерживает пресеты
//     Gmail/Yandex/Beget, инициальную синхронизацию истории, безопасные
//     обновления паролей. Сохраняет через POST /api/accounts либо
//     PUT /api/accounts/:id.
//
// Также сохранён `renderAccounts(root)` — для обратной совместимости с
// возможными прямыми вызовами; рендерит карточки + кнопку «+ Подключить».

import { accountsApi } from '../api.js';
import { Modal, Button, EmptyState, TagBadge } from '../components/ui.js';
import { icon as renderIcon } from '../components/icons.js';
import { h, formatRelative, statusDot, showError } from './util.js';

/* ------------------------------- Пресеты ------------------------------- */

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

/* ------------------------------ Хелперы UI ----------------------------- */

/**
 * По email/host угадывает короткий код провайдера для отображения логотипа.
 * @param {object} acc
 * @returns {'gmail'|'yandex'|'beget'|'other'}
 */
function guessProvider(acc) {
  const email = (acc?.email || '').toLowerCase();
  const host = (acc?.imap_host || '').toLowerCase();
  if (email.endsWith('@gmail.com') || host.includes('gmail')) return 'gmail';
  if (email.endsWith('@yandex.ru') || email.endsWith('@ya.ru') || host.includes('yandex')) return 'yandex';
  if (host.includes('beget')) return 'beget';
  return 'other';
}

const PROVIDER_META = {
  gmail: { label: 'Gmail', accent: 'red', icon: 'mail' },
  yandex: { label: 'Yandex', accent: 'orange', icon: 'mail' },
  beget: { label: 'Beget', accent: 'cyan', icon: 'mail' },
  other: { label: 'IMAP', accent: 'purple', icon: 'mail' },
};

/**
 * Карточка аккаунта (для dashboard и settings).
 * @param {object} account
 * @param {{ onConfigure?: Function, onDisconnect?: Function }} handlers
 * @returns {HTMLElement}
 */
export function renderAccountCard(account, handlers = {}) {
  const { onConfigure, onDisconnect } = handlers;
  const providerKey = guessProvider(account);
  const meta = PROVIDER_META[providerKey];

  const enabled = account.enabled !== 0;
  const lastSync = account.last_fetched_at || account.updated_at || account.created_at;
  const statusKey = enabled ? 'active' : 'paused';
  const statusLabel = enabled ? 'Подключено' : 'Отключено';

  const header = h('div', { class: 'flex items-start justify-between gap-3' }, [
    h('div', { class: 'flex items-center gap-3 min-w-0' }, [
      // Логотип провайдера
      (() => {
        const tile = document.createElement('div');
        tile.className = 'flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)] shrink-0';
        tile.style.backgroundColor = `color-mix(in srgb, var(--color-accent-${meta.accent}) 14%, transparent)`;
        tile.style.color = `var(--color-accent-${meta.accent})`;
        tile.appendChild(renderIcon(meta.icon, { size: 20 }));
        return tile;
      })(),
      h('div', { class: 'min-w-0' }, [
        h('div', { class: 'text-sm font-semibold text-[color:var(--color-text-primary)] truncate', text: meta.label }),
        h('div', { class: 'text-xs text-[color:var(--color-text-secondary)] truncate', text: account.email || account.label || '—' }),
      ]),
    ]),
    TagBadge({ label: statusLabel, variant: enabled ? 'green' : 'neutral' }),
  ]);

  const meta1 = h('div', { class: 'flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]' }, [
    statusDot(statusKey),
    h('span', { text: lastSync ? `Последняя синхронизация: ${formatRelative(lastSync)}` : 'Синхронизация не выполнялась' }),
  ]);

  const buttons = h('div', { class: 'flex items-center gap-2 mt-1' }, [
    Button({
      label: 'Настроить',
      variant: 'ghost',
      size: 'sm',
      icon: 'settings',
      onClick: () => onConfigure?.(account),
    }),
    Button({
      label: 'Отключить',
      variant: 'danger',
      size: 'sm',
      icon: 'trash',
      onClick: () => onDisconnect?.(account),
    }),
  ]);

  const card = document.createElement('div');
  card.className = 'card flex flex-col gap-3';
  card.append(header, meta1, buttons);
  return card;
}

/* ----------------------------- Форма аккаунта -------------------------- */

/**
 * Внутренняя фабрика формы. Возвращает {form, getPayload}.
 */
function buildAccountForm(existingAccount) {
  const acc = existingAccount || {};
  const isEdit = !!existingAccount;
  const form = h('form', { class: 'grid grid-cols-2 gap-3' });

  const hintBox = h('div', {
    class: 'col-span-2 hidden rounded border border-[color:var(--color-accent-purple)] bg-[color:color-mix(in_srgb,var(--color-accent-purple)_8%,transparent)] px-3 py-2 text-xs text-[color:var(--color-accent-purple)]',
  });

  if (!isEdit) {
    const presetWrap = h('div', { class: 'col-span-2 flex items-center gap-2' }, [
      h('span', { class: 'text-sm font-medium text-[color:var(--color-text-primary)]', text: 'Быстрое заполнение:' }),
    ]);
    const presetSelect = h('select', { class: 'select max-w-[12rem]' }, [
      h('option', { value: '' }, '— пресет —'),
      h('option', { value: 'gmail' }, 'Gmail'),
      h('option', { value: 'yandex' }, 'Yandex'),
      h('option', { value: 'beget' }, 'Beget'),
    ]);
    presetSelect.addEventListener('change', (e) => applyPreset(e.target.value));
    presetWrap.appendChild(presetSelect);
    form.appendChild(presetWrap);
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
    const emailVal = form.elements.namedItem('email')?.value || '';
    if (emailVal) {
      setField('imap_user', emailVal);
      setField('smtp_user', emailVal);
    }
    hintBox.textContent = p.hint;
    hintBox.classList.remove('hidden');
  }

  // Простые именованные поля. Используем нативные input/select напрямую
  // чтобы field name работал внутри form.elements.namedItem.
  function fieldRow(labelText, control, full = false) {
    const wrap = h('label', { class: `flex flex-col gap-1 text-sm${full ? ' col-span-2' : ''}` }, [
      h('span', { class: 'text-sm font-medium text-[color:var(--color-text-primary)]', text: labelText }),
      control,
    ]);
    return wrap;
  }
  function inp(opts) {
    const el = document.createElement('input');
    el.className = 'input';
    el.name = opts.name;
    if (opts.type) el.type = opts.type;
    if (opts.placeholder) el.placeholder = opts.placeholder;
    if (opts.value !== undefined && opts.value !== null) el.value = String(opts.value);
    return el;
  }
  function chk(name, checked) {
    const el = document.createElement('input');
    el.type = 'checkbox';
    el.name = name;
    el.checked = !!checked;
    el.className = 'h-4 w-4 accent-[color:var(--color-accent-purple)]';
    return el;
  }
  function chkLabel(name, checked, text) {
    return h('label', { class: 'inline-flex items-center gap-2 text-sm text-[color:var(--color-text-primary)]' }, [
      chk(name, checked),
      h('span', { text }),
    ]);
  }

  form.appendChild(fieldRow('Label', inp({ name: 'label', value: acc.label })));
  form.appendChild(fieldRow('Email', inp({ name: 'email', type: 'email', value: acc.email })));
  form.appendChild(fieldRow('IMAP host', inp({ name: 'imap_host', value: acc.imap_host })));
  form.appendChild(fieldRow('IMAP port', inp({ name: 'imap_port', type: 'number', value: acc.imap_port })));
  form.appendChild(fieldRow('IMAP user', inp({ name: 'imap_user', value: acc.imap_user })));
  form.appendChild(
    fieldRow(
      `IMAP password${acc.has_imap_pass ? ' (задан — пусто = не менять)' : ''}`,
      inp({ name: 'imap_pass', type: 'password' }),
    ),
  );
  form.appendChild(fieldRow('SMTP host', inp({ name: 'smtp_host', value: acc.smtp_host })));
  form.appendChild(fieldRow('SMTP port', inp({ name: 'smtp_port', type: 'number', value: acc.smtp_port })));
  form.appendChild(fieldRow('SMTP user', inp({ name: 'smtp_user', value: acc.smtp_user })));
  form.appendChild(
    fieldRow(
      `SMTP password${acc.has_smtp_pass ? ' (задан — пусто = не менять)' : ''}`,
      inp({ name: 'smtp_pass', type: 'password' }),
    ),
  );
  form.appendChild(fieldRow('Folder', inp({ name: 'folder', value: acc.folder ?? 'INBOX' })));

  // Initial sync — упрощенная версия (selectbox + custom number).
  const currentSync = acc.initial_sync_count;
  const wantSync = currentSync !== null && currentSync !== undefined && currentSync !== 0;
  const presetValue =
    currentSync === -1 ? 'all' : [10, 50, 100, 500].includes(currentSync) ? String(currentSync) : wantSync ? 'custom' : '';

  const syncWrap = h('div', { class: 'col-span-2 rounded-[var(--radius-md)] border border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-elevated)] p-3' });

  const syncCheckbox = chk('__sync_on', wantSync);
  const syncPreset = h('select', { class: 'select w-fit', name: '__sync_preset' }, [
    h('option', { value: 'all' }, 'Все'),
    h('option', { value: '10' }, 'Последние 10'),
    h('option', { value: '50' }, 'Последние 50'),
    h('option', { value: '100' }, 'Последние 100'),
    h('option', { value: '500' }, 'Последние 500'),
    h('option', { value: 'custom' }, 'Другое число…'),
  ]);
  syncPreset.value = presetValue || 'all';
  const syncCustom = inp({ name: '__sync_custom', type: 'number', placeholder: 'N',
    value: presetValue === 'custom' && typeof currentSync === 'number' ? currentSync : '' });
  syncCustom.classList.add('w-24');

  const syncedBadge = acc.initial_synced
    ? h('span', { class: 'tag tag-green', text: '✓ синхронизирован' })
    : null;

  function updateSyncUI() {
    const on = syncCheckbox.checked;
    syncPreset.disabled = !on;
    syncCustom.style.display = on && syncPreset.value === 'custom' ? 'inline-block' : 'none';
    syncCustom.disabled = !on;
  }
  syncCheckbox.addEventListener('change', updateSyncUI);
  syncPreset.addEventListener('change', updateSyncUI);
  updateSyncUI();

  syncWrap.appendChild(
    h('label', { class: 'flex items-center gap-2 text-sm font-medium text-[color:var(--color-text-primary)]' }, [
      syncCheckbox,
      h('span', { text: 'Синхронизировать старые письма при первом подключении' }),
    ]),
  );
  syncWrap.appendChild(
    h('div', { class: 'mt-2 flex items-center gap-2 text-sm flex-wrap' }, [
      h('span', { class: 'text-[color:var(--color-text-secondary)]', text: 'Количество:' }),
      syncPreset,
      syncCustom,
      syncedBadge,
    ]),
  );
  if (isEdit && acc.initial_synced) {
    syncWrap.appendChild(
      h('div', { class: 'mt-1 text-xs text-[color:var(--color-text-muted)]', text: 'Изменение этого поля сбросит флаг и повторно синхронизирует историю.' }),
    );
  }
  form.appendChild(syncWrap);

  const flagsRow = h('div', { class: 'col-span-2 flex flex-wrap gap-4' }, [
    chkLabel('imap_tls', acc.imap_tls !== 0, 'IMAP TLS'),
    chkLabel('smtp_tls', acc.smtp_tls !== 0, 'SMTP TLS'),
    chkLabel('enabled', acc.enabled !== 0, 'Активен'),
  ]);
  form.appendChild(flagsRow);

  // Email blur копирует значение в imap_user/smtp_user если те пусты
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

  function getPayload() {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') {
        out[el.name] = el.checked ? 1 : 0;
      } else if (el.type === 'number') {
        out[el.name] = el.value === '' ? null : Number(el.value);
      } else {
        out[el.name] = el.value;
      }
    }
    if (isEdit) {
      if (!out.imap_pass) delete out.imap_pass;
      if (!out.smtp_pass) delete out.smtp_pass;
    }
    const syncOn = !!out.__sync_on;
    const preset = out.__sync_preset;
    const custom = out.__sync_custom;
    delete out.__sync_on;
    delete out.__sync_preset;
    delete out.__sync_custom;
    if (syncOn) {
      if (preset === 'all') out.initial_sync_count = -1;
      else if (preset === 'custom') {
        const n = Number(custom);
        out.initial_sync_count = Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
      } else out.initial_sync_count = Number(preset);
    } else {
      out.initial_sync_count = null;
    }
    for (const k of Object.keys(out)) {
      if (out[k] === '') out[k] = null;
    }
    return out;
  }

  return { form, getPayload, isEdit };
}

/* ------------------------------ openAccountModal ----------------------- */

/**
 * Открывает модалку добавления / редактирования аккаунта и монтирует её в
 * document.body. Возвращает корневой overlay-элемент (с методом .close()).
 *
 * @param {{ existingAccount?: object|null, onSave?: (saved:object)=>void, onClose?: Function }} opts
 */
export function openAccountModal({ existingAccount = null, onSave, onClose } = {}) {
  const isEdit = !!existingAccount;
  const { form, getPayload } = buildAccountForm(existingAccount);

  const status = h('span', { class: 'text-sm text-[color:var(--color-text-secondary)]' });

  const submit = async () => {
    const payload = getPayload();
    status.textContent = 'Сохраняю…';
    try {
      let saved;
      if (isEdit) {
        saved = await accountsApi.update(existingAccount.id, payload);
      } else {
        saved = await accountsApi.create(payload);
      }
      status.textContent = '';
      overlay.close();
      if (typeof onSave === 'function') onSave(saved);
    } catch (err) {
      status.textContent = '';
      const msg = err?.message || String(err);
      const banner = h('div', {
        class: 'rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800',
        text: msg,
      });
      form.prepend(banner);
      setTimeout(() => banner.remove(), 6000);
    }
  };

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    submit();
  });

  const overlay = Modal({
    title: isEdit ? `Редактирование: ${existingAccount.email || existingAccount.label || ''}` : 'Добавить почтовый аккаунт',
    children: form,
    footer: [
      status,
      Button({ label: 'Отмена', variant: 'ghost', onClick: () => overlay.close() }),
      Button({ label: isEdit ? 'Сохранить' : 'Подключить', variant: 'primary', icon: 'check', onClick: submit }),
    ],
    onClose,
  });

  // Шире, чем стандартный max-w-lg — у формы 2-колоночная сетка.
  const dialog = overlay.querySelector('.card');
  if (dialog) {
    dialog.classList.remove('max-w-lg');
    dialog.classList.add('max-w-2xl');
  }

  // Esc закрывает модалку.
  const onKey = (e) => {
    if (e.key === 'Escape') {
      overlay.close();
      window.removeEventListener('keydown', onKey);
    }
  };
  window.addEventListener('keydown', onKey);
  const origClose = overlay.close;
  overlay.close = () => {
    window.removeEventListener('keydown', onKey);
    origClose();
  };

  document.body.appendChild(overlay);
  return overlay;
}

/* --------------------- renderAccounts (legacy view) -------------------- */

/**
 * Legacy view-обёртка. После Phase 3 главным потребителем стал settings.js,
 * но если кто-то всё ещё вызывает напрямую — отрисуем сетку карточек.
 * @param {HTMLElement} root
 */
export async function renderAccounts(root) {
  root.innerHTML = '';
  const wrap = h('div', { class: 'flex flex-col gap-4' });
  root.appendChild(wrap);

  const header = h('div', { class: 'flex items-center justify-between' }, [
    h('h1', { class: 'text-xl font-semibold text-[color:var(--color-text-primary)]', text: 'Почтовые аккаунты' }),
  ]);
  const addBtn = Button({
    label: 'Подключить аккаунт',
    icon: 'plus',
    onClick: () =>
      openAccountModal({
        onSave: () => renderAccounts(root),
      }),
  });
  header.appendChild(addBtn);
  wrap.appendChild(header);

  const grid = h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4' });
  wrap.appendChild(grid);

  try {
    const resp = await accountsApi.list();
    const accounts = Array.isArray(resp) ? resp : resp.accounts || [];
    if (!accounts.length) {
      grid.replaceWith(
        EmptyState({
          icon: 'mail',
          title: 'Нет подключённых аккаунтов',
          description: 'Подключите почтовый ящик, чтобы письма начали поступать в систему.',
          cta: Button({
            label: 'Подключить аккаунт',
            icon: 'plus',
            onClick: () => openAccountModal({ onSave: () => renderAccounts(root) }),
          }),
        }),
      );
      return;
    }
    for (const acc of accounts) {
      grid.appendChild(
        renderAccountCard(acc, {
          onConfigure: () =>
            openAccountModal({ existingAccount: acc, onSave: () => renderAccounts(root) }),
          onDisconnect: async () => {
            // eslint-disable-next-line no-alert
            if (!window.confirm(`Отключить ${acc.email || acc.label || '#' + acc.id}?`)) return;
            try {
              await accountsApi.remove(acc.id);
              renderAccounts(root);
            } catch (err) {
              showError(root, err);
            }
          },
        }),
      );
    }
  } catch (err) {
    showError(root, err);
  }
}
