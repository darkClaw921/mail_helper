// content/gmail.js — инжектор iframe боковой панели на mail.google.com.
//
// Поведение:
//   • При загрузке страницы создаёт <iframe class="mh-sidebar-frame"> с
//     src=chrome.runtime.getURL('sidebar/sidebar.html') и добавляет в
//     document.documentElement (НЕ в body — чтобы пережить SPA-перерисовки
//     внутреннего контейнера Gmail).
//   • Навешивает MutationObserver на document.documentElement — если наш
//     iframe удалился (редко, но Gmail делает это при каких-то reflow) —
//     пересоздаёт.
//   • Кнопка toggle справа сворачивает панель в узкую полоску (кликом
//     разворачивается обратно). Состояние сохраняется в chrome.storage.local
//     (key: sidebar_collapsed_gmail).
//   • Добавляет на <html> класс mh-sidebar-open → content/inject.css сдвигает
//     содержимое вправо на --mh-sidebar-width.
//
// Пробрасывает chrome.runtime.onMessage вниз в iframe через postMessage,
// чтобы sidebar.js мог реагировать даже если iframe не зарегистрирован как
// прямой receiver runtime-сообщений (chrome.runtime.sendMessage должен
// доставлять и в frames, но делаем перестраховку).

(() => {
  'use strict';

  if (window.__mhSidebarInjected) return;
  window.__mhSidebarInjected = true;

  const STORAGE_KEY = 'sidebar_collapsed_gmail';
  const IFRAME_ID = 'mh-sidebar-frame';
  const TOGGLE_ID = 'mh-sidebar-toggle';

  let iframeEl = null;
  let toggleEl = null;
  let collapsed = false;

  function createToggle() {
    const btn = document.createElement('button');
    btn.id = TOGGLE_ID;
    btn.className = 'mh-sidebar-toggle';
    btn.type = 'button';
    btn.title = 'Toggle Mail Helper sidebar';
    btn.textContent = '▸';
    btn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setCollapsed(!collapsed);
    });
    return btn;
  }

  function createIframe() {
    const iframe = document.createElement('iframe');
    iframe.id = IFRAME_ID;
    iframe.className = 'mh-sidebar-frame';
    iframe.src = chrome.runtime.getURL('sidebar/sidebar.html');
    iframe.setAttribute('allowtransparency', 'true');
    iframe.setAttribute('aria-label', 'Mail Helper sidebar');
    // inline styles дублируют inject.css на случай позднего применения CSS.
    Object.assign(iframe.style, {
      position: 'fixed',
      top: '0',
      right: '0',
      width: 'var(--mh-sidebar-width, 380px)',
      height: '100vh',
      border: '0',
      margin: '0',
      padding: '0',
      zIndex: '2147483600',
      background: '#ffffff',
      boxShadow: '-2px 0 10px rgba(0,0,0,0.1)',
    });
    return iframe;
  }

  function ensureMounted() {
    const root = document.documentElement;
    if (!root) return;
    if (!iframeEl || !root.contains(iframeEl)) {
      iframeEl = createIframe();
      root.appendChild(iframeEl);
    }
    if (!toggleEl || !root.contains(toggleEl)) {
      toggleEl = createToggle();
      root.appendChild(toggleEl);
    }
    applyCollapsed();
  }

  function applyCollapsed() {
    const root = document.documentElement;
    if (!root) return;
    root.classList.add('mh-sidebar-open');
    if (collapsed) {
      root.classList.add('mh-sidebar-collapsed');
      iframeEl?.classList.add('mh-collapsed');
      toggleEl?.classList.add('mh-collapsed');
      if (toggleEl) toggleEl.textContent = '◂';
    } else {
      root.classList.remove('mh-sidebar-collapsed');
      iframeEl?.classList.remove('mh-collapsed');
      toggleEl?.classList.remove('mh-collapsed');
      if (toggleEl) toggleEl.textContent = '▸';
    }
  }

  async function loadCollapsedState() {
    try {
      const s = await chrome.storage.local.get([STORAGE_KEY]);
      collapsed = !!s[STORAGE_KEY];
    } catch {
      collapsed = false;
    }
    applyCollapsed();
  }

  async function setCollapsed(value) {
    collapsed = !!value;
    applyCollapsed();
    try {
      await chrome.storage.local.set({ [STORAGE_KEY]: collapsed });
    } catch {
      /* ignore */
    }
  }

  // Пересоздаём iframe если Gmail его удалил (редко, но SPA-reflow бывает).
  function startObserver() {
    const target = document.documentElement;
    if (!target) return;
    const mo = new MutationObserver(() => {
      if (!iframeEl || !target.contains(iframeEl)) {
        ensureMounted();
      }
    });
    mo.observe(target, { childList: true, subtree: false });
  }

  // Пробрасываем runtime-сообщения в iframe (на случай если напрямую не дошло).
  function wireRuntimeBridge() {
    chrome.runtime.onMessage.addListener((msg) => {
      if (!msg || !iframeEl?.contentWindow) return;
      // Don't spam; только известные типы
      const known = new Set(['new_message', 'updated', 'ws_status', 'focus_message']);
      if (!known.has(msg.type)) return;
      try {
        iframeEl.contentWindow.postMessage({ __mh: true, ...msg }, '*');
      } catch {
        /* ignore cross-origin edge cases */
      }
    });
  }

  function boot() {
    ensureMounted();
    loadCollapsedState();
    startObserver();
    wireRuntimeBridge();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot, { once: true });
  } else {
    boot();
  }
})();
