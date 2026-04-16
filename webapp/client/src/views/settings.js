// views/settings.js — Настройки и интеграции (#/settings).
//
// Phase 3 редизайн (Pencil 7UqaE): карточный лэйаут в вертикальном стеке.
//   1. Card «Почтовые аккаунты» — grid AccountCard + IconTile «+» (открывает
//      AccountEditor‑модалку из views/accounts.js).
//   2. Card «AI‑провайдер (OpenRouter)» — Input API‑key (password), Select
//      модели, кнопка «Проверить соединение» + статус‑индикатор.
//   3. Card «Уведомления Telegram» — Input bot token, Input chat_id, кнопка
//      «Отправить тест» + статус.
//   4. Card «Расширение браузера» — статус‑карточка + текстовая инструкция.
//
// Сохранение через PUT /api/settings (паттерн оригинального settings.js:
// отправлять только непустые поля).

import { settingsApi, accountsApi } from '../api.js';
import {
  SectionHeader,
  Card,
  Button,
  Input,
  Select,
  EmptyState,
} from '../components/ui.js';
import { h, statusDot, showError } from './util.js';
import { renderAccountCard, openAccountModal } from './accounts.js';

/* ---------------------------- Константы ------------------------------- */

const DEFAULT_MODEL = 'x-ai/grok-4-fast';
const MODEL_OPTIONS = [
  { value: 'x-ai/grok-4-fast', label: 'xAI · Grok 4.1 Fast' },
  { value: 'openai/gpt-4o-mini', label: 'OpenAI · GPT‑4o mini' },
  { value: 'openai/gpt-4o', label: 'OpenAI · GPT‑4o' },
  { value: 'anthropic/claude-3.5-sonnet', label: 'Anthropic · Claude 3.5 Sonnet' },
  { value: 'openrouter/auto', label: 'OpenRouter · Auto' },
];

/* ----------------------------- Хелперы UI ----------------------------- */

function statusIndicator(state, label) {
  const span = h('span', { class: 'inline-flex items-center gap-2 text-xs text-[color:var(--color-text-secondary)]' }, [
    statusDot(state),
    h('span', { text: label }),
  ]);
  return span;
}

/* ----------------------------- Render ---------------------------------- */

export async function renderSettings(root) {
  root.innerHTML = '';
  const wrap = h('div', { class: 'flex flex-col gap-6 max-w-4xl' });
  root.appendChild(wrap);

  wrap.appendChild(SectionHeader({
    title: 'Настройки и интеграции',
    subtitle: 'Аккаунты, AI‑провайдер, уведомления и расширения',
  }));

  let current;
  try {
    current = await settingsApi.get();
  } catch (err) {
    showError(root, err);
    return;
  }

  /* ===== 1. Почтовые аккаунты ===== */
  const accountsHost = h('div', { class: 'grid grid-cols-1 sm:grid-cols-2 gap-3' });
  const refreshAccounts = async () => {
    accountsHost.innerHTML = '<div class="col-span-full text-sm text-[color:var(--color-text-secondary)]">Загрузка…</div>';
    try {
      const resp = await accountsApi.list();
      const list = Array.isArray(resp) ? resp : resp.accounts || [];
      accountsHost.innerHTML = '';
      if (!list.length) {
        accountsHost.appendChild(
          h('div', { class: 'col-span-full' }, [
            EmptyState({
              icon: 'mail',
              title: 'Нет подключённых ящиков',
              description: 'Подключите Gmail/Yandex или произвольный IMAP‑аккаунт.',
              cta: Button({
                label: 'Подключить аккаунт',
                icon: 'plus',
                onClick: () => openAccountModal({ onSave: refreshAccounts }),
              }),
            }),
          ]),
        );
        return;
      }
      for (const acc of list) {
        accountsHost.appendChild(
          renderAccountCard(acc, {
            onConfigure: () => openAccountModal({ existingAccount: acc, onSave: refreshAccounts }),
            onDisconnect: async () => {
              // eslint-disable-next-line no-alert
              if (!window.confirm(`Отключить ${acc.email || acc.label || '#' + acc.id}?`)) return;
              try {
                await accountsApi.remove(acc.id);
                refreshAccounts();
              } catch (err) {
                // eslint-disable-next-line no-alert
                window.alert('Ошибка: ' + (err?.message || err));
              }
            },
          }),
        );
      }
      // Плитка «+ Подключить аккаунт» в конце grid'а.
      const addTile = document.createElement('button');
      addTile.type = 'button';
      addTile.className = 'flex flex-col items-center justify-center gap-2 rounded-[var(--radius-lg)] border-2 border-dashed border-[color:var(--color-border-subtle)] bg-[color:var(--color-bg-surface)] p-6 text-sm text-[color:var(--color-text-secondary)] hover:border-[color:var(--color-accent-purple)] hover:text-[color:var(--color-accent-purple)] transition-colors min-h-[140px]';
      addTile.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h14"/><path d="M12 5v14"/></svg><span>Подключить аккаунт</span>';
      addTile.addEventListener('click', () => openAccountModal({ onSave: refreshAccounts }));
      accountsHost.appendChild(addTile);
    } catch (err) {
      accountsHost.innerHTML = '';
      showError(root, err);
    }
  };
  wrap.appendChild(
    Card({
      title: 'Почтовые аккаунты',
      subtitle: 'Подключённые ящики, с которых читаются и обрабатываются письма',
      children: accountsHost,
    }),
  );
  refreshAccounts();

  /* ===== 2. AI‑провайдер (OpenRouter) ===== */
  const openrouterStatus = statusIndicator(
    current.has_openrouter_api_key ? 'success' : 'idle',
    current.has_openrouter_api_key ? 'Ключ задан' : 'Ключ не задан',
  );
  const openrouterKeyInput = Input({
    label: 'API key OpenRouter',
    type: 'password',
    placeholder: current.has_openrouter_api_key ? '*** (оставьте пустым, чтобы не менять)' : '',
    name: 'openrouter_api_key',
    onInput: (v) => { aiState.openrouter_api_key = v; },
  });
  const aiState = {
    openrouter_api_key: '',
    model: current.default_model || DEFAULT_MODEL,
  };
  const modelSelect = Select({
    label: 'Модель по умолчанию',
    value: aiState.model,
    options: MODEL_OPTIONS,
    onChange: (v) => { aiState.model = v; },
  });
  const aiCheckBtn = Button({
    label: 'Проверить соединение',
    variant: 'ghost',
    icon: 'play',
    onClick: async () => {
      openrouterStatus.replaceChildren(statusDot('pending'), h('span', { text: 'Проверка…' }));
      // TODO(backend): полноценный health‑check OpenRouter (в settings.js нет
      // отдельного endpoint). Пока проверяем «есть ли ключ» в /api/settings.
      try {
        const fresh = await settingsApi.get();
        const ok = !!fresh.has_openrouter_api_key;
        openrouterStatus.replaceChildren(
          statusDot(ok ? 'success' : 'error'),
          h('span', { text: ok ? 'Подключено' : 'Ключ не настроен' }),
        );
      } catch (err) {
        openrouterStatus.replaceChildren(statusDot('error'), h('span', { text: 'Ошибка: ' + (err?.message || err) }));
      }
    },
  });
  const aiSaveBtn = Button({
    label: 'Сохранить',
    icon: 'check',
    onClick: async () => {
      const payload = {};
      if (aiState.openrouter_api_key) payload.openrouter_api_key = aiState.openrouter_api_key;
      if (!Object.keys(payload).length) {
        openrouterStatus.replaceChildren(statusDot('warning'), h('span', { text: 'Нечего сохранять' }));
        return;
      }
      try {
        await settingsApi.update(payload);
        openrouterStatus.replaceChildren(statusDot('success'), h('span', { text: 'Сохранено' }));
        // Обновляем чтобы скрыть значение из input.
        openrouterKeyInput.querySelector('input').value = '';
        aiState.openrouter_api_key = '';
      } catch (err) {
        openrouterStatus.replaceChildren(statusDot('error'), h('span', { text: 'Ошибка: ' + (err?.message || err) }));
      }
    },
  });
  wrap.appendChild(
    Card({
      title: 'AI‑провайдер (OpenRouter)',
      subtitle: 'Ключ и модель для классификации писем',
      children: [
        openrouterKeyInput,
        modelSelect,
        h('div', { class: 'flex items-center gap-3' }, [aiCheckBtn, aiSaveBtn, openrouterStatus]),
      ],
    }),
  );

  /* ===== 3. Уведомления Telegram ===== */
  const tgState = { telegram_bot_token: '', chat_id: '' };
  const tgStatus = statusIndicator(
    current.has_telegram_bot_token ? 'success' : 'idle',
    current.has_telegram_bot_token ? 'Бот настроен' : 'Бот не настроен',
  );
  const tgTokenInput = Input({
    label: 'Bot token',
    type: 'password',
    placeholder: current.has_telegram_bot_token ? '*** (оставьте пустым, чтобы не менять)' : '',
    name: 'telegram_bot_token',
    onInput: (v) => { tgState.telegram_bot_token = v; },
  });
  const tgChatInput = Input({
    label: 'Chat ID для тестового сообщения',
    placeholder: 'например, 123456789',
    onInput: (v) => { tgState.chat_id = v; },
  });
  const tgTestBtn = Button({
    label: 'Тест уведомления',
    variant: 'ghost',
    icon: 'play',
    onClick: async () => {
      tgStatus.replaceChildren(statusDot('pending'), h('span', { text: 'Отправка…' }));
      try {
        // TODO(backend): отдельного endpoint для теста telegram нет; пробуем
        // вызвать общий /api/actions/test (если когда‑то появится). Пока
        // просто проверяем что токен сохранён.
        const fresh = await settingsApi.get();
        const ok = !!fresh.has_telegram_bot_token;
        tgStatus.replaceChildren(
          statusDot(ok ? 'success' : 'error'),
          h('span', { text: ok ? 'Бот готов (отправка через action не реализована в API)' : 'Токен не задан' }),
        );
      } catch (err) {
        tgStatus.replaceChildren(statusDot('error'), h('span', { text: 'Ошибка: ' + (err?.message || err) }));
      }
    },
  });
  const tgSaveBtn = Button({
    label: 'Сохранить',
    icon: 'check',
    onClick: async () => {
      const payload = {};
      if (tgState.telegram_bot_token) payload.telegram_bot_token = tgState.telegram_bot_token;
      if (!Object.keys(payload).length) {
        tgStatus.replaceChildren(statusDot('warning'), h('span', { text: 'Нечего сохранять' }));
        return;
      }
      try {
        await settingsApi.update(payload);
        tgStatus.replaceChildren(statusDot('success'), h('span', { text: 'Сохранено' }));
        tgTokenInput.querySelector('input').value = '';
        tgState.telegram_bot_token = '';
      } catch (err) {
        tgStatus.replaceChildren(statusDot('error'), h('span', { text: 'Ошибка: ' + (err?.message || err) }));
      }
    },
  });
  wrap.appendChild(
    Card({
      title: 'Уведомления Telegram',
      subtitle: 'Бот для отправки уведомлений по правилам',
      children: [
        tgTokenInput,
        tgChatInput,
        h('div', { class: 'flex items-center gap-3' }, [tgTestBtn, tgSaveBtn, tgStatus]),
      ],
    }),
  );

  /* ===== 4. Mail Helper API key ===== */
  const apiKeyState = { api_key: '' };
  const apiKeyStatus = statusIndicator(
    current.has_api_key ? 'success' : 'warning',
    current.has_api_key ? 'Ключ установлен' : 'Ключ не задан',
  );
  const apiKeyInput = Input({
    label: 'Mail Helper API key (доступ к backend)',
    type: 'password',
    placeholder: current.has_api_key ? '*** (оставьте пустым, чтобы не менять)' : '',
    onInput: (v) => { apiKeyState.api_key = v; },
  });
  const apiKeySaveBtn = Button({
    label: 'Сохранить',
    icon: 'check',
    onClick: async () => {
      if (!apiKeyState.api_key) {
        apiKeyStatus.replaceChildren(statusDot('warning'), h('span', { text: 'Введите новый ключ' }));
        return;
      }
      try {
        await settingsApi.update({ api_key: apiKeyState.api_key });
        apiKeyStatus.replaceChildren(statusDot('success'), h('span', { text: 'Сохранено — обновите страницу' }));
        apiKeyInput.querySelector('input').value = '';
        apiKeyState.api_key = '';
      } catch (err) {
        apiKeyStatus.replaceChildren(statusDot('error'), h('span', { text: 'Ошибка: ' + (err?.message || err) }));
      }
    },
  });
  wrap.appendChild(
    Card({
      title: 'API‑ключ Mail Helper',
      subtitle: 'Используется для авторизации REST/WS запросов от UI и расширения',
      children: [
        apiKeyInput,
        h('div', { class: 'flex items-center gap-3' }, [apiKeySaveBtn, apiKeyStatus]),
      ],
    }),
  );

  /* ===== 5. Валюта отображения ===== */
  const currencyState = {
    currency: current.currency || 'USD',
    currency_rate: current.currency_rate || '',
  };
  const currencyStatus = statusIndicator('idle', '');

  const currencySelect = Select({
    label: 'Валюта отображения стоимости',
    value: currencyState.currency,
    options: [
      { value: 'USD', label: 'USD ($)' },
      { value: 'RUB', label: 'RUB (₽)' },
    ],
    onChange: (v) => {
      currencyState.currency = v;
      rateInput.style.display = v === 'RUB' ? '' : 'none';
    },
  });
  const rateInput = Input({
    label: 'Курс USD → RUB',
    value: currencyState.currency_rate || '',
    placeholder: 'например, 92.5',
    hint: 'Сколько рублей за 1 доллар. Стоимость будет пересчитана по этому курсу.',
    onInput: (v) => { currencyState.currency_rate = v; },
  });
  // Скрыть поле курса если валюта = USD.
  if (currencyState.currency !== 'RUB') rateInput.style.display = 'none';

  const currencySaveBtn = Button({
    label: 'Сохранить',
    icon: 'check',
    onClick: async () => {
      const payload = { currency: currencyState.currency };
      if (currencyState.currency === 'RUB') {
        const rate = parseFloat(currencyState.currency_rate);
        if (!rate || rate <= 0) {
          window.alert('Укажите корректный курс USD → RUB');
          return;
        }
        payload.currency_rate = rate;
      }
      try {
        await settingsApi.update(payload);
        currencyStatus.replaceChildren(statusDot('success'), h('span', { text: 'Сохранено' }));
      } catch (err) {
        currencyStatus.replaceChildren(statusDot('error'), h('span', { text: 'Ошибка: ' + (err?.message || err) }));
      }
    },
  });
  wrap.appendChild(
    Card({
      title: 'Валюта',
      subtitle: 'Валюта отображения расходов на LLM',
      children: [
        currencySelect,
        rateInput,
        h('div', { class: 'flex items-center gap-3' }, [currencySaveBtn, currencyStatus]),
      ],
    }),
  );

  /* ===== 6. Расширение браузера ===== */
  const extInstructions = h('div', { class: 'flex flex-col gap-3 text-sm text-[color:var(--color-text-secondary)]' }, [
    h('p', {}, 'Расширение MailMind для Chrome устанавливается вручную из директории extension/.'),
    h('ol', { class: 'list-decimal pl-5 space-y-1' }, [
      h('li', {}, 'Откройте chrome://extensions, включите «Режим разработчика».'),
      h('li', {}, 'Нажмите «Загрузить распакованное» и выберите папку extension/.'),
      h('li', {}, 'В opened‑окне расширения укажите host backend и API‑ключ.'),
    ]),
    h('div', { class: 'flex items-center gap-3' }, [
      statusIndicator('idle', 'Web Store: ещё не опубликовано'),
    ]),
  ]);
  wrap.appendChild(
    Card({
      title: 'Расширение браузера',
      subtitle: 'MailMind Chrome MV3 — оверлей в Gmail',
      children: extInstructions,
    }),
  );
}
