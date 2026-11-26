import { randomUUID } from 'node:crypto';
import { z } from 'zod/v4';
import {
  analysisView,
  cases,
  effect,
  search,
  facts,
  rankBacklog,
  updateCase,
  setting,
  defaultRules,
  digest,
} from './evidence.mjs';
import { visibleCase, dashboard, draft, confirm, thread, cardTypes } from './workbench.mjs';
import { access, grant, readSnapshot, readRange, compareRanges, neighboring } from './chart-ranges.mjs';
import { jira } from './connectors.mjs';
import { runTool } from './analytics.mjs';

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
  title: text,
  description: z.string().max(4000),
  key: optional,
  priority: optional,
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
  'jira-search': ['Поиск дубликатов и открытых задач', { query: text }],
  'create-case': ['Создать личный разбор по явному поручению', createInput],
  append_case: [
    'Дополнить разбор выводом и ссылкой на доказательство',
    { ...caseInput, note: text, rangeId: id.optional() },
  ],
  chart: [
    'Построить график из доступных агрегатов (метрика, продукт, сегмент) или архивных событий для count, sum, mean, median, p90',
    {
      metric: optional,
      product: optional,
      segment: optional,
      releaseId: id.optional(),
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
  draft: ['Подготовить и сохранить черновик QA или Jira. Записи в Jira не выполняет.', issueInput],
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
export function workspaceOperation(
  store,
  user,
  op,
  input = {},
  env = process.env,
  send = fetch,
  sharedOnly = false,
) {
  const db = store.db;
  const meta = operations[op];
  const b = meta ? z.object(meta[1]).parse(input) : input;
  const current = () => visibleCase(db, user, b.caseId);
  if (op === 'overview') return dashboard(db, user);
  if (op === 'metrics') {
    const rows = db
      .prepare(
        "SELECT DISTINCT json_extract(body,'$.metric_id') metric,json_extract(body,'$.product') product,json_extract(body,'$.segment') segment FROM facts WHERE kind='metrics'",
      )
      .all();
    return {
      metrics: rows,
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
      drafts: db
        .prepare("SELECT * FROM draft_actions WHERE case_id=? AND (user=? OR state='done')")
        .all(c.id, user.id)
        .map((x) => ({ ...x, body: JSON.parse(x.body) })),
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
      origin = { calc: r.calc, cards: r.cards, full: r.full };
    }
    const key = randomUUID();
    db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(
      key,
      product,
      title,
      'Исследуем',
      JSON.stringify({ owner: user.id, responsible: user.name, release: release || null, plan, origin }),
    );
    return { id: key, title, product };
  }
  if (op === 'append_case') {
    const c = current();
    if (b.rangeId) access(db, user, b.rangeId, !c.body.owner);
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
    if (!b.metric || !b.product || !b.segment)
      throw Error('Выберите metric, product и segment из каталога метрик');
    const rows = facts(db, 'metrics')
      .filter(
        (r) => r.data.metric_id === b.metric && r.data.product === b.product && r.data.segment === b.segment,
      )
      .sort((a, b) => a.data.date.localeCompare(b.data.date));
    if (!rows.length) throw Error('В этом разрезе нет наблюдений');
    const step = ['cfg_option_share', 'cfg_step_dropoff', 'lk_reco_ctr'].includes(b.metric)
      ? 7 * 86400000
      : 86400000;
    const view = {
      kind: 'metric-chart',
      step,
      product: b.product,
      title: b.title || b.metric,
      metric: b.metric,
      segment: b.segment,
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
    const hash = digest(JSON.stringify(view));
    db.prepare('INSERT OR IGNORE INTO evidence_calcs VALUES(?,?)').run(hash, JSON.stringify(view));
    grant(db, hash, 'user', user.id);
    return { id: hash, source: 'metric', title: view.title, unit: view.unit, points: view.points.length };
  }
  if (op === 'jira-search') {
    if (user.role !== 'judge' && env.JIRA_BASE_URL)
      return jira(env, send)
        .search(b.query)
        .then((items) => ({ local: false, items }));
    return {
      local: true,
      items: [
        ...new Map([
          ...search(db, b.query, ['backlog']).map((f) => [f.key, { title: f.data.title, key: f.key }]),
          ...db
            .prepare('SELECT key,title,priority FROM local_issues WHERE title LIKE ? OR key=?')
            .all('%' + b.query + '%', b.query)
            .map((f) => [f.key, f]),
        ]).values(),
      ],
    };
  }
  if (op === 'draft') {
    if (b.rangeId) {
      readRange(db, user, b.rangeId);
      b.description = b.description.slice(0, 3800) + '\nДоказательство: #range/' + b.rangeId;
    }
    return {
      ...draft(store, user, b),
      destination:
        user.role === 'judge' || !env.JIRA_BASE_URL ? 'локальный демо-бэклог' : 'Jira · ' + env.JIRA_PROJECT,
    };
  }
  if (op === 'confirm') return confirm(store, user, b.id, env, send);
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
      return { id: key, recipient: 'Команда Store', ...body };
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
