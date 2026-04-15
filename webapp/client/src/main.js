// Точка входа SPA. Инициализирует hash-роутер, оборачивает каждый view в
// общий shell (sidebar + topbar) и диспатчит на view-модули в views/.
//
// Маршруты:
//   #/              -> redirect to #/dashboard
//   #/dashboard     -> views/dashboard.js
//   #/inbox         -> views/messages.js
//   #/prompts       -> views/prompts.js
//   #/actions       -> views/actions.js
//   #/actions/new   -> views/actionEditor.js { mode:'new' }
//   #/actions/:id/edit -> views/actionEditor.js { mode:'edit', id }
//   #/settings      -> views/settings.js
//   #/accounts      -> redirect to #/settings (legacy)

import './style.css';

import { ensureApiKey } from './api.js';
import { renderShell } from './views/shell.js';
import { renderDashboard } from './views/dashboard.js';
import { renderMessages } from './views/messages.js';
import { renderPrompts } from './views/prompts.js';
import { renderActions } from './views/actions.js';
import { renderActionEditor } from './views/actionEditor.js';
import { renderSettings } from './views/settings.js';

function renderPlaceholder(main, title, description) {
  main.replaceChildren();
  const wrap = document.createElement('div');
  wrap.className = 'flex flex-col gap-4';
  const h = document.createElement('h1');
  h.className = 'text-2xl font-semibold';
  h.textContent = title;
  const p = document.createElement('p');
  p.className = 'text-sm text-[color:var(--color-text-secondary)]';
  p.textContent = description;
  wrap.append(h, p);
  main.appendChild(wrap);
}

/**
 * Парсит hash и возвращает { route, params }, где route — нормализованный
 * ключ (например '#/actions/edit'), а params — данные из URL (id).
 */
function matchRoute(rawHash) {
  const hash = rawHash || '#/dashboard';
  if (hash === '' || hash === '#' || hash === '#/') {
    return { route: '#/dashboard', params: {} };
  }
  if (hash === '#/accounts') {
    return { route: '#/settings', params: {}, redirect: '#/settings' };
  }
  if (hash === '#/actions/new') {
    return { route: '#/actions/new', params: { mode: 'new' } };
  }
  const editMatch = hash.match(/^#\/actions\/([^/]+)\/edit$/);
  if (editMatch) {
    return { route: '#/actions/edit', params: { mode: 'edit', id: editMatch[1] } };
  }
  if (['#/dashboard', '#/inbox', '#/prompts', '#/actions', '#/settings'].includes(hash)) {
    return { route: hash, params: {} };
  }
  return { route: '#/dashboard', params: {} };
}

const root = document.getElementById('app');

async function renderCurrentView() {
  const { route, params, redirect } = matchRoute(window.location.hash);
  if (redirect) {
    window.location.hash = redirect;
    return;
  }
  // Пересоздаём shell на каждой навигации, чтобы активный пункт обновлялся.
  const main = renderShell(root, { activeRoute: route });
  try {
    switch (route) {
      case '#/dashboard':
        await renderDashboard(main);
        break;
      case '#/inbox':
        renderMessages(main);
        break;
      case '#/prompts':
        renderPrompts(main);
        break;
      case '#/actions':
        renderActions(main);
        break;
      case '#/actions/new':
      case '#/actions/edit':
        await renderActionEditor(main, params);
        break;
      case '#/settings':
        renderSettings(main);
        break;
      default:
        renderPlaceholder(main, 'Не найдено', `Маршрут ${route} отсутствует.`);
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('view render failed', err);
    main.textContent = String(err?.message || err);
  }
}

function boot() {
  // Захватываем api_key из query (?api_key=...) и сохраняем в sessionStorage.
  ensureApiKey();
  window.addEventListener('hashchange', renderCurrentView);
  if (!window.location.hash || window.location.hash === '#' || window.location.hash === '#/') {
    window.location.hash = '#/dashboard';
    return; // hashchange сработает сам
  }
  renderCurrentView();
}

boot();
