// Небольшие утилиты для views. Без зависимостей — ванильный DOM.
//
// Содержит:
//  - h(tag, opts, children) — базовая фабрика элемента.
//  - escapeHtml / formToObject — общие helper'ы.
//  - formatDate / formatRelative — форматирование дат (ru-RU).
//  - renderTabs — фабрика таб-контейнера (удобна, когда нужен inline без
//    компонента из ui.js; сам ui.js также экспортирует Tabs).
//  - statusDot — цветная точка статуса.
//  - showError / button / field / input / textarea / select / checkbox —
//    legacy helpers, которые уже используются во view-модулях. Оставлены
//    ради обратной совместимости во время поэтапного редизайна; новые
//    view пишем через components/ui.js.

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

export function escapeHtml(value) {
  if (value === null || value === undefined) return '';
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}

/**
 * Создаёт элемент и задаёт атрибуты/слушатели/детей разом.
 */
export function h(tag, opts = {}, children = []) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(opts)) {
    if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') {
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v !== null && v !== undefined && v !== false) {
      el.setAttribute(k, v === true ? '' : v);
    }
  }
  for (const child of [].concat(children)) {
    if (child == null || child === false) continue;
    if (typeof child === 'string') el.appendChild(document.createTextNode(child));
    else el.appendChild(child);
  }
  return el;
}

/**
 * Простой debounce: возвращает функцию, которая откладывает вызов `fn` на
 * `wait` мс. Повторные вызовы сбрасывают таймер. У возвращённой функции есть
 * метод `.cancel()` для очистки отложенного вызова (удобно при unmount/смене
 * контекста, например при переключении промта).
 *
 * @template {(...args:any[])=>any} F
 * @param {F} fn
 * @param {number} wait
 * @returns {F & { cancel: () => void }}
 */
export function debounce(fn, wait = 300) {
  let timer = null;
  const wrapped = function (...args) {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      fn.apply(this, args);
    }, wait);
  };
  wrapped.cancel = () => {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
  return wrapped;
}

export function showError(root, err) {
  const msg = err?.message || String(err);
  const banner = h('div', {
    class:
      'mb-3 rounded border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800',
    text: msg,
  });
  root.prepend(banner);
  setTimeout(() => banner.remove(), 6000);
}

/**
 * Простая обёртка для кнопки Tailwind (legacy — для старых views).
 * Новые view используют components/ui.js Button().
 */
export function button(label, { variant = 'primary', type = 'button', onClick } = {}) {
  const cls =
    variant === 'danger'
      ? 'rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700'
      : variant === 'secondary'
        ? 'rounded border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50'
        : 'rounded bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700';
  return h('button', { type, class: cls, onclick: onClick }, label);
}

export function field(label, input) {
  return h('label', { class: 'block text-sm' }, [
    h('span', { class: 'mb-1 block font-medium text-slate-700', text: label }),
    input,
  ]);
}

export function input({ name, value = '', type = 'text', placeholder = '' } = {}) {
  const el = h('input', {
    type,
    name,
    value: value ?? '',
    placeholder,
    class:
      'block w-full rounded border border-slate-300 px-2 py-1 text-sm focus:border-indigo-500 focus:outline-none',
  });
  return el;
}

export function textarea({ name, value = '', rows = 4, placeholder = '' } = {}) {
  const el = h('textarea', {
    name,
    rows,
    placeholder,
    class:
      'block w-full rounded border border-slate-300 px-2 py-1 font-mono text-sm focus:border-indigo-500 focus:outline-none',
  });
  el.value = value ?? '';
  return el;
}

export function select({ name, value = '', options = [] } = {}) {
  const el = h('select', {
    name,
    class: 'block w-full rounded border border-slate-300 px-2 py-1 text-sm',
  });
  for (const opt of options) {
    const o = h('option', { value: opt.value }, opt.label);
    if (opt.value === value) o.selected = true;
    el.appendChild(o);
  }
  return el;
}

export function checkbox({ name, checked = false, label = '' } = {}) {
  const el = h('input', { type: 'checkbox', name, class: 'mr-2' });
  el.checked = !!checked;
  return h('label', { class: 'inline-flex items-center text-sm' }, [el, label]);
}

export function formToObject(form) {
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
  return out;
}

/* --------------------- Форматирование --------------------- */

/**
 * Форматирует абсолютную дату в формате `DD.MM.YYYY HH:MM` (ru-RU).
 * @param {string|number|Date} value
 */
export function formatDate(value) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

const RELATIVE_UNITS = [
  { limit: 60, div: 1, name: 'секунд' },
  { limit: 3600, div: 60, name: 'минут' },
  { limit: 86400, div: 3600, name: 'часов' },
  { limit: 86400 * 7, div: 86400, name: 'дн' },
  { limit: 86400 * 30, div: 86400 * 7, name: 'нед' },
  { limit: 86400 * 365, div: 86400 * 30, name: 'мес' },
];

/**
 * Возвращает относительное время вида "5 минут назад" / "через 2 часа".
 * Поддерживает ISO-строку, Date или unix-ms.
 * @param {string|number|Date} value
 */
export function formatRelative(value) {
  if (value == null || value === '') return '';
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  const now = Date.now();
  const diffSec = Math.round((now - d.getTime()) / 1000);
  const abs = Math.abs(diffSec);
  if (abs < 10) return 'только что';
  let label;
  let amount;
  let unit;
  for (const u of RELATIVE_UNITS) {
    if (abs < u.limit) {
      amount = Math.round(abs / u.div);
      unit = u.name;
      break;
    }
  }
  if (unit === undefined) {
    amount = Math.round(abs / (86400 * 365));
    unit = 'г';
  }
  label = `${amount} ${unit}`;
  return diffSec >= 0 ? `${label} назад` : `через ${label}`;
}

/* --------------------- Status dot --------------------- */

const STATUS_COLORS = {
  active: 'var(--color-accent-green)',
  success: 'var(--color-accent-green)',
  paused: 'var(--color-text-muted)',
  idle: 'var(--color-text-muted)',
  error: 'var(--color-accent-red)',
  pending: 'var(--color-accent-orange)',
  warning: 'var(--color-accent-orange)',
  info: 'var(--color-accent-cyan)',
};

/**
 * Возвращает небольшой <span> — цветная точка статуса.
 * @param {string} status — ключ из STATUS_COLORS или CSS-цвет.
 */
export function statusDot(status) {
  const color = STATUS_COLORS[status] || status || STATUS_COLORS.idle;
  const span = document.createElement('span');
  span.className = 'inline-block rounded-full';
  span.style.width = '0.5rem';
  span.style.height = '0.5rem';
  span.style.backgroundColor = color;
  return span;
}

/* --------------------- Tabs (inline helper) --------------------- */

/**
 * Рендерит горизонтальный ряд табов в переданный контейнер, очищая его
 * содержимое. Активный таб выделяется bg-card. При клике — вызывает
 * onChange(id).
 *
 * @param {HTMLElement} container
 * @param {Array<{id:string,label:string,count?:number}>} tabs
 * @param {string} active
 * @param {(id:string)=>void} onChange
 */
export function renderTabs(container, tabs, active, onChange) {
  if (!container) return null;
  container.innerHTML = '';
  container.className = 'flex items-center gap-1 rounded-[var(--radius-md)] bg-[color:var(--color-bg-elevated)] p-1 w-fit';
  for (const t of tabs) {
    const isActive = t.id === active;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('role', 'tab');
    btn.setAttribute('aria-selected', String(isActive));
    btn.className = [
      'flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium transition-colors',
      isActive
        ? 'bg-[color:var(--color-bg-card)] text-[color:var(--color-text-primary)] shadow-sm'
        : 'text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]',
    ].join(' ');
    btn.textContent = t.label;
    if (typeof t.count === 'number') {
      const badge = document.createElement('span');
      badge.className = 'ml-2 rounded-full bg-[color:var(--color-bg-elevated)] px-1.5 text-xs text-[color:var(--color-text-secondary)]';
      badge.textContent = String(t.count);
      btn.appendChild(badge);
    }
    btn.addEventListener('click', () => {
      if (typeof onChange === 'function') onChange(t.id);
    });
    container.appendChild(btn);
  }
  return container;
}
