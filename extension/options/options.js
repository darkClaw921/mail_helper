// options/options.js — настройка Mail Helper extension.
//
// Задачи:
//   • load/save { backend_url, api_key, notify_important } в chrome.storage.local
//   • кнопка Test Connection: GET {backend_url}/api/health без авторизации, затем
//     GET {backend_url}/api/messages?limit=1 с X-API-Key для верификации ключа.
//   • кнопка Reconnect WS: шлёт сообщение background SW — он пересоздаст сокет.
//
// Ключи storage (согласованы с background.js и sidebar.js):
//   backend_url — string ("http://localhost:3000"), без завершающего /
//   api_key     — string
//   notify_important — boolean (default true)

/** Нормализует URL бэка: обрезает trailing slash, проверяет протокол. */
function normalizeBackendUrl(raw) {
  const s = String(raw || '').trim();
  if (!s) return '';
  // Попытаемся распарсить; если не парсится — вернём как есть и дадим упасть на fetch.
  try {
    const u = new URL(s);
    // убираем trailing слэш(и) из pathname
    const path = u.pathname.replace(/\/+$/, '');
    return `${u.protocol}//${u.host}${path}`;
  } catch {
    return s.replace(/\/+$/, '');
  }
}

/** Загружает настройки в форму. */
async function loadSettings() {
  const stored = await chrome.storage.local.get([
    'backend_url',
    'api_key',
    'notify_important',
    'notify_sound',
  ]);
  // Не подставляем дефолтный URL — пользователь должен явно указать сервер,
  // чтобы расширение не лезло в произвольный localhost без разрешения.
  const el = document.getElementById('backend-url');
  el.value = stored.backend_url || '';
  if (!el.placeholder) el.placeholder = 'http://localhost:3000';
  document.getElementById('api-key').value = stored.api_key || '';
  document.getElementById('notify-important').checked =
    stored.notify_important !== false; // default true
  const soundEl = document.getElementById('notify-sound');
  if (soundEl) soundEl.checked = stored.notify_sound === true; // default off
}

/** Показывает статус-баннер. */
function setStatus(kind, text) {
  const el = document.getElementById('status');
  el.className = `opt-status visible ${kind}`;
  el.textContent = text;
}

function clearStatus() {
  const el = document.getElementById('status');
  el.className = 'opt-status';
  el.textContent = '';
}

/** Сохраняет backend_url и api_key. */
async function onSaveClick() {
  clearStatus();
  const backendUrl = normalizeBackendUrl(document.getElementById('backend-url').value);
  const apiKey = document.getElementById('api-key').value.trim();

  if (!backendUrl) {
    setStatus('err', 'Backend URL is required');
    return;
  }
  if (!apiKey) {
    setStatus('err', 'API Key is required');
    return;
  }
  if (!/^https?:\/\//i.test(backendUrl)) {
    setStatus('err', 'Backend URL must start with http:// or https://');
    return;
  }

  await chrome.storage.local.set({ backend_url: backendUrl, api_key: apiKey });
  // background слушает storage.onChanged и пересоздаст WS при необходимости,
  // но шлём явный сигнал — на случай если onChanged запаздывает.
  try {
    await chrome.runtime.sendMessage({ type: 'settings_changed' });
  } catch {
    /* background может быть ещё не проснулся — это ок, он подхватит через storage */
  }
  setStatus('ok', 'Saved. Background WS will reconnect with new credentials.');
}

/** Сохраняет чекбокс notify_important отдельно. */
async function onSaveNotifyClick() {
  const checked = document.getElementById('notify-important').checked;
  const soundEl = document.getElementById('notify-sound');
  const sound = soundEl ? soundEl.checked : false;
  await chrome.storage.local.set({
    notify_important: checked,
    notify_sound: sound,
  });
  setStatus(
    'ok',
    `Уведомления: важные ${checked ? 'ON' : 'OFF'} · звук ${sound ? 'ON' : 'OFF'}`,
  );
}

/** Тестирует коннект: сперва /api/health (публичный), потом /api/messages. */
async function onTestClick() {
  clearStatus();
  const backendUrl = normalizeBackendUrl(document.getElementById('backend-url').value);
  const apiKey = document.getElementById('api-key').value.trim();
  if (!backendUrl) {
    setStatus('err', 'Enter Backend URL first');
    return;
  }

  setStatus('info', 'Testing /api/health ...');
  const btn = document.getElementById('test-btn');
  btn.disabled = true;

  try {
    const healthRes = await fetch(`${backendUrl}/api/health`, { method: 'GET' });
    if (!healthRes.ok) {
      setStatus('err', `/api/health failed: HTTP ${healthRes.status}`);
      return;
    }
    const health = await healthRes.json();
    const healthMsg = `/api/health OK · uptime=${health.uptime}s · v${health.version || '?'}`;

    if (!apiKey) {
      setStatus('info', `${healthMsg}\n(skipping /api/messages — no API Key)`);
      return;
    }

    setStatus('info', `${healthMsg}\nTesting /api/messages ...`);
    const msgRes = await fetch(`${backendUrl}/api/messages?limit=1`, {
      method: 'GET',
      headers: { 'X-API-Key': apiKey },
    });
    if (msgRes.status === 401 || msgRes.status === 403) {
      setStatus('err', `${healthMsg}\n/api/messages auth failed: HTTP ${msgRes.status} — check API Key`);
      return;
    }
    if (!msgRes.ok) {
      setStatus('err', `${healthMsg}\n/api/messages failed: HTTP ${msgRes.status}`);
      return;
    }
    const body = await msgRes.json();
    const total = typeof body.total === 'number' ? body.total : (body.messages?.length ?? 0);
    setStatus('ok', `${healthMsg}\n/api/messages OK · total=${total}`);
  } catch (err) {
    setStatus('err', `Fetch failed: ${err?.message || String(err)}`);
  } finally {
    btn.disabled = false;
  }
}

/** Пинает background чтобы пересоздать WS-соединение. */
async function onReconnectClick() {
  clearStatus();
  try {
    const res = await chrome.runtime.sendMessage({ type: 'reconnect_ws' });
    if (res && res.ok) {
      setStatus('ok', 'Background SW scheduled WS reconnect');
    } else {
      setStatus('info', 'Reconnect request sent (no response from SW)');
    }
  } catch (err) {
    setStatus('err', `Failed to reach background: ${err?.message || String(err)}`);
  }
}

document.addEventListener('DOMContentLoaded', () => {
  loadSettings().catch((err) => {
    setStatus('err', `Failed to load settings: ${err?.message || String(err)}`);
  });
  document.getElementById('save-btn').addEventListener('click', onSaveClick);
  document.getElementById('save-notify-btn').addEventListener('click', onSaveNotifyClick);
  document.getElementById('test-btn').addEventListener('click', onTestClick);
  document.getElementById('reconnect-btn').addEventListener('click', onReconnectClick);
});
