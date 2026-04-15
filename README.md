# Mail Helper

Локальный ассистент-почты: слушает IMAP, пропускает каждое входящее письмо через LLM (OpenRouter), применяет настраиваемые actions (Telegram / webhook / пересылка SMTP / браузерная нотификация), и отдаёт "важные" письма в sidebar Chrome-расширения, которое инжектится в Gmail и Yandex.Mail.

Двунаправленная синхронизация флага "прочитано": отметил в sidebar — IMAP получает `\Seen`; отметил в Gmail — sidebar обновляется из IDLE flags event.

## Состав

- `webapp/server/` — Express + WebSocket backend: IMAP воркеры, LLM классификатор, actions runner, REST API, WS hub.
- `webapp/client/` — Vite + Tailwind web UI для настройки (ключи, аккаунты, промты, actions).
- `extension/` — Chrome MV3 расширение (service worker + content scripts + sidebar iframe).
- `architecture.md` — подробная карта проекта с описанием каждого файла.

## Требования

- **Node.js 20+** (используется встроенный fetch, WebSocket API, ESM).
- **Google Chrome** (или любой Chromium) для расширения (Manifest V3).
- IMAP-аккаунт с разрешённым IMAP и (для Gmail) app password.
- Ключ [OpenRouter](https://openrouter.ai/) — используется модель `x-ai/grok-4-fast`.
- Опционально: Telegram bot token + chat id (для telegram action), любой webhook URL, SMTP креды (для forward action).

## Установка и запуск backend

```bash
cd webapp
npm install
```

### 1. Сгенерировать MASTER_KEY

AES-256-GCM ключ для шифрования паролей IMAP/SMTP и секретов в SQLite (32 байта = 64 hex символа):

```bash
openssl rand -hex 32
```

Или, без openssl:

```bash
node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))'
```

### 2. Создать `.env`

```bash
cp .env.example .env
```

Открыть `webapp/.env` и заполнить `MASTER_KEY` значением из шага 1. Пример:

```dotenv
PORT=3000
MASTER_KEY=<64 hex chars>
DB_PATH=./data.db
LOG_LEVEL=info
```

> Если вы потеряете `MASTER_KEY`, расшифровать уже сохранённые в БД пароли не получится — удалите `data.db`, заведите новый ключ, и добавьте аккаунты заново.

### 3. Инициализировать БД

```bash
npm run init-db
```

Создаёт `webapp/data.db` по схеме `server/db/schema.sql`, сиидит один дефолтный промт и генерирует `api_key` (показывается в логах).

### 4. Запустить в dev-режиме

```bash
npm run dev
```

Поднимет:
- Express API + WebSocket на `http://localhost:3000` (backend)
- Vite dev-сервер web UI на `http://localhost:5173` с проксированием `/api` и `/ws` на `:3000`

Откройте `http://localhost:5173` в браузере.

### 5. Настроить через web UI

1. При первом заходе backend запросит X-API-Key — возьмите его из логов сервера (`api_key generated`) или из `GET /api/settings` через curl. В самом UI ключ запрашивается один раз и сохраняется в `sessionStorage`.
2. В разделе **Settings** вставьте свой **OpenRouter API key** и нажмите Save.
3. Опционально введите **Telegram bot token** (глобальный токен; отдельные actions используют разные `chat_id`).
4. Разделы web UI:
   - **Accounts** — добавить IMAP-ящики (host, port, tls, user, пароль/app password). Кнопка "Test" проверяет IMAP+SMTP.
   - **Prompts** — редактировать `system_prompt` и `output_schema` (JSON schema для classification). Один промт помечен `is_default`.
   - **Actions** — создать цепочку: тип (telegram/webhook/forward/browser), `match_expr` (`important === true`, `tags.includes("promo")` и т.п.), и конфиг (для telegram — chat_id; для webhook — url; для forward — SMTP + to; для browser — пусто).

Для **Gmail**:
- Включите двухфакторную аутентификацию в Google Account.
- Создайте App Password: [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords). Именно его (а не пароль от аккаунта) указывайте как IMAP пароль.
- IMAP: `imap.gmail.com:993`, TLS.
- SMTP (для forward action): `smtp.gmail.com:465`, TLS.

Для **Yandex**:
- [id.yandex.ru](https://id.yandex.ru/) → Пароли приложений → создать пароль для "Почты".
- IMAP: `imap.yandex.ru:993`, TLS.

## Установка Chrome extension

1. Откройте `chrome://extensions`.
2. Включите **Developer mode** (в правом верхнем углу).
3. Нажмите **Load unpacked** и выберите каталог `mail_helper/extension/`.
4. Откройте options страницу расширения (правый клик по иконке → Options или `chrome://extensions` → Details → Extension options).
5. Заполните:
   - **Backend URL**: `http://localhost:3000` (без завершающего `/`).
   - **API key**: тот же `api_key` который используете в web UI.
   - **Notify on important**: включено по умолчанию — показывает `chrome.notifications` на письмах с `important === true`.
6. Сохраните. Background service worker автоматически откроет WebSocket к `/ws?token=<api_key>` и начнёт получать события.

Откройте [mail.google.com](https://mail.google.com/) или [mail.yandex.ru](https://mail.yandex.ru/) — справа появится iframe с sidebar, показывающий последние важные письма. Клик по строке прокручивает Gmail к нужной переписке; кнопка "прочитать" отправляет `mark_read` → WS → backend → IMAP `\Seen`.

## Verification: end-to-end smoke test

После того как backend и extension запущены, пройдитесь по чеклисту:

1. **Backend живой.** `curl http://localhost:3000/api/health` → `{"ok":true,...}`.
2. **API key работает.** В web UI (`http://localhost:5173`) залогиньтесь API-ключом и откройте Settings — поля должны подгрузиться.
3. **Аккаунт подключается.** В разделе Accounts добавьте ящик, нажмите "Test". Должно вернуть `{ok:true, mailboxes:[...]}`.
4. **IMAP IDLE активен.** В логах сервера: `imap connected` и `initial lastSeenUid`. Воркер подписан на `exists`/`flags` события.
5. **Письмо приходит.** Отправьте себе тестовое письмо. В логах: `message stored`. В БД таблица `messages` содержит новую строку с `uid`.
6. **Классификация сработала.** В логах: `message classified ... important:true/false`. Поле `classification_json` в messages заполнено.
7. **Telegram action доставляет.** Создайте action с `type=telegram`, `match_expr='true'`, `config={chat_id: <ваш>}`. Пошлите тестовое письмо — должно прилететь в Telegram.
8. **Web UI показывает письмо.** В разделе Messages (или на главной) новое письмо видно в списке с тегом important.
9. **Extension получает.** Откройте Gmail. Sidebar справа должен показать то же письмо. В консоли background: `ws open`, приходят `new_message`.
10. **Mark-as-read синхронизирован.** В sidebar нажмите "прочитать" — в Gmail письмо должно перестать быть жирным; в логах backend `is_read synced ... source:api` и `imap flag updated`.
11. **Обратная синхронизация.** В Gmail UI отметьте другое письмо прочитанным — sidebar должен обновиться (событие `flags` → `updated`).
12. **Reconnect.** Прерывайте сеть / убейте процесс `npm run dev` на 30 секунд — при возврате и backend, и extension автоматически восстановят IMAP/WS.

## Troubleshooting

- **`MASTER_KEY is required (64 hex chars)`** — не заполнен / неправильной длины ключ в `.env`. 64 hex = ровно 32 байта.
- **IMAP `AUTHENTICATIONFAILED`** — неверный пароль или не выдан app password. Backend теперь не долбит сервер каждые 2с при такой ошибке — держит 60с между попытками.
- **IMAP отваливается каждые несколько минут** — у некоторых провайдеров короткий IDLE-таймаут; мы сами пере-IDLE раз в 25 минут. Если рвётся чаще — проверьте, что провайдер не закрывает TLS по idle (в логах `imap connection closed`).
- **LLM ничего не классифицирует, в логах `openrouter_api_key is not configured`** — добавьте ключ в Settings web UI.
- **Extension sidebar пустой, в options статус `closed`** — неправильный `backend_url` или `api_key`. Проверьте в консоли background SW (chrome://extensions → Service worker → inspect). При смене любого из этих значений WS пересоздаётся автоматически через `storage.onChanged`.
- **MV3 service worker засыпает** — chrome.alarms с `periodInMinutes: 0.5` держит его живым и триггерит reconnect если WS не в `OPEN`.
- **`Receiving end does not exist`** в консоли расширения — нормально, sidebar iframe ещё не открыт, сообщение игнорируется.
- **Web UI отдаёт `401 invalid_api_key`** — зашёл с неправильным ключом; очистите `sessionStorage` и залогиньтесь заново.

## Полезные команды

```bash
# Генерация MASTER_KEY
openssl rand -hex 32

# Инициализация БД (удалите data.db чтобы пересоздать с нуля)
cd webapp && npm run init-db

# Только backend (без Vite)
cd webapp && npm run dev:server

# Только web UI
cd webapp && npm run dev:client

# Production
cd webapp && npm run build && npm run start
```

## Архитектура

Полная карта файлов проекта с описанием каждого модуля — в [architecture.md](./architecture.md).

## License

Private project, все права defended — см. владельца репозитория.
