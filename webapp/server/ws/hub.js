// ws/hub.js — WebSocket-хаб для плагина и web-UI.
//
// Архитектура:
//   * Использует ws@8 в режиме noServer — подключается к существующему
//     http.Server из index.js через server.on('upgrade'), не плодит второй порт.
//   * Auth: query-параметр ?token=<api_key> сравнивается с api_key из
//     settings (см. api/auth.js -> ensureApiKey) через timingSafeEqual.
//     Невалидный токен / отсутствие токена → close 1008 (policy violation),
//     соединение закрывается до handleUpgrade.
//   * Path: только '/ws'. Любой другой upgrade-путь → 404 destroy.
//   * Keep-alive: каждые 30с шлём ping; клиент с isAlive=false (не ответил
//     pong с прошлого тика) — terminate. Это страховка от dead TCP.
//   * Late-bind: после init() публикуем globalThis.__mailHelperWsHub = hub
//     для actions/browser.js (он уже умеет найти хаб). Также подписываемся
//     на mailEvents 'message:classified' (broadcast new_message) и
//     'action:browser' (broadcast notify) — см. mh-pz9.2 и mh-pz9.4.
//   * Server→Client события: { type: 'new_message'|'updated'|'notify'|'pong', data }
//   * Client→Server события: { type: 'mark_read', id } | { type: 'ping' } — см. mh-pz9.3.
//
// Экспорт:
//   initWsHub(httpServer) — навешивает 'upgrade' на http-сервер, стартует
//                           heartbeat-интервал, подписывается на mailEvents.
//                           Возвращает объект hub с методами broadcast/sendTo/onMessage/close.

import { WebSocketServer } from 'ws';
import { timingSafeEqual } from 'node:crypto';

import { ensureApiKey } from '../api/auth.js';
import { logger } from '../logger.js';
import { mailEvents } from '../mail/events.js';
import { markFlags } from '../services/messages.js';

const log = logger.child({ module: 'ws:hub' });

const WS_PATH = '/ws';
const HEARTBEAT_INTERVAL_MS = 30_000;

// Уникальный id клиента для логов и sendTo; выдаётся при handleUpgrade.
let clientSeq = 0;

function safeEqualToken(provided, expected) {
  if (!provided || !expected) return false;
  const a = Buffer.from(String(provided), 'utf8');
  const b = Buffer.from(String(expected), 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

function parseTokenFromUrl(reqUrl) {
  // reqUrl приходит как '/ws?token=xxx'. URL требует базу.
  try {
    const u = new URL(reqUrl, 'http://localhost');
    if (u.pathname !== WS_PATH) return { path: u.pathname, token: null };
    return { path: u.pathname, token: u.searchParams.get('token') };
  } catch {
    return { path: null, token: null };
  }
}

function onSocketPreHandshakeError(err) {
  log.warn({ err: err?.message || String(err) }, 'socket error before handshake');
}

/**
 * @typedef {Object} WsHub
 * @property {(type: string, data?: any) => number} broadcast — шлёт всем активным клиентам, возвращает кол-во.
 * @property {(clientId: number, type: string, data?: any) => boolean} sendTo
 * @property {(handler: (client, msg) => void) => void} onMessage — регистрирует доп. обработчик входящих.
 * @property {() => Promise<void>} close — graceful shutdown.
 * @property {() => number} clientCount
 */

/**
 * Инициализирует WebSocket-хаб поверх существующего http.Server.
 * @param {import('node:http').Server} httpServer
 * @returns {WsHub}
 */
export function initWsHub(httpServer) {
  const wss = new WebSocketServer({ noServer: true, clientTracking: true });
  /** @type {Set<(client, msg) => void>} */
  const messageHandlers = new Set();

  // ── Upgrade-хендлер: auth + path-роутинг ───────────────────────────────
  function handleUpgrade(req, socket, head) {
    socket.on('error', onSocketPreHandshakeError);

    const { path, token } = parseTokenFromUrl(req.url);
    if (path !== WS_PATH) {
      socket.write('HTTP/1.1 404 Not Found\r\n\r\n');
      socket.destroy();
      return;
    }

    let expected;
    try {
      expected = ensureApiKey();
    } catch (err) {
      log.error({ err: err?.message || String(err) }, 'ensureApiKey failed during upgrade');
      socket.write('HTTP/1.1 500 Internal Server Error\r\n\r\n');
      socket.destroy();
      return;
    }

    if (!safeEqualToken(token, expected)) {
      // Соответствует требованию ACL: 1008 = policy violation. До handshake
      // отдать его HTTP-уровнем нельзя, поэтому шлём 401 на сокет; ws-клиент
      // увидит ошибку connect.
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      log.warn({ remote: socket.remoteAddress }, 'ws auth rejected');
      return;
    }

    socket.removeListener('error', onSocketPreHandshakeError);

    wss.handleUpgrade(req, socket, head, (ws) => {
      ws.id = ++clientSeq;
      ws.isAlive = true;
      wss.emit('connection', ws, req);
    });
  }

  httpServer.on('upgrade', handleUpgrade);

  // ── Heartbeat: ping/pong, terminate dead ───────────────────────────────
  const heartbeatInterval = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        log.warn({ clientId: ws.id }, 'terminating dead ws client');
        try {
          ws.terminate();
        } catch (err) {
          log.debug({ err: err?.message }, 'terminate failed');
        }
        continue;
      }
      ws.isAlive = false;
      try {
        ws.ping();
      } catch (err) {
        log.debug({ err: err?.message, clientId: ws.id }, 'ping failed');
      }
    }
  }, HEARTBEAT_INTERVAL_MS);
  // не блокируем event-loop при тестах
  heartbeatInterval.unref?.();

  // ── connection-хендлер ─────────────────────────────────────────────────
  wss.on('connection', (ws, req) => {
    log.info(
      { clientId: ws.id, remote: req.socket?.remoteAddress, total: wss.clients.size },
      'ws client connected',
    );

    ws.on('error', (err) => {
      log.warn({ err: err?.message || String(err), clientId: ws.id }, 'ws error');
    });

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('close', (code, reason) => {
      log.info(
        {
          clientId: ws.id,
          code,
          reason: reason?.toString?.() || '',
          remaining: wss.clients.size - 1,
        },
        'ws client disconnected',
      );
    });

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString('utf8'));
      } catch (err) {
        log.warn({ err: err?.message, clientId: ws.id }, 'invalid json from client');
        try {
          ws.send(JSON.stringify({ type: 'error', data: { error: 'invalid_json' } }));
        } catch {}
        return;
      }
      if (!msg || typeof msg.type !== 'string') {
        log.warn({ clientId: ws.id, msg }, 'malformed ws message (no type)');
        return;
      }
      // Базовые хендлеры: ping, mark_read.
      handleClientMessage(ws, msg, hub);
      // Дополнительные подписчики (для расширения).
      for (const fn of messageHandlers) {
        try {
          fn(ws, msg);
        } catch (err) {
          log.error({ err: err?.message }, 'ws message handler threw');
        }
      }
    });
  });

  // ── Mail-events bridge → broadcast ─────────────────────────────────────
  // Защита от дублей при тестовом ре-инит: сохраняем listener-функции
  // чтобы корректно отписаться в close().
  const onClassified = ({ message, classification }) => {
    if (!message?.id) return;
    hub.broadcast('new_message', {
      id: message.id,
      account_id: message.account_id,
      subject: message.subject ?? null,
      from: message.from_addr ?? null,
      snippet: message.snippet ?? null,
      important: classification?.important === true,
      classification: classification ?? null,
    });
  };
  const onActionBrowser = (payload) => {
    hub.broadcast('notify', {
      title: payload?.title ?? '',
      body: payload?.body ?? '',
      messageId: payload?.messageId ?? null,
    });
  };
  // Унифицированный источник 'updated'-событий: и REST PATCH (через
  // services/messages.markFlags), и reverse-sync из imapWorker (_handleFlags)
  // эмитят mailEvents.'message:updated'. Hub — единственное место broadcast.
  // См. Ф8: mh-dq9.3.
  const onMessageUpdated = (payload) => {
    if (!payload?.id) return;
    const data = { id: payload.id };
    if (payload.is_read !== undefined) data.is_read = payload.is_read;
    if (payload.is_important !== undefined) data.is_important = payload.is_important;
    hub.broadcast('updated', data);
  };
  mailEvents.on('message:classified', onClassified);
  mailEvents.on('action:browser', onActionBrowser);
  mailEvents.on('message:updated', onMessageUpdated);

  // ── hub object ─────────────────────────────────────────────────────────
  /** @type {WsHub} */
  const hub = {
    broadcast(type, data) {
      const payload = JSON.stringify({ type, data: data ?? null });
      let sent = 0;
      for (const ws of wss.clients) {
        if (ws.readyState === ws.OPEN) {
          try {
            ws.send(payload);
            sent++;
          } catch (err) {
            log.warn({ err: err?.message, clientId: ws.id }, 'send failed');
          }
        }
      }
      return sent;
    },
    sendTo(clientId, type, data) {
      for (const ws of wss.clients) {
        if (ws.id === clientId && ws.readyState === ws.OPEN) {
          try {
            ws.send(JSON.stringify({ type, data: data ?? null }));
            return true;
          } catch (err) {
            log.warn({ err: err?.message, clientId }, 'sendTo failed');
            return false;
          }
        }
      }
      return false;
    },
    onMessage(handler) {
      if (typeof handler === 'function') messageHandlers.add(handler);
    },
    clientCount() {
      return wss.clients.size;
    },
    async close() {
      clearInterval(heartbeatInterval);
      mailEvents.off('message:classified', onClassified);
      mailEvents.off('action:browser', onActionBrowser);
      mailEvents.off('message:updated', onMessageUpdated);
      httpServer.removeListener('upgrade', handleUpgrade);
      // Закрываем все активные соединения корректным close-frame'ом.
      for (const ws of wss.clients) {
        try {
          ws.close(1001, 'server shutting down');
        } catch {}
      }
      // Даём небольшое окно на flush, иначе terminate.
      await new Promise((resolve) => setTimeout(resolve, 200));
      for (const ws of wss.clients) {
        try {
          ws.terminate();
        } catch {}
      }
      await new Promise((resolve) => wss.close(() => resolve()));
      if (globalThis.__mailHelperWsHub === hub) {
        globalThis.__mailHelperWsHub = undefined;
      }
      log.info('ws hub closed');
    },
  };

  // late-bind для actions/browser.js (см. webapp/server/actions/browser.js).
  globalThis.__mailHelperWsHub = hub;

  log.info({ path: WS_PATH }, 'ws hub initialized');
  return hub;
}

// ── Client → Server message handling (mh-pz9.3) ─────────────────────────
// Вынесено в отдельную функцию, чтобы держать handler-блок compact.
function handleClientMessage(ws, msg, hub) {
  switch (msg.type) {
    case 'ping':
      try {
        ws.send(JSON.stringify({ type: 'pong', data: { ts: Date.now() } }));
      } catch (err) {
        log.warn({ err: err?.message, clientId: ws.id }, 'pong send failed');
      }
      return;

    case 'mark_read': {
      const id = Number.parseInt(msg.id ?? msg.data?.id, 10);
      if (!Number.isFinite(id)) {
        log.warn({ clientId: ws.id, msg }, 'mark_read without valid id');
        try {
          ws.send(
            JSON.stringify({
              type: 'error',
              data: { error: 'invalid_id', for: 'mark_read' },
            }),
          );
        } catch {}
        return;
      }
      // Делегируем в общий сервис — он делает UPDATE БД, fire-and-forget IMAP \Seen
      // и эмитит mailEvents 'message:updated' (на который подписан сам hub и шлёт
      // broadcast). Таким образом один путь broadcast и для REST PATCH, и для WS.
      // См. Ф8: mh-dq9.3.
      try {
        const result = markFlags(id, { is_read: 1 });
        if (!result.ok) {
          ws.send(
            JSON.stringify({
              type: 'error',
              data: { error: result.error, for: 'mark_read', id },
            }),
          );
          return;
        }
        // Дополнительно ничего не шлём — onMessageUpdated уже сделал broadcast.
      } catch (err) {
        log.error({ err: err?.message, clientId: ws.id, id }, 'mark_read failed');
        try {
          ws.send(
            JSON.stringify({
              type: 'error',
              data: { error: 'internal', for: 'mark_read', id },
            }),
          );
        } catch {}
      }
      return;
    }

    default:
      log.warn({ clientId: ws.id, type: msg.type }, 'unknown ws message type');
  }
}

export default { initWsHub };
