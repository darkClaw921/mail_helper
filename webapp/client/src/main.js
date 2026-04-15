// Точка входа SPA. Инициализирует hash-роутер и диспатчит на view-модули
// в client/src/views/. Роуты:
//   #/accounts  — список/редактирование почтовых аккаунтов
//   #/prompts   — список/редактирование LLM-промтов
//   #/actions   — список/редактирование actions
//   #/settings  — глобальные ключи (OpenRouter, Telegram, API key)

import './style.css';

import { renderAccounts } from './views/accounts.js';
import { renderPrompts } from './views/prompts.js';
import { renderActions } from './views/actions.js';
import { renderSettings } from './views/settings.js';
import { renderMessages } from './views/messages.js';
import { ensureApiKey } from './api.js';

const ROUTES = {
  '#/inbox': renderMessages,
  '#/accounts': renderAccounts,
  '#/prompts': renderPrompts,
  '#/actions': renderActions,
  '#/settings': renderSettings,
};

const root = document.getElementById('app');

function renderView() {
  const hash = window.location.hash || '#/inbox';
  const handler = ROUTES[hash] ?? renderMessages;
  root.innerHTML = '';
  try {
    handler(root);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('view render failed', err);
    root.textContent = String(err?.message || err);
  }
}

function boot() {
  // Захватываем api_key из query (?api_key=...) и сохраняем в sessionStorage.
  ensureApiKey();
  window.addEventListener('hashchange', renderView);
  if (!window.location.hash) window.location.hash = '#/inbox';
  renderView();
}

boot();
