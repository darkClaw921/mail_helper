# Mail Helper — Architecture

Проект состоит из двух независимых частей: `webapp/` (Node.js backend + web UI на Vite) и `extension/` (Chrome расширение MV3). Backend слушает IMAP, пропускает каждое входящее письмо через LLM-классификатор (OpenRouter), выполняет привязанные к результату actions (Telegram / webhook / пересылка SMTP / браузерная нотификация) и отдаёт события в расширение через WebSocket.

## Корень репозитория

```
mail_helper/
├── README.md              # инструкция по установке, настройке, verification
├── architecture.md        # этот файл
├── webapp/                # backend + client
└── extension/             # Chrome MV3 extension
```

- [README.md](README.md) — onboarding: требования, генерация `MASTER_KEY`, `.env`, `npm run init-db` / `npm run dev`, загрузка extension unpacked, Gmail/Yandex app password, Verification checklist (12 шагов end-to-end smoke test), Troubleshooting.

## webapp/

Node.js ESM проект (`"type": "module"`, Node ≥ 20). Express-бэкенд для прослушки IMAP, классификации писем через LLM и раздачи REST/WS API плагину; Vite + Tailwind v4 клиент для админки.

- [webapp/package.json](webapp/package.json) — зависимости и скрипты. Скрипты: `dev` (concurrently: server через nodemon + vite), `dev:server`, `dev:client`, `start` (prod-сервер), `build` (vite build), `preview`, `init-db`. Runtime deps: `express`, `better-sqlite3`, `dotenv`, `pino`, `pino-http`, `zod`, `imapflow`, `mailparser`, `nodemailer`, `ws`. Dev deps: `vite`, `@tailwindcss/vite`, `tailwindcss`, `concurrently`, `nodemon`.
- [webapp/.env.example](webapp/.env.example) — шаблон переменных окружения: `PORT`, `MASTER_KEY` (64 hex = 32 байта, AES-256-GCM), `DB_PATH`, `LOG_LEVEL`.
- [webapp/.gitignore](webapp/.gitignore) — игнорит `node_modules`, `.env`, `data.db*`, `dist/`.
- [webapp/vite.config.js](webapp/vite.config.js) — Vite конфиг: `root: client`, плагин `@tailwindcss/vite`, dev-сервер на `:5173` с прокси `/api` → `http://localhost:3000` и `/ws` (websocket).

### webapp/server/ — backend

- [webapp/server/index.js](webapp/server/index.js) — точка входа. Поднимает Express, цепляет `pino-http`, регистрирует `/api/health`, подключает `apiKeyMiddleware` на префиксе `/api`, монтирует роутеры `settings/accounts/prompts/actions/messages`, 404-хендлер для неизвестных `/api/*`, централизованный error handler (логирует полный err через `pino.stdSerializers.err`, клиенту отдаёт `{error, message}` без stack; для 5xx обобщает message до `'internal error'`). При старте вызывает `registerClassifierPipeline()` (подписка LLM-пайплайна на `mailEvents.'message:stored'`) и `registerActionsRunner()` (подписка actions-runner на `mailEvents.'message:classified'`) до старта IMAP, чтобы ни одно письмо не прошло мимо классификации и actions. Создаёт http.Server явно (`http.createServer(app)`) и до `server.listen()` зовёт `initWsHub(server)` — WebSocket-хаб навешивает свой `'upgrade'`-хендлер на тот же порт. После listen вызывает `accountManager.start()` — поднимает IMAP-воркеры для всех enabled аккаунтов. Graceful shutdown по `SIGINT/SIGTERM` параллельно гасит воркеры через `accountManager.stopAll()`, WS-хаб через `wsHub.close()` и закрывает HTTP-сервер + БД. Process-level хендлеры `unhandledRejection`/`uncaughtException` логируются (fatal-уровень) и инициируют shutdown. Экспортирует `app, server, wsHub`.
- [webapp/server/config.js](webapp/server/config.js) — грузит `.env` через `dotenv/config`, валидирует переменные через `zod`. Экспортирует заморожённый `config`. При невалидном окружении выводит сообщение и `process.exit(1)`.
- [webapp/server/logger.js](webapp/server/logger.js) — общий `pino`-логгер с уровнем из `config.LOG_LEVEL`, ISO-временем и стандартными сериализаторами `err`/`req`/`res` (`pino.stdSerializers.*`), чтобы в логах развёрнуто присутствовал полный stack ошибок и метаданные HTTP-запроса.

### webapp/server/db/ — хранилище

- [webapp/server/db/schema.sql](webapp/server/db/schema.sql) — таблицы `accounts`, `prompts`, `actions`, `messages`, `settings` + индексы. Все секреты хранятся в `*_enc` полях / `value_enc`. В `accounts` поля `initial_sync_count` (null/0=не синкать, -1=все, N>0=последние N) + `initial_synced` (0/1) управляют первичной синхронизацией истории писем при первом подключении.
- [webapp/server/db/index.js](webapp/server/db/index.js) — обёртка над `better-sqlite3`. Открывает БД по `config.DB_PATH`, включает WAL + foreign keys, идемпотентно применяет `schema.sql`, затем сидит дефолтный промт-классификатор (если таблица `prompts` пуста). Экспортирует `db`, `applySchema(db)`, `seedDefaultPrompt(db)`, `closeDb()`. `seedDefaultPrompt` вставляет один `prompts`-ряд `Default Importance Classifier` (`is_default=1`, `enabled=1`) с системным промтом для JSON-классификатора важности (поля `important`, `reason`, `tags`, `summary`) — идемпотентно.
- [webapp/server/db/init.js](webapp/server/db/init.js) — самостоятельный скрипт для `npm run init-db`.
- [webapp/server/db/crypto.js](webapp/server/db/crypto.js) — AES-256-GCM шифрование. `encrypt(plaintext)` → `base64(iv):base64(tag):base64(ciphertext)`. `decrypt(packed)` — обратная операция. `getKey()` читает и валидирует `MASTER_KEY`.

### webapp/server/api/ — REST-роуты

- [webapp/server/api/auth.js](webapp/server/api/auth.js) — middleware `X-API-Key`. `ensureApiKey()` возвращает текущий ключ из `settings.api_key`; при отсутствии — генерирует `randomUUID()`, шифрует, сохраняет и логирует. `apiKeyMiddleware` пропускает `/api/health`, в остальных случаях сравнивает `X-API-Key` (или `?api_key=`) через `timingSafeEqual`.
- [webapp/server/api/settings.js](webapp/server/api/settings.js) — `GET /api/settings` (возвращает `***` для заданных значений + флаги `has_*`) и `PUT /api/settings` (принимает `openrouter_api_key`/`telegram_bot_token`/`api_key`, шифрует и апсертит). Валидация zod.
- [webapp/server/api/accounts.js](webapp/server/api/accounts.js) — CRUD `/api/accounts` + `POST /:id/test`. Пароли `imap_pass`/`smtp_pass` принимаются plain-text в POST/PUT, шифруются в `imap_pass_enc`/`smtp_pass_enc`. В GET пароли никогда не возвращаются — вместо них булевы `has_imap_pass`/`has_smtp_pass`. В PUT пустой пароль значит «не менять». DELETE каскадно удаляет связанные `messages`. После каждого POST/PUT/DELETE зовётся `accountManager.reloadAccount(id)` — IMAP-воркер стартует/перезапускается/останавливается без рестарта сервера. `POST /:id/test` параллельно проверяет IMAP (`ImapWorker.testConnection`) и SMTP (`smtp.testSmtp`), таймаут 15с каждый, возвращает `{ imap: {ok, error?}, smtp: {ok, error?} }`.
- [webapp/server/api/prompts.js](webapp/server/api/prompts.js) — CRUD `/api/prompts` + `POST /:id/test`. Инвариант: ровно один `is_default=1` — установка флага через POST/PUT транзакционно снимает его у остальных. `POST /:id/test` принимает опциональный body `{ message_id? }` или `{ message?: { subject, from_addr, to_addr, body_text } }`; без body берёт последнее письмо из `messages` по `date DESC`. Вызывает `openrouter.classify` с `system_prompt` промта и возвращает `{ ok, result, tokens_used, usage, duration_ms, message_id }`; **не** пишет в БД. 400 если нет писем / ключ OpenRouter не настроен, 502 при ошибке LLM.
- [webapp/server/api/actions.js](webapp/server/api/actions.js) — CRUD `/api/actions`. Поле `config` приходит/отдаётся как JSON-объект; на диске `JSON.stringify` + `encrypt` → `config_enc`. `type` — enum `telegram|webhook|forward|browser`. `match_expr` хранится plain-text.
- [webapp/server/api/messages.js](webapp/server/api/messages.js) — `GET /api/messages` (список с фильтрами `account_id`/`unread`/`important` + пагинация, без `body_html`), `GET /api/messages/:id` (полная запись с `body_text`/`body_html`), `PATCH /api/messages/:id` (флаги `is_read`/`is_important`). PATCH делегирует в `services/messages.markFlags(id, { is_read?, is_important? })` — общий путь и для WS `mark_read`. Сервис обновляет БД, fire-and-forget синкит IMAP `\Seen` через `accountManager.getWorker(account_id).setFlag(uid, '\\Seen', add)` и эмитит `mailEvents.'message:updated'`; WS broadcast делает уже `ws/hub.js` подпиской на это событие (не сам роут). `classification_json` парсится в объект `classification`.

### webapp/client/ — фронтенд (Vite + Tailwind v4 + ванильный JS)

- [webapp/client/index.html](webapp/client/index.html) — корневой HTML со статической навигацией и `<main id="app">` для рендера текущей view.
- [webapp/client/src/style.css](webapp/client/src/style.css) — `@import "tailwindcss";` (Tailwind v4 как Vite-плагин).
- [webapp/client/src/main.js](webapp/client/src/main.js) — бутстрап SPA. Инициализирует hash-роутер, диспатчит на `renderMessages/renderAccounts/renderPrompts/renderActions/renderSettings`. Дефолтный маршрут — `#/inbox`.
- [webapp/client/src/api.js](webapp/client/src/api.js) — API-клиент. `apiFetch(path, opts)` добавляет `X-API-Key` из `sessionStorage.api_key`, сериализует JSON, выбрасывает `ApiError` с `status`/`body`. `ensureApiKey()` захватывает `?api_key=...` из URL или запрашивает через `prompt()`. `clearApiKey()` сбрасывает ключ (напр. при 401). Ресурсные хелперы: `settingsApi`, `accountsApi`, `promptsApi`, `actionsApi`, `messagesApi`.
- [webapp/client/src/views/util.js](webapp/client/src/views/util.js) — утилиты для view-модулей: `escapeHtml`, фабрика `h()` для DOM, хелперы `field/input/textarea/select/checkbox/button`, `formToObject`, `showError`.
- [webapp/client/src/views/accounts.js](webapp/client/src/views/accounts.js) — view `#/accounts`: таблица аккаунтов + форма создания/редактирования (IMAP/SMTP хосты, порты, креды, TLS, folder, enabled). Пресеты Gmail / Yandex / Beget автозаполняют IMAP+SMTP хосты/порты и подсказку про App Password. Блок «Синхронизировать старые письма»: чекбокс + селект (все / 10 / 50 / 100 / 500 / custom) → отправляется как `initial_sync_count`. Пустые пароли при Edit не отправляются. Email blur копируется в imap_user/smtp_user если те пусты.
- [webapp/client/src/views/prompts.js](webapp/client/src/views/prompts.js) — view `#/prompts`: список + форма с `name`, `system_prompt` (textarea), `output_schema`, `is_default`, `enabled`.
- [webapp/client/src/views/actions.js](webapp/client/src/views/actions.js) — view `#/actions`: список + форма с `name`, `prompt_id`, `type` (select из 4 типов), `match_expr`, `config` (JSON-textarea), `enabled`.
- [webapp/client/src/views/settings.js](webapp/client/src/views/settings.js) — view `#/settings`: форма с тремя password-инпутами (OpenRouter key, Telegram bot token, Mail Helper API key). Отправляются только непустые поля.
- [webapp/client/src/views/messages.js](webapp/client/src/views/messages.js) — view `#/inbox`: лента писем всех ящиков с LLM-классификацией. Фильтры (все / непрочитанные / важные) + селект по ящику. Карточки сортируются: важные → непрочитанные → по дате. Раскрываемые карточки подгружают тело через `messagesApi.get(id)` (text → `<pre>`, html → sandbox-iframe) + показывают полный JSON classification. Mark read/unread через `PATCH /api/messages/:id`. Live-обновления через WebSocket `/ws?token=<api_key>`: событие `new_message` триггерит reload, `updated` — обновляет флаги в локальном state.

### webapp/server/mail/ — IMAP/SMTP ядро (Phase 3)

- [webapp/server/mail/events.js](webapp/server/mail/events.js) — глобальная шина `mailEvents` (`EventEmitter`) для пайплайна писем. События: `message:new` ({ account_id, uid }), `message:stored` ({ message }), `message:classified` ({ message, classification, prompt }), `action:browser` ({ title, body, messageId, accountId, important, tags, reason, ts }), `message:updated` ({ id, account_id?, is_read?, is_important?, source? }) — единый источник WS `updated`-broadcast'ов: эмитится из `services/messages.markFlags` (PATCH и WS mark_read) и из `imapWorker._handleFlags` при IMAP reverse-sync (`source:'imap'`). `message:stored` слушает Ф4 pipeline (classifier). `message:classified` слушает Ф5 actions/runner и Ф6 WS hub. `action:browser` эмитится Ф5 actions/browser.js, подписчик — Ф6 WS hub. `message:updated` слушает Ф8 WS hub (один путь broadcast). `maxListeners = 50`.
- [webapp/server/mail/accountManager.js](webapp/server/mail/accountManager.js) — управление жизненным циклом `ImapWorker`'ов. Хранит `Map<account_id, ImapWorker>`. Экспорты: `start()` (поднимает воркеры для всех `enabled=1` аккаунтов, вызывается из `index.js` при старте сервера), `reloadAccount(id)` (идемпотентный ре-синк: стартует/рестартит/гасит воркер согласно текущему состоянию в БД — вызывается из `api/accounts.js` после POST/PUT/DELETE), `stopAll()` (graceful shutdown), `getWorker(id)` (доступ к воркеру для будущих фаз — mark-seen и т. д.).
- [webapp/server/mail/imapWorker.js](webapp/server/mail/imapWorker.js) — класс `ImapWorker` — одно IMAP-соединение через `imapflow` на аккаунт. В `start()` расшифровывает `imap_pass_enc`, подключается, открывает `account.folder` (default `INBOX`), выставляет `lastSeenUid` (SELECT MAX(uid) FROM messages; при первом запуске подставляет `mailbox.uidNext - 1` чтобы не тянуть историю). Слушает событие `exists` — зовёт `_handleExists()`: IMAP search по UID-range `lastSeenUid+1:*` и для каждого нового UID вызывает `fetchAndStore` + эмитит `message:new` / `message:stored` в `mailEvents`. Слушает событие `flags` (Ф8 reverse-sync) — `_handleFlags(data)` сверяет `data.flags.has('\\Seen')` с `messages.is_read` по `(account_id, data.uid)`; при расхождении обновляет `is_read` и эмитит `mailEvents.'message:updated'` с `source:'imap'`. Держит IDLE-цикл с re-IDLE каждые 25 минут (через `client.close()` и реконнект). Авто-реконнект — экспоненциальная задержка (base 2с, max 60с) с ±25% jitter; счётчик `consecutiveFailures` сбрасывается при успешном подключении; функция `isFatalAuthError(err)` детектит `AUTHENTICATIONFAILED`/`invalid credentials` и сразу прижимает delay к потолку, чтобы неверный пароль не дёргал IMAP каждые 2с; после `MAX_CONSECUTIVE_FAILURES=5` неудач подряд логируется ERROR-сообщение и delay остаётся на максимуме. `stop()` корректно освобождает lock и logout; `_teardown()` снимает все `exists/flags/error/close` listeners перед logout. Метод `setFlag(uid, flag, add)` (Ф8 forward-sync) — через уже открытый mailbox-lock вызывает `client.messageFlagsAdd/Remove(String(uid), [flag], { uid: true })`; если `client.usable === false` (воркер не поднят / ещё не в IDLE) — возвращает `{ ok:false, error:'not_ready' }` и пишет warn-лог, REST-ответ этим не валится. Статический метод `ImapWorker.testConnection(account)` используется в `POST /api/accounts/:id/test`: connect + mailboxOpen + list + logout с таймаутом 15с, возвращает `{ ok, mailboxes? }` или `{ ok: false, error }`.
- [webapp/server/mail/fetcher.js](webapp/server/mail/fetcher.js) — `fetchAndStore(client, accountId, uid)`. Работает поверх уже открытого `ImapFlow`-клиента (с активным mailbox-lock). Через `client.fetchOne(uid, { source, envelope, flags, internalDate }, { uid: true })` забирает письмо, парсит source через `mailparser.simpleParser`, собирает поля (`subject`, `from_addr`/`to_addr` — text из addressList, `date` — ms, `snippet` — 200 символов из text или stripped html, `body_text`, `body_html`, `is_read` — по флагу `\Seen`). Делает `INSERT OR IGNORE` в `messages` по UNIQUE (account_id, uid). Возвращает API-объект (с распарсенной `classification`), либо `null` если был дубль/пустой source.
- [webapp/server/mail/smtp.js](webapp/server/mail/smtp.js) — обёртка над `nodemailer`. Экспорты: `sendMail(accountId, { to, subject, text, html, cc, bcc, replyTo, attachments, from? })` — берёт `smtp_host/port/user/pass_enc` из accounts, создаёт transport на вызов (без кэша), отправляет, закрывает. `forwardMessage(accountId, messageId, to, opts?)` — берёт тело из таблицы `messages`, собирает Fwd-обёртку (заголовок "From/Date/To/Subject" + оригинальное тело) и отправляет через `sendMail`. Используется в Ф5 `actions/forward.js`. `testSmtp(account)` — `transporter.verify()` с таймаутом 15с для endpoint `/api/accounts/:id/test`, возвращает `{ ok, error? }`.

### webapp/server/llm/ — LLM классификация (Phase 4)

- [webapp/server/llm/openrouter.js](webapp/server/llm/openrouter.js) — клиент OpenRouter Chat Completions. `classify({ systemPrompt, userPrompt, model?, timeoutMs?, retry? })` шлёт POST на `https://openrouter.ai/api/v1/chat/completions` с моделью `x-ai/grok-4-fast` (по умолчанию), заголовками `Authorization: Bearer <key>`, `HTTP-Referer: http://localhost`, `X-Title: mail-helper`, body с `response_format: {type:'json_object'}`. Парсит `choices[0].message.content` как JSON, возвращает `{ result, usage, durationMs, raw }`. Таймаут 30с через `AbortController`; ретрай 1 раз при 5xx и сетевых ошибках (AbortError — без ретрая). Логирует `usage.total_tokens` через pino. `getOpenRouterKey()` читает `settings.openrouter_api_key` и расшифровывает через `crypto.decrypt` (возвращает `null` если не задан / пустой). Если ключа нет — `classify` бросает `Error('openrouter_key_missing')` c `code='openrouter_key_missing'`.
- [webapp/server/llm/classifier.js](webapp/server/llm/classifier.js) — применение LLM-промта к одному письму. `pickPromptForMessage()` возвращает активный промт (приоритет: enabled+default → enabled → default). `buildUserPrompt(message)` формирует user-content из полей `subject`/`from_addr`/`to_addr`/`body_text` (тело обрезается до 4000 символов + маркер truncated). `classifyMessage(messageRow, { prompt?, persist=true, force=false })` вызывает `openrouter.classify`, парсит JSON и обновляет `messages` (`classification_json`, `is_important`, `prompt_id`). Идемпотентно: если `classification_json` уже заполнен и явно не передан `prompt` — возвращает кэш без похода в LLM. Ошибки LLM (кроме `openrouter_key_missing`, который пробрасывается) записываются в `classification_json` как `{error:true, message, code, status}` и возвращают `{ok:false, error}`. `getMessageById(id)` возвращает свежую запись. `isLlmConfigured()` — быстрая проверка наличия ключа.
- [webapp/server/llm/pipeline.js](webapp/server/llm/pipeline.js) — интеграция classifier в почтовый пайплайн. `registerClassifierPipeline()` (идемпотентный, вызывается один раз из `index.js`) подписывается на `mailEvents.'message:stored'` и на каждое событие асинхронно запускает `classifyMessage(message)`. Если `openrouter_api_key` не задан — skip с warn (pipeline не падает). После успешной классификации перечитывает свежую запись из БД и эмитит `mailEvents.emit('message:classified', { message, classification, prompt })`. Ошибки классификации логируются, но не прерывают pipeline.

### webapp/server/actions/ — Actions по результату классификации (Phase 5)

Диспетчер: подписывается на `mailEvents.'message:classified'`, для каждого события выбирает enabled actions (с фильтром по `prompt_id`), оценивает `match_expr` через безопасный whitelist-evaluator и дёргает соответствующий плагин по `type`. Один упавший action не блокирует остальные (Promise.allSettled). Каждый плагин сам ловит свои ошибки и возвращает `{ok, error?}` — никогда не кидает.

- [webapp/server/actions/evaluator.js](webapp/server/actions/evaluator.js) — безопасный интерпретатор выражений `match_expr`. Рукописный рекурсивно-спускающийся парсер (`tokenize → parse → evalNode`). Без `eval` / `new Function` / `vm`. Whitelist идентификаторов: `important, reason, tags, summary` (константа `ALLOWED_IDENTIFIERS`). Единственный разрешённый метод — `<ident>.includes(<arg>)` (для `tags.includes('bill')` и строк). Поддерживает литералы (`string`/`number`/`true`/`false`/`null`), операторы `==` `!=` `&&` `||` `!`, скобки. Любой другой идентификатор/метод/символ → синтаксическая ошибка. Экспорты: `evaluate(expr, ctx)`, `compile(expr) -> (ctx) -> boolean`, `ALLOWED_IDENTIFIERS`.
- [webapp/server/actions/runner.js](webapp/server/actions/runner.js) — диспетчер. `runActionsForMessage(message, classification, prompt?)` — SELECT enabled actions из `actions` WHERE `enabled=1 AND (prompt_id IS NULL OR prompt_id = @prompt_id)`, для каждой: расшифровывает `config_enc` в JSON через `db/crypto.decrypt`, компилирует `match_expr` через `evaluator.compile`, если truthy — вызывает `dispatchAction(action, message, classification)`. Диспатч по `type`: `telegram|webhook|forward|browser` → соответствующий модуль. Параллельно (`Promise.allSettled`), каждая ошибка изолирована. Возвращает массив `{ action_id, type, matched, ok?, error? }` + пишет сводный pino-лог (`total/matched/ok/failed`). `registerActionsRunner()` — идемпотентная подписка на `mailEvents.'message:classified'`, вызывается один раз из `server/index.js`.
- [webapp/server/actions/telegram.js](webapp/server/actions/telegram.js) — `sendTelegram(config, message, classification)`. Читает `telegram_bot_token` из `settings` через `crypto.decrypt`, POST `https://api.telegram.org/bot<token>/sendMessage` с `{chat_id, text, parse_mode:'HTML', disable_web_page_preview:true}`. Таймаут 15с через `AbortController`, retry 1 раз на 5xx / network / timeout. Текст формируется в `formatTelegramText()` — HTML-escape + clip до разумных длин, структура: заголовок (⚠ Важное / Новое письмо), reason, From, Subject, теги (`#tag`), snippet, summary. `config` — `{ chat_id }`.
- [webapp/server/actions/webhook.js](webapp/server/actions/webhook.js) — `sendWebhook(config, message, classification)`. POST JSON на `config.url` (валидируется как `http(s)://`). Заголовки: `content-type: application/json`, `accept: application/json` + опциональные `config.headers` (не могут перетереть `content-type`). Body: `{ message: { id, account_id, uid, message_id, subject, from_addr, to_addr, date, snippet, is_important }, classification }`. Таймаут 15с, retry 1 раз на 5xx/network. Статус `<400` = success.
- [webapp/server/actions/forward.js](webapp/server/actions/forward.js) — `forwardAction(config, message)`. Делегирует в `mail/smtp.forwardMessage(fromAccountId, messageId, to)`. `from_account_id` — `config.from_account_id` или `message.account_id`. Возвращает `{ok, messageId?|error}`; не кидает.
- [webapp/server/actions/browser.js](webapp/server/actions/browser.js) — `browserAction(config, message, classification)`. Публикует событие `action:browser` в `mailEvents` с payload `{title, body, messageId, accountId, important, tags, reason, ts}`. Дефолты для `title`: `config.title` → `message.from_addr` → `'Важное письмо'`. Дефолты для `body`: `config.body` → `message.subject` → `classification.summary` → `classification.reason` → `''`. Также вызывает `globalThis.__mailHelperWsHub.broadcast('notify', payload)` если hub уже привязан (late-bind для Phase 6; если hub не готов — no-op с debug-логом, событие остаётся на шине для подписчика hub).

### webapp/server/services/ — Общая бизнес-логика (Phase 8)

- [webapp/server/services/messages.js](webapp/server/services/messages.js) — `markFlags(id, { is_read?, is_important? })`. Общий сервис, используемый и REST PATCH (`api/messages.js`), и WS `mark_read` (`ws/hub.js`). Делает UPDATE `messages` (только фактически изменившиеся поля), fire-and-forget синк флага `\Seen` в IMAP через `accountManager.getWorker(account_id).setFlag(uid, '\\Seen', add)` (если воркер не активен — warn-лог, БД уже обновлена), эмитит `mailEvents.'message:updated'` с `{id, account_id, is_read?, is_important?, source:'local'}`. Возвращает `{ ok:true, message, changed }` или `{ ok:false, error:'not_found'|'invalid_id' }`. Ошибки IMAP не делают `ok:false` — они логируются и не роняют REST-ответ.

### webapp/server/ws/ — WebSocket-хаб (Phase 6)

- [webapp/server/ws/hub.js](webapp/server/ws/hub.js) — WebSocket-хаб для плагина и web-UI. Использует `ws@8` в режиме `noServer` и подключается к существующему `http.Server` из `index.js` через `server.on('upgrade')` (без второго порта). Path: `/ws`. Auth: query-параметр `?token=<api_key>` сравнивается с результатом `api/auth.ensureApiKey()` через `timingSafeEqual` (несовпадение → `401 Unauthorized` на сокет, `socket.destroy()`). После upgrade каждому клиенту присваивается монотонный `ws.id`. Heartbeat: каждые 30 с шлёт `ws.ping()`; клиент с `isAlive=false` (не ответил pong с прошлого тика) — `ws.terminate()`. Подписывается на `mailEvents.'message:classified'` → `broadcast('new_message', {id, account_id, subject, from, snippet, important, classification})`, на `mailEvents.'action:browser'` → `broadcast('notify', {title, body, messageId})`, и (Ф8) на `mailEvents.'message:updated'` → `broadcast('updated', {id, is_read?, is_important?})` — единый путь `updated`-событий для REST PATCH, WS `mark_read` и IMAP reverse-sync. Входящие сообщения от клиента (JSON): `{type:'ping'}` → ответ `{type:'pong', data:{ts}}`; `{type:'mark_read', id}` → делегирует в `services/messages.markFlags(id, { is_read: 1 })` (общий путь с PATCH): БД + fire-and-forget IMAP `\Seen` + эмит `message:updated`, broadcast делает listener hub'а. Невалидный JSON / неизвестный type — warn-лог + `{type:'error',data:{error:'invalid_json'|...}}`. Late-bind: после init выставляет `globalThis.__mailHelperWsHub = hub` (используется `actions/browser.js`). Экспорт `initWsHub(httpServer)` → объект `{ broadcast(type,data), sendTo(clientId,type,data), onMessage(handler), clientCount(), close() }`. `close()` снимает все подписки/handlers, шлёт `1001` всем клиентам, через 200 мс `terminate` остатков и `wss.close()`.

### extension/ — Chrome Extension MV3 (Phase 7)

Ванильное MV3 расширение без бандлера. Устанавливается через `chrome://extensions` → Load unpacked, корневая папка — `extension/`. Подробности по установке и конфигурации: [extension/README.md](extension/README.md).

- [extension/manifest.json](extension/manifest.json) — MV3 манифест. `permissions: [storage, notifications, alarms, scripting]`, `host_permissions`: `*://mail.google.com/*`, `*://mail.yandex.ru/*`, `http://localhost:3000/*`, `http://127.0.0.1:3000/*`, `http://*/*`, `https://*/*` (последние два нужны чтобы SW мог `fetch`/WS на любой backend). `background.service_worker: 'background.js'` с `type:'module'` для будущих ESM-зависимостей (сейчас используется обычный SW-скрипт). `content_scripts`: `gmail.js`+`inject.css` на Gmail, `yandex.js`+`inject.css` на Yandex, обе пары с `run_at: document_idle`. `options_page: 'options/options.html'`. `action` с тулбар-иконкой. `web_accessible_resources`: `sidebar/*`, `icons/*` для Gmail/Yandex (чтобы iframe мог грузиться с `chrome-extension://…/sidebar/sidebar.html`).
- [extension/background.js](extension/background.js) — service worker. Ответственности: (1) открывает и держит WebSocket на `backendUrl→wsUrl /ws?token=<api_key>` с экспоненциальным backoff (2s→60s) и jitter ±25%, после 30с стабильного коннекта сбрасывает backoff. Каждому сокету ставится маркер `socket.__mhReplaced`: при повторном `openWs()` предыдущий сокет помечается как replaced, его `close`/`open`/`message`/`error` хендлеры игнорятся — исключает параллельные цепочки `scheduleReconnect`; (2) `chrome.alarms.create('mh-keepalive', {periodInMinutes: 0.5})` — пинает SW каждые 30с и при необходимости форсирует реконнект; отдельный alarm `mh-reconnect` для отложенных попыток (≥30с); (3) на `new_message` / `updated` / `ws_status` событиях WS — `chrome.runtime.sendMessage` в sidebar/options; (4) `showNotification()` для события `notify` (всегда) и `new_message` с `important=true` + опт-ин `notify_important` в storage; (5) `chrome.notifications.onClicked` → `focusMessageInMailTab(id)` — ищет Gmail/Yandex вкладку, активирует, шлёт `chrome.tabs.sendMessage(tabId, {type:'focus_message', id})`; (6) `chrome.runtime.onMessage` роутер: `settings_changed`/`reconnect_ws` → `openWs()`, `get_ws_status` → `{state,lastError}`, `mark_read` → `ws.send({type:'mark_read', id})`, `focus_message` → `focusMessageInMailTab`; (7) `chrome.storage.onChanged` на `backend_url|api_key` → немедленный реконнект; (8) boot-хуки: `runtime.onInstalled`, `runtime.onStartup` и top-level `openWs()` чтобы просыпаться после suspend.
- [extension/options/options.html](extension/options/options.html) — страница настроек (MV3 options_page). Форма: Backend URL (default `http://localhost:3000`), API Key (password), кнопки **Save** / **Test connection** / **Reconnect WS**, чекбокс «Show desktop notification for every important message» + отдельная кнопка сохранения.
- [extension/options/options.css](extension/options/options.css) — светлая тема, нейтральные карточки.
- [extension/options/options.js](extension/options/options.js) — логика страницы. `loadSettings()` читает `chrome.storage.local.{backend_url, api_key, notify_important}`. `normalizeBackendUrl()` обрезает trailing slash и валидирует протокол. `onSaveClick()` пишет в storage + шлёт `chrome.runtime.sendMessage({type:'settings_changed'})` для моментального реконнекта. `onTestClick()` делает `GET /api/health` (без auth), затем `GET /api/messages?limit=1` с `X-API-Key` и показывает статус-баннер. `onReconnectClick()` шлёт `reconnect_ws` в background.
- [extension/sidebar/sidebar.html](extension/sidebar/sidebar.html) — корневой контейнер панели: header (бренд + WS-индикатор), filters tabs (Important/Unread/All + refresh), контейнер списка, footer с счётчиком и ссылкой в Settings.
- [extension/sidebar/sidebar.css](extension/sidebar/sidebar.css) — стили панели: фикс-лейаут, карточки писем, теги (category/reason), индикатор WS (цветная точка), тост внизу.
- [extension/sidebar/sidebar.js](extension/sidebar/sidebar.js) — ванильный JS панели. `boot()`: читает storage, GET `/api/messages?<filter>&limit=50` с `X-API-Key`, строит `messagesById: Map<id, message>`, рендерит. `getVisibleMessages()` сортирует: important → unread → date desc. `markRead(id)`: оптимистичный UI + `PATCH /api/messages/:id {is_read:1}`, rollback при ошибке. `openMessage(id)` → `chrome.runtime.sendMessage({type:'focus_message', id})`. Слушает `chrome.runtime.onMessage`: `new_message` вставляет карточку сверху и триггерит toast если `important=true`; `updated` мутирует `messagesById[id]`; `ws_status` обновляет индикатор; `focus_message` скроллит карточку в поле зрения. `chrome.storage.onChanged` → перезагрузка при смене кредов.
- [extension/content/gmail.js](extension/content/gmail.js) — content script для `*://mail.google.com/*`. Создаёт `<iframe class="mh-sidebar-frame">` с `src=chrome.runtime.getURL('sidebar/sidebar.html')` и кнопку toggle, оба — прямые дети `document.documentElement` (чтобы пережить SPA-перерисовки Gmail). `MutationObserver` на `documentElement` (childList) пересоздаёт iframe при удалении. Состояние collapsed/expanded хранится в `chrome.storage.local.sidebar_collapsed_gmail`. Мостик `chrome.runtime.onMessage` → `iframe.contentWindow.postMessage(...)` дублирует live-события в sidebar для подстраховки.
- [extension/content/yandex.js](extension/content/yandex.js) — то же для `*://mail.yandex.ru/*`, ключ состояния `sidebar_collapsed_yandex`.
- [extension/content/inject.css](extension/content/inject.css) — стили iframe+toggle. CSS-переменная `--mh-sidebar-width: 380px`. Класс `mh-sidebar-open` на `<html>` даёт `padding-right` равный ширине панели; `mh-sidebar-collapsed` сужает до 36px.
- [extension/icons/icon.svg](extension/icons/icon.svg) — исходная векторная иконка (конверт на синем фоне).
- `extension/icons/icon16.png`, `icon48.png`, `icon128.png` — PNG иконки тулбара/магазина (генерируются скриптом при первом запуске; сейчас залиты placeholder-вариантом).
- [extension/README.md](extension/README.md) — инструкция по Load unpacked, конфигурации, troubleshooting, обоснование permissions.

### Поток данных расширения

```
WS /ws?token=… (hub.js broadcast)
     │
     ▼
background.js service worker — onWsMessage(raw)
     │                    ├── type:new_message  → chrome.runtime.sendMessage + chrome.notifications (если important & notify_important)
     │                    ├── type:updated      → chrome.runtime.sendMessage
     │                    ├── type:notify       → chrome.notifications (всегда)
     │                    └── type:pong         → ignore
     │
     ▼                                                    ▲
content/{gmail,yandex}.js (injects iframe)                │
     │                                                    │
     ▼                                                    │
sidebar/sidebar.html (iframe) ←──── runtime.onMessage ────┘
     │
     ├── user clicks Mark read → PATCH /api/messages/:id {is_read:1}
     └── user clicks Open      → chrome.runtime.sendMessage({type:'focus_message', id})
                                                            │
                                                            ▼
                                      background.js → chrome.tabs.update(active:true) + sendMessage(focus_message)
```

### Ключи `chrome.storage.local`

| Ключ | Тип | Источник | Потребители |
|------|-----|----------|-------------|
| `backend_url` | string | options.js | background.js, sidebar.js |
| `api_key` | string | options.js | background.js (WS token + fetch), sidebar.js (`X-API-Key`) |
| `notify_important` | boolean | options.js | background.js (фильтр уведомлений) |
| `sidebar_collapsed_gmail` | boolean | content/gmail.js | content/gmail.js |
| `sidebar_collapsed_yandex` | boolean | content/yandex.js | content/yandex.js |

### Сообщения `chrome.runtime`

| Тип | Отправитель | Получатель | Payload |
|-----|-------------|------------|---------|
| `settings_changed` | options.js | background.js | — |
| `reconnect_ws` | options.js | background.js | — |
| `get_ws_status` | sidebar.js | background.js | → `{state, lastError}` |
| `mark_read` | sidebar.js (будущее) | background.js → WS | `{id}` |
| `focus_message` | sidebar.js / notification click | background.js → tab | `{id}` |
| `new_message` | background.js (WS bridge) | sidebar.js | данные письма |
| `updated` | background.js (WS bridge) | sidebar.js | `{id, is_read?, is_important?}` |
| `ws_status` | background.js | sidebar.js | `{state}` |

## WebSocket endpoint

| Путь  | Auth                       | Server→Client события | Client→Server события |
|-------|----------------------------|------------------------|------------------------|
| `/ws` | `?token=<api_key>` (query) | `new_message`, `updated`, `notify`, `pong`, `error` | `ping`, `mark_read` |

## REST endpoints (текущий срез)

| Метод  | Путь                   | Auth           | Описание |
|--------|------------------------|----------------|----------|
| GET    | `/api/health`          | нет            | `{ ok, uptime, version }` |
| GET    | `/api/settings`        | X-API-Key      | маскированные значения + флаги `has_*` |
| PUT    | `/api/settings`        | X-API-Key      | upsert шифрованных `openrouter_api_key`/`telegram_bot_token`/`api_key` |
| GET    | `/api/accounts`        | X-API-Key      | список аккаунтов (без паролей) |
| GET    | `/api/accounts/:id`    | X-API-Key      | один аккаунт |
| POST   | `/api/accounts`        | X-API-Key      | создать (пароли шифруются) |
| PUT    | `/api/accounts/:id`    | X-API-Key      | обновить (пустой пароль = не менять) |
| DELETE | `/api/accounts/:id`    | X-API-Key      | удалить (каскад на messages) |
| POST   | `/api/accounts/:id/test` | X-API-Key    | `{ imap: {ok,error?}, smtp: {ok,error?} }` — проверка кредов |
| GET    | `/api/prompts`         | X-API-Key      | список промтов |
| GET    | `/api/prompts/:id`     | X-API-Key      | один промт |
| POST   | `/api/prompts`         | X-API-Key      | создать; `is_default=1` сбрасывает у остальных |
| PUT    | `/api/prompts/:id`     | X-API-Key      | обновить |
| DELETE | `/api/prompts/:id`     | X-API-Key      | удалить |
| POST   | `/api/prompts/:id/test`| X-API-Key      | прогнать промт через LLM на последнем / переданном письме (без записи в БД) |
| GET    | `/api/actions`         | X-API-Key      | список actions с расшифрованным `config` |
| GET    | `/api/actions/:id`     | X-API-Key      | один action |
| POST   | `/api/actions`         | X-API-Key      | создать (`config` шифруется) |
| PUT    | `/api/actions/:id`     | X-API-Key      | обновить |
| DELETE | `/api/actions/:id`     | X-API-Key      | удалить |
| GET    | `/api/messages`        | X-API-Key      | список с фильтрами и пагинацией |
| GET    | `/api/messages/:id`    | X-API-Key      | одно письмо (body_text/body_html) |
| PATCH  | `/api/messages/:id`    | X-API-Key      | обновить `is_read`/`is_important` (только БД) |
