// template.js — общий рендерер плейсхолдеров для action-шаблонов.
//
// Используется в actions/telegram.js и actions/webhook.js при наличии
// config.template (задаётся пользователем в UI «Правила маршрутизации» или в
// редакторе actionEditor.js).
//
// Поддерживаемые плейсхолдеры вида `{key}`:
//   * Из message: {subject}, {from} (alias from_addr), {to} (alias to_addr),
//     {snippet}, {date}, {id}, {message_id}.
//   * Из classification: {important}, {reason}, {summary}, {tags},
//     плюс любые ключи output_params промта.
//
// Правила:
//   * Неизвестные плейсхолдеры оставляются как есть (`{foo}`), чтобы юзер сразу
//     увидел опечатку в итоговом сообщении.
//   * Массивы (например tags) склеиваются через `, `.
//   * null/undefined → пустая строка.
//   * Экранирование/HTML — на стороне вызывающего модуля.

function valueFor(key, ctx) {
  const message = ctx.message || {};
  const cls = ctx.classification || {};

  // message aliases
  switch (key) {
    case 'subject':
      return message.subject ?? '';
    case 'from':
    case 'from_addr':
      return message.from_addr ?? message.from ?? '';
    case 'to':
    case 'to_addr':
      return message.to_addr ?? message.to ?? '';
    case 'snippet':
      return message.snippet ?? '';
    case 'date':
      return message.date ?? '';
    case 'id':
      return message.id ?? '';
    case 'message_id':
      return message.message_id ?? '';
    default:
      break;
  }

  // classification
  if (key in cls) {
    const v = cls[key];
    if (v == null) return '';
    if (Array.isArray(v)) return v.join(', ');
    if (typeof v === 'object') return JSON.stringify(v);
    return String(v);
  }

  return undefined;
}

/**
 * Отрендерить строку-шаблон, подставив плейсхолдеры `{key}`.
 * @param {string} template
 * @param {{ message?: object, classification?: object }} ctx
 * @param {{ escape?: (s:string)=>string }} [opts] — опциональный escaper,
 *   применяется к каждому подставленному значению (напр. escapeHtml для Telegram).
 * @returns {string}
 */
export function renderTemplate(template, ctx, opts = {}) {
  if (typeof template !== 'string' || template.length === 0) return '';
  const esc = typeof opts.escape === 'function' ? opts.escape : (s) => s;
  return template.replace(/\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, key) => {
    const v = valueFor(key, ctx);
    if (v === undefined) return match; // неизвестный ключ — оставить как есть
    if (v === '') return '';
    return esc(String(v));
  });
}

export default { renderTemplate };
