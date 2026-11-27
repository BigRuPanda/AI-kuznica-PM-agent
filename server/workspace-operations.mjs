import { excelSources, sourceRows, sourceValues, cellSource, issuePages, issueClosure, pagesByIssue } from './knowledge.mjs';
import { readPublicPage } from './public-page.mjs';
import { marketOffers } from './market-offers.mjs';
import { decisionDraft, releaseDecision } from './release-decision.mjs';
import { checkOffer, savedOfferCheck } from './competitor-check.mjs';
import { randomUUID } from 'node:crypto';
import { signalHistory } from './signal-history.mjs';
import { protectedProducts } from './source-policy.mjs';
import { readInvestigations, requireActionableRun, syncInvestigations } from './case-investigations.mjs';
import { z } from 'zod/v4';
import {
  analysisView,
  cases,
  effect,
  createMeasurementAgreement,
  createMeasurementWatch,
  search,
  caseEvidenceSearch,
  facts,
  updateCase,
  setting,
  defaultRules,
  digest,
  fmt,
} from './evidence.mjs';
import { visibleCase, dashboard, thread, cardTypes, addUserMessage, bindReleaseThreadCase } from './workbench.mjs';
import { access, grant, readSnapshot, readRange, compareRanges, neighboring } from './chart-ranges.mjs';
import { targetFor } from './tracker-connections.mjs';
import { trackerClient, prepareTracker, confirmTracker, preview, publicPage, caseLinks } from './tracker-workflow.mjs';
import { runTool } from './analytics.mjs';
import { prepareResearch, researchContext } from './agent-research.mjs';
import { saveMaterial } from './materials.mjs';
import { aggregateMetric, describeMetricSeries, observationWithin } from './metric-observations.mjs';
import { measurementSpec, measuredSignal, legacyOrderMetric, startMeasurementWatch, watchKind } from './watch-measurement.mjs';
import { makeObservationPlan, observationOptions, observedEffect, validateEffectCutoff } from './effect-plan.mjs';

const text = z.string().min(1).max(2400),
  id = z.string().min(1).max(150),
  optional = z.string().max(400).optional();
const ref = z.object({
  source: z.enum(['weekly', 'release', 'metric']),
  calcId: id,
  metric: id,
  version: optional,
  series: z.array(id).min(1).max(12),
  ranges: z
    .array(z.object({ from: z.number().int(), to: z.number().int() }))
    .min(1)
    .max(2),
});
const caseInput = { caseId: id };
const signalIssueInput = z.strictObject({ ...caseInput, revision: z.number().int().nonnegative().optional() });
const metricSeriesInput = z.object({ product: id, segment: id, sourceId: id, definitionId: id });
const viewInput = {
  caseId: id.optional(),
  product: optional,
  control: z.union([z.string(), z.literal(false)]).optional(),
  full: z.boolean().optional(),
  sourceQuery: optional,
  from: optional,
  through: optional,
  releaseWeek: optional,
  ratioSelections: z.object({ ctr: metricSeriesInput.optional(), reach: metricSeriesInput.optional() }).optional(),
};
const measurement = z.object({
  metric: z.enum(['orders_index', 'lk_reco_ctr', 'cfg_completion_rate', 'cfg_reach_rate']),
  product: optional,
  segment: optional,
  sourceId: optional,
  definitionId: optional,
  control: optional,
  controlSegment: optional,
  controlSourceId: optional,
  controlDefinitionId: optional,
  baselineFrom: optional,
  baselineThrough: optional,
  comparison: z.enum(['gte', 'lte']),
  targetMode: z.enum(['absolute', 'baseline_percent']),
  targetValue: z.number().finite().nonnegative(),
  minDenominator: z.number().int().positive().optional(),
});
const createInput = {
  title: text,
  product: text,
  from: z.iso.date().optional(),
  through: z.iso.date().optional(),
  release: optional,
  hypothesis: optional,
  metric: optional,
  baseline: optional,
  control: optional,
  success: optional,
  measurement: measurement.optional(),
  message: z.number().int().optional(),
};
const issueInput = {
  caseId: id,
  includeReport: z.boolean().optional(),
  title: z.string().max(240).optional(),
  description: z.string().max(4000).optional(),
  key: optional,
  priority: optional,
  priorityId: optional,
  statusId: optional,
  trackerId: optional,
  assigneeId: optional,
  comment: z.string().max(4000).optional(),
  rangeId: id.optional(),
};
const publishInput = {
  caseId: id,
  calc: id.optional(),
  rangeId: id.optional(),
  cards: z.array(z.enum(cardTypes)).optional(),
  conclusion: z.string().max(1400).optional(),
};
const watchInput = {
  caseId: id,
  deployed: z.string().optional(),
  percent: z.coerce.number().positive().max(300).optional(),
  control: optional,
  measurement: measurement.optional(),
  agreementId: id.optional(),
};
const observationInput = {
  metric: id.optional(),
  segment: optional,
  releaseId: optional,
  taskId: optional,
  baselineWeeks: z.coerce.number().int().min(1).max(12).optional(),
  observationWeeks: z.coerce.number().int().min(1).max(12).optional(),
  target: z.number().finite().nullable().optional(),
  direction: z.enum(['at-least', 'at-most']).optional(),
  condition: optional,
};
const agreementInput = z.strictObject({
  caseId: id,
  runId: id,
  expectedAgreementId: id.nullable(),
  measurement,
});
export const operations = {
  'knowledge-sources':['Список версий Excel рабочего пространства',{}],
  'knowledge-source':['Строки книги по версии и ячейке',{version:id,loc:optional,offset:z.number().int().nonnegative().optional()}],
  release_decision: ['Измерения, источники и связанные задачи по выпущенной функции. Для истории through — дата последнего доступного дня.',
    { product: optional, caseId: id.optional(), releaseId: id.optional(), through: optional }],
  'release-tracker': ['Найти связанные задачи и дубли.', { caseId: id.optional(), releaseId: id, product: optional }],
  'release-tracker-case': ['Создать личный разбор по выбранному релизу.', { releaseId: id, product: optional }],
  'release-tracker-draft': ['Подготовить задачу или комментарий по решению.',
    { caseId: id, releaseId: id, product: optional, key: id.optional() }],
  source_value:['Исходные значения метрики с точными координатами и идентификаторами ряда',{product:text,metric:id,date:z.iso.date(),segment:optional,sourceId:optional,definitionId:optional,stepDays:z.number().int().positive().optional()}],
  read_public_page:['Читать публичную HTML-страницу по URL или выбранной ячейке',{url:z.url().max(2048).optional(),version:id.optional(),loc:optional}],
  competitor_check:['Проверить предложение продавца из конкретной строки исследования',{version:id,loc:id,savedOnly:z.boolean().optional(),asOf:z.iso.datetime().optional()}],
  funnel: [
    'Рассчитать по счётчикам этапы подбора, завершение и корзину, проверить сегменты и покрытие. Используй для вопросов о пути покупки. В чате thread и rangeId подставит сервер.',
    {
      thread: id.optional(),
      caseId: id.optional(),
      product: optional,
      rangeId: id.optional(),
      calc: id.optional(),
    },
  ],
  overview: ['Найти активные сигналы, разборы и беседы команды', {}],
  metrics: ['Список доступных семейств, метрик и разрезов', {}],
  view: ['Посчитать недельный индекс и контроль, открыть разбор, проверить соседние периоды. Если у карточки CTR или охвата есть варианты, передай выбранный ряд в ratioSelections.ctr или ratioSelections.reach.', viewInput],
  calc: ['Открыть точную историческую версию недельного расчёта', { id }],
  range_compare: ['Рассчитать A и B по закреплённому графику', { selection: ref }],
  range_read: ['Открыть сохранённые интервалы и точные значения. Используй для вопроса о выделении.', { id }],
  selection_context: [
    'Проверить ближайший предыдущий период, контроль, релизы и источники по закреплённой версии. Возвращает факты вне выделения.',
    { id },
  ],
  search: [
    'Найти подтверждения и альтернативы в интервью, релизах, исследованиях, бэклоге',
    {
      query: text,
      caseId: id.optional(),
      asOf: optional,
      kinds: z.array(z.enum(['interview', 'competitor', 'backlog', 'releases', 'dictionary'])).optional(),
    },
  ],
  case_links: ['Доступные участнику задачи и страницы этого разбора', { caseId: id }],
  issue_search: ['Найти задачи в проекте Redmine, при необходимости по метке происхождения', { query: z.string().max(400), origin: z.literal('ai-generated').optional() }],
  issue_read: [
    'Прочитать задачу с комментариями и разрешёнными переходами',
    { key: id, local: z.boolean().optional() },
  ],
  issue_options: ['Приоритеты, исполнители и типы задач Redmine', {}],
  page_search: ['Найти страницы Confluence в пространстве команды', { query: z.string().max(400) }],
  page_read: ['Прочитать страницу и её версию. Для встроенной страницы используйте номер задачи Redmine (issueKey) либо её ключ (key с local: true).', {
    key: id.optional(), issueKey: id.optional(), local: z.boolean().optional(),
  }],
  page_draft: [
    'Предпросмотр изменения страницы Confluence. fragment — уникальный исходный текст для замены, иначе content добавляется в конец. issueKey связывает страницу с задачей.',
    {
      caseId: id,
      key: optional,
      title: z.string().max(255).optional(),
      content: z.string().max(30000).optional(),
      fragment: z.string().max(10000).optional(),
      issueKey: optional,
      sourceVersions: z.array(z.string().regex(/^[a-f0-9]{64}$/)).max(8).optional(),
      resultPage: id.optional(),
      pageTarget: z.enum(['local','external']).optional(),
      includeResultSources: z.boolean().optional(),
      baseVersion: z.number().int().positive().optional(),
    },
  ],
  'create-case': ['Создать личный разбор по явному поручению. Сохрани заданную цель в measurement. Для CTR ≥ 5% передай lk_reco_ctr, gte, absolute и targetValue 5.', createInput],
  append_case: [
    'Дополнить разбор выводом и ссылкой на доказательство',
    { ...caseInput, note: text, rangeId: id.optional() },
  ],
  chart: [
    'Построить график. Для агрегатов скопируй metric, product, segment, sourceId, definitionId из каталога metrics. Для недельного индекса заказов используй orders_index и семейство продукта. Параметры field и stat относятся к архивному releaseId.',
    {
      metric: optional,
      from: optional,
      through: optional,
      full: z.boolean().optional(),
      sourceId: optional,
      definitionId: optional,
      product: optional,
      segment: optional,
      releaseId: id.optional(),
      calc: id.optional(),
      day: z.number().int().optional(),
      field: z.enum(['events', 'amount', 'duration']).optional(),
      stat: z.enum(['count', 'sum', 'mean', 'median', 'p90']).optional(),
      start: optional,
      end: optional,
      title: optional,
    },
  ],
  set_view: [
    'Изменить личный вид ТОЛЬКО по явной просьбе пользователя',
    {
      ...caseInput,
      cards: z.array(z.enum(cardTypes)).min(1),
      control: optional,
      full: z.boolean().optional(),
      pin: z.boolean().optional(),
    },
  ],
  draft: [
    'Подготовить изменение или создание задачи Redmine. Для изменения передай key и изменяемые поля, ID возьми из справочников.',
    issueInput,
  ],
  prepare_publish: ['Подготовить предпросмотр публикации в команду; потребуется подтверждение', publishInput],
  feedback: [
    'Сохранить явно высказанную поправку к источнику',
    { ...caseInput, source: text, comment: text },
  ],
  watch: ['Назначить наблюдение по согласованному критерию с даты выкладки. Для нового критерия передай measurement. Для архивного плана передай metric и задачу или релиз. Число 5 для абсолютной цели CTR означает 5%.', { ...watchInput, ...observationInput }],
  'watch-options': ['Найти архивные метрики, разрезы, релизы и задачи для наблюдения за продуктом.', caseInput],
  'effect-preview': ['Прочитать результат наблюдения на указанную дату без изменения плана.', {
    ...caseInput, ...observationInput, deployed: watchInput.deployed, control: optional, asOf: optional,
  }],
  decide: [
    'Изменить статус разбора по просьбе пользователя',
    { ...caseInput, state: z.enum(['Исследуем', 'Нужно решение', 'Завершено']) },
  ],
};
export const writes = new Set([
  'create-case',
  'append_case',
  'set_view',
  'draft',
  'prepare_publish',
  'page_draft',
  'feedback',
  'watch',
  'decide',
]);
function checkPublicationCalculation(db, user, id, product) {
  const snapshot = readSnapshot(db, user, id);
  if (snapshot.kind === 'investigation-calculation')
    throw Error('Опубликуйте выбранную версию исследования из самого разбора.');
  if (snapshot.product !== product) throw Error('Расчёт другого продукта');
}

function commitPublication(store, user, key, data) {
  const db = store.db,
    c = visibleCase(db, user, data.caseId);
  if (data.calc) checkPublicationCalculation(db, user, data.calc, c.product);
  if (data.rangeId) access(db, user, data.rangeId);
  if (!db.prepare('SELECT id FROM published WHERE id=?').get(key)) {
    if (c.body.owner) syncInvestigations(db, c.id);
    delete c.body.owner;
    updateCase(db, c);
    db.prepare('INSERT INTO published VALUES(?,?,?,?,?)').run(
      key,
      c.id,
      user.name,
      JSON.stringify(data),
      Date.now(),
    );
    grant(db, data.calc, 'thread', 'group');
    grant(db, data.rangeId, 'thread', 'group');
    addUserMessage(db, user, 'group', {
      ...data,
      text: 'Опубликован разбор: ' + c.title + (data.conclusion ? '\\n' + data.conclusion : ''),
    });
  }
  return { ok: true, id: key, caseId: c.id };
}
function metricCatalog(db) {
  return db
    .prepare(
      `WITH observations AS (
    SELECT body,json_extract(body,'$.source_id') origin FROM facts WHERE kind='metrics'
    UNION ALL SELECT body,json_extract(body,'$.combine_group') origin FROM facts
    WHERE kind='metrics' AND json_extract(body,'$.combine_group') IS NOT NULL)
    SELECT DISTINCT json_extract(body,'$.metric_id') metric,json_extract(body,'$.product') product,
    json_extract(body,'$.segment') segment,origin sourceId,
    json_extract(body,'$.definition_id') definitionId,json_extract(body,'$.unit') unit,
    json_extract(body,'$.step_days') stepDays FROM observations ORDER BY metric,product,segment,sourceId,definitionId`,
    )
    .all();
}

function resolveSeries(db, input) {
  const catalog = metricCatalog(db);
  const metrics = catalog.filter((r) => r.metric === input.metric);
  const products = metrics.filter((r) => !input.product || r.product === input.product);
  const matches = products.filter((r) => (!input.segment || r.segment === input.segment) &&
    (!input.sourceId || r.sourceId === input.sourceId) &&
    (!input.definitionId || r.definitionId === input.definitionId));
  if (matches.length === 1) return matches[0];
  const options = matches.length
    ? matches
    : products.length
      ? products
    : metrics.length
      ? metrics
      : catalog.filter((r) => !input.product || input.product === r.product);
  const choices = (options.length ? options : catalog)
    .slice(0, 8)
    .map((r) => r.metric + ' / ' + describeMetricSeries(r));
  throw Object.assign(
    Error(
      choices.length
        ? 'Уточните ряд. Доступные сочетания: ' + choices.join('; ')
        : 'В источниках пока нет рядов метрик.',
    ),
    { code: 'CHART_SERIES_UNAVAILABLE' },
  );
}

function prepareSignalIssue(store, user, input, env, send) {
  const { caseId, revision } = signalIssueInput.parse(input);
  const c = visibleCase(store.db, user, caseId);
  const signal = c.body.signal;
  if (!signal || signal.status === 'withdrawn' || c.state === 'Завершено')
    throw Error('В разборе нет действующего сигнала');
  const currentRevision = signal.revision ?? 0;
  if (revision !== undefined && revision !== currentRevision)
    throw Error('Сигнал изменился. Обновите разбор перед подготовкой задачи.');
  const request = digest(JSON.stringify(['signal-issue-draft', user.id, caseId, currentRevision]));
  const description = [
    c.title,
    signal.releaseId && 'Релиз: ' + signal.releaseId,
    signal.segment && 'Сегмент: ' + signal.segment,
    'Неделя сигнала: ' + signal.week,
    signal.metric
      ? 'Значение: ' + fmt(signal.n) + ' / ' + fmt(signal.d) + ' = ' + fmt(signal.value) + '%.'
      : 'Индекс заказов: ' + fmt(signal.value) + ' п.',
    signal.baselineFrom && signal.baselineThrough &&
      'База (' + signal.baselineFrom + ' — ' + signal.baselineThrough + '): ' +
      fmt(signal.baseN) + ' / ' + fmt(signal.baseD) + ' = ' + fmt(signal.baseValue) + '%.',
    signal.change != null && 'Изменение: ' + fmt(signal.change) + ' ' + (signal.changeUnit || '%') + '.',
    signal.source && 'Источник: ' + signal.source,
    'Разбор ' + c.id + ', версия сигнала ' + currentRevision + '.',
    '\nПроверить причины отклонения и предложить дальнейшие действия.',
  ].filter(Boolean).join('\n');
  return prepareTracker(store, user, 'issue', {
    caseId,
    title: ('Проверить сигнал · ' + c.title + ' · ' + signal.week).slice(0, 240),
    description,
  }, env, send, request, false, true, {signalRevision: currentRevision});
}

function signalMeasurement(c) {
  const signal = c.body.signal;
  if (!signal) return null;
  if (measuredSignal(signal.metric)) return {
    metric: signal.metric, product: c.product, segment: signal.segment || 'all',
    sourceId: signal.sourceId, definitionId: signal.definitionId, stepDays: signal.stepDays, counterIds: signal.counterIds,
  };
  return legacyOrderMetric(signal.metric) ? { metric: 'orders_index', product: c.product, segment: 'all' } : null;
}

function agreeMeasurement(store, user, input) {
  const b = agreementInput.parse(input);
  const db = store.db;
  return store.tx(() => {
    const c = visibleCase(db, user, b.caseId);
    const signal = c.body.signal, series = signalMeasurement(c);
    if (!series || signal.status === 'withdrawn' || c.state === 'Завершено')
      throw Error('Откройте разбор действующего сигнала.');
    if (c.body.watch || c.state === 'Наблюдаем эффект')
      throw Error('Критерий зафиксирован после назначения проверки эффекта.');
    const run = requireActionableRun(db, user, c.id, b.runId);
    const signalRevision = signal.revision ?? 0;
    if (run.revision !== signalRevision)
      throw Error('Сигнал уточнён. Откройте актуальное исследование.');
    const privatePrimary = c.body.owner === user.id && run.owner === user.id && !run.parentId;
    if (run.owner && !run.published && !privatePrimary)
      throw Error('Опубликуйте исследование перед согласованием критерия для разбора.');
    const plan = c.body.plan || {};
    const previous = plan.measurementAgreement;
    if (plan.measurement && !previous) throw Error('В разборе уже согласован критерий измерения.');
    const inputSpec = b.measurement;
    if (['metric', 'product', 'segment', 'sourceId', 'definitionId']
      .some(key => inputSpec[key] && inputSpec[key] !== series[key]))
      throw Error('Подтвердите метрику и ряд сигнала.');
    if (!inputSpec.baselineFrom || !inputSpec.baselineThrough)
      throw Error('Укажите начало и конец базового периода.');
    const normalized = measurementSpec({
      ...inputSpec, ...series, minDenominator: inputSpec.minDenominator ?? signal.minDenominator,
    }, c.product);
    const request = digest(JSON.stringify([run.id, signalRevision, normalized]));
    if (previous?.request === request) return { measurement: plan.measurement, agreement: previous };
    if ((previous?.id || null) !== b.expectedAgreementId)
      throw Error('План измерения уже обновлён. Откройте текущий критерий.');
    const { measurement, baseline, controlBaseline, target, tolerance } = createMeasurementAgreement(db, normalized);
    const agreement = { id: randomUUID(), runId: run.id, signalRevision, request, baseline, controlBaseline, target, tolerance };
    c.body.plan = { ...plan, measurement, measurementAgreement: agreement };
    updateCase(db, c);
    return { measurement, agreement };
  });
}

function proposedObservation(db, c, input, env) {
  if (env.SOURCE_ARCHIVE_SHA256 && input.deployed && !input.releaseId)
    throw Error('Выберите подтверждённую выкладку из журнала релизов.');
  return makeObservationPlan(db, c, input);
}

function createPersonalCase(db, user, { title, product, release, plan = {}, origin = null }) {
  const key = randomUUID();
  db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(key, product, title, 'Исследуем',
    JSON.stringify({ owner: user.id, responsible: user.name, release: release || null, plan, origin }));
  if (origin) grant(db, origin.calc, 'user', user.id);
  syncInvestigations(db, key);
  return { id: key, title, product };
}

export function workspaceOperation(
  store,
  user,
  op,
  input = {},
  env = process.env,
  send = fetch,
  sharedOnly = false,
  requestId,
  assistantAuthored = false,
) {
  const db = store.db;
  const meta = operations[op];
  const b = meta ? z.object(meta[1]).parse(input) : input;
  if (op === 'release_decision') return releaseDecision(db, user, b, sharedOnly);
  if (['release-tracker', 'release-tracker-case', 'release-tracker-draft'].includes(op)) {
    if (sharedOnly || assistantAuthored) throw Error('Откройте личный чат этого разбора.');
    const decision = releaseDecision(db, user, b);
    if (!decision.release || decision.historical) throw Error('Откройте текущий срез выпущенной функции.');
    const requestedCaseId = b.caseId || decision.caseId;
    const relatedCase = requestedCaseId && visibleCase(db, user, requestedCaseId);
    const caseId = relatedCase?.body.release === b.releaseId ? relatedCase.id : null;
    if (b.caseId && (!caseId || b.product && b.product !== decision.product))
      throw Error('Выберите разбор выбранного продукта, связанный с этим релизом.');
    if (op === 'release-tracker-case') {
      return store.tx(() => {
        const current = releaseDecision(db, user, b);
        const linked = current.caseId && visibleCase(db, user, current.caseId);
        const title = ('Оценка релиза ' + b.releaseId + ' · ' + current.product).slice(0, 240);
        const caseId = linked?.body.release === b.releaseId ? linked.id :
          createPersonalCase(db, user, { title, product: current.product, release: b.releaseId }).id;
        if (current.scope !== 'account') bindReleaseThreadCase(db, user, b.releaseId, caseId, current.product);
        return { caseId };
      });
    }
    const proposed = decisionDraft(decision, env.APP_BASE_URL);
    const target = targetFor(db, user, 'redmine', env);
    const linkedKeys = [...new Set([...decision.release.relatedTaskIds, ...decision.delivered.map(task => task.id)])];
    const titles = [decision.backlog?.title, proposed.title, ...decision.delivered.map(task => task.title)].filter(Boolean);
    const queries = [...new Set([...linkedKeys, ...titles, decision.product, decision.measurement?.metric].filter(Boolean))];
    return Promise.resolve(trackerClient(store, user, target, env, send, caseId)).then(async api => {
      const hits = api.searchProject ? await api.searchProject(queries) :
        (await Promise.all(queries.map(query => api.search(query, true)))).flat();
      const normalized = title => title.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
      const linked = new Set(linkedKeys.map(normalized));
      const exact = new Set(titles.map(normalized));
      const items = [...new Map(hits.map(item => [item.key, item])).values()]
        .map(({ key, title, url, status, canComment = true }) => {
          const linkedToRelease = linked.has(normalized(key));
          return { key, title, url, status, canComment, linkedToRelease, exact: linkedToRelease || exact.has(normalized(title)) };
        })
        .sort((a, b) => Number(b.linkedToRelease) - Number(a.linkedToRelease) || Number(b.exact) - Number(a.exact));
      if (op === 'release-tracker') return { items, caseId, local: !!target.local };
      const chosen = b.key && items.find(item => item.key === b.key);
      if (b.key && !chosen) throw Error('Повторите поиск и выберите задачу из результатов.');
      if (chosen && !chosen.canComment) throw Error('Откройте найденную задачу в Redmine для добавления комментария.');
      if (!chosen && items.some(item => item.exact)) throw Error('Найдена подходящая задача. Предложите комментарий к ней.');
      if (visibleCase(db, user, caseId).body.release !== b.releaseId) throw Error('Привязка разбора к релизу изменилась.');
      const body = chosen ? { caseId, key: chosen.key, comment: proposed.description } : { caseId, ...proposed };
      const draftId = digest(JSON.stringify(['release-decision', user.id, caseId, b.releaseId, b.key, target, proposed.description]));
      return prepareTracker(store, user, 'issue', body, env, send, draftId);
    });
  }
  if (op === 'knowledge-sources') return excelSources(db);
  if (op === 'knowledge-source') return sourceRows(db,b.version,b.offset,b.loc);
  if (op === 'source_value') return sourceValues(db,b);
  if (op === 'read_public_page') {
    if (Boolean(b.version)!==Boolean(b.loc) || Boolean(b.url)===Boolean(b.version)) throw Error('Укажите URL или версию книги и адрес ячейки.');
    const cell = b.version && cellSource(db,b.version,b.loc);
    return readPublicPage(cell ? cell.url : b.url,env).then(page=>({...page,...(cell && {source:cell})}));
  }
  if (op === 'competitor_check') {
    if(b.asOf || b.savedOnly) {
      const archived=sourceRows(db,b.version,0,b.loc);
      if(!archived.rows[0]?.offer)return null;
      if(!b.asOf) return savedOfferCheck(db,b);
      const row=db.prepare("SELECT body FROM competitor_check_history WHERE version=? AND loc=? AND json_extract(body,'$.checkedAt')<=? ORDER BY json_extract(body,'$.checkedAt') DESC,id DESC LIMIT 1").get(b.version,b.loc,new Date(b.asOf).toISOString());
      return row?JSON.parse(row.body):null;
    }
    const offer=marketOffers(db,null,new Date().toISOString().slice(0,10)).find(o=>o.version===b.version && o.loc===b.loc);
    if(!offer) throw Error('Позиция отсутствует в действующей версии исследования.');
    return checkOffer(db,offer,env,send,requestId);
  }
  const current = () => visibleCase(db, user, b.caseId);
  if (op === 'signal-issue-draft') return prepareSignalIssue(store, user, b, env, send);
  if (op === 'investigation-measurement') {
    if (assistantAuthored || sharedOnly) throw Error('Подтвердите критерий в разборе.');
    return agreeMeasurement(store, user, b);
  }
  if (op === 'funnel') {
    if (!b.thread) throw Error('Укажите беседу для сохранения результата');
    const shared = thread(db, user, b.thread).scope === 'group';
    if (b.caseId && current().body.owner && shared) throw Error('Личный разбор недоступен в группе');
    const r = prepareResearch(
      store,
      user,
      { ...b, question: 'Проверь воронку', screen: b.calc ? { calc: b.calc } : undefined },
      [],
      null,
    );
    if (!r) throw Error('Уточните семейство продукта или приложите доступный график');
    const ref = saveMaterial(db, b.thread, {
      kind: 'report',
      title: 'Воронка · ' + r.product,
      product: r.product,
      contextCalc: r.contextCalc,
      summary:
        r.findings.find((s) => s.includes('Завершение подбора')) ||
        r.findings[0] ||
        'В выбранном периоде отсутствуют наблюдения.',
      ranges: r.periods,
      findings: r.findings,
      sections: r.sections,
      children: r.children,
      checks: r.checks,
    });
    return { material: ref, chart: r.requestedChart, available: r.funnelAvailable, ...researchContext(r) };
  }
  if (op === 'overview') return dashboard(db, user);
  if (op === 'metrics') {
    return {
      metrics: metricCatalog(db),
      ordersIndex: {
        metric: 'orders_index',
        products: [...new Set(facts(db, 'sales').map((f) => f.data.product_family))],
        segment: 'all',
      },
      definitions: facts(db, 'dictionary').map((f) => f.data),
      releases: store.releases().map((r) => ({ id: r.id, title: r.title })),
    };
  }
  if (op === 'calc') return readSnapshot(db, user, b.id);
  if (op === 'range_read') return readRange(db, user, b.id);
  if (op === 'selection_context') return neighboring(store, user, b.id, sharedOnly);
  if (op === 'range_compare') return compareRanges(store, user, b.selection);
  if (op === 'search') return b.caseId
    ? caseEvidenceSearch(db, current().product, b.query, b.kinds, b.asOf)
    : search(db, b.query, b.kinds, 8, { asOf: b.asOf });
  if (op === 'view') {
    const c = b.caseId ? current() : null;
    const view = analysisView(db, b);
    grant(db, view.id, 'user', user.id);
    if (!c) return { view, backlog: view.backlog };
    return {
      case: c,
      investigation: readInvestigations(db, user, c.id, sharedOnly),
      signalHistory: c.body.signal && !b.through ? signalHistory(db,c.id) : [],
      view,
      effect: view.monitoring?.result ?? null,
      backlog: view.backlog,
      personal: JSON.parse(
        db.prepare('SELECT body FROM personal_views WHERE user=? AND case_id=?').get(user.id, c.id)?.body ||
          'null',
      ),
      published: db
        .prepare('SELECT * FROM published WHERE case_id=? ORDER BY created DESC LIMIT 6')
        .all(c.id)
        .map((x) => ({ ...x, body: JSON.parse(x.body) })),
      drafts: sharedOnly
        ? []
        : db
            .prepare('SELECT * FROM draft_actions WHERE case_id=? AND user=? ORDER BY rowid DESC')
            .all(c.id, user.id)
            .map(preview),
    };
  }
  if (op === 'create-case') {
    const { title, product, release, message, ...plan } = b;
    if (env.SOURCE_ARCHIVE_SHA256 && (user.space === 'team'
      ? !protectedProducts(db).includes(product)
      : !facts(db, 'sales').some(row => row.data.product_family === product)))
      throw Error('Выберите семейство продукта из загруженной книги.');
    if (plan.from && plan.through && plan.from > plan.through)
      throw Error('Начало исследования должно быть не позже конца периода.');
    if (plan.measurement) plan.measurement = measurementSpec(plan.measurement, product);
    let origin = null;
    if (message) {
      const m = db
        .prepare("SELECT thread,body FROM chat_items WHERE seq=? AND role='assistant'")
        .get(message);
      if (!m) throw Error('Ответ не найден');
      thread(db, user, m.thread);
      const r = JSON.parse(m.body);
      if (r.product !== product) throw Error('Другой продукт');
      if (r.calc) {
        access(db, user, r.calc);
        origin = { calc: r.calc, cards: r.cards || ['summary', 'trend'], full: !!r.full };
      }
    }
    return createPersonalCase(db, user, { title, product, release, plan, origin });
  }
  if (op === 'append_case') {
    const c = current();
    if (b.rangeId) {
      access(db, user, b.rangeId, !c.body.owner);
      grant(db, b.rangeId, c.body.owner ? 'user' : 'case', c.body.owner || c.id);
    }
    c.body.notes = [
      ...(c.body.notes || []),
      { author: user.name, text: b.note, rangeId: b.rangeId, created: Date.now() },
    ];
    updateCase(db, c);
    return { caseId: c.id, note: b.note };
  }
  if (op === 'set_view') {
    const c = current(),
      view = {
        revision: randomUUID(),
        cards: [...new Set(b.cards)],
        control: b.control,
        full: b.full,
        pin: b.pin,
      };
    db.prepare('INSERT OR REPLACE INTO personal_views VALUES(?,?,?)').run(
      user.id,
      c.id,
      JSON.stringify(view),
    );
    return { caseId: c.id, ...view };
  }
  if (op === 'chart') {
    if (b.releaseId) {
      const g = runTool(store, 'build_chart', {
        releaseId: b.releaseId,
        day: b.day,
        segment: b.segment || 'all',
        spec: { field: b.field, stat: b.stat, start: b.start, end: b.end, title: b.title },
      });
      return {
        id: g.id,
        source: 'release',
        title: g.result.title,
        unit: g.result.unit,
        formula: g.result.formula,
      };
    }
    if (['orders_index', 'family_orders_idx'].includes(b.metric)) {
      if (b.segment && b.segment !== 'all')
        throw Error(
          'Индекс заказов доступен по семейству для всех устройств. Для этого ряда укажите segment=all.',
        );
      let view;
      if (b.calc) {
        access(db, user, b.calc, sharedOnly);
        view = { ...readSnapshot(db, user, b.calc), id: b.calc };
      } else {
        if (!b.product || !facts(db, 'sales').some((f) => f.data.product_family === b.product))
          throw Error('Для индекса заказов выберите семейство из ordersIndex.products.');
        view = analysisView(db, { product: b.product, from: b.from, through: b.through, full: b.full });
      }
      if (
        (b.product && b.product !== view.product) ||
        !view.summary?.[0]?.rows?.some((r) => Number.isFinite(r.value))
      )
        throw Error('Для выбранного семейства в снимке нет ряда индекса заказов.');
      grant(db, view.id, 'user', user.id);
      return {
        id: view.id,
        source: 'weekly',
        metric: 'orders_index',
        cards: ['summary', 'trend'],
        title: 'Индекс заказов · ' + view.product,
        product: view.product,
        segment: 'all',
        unit: 'п. индекса',
        summary: view.summary.map(({ product, before, after }) => ({ product, before, after })),
      };
    }
    const series = resolveSeries(db, b);
    const sourceRows = facts(db, 'metrics')
      .filter(
        (r) =>
          r.data.metric_id === series.metric &&
          r.data.product === series.product &&
          (r.data.source_id === series.sourceId || r.data.combine_group === series.sourceId) &&
          r.data.definition_id === series.definitionId && r.data.step_days === series.stepDays,
      );
    const rows = sourceRows.filter(r => r.data.segment === series.segment && observationWithin(r.data, b.from, b.through) &&
      (!b.full || !r.data.partial && !/неполн/i.test(r.data.comment || '')))
      .sort((a, b) => a.data.date.localeCompare(b.data.date));
    if (!rows.length) throw Error('В этом разрезе нет наблюдений');
    const step = series.stepDays * 86400000;
    let points = rows.map((r) => ({
      date: r.data.date, value: r.data.value, numerator: r.data.numerator, denominator: r.data.denominator,
      details: r.data.detail_json ? JSON.parse(r.data.detail_json) : null, sample: r.data.sample_size,
      partial: !!r.data.partial || /неполн/i.test(r.data.comment || ''), source: r.file + ' · ' + r.loc, version: r.version,
      ...(series.unit === 'ratio' && r.data.value == null &&
        {reason: aggregateMetric([r.data], series.metric).reason}),
    }));
    if (series.sourceId.startsWith('group:')) {
      const byDate = new Map();
      for (const f of rows) {
        if (!byDate.has(f.data.date)) byDate.set(f.data.date, []);
        byDate.get(f.data.date).push(f);
      }
      points = [...byDate].map(([date, group]) => {
        const total = aggregateMetric(group.map(f => f.data), series.metric, series);
        const sources = group.map(f => ({source:f.file + ' · ' + f.loc, version:f.version}));
        return {date, value:total.value == null || series.unit !== 'ratio' ? total.value : total.value / 100,
          numerator:total.n, denominator:total.d, reason:total.reason, sources, combineMembers:total.combineMembers,
          details: {}, partial:group.some(f => f.data.partial || /неполн/i.test(f.data.comment || '')),
          version:group[0].version, source:sources.map(s => s.source).join(', ')};
      });
    } else if (new Set(points.map(p => p.date)).size !== points.length) {
      throw Error('У выбранного сегмента несколько наблюдений на одну дату. Уточните названия группировок в источнике.');
    }
    const view = {
      kind: 'metric-chart',
      step,
      sourceId: series.sourceId,
      definitionId: series.definitionId,
      product: series.product,
      title: b.title || b.metric,
      metric: b.metric,
      segment: series.segment,
      unit: rows[0].data.unit,
      full: !!b.full,
      metricVersions: [...new Set(sourceRows.map(r => r.version))],
      points,
    };
    const observed = view.points.filter((p) => Number.isFinite(p.value));
    if (!observed.length)
      throw Object.assign(Error(points.find(p => p.reason)?.reason || 'Для ряда пока нет числовых наблюдений.'), {
        code: 'CHART_SERIES_UNAVAILABLE',
      });
    const hash = digest(JSON.stringify(view));
    db.prepare('INSERT OR IGNORE INTO evidence_calcs VALUES(?,?)').run(hash, JSON.stringify(view));
    grant(db, hash, 'user', user.id);
    const sample = (p) => ({ date: p.date, value: p.value, partial: p.partial, source: p.source });
    return {
      id: hash,
      source: 'metric',
      sourceId: view.sourceId,
      definitionId: view.definitionId,
      title: view.title,
      metric: view.metric,
      product: view.product,
      segment: view.segment,
      unit: view.unit,
      points: view.points.length,
      observations: observed.length,
      first: sample(observed[0]),
      last: sample(observed.at(-1)),
      min: sample(observed.reduce((a, b) => (a.value <= b.value ? a : b))),
      max: sample(observed.reduce((a, b) => (a.value >= b.value ? a : b))),
    };
  }
  if (op === 'case_links') {
    current();
    return caseLinks(store, user, b.caseId, env, send, sharedOnly);
  }
  if (
    [
      'issue_search',
      'issue_read',
      'issue_options',
      'page_search',
      'page_read',
      'draft',
      'page_draft',
    ].includes(op)
  ) {
    const service = op.startsWith('page_') ? 'confluence' : 'redmine';
    if (op === 'page_read' && b.issueKey) {
      return Promise.resolve().then(async () => {
        const issues = pagesByIssue(db, user, b.issueKey, { sharedOnly, localOnly: b.local });
        let result, providerError;
        for (const candidates of issues) {
          for (const { key, target } of candidates) {
            let page;
            try {
              const api = await trackerClient(store, user, target, env, send, undefined, sharedOnly);
              page = publicPage(await api.read(key));
            } catch (error) {
              providerError ??= error;
              continue;
            }
            if (result) throw Error('Найдено несколько задач с таким номером. Укажите ключ страницы из поиска.');
            result = page;
            break;
          }
        }
        if (result) return result;
        throw providerError || Error('Страница по задаче недоступна.');
      });
    }
    const target = b.local || (op === 'page_draft' && b.pageTarget === 'local')
      ? { service, local: true } : targetFor(db, user, service, env);
    if (
      sharedOnly &&
      (!target.local || (op === 'page_draft' && b.issueKey && !targetFor(db, user, 'redmine', env).local))
    )
      throw Error('Откройте личный чат для работы с задачами и страницами');
    if (op === 'draft' || op === 'page_draft') {
      current();
      if (b.rangeId) {
        readRange(db, user, b.rangeId);
        const evidence = '\nДоказательство: #range/' + b.rangeId;
        if (!b.key || b.description !== undefined)
          b.description = (b.description || '').slice(0, 3800) + evidence;
        else if (b.comment) b.comment = b.comment.slice(0, 3800) + evidence;
      }
      return prepareTracker(
        store,
        user,
        op === 'draft' ? 'issue' : 'page',
        b,
        env,
        send,
        requestId,
        sharedOnly,
        assistantAuthored,
      );
    }
    return Promise.resolve(trackerClient(store, user, target, env, send, undefined, sharedOnly)).then(
      async (api) => {
        if (op.endsWith('_search')) return { local: !!target.local, items: await api.search(b.query, false, b.origin) };
        if (op === 'issue_options') return api.options();
        if (op === 'page_read') {
          if (!b.key) throw Error('Укажите ключ страницы или номер задачи Redmine');
          return publicPage(await api.read(b.key));
        }
        const value = await api.read(b.key);
        return { ...value, ...issueClosure(db, user, value.url, sharedOnly), pages: issuePages(db, user, value.url, sharedOnly) };
      },
    );
  }
  if (op === 'confirm') {
    const row = db.prepare('SELECT * FROM draft_actions WHERE id=? AND user=?').get(b.id, user.id);
    if (!row) throw Error('Черновик недоступен');
    visibleCase(db, user, row.case_id);
    return confirmTracker(store, user, row, b.revision, env, send);
  }
  if (['prepare_publish', 'publish'].includes(op)) {
    const c = current();
    const range = b.rangeId ? readRange(db, user, b.rangeId) : null;
    if (!range && !b.calc) throw Error('Нужен расчёт или выделение для публикации');
    if (b.calc) checkPublicationCalculation(db, user, b.calc, c.product);
    if (range && range.source === 'weekly' && range.product !== c.product)
      throw Error('Выделение другого продукта');
    const cards = (b.cards || []).filter((k) => cardTypes.includes(k));
    if (!range && !cards.length) throw Error('Выберите материалы');
    const body = {
      caseId: c.id,
      calc: b.calc,
      cards,
      rangeId: range?.id,
      conclusion: String(b.conclusion || '').slice(0, 1400),
    };
    if (op === 'prepare_publish') {
      const key = randomUUID();
      db.prepare("INSERT INTO agent_previews VALUES(?,?,'publish',?,'pending',NULL)").run(
        key,
        user.id,
        JSON.stringify(body),
      );
      return { id: key, recipient: thread(db, user, 'group').title, ...body };
    }
    const key = digest(JSON.stringify([user.id, body]));
    return store.tx(() => commitPublication(store, user, key, body));
  }
  if (op === 'approve_preview') {
    const p = db.prepare('SELECT * FROM agent_previews WHERE id=? AND owner=?').get(b.id, user.id);
    if (!p) throw Error('Предпросмотр недоступен');
    if (p.state === 'done') return JSON.parse(p.result);
    return store.tx(() => {
      const result = commitPublication(store, user, p.id, JSON.parse(p.body));
      db.prepare("UPDATE agent_previews SET state='done',result=? WHERE id=?").run(
        JSON.stringify(result),
        p.id,
      );
      return result;
    });
  }
  if (op === 'feedback') {
    const c = current();
    db.prepare('INSERT INTO feedback(source,product,author,comment,created) VALUES(?,?,?,?,?)').run(
      b.source,
      c.product,
      user.name,
      b.comment,
      Date.now(),
    );
    return { ok: true };
  }
  if (op === 'watch-options') return observationOptions(db, current());
  if (op === 'effect-preview') {
    const c = current();
    if (b.asOf !== undefined) validateEffectCutoff(b.asOf);
    const result = b.metric
      ? observedEffect(db, { ...c, body: { ...c.body, watch: proposedObservation(db, c, b, env) } }, b.asOf)
      : effect(db, c, b.asOf);
    return result && { caseId: c.id, ...result };
  }
  if (op === 'watch') return store.tx(() => {
    const c = current(), precommitted = c.body.plan?.measurement, signal = c.body.signal;
    const previous = c.body.watch, agreement = c.body.plan?.measurementAgreement;
    const previousKind = watchKind(previous);
    if (b.agreementId && b.agreementId !== agreement?.id)
      throw Error('План измерения уже обновлён. Откройте текущий критерий.');
    if (agreement && previous?.agreementId !== agreement.id &&
      (signal?.status === 'withdrawn' || agreement.signalRevision !== (signal?.revision ?? 0)))
      throw Error('Сигнал уточнён. Согласуйте критерий в актуальном исследовании перед назначением проверки.');
    if (agreement && (b.measurement || b.percent || b.control || b.metric))
      throw Error('Используется согласованный критерий проверки. Передайте дату выкладки.');
    if (precommitted && b.metric)
      throw Error('Для этого разбора используется план проверки, заданный до выкладки. Передайте только дату.');
    const save = (watch) => {
      if (previous) {
        const prior = analysisView(db, { caseId: c.id });
        grant(db, prior.id, 'case', c.id);
        c.body.watchHistory = [...(c.body.watchHistory || []),
          { revision: previous.revision ?? 1, calc: prior.id, deployed: previous.deployed }];
      }
      watch.revision = previous ? (previous.revision ?? 1) + 1 : 1;
      c.body.watch = watch;
      delete c.body.watchReviewed;
      c.state = 'Наблюдаем эффект';
      updateCase(db, c);
      return { caseId: c.id, ...effect(db, c) };
    };
    if (b.metric) {
      if (b.measurement || b.percent)
        throw Error('Передайте поля одного плана проверки.');
      const plan = proposedObservation(db, c, b, env);
      if (!plan.taskId && !plan.deployed) throw Error('Выберите задачу или укажите подтверждённую выкладку.');
      if (previousKind === 'archive-observation' && plan.request === previous.request)
        return { caseId: c.id, ...effect(db, c) };
      return save(plan);
    }
    if (typeof b.deployed !== 'string') throw Error('Укажите дату выкладки.');
    if (!b.measurement && !b.percent && previousKind === 'measurement' && previous.deployed === b.deployed)
      return { caseId: c.id, ...effect(db, c) };
    if (precommitted && b.measurement)
      throw Error('Для этого разбора используется план проверки, заданный до выкладки. Передайте только дату.');
    const automatic = measuredSignal(signal?.metric) ? {
      ...signalMeasurement(c),
      baselineFrom: signal.baselineFrom, baselineThrough: signal.baselineThrough,
      control: b.control, minDenominator: signal.minDenominator,
    } : null;
    if (automatic && b.measurement && ['metric', 'product', 'segment', 'sourceId', 'definitionId']
      .some(key => automatic[key] && b.measurement[key] && automatic[key] !== b.measurement[key]))
      throw Error('Выберите метрику, продукт, сегмент и источник сигнала.');
    const spec = precommitted || (b.measurement && { ...automatic, ...b.measurement }) ||
      (!b.percent && previousKind === 'measurement' && previous.measurement) || (automatic && {
      ...automatic, comparison: 'gte', targetMode: 'baseline_percent',
      targetValue: b.percent ?? setting(db, 'rules', defaultRules).recovery,
    });
    if (agreement) return save(startMeasurementWatch({
      version: 2, measurement: precommitted, agreementId: agreement.id, control: precommitted.control,
      target: agreement.target, tolerance: agreement.tolerance, baseline: agreement.baseline,
      controlBaseline: agreement.controlBaseline, signalRevision: agreement.signalRevision,
    }, b.deployed));
    if (spec) {
      const normalized = measurementSpec(spec, c.product);
      const request = digest(JSON.stringify([normalized, b.deployed]));
      if (previousKind === 'measurement' && previous.request === request)
        return { caseId: c.id, ...effect(db, c) };
      return save({ ...createMeasurementWatch(db, normalized, b.deployed), request });
    }
    if (!legacyOrderMetric(c.body.plan?.metric))
      throw Error('Уточните целевую метрику и критерий старого плана в форме наблюдения.');
    if (!b.percent) throw Error('Укажите процент от базы индекса заказов или план измерения.');
    const v = analysisView(db, { caseId: c.id, control: b.control });
    if (
      !/^\d{4}-\d\d-\d\d$/.test(b.deployed) ||
      new Date(b.deployed + 'T12:00:00Z').toISOString().slice(0, 10) !== b.deployed ||
      !v.summary[1]?.before ||
      !v.summary[0]?.before
    )
      throw Error('Нужны дата выкладки, база и контроль');
    return save({
      deployed: b.deployed,
      target: (v.summary[0].before * b.percent) / 100,
      control: v.summary[1].product,
      controlBase: v.summary[1].before,
      tolerance: setting(db, 'rules', defaultRules).controlTolerance,
    });
  });
  if (op === 'decide') {
    const c = current();
    c.state = b.state;
    updateCase(db, c);
    return { ok: true, state: c.state };
  }
  throw Error('Неизвестная операция');
}
