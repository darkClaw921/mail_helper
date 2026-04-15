// API-клиент для бэкенда Mail Helper.
//
// apiFetch добавляет заголовок X-API-Key из sessionStorage.api_key, парсит
// JSON и выбрасывает ApiError при неуспешном ответе. При 401 очищает ключ в
// sessionStorage и показывает prompt(), чтобы пользователь ввёл новый ключ.
//
// ensureApiKey() вызывается из main.js при старте: если в URL есть
// ?api_key=... — сохраняет в sessionStorage и чистит URL; если ключа нет —
// просит ввести вручную через prompt().
//
// Дальше — CRUD-хелперы для 5 ресурсов (settings, accounts, prompts, actions,
// messages) на базе apiFetch.

const KEY_STORAGE = 'api_key';

export class ApiError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

function getApiKey() {
  return sessionStorage.getItem(KEY_STORAGE) || '';
}

function setApiKey(value) {
  if (value) sessionStorage.setItem(KEY_STORAGE, value);
  else sessionStorage.removeItem(KEY_STORAGE);
}

/**
 * Захватывает api_key из ?api_key=... (и чистит URL) либо просит ввести
 * через prompt(), если ключа ещё нет.
 */
export function ensureApiKey() {
  const url = new URL(window.location.href);
  const fromUrl = url.searchParams.get('api_key');
  if (fromUrl) {
    setApiKey(fromUrl);
    url.searchParams.delete('api_key');
    window.history.replaceState({}, '', url.toString());
  }
  if (!getApiKey()) {
    // eslint-disable-next-line no-alert
    const entered = window.prompt(
      'Введите API-ключ Mail Helper (смотрите в логах backend при первом запуске):',
    );
    if (entered) setApiKey(entered.trim());
  }
  return getApiKey();
}

export function clearApiKey() {
  setApiKey('');
}

/**
 * Базовая обёртка над fetch. Прозрачно сериализует body в JSON, парсит ответ,
 * выбрасывает ApiError для !ok. При 401 очищает ключ в sessionStorage.
 *
 * @param {string} path — абсолютный путь, например "/api/accounts"
 * @param {object} [opts] — fetch options (method, body — object | undefined)
 */
export async function apiFetch(path, opts = {}) {
  const { method = 'GET', body, headers = {}, ...rest } = opts;
  const init = {
    method,
    headers: {
      Accept: 'application/json',
      ...headers,
    },
    ...rest,
  };
  const key = getApiKey();
  if (key) init.headers['X-API-Key'] = key;
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = typeof body === 'string' ? body : JSON.stringify(body);
  }

  const resp = await fetch(path, init);
  const text = await resp.text();
  let data = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!resp.ok) {
    if (resp.status === 401) {
      clearApiKey();
      // eslint-disable-next-line no-alert
      window.alert('API-ключ не подошёл. Обновите страницу и введите корректный ключ.');
    }
    const msg =
      (data && typeof data === 'object' && (data.error || data.message)) ||
      `HTTP ${resp.status}`;
    throw new ApiError(msg, { status: resp.status, body: data });
  }
  return data;
}

// -------- CRUD-хелперы по ресурсам ---------------------------------------

function resource(basePath) {
  return {
    list: (query) => {
      const qs = query ? '?' + new URLSearchParams(query).toString() : '';
      return apiFetch(basePath + qs);
    },
    get: (id) => apiFetch(`${basePath}/${id}`),
    create: (payload) => apiFetch(basePath, { method: 'POST', body: payload }),
    update: (id, payload) => apiFetch(`${basePath}/${id}`, { method: 'PUT', body: payload }),
    patch: (id, payload) => apiFetch(`${basePath}/${id}`, { method: 'PATCH', body: payload }),
    remove: (id) => apiFetch(`${basePath}/${id}`, { method: 'DELETE' }),
  };
}

export const accountsApi = resource('/api/accounts');
export const promptsApi = resource('/api/prompts');
export const actionsApi = resource('/api/actions');
export const messagesApi = resource('/api/messages');

// settings — не-/:id ресурс, GET/PUT на корне.
export const settingsApi = {
  get: () => apiFetch('/api/settings'),
  update: (payload) => apiFetch('/api/settings', { method: 'PUT', body: payload }),
};
