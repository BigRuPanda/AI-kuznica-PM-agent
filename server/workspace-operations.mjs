import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import {
  analysisView,
  cases,
  effect,
  search,
  facts,
  metricStepDays,
  rankBacklog,
  updateCase,
  setting,
  defaultRules,
  digest,
} from './evidence.mjs';
import { visibleCase, dashboard, thread, cardTypes } from './workbench.mjs';
import { access, grant, readSnapshot, readRange, compareRanges, neighboring } from './chart-ranges.mjs';
import { targetFor } from './tracker-connections.mjs';
import { trackerClient, prepareTracker, confirmTracker, preview, publicPage, caseLinks } from './tracker-workflow.mjs';
import { runTool } from './analytics.mjs';
import { prepareResearch, researchContext } from './agent-research.mjs';
import { saveMaterial } from './materials.mjs';

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
const viewInput = {
  caseId: id.optional(),
  product: optional,
  control: z.union([z.string(), z.literal(false)]).optional(),
  full: z.boolean().optional(),
  sourceQuery: optional,
  from: optional,
  through: optional,
  releaseWeek: optional,
};
const createInput = {
  title: text,
  product: text,
  release: optional,
  hypothesis: optional,
  metric: optional,
  baseline: optional,
  control: optional,
  success: optional,
  message: z.number().int().optional(),
};
const issueInput = {
  caseId: id,
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
  deployed: z.string(),
  percent: z.coerce.number().positive().max(300),
  control: optional,
};
export const operations = {
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
  view: ['Посчитать недельный индекс и контроль, открыть разбор, проверить соседние периоды', viewInput],
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
      kinds: z.array(z.enum(['interview', 'competitor', 'backlog', 'releases', 'dictionary'])).optional(),
    },
  ],
  case_links: ['Доступные участнику задачи и страницы этого разбора', { caseId: id }],
  issue_search: ['Найти задачи в проекте Redmine', { query: z.string().max(400) }],
  issue_read: [
    'Прочитать задачу с комментариями и разрешёнными переходами',
    { key: id, local: z.boolean().optional() },
  ],
  issue_options: ['Приоритеты, исполнители и типы задач Redmine', {}],
  page_search: ['Найти страницы Confluence в пространстве команды', { query: z.string().max(400) }],
  page_read: ['Прочитать страницу Confluence и её версию', { key: id, local: z.boolean().optional() }],
  page_draft: [
    'Предпросмотр изменения страницы Confluence. fragment — уникальный исходный текст для замены, иначе content добавляется в конец. issueKey связывает страницу с задачей.',
    {
      caseId: id,
      key: optional,
      title: z.string().max(255).optional(),
      content: z.string().max(30000).optional(),
      fragment: z.string().max(10000).optional(),
      issueKey: optional,
      baseVersion: z.number().int().positive().optional(),
    },
  ],
  'create-case': ['Создать личный разбор по явному поручению', createInput],
  append_case: [
    'Дополнить разбор выводом и ссылкой на доказательство',
    { ...caseInput, note: text, rangeId: id.optional() },
  ],
  chart: [
    'Построить график. Для агрегатов скопируй сочетание metric, product, segment из metrics. Для недельного индекса заказов используй orders_index и семейство продукта. Параметры field и stat относятся к архивному releaseId.',
    {
      metric: optional,
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
  watch: ['Назначить наблюдение по подтверждённой дате выкладки и цели', watchInput],
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
function commitPublication(store, user, key, data) {
  const db = store.db,
    c = visibleCase(db, user, data.caseId);
  if (data.calc) access(db, user, data.calc);
  if (data.rangeId) access(db, user, data.rangeId);
  if (!db.prepare('SELECT id FROM published WHERE id=?').get(key)) {
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
    db.prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES('group',?,'user',?,?)").run(
      user.name,
      JSON.stringify({
        ...data,
        text: 'Опубликован разбор: ' + c.title + (data.conclusion ? '\\n' + data.conclusion : ''),
      }),
      Date.now(),
    );
  }
  return { ok: true, id: key, caseId: c.id };
}
function metricCatalog(db) {
  return db
    .prepare(
      `SELECT DISTINCT json_extract(body,'$.metric_id') metric,json_extract(body,'$.product') product,
    json_extract(body,'$.segment') segment FROM facts WHERE kind='metrics' ORDER BY metric,product,segment`,
    )
    .all();
}

function resolveSeries(db, input) {
  const catalog = metricCatalog(db);
  const metrics = catalog.filter((r) => r.metric === input.metric);
  const products = metrics.filter((r) => !input.product || r.product === input.product);
  const matches = products.filter((r) => !input.segment || r.segment === input.segment);
  if (matches.length === 1) return matches[0];
  const options = products.length
    ? products
    : metrics.length
      ? metrics
      : catalog.filter((r) => !input.product || input.product === r.product);
  const choices = (options.length ? options : catalog)
    .slice(0, 8)
    .map((r) => [r.metric, r.product, r.segment].join(' / '));
  throw Object.assign(
    Error(
      choices.length
        ? 'Уточните ряд. Доступные сочетания: ' + choices.join('; ')
        : 'В источниках пока нет рядов метрик.',
    ),
    { code: 'CHART_SERIES_UNAVAILABLE' },
  );
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
) {
  const db = store.db;
  const meta = operations[op];
  const b = meta ? z.object(meta[1]).parse(input) : input;
  const current = () => visibleCase(db, user, b.caseId);
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
  if (op === 'search') return search(db, b.query, b.kinds);
  if (op === 'view') {
    const c = b.caseId ? current() : null;
    const view = analysisView(db, b);
    grant(db, view.id, 'user', user.id);
    if (!c) return { view, backlog: rankBacklog(db, view.product) };
    return {
      case: c,
      view,
      effect: effect(db, c),
      backlog: rankBacklog(db, c.product),
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
    const key = randomUUID();
    db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(
      key,
      product,
      title,
      'Исследуем',
      JSON.stringify({ owner: user.id, responsible: user.name, release: release || null, plan, origin }),
    );
    if (origin) grant(db, origin.calc, 'user', user.id);
    return { id: key, title, product };
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
        view = analysisView(db, { product: b.product });
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
    const rows = facts(db, 'metrics')
      .filter(
        (r) =>
          r.data.metric_id === series.metric &&
          r.data.product === series.product &&
          r.data.segment === series.segment,
      )
      .sort((a, b) => a.data.date.localeCompare(b.data.date));
    if (!rows.length) throw Error('В этом разрезе нет наблюдений');
    const step = metricStepDays(b.metric) * 86400000;
    const view = {
      kind: 'metric-chart',
      step,
      product: series.product,
      title: b.title || b.metric,
      metric: b.metric,
      segment: series.segment,
      unit: rows[0].data.unit,
      points: rows.map((r) => ({
        date: r.data.date,
        value: r.data.value,
        details: r.data.detail_json ? JSON.parse(r.data.detail_json) : null,
        sample: r.data.sample_size,
        partial: /неполн/i.test(r.data.comment || ''),
        source: r.file + ' · ' + r.loc,
        version: r.version,
      })),
    };
    const observed = view.points.filter((p) => Number.isFinite(p.value));
    if (!observed.length)
      throw Object.assign(Error('Для ряда пока нет числовых наблюдений.'), {
        code: 'CHART_SERIES_UNAVAILABLE',
      });
    const hash = digest(JSON.stringify(view));
    db.prepare('INSERT OR IGNORE INTO evidence_calcs VALUES(?,?)').run(hash, JSON.stringify(view));
    grant(db, hash, 'user', user.id);
    const sample = (p) => ({ date: p.date, value: p.value, partial: p.partial, source: p.source });
    return {
      id: hash,
      source: 'metric',
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
    const target = b.local ? { service, local: true } : targetFor(db, user, service);
    if (
      sharedOnly &&
      (!target.local || (op === 'page_draft' && b.issueKey && !targetFor(db, user, 'redmine').local))
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
      );
    }
    return Promise.resolve(trackerClient(store, user, target, env, send, undefined, sharedOnly)).then(
      async (api) => {
        if (op.endsWith('_search')) return { local: !!target.local, items: await api.search(b.query) };
        if (op === 'issue_options') return api.options();
        const value = await api.read(b.key);
        return op === 'page_read' ? publicPage(value) : value;
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
    if (b.calc && readSnapshot(db, user, b.calc).product !== c.product)
      throw Error('Расчёт другого продукта');
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
  if (op === 'watch') {
    const c = current(),
      v = analysisView(db, { caseId: c.id, control: b.control });
    if (
      !/^\d{4}-\d\d-\d\d$/.test(b.deployed) ||
      new Date(b.deployed + 'T12:00:00Z').toISOString().slice(0, 10) !== b.deployed ||
      !v.summary[1]?.before ||
      !v.summary[0]?.before
    )
      throw Error('Нужны дата выкладки, база и контроль');
    c.body.watch = {
      deployed: b.deployed,
      target: (v.summary[0].before * b.percent) / 100,
      control: v.summary[1].product,
      controlBase: v.summary[1].before,
      tolerance: setting(db, 'rules', defaultRules).controlTolerance,
    };
    c.state = 'Наблюдаем эффект';
    updateCase(db, c);
    return { caseId: c.id, ...effect(db, c) };
  }
  if (op === 'decide') {
    const c = current();
    c.state = b.state;
    updateCase(db, c);
    return { ok: true, state: c.state };
  }
  throw Error('Неизвестная операция');
}
