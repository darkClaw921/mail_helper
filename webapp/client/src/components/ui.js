// components/ui.js — UI-примитивы без фреймворка.
//
// Каждая функция — чистая фабрика: принимает объект опций и возвращает
// HTMLElement, готовый к монтированию в DOM. Стили подтягиваются из
// @layer components в style.css (.card, .btn-primary, .tag, .toggle и т.д.).

import { icon as renderIcon } from './icons.js';

/* ---------- Низкоуровневый helper ---------- */

/**
 * Мини-фабрика элемента.
 * Не экспортируем из util.js чтобы components/ оставался независимым
 * от views/.
 */
function el(tag, opts = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(opts)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class' || k === 'className') {
      node.className = v;
    } else if (k === 'text') {
      node.textContent = v;
    } else if (k === 'html') {
      node.innerHTML = v;
    } else if (k === 'style' && typeof v === 'object') {
      Object.assign(node.style, v);
    } else if (k.startsWith('on') && typeof v === 'function') {
      node.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (v === true) {
      node.setAttribute(k, '');
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    if (typeof child === 'string' || typeof child === 'number') {
      node.appendChild(document.createTextNode(String(child)));
    } else {
      node.appendChild(child);
    }
  }
  return node;
}

function resolveIcon(maybeIcon, size = 16) {
  if (!maybeIcon) return null;
  if (maybeIcon instanceof Node) return maybeIcon;
  if (typeof maybeIcon === 'string') return renderIcon(maybeIcon, { size });
  return null;
}

/* ---------- Card ---------- */

/**
 * @param {{ title?: string, subtitle?: string, actions?: Node|Node[], children?: Node|Node[], className?: string }} opts
 */
export function Card({ title, subtitle, actions, children, className = '' } = {}) {
  const parts = [];
  if (title || subtitle || actions) {
    const header = el('div', { class: 'flex items-start justify-between gap-4 mb-4' }, [
      el('div', {}, [
        title ? el('h3', { class: 'text-base font-semibold text-[color:var(--color-text-primary)]', text: title }) : null,
        subtitle ? el('p', { class: 'text-sm text-[color:var(--color-text-secondary)] mt-1', text: subtitle }) : null,
      ]),
      actions ? el('div', { class: 'flex items-center gap-2' }, [].concat(actions)) : null,
    ]);
    parts.push(header);
  }
  if (children) {
    const body = el('div', { class: 'flex flex-col gap-3' }, [].concat(children));
    parts.push(body);
  }
  return el('div', { class: `card ${className}`.trim() }, parts);
}

/* ---------- Button ---------- */

/**
 * @param {{ label?: string, variant?: 'primary'|'ghost'|'danger', icon?: string|Node, onClick?: Function, size?: 'sm'|'md', disabled?: boolean, type?: string, className?: string }} opts
 */
export function Button({
  label,
  variant = 'primary',
  icon,
  onClick,
  size = 'md',
  disabled = false,
  type = 'button',
  className = '',
} = {}) {
  const variantCls =
    variant === 'danger' ? 'btn-danger' : variant === 'ghost' ? 'btn-ghost' : 'btn-primary';
  const sizeCls = size === 'sm' ? 'text-xs py-1 px-2' : '';
  const btn = el(
    'button',
    {
      type,
      class: `btn ${variantCls} ${sizeCls} ${className}`.trim(),
      disabled,
      onClick,
    },
    [resolveIcon(icon, size === 'sm' ? 14 : 16), label ? el('span', { text: label }) : null],
  );
  return btn;
}

/* ---------- StatsCard ---------- */

/**
 * @param {{ label: string, value: string|number, icon?: string, accent?: 'purple'|'cyan'|'green'|'orange'|'pink'|'red', delta?: string }} opts
 */
export function StatsCard({ label, value, icon, accent = 'purple', delta } = {}) {
  const accentVar = `var(--color-accent-${accent})`;
  const iconTile = icon
    ? el(
        'div',
        {
          class: 'flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)]',
          style: { backgroundColor: `color-mix(in srgb, ${accentVar} 14%, transparent)`, color: accentVar },
        },
        [resolveIcon(icon, 20)],
      )
    : null;
  return el('div', { class: 'stat-card' }, [
    el('div', { class: 'flex items-center justify-between' }, [
      el('span', {
        class: 'text-xs uppercase tracking-wide text-[color:var(--color-text-secondary)]',
        text: label ?? '',
      }),
      iconTile,
    ]),
    el('div', { class: 'text-2xl font-semibold text-[color:var(--color-text-primary)]', text: String(value ?? '') }),
    delta
      ? el('div', {
          class: 'text-xs text-[color:var(--color-text-secondary)]',
          text: delta,
        })
      : null,
  ]);
}

/* ---------- Toggle ---------- */

/**
 * @param {{ checked?: boolean, onChange?: (next: boolean) => void, label?: string, disabled?: boolean }} opts
 */
export function Toggle({ checked = false, onChange, label, disabled = false } = {}) {
  let state = !!checked;
  const dot = el('span', { class: `toggle ${state ? 'is-on' : ''}`, role: 'switch', 'aria-checked': String(state), tabindex: '0' });
  const toggle = () => {
    if (disabled) return;
    state = !state;
    dot.classList.toggle('is-on', state);
    dot.setAttribute('aria-checked', String(state));
    if (typeof onChange === 'function') onChange(state);
  };
  dot.addEventListener('click', toggle);
  dot.addEventListener('keydown', (e) => {
    if (e.key === ' ' || e.key === 'Enter') {
      e.preventDefault();
      toggle();
    }
  });
  if (!label) return dot;
  return el('label', { class: 'inline-flex items-center gap-2 text-sm text-[color:var(--color-text-primary)] cursor-pointer select-none' }, [
    dot,
    el('span', { text: label }),
  ]);
}

/* ---------- TagBadge ---------- */

/**
 * @param {{ label: string, variant?: 'neutral'|'purple'|'green'|'red'|'orange'|'cyan' }} opts
 */
export function TagBadge({ label, variant = 'neutral' } = {}) {
  const variantCls = variant === 'neutral' ? '' : `tag-${variant}`;
  return el('span', { class: `tag ${variantCls}`.trim(), text: label ?? '' });
}

/* ---------- Input / Textarea / Select ---------- */

function formField(labelText, control, hint) {
  return el('label', { class: 'flex flex-col gap-1 text-sm' }, [
    labelText
      ? el('span', { class: 'text-sm font-medium text-[color:var(--color-text-primary)]', text: labelText })
      : null,
    control,
    hint ? el('span', { class: 'text-xs text-[color:var(--color-text-muted)]', text: hint }) : null,
  ]);
}

/**
 * @param {{ label?: string, value?: string, onInput?: Function, type?: string, placeholder?: string, hint?: string, name?: string, disabled?: boolean }} opts
 */
export function Input({ label, value = '', onInput, type = 'text', placeholder = '', hint, name, disabled = false } = {}) {
  const input = el('input', {
    type,
    name,
    placeholder,
    class: 'input',
    disabled,
  });
  input.value = value ?? '';
  if (typeof onInput === 'function') {
    input.addEventListener('input', (e) => onInput(e.target.value, e));
  }
  if (!label && !hint) return input;
  return formField(label, input, hint);
}

/**
 * @param {{ label?: string, value?: string, onInput?: Function, rows?: number, placeholder?: string, hint?: string, name?: string }} opts
 */
export function Textarea({ label, value = '', onInput, rows = 4, placeholder = '', hint, name } = {}) {
  const textarea = el('textarea', { rows, placeholder, name, class: 'textarea' });
  textarea.value = value ?? '';
  if (typeof onInput === 'function') {
    textarea.addEventListener('input', (e) => onInput(e.target.value, e));
  }
  if (!label && !hint) return textarea;
  return formField(label, textarea, hint);
}

/**
 * @param {{ label?: string, value?: string, options: Array<{value:string,label:string}|string>, onChange?: Function, hint?: string, name?: string }} opts
 */
export function Select({ label, value = '', options = [], onChange, hint, name } = {}) {
  const select = el('select', { class: 'select', name });
  for (const opt of options) {
    const o = typeof opt === 'string' ? { value: opt, label: opt } : opt;
    const option = el('option', { value: o.value, text: o.label });
    if (String(o.value) === String(value)) option.selected = true;
    select.appendChild(option);
  }
  if (typeof onChange === 'function') {
    select.addEventListener('change', (e) => onChange(e.target.value, e));
  }
  if (!label && !hint) return select;
  return formField(label, select, hint);
}

/* ---------- SectionHeader ---------- */

/**
 * @param {{ title: string, subtitle?: string, actions?: Node|Node[] }} opts
 */
export function SectionHeader({ title, subtitle, actions } = {}) {
  return el('div', { class: 'flex items-start justify-between gap-4 mb-4' }, [
    el('div', {}, [
      el('h2', { class: 'text-xl font-semibold text-[color:var(--color-text-primary)]', text: title ?? '' }),
      subtitle ? el('p', { class: 'text-sm text-[color:var(--color-text-secondary)] mt-1', text: subtitle }) : null,
    ]),
    actions ? el('div', { class: 'flex items-center gap-2 shrink-0' }, [].concat(actions)) : null,
  ]);
}

/* ---------- EmptyState ---------- */

/**
 * @param {{ icon?: string, title: string, description?: string, cta?: Node }} opts
 */
export function EmptyState({ icon, title, description, cta } = {}) {
  return el(
    'div',
    {
      class: 'flex w-full flex-col items-center justify-center gap-3 rounded-[var(--radius-lg)] border border-dashed border-[color:var(--color-border-subtle)] p-8 text-center',
    },
    [
      icon
        ? el(
            'div',
            {
              class: 'flex h-12 w-12 items-center justify-center rounded-full bg-[color:var(--color-bg-elevated)] text-[color:var(--color-text-secondary)]',
            },
            [resolveIcon(icon, 24)],
          )
        : null,
      el('h3', {
        class: 'text-base font-semibold text-[color:var(--color-text-primary)]',
        style: { width: '100%', textAlign: 'center' },
        text: title ?? '',
      }),
      description
        ? el('p', {
            class: 'text-sm text-[color:var(--color-text-secondary)]',
            style: {
              width: '100%',
              maxWidth: '28rem',
              textAlign: 'center',
              whiteSpace: 'normal',
              wordBreak: 'normal',
              overflowWrap: 'normal',
            },
            text: description,
          })
        : null,
      cta || null,
    ],
  );
}

/* ---------- IconTile ---------- */

/**
 * @param {{ icon: string, accent?: 'purple'|'cyan'|'green'|'orange'|'pink'|'red', size?: number, label?: string, onClick?: Function }} opts
 */
export function IconTile({ icon, accent = 'purple', size = 20, label, onClick } = {}) {
  const accentVar = `var(--color-accent-${accent})`;
  const tile = el(
    'div',
    {
      class: 'flex h-10 w-10 items-center justify-center rounded-[var(--radius-md)]',
      style: { backgroundColor: `color-mix(in srgb, ${accentVar} 14%, transparent)`, color: accentVar },
    },
    [resolveIcon(icon, size)],
  );
  if (!label && !onClick) return tile;
  const wrap = el(
    onClick ? 'button' : 'div',
    {
      class: 'flex items-center gap-3 text-left',
      type: onClick ? 'button' : undefined,
      onClick,
    },
    [tile, label ? el('span', { class: 'text-sm font-medium', text: label }) : null],
  );
  return wrap;
}

/* ---------- Tabs ---------- */

/**
 * @param {{ tabs: Array<{id:string,label:string,count?:number}>, active?: string, onChange?: (id:string)=>void }} opts
 */
export function Tabs({ tabs = [], active, onChange } = {}) {
  const row = el('div', {
    class: 'flex items-center gap-1 rounded-[var(--radius-md)] bg-[color:var(--color-bg-elevated)] p-1',
    role: 'tablist',
  });
  for (const t of tabs) {
    const isActive = t.id === active;
    const btn = el(
      'button',
      {
        type: 'button',
        role: 'tab',
        'aria-selected': String(isActive),
        class: [
          'flex items-center gap-2 rounded-[var(--radius-sm)] px-3 py-1.5 text-sm font-medium transition-colors',
          isActive
            ? 'bg-[color:var(--color-bg-card)] text-[color:var(--color-text-primary)] shadow-sm'
            : 'text-[color:var(--color-text-secondary)] hover:text-[color:var(--color-text-primary)]',
        ].join(' '),
        onClick: () => {
          if (typeof onChange === 'function') onChange(t.id);
        },
      },
      [
        el('span', { text: t.label }),
        typeof t.count === 'number'
          ? el('span', {
              class: 'rounded-full bg-[color:var(--color-bg-elevated)] px-1.5 text-xs text-[color:var(--color-text-secondary)]',
              text: String(t.count),
            })
          : null,
      ],
    );
    row.appendChild(btn);
  }
  return row;
}

/* ---------- Modal ---------- */

/**
 * Простой overlay-модал. Возвращает корневой элемент — его добавляют в
 * document.body и вызывают .close() или удаляют вручную.
 * @param {{ title?: string, children?: Node|Node[], onClose?: Function, footer?: Node|Node[], size?: 'sm'|'md'|'lg'|'xl' }} opts
 */
export function Modal({ title, children, onClose, footer, size = 'md' } = {}) {
  const overlay = el('div', {
    class: 'fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4',
    role: 'dialog',
    'aria-modal': 'true',
  });
  const close = () => {
    overlay.remove();
    if (typeof onClose === 'function') onClose();
  };
  const closeBtn = Button({
    variant: 'ghost',
    icon: 'x',
    size: 'sm',
    onClick: close,
    className: '!p-1.5',
  });
  const sizeCls = {
    sm: 'max-w-md',
    md: 'max-w-2xl',
    lg: 'max-w-4xl',
    xl: 'max-w-6xl',
  }[size] || 'max-w-2xl';
  const dialog = el(
    'div',
    {
      class: `card w-full ${sizeCls} max-h-[90vh] overflow-auto`,
      onClick: (e) => e.stopPropagation(),
    },
    [
      el('div', { class: 'flex items-start justify-between gap-4 mb-4' }, [
        el('h3', { class: 'text-lg font-semibold', text: title ?? '' }),
        closeBtn,
      ]),
      el('div', { class: 'flex flex-col gap-3' }, [].concat(children || [])),
      footer
        ? el('div', { class: 'flex items-center justify-end gap-2 mt-5 pt-4 border-t border-[color:var(--color-border-subtle)]' }, [].concat(footer))
        : null,
    ],
  );
  overlay.appendChild(dialog);
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  overlay.close = close;
  return overlay;
}
