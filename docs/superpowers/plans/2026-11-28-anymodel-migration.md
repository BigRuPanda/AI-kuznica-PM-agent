# План миграции ProxyAPI → AnyModel

> Для реализации по задачам использовать `superpowers:executing-plans` или `superpowers:subagent-driven-development`.

**Цель.** Перевести серверные вызовы ProxyAPI на Qwen3.8 27B через AnyModel. Для отката вернуть предыдущую версию приложения и её настройки.

**Архитектура.** Добавить `LLM_BACKEND=anymodel` в общий адаптер чата и расследований. Использовать действующий транспорт на `fetch`, `POST https://anymodel.org/v1/chat/completions` и `Authorization: Bearer` из `ANYMODEL_API_KEY`. Передавать ID `qwen/qwen3.8-27b`. [Карточка модели](https://anymodel.org/ru/models/qwen3-8-27b) · [Инструкция AnyModel API](https://anymodel.org/en/skills/anymodel/anymodel-api)

## 1. Серверный адаптер

- [ ] Обновить регрессии в `tests/v1.test.mjs` и `tests/presentations.test.mjs`. Проверить пустой ключ или модель, ошибку миграции для `LLM_BACKEND=proxyapi`, независимость запроса AnyModel от `LLM_BASE_URL` и `LLM_API_KEY`, отсутствие запросов при `DATA_PROFILE=local` и шаблон для приватной презентации. В двухходовом тесте проверить точный URL, тестовый Bearer-ключ, `tool_call_id`, ответ `37` и `usage`.
- [ ] Запустить `node --test --test-name-pattern="AnyModel|stale ProxyAPI" tests/v1.test.mjs tests/presentations.test.mjs` до реализации и подтвердить, что тест нового транспорта выявляет неверный выбор провайдера.
- [ ] В `server/agent.mjs` заменить ветку ProxyAPI на AnyModel. Требовать `ANYMODEL_API_KEY` и `LLM_MODEL`, фиксировать адрес и переиспользовать обработку инструментов, лимитов, тайм-аутов и `usage`. Для `proxyapi` возвращать подсказку с `LLM_BACKEND=anymodel` до выбора общего API. Сохранить защиту приватного снимка презентации.
- [ ] Повторить целевые тесты, выполнить `pnpm test` и зафиксировать адаптер и регрессии отдельным коммитом.

## 2. Настройки и приёмка

- [ ] В `.env.example` задать новый backend и модель, пустой `ANYMODEL_API_KEY` и стартовый `DATA_PROFILE=local`. Переназначить `pnpm model:key` на `set-anymodel-key.mjs` с сохранением скрытого ввода и атомарной записи. Дважды ввести фиктивный ключ в тестовой копии проекта и проверить одну строку `ANYMODEL_API_KEY` и отсутствие ключа в выводе.
- [ ] Перенести `scripts/check-synthetic-ctr.mjs` на URL и ID модели AnyModel. В `scripts/check-model.mjs` для настроенного AnyModel проверить каталог `GET /v1/models`, вызов с `tool_choice: "required"` и цепочку «именованный вызов → результат инструмента → `auto`». Добавить короткий запрос без инструментов с `max_tokens: 56` и `temperature: 0`, ожидающий JSON `{"value":37}`.
- [ ] Обновить README и инструкции приёмки в `submission`. Выполнить `pnpm build` и `node scripts/check-synthetic-ctr.mjs`. Локальный сценарий должен показать CTR 6% → 1%, −5 п. п. и `calls: 0`. Зафиксировать настройки, скрипты и документацию отдельным коммитом.

## 3. Переключение и откат

- [ ] На тестовом экземпляре задать `DATA_PROFILE=configured`, `LLM_BACKEND=anymodel`, `LLM_MODEL=qwen/qwen3.8-27b` и `LLM_DATA_MODE=analysis`. Ввести ключ через `pnpm model:key` или серверное хранилище секретов. Ключ из переписки рекомендуется перевыпустить перед развёртыванием.
- [ ] Выполнить `pnpm model:check` и `node scripts/check-synthetic-ctr.mjs --live`. Критерии допуска — валидные вызовы инструментов, CTR 6% → 1% с оговоркой о причине, один черновик, ноль созданных задач и ненулевой учёт токенов. При провале оставить текущую версию развёрнутой.
- [ ] Сохранить предыдущую ревизию, конфигурацию и резервную копию SQLite. Обновить активный `.env`, убрав `PROXYAPI_API_KEY`. Локально перезапустить приложение. На VPS выполнить `docker compose up -d --build app`, проверить `/health` и запустить `docker compose exec -T app node scripts/check-model.mjs`. Сверить ошибки провайдера, задержку и токены первых запросов.
- [ ] При сбое после переключения вернуть предыдущую ревизию и её конфигурацию, перезапустить приложение с тем же томом данных и повторить `/health` и проверку модели.
