# План реализации исправлений чатов и разборов AnyModel

> **For agentic workers** Use `superpowers:subagent-driven-development` or `superpowers:executing-plans` to implement this plan task by task. Steps use checkboxes for tracking.

**Цель** Личные и общие чаты возвращают проверенный ответ или понятный частичный результат, а фоновые разборы завершают все выбранные роли и сохраняют подтверждённые выводы.

**Архитектура** Общий адаптер проверяет ответ и сохраняет причину сбоя. Чат связывает операции записи с явным поручением и подтверждает их сохранёнными квитанциями. Роли собирают итог из коротких проверенных частей, а очереди учитывают порядок беседы и актуальность попытки.

**Стек** Node.js 24, ES modules, `node:sqlite`, Zod v4, React, TypeScript, `node --test`, Playwright.

**Дизайн** `docs/superpowers/specs/2026-11-28-anymodel-chat-and-investigations-design.md` и согласованные находки аудита чатов, записи, источников и очередей.

## Общие условия

- Общий бюджет рабочего чата и каждой роли AnyModel составляет **600 секунд**. Срок владения попыткой может сократить бюджет роли. Рабочий чат сохраняет ограничение в **6 вызовов**. Для разделённого вывода ведущего и рецензента предусмотрено до **9 вызовов** в пределах прежнего времени. Детали ниже.
- Для `qwen/qwen3.8-27b` потолок генерации **65 536 токенов**, включая рассуждения. Наблюдаемый обрыв около **61 секунды** служит ориентиром для измерений. Успех оценивается по сохранённому результату и проверенным источникам.
- Профиль `DATA_PROFILE=local` выполняет расчёты локально. Запросы с данными модели подчиняются `LLM_DATA_MODE`. Проверки прав, закреплённый период, снимок источников и ручные подтверждения действуют при первичном вызове и при возобновлении.
- Обработать существующие `agent_turns`, `agent_steps` и прерванные попытки. В диагностику попадают только технические поля, включая модель, маршрут, длительность, HTTP-статус, причину завершения и код ошибки.
- Начать с текущей рабочей копии и зафиксировать исходные правки при подготовке места исполнения. Коммиты задач содержат изменения соответствующей задачи. Рабочая база стенда и настройка подключений остаются за границей тестовых прогонов.
- Модульные прогоны используют SQLite в памяти и подменённые ответы. Живая приёмка использует синтетические сценарии и штатный скрипт `agent:eval`.

## Что проверить при ревью

1. Повреждённый сохранённый ход после успешной записи возобновляется с квитанцией и без второй записи. Задача 2.
2. В одном запросе соседствуют отрицание записи и разрешённое чтение или действие другой природы. Цель записи берётся из разрешённого контекста. Задача 3.
3. Два разных черновика и повтор одного дают две квитанции. Откат вставки квитанции убирает локальную запись и отметку в ответе. Задача 4.
4. Роль успешно прочитала замечание об учёте, затем потеряла соединение на последней части. Публикуется только целый проверенный итог, повтор берёт исходный снимок. Задача 7.
5. Устаревшая роль отдаёт поздний ответ после запуска новой. Она освобождает слот и не меняет новую ревизию. Задача 11.

## Карта файлов

| Файлы | Ответственность |
| --- | --- |
| `server/model-response.mjs`, `server/agent.mjs`, `server/gemini.mjs` | Чтение и проверка ответа, общие признаки завершения, причины отказов, лимиты и сигнал отмены |
| `server/chat-write-intent.mjs`, `server/workspace-agent.mjs` | Допустимые действия, выбор цели, состояние хода модели и исполнение инструментов |
| `server/workspace-operations.mjs`, `server/workbench.mjs` | Транзакции действий, квитанции, итог поручения и выбор следующего задания |
| `server/investigation-engine.mjs`, `server/case-investigations.mjs`, `server/investigation-stages.mjs`, `server/investigation-scheduler.mjs` | Разделённый вывод, запись результатов роли, повторы и отмена |
| `server/source-chat.mjs`, `server/web-search.mjs`, `server/chat-brief.mjs`, `server/archive-search.mjs`, `server/http.mjs` | Завершённость ответа по источникам и отдельный обзор в журнале релизов |
| `server/team-http.mjs`, `web/team.tsx` | Параллельность бесед, видимый статус ожидания и опрос Telegram |
| `tests`, `scripts/acceptance` | Проверки конкретных регрессий и живые сценарии |

## Контроль перед реализацией

- [ ] Сохранить вывод `git status --short` и результаты команд ниже. Сейчас первая выборка проходит **58 тестов**. Во второй 6 проходов и 9 падений с учётом родительских тестов, связанных с наблюдением и предпросмотром. Сверять последующие прогоны с этой базой.

```powershell
node --test --test-force-exit tests/chat-grounding.test.mjs tests/investigation-engine.test.mjs tests/investigation-queue.test.mjs tests/anymodel-nonworkspace.test.mjs tests/anymodel-time-budgets.test.mjs
node --test --test-force-exit tests/chat-watch-tool.test.mjs tests/workspace-draft-receipts.test.mjs
```

## I. Ответ модели и безопасность записей

### Задача 1 — общая проверка ответа модели

**Файлы** `server/model-response.mjs`, `server/agent.mjs:52`, `server/gemini.mjs:32`. Тесты `tests/v1.test.mjs`, `tests/investigation-engine.test.mjs`.

**Интерфейс** `normalizeModelReply(message, {finishReason, usage, googleParts})` возвращает прежние `content`, `tool_calls`, `usage`, `googleParts` и `lengthLimited`, плюс `finishReason`. Ошибка адаптера сохраняет используемые `status`, `timedOut`, `retryable`, `invalidModelResponse` и при наличии добавляет `modelCode` и `retryAt` в миллисекундах Unix. `providerCall(env, messages, tools, choice, send, limits)` принимает необязательный `limits.signal`.

- [ ] Добавить в `tests/v1.test.mjs` тест `model reply rejects invalid tool batches and preserves valid stop calls`. Подставить `[null]`, отсутствующий или повторный `id`, нестроковые аргументы и поломанный JSON в аргументах одного из двух вызовов. Проверить `await assert.rejects(..., {invalidModelResponse:true})`. Ответ с `content:null`, полным вызовом и `finish_reason:'stop'` возвращает этот вызов и `finishReason === 'stop'`. Добавить тест `model failures retain retry deadline and cancellation` для HTTP 429 с `Retry-After:120`, HTTP 400 с `context_length_exceeded`, HTTP 402, обрыва потока и внешней отмены. Зафиксировать `Date.now()` на `receivedAt`, проверить `retryAt === receivedAt + 120_000`, коды причин и `timedOut !== true` для внешней отмены.
- [ ] Запустить `node --test --test-name-pattern="model reply rejects|model failures retain" tests/v1.test.mjs`. Ожидание до правки — принятие неисправного вызова либо потеря причины.
- [ ] Реализовать нормализацию после чтения HTTP-тела. Проверять типы, JSON-объект аргументов и уникальность ID внутри одного ответа. Схемы конкретных инструментов и права проверяет вызывающий маршрут. Нормализовать `length`, `refusal` и `content_filter`, сохраняя действительные вызовы с `stop`. Для Gemini сохранить родные `googleParts` и подписи, привести `MAX_TOKENS` к `length`. Из HTTP-ошибки брать только известный технический код и `Retry-After` как число секунд или HTTP-дату. Различать `invalid_response`, `body_interrupted`, `context_limit`, `rate_limit`, `quota`, `cancelled` в `modelCode`. При чтении тела отличать внешнюю отмену от тайм-аута. При сериализации истории исключить внутренние метаданные результата. Потолок генерации пока передаётся по текущим правилам.
- [ ] Запустить `node --test --test-force-exit tests/v1.test.mjs tests/check-model.test.mjs tests/investigation-engine.test.mjs`. Новые и существующие проверки транспорта проходят, включая `content:null` и продолжение Gemini с подписью.
- [ ] Зафиксировать изменения задачи в коммите `fix: validate model replies before dispatch`.

### Задача 2 — восстановление хода и показ результата чтения

**Файлы** `server/workspace-agent.mjs:201`, `server/workbench.mjs:1165`. Тест `tests/chat-grounding.test.mjs`.

**Интерфейс** `runAssistant(store, user, b, env, send, job, history, research, intent)` принимает результат задачи 1. `resumeJob(db, user, id)` сохраняет `agent_steps`, материалы и связь с исходным `questionSeq`.

- [ ] Добавить `private report survives bad tool reply and resumes from the last valid turn`. В фикстуре выполнить успешное чтение, затем подставить `[null]` и повторить задание. Отдельно загрузить состояние старого поручения с `[null]` в `pending` после сохранённой квитанции. Проверить `assert.equal(extraCallsAfterResume, 1)`, `assert.equal(writesAfterResume, writesBeforeResume)` и один ответ на исходный `questionSeq`. Добавить `optional read failure keeps a checked answer` и `truncated or refused chat reply is not done`. При `length` с полным по форме вызовом записи проверить `assert.equal(notes, 0)`. Проверенный вывод со ссылкой остаётся при сбое вспомогательного чтения, а обрыв текста и отказ дают `partial` при полезных данных или `failed` при их отсутствии.
- [ ] Запустить `node --test --test-name-pattern="private report survives|optional read failure|truncated or refused" tests/chat-grounding.test.mjs`. До правки старое поручение повторяет падение, ошибка чтения скрывает вывод, а обрезка может быть `done`.
- [ ] В `runAssistant` принимать в `pending` только полностью проверенный набор. `length` и отказ обрабатывать до вызова инструментов. При загрузке старого состояния удалять повреждённый ход и относящиеся к нему незавершённые пары. Исходный вопрос и валидные пары сохраняются. Уже записанные результаты удалённого хода передавать как проверенные данные из `agent_steps` и сохранённых ссылок. Разрешать завершение по этим данным после отказа необязательного шага. Завершённые записи подтверждаются квитанциями задач 3–5. Для `effect_preview` обработать `null` как отсутствие плана.
- [ ] Запустить `node --test --test-force-exit tests/chat-grounding.test.mjs tests/anymodel-time-budgets.test.mjs`. Ожидание — регрессии проходят, доступ к чужой карточке отклоняется, старый общий чат отвечает по доступной истории.
- [ ] Зафиксировать изменения задачи в коммите `fix: resume chat from valid model state`.

### Задача 3 — разрешённые действия и их цели

**Файлы** создать `server/chat-write-intent.mjs`. Изменить `server/workspace-agent.mjs:85` и `:357`. Тесты `tests/chat-grounding.test.mjs`, раздел отрицательных случаев `tests/chat-watch-tool.test.mjs`, сценарии личного вида в `tests/workspace.browser.mjs`.

**Интерфейс** `chatWriteRequests(question)` возвращает `Array<{op, count}>` по явным действиям текущего сообщения. `op` совпадает с ключом из `writes`. Чат использует этот набор для выбора инструментов, проверки записи и подсчёта результата. Позже очередь использует его для допуска параллельного выполнения.

- [ ] Добавить `case reports are read only and chat writes use the requested target`. Передать «Сделай разбор», «Не добавляй заметку», «Покажи карточки, ничего не меняй» и указание «Запиши в неё» о странице Confluence. Проверить отсутствие лишних инструментов и записей даже при подставленном вызове, а для «Добавь заметку в текущий разбор» с другим `caseId` проверить сохранение исходной карточки и отсутствие изменений в другой. Положительные варианты открывают `append_case`, `create_case` и `watch` для «Сохрани наблюдение». В тесте наблюдения проверить, что «Не назначай» даёт отказ до входа в транзакцию.
- [ ] Запустить `node --test --test-name-pattern="case reports are read only|cannot schedule a watch" tests/chat-grounding.test.mjs tests/chat-watch-tool.test.mjs`. До правки отрицательные команды доходят до записи.
- [ ] Реализовать `chatWriteRequests(question)` на явных сочетаниях действия и объекта, учитывая отрицание в соответствующей части поручения. Задача, страница, заметка, личный вид и наблюдение имеют свои формулировки. Явное количество задаёт `count`. Несколько разновидностей действий рассматриваются независимо. Для существующей карточки команда «Сделай разбор» означает чтение. Модель получает только инструменты разрешённых записей. Вариант `singleIssue` применяется только к одному запрошенному черновику Redmine, когда остальных записей нет. Для слов «текущий разбор» сервер берёт `caseId` из контекста, затем применяет текущую проверку доступа. Другую цель подтверждает однозначная ссылка в самом поручении. Если модель вернула лишнюю запись, отклонить её как результат инструмента и продолжить допустимые чтения. Для подготовленных внешних действий используются подтверждения в интерфейсе.
- [ ] Запустить команды предыдущего шага и `node --test --test-force-exit tests/chat-grounding.test.mjs`. Отрицательные сценарии и разрешённые заметки проходят. Положительные записи `watch` приводятся к зелёному в задаче 4.
- [ ] Зафиксировать изменения задачи в коммите `fix: scope chat writes to the requested action and target`.

### Задача 4 — атомарная запись и повторяемые квитанции

**Файлы** `server/workspace-operations.mjs:951`, `server/workspace-agent.mjs:636` и `:774`. Тесты `tests/chat-watch-tool.test.mjs`, `tests/workspace-draft-receipts.test.mjs`, `tests/chat-grounding.test.mjs`.

**Интерфейс** `workspaceOperation(store, user, op, input, env, send, sharedOnly, requestId, assistantAuthored)` сохраняет свой контракт. Квитанции `agent_steps` привязаны к поручению и подписи операции. Для черновика подпись учитывает нормализованное содержимое, целевую карточку и вид операции.

- [ ] Оставить текущие тесты наблюдения и добавить `failed receipt rolls back note and visible action` с TEMP-триггером, прерывающим вставку `agent_steps`. Проверить `notes === 0`, `receipts === 0` и отсутствие `append_case` в `actions`. В `tests/workspace-draft-receipts.test.mjs` добавить `two distinct issue drafts keep distinct receipts`. По двум разным запрошенным черновикам и повтору первого проверить `new Set(ids).size === 2`, две строки `draft_actions` и те же ID при продолжении после сбоя. Добавить фикстуру старой квитанции до смены подписи.
- [ ] Запустить `node --test --test-name-pattern="schedules one durable watch|failed receipt|two distinct issue drafts" tests/chat-watch-tool.test.mjs tests/chat-grounding.test.mjs tests/workspace-draft-receipts.test.mjs`. Ожидание до правки — двойной `BEGIN`, ложная отметка либо один ID для двух черновиков.
- [ ] Сделать тело `watch` синхронным под одной транзакцией. Прямой вызов открывает транзакцию, чат выполняет ту же операцию в своей транзакции с записью квитанции. Изменения состояния агента применять после успешного коммита. Передавать `digest(job + '/' + signature)` в `prepareTracker` как `requestId`. Для того же канонического содержимого получается тот же ID. Для отличающихся черновиков получаются разные ID. Старую квитанцию использовать при подтверждённом совпадении владельца, цели и сохранённого содержимого. После подтверждённой записи возобновлять незавершённую часть поручения, сохраняя её квитанцию.
- [ ] Запустить `node --test --test-force-exit tests/chat-watch-tool.test.mjs tests/chat-grounding.test.mjs` и `node --test --test-name-pattern="two distinct issue drafts" tests/workspace-draft-receipts.test.mjs`. Проверить одну ревизию наблюдения и одну квитанцию для повторённого вызова, включая прямой `watch`.
- [ ] Зафиксировать изменения задачи в коммите `fix: commit chat actions with durable receipts`.

### Задача 5 — итог по запрошенным результатам

**Файлы** `server/workspace-agent.mjs:447`, `server/workbench.mjs:1053`. Тест `tests/workspace-draft-receipts.test.mjs`. Использует `chatWriteRequests` и квитанции задач 3–4.

- [ ] Добавить в `tests/workspace-draft-receipts.test.mjs` тест `chat status counts requested artifacts and ignores unsupported claims` с ответами модели о сохранении плана или заметки при пустой БД и о публикации при `state:'draft'`. Ожидание для `done` — все запрошенные записи подтверждены. При одной подготовленной записи из двух ожидается `partial`. Чтение с полезным выводом без намерения писать завершается `done`.
- [ ] Запустить `node --test --test-force-exit tests/workspace-draft-receipts.test.mjs`. До правки сохранённый предпросмотр страницы получает `partial`, а часть заявлений без квитанции проходит как `done`.
- [ ] В `runAssistant` сопоставлять запрошенные операции с квитанциями по виду, цели, количеству и состоянию. Убрать Redmine-специфичную проверку «черновик» для Confluence из `completeMaterials`, используя проверенный итог чата. Статусы подтверждения учитывают существующие состояния `draft_actions` и `agent_previews`. Предпросмотр в состоянии `draft` получает текст о готовности к подтверждению, публикация требует подтверждённого состояния. Обязательный провал даёт причину, успешные результаты чтения и записи остаются видимыми.
- [ ] Запустить `node --test --test-force-exit tests/workspace-draft-receipts.test.mjs tests/chat-watch-tool.test.mjs tests/chat-grounding.test.mjs`. Ожидание — оба исходно красных файла проходят, включая смешанный запрос Confluence и Redmine.
- [ ] Зафиксировать изменения задачи в коммите `fix: reconcile chat status with saved outcomes`.

## II. Завершение ответов и выводов

### Задача 6 — лимиты и повторы по причине сбоя

**Файлы** `server/agent.mjs:65`, `server/workspace-agent.mjs:395`, `server/workbench.mjs:510` и `:1165`, `server/case-investigations.mjs:491`, `server/investigation-stages.mjs:81`. Действующие короткие вызовы в `server/chat-brief.mjs`, `server/archive-search.mjs`, `server/source-chat.mjs`, `server/web-search.mjs`. Тесты `tests/v1.test.mjs`, `tests/check-model.test.mjs`, `tests/anymodel-time-budgets.test.mjs`, `tests/investigation-queue.test.mjs`, `tests/anymodel-nonworkspace.test.mjs`.

**Интерфейс** `providerCall(..., {maxTokens, timeout, signal})` ограничивает явно заданный `maxTokens` потолком Qwen. Пропущенный `maxTokens` даёт прежний потолок для 27B. `jobs.result.retryAt` при временном запрете повтора хранит время в миллисекундах Unix, очередь ролей пользуется существующим `next`.

- [ ] В существующем тесте `AnyModel uses its own key, endpoint and model limits across tool calls` проверить `max_tokens === 65_536` без явного значения и `max_tokens === 56` при явном `maxTokens:56` с подменённой моделью. В `anymodel-time-budgets.test.mjs` добавить `chat compacts after an interrupted body and respects retry-after`. Имитировать обрыв тела, явный `context_length_exceeded`, 429 с `Retry-After:120` и 402. Проверить отличающийся сокращённый повтор, те же ссылки и квитанции, `retryAt`, отсутствие раннего повторного вызова и неизменный общий дедлайн. В `investigation-queue.test.mjs` закрепить `next >= retryAt` и понятный отказ при 402.
- [ ] Запустить `node --test --test-force-exit tests/v1.test.mjs tests/anymodel-time-budgets.test.mjs tests/investigation-queue.test.mjs`. Ожидание до правки — старый максимум в явном запросе, одинаковое тело при обрыве или игнорирование `Retry-After`.
- [ ] Применить `min(maxTokens, 65_536)` для явно заданного лимита 27B. В существующих коротких синтезах и сокращённом повторе чата с прежним лимитом 160 оставлять `maxTokens` для 27B пустым до измерений. После обрыва тела, лимита контекста или генерации пробовать один сокращённый вывод. Хранить те же пары вызовов и результатов, убирать дублирующее изложение и дальнюю историю, передавать необходимые факты. Незавершённые допустимые действия возобновлять из состояния задачи 4. При повторном сбое отдавать сохранённые факты и причину. При 429 с `retryAt` освобождать слот, показывать оставшееся время в сообщении и вычислять `canResume` при каждом чтении беседы. `resumeJob` использует тот же срок. Роли сохраняют `next`, пользовательская настройка автоматических повторов действует. При постоянном отказе показывать причину и ждать восстановления доступа.
- [ ] Запустить `node --test --test-force-exit tests/v1.test.mjs tests/check-model.test.mjs tests/anymodel-time-budgets.test.mjs tests/investigation-queue.test.mjs tests/anymodel-nonworkspace.test.mjs`. Ожидание — тесты общего бюджета и видимых причин проходят.
- [ ] Зафиксировать изменения задачи в коммите `fix: retry model failures within measured budgets`.

### Задача 7 — короткие вызовы в ролях разбора

**Файлы** `server/investigation-engine.mjs:437` и `:521`, `server/case-investigations.mjs:491`, `scripts/acceptance/cases-nonworkspace.mjs`, `scripts/acceptance/runner.mjs`. Тесты `tests/investigation-engine.test.mjs`, `tests/investigation-queue.test.mjs`, `tests/anymodel-time-budgets.test.mjs`, `tests/anymodel-nonworkspace.test.mjs`, `tests/acceptance-harness.test.mjs`.

**Интерфейс** `runInvestigationStage({env, send, stage, run, capture, prior, now, leaseDeadline, signal})` возвращает существующие `check`, `result`, `usage`. Разделение финала применяется для AnyModel Qwen3.8 27B. Ведущий и рецензент завершают фазу чтения `submit_check`. Затем `submit_assessment` принимает `summary` и `hypotheses` из `decision`, `submit_plan` принимает `action`, `plan`, `outcomes`, `issueSourceKey`, `issueQuery`, а `submit_verification` принимает существующую схему `verification` при замечании об учёте.

- [ ] Добавить `Qwen lead and reviewer assemble validated parts from inspected evidence`. Сценарий возвращает `read_findings`, при необходимости `search_findings`, затем `submit_check` и части. Проверить `tools.length === 1` на запросах финализации, сохранение `question` до 300, `result` до 1200 и `impact` до 700 символов, и `sourceRefs` с исходными ID. Добавить `Qwen failure in verification keeps the frozen snapshot for retry`. Имитировать незавершённую последнюю часть, проверить `status === 'retry'`, отсутствие итога, прежний `calcId` и сохранность других ролей. Повтор под тем же пользователем заканчивается `ready`.
- [ ] Запустить `node --test --test-name-pattern="Qwen lead and reviewer|Qwen failure in verification" tests/investigation-engine.test.mjs tests/investigation-queue.test.mjs`. Ожидание до правки — финал запрашивается единственным `submit_decision` или `submit_review`.
- [ ] Использовать существующий разрешённый каталог и до 5 вызовов на чтение и `submit_check`. Дать ведущему и рецензенту краткие результаты предыдущих ролей со ссылками. После принятой проверки сформировать 2 обязательные части и при необходимости парную проверку. Каждый вызов формирования получает только одну схему, нужные факты снимка, краткие предыдущие выводы и начальный `maxTokens:8192` до измерений задачи 13. Допустить одну коррекцию ошибочной части, всего до 9 вызовов в пределах общего дедлайна и срока владения попыткой. Временные части держать в памяти. Принять итог через `validatedResult` после проверки всех ссылок и обязательных полей. Для прочих моделей сохраняется текущий формат запроса, обрыв и исчерпание генерации во всех ролях обрабатываются по задаче 1.
- [ ] Обновить сценарии `investigation-lead`, `investigation-review`, `investigation-roles`, `investigation-alternative-roles`, `investigation-measurement-lead`. В проверке принудительных инструментов учесть нужные части для конкретного режима. Проверки свободного выбора источников, недоступных инструментов и полноты итогов продолжают работать.
- [ ] Запустить `node --test --test-force-exit tests/investigation-engine.test.mjs tests/investigation-queue.test.mjs tests/anymodel-time-budgets.test.mjs tests/anymodel-nonworkspace.test.mjs tests/acceptance-harness.test.mjs`. Ожидание — штатный `ready` после всех частей и корректное состояние `retry` на имитации сбоя.
- [ ] Зафиксировать изменения задачи в коммите `fix: assemble investigation results from short validated calls`.

### Задача 8 — ответы по источникам и короткие ответы

**Файлы** `server/source-chat.mjs:38`, `server/web-search.mjs:101`, `server/chat-brief.mjs:47`, `server/archive-search.mjs:309`. Тесты `tests/anymodel-nonworkspace.test.mjs`, `tests/web-search.test.mjs`, `tests/chat-grounding.test.mjs`.

- [ ] Добавить `source synthesis saves partial results and accepts one fenced verdict`. У обычного JSON и содержимого одного блока с тем же JSON совпадают вывод и цитата. При модели HTTP 503 или `length` проверить `outcome === 'partial'`, источники и возможность повтора для пользователя. Для короткого полноценного `stop` проверить, что заключительное предложение с `?»` сохранилось. Добавить `archive preserves dates tied to the correct release`. На источниках `TEST-31` от `2026-03-04` и `TEST-42` от `2026-05-12` ответ с `TEST-31` от `2026-05-04` не проходит как готовый.
- [ ] Запустить `node --test --test-name-pattern="source synthesis saves|archive preserves dates" tests/anymodel-nonworkspace.test.mjs tests/web-search.test.mjs tests/chat-grounding.test.mjs`. Ожидание до правки — потеря корректного JSON, неверный `done` или пропуск ошибочной даты.
- [ ] Для принятия вывода использовать признаки завершения задачи 1. Для публичной страницы принять один голый JSON-объект либо один обрамлённый блок и применить прежние проверки поля `verdict` и дословной цитаты. При провале запрошенного синтеза отдать `partial` со ссылками. Чтение источника по прямому запросу может завершаться `done` по серверным данным. Сохранять весь текст `stop` в короткой реплике. Для архивных дат, идентификаторов и измерений строить точный ответ по строкам или проверять сочетания по одному источнику.
- [ ] Запустить `node --test --test-force-exit tests/anymodel-nonworkspace.test.mjs tests/web-search.test.mjs tests/chat-grounding.test.mjs`. Ожидание — форматы и точность проходят, локальные запросы сохраняют возможность ответа по имеющимся данным.
- [ ] Зафиксировать изменения задачи в коммите `fix: preserve sourced answers and reject incomplete synthesis`.

### Задача 9 — готовый ответ в журнале релизов

**Файлы** `server/agent.mjs:95` и `:151`, `server/http.mjs:12`, `server/team-http.mjs:690`, `scripts/acceptance/cases-nonworkspace.mjs`. Тесты `tests/v1.test.mjs`, `tests/anymodel-nonworkspace.test.mjs`.

**Интерфейс** `makeAgent(store, options)` возвращает прежние `ask`, `initial`, а также `waitForReviews()` для проверки и `closeReviews()` для остановки фонового обзора при закрытии приложения. Оба метода возвращают `Promise<void>`.

- [ ] Добавить `release chat saves its answer while optional review is pending`. Подвесить `record_findings` через управляемый Promise. После входа в обзор дождаться одного оборота цикла и проверить, что `ask` вернул ответ, а в `messages` записана пара вопрос–ответ. Второй вопрос к тому же релизу тоже получает ответ. Разрешить Promise в `finally`, чтобы проверка завершалась на исходном коде. Добавить `release metadata completes without an unrelated calculation` для успешного `get_release` и контрольного вопроса о метрике, где расчёт по-прежнему нужен.
- [ ] Запустить `node --test --test-name-pattern="release chat saves|release metadata completes" tests/v1.test.mjs`. До правки первый ответ ждёт `record_findings`, а ответ по метаданным отклоняется без `calc`.
- [ ] В `apiTurn` учитывать успешное чтение `get_release` при ответе о метаданных. Для выводов по метрикам проверять расчёт. Отклонять обрезанный итог, сохраняя подтверждённые расчёты. В `makeAgent.ask` фиксировать чат прежде отдельного обзора. Привязать фоновый обзор к версии релиза, сохранив идемпотентность `report_versions` и обработку отказа. `closeReviews()` отменяет активные обзоры и дожидается выхода фоновой работы через сигнал задачи 1. Подключить это к закрытию `createTeamApp` до закрытия SQLite. В живой фикстуре дождаться `waitForReviews()` перед проверкой обзора и закрытием SQLite.
- [ ] Запустить `node --test --test-force-exit tests/v1.test.mjs tests/anymodel-nonworkspace.test.mjs`. Ожидание — ответы на метаданные и метрики проходят, обзор остаётся доступен после ответа. В приёмочных сценариях проверка `record_findings` ждёт обзор отдельно от сообщения.
- [ ] Зафиксировать изменения задачи в коммите `fix: return release chat before optional review`.

## III. Очереди и сквозная приёмка

### Задача 10 — ожидание и выполнение в чатах

**Файлы** `server/workbench.mjs:1195`, `server/team-http.mjs:215`, `web/team.tsx:495` и `:814`. Тесты `tests/team.test.mjs`, `tests/workspace.browser.mjs`.

- [ ] Добавить `a slow conversation leaves another conversation free`. Заблокировать ответ первого чата управляемым Promise, поставить второе сообщение в тот же чат и запрос в другую беседу. Проверить, что вторая беседа получает ответ, второе сообщение первого чата остаётся `queued`, а одновременно стартуют не более двух заданий на пространство. Добавить проверку UI текста «В очереди» для `queued` и «Помощник отвечает» для `running`.
- [ ] Запустить `node --test --test-name-pattern="a slow conversation" tests/team.test.mjs`. До правки запрос второй беседы ждёт первый.
- [ ] В `workJobs` выбирать и помечать `running` только допустимую задачу из ожидающих, сохраняя FIFO внутри беседы. В `team-http` держать до двух активных заданий на пространство. Для заданий с явной записью использовать один активный исполнитель записи на пространство, опираясь на `chatWriteRequests`. Чтение получает доступный слот. Интерфейс использует существующий `jobs[].status` из `messages`, сохраняя шаги выполнения и возможность повтора.
- [ ] Запустить `node --test --test-force-exit tests/team.test.mjs` и `pnpm build`, затем `node --test --test-name-pattern="queued conversation" tests/workspace.browser.mjs` для добавленного сценария отображения. Ожидание — FIFO беседы, ограниченная параллельность и правильные подписи.
- [ ] Зафиксировать изменения задачи в коммите `fix: schedule chat work by conversation`.

### Задача 11 — отмена устаревшей роли

**Файлы** `server/investigation-scheduler.mjs:8`, `server/case-investigations.mjs:491` и `:528`, `server/investigation-engine.mjs:521`. Тесты `tests/investigation-scheduler.test.mjs`, `tests/investigation-queue.test.mjs`.

**Интерфейс** `tryStartInvestigation(store, work, env, send, options)` принимает `options.signal` и `options.onRoleClaim({runId, role, lease, leaseUntil})`. `onRoleClaim` вызывается после фиксации аренды. Сигнал передаётся в `runInvestigationStage` задачи 7.

- [ ] Добавить `superseded role aborts and releases its scheduler slot`. При лимите 1 блокировать вызов старой роли до `signal.abort`, создать новую ревизию и проверить, что `aborted === true`, новый запуск получил слот, а результат старой роли не заменил актуальный. Повторить с истёкшей арендой.
- [ ] Запустить `node --test --test-name-pattern="superseded role aborts" tests/investigation-scheduler.test.mjs`. Ожидание до правки — старая роль удерживает слот.
- [ ] Привязать `AbortController` к конкретной аренде роли при `tryStartInvestigation`. Диспетчер сверяет принадлежность аренды и срок при пробуждении, передаёт `signal` от попытки до `providerCall`, освобождает слот при завершении отменённой попытки. При закрытии отменить активные сетевые вызовы. Сохранить проверку текущей ревизии и аренды перед фиксацией результата.
- [ ] Запустить `node --test --test-force-exit tests/investigation-scheduler.test.mjs tests/investigation-queue.test.mjs tests/anymodel-time-budgets.test.mjs`. Ожидание — новая роль стартует, старый результат игнорируется, очередь других разборов работает.
- [ ] Зафиксировать изменения задачи в коммите `fix: cancel stale investigation requests`.

### Задача 12 — необрабатываемое сообщение Telegram

**Файлы** `server/team-http.mjs:147` и `:175`, `server/workbench.mjs:360`. Тест `tests/telegram-polling.test.mjs`.

**Интерфейс** `chatQuestion(value)` в `server/workbench.mjs` возвращает очищенный текст и применяет текущее правило длины от 1 до 2400 символов. `enqueue` и обработка Telegram используют одну функцию.

- [ ] Добавить `Telegram advances past invalid input and retries storage failures`. В пачке из сообщения на 2401 символ и валидного вопроса проверить `offset === lastUpdateId + 1` и одну постановку валидного вопроса. На отдельном отказе хранилища проверить сохранение offset и один успешный повтор.
- [ ] Запустить `node --test --test-name-pattern="advances past invalid input" tests/telegram-polling.test.mjs`. До правки обработка останавливается на первом обновлении.
- [ ] Применять обычную проверку текста к каждому обновлению. Принятые и окончательно отклонённые обновления помечать обработанными и продвигать offset. При сбое хранения сохранять точку повтора. `requestId` привязан к `update_id`, поэтому повтор сохраняет одно поручение.
- [ ] Запустить `node --test --test-force-exit tests/telegram-polling.test.mjs`. Ожидание — старый тест восстановления offset и новый тест проходят.
- [ ] Зафиксировать изменения задачи в коммите `fix: keep Telegram polling past invalid questions`.

### Задача 13 — приёмка всего изменения

**Файлы** `scripts/acceptance/cases-workspace.mjs`, `scripts/acceptance/cases-nonworkspace.mjs`, `tests/acceptance-harness.test.mjs`. Использовать существующие фикстуры и `pnpm agent:eval`.

- [ ] Добавить `workspace-private-case-report` с тремя формулировками запроса вывода по выделенному графику. Проверка требует текст и доступные ссылки, использует правильную карточку и убеждается, что заметки и другие записи не созданы. Дополнить покрытие подтверждённой заметки с повтором, двух черновиков и полного разбора с ограничением учёта.
- [ ] Выполнить `pnpm build`, `pnpm test` и `pnpm test:ui`. Ожидание — регрессии задач 1–12 проходят. Сверить остальные ошибки и пропуски с исходной копией и указать их отдельно, если они есть.
- [ ] Проверить `pnpm model:check` и выполнить живую приёмку через штатный AnyModel на синтетических данных. Для частей ролей начать с потолков **4 096**, **8 192** и **12 288** токенов в целевых пробах, оставив общий дедлайн. Закрепить для каждого назначения минимальный проверенный потолок, при котором ответ завершён и проходит схему. Подтвердить выбор после изменения бюджетов повтором тех же сценариев. В отчёт записать завершённые части, время каждого вызова, `finish_reason` и выходные токены. Ответ с обрывом и ответ из одних рассуждений требуют исправления причины и повторной проверки.

```powershell
pnpm agent:eval --suite=first-pass --case=workspace-private-case-report --out=var/acceptance/anymodel-reliability
pnpm agent:eval --suite=first-pass --case=investigation-lead --out=var/acceptance/anymodel-reliability
pnpm agent:eval --suite=first-pass --case=investigation-roles --out=var/acceptance/anymodel-reliability
pnpm agent:eval --suite=first-pass --case=investigation-review --out=var/acceptance/anymodel-reliability
pnpm agent:eval --suite=first-pass --case=investigation-alternative-roles --out=var/acceptance/anymodel-reliability
pnpm agent:eval --suite=first-pass --case=investigation-measurement-lead --out=var/acceptance/anymodel-reliability
pnpm agent:eval --suite=first-pass --case=source-public-page --out=var/acceptance/anymodel-reliability
pnpm agent:eval --suite=first-pass --case=release-description --out=var/acceptance/anymodel-reliability
```

- [ ] Проверить пользовательский результат в итоговых квитанциях. Личный чат возвращает вывод, режим `roles` сохраняет четыре проверки и итог, рецензент ссылается на самостоятельно прочитанные источники. При частичном результате доступны исходное выделение и продолжение поручения. Отдельно сверить отсутствие неожиданных записей и дублей.
- [ ] Зафиксировать изменения приёмки и проверенные бюджеты в коммите `test: exercise chat and investigation recovery on AnyModel`.
