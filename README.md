# Помощник продакта Softline Store

Приложение отслеживает продуктовые метрики, помогает разобраться в причинах изменений и проверить эффект релиза. Каждый расчёт можно сверить с источником и периодом наблюдения.

[Локальный запуск](#локальный-запуск) · [Хостинг на VPS](#хостинг-на-vps) · [Первый вход и данные](#первый-вход-и-данные) · [Подключение модели](#подключение-модели) · [Интеграции](#интеграции) · [Обновление и проверки](#обновление-и-проверки)

## Локальный запуск

Установите Git, Node.js 24, pnpm 11 и Python 3.10+. Python нужен для импорта ZIP, XLSX и PPTX и для отправки почты. При необходимости установите pnpm командой `npm install -g pnpm@11.25.0`.

```sh
git clone --branch main https://github.com/BigRuPanda/AI-kuznica-PM-agent.git
cd AI-kuznica-PM-agent
pnpm install --frozen-lockfile
pnpm setup
```

`pnpm setup` создаёт `.env` и генерирует ключи приглашений и `INTEGRATION_KEY` для персональных подключений. Если приложение не находит Python, укажите полный путь к исполняемому файлу в `PYTHON_BIN` в `.env`. Пример на Windows — `PYTHON_BIN="C:\Python311\python.exe"`.

```sh
pnpm build
pnpm start
```

Приложение по умолчанию слушает `127.0.0.1:8090`. Если меняете `PORT`, задайте тот же порт в `APP_BASE_URL`. SQLite хранится в `var/`. [Открыть приложение](http://127.0.0.1:8090) · [Проверить состояние](http://127.0.0.1:8090/health)

## Хостинг на VPS

### Сервер и домен

1. Подключитесь к Linux-серверу по SSH и установите Git, curl, OpenSSL, Docker Engine и плагин Compose. Проверьте установку командами `sudo docker version` и `sudo docker compose version`. [Установка Docker на Ubuntu](https://docs.docker.com/engine/install/ubuntu/)
2. Направьте DNS-запись `A` своего поддомена на IPv4 сервера и откройте входящие TCP-порты 80 и 443 для Caddy. Если используете `AAAA`, проверьте доступность сервера по IPv6. Ниже `pm.example.com` обозначает ваш поддомен. [Автоматический HTTPS в Caddy](https://caddyserver.com/docs/automatic-https)
3. Клонируйте репозиторий на VPS с доступом к GitHub. Для переноса конкретного коммита можно создать архив командой `git archive --format=tar.gz --output=pm-agent.tar.gz HEAD`, передать его по SCP и распаковать на сервере.

```sh
git clone --branch main https://github.com/BigRuPanda/AI-kuznica-PM-agent.git
cd AI-kuznica-PM-agent
```

### Конфигурация и запуск

При первом развёртывании выполните `install -m 600 .env.example .env`. Откройте `.env` и задайте домен, адрес сайта и ключи. Сгенерируйте код администратора командой `openssl rand -hex 32`. Для `INTEGRATION_KEY` нужны 32 случайных байта в base64url. Получить такой ключ можно командой `openssl rand -base64 32 | tr '/+' '_-' | tr -d '='`.

```dotenv
SITE_DOMAIN=pm.example.com
APP_BASE_URL=https://pm.example.com
ADMIN_INVITE_KEY=СЛУЧАЙНЫЙ_КОД_АДМИНИСТРАТОРА
INTEGRATION_KEY=СЛУЧАЙНЫЙ_КЛЮЧ_BASE64URL
DATA_PROFILE=local
```

```sh
sudo docker compose config --quiet
sudo docker compose up -d --build
sudo docker compose ps
curl -fsS https://pm.example.com/health
```

Замените домен в команде curl. У контейнера `app` ожидается статус `healthy`, а `/health` возвращает `{"ok":true}`. Первый выпуск TLS-сертификата может занять несколько минут. После изменения `.env` выполните `sudo docker compose up -d`.

В Docker вместо `pnpm ops <команда>` запускайте `sudo docker compose exec -T app node scripts/ops.mjs <команда>`. Например, ссылки для первого входа выдаёт команда ниже.

```sh
sudo docker compose exec -T app node scripts/ops.mjs links
```

## Первый вход и данные

1. Откройте сайт и выберите **У меня есть приглашение**. Для первого администратора используйте `ADMIN_INVITE_KEY` из `.env`. Команда `pnpm ops links` покажет готовую ссылку. После регистрации администратора создавайте приглашения в **Настройках команды**.
2. Откройте **Источники**, загрузите архив ZIP, книгу XLSX или презентацию PPTX и нажмите **Загрузить и пересчитать**. Импорт доступен администратору. Через терминал тот же импорт запускается командой `pnpm ops import ./hackathon.zip`.
3. Откройте релиз в **Релизах** или сигнал в **Разборах**. Сверьте период, числитель, знаменатель и ссылку на данные. По результату можно подготовить задачу и задать условия проверки эффекта.

Для дневной аналитики событий откройте **Релизы → Управление**, импортируйте CSV и создайте релиз на его основе. В CSV обязательны `event_type`, `event_at` с часовым поясом и `order_id` или `invoice_id`. Для сегментов, сумм и сравнения версий заполните `customer_segment`, `amount_rub` и `ui_version` соответственно. Значения типов событий и правила импорта приведены в коде. [Формат CSV](server/import.mjs)

Для **жюри** задайте отдельный случайный `DEMO_INVITE_KEY` и подготовьте материалы командой `pnpm ops prepare-demo ./hackathon.zip`. Затем получите ссылку через `pnpm ops links`. Новые аккаунты жюри получают выделенные пространства с этим набором.

Для CLI-импорта на VPS сначала скопируйте архив в контейнер.

```sh
sudo docker compose cp ./hackathon.zip app:/tmp/hackathon.zip
sudo docker compose exec -T --user root app chown node:node /tmp/hackathon.zip
sudo docker compose exec -T app node scripts/ops.mjs import /tmp/hackathon.zip
sudo docker compose exec -T app rm /tmp/hackathon.zip
```

Для подготовки материалов жюри используйте `prepare-demo` в той же команде до удаления файла.

Для **режима согласования источников** укажите в `SOURCE_ARCHIVE_SHA256` SHA-256 исходного ZIP организатора. Загрузите этот ZIP первым. Последующие версии согласует администратор в **Источниках**.

## Подключение модели

Стартовый профиль `DATA_PROFILE=local` выполняет расчёты на сервере и отключает вызовы модели. Для Qwen3.8 27B через ProxyAPI укажите в `.env` следующие настройки. [Карточка модели](https://proxyapi.ru/models/qwen/qwen3.8-27b)

```dotenv
DATA_PROFILE=configured
LLM_BACKEND=proxyapi
LLM_MODEL=qwen/qwen3.8-27b
```

Локально выполните `pnpm model:key` для скрытого ввода токена и `pnpm model:check` для проверки вызова инструмента. На VPS сохраните токен в `PROXYAPI_API_KEY` в серверном `.env` и выполните команды ниже.

```sh
sudo docker compose up -d
sudo docker compose exec -T app node scripts/check-model.mjs
```

| Провайдер | Дополнительные параметры |
| --- | --- |
| `proxyapi` | `PROXYAPI_API_KEY` и идентификатор модели из каталога ProxyAPI |
| `api` | `LLM_BASE_URL` совместимого API и его `LLM_API_KEY` |
| `gemini`, `vertex-express` | `LLM_API_KEY` |
| `vertex` | `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` и Google Application Default Credentials. При использовании файла укажите `GOOGLE_APPLICATION_CREDENTIALS` по пути, доступному приложению. |

Для каждого провайдера задайте подходящий `LLM_MODEL`. Режим `LLM_DATA_MODE=selection` оставляет подготовку чисел на сервере. В `analysis` модель также получает отобранные факты для расследования.

## Интеграции

Для внешних сервисов используйте `DATA_PROFILE=configured`. В профиле `local` перечислите разрешённые адреса в `LOCAL_HTTP_ORIGINS` через запятую, включая схему и порт. Пример адреса — `http://127.0.0.1:18880`. Для почты укажите `LOCAL_SMTP_TARGET` в формате `хост:порт`. После правок `.env` перезапустите приложение. [Все параметры](.env.example)

### Яндекс Метрика

1. Получите OAuth-токен с правом `metrika:read` от учётной записи с доступом к счётчику. Запишите токен в `METRIKA_TOKEN` и укажите числовые ID в `METRIKA_COUNTER_IDS` через запятую без пробелов. [Авторизация в Метрике](https://yandex.ru/dev/metrika/ru/intro/authorization)
2. По умолчанию загружаются визиты. Чтобы считать CTR, добавьте отчёт в `METRIKA_REPORTS_JSON`. В примере замените ID целей `123` и `456` на цели клика и показа своего счётчика.

   ```dotenv
   METRIKA_REPORTS_JSON=[{"id":"lk_reco_ctr","product":"ЛК","numerator":"ym:s:goal123visits","denominator":"ym:s:goal456visits","dimensions":"ym:s:date","unit":"ratio"}]
   ```

3. Выполните `pnpm ops check-metrika`. Откройте **Источники → Синхронизировать Метрику** и проверьте, что журнал показывает успешную загрузку и дату последнего наблюдения.

`METRIKA_TIME_ZONE` задаёт часовой пояс счётчика. Для недельных отчётов первой группировкой укажите `ym:s:startOfWeek`. `METRIKA_SYNC_MINUTES=0` оставляет ручной запуск, интервал от 5 минут включает регулярную загрузку в обычном режиме.

### Redmine

1. Включите REST API на стороне Redmine. Администратор приложения указывает HTTPS-адрес и идентификатор проекта в **Настройки команды → Подключения команды**. Там же можно задать ID поля **Происхождение задачи** для метки `ai-generated`. [REST API Redmine](https://www.redmine.org/projects/redmine/wiki/Rest_api)
2. Участник открывает **Мои настройки → Личные подключения**, вводит личный API-ключ Redmine и нажимает **Проверить доступ**. Для сохранения подключений нужен `INTEGRATION_KEY` из `.env`.
3. Найдите задачу из разбора и проверьте, что черновик открывается для подтверждения. Для проверки с сервера задайте личный ключ приложения в `MCP_ACCESS_TOKEN` и выполните `pnpm ops check-redmine`.

### Confluence

При подключённом Signal Bridge настройки Confluence доступны в разделах **Подключения команды** и **Личные подключения**. Администратор также может задать адрес, редакцию и ключ пространства запросом `POST /api/team/integration-config` в авторизованной сессии. Пример для Cloud.

```json
{"service":"confluence","url":"https://team.atlassian.net","edition":"cloud","scope":"PM"}
```

- **Data Center** использует `edition: "dc"`. В адресе сохраните префикс установки, например `/confluence`. Участник передаёт личный токен с правами на нужное пространство в поле `token` запроса `POST /api/team/integration-access` вместе с `service: "confluence"` и `action: "connect"`.
- **Cloud** использует общее приложение OAuth 2.0 (3LO). В `.env` задайте `CONFLUENCE_CLIENT_ID` и `CONFLUENCE_CLIENT_SECRET`, а в настройках OAuth укажите адрес возврата `APP_BASE_URL/api/integrations/confluence/callback` с вашим доменом. Участник отправляет тот же запрос `integration-access` с действием `connect` и открывает полученную ссылку `authorize`. [Настройка OAuth Atlassian](https://developer.atlassian.com/cloud/confluence/oauth-2-3lo-apps/)

Для Cloud добавьте права `read:confluence-content.all`, `read:confluence-space.summary`, `search:confluence`, `write:confluence-content`, `read:page:confluence`, `write:page:confluence` и `read:space:confluence`. Для обновления доступа приложение запрашивает `offline_access`. Проверка с сервера — `pnpm ops check-confluence` с личным ключом приложения в `MCP_ACCESS_TOKEN`.

### Telegram

1. Создайте бота через BotFather и укажите `TELEGRAM_BOT_TOKEN` в `.env`. Для групп добавьте бота и перечислите разрешённые ID в `TELEGRAM_CHAT_IDS`. Для канала уведомлений можно использовать `TELEGRAM_CHANNEL_ID`. [Создание бота](https://core.telegram.org/bots/tutorial#obtain-your-bot-token)
2. Проверьте токен командой `pnpm ops check-telegram`. На публичном стенде задайте HTTPS-адрес в `APP_BASE_URL`, сгенерируйте `TELEGRAM_WEBHOOK_SECRET` командой `openssl rand -hex 32` и выполните `pnpm ops register-webhook`.
3. Для личных уведомлений откройте **Мои настройки → Мои уведомления → Привязать Telegram**, перейдите к боту и нажмите **Старт**. В разрешённой группе задайте вопрос командой `/ask` или ответом на сообщение бота.

Для локальной привязки через опрос используйте отдельного бота с пустым `TELEGRAM_WEBHOOK_SECRET` и задайте `TELEGRAM_BIND_POLLING=true`. Затем перезапустите приложение.

### Почта и фоновые уведомления

1. Укажите `SMTP_HOST`, `SMTP_PORT`, `SMTP_FROM` и `SMTP_TO` для тестового письма. Для SMTP с авторизацией задайте `SMTP_USER` и `SMTP_PASSWORD`. Обычно порт 587 использует `SMTP_TLS=starttls`, порт 465 — `SMTP_TLS=implicit`.
2. Проверьте подключение командой `pnpm ops check-smtp`. Команда `pnpm ops test-smtp` отправит письмо на `SMTP_TO`. Для личной доставки участник подтверждает адрес в **Мои настройки → Мои уведомления**.
3. Когда каналы и получатели проверены, установите `NOTIFICATIONS_ENABLED=true`. В `NOTIFICATION_CHANNELS` укажите `smtp`, `telegram` или `telegram,smtp`. Состояние отправок видно в **Настройки команды → Доставка уведомлений**.

### MCP

Откройте **Мои настройки → Выпустить ключ MCP**. Для удалённого клиента выберите Streamable HTTP, добавьте к адресу приложения путь `/mcp` и передайте `Authorization: Bearer <ключ>`. Для локального stdio задайте `MCP_ACCESS_TOKEN` в окружении клиента и запускайте `pnpm mcp` из каталога проекта. [Транспорты MCP](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)

### Signal Bridge

В каталоге `integrations/signal-bridge` установите Python 3.11+, выполните `python3 configure.py` с доступом к Метрике и Redmine, затем `python3 service.py`. На Windows используйте `configure.cmd` и `start.cmd`. Проверьте `/health` сервиса на порту 18880 и укажите его адрес в `SIGNAL_BRIDGE_URL` в `.env` командного приложения. В Docker адрес должен быть доступен из контейнера `app`. [Настройка Signal Bridge и его уведомлений](integrations/signal-bridge/README.md)

### Поиск в интернете

Подключите Yandex Search API и сохраните ID каталога в `YANDEX_SEARCH_FOLDER_ID`, а API-ключ сервисного аккаунта в `YANDEX_SEARCH_API_KEY`. Выполните проверку в чате с переключателем **Поиск в интернете**. [Настройка Yandex Search API](https://aistudio.yandex.ru/ru/docs/search-api/quickstart/)

## Обновление и проверки

Перед обновлением сделайте резервную копию SQLite. Локальная команда `pnpm ops backup` проверит копию и выведет её путь. На VPS для согласованного снимка остановите сервисы на время копирования.

```sh
sudo docker compose stop caddy app
sudo docker compose run --rm --no-deps -T app node scripts/ops.mjs backup
sudo docker compose up -d
```

Копия находится внутри тома `pmdata` в `/app/var/backups`. Подставьте имя снимка из вывода и скопируйте его с VPS в своё хранилище. Сохраните серверный `.env` отдельно, включая `INTEGRATION_KEY` для восстановления личных подключений.

```sh
snapshot='имя-каталога-из-вывода'
install -d -m 700 "$HOME/pm-backups"
sudo docker compose cp "app:/app/var/backups/$snapshot" "$HOME/pm-backups/"
```

Для обновления запуска из Git выполните `git pull --ff-only`, `sudo docker compose up -d --build` и снова проверьте `/health`. Для обычной остановки используйте `sudo docker compose stop`.

| Симптом | Проверка |
| --- | --- |
| Сайт не открывается по HTTPS | DNS домена, порты 80 и 443, журнал `sudo docker compose logs --tail=100 caddy` |
| Контейнер `app` не готов | Значение `APP_BASE_URL`, журнал `sudo docker compose logs --tail=100 app` |
| Модель не отвечает | `DATA_PROFILE`, идентификатор модели, ключ и ответ `model:check` |
| Метрика вернула 403 | Право `metrika:read` и доступ владельца токена к выбранному счётчику |

```sh
pnpm test
pnpm test:ui
```

Для браузерных тестов используйте Edge или Chromium. При необходимости укажите путь в `PM_BROWSER_PATH`. Сквозной сценарий с Метрикой, Redmine и почтой описан в пилоте. [Локальный пилот](submission/pilot.md) · [Протокол проверки интерфейса](submission/ui-migration-acceptance.md)
