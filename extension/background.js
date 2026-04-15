// background.js — Mail Helper MV3 service worker.
//
// Ответственности:
//   1. Держит WebSocket-соединение с бэкендом:
//      URL = backend_url с заменой http→ws / https→wss, + /ws?token=<api_key>.
//      Reconnect с экспоненциальным backoff (2s → 60s max), сброс после
//      30с стабильного коннекта.
//   2. chrome.alarms keepalive (каждые 30 секунд) — не даёт SW уснуть и
//      принудительно проверяет/реанимирует WS.
//   3. Ретранслирует события WS (new_message / updated / notify) в sidebar
//      через chrome.runtime.sendMessage. При important=true или событии
//      notify — показывает chrome.notifications.create.
//   4. Слушает chrome.runtime.onMessage от sidebar/options:
//        { type: 'settings_changed' }  → reconnect WS
//        { type: 'reconnect_ws' }      → reconnect WS
//        { type: 'get_ws_status' }     → { ok, state }
//        { type: 'mark_read', id }     → WS send {type:'mark_read', id}
//        { type: 'focus_message', id } → focus Gmail tab и прокинуть id
//   5. chrome.storage.onChanged (local: backend_url | api_key) → reconnect.
//
// Примечания по MV3:
//   • SW останавливается через ~30с бездействия. chrome.alarms с
//     periodInMinutes: 0.5 — допустимый минимум в MV3 — пинает SW каждые 30с
//     и заодно служит тиком keepalive. Активный WebSocket также продлевает
//     жизнь SW, но только пока через него идёт трафик; пинг на стороне
//     сервера идёт каждые 30с (ws/hub.js HEARTBEAT_INTERVAL_MS), так что
//     связка alarm + ws-ping покрывает оба направления.
//   • Нельзя использовать setInterval — он не переживёт suspension.
//     Используем Date.now() + chrome.alarms для планирования reconnect.

'use strict';

// ── Constants ─────────────────────────────────────────────────────────

const ALARM_KEEPALIVE = 'mh-keepalive';
const ALARM_RECONNECT = 'mh-reconnect';
const RECONNECT_MIN_MS = 2_000;
const RECONNECT_MAX_MS = 60_000;
const STABLE_CONNECTION_MS = 30_000; // после этого сбрасываем backoff

// ── State (module scope — переживает сколько SW жив) ──────────────────

let ws = null;
/** 'idle' | 'connecting' | 'connected' | 'closed' */
let wsState = 'idle';
let reconnectAttempts = 0;
let connectedAt = 0;
let lastError = '';

// ── Utilities ─────────────────────────────────────────────────────────

function log(...args) {
  // SW console shows up in chrome://extensions service worker inspect.
  console.log('[mh-bg]', ...args);
}

function logWarn(...args) {
  console.warn('[mh-bg]', ...args);
}

async function readSettings() {
  const { backend_url, api_key, notify_important } = await chrome.storage.local.get([
    'backend_url',
    'api_key',
    'notify_important',
  ]);
  return {
    backendUrl: (backend_url || 'http://localhost:3000').replace(/\/+$/, ''),
    apiKey: api_key || '',
    notifyImportant: notify_important !== false, // default true
  };
}

function backendToWsUrl(backendUrl, apiKey) {
  // Convert http(s)://host:port[/...] → ws(s)://host:port/ws?token=<key>
  try {
    const u = new URL(backendUrl);
    const proto = u.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${u.host}/ws?token=${encodeURIComponent(apiKey)}`;
  } catch {
    // malformed URL — сформируем по best-effort правилу
    return `${backendUrl.replace(/^http/i, 'ws')}/ws?token=${encodeURIComponent(apiKey)}`;
  }
}

function broadcastToSidebars(type, data) {
  // chrome.runtime.sendMessage рассылает всем доступным получателям
  // (options, sidebar iframes, popup). Ошибка "Receiving end does not exist"
  // нормальна, если никто не слушает — игнорируем.
  try {
    chrome.runtime.sendMessage({ type, data }, () => {
      // consume lastError to prevent unchecked runtime.lastError warnings
      void chrome.runtime.lastError;
    });
  } catch (err) {
    // noop
  }
}

function setWsState(state) {
  if (wsState === state) return;
  wsState = state;
  broadcastToSidebars('ws_status', { state });
}

// ── WebSocket lifecycle ───────────────────────────────────────────────

async function openWs() {
  // Сначала гарантированно закрыли предыдущий сокет. closeWs помечает его
  // .__mhReplaced = true чтобы его отложенный close-handler не дёрнул
  // scheduleReconnect и не создал параллельную цепочку реконнектов.
  await closeWs('reconnecting');

  const { backendUrl, apiKey } = await readSettings();
  if (!backendUrl || !apiKey) {
    logWarn('cannot open ws: backend_url or api_key missing');
    setWsState('idle');
    return;
  }

  const url = backendToWsUrl(backendUrl, apiKey);
  log('opening ws →', url.replace(/token=[^&]+/, 'token=***'));
  setWsState('connecting');

  let socket;
  try {
    socket = new WebSocket(url);
  } catch (err) {
    logWarn('WebSocket ctor threw', err);
    lastError = err?.message || String(err);
    scheduleReconnect();
    return;
  }
  ws = socket;

  socket.addEventListener('open', () => {
    if (socket.__mhReplaced) return;
    log('ws open');
    connectedAt = Date.now();
    reconnectAttempts = 0; // connection established; backoff будет сброшен через STABLE_CONNECTION_MS окончательно
    setWsState('connected');
  });

  socket.addEventListener('message', (ev) => {
    if (socket.__mhReplaced) return;
    onWsMessage(ev.data);
  });

  socket.addEventListener('error', (ev) => {
    if (socket.__mhReplaced) return;
    // В WS error — обычно пустой Event, важнее последующий close.
    logWarn('ws error');
    lastError = 'socket error';
  });

  socket.addEventListener('close', (ev) => {
    // Если этот сокет был вытеснен явным реконнектом — игнорируем его close,
    // иначе получим параллельную цепочку scheduleReconnect.
    if (socket.__mhReplaced) {
      log('ws close (replaced socket)', ev.code);
      return;
    }
    log('ws close', ev.code, ev.reason);
    const wasConnected = wsState === 'connected';
    setWsState('closed');
    if (ws === socket) ws = null;
    // Если соединение прожило STABLE_CONNECTION_MS — сбрасываем backoff.
    if (wasConnected && connectedAt && Date.now() - connectedAt >= STABLE_CONNECTION_MS) {
      reconnectAttempts = 0;
    }
    scheduleReconnect();
  });
}

async function closeWs(reason = 'manual') {
  const s = ws;
  if (!s) return;
  // Пометить сокет как "вытеснен"; его close-handler не должен триггерить
  // повторный scheduleReconnect — новый openWs уже идёт следующей строкой.
  try {
    s.__mhReplaced = true;
  } catch {
    /* primitive Proxy safety */
  }
  ws = null;
  try {
    if (s.readyState === WebSocket.OPEN || s.readyState === WebSocket.CONNECTING) {
      s.close(1000, reason);
    }
  } catch (err) {
    logWarn('closeWs error', err);
  }
}

function computeBackoffMs() {
  const base = Math.min(
    RECONNECT_MAX_MS,
    RECONNECT_MIN_MS * Math.pow(2, reconnectAttempts),
  );
  // jitter ±25% чтобы n клиентов не переподключались одновременно.
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.max(RECONNECT_MIN_MS, Math.round(base + jitter));
}

function scheduleReconnect() {
  reconnectAttempts++;
  const delayMs = computeBackoffMs();
  log(`scheduling reconnect in ${delayMs}ms (attempt #${reconnectAttempts})`);
  // chrome.alarms принимает delayInMinutes. Минимум 30сек — но для первого
  // запуска после инсталла допускаются более короткие промежутки. Клэмпим к
  // допустимому минимуму (chrome требует >= 30с в production — для dev builds
  // может быть короче). Если delay < 30s — используем setTimeout (переживает
  // пока SW не уснёт; а alarm всё равно держит keepalive).
  if (delayMs < 30_000) {
    // Пока SW жив, setTimeout сработает; плюс keepalive-alarm гарантирует,
    // что SW не уснёт надолго.
    setTimeout(() => {
      openWs().catch((err) => logWarn('reconnect openWs error', err));
    }, delayMs);
  } else {
    chrome.alarms.create(ALARM_RECONNECT, { delayInMinutes: delayMs / 60_000 });
  }
}

// ── WS → sidebar/notifications bridge ─────────────────────────────────

function onWsMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(typeof raw === 'string' ? raw : raw.toString('utf8'));
  } catch (err) {
    logWarn('ws invalid json', err);
    return;
  }
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'new_message':
      broadcastToSidebars('new_message', msg.data);
      maybeNotifyOnNewMessage(msg.data);
      return;
    case 'updated':
      broadcastToSidebars('updated', msg.data);
      return;
    case 'notify':
      // actions/browser → hub.broadcast('notify',...) — всегда показываем.
      showNotification({
        messageId: msg.data?.messageId ?? null,
        title: msg.data?.title || 'Mail Helper',
        body: msg.data?.body || '',
      });
      return;
    case 'pong':
      return;
    case 'error':
      logWarn('ws server error', msg.data);
      return;
    default:
      log('ws unknown type', msg.type);
      return;
  }
}

async function maybeNotifyOnNewMessage(data) {
  if (!data) return;
  const { notifyImportant } = await readSettings();
  if (data.important === true && notifyImportant) {
    showNotification({
      messageId: data.id,
      title: `★ ${data.subject || 'Important mail'}`,
      body: `${data.from || ''}${data.snippet ? '\n' + data.snippet : ''}`.trim(),
    });
  }
}

function showNotification({ title, body, messageId }) {
  const notifId = messageId ? `mh-msg-${messageId}` : `mh-${Date.now()}`;
  try {
    chrome.notifications.create(
      notifId,
      {
        type: 'basic',
        iconUrl: chrome.runtime.getURL('icons/icon128.png'),
        title: String(title || 'Mail Helper').slice(0, 120),
        message: String(body || '').slice(0, 400),
        priority: 1,
      },
      () => {
        // Consume runtime.lastError if notifications permission not granted.
        void chrome.runtime.lastError;
      },
    );
    if (messageId) {
      notifIdToMessageId.set(notifId, messageId);
    }
  } catch (err) {
    logWarn('notifications.create threw', err);
  }
}

// ── Notification click → focus message ────────────────────────────────

const notifIdToMessageId = new Map();

chrome.notifications.onClicked.addListener(async (notifId) => {
  const id = notifIdToMessageId.get(notifId);
  try {
    chrome.notifications.clear(notifId);
  } catch {}
  if (!id) return;
  await focusMessageInMailTab(id);
});

async function focusMessageInMailTab(messageId) {
  // Попробуем найти активную Gmail или Yandex.Mail вкладку и сфокусировать.
  try {
    const tabs = await chrome.tabs.query({
      url: ['*://mail.google.com/*', '*://mail.yandex.ru/*'],
    });
    if (tabs.length > 0) {
      const tab = tabs.find((t) => t.active) || tabs[0];
      await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
      await chrome.tabs.update(tab.id, { active: true }).catch(() => {});
      // Прокинем id в sidebar iframe. sendMessage в tab дойдёт до content script
      // (iframe sees runtime.onMessage тоже). Не падаем, если получателя нет.
      try {
        await chrome.tabs.sendMessage(tab.id, { type: 'focus_message', id: messageId });
      } catch {}
      return;
    }
    // нет открытой вкладки — открываем Gmail.
    await chrome.tabs.create({ url: 'https://mail.google.com/' });
  } catch (err) {
    logWarn('focusMessageInMailTab failed', err);
  }
}

// ── runtime.onMessage (from options/sidebar) ──────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') {
    sendResponse?.({ ok: false, error: 'bad_message' });
    return false;
  }
  switch (msg.type) {
    case 'settings_changed':
    case 'reconnect_ws':
      reconnectAttempts = 0; // пользователь явно хочет немедленный реконнект
      openWs()
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true; // async

    case 'get_ws_status':
      sendResponse({ ok: true, state: wsState, lastError });
      return false;

    case 'mark_read': {
      const id = Number(msg.id);
      if (!Number.isFinite(id)) {
        sendResponse({ ok: false, error: 'invalid_id' });
        return false;
      }
      if (ws && ws.readyState === WebSocket.OPEN) {
        try {
          ws.send(JSON.stringify({ type: 'mark_read', id }));
          sendResponse({ ok: true });
        } catch (err) {
          sendResponse({ ok: false, error: err?.message || String(err) });
        }
      } else {
        sendResponse({ ok: false, error: 'ws_not_open' });
      }
      return false;
    }

    case 'focus_message': {
      const id = Number(msg.id);
      if (!Number.isFinite(id)) {
        sendResponse({ ok: false, error: 'invalid_id' });
        return false;
      }
      focusMessageInMailTab(id)
        .then(() => sendResponse({ ok: true }))
        .catch((err) => sendResponse({ ok: false, error: err?.message || String(err) }));
      return true;
    }

    default:
      // не наш тип, не трогаем
      return false;
  }
});

// ── storage.onChanged → reconnect on credentials change ───────────────

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local') return;
  if (changes.backend_url || changes.api_key) {
    log('storage credentials changed → reconnecting');
    reconnectAttempts = 0;
    openWs().catch((err) => logWarn('onChanged openWs error', err));
  }
});

// ── Alarms: keepalive + scheduled reconnect ───────────────────────────

// periodInMinutes: 0.5 — допустимо в MV3 (минимум 30с в stable).
chrome.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.5 });

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_KEEPALIVE) {
    onKeepaliveTick();
    return;
  }
  if (alarm.name === ALARM_RECONNECT) {
    log('reconnect alarm fired');
    openWs().catch((err) => logWarn('alarm openWs error', err));
    return;
  }
});

function onKeepaliveTick() {
  // Если WS не открыт — реконнект (с обнулением backoff, т.к. keepalive
  // редок). Также отправляем ping через WS если открыт — держит flow-хватку
  // к SW.
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    if (wsState !== 'connecting') {
      reconnectAttempts = 0;
      openWs().catch((err) => logWarn('keepalive openWs error', err));
    }
    return;
  }
  try {
    ws.send(JSON.stringify({ type: 'ping' }));
  } catch (err) {
    logWarn('keepalive ping failed', err);
  }
}

// ── Install / startup triggers ────────────────────────────────────────

chrome.runtime.onInstalled.addListener((info) => {
  log('onInstalled', info.reason);
  openWs().catch((err) => logWarn('onInstalled openWs error', err));
});

chrome.runtime.onStartup.addListener(() => {
  log('onStartup');
  openWs().catch((err) => logWarn('onStartup openWs error', err));
});

// Top-level: при загрузке SW (в т.ч. wake after sleep) — сразу пробуем коннект.
// Это дополняет onInstalled/onStartup которые не срабатывают на wake.
openWs().catch((err) => logWarn('boot openWs error', err));
