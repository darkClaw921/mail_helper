// browser.js — action-плагин уведомления в браузер через WS hub.
//
// Фаза 5: заготовка. WS hub будет реализован в Фазе 6 (webapp/server/ws/hub.js).
// Пока hub не подключен — этот модуль публикует событие 'action:browser' в
// mailEvents; фаза 6 подпишет hub.broadcast('notify', ...) на это событие
// (см. mh-pz9.4). Это даёт loose coupling: actions/browser не импортирует ws/hub.
//
// config: { title?: string, body?: string }
//   * если title/body не заданы — берём from_addr / subject|summary как дефолты.
//
// Возвращает { ok: true, emitted: true } — публикация в EventEmitter
// синхронна и не может упасть на сетевом уровне.

import { mailEvents } from '../mail/events.js';
import { logger } from '../logger.js';

const log = logger.child({ module: 'action:browser' });

function clip(s, max) {
  if (s == null) return '';
  const str = String(s);
  return str.length <= max ? str : str.slice(0, max) + '…';
}

/**
 * Опубликовать browser-уведомление в mailEvents. WS hub подхватит на фазе 6.
 * @param {{ title?: string, body?: string }} config
 * @param {object} message
 * @param {object} classification
 * @returns {Promise<{ ok: true, emitted: true }>}
 */
export async function browserAction(config, message, classification) {
  const title =
    (typeof config?.title === 'string' && config.title.trim()) ||
    (message?.from_addr && clip(message.from_addr, 100)) ||
    'Важное письмо';

  const body =
    (typeof config?.body === 'string' && config.body.trim()) ||
    (message?.subject && clip(message.subject, 200)) ||
    clip(classification?.summary, 200) ||
    clip(classification?.reason, 200) ||
    '';

  const payload = {
    title,
    body,
    messageId: message?.id ?? null,
    accountId: message?.account_id ?? null,
    important: classification?.important === true,
    tags: Array.isArray(classification?.tags) ? classification.tags : [],
    reason: classification?.reason ?? null,
    ts: Date.now(),
  };

  // Первичный источник правды — mailEvents. На фазе 6 hub подпишется на 'action:browser'.
  mailEvents.emit('action:browser', payload);
  log.info(
    { messageId: payload.messageId, title: payload.title },
    'browser action emitted (waiting for WS hub subscription)',
  );

  // Если в runtime-области уже появился hub (поздний bind, напр. из tests) —
  // вызовем его. Иначе warn только при очень verbose логгере (debug).
  const hub = globalThis.__mailHelperWsHub;
  if (hub && typeof hub.broadcast === 'function') {
    try {
      hub.broadcast('notify', payload);
    } catch (err) {
      log.error({ err: err?.message || String(err) }, 'ws hub broadcast failed');
    }
  } else {
    log.debug('ws hub not initialized yet — event left on mailEvents bus');
  }

  return { ok: true, emitted: true };
}

export default { browserAction };
