// View /settings — глобальные ключи (OpenRouter, Telegram, mail-helper API-key).
// Значения приходят замаскированными (***). Поля ввода трактуются как
// "оставить без изменений, если пусто".

import { settingsApi } from '../api.js';
import { h, field, input, button, showError, formToObject } from './util.js';

export async function renderSettings(root) {
  const wrapper = h('div', { class: 'space-y-4' });
  root.appendChild(wrapper);
  wrapper.appendChild(h('h1', { class: 'text-xl font-semibold', text: 'Настройки' }));

  let current;
  try {
    current = await settingsApi.get();
  } catch (err) {
    showError(root, err);
    return;
  }

  const form = h('form', { class: 'space-y-3 rounded bg-white p-4 shadow-sm' });
  wrapper.appendChild(form);

  const fields = [
    { name: 'openrouter_api_key', label: 'OpenRouter API key' },
    { name: 'telegram_bot_token', label: 'Telegram bot token' },
    { name: 'api_key', label: 'Mail Helper API key (доступ к backend)' },
  ];
  for (const f of fields) {
    const present = current[`has_${f.name}`];
    form.appendChild(
      field(
        `${f.label} ${present ? '(задано — пусто = не менять)' : '(не задано)'}`,
        input({ name: f.name, type: 'password', placeholder: present ? '***' : '' }),
      ),
    );
  }

  const status = h('div', { class: 'text-sm text-slate-500' });
  const saveBtn = button('Сохранить', {
    variant: 'primary',
    type: 'submit',
  });
  form.appendChild(h('div', { class: 'flex items-center gap-3' }, [saveBtn, status]));

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const raw = formToObject(form);
    // Отправляем только непустые поля.
    const payload = {};
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'string' && v.length > 0) payload[k] = v;
    }
    if (Object.keys(payload).length === 0) {
      status.textContent = 'Нечего сохранять.';
      return;
    }
    try {
      status.textContent = 'Сохраняю…';
      const updated = await settingsApi.update(payload);
      status.textContent = 'Сохранено: ' + (updated.updated || []).join(', ');
      form.reset();
      // Перерисуем, чтобы обновить лейблы has_*.
      setTimeout(() => {
        root.innerHTML = '';
        renderSettings(root);
      }, 400);
    } catch (err) {
      status.textContent = '';
      showError(root, err);
    }
  });
}
