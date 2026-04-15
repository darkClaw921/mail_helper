// Небольшие утилиты для views. Без зависимостей — ванильный DOM.

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
 * Простая обёртка для кнопки Tailwind.
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
