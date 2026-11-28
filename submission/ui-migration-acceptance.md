# Приёмка нового UI с профилями

Проверен коммит `13a676ca0ee9c51480a1d3691ef7b704f79c64be` ветки `codex/full-ui-profile-migration`. В основу вошли локальный `main@d90bf9f`, UI с профилями `2f7a3c0` и функции интеграционной ветки `e662119`.

Код каждой из 17 задач плана прошёл отдельное ревью. При сведении проверок трёх доноров сохранены все 187 имён тестов локального main и 175 имён UI-ветки. Для интеграционной ветки 106 из 119 имён совпадают, остальные 13 сопоставлены с тестами-преемниками. Число имён включает вложенные сценарии и отличается от числа исполненных проверок.

## Общий результат

| Набор | Фактический результат |
|---|---|
| Node.js, включая обновление SQLite | 266 прошли, 0 ошибок, 2 пропуска. |
| Браузерные тесты | 43 прошли, 0 ошибок, 0 пропусков. |
| Python Signal Bridge | 17 проверок прошли с тестовыми провайдерами. |
| Визуальная приёмка | 42 снимка на 390, 900 и 1440 px, светлая и тёмная темы. Проверены границы страницы и кнопки отправки в панели разбора. |
| Локальный пилот | Две роли, одна задача Redmine и одно письмо Mailpit; восстановленный CTR 6%, ошибок страницы 0. |
| Production-экспорт | Одна версия из образа без dev-зависимостей открыта в PowerPoint и PDF. Проверены редактируемость, кириллица, исходные ссылки и права на скачивание. |
| Восстановление | Три базы в согласованной резервной копии. После возврата к прежнему коду и снимку открылись расчёт и вложенный график. Подтверждённая тестовая доставка сохранила одну попытку. |

Пилот и production-образ проверены на коммите `515e92534790655d8acb7a9bcc80706f89e9487f`. До ревизии приёмки изменялся только тестовый код. Совпадение исходников приложения проверено через Git.

На ширине 900 px в узкой панели разбора вторая строка подсказки пустого поля ввода может быть видна частично. Само поле и кнопка отправки доступны. Это замечание визуального ревью не блокировало приёмку.

Оба условных теста на оригинальном ZIP организатора требуют исходный архив. Его не было в доступной тестовой поставке. Все 24 сценария ниже проверены на синтетических данных, включая исторические решения, Excel, Redmine, привязку контактов и экспорт. Реальные внешние Telegram и Метрика в испытаниях не использовались.

## Приёмка по 24 пунктам

| № | Сценарий | Подтверждённый результат | Проверка |
|---:|---|---|---|
| 1 | **Группы переписок** | Переименованная беседа сохранила связь с разбором; поиск нашёл её в нужной группе. | [chat groups keep team conversations personal and case discussions searchable](../tests/workspace.browser.mjs) |
| 2 | **Закрепление графиков и отчётов** | График прикладывается к сообщению в обычном чате. Закрепление и снятие относятся к текущему разбору. | [profile photo, renamed case chat and ordinary chart attachments work together](../tests/ui-migration-core.browser.mjs) |
| 3 | **Этапы и повтор расследования** | При сбое двух ролей причины остаются раздельными. Повтор и рестарт сохраняют завершённые этапы и исходный расчёт. | [two failed roles retain separate reasons, deadlines and permissions](../tests/investigation-queue.test.mjs) |
| 4 | **Одновременные проверки** | Пять разборов запускают десять ролей. Лимит меняет администратор, очередь обслуживает разные пространства. | [five cases start ten blocked roles without page reads](../tests/investigation-scheduler.test.mjs) |
| 5 | **Две недели ниже порога** | Карточка открывает обе строки источника и показывает период, для которого ещё нет истории. | [May threshold card shows the observed weeks and opens their saved source rows](../tests/threshold-observation.browser.mjs) |
| 6 | **Профиль в обсуждении CSV** | У подтверждённых собственных сообщений появляется фото. Одноимённый коллега и старая реплика сохраняют историческую подпись. | [CSV release discussion shows the profile photo on confirmed own messages](../tests/workspace.browser.mjs) |
| 7 | **Приглашение в открытой вкладке** | Смена ссылки переключает экран на регистрацию и подставляет актуальный код; проверен вход жюри. | [an invitation opens registration in an existing signed-out tab and updates its code](../tests/workspace.browser.mjs) |
| 8 | **Самостоятельный разбор** | После оценки релиза следующая форма из списка открывается с пустым полем релиза. | [a new case started from the case list does not inherit a previous release](../tests/workspace.browser.mjs) |
| 9 | **Первичные строки CTR и охвата** | Дата, числитель и знаменатель согласованы с выбранной ячейкой; повторный импорт сохраняет прежнюю ссылку снимка. | [ratio evidence points to the selected workbook revision](../tests/workspace.browser.mjs) |
| 10 | **Источники сигнала** | Сохранённая карточка CTR раскрывает собственные наблюдения и периоды. Проверен переход старого живого сигнала на новую версию. | [saved signal cites its own metric](../tests/workspace.browser.mjs) |
| 11 | **Личный вид разбора** | Контроль, полные недели, фильтр и закрепления переживают обновление, смену разбора и запоздалый ответ; другой аккаунт получает свой вид. | [personal investigation cards, filters and control survive reload, navigation and account changes](../tests/workspace.browser.mjs) |
| 12 | **Действия активного чата** | После поиска и сворачивания списка доступны разрешённые действия; длинный заголовок читается, клавиатурный фокус возвращается к беседе. | [active chat actions survive collapse and filtering](../tests/workspace.browser.mjs) |
| 13 | **Автономный показ** | Оба релиза, их фильтры и обсуждения работают без командного API. Кнопки браузера восстанавливают выбранный релиз. | [standalone demo preserves release selection, filters, themes and discussion](../tests/workspace.browser.mjs) |
| 14 | **Подтверждённые контакты** | Почта подтверждается отдельным кодом, Telegram — личной привязкой. Участники видят и отключают собственные каналы. | [verified notification contacts are personal and independently removable](../tests/workspace.browser.mjs) |
| 15 | **Доставка владельцу** | Проверены ожидание контакта, смена адреса, сохранение назначенного получателя после рестарта, исправления и отзыв сигнала. | [owner-targeted deliveries wait, recheck changed contacts, and do not use shared addresses](../tests/notifications.test.mjs) |
| 16 | **Закрытие и повторное закрытие Redmine** | Подтверждённая задача сохраняет исходный отчёт, номер и отдельные эпизоды закрытия; повторы используют квитанцию. | [Bridge keeps the draft report across confirmation, restart and two closure episodes](../tests/tracking.test.mjs) |
| 17 | **База знаний** | Из результата открыт отчёт, опубликована версия с Excel и обратной ссылкой. Второй аккаунт не видит личные материалы. | [Signal Bridge publishes a closed result with versioned Excel and hides it from a second account](../tests/workspace.browser.mjs) |
| 18 | **Решение по релизу** | Проверены семейства и ЛК, календарный срез, полные ссылки на исходные строки, поиск связанных задач и подтверждение записи. | [release decision validates dates and rejects private cases before loading source facts](../tests/release-decision.test.mjs) |
| 19 | **План до выкладки** | План ожидает подтверждённую дату. Предпросмотр сохраняет запись без изменений. Проверены оба формата version 2, неполные окна и контроль. | [both saved version 2 formats and the legacy target survive a restart and read-only preview](../tests/effect-plan.test.mjs) |
| 20 | **Презентация разбора** | Создание из чата и карточки, сохранённая версия, ограничения скачивания, предпросмотр, PPTX и PDF. Новые и старые ссылки проверены после рестарта. | [an upgraded donor workspace preserves UUID links and reports a lost original snapshot](../tests/presentations.test.mjs) |
| 21 | **Архивный чат** | Для недели 06.04.2026 расчёт дал 33 и 21, разницу 12 и ссылки; продолжение сохранило контекст и исходную версию. | [weekly comparisons and subsequent questions resolve the named products and the same week](../tests/chat-grounding.test.mjs) |
| 22 | **Архив и диагностика Метрики** | Администратор проверяет Reports API на тестовом транспорте без импорта. Создание разбора ограничено допустимыми семействами. | [archive settings diagnose Reports API and sources show the protected ZIP inventory](../tests/workspace.browser.mjs) |
| 23 | **Список документов** | Первая версия и её происхождение видны; справочные файлы отделены от индексированных. Повторный импорт не создаёт ложного дубля старого справочника. | [archive settings diagnose Reports API and sources show the protected ZIP inventory](../tests/workspace.browser.mjs) |
| 24 | **Сигнал по корзине** | Проверены полные семидневные окна, граница 20%, минимум 20 визитов, отдельные эпизоды, защита от дублей и ручная сверка неопределённой отправки. | [test_signal_requires_volume_and_notifies_once](../integrations/signal-bridge/verify.py) |

## Проверка данных и прав

Независимые копии трёх доноров запущены дважды. До старта проверялось наличие каждой базы, включая SQLite жюри. После рестарта проверялись сессии, авторство, права на личные материалы, контрольные числовые значения, фиксированные версии документов и ранее выданные идентификаторы. Проверки целостности SQLite и внешних ключей прошли.

Браузером открыты ранее поддерживаемые адреса с `?openChat=`, `?legacy=1`, расчёт, диапазон, снимок, материал и ячейка книги. Пилот прошёл через настоящий локальный Redmine и Mailpit в отдельном Compose-проекте. Для подтверждения UI режимы и роли переключались на тестовых аккаунтах администратора, участника и жюри.

## Воспроизведение

1. Установить зависимости командой `pnpm install --frozen-lockfile` и выполнить `pnpm build`.
2. Запустить `node scripts/ui-migration-fixtures.mjs --local <checkout> --ui <checkout> --integration <checkout> --out <empty-directory>`. Передать пути к рабочим копиям трёх исходных ревизий и пустому каталогу для результата. Задать абсолютный путь к результату в `PM_MIGRATION_FIXTURES`.
3. Выполнить `node --test --test-concurrency=1 "tests/*.test.mjs"` и `node --test --test-concurrency=1 "tests/*.browser.mjs"`. На Windows при необходимости задать `PYTHON_BIN` и `PM_BROWSER_PATH`.
4. Выполнить `python integrations/signal-bridge/verify.py -v`; прогнать обе [проверки пилота](pilot.md) на изолированном стенде. Для исходного ZIP задать `SIGNAL_RELEASE_ARCHIVE` и `SIGNAL_RELEASE_BROWSER=1`.
