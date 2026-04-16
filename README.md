<div align="center">

# 📬 MailMind AI

**Локальный почтовый ассистент с LLM-классификацией, автоматизациями и Chrome-расширением**

![Actions & Automation](./Actions%20%26%20Automation.png)

</div>

<p align="center">
  <a href="https://nodejs.org/"><img src="https://img.shields.io/badge/NODE.JS-20%2B-339933?style=for-the-badge&logo=node.js&logoColor=white" alt="Node"></a>
  <a href="https://developer.chrome.com/docs/extensions/mv3/intro/"><img src="https://img.shields.io/badge/CHROME-MV3-4285F4?style=for-the-badge&logo=googlechrome&logoColor=white" alt="Chrome MV3"></a>
  <a href="https://openrouter.ai/"><img src="https://img.shields.io/badge/OPENROUTER-GROK--4--FAST-8A2BE2?style=for-the-badge&logo=openai&logoColor=white" alt="OpenRouter"></a>
  <a href="https://vitejs.dev/"><img src="https://img.shields.io/badge/VITE-TAILWIND_V4-646CFF?style=for-the-badge&logo=vite&logoColor=white" alt="Vite"></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/SQLITE-WAL-003B57?style=for-the-badge&logo=sqlite&logoColor=white" alt="SQLite"></a>
  <a href="#license"><img src="https://img.shields.io/badge/LICENSE-MIT-FACC15?style=for-the-badge" alt="License: MIT"></a>
</p>

---

## ✨ Что умеет

- 🧠 **LLM-классификация** каждого входящего письма через OpenRouter (`x-ai/grok-4-fast` по умолчанию).
- ⚡ **Actions & Automation** — правила «триггер → действие»: Telegram, webhook, SMTP-forward, браузерная нотификация.
- 🔁 **Двусторонний sync флага `\Seen`**: отметил в sidebar → IMAP; отметил в Gmail → sidebar обновляется из IDLE.
- 🧩 **Chrome MV3 расширение** инжектит sidebar в Gmail и Yandex.Mail.
- 🔐 **AES-256-GCM** для всех секретов в SQLite (IMAP/SMTP/Telegram/API-keys).
- 🪝 **WebSocket live-поток** событий в UI и расширение без поллинга.

---

## 🏗 Состав репозитория

| Каталог | Что внутри |
|---|---|
| [`webapp/server/`](webapp/server/) | Express + WS backend: IMAP воркеры, LLM classifier, actions runner, REST, WS hub |
| [`webapp/client/`](webapp/client/) | Vite + Tailwind v4 web UI (dashboard, prompts, actions, settings) |
| [`extension/`](extension/) | Chrome MV3 extension (SW + content-scripts + sidebar iframe) |
| [`architecture.md`](./architecture.md) | Полная карта проекта с описанием каждого файла |

---

## 📋 Требования

- **Node.js 20+** (встроенный `fetch`, WebSocket API, ESM).
- **Google Chrome** / Chromium для расширения (Manifest V3).
- IMAP-аккаунт с разрешённым IMAP и app password (для Gmail/Yandex).
- Ключ [OpenRouter](https://openrouter.ai/).
- Опционально: Telegram bot token + chat id, webhook URL, SMTP креды.

---

## 🚀 Быстрый старт

### 1. Установка backend

```bash
cd webapp
npm install
```

### 2. Сгенерировать `MASTER_KEY`

AES-256-GCM ключ (32 байта = 64 hex) для шифрования паролей в SQLite:

```bash
openssl rand -hex 32
# или без openssl:
node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
```

> ⚠️ Потеря `MASTER_KEY` = невозможность расшифровать пароли. Удалите `data.db`, заведите новый ключ, добавьте аккаунты заново.

### 3. Создать `.env`

```bash
cp .env.example .env
```

```dotenv
PORT=3000
MASTER_KEY=<64 hex chars>
DB_PATH=./data.db
LOG_LEVEL=info
```

### 4. Инициализировать БД

```bash
npm run init-db
```

Создаёт `webapp/data.db` по схеме `server/db/schema.sql`, сидит дефолтный промт, генерирует `api_key` (виден в логах).

### 5. Dev-режим

```bash
npm run dev
```

| Сервис | URL |
|---|---|
| Backend API + WS | `http://localhost:3000` |
| Web UI (Vite + proxy) | `http://localhost:5173` |

---

## ⚙️ Настройка через Web UI

1. При первом заходе UI запросит **X-API-Key** — возьмите из логов (`api_key generated`). Хранится в `sessionStorage`.
2. **Settings** → вставить **OpenRouter API key** (обязательно) и Telegram bot token (опционально).
3. **Accounts** → добавить IMAP-ящик, кнопка **Test** проверяет IMAP + SMTP.
4. **Prompts** → редактировать `system_prompt` + `output_params` (динамический JSON-контракт).
5. **Actions** → создать правило: `type` (telegram/webhook/forward/browser) + `match_expr` + `config`.

### Gmail

- Включить 2FA в Google Account.
- [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) → сгенерировать App Password.
- IMAP: `imap.gmail.com:993` (TLS). SMTP: `smtp.gmail.com:465` (TLS).

### Yandex

- [id.yandex.ru](https://id.yandex.ru/) → Пароли приложений → Почта.
- IMAP: `imap.yandex.ru:993` (TLS).

---

## 🧩 Chrome Extension

<div align="center">

![Email Plugin Overlay](./Email%20Plugin%20Overlay.png)

</div>

1. `chrome://extensions` → **Developer mode** → **Load unpacked** → выбрать `mail_helper/extension/`.
2. Options → заполнить **Backend URL** (`http://localhost:3000`) + **API key**.
3. Открыть Gmail или Yandex — справа появится sidebar. Service worker держит WS к `/ws?token=<api_key>`.

---

## ✅ End-to-end smoke test

| # | Проверка | Ожидаемо |
|---|---|---|
| 1 | `curl http://localhost:3000/api/health` | `{"ok":true,...}` |
| 2 | Web UI Settings | поля подгружаются |
| 3 | Accounts → Test | `{ok:true, mailboxes:[...]}` |
| 4 | IMAP IDLE | лог: `imap connected` + `initial lastSeenUid` |
| 5 | Прислать письмо | лог: `message stored`, строка в `messages` |
| 6 | LLM classification | лог: `message classified`, `classification_json` заполнен |
| 7 | Telegram action | сообщение прилетает в Telegram |
| 8 | Web UI Messages | письмо с тегом important |
| 9 | Extension sidebar | `new_message` в консоли, письмо в панели |
| 10 | Mark-as-read (sidebar → IMAP) | Gmail снимает жирный шрифт |
| 11 | Mark-as-read (Gmail → sidebar) | sidebar обновляется через `flags` event |
| 12 | Reconnect | backend и extension восстанавливают соединение |

---

## 🩺 Troubleshooting

<details>
<summary><code>MASTER_KEY is required (64 hex chars)</code></summary>
Ключ в <code>.env</code> пустой или неправильной длины. 64 hex = ровно 32 байта.
</details>

<details>
<summary>IMAP <code>AUTHENTICATIONFAILED</code></summary>
Неверный пароль / не выдан app password. Backend держит 60с между попытками — не долбит сервер.
</details>

<details>
<summary>IMAP рвётся каждые несколько минут</summary>
Короткий IDLE-таймаут у провайдера. Мы пере-IDLE раз в 25 мин. Проверьте, что TLS не закрывается по idle.
</details>

<details>
<summary><code>openrouter_api_key is not configured</code></summary>
Добавьте ключ в Settings web UI.
</details>

<details>
<summary>Extension sidebar пустой, WS status <code>closed</code></summary>
Неправильный <code>backend_url</code> / <code>api_key</code>. Смотрите консоль background SW (<code>chrome://extensions</code> → Service worker → inspect). На смену значений WS пересоздаётся автоматически.
</details>

<details>
<summary>MV3 service worker засыпает</summary>
<code>chrome.alarms</code> с <code>periodInMinutes: 0.5</code> держит его живым + триггерит reconnect при не-OPEN WS.
</details>

<details>
<summary><code>Receiving end does not exist</code> в консоли расширения</summary>
Нормально: sidebar iframe ещё не открыт, сообщение игнорируется.
</details>

<details>
<summary>Web UI <code>401 invalid_api_key</code></summary>
Очистите <code>sessionStorage</code> и залогиньтесь заново.
</details>

---

## 🛠 Полезные команды

```bash
# Генерация MASTER_KEY
openssl rand -hex 32

# Пересоздать БД
rm webapp/data.db && cd webapp && npm run init-db

# Только backend (без Vite)
cd webapp && npm run dev:server

# Только web UI
cd webapp && npm run dev:client

# Production
cd webapp && npm run build && npm run start
```

---

## 📚 Архитектура

Полная карта файлов с описанием каждого модуля — в [`architecture.md`](./architecture.md).

High-level:

```
IMAP IDLE ──▶ fetcher ──▶ messages (SQLite)
                              │
                              ├─▶ LLM classifier ──▶ classification_json
                              │           │
                              │           └─▶ actions/runner
                              │                  ├─▶ Telegram
                              │                  ├─▶ Webhook
                              │                  ├─▶ SMTP forward
                              │                  └─▶ Browser notify
                              │
                              └─▶ WS hub ──▶ Web UI + Chrome Extension sidebar
```

---

## 📄 License

MIT — см. [LICENSE](./LICENSE).
