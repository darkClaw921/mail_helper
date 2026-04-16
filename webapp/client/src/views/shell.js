// views/shell.js — общий каркас приложения.
//
// Рендерит левый sidebar (220px, логотип MailMind AI + nav) и правую
// колонку с topbar (поиск + нотификации + avatar). Контент view
// складывается в возвращаемый <main> элемент (см. usage в main.js).
//
// API:
//   const main = renderShell(root, { activeRoute });
//   renderDashboard(main);           // произвольный render в main
//
// Для обратной совместимости поддерживается также
//   renderShell({ activeRoute, renderContent })
// — тогда renderContent вызывается с main-элементом, а шелл сам
// монтируется… но в этом случае функция возвращает корневой элемент.

import { icon } from '../components/icons.js';

const NAV_ITEMS = [
  { id: 'dashboard', href: '#/dashboard', label: 'Панель', icon: 'brain-circuit' },
  { id: 'inbox', href: '#/inbox', label: 'Входящие', icon: 'inbox' },
  { id: 'prompts', href: '#/prompts', label: 'Промты', icon: 'bookmark' },
  { id: 'actions', href: '#/actions', label: 'Действия', icon: 'zap' },
  { id: 'settings', href: '#/settings', label: 'Настройки', icon: 'settings' },
];

/**
 * Определяет id активного nav-пункта по hash.
 * `#/actions/new` и `#/actions/:id/edit` подсвечивают «Действия».
 */
function resolveActiveId(hash) {
  const h = (hash || '').replace(/^#/, '');
  if (h.startsWith('/dashboard')) return 'dashboard';
  if (h.startsWith('/inbox')) return 'inbox';
  if (h.startsWith('/prompts')) return 'prompts';
  if (h.startsWith('/actions')) return 'actions';
  if (h.startsWith('/settings')) return 'settings';
  return 'dashboard';
}

function buildSidebar(activeId) {
  const sidebar = document.createElement('aside');
  sidebar.className = 'flex flex-col shrink-0 border-r border-[color:var(--color-border-subtle)]';
  sidebar.style.width = '220px';
  sidebar.style.backgroundColor = 'var(--color-sidebar-bg)';
  sidebar.style.height = '100vh';
  sidebar.style.position = 'sticky';
  sidebar.style.top = '0';

  // Brand block
  const brand = document.createElement('div');
  brand.className = 'flex items-center gap-3 px-5 py-5 border-b border-[color:var(--color-border-subtle)]';
  const logo = document.createElement('div');
  logo.className = 'flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] text-white';
  logo.style.background = 'linear-gradient(135deg, var(--color-accent-purple), var(--color-accent-cyan))';
  logo.appendChild(icon('brain', { size: 20 }));
  const title = document.createElement('div');
  title.className = 'flex flex-col';
  const t1 = document.createElement('span');
  t1.className = 'text-sm font-semibold text-[color:var(--color-text-primary)]';
  t1.textContent = 'MailMind AI';
  const t2 = document.createElement('span');
  t2.className = 'text-xs text-[color:var(--color-text-secondary)]';
  t2.textContent = 'Почтовый ассистент';
  title.append(t1, t2);
  brand.append(logo, title);
  sidebar.appendChild(brand);

  // Nav
  const nav = document.createElement('nav');
  nav.className = 'flex flex-col gap-1 px-3 py-4 flex-1';
  for (const item of NAV_ITEMS) {
    const a = document.createElement('a');
    a.href = item.href;
    a.className = 'nav-item' + (item.id === activeId ? ' nav-item-active active' : '');
    a.appendChild(icon(item.icon, { size: 16 }));
    const label = document.createElement('span');
    label.textContent = item.label;
    a.appendChild(label);
    nav.appendChild(a);
  }
  sidebar.appendChild(nav);

  // User block (placeholder — позже заполняется реальными данными)
  const user = document.createElement('div');
  user.className = 'flex items-center gap-3 px-4 py-4 border-t border-[color:var(--color-border-subtle)]';
  const avatar = document.createElement('div');
  avatar.className = 'flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--color-bg-elevated)] text-[color:var(--color-text-secondary)]';
  avatar.appendChild(icon('user', { size: 18 }));
  const userInfo = document.createElement('div');
  userInfo.className = 'flex flex-col min-w-0';
  const uName = document.createElement('span');
  uName.className = 'text-sm font-medium text-[color:var(--color-text-primary)] truncate';
  uName.textContent = 'Пользователь';
  const uHint = document.createElement('span');
  uHint.className = 'text-xs text-[color:var(--color-text-muted)] truncate';
  uHint.textContent = 'локальный профиль';
  userInfo.append(uName, uHint);
  user.append(avatar, userInfo);
  sidebar.appendChild(user);

  return sidebar;
}

function buildTopbar(activeId) {
  const topbar = document.createElement('header');
  topbar.className = 'flex items-center justify-between gap-4 border-b border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-card)] px-6 py-3';

  // Search
  const searchWrap = document.createElement('div');
  searchWrap.className = 'relative flex-1 max-w-2xl';
  const searchIcon = icon('search', { size: 16 });
  searchIcon.setAttribute('class', 'absolute left-3 top-1/2 -translate-y-1/2 text-[color:var(--color-text-muted)]');
  const search = document.createElement('input');
  search.type = 'search';
  search.placeholder = 'Поиск писем, правил, промтов…';
  search.className = 'input pl-9';
  // Восстанавливаем текущий query (если был выставлен на прошлом экране).
  try {
    const q = window.__globalSearchQuery || '';
    if (q) search.value = q;
  } catch (_) { /* noop */ }

  function emitSearch(q, { navigate = false } = {}) {
    window.__globalSearchQuery = q;
    if (navigate) {
      const target = '#/inbox';
      if (window.location.hash !== target) {
        window.location.hash = target;
        // hashchange перерендерит view, который сам подхватит __globalSearchQuery
        return;
      }
    }
    window.dispatchEvent(new CustomEvent('global-search', { detail: { q } }));
  }

  search.addEventListener('input', (e) => {
    const q = e.target.value;
    // На экранах с собственным поиском — стримим ввод сразу; иначе ждём Enter.
    if (activeId === 'inbox' || activeId === 'prompts') {
      emitSearch(q);
    } else {
      window.__globalSearchQuery = q;
    }
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      emitSearch(e.target.value, { navigate: true });
    }
  });
  searchWrap.append(searchIcon, search);

  // Right side
  const right = document.createElement('div');
  right.className = 'flex items-center gap-3';
  const bellBtn = document.createElement('button');
  bellBtn.type = 'button';
  bellBtn.className = 'flex h-9 w-9 items-center justify-center rounded-[var(--radius-md)] border border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-card)] text-[color:var(--color-text-secondary)] hover:bg-[color:var(--color-bg-elevated)]';
  bellBtn.appendChild(icon('bell', { size: 16 }));
  const avatar = document.createElement('div');
  avatar.className = 'flex h-9 w-9 items-center justify-center rounded-full bg-[color:var(--color-bg-elevated)] text-[color:var(--color-text-secondary)]';
  avatar.appendChild(icon('user', { size: 18 }));
  right.append(bellBtn, avatar);

  topbar.append(searchWrap, right);
  return topbar;
}

/**
 * Основная фабрика shell. Поддерживает два вызова:
 *   renderShell(root, { activeRoute })        -> возвращает mainEl
 *   renderShell({ activeRoute, renderContent }) -> возвращает root shell-элемент
 *
 * @returns {HTMLElement}
 */
export function renderShell(a, b) {
  let root = null;
  let activeRoute = '';
  let renderContent = null;

  if (a && a.nodeType === 1) {
    // форма (root, opts)
    root = a;
    activeRoute = b?.activeRoute ?? window.location.hash;
  } else {
    // форма (opts)
    activeRoute = a?.activeRoute ?? window.location.hash;
    renderContent = typeof a?.renderContent === 'function' ? a.renderContent : null;
  }

  const activeId = resolveActiveId(activeRoute);

  const shell = document.createElement('div');
  shell.className = 'flex min-h-screen';

  shell.appendChild(buildSidebar(activeId));

  const right = document.createElement('div');
  right.className = 'flex flex-1 flex-col min-w-0 bg-[color:var(--color-bg-surface)]';
  right.appendChild(buildTopbar(activeId));

  const main = document.createElement('main');
  main.className = 'flex-1 p-6 overflow-auto';
  right.appendChild(main);
  shell.appendChild(right);

  if (root) {
    root.replaceChildren(shell);
    return main;
  }

  if (typeof renderContent === 'function') {
    try {
      renderContent(main);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.error('renderShell: renderContent failed', err);
      main.textContent = String(err?.message || err);
    }
  }
  return shell;
}

export { NAV_ITEMS };
