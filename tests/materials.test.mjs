import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { evaluationCase } from '../scripts/eval-agent.mjs';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs, setSetting } from '../server/evidence.mjs';
import { initWorkbench, createThread, enqueue, workJobs, messages, resumeJob } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { materialForResult, readMaterial, telegramParts } from '../server/materials.mjs';
import { createTeamApp } from '../server/team-http.mjs';

const user = { id: 'u', name: 'Тест', role: 'judge' };
const api = {
  LLM_DATA_MODE: 'analysis',
  LLM_MODEL: 'test',
  LLM_BASE_URL: 'http://localhost',
  LLM_BACKEND: 'api',
};
const say = (text) => new Response(JSON.stringify({ choices: [{ message: { content: text } }] }));
function sample(s, u = user) {
  const { selection } = evaluationCase(s, u);
  const c = workspaceOperation(s, u, 'create-case', { title: 'Воронка Astra', product: 'Astra' });
  const v = workspaceOperation(s, u, 'view', { caseId: c.id, control: 'Kaspersky', from: '2026-06-29' }).view;
  return {
    thread: createThread(s.db, u, 'Воронка'),
    caseId: c.id,
    selection: { ...selection, calcId: v.id, version: v.id },
    view: v,
  };
}
function open() {
  const s = openStore(':memory:');
  initEvidence(s.db);
  initWorkbench(s.db);
  return s;
}
test('exact weekly questions reference the recorded value or report the available dates without a model', async () => {
  const s = open();
  try {
    importDocs(s, [{ file: 'orders.xlsx', facts: [{
      kind: 'sales', loc: 'Продажи!A8',
      row: { product_family: 'Продукт', week_start: '2026-02-02', orders_index: 0 },
    }] }], { notify: false });
    const thread = createThread(s.db, user, 'Продажи');
    const ask = async (date, suffix) => {
      enqueue(s, user, { thread, question: 'Какой индекс заказов Продукт за неделю с ' + date + '? ' + suffix });
      await workJobs(s, { publicUser: () => user }, {});
      return messages(s.db, user, thread).items.at(-1).body;
    };
    const value = await ask('2026-02-02', 'Дай ссылку на строку.');
    assert.match(value.text, /— 0/);
    assert.match(value.readSources[0].label, /orders.xlsx · Продажи!A8/);
    const missing = await ask('2026-02-09', 'Проверь, есть ли в книге строка за эту дату.');
    assert.match(missing.text, /нет строки за неделю с 2026-02-09/);
    assert.match(missing.text, /последняя — 2026-02-02/);
    assert.deepEqual(missing.readSources, []);
  } finally {
    s.close();
  }
});
test('an explicit release observation uses the exact archived series and cutoff without a model', async () => {
  const s = open();
  try {
    const row = (kind, loc, data) => ({ kind, loc, row: data });
    const metric = 'cfg_orion_views';
    const samples = (from, count, segment, value) => Array.from({ length: count }, (_, i) => row(
      'metrics', (segment === 'desktop' ? 'Desktop' : 'Mobile') + '!A' + (from + i), {
        product: 'Orion', metric_id: metric, segment, unit: 'visits',
        date: '2026-05-' + String(from + i).padStart(2, '0'), value,
      },
    ));
    importDocs(s, [{ file: 'Archive.xlsx', facts: [
      row('dictionary', 'Dictionary!A2', { metric_id: metric, metric_name: 'Доля открывших конфигуратор' }),
      row('dictionary', 'Dictionary!A3', { metric_id: 'cfg_orion_open', metric_name: 'Открытия конфигуратора' }),
      row('backlog', 'Tasks!A2', { task_id: 'T-41', title: 'Orion', release_id: 'R-63',
        linked_metric_ids: metric + ',cfg_orion_open', created_date: '2026-04-22' }),
      row('backlog', 'Tasks!A3', { task_id: 'T-42', title: 'Orion', release_id: 'R-63',
        linked_metric_ids: metric, created_date: '2026-05-20' }),
      row('releases', 'Releases!A2', { release_id: 'R-63', description: 'Orion',
        release_date: '2026-05-12', status: 'выпущен', release_type: 'minor',
        related_task_ids: 'T-41,T-42', affected_metrics: metric }),
      ...samples(5, 7, 'desktop', 4), ...samples(13, 7, 'desktop', 10),
      ...samples(5, 7, 'mobile', 40), ...samples(13, 7, 'mobile', 5),
    ] }], { notify: false });
    s.db.prepare("INSERT INTO cases VALUES('orion','Orion','Orion','Исследуем','{}')").run();
    setSetting(s.db, 'metrika_probe', { at: Date.UTC(2026, 10, 27, 12), status: 'ready' });
    const thread = createThread(s.db, user, 'Эффект Orion');
    const env = { ...api, SOURCE_ARCHIVE_SHA256: 'archive' };
    let calls = 0;
    const ask = async (question, caseId) => {
      enqueue(s, user, { thread, question, caseId });
      await workJobs(s, { publicUser: () => user }, env, async () => {
        calls++;
        return say('Ответ для другого поручения.');
      });
      return messages(s.db, user, thread).items.at(-1).body;
    };
    const limited = await ask('Разбери R-63 для Orion по данным на 14.05.2026. Какая задача связана и как изменился cfg_orion_views на desktop по двум окнам по 1 неделе? Проверь живые данные Метрики магазина. Не создавай задачу.');
    assert.deepEqual(limited.steps, ['watch-options', 'effect-preview']);
    assert.equal(limited.caseId, 'orion');
    assert.match(limited.text, /R-63 вышел 2026-05-12/);
    assert.match(limited.text, /T-41/);
    assert.doesNotMatch(limited.text, /T-42|Наблюдаемое изменение/);
    assert.match(limited.text, /2026-05-05 – 2026-05-11 · 7\/7 дней.*28 \/ 7 ≈ 4 визитов\/день/);
    assert.match(limited.text, /2026-05-13 – 2026-05-19 · 2\/7 дней.*2026-05-15 – 2026-05-19/);
    assert.match(limited.text, /рабочего счётчика.{0,50}недоступны/);
    assert.match(limited.text, /Reports API ответил на проверку тестового счётчика 2026-11-27/);
    const citations = limited.readSources.map(x => x.label);
    for (const loc of ['Releases!A2', 'Tasks!A2', 'Dictionary!A2', 'Desktop!A13', 'Desktop!A14'])
      assert.ok(citations.includes('Archive.xlsx · ' + loc));
    assert.ok(citations.every(s => !/Mobile!|Desktop!A(?:15|16|17|18|19)/u.test(s)));
    const plainLanguage = await ask('На 14 мая 2026 года проверь эффект R-63 для Orion. Можно ли сравнить долю визитов с открытием конфигуратора на десктопе по двум однонедельным окнам? Можно ли тем же объяснить падение самостоятельных заказов?');
    assert.match(plainLanguage.text, /Срез на 2026-05-14 · Доля открывших конфигуратор \(cfg_orion_views\) · desktop/);
    assert.match(plainLanguage.text, /2\/7 дней/);
    assert.match(plainLanguage.text, /нельзя установить причину изменения индекса самостоятельных заказов/);

    const missing = await ask('На 2026-05-19 проверь эффект r–63 на T‑41 по cfg_orion_views, одну неделю до и после.', 'orion');
    assert.match(missing.text, /Какой разрез выбрать\?.*desktop, mobile/);
    const clarified = await ask('Для mobile.', 'orion');
    assert.match(clarified.text, /Наблюдаемое изменение · -35 визитов в день/);
    assert.match(clarified.text, /cfg_orion_views\) · mobile/);
    assert.ok(clarified.readSources.every(s => !/Desktop!/u.test(s.label)));
    const absent = await ask('Каким был эффект R-63 на 2026-05-14 по cfg_unknown и desktop за 1 неделю до и после?', 'orion');
    assert.match(absent.text, /нет доступного ряда cfg_unknown/);
    assert.doesNotMatch(absent.text, /7\/7 дней|Индекс самостоятельных заказов/);
    const byName = await ask('Доля открывших конфигуратор.', 'orion');
    assert.match(byName.text, /Срез на 2026-05-14 · Доля открывших конфигуратор/);
    const missingDate = await ask('Оцени эффект R-63 по cfg_orion_views desktop за 1 неделю до и после', 'orion');
    assert.match(missingDate.text, /На какую дату среза/);
    const missingBaseline = await ask('Срез на 14.05.2026. Оцени эффект R-63 по cfg_orion_views desktop за 1 неделю после релиза.', 'orion');
    assert.match(missingBaseline.text, /Сколько недель взять до релиза и сколько после/);
    assert.equal(calls, 0);
    assert.deepEqual(JSON.parse(s.db.prepare("SELECT body FROM cases WHERE id='orion'").get().body), {});
    assert.equal(s.db.prepare('SELECT count(*) AS n FROM draft_actions').get().n, 0);
    const mixed = await ask('Сравни R-63 по cfg_orion_views desktop на 2026-05-14, 1 неделя до и после. Построй график.', 'orion');
    assert.ok(calls > 0);
    assert.notEqual(mixed.mode, 'release-observation');
  } finally {
    s.close();
  }
});
test('the workspace reports a local model deadline and keeps the turn resumable after a single request', async () => {
  const s = open();
  try {
    const thread = createThread(s.db, user, 'Таймаут модели');
    let calls = 0;
    enqueue(s, user, { thread, question: 'Что такое статистическая значимость?' });
    await workJobs(s, { publicUser: () => user }, api, async () => {
      calls++;
      throw new DOMException('deadline', 'TimeoutError');
    });
    const result = messages(s.db, user, thread).items.at(-1).body;
    assert.equal(calls, 1);
    assert.match(result.text, /Модель не успела ответить за 60 секунд/);
    assert.doesNotMatch(result.text, /Модель недоступна|параметры \.env/);
    assert.equal(result.canResume, true);
  } finally {
    s.close();
  }
});
test('a request for a new issue returns its saved draft and waits for confirmation', async () => {
  const s = open();
  try {
    const { caseId, thread } = sample(s);
    enqueue(s, user, { caseId, thread, question: 'Подготовь заявку в Redmine по этому разбору' });
    await workJobs(s, { publicUser: () => user }, api, async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.ok(!request.tools.some(t => t.function.name === 'page_draft'));
      if (request.messages.at(-1).role === 'tool') return say('Заявка уже доступна в Redmine.');
      const args = { title: 'Проверить расчёт', description: 'Сверить значение с исходной книгой' };
      const call = { id: 'new-issue', type: 'function', function: { name: 'draft', arguments: JSON.stringify(args) } };
      return Response.json({ choices: [{ message: { tool_calls: [call] } }] });
    });
    const result = messages(s.db, user, thread).items.at(-1).body;
    assert.deepEqual(result.steps, ['issue_search', 'draft']);
    assert.equal(result.actions[0].state, 'draft');
    assert.match(result.text, /черновик «Проверить расчёт»/);
    assert.match(result.text, /подтвердите создание/);
  } finally {
    s.close();
  }
});
test('chart corrections survive later turns and the open screen cannot replace the corrected series', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'chart-focus-')), 'data.sqlite');
  let s = openStore(path);
  initEvidence(s.db);
  initWorkbench(s.db);
  try {
    const { caseId, thread, view } = sample(s),
      accounts = { publicUser: () => user };
    const screen = { calc: view.id, cards: ['summary', 'timeline'] };
    const start = Date.UTC(2026, 9, 5);
    importDocs(s, [
      {
        file: 'Visits.xlsx',
        facts: Array.from({ length: 14 }, (_, i) => ({
          kind: 'metrics',
          loc: 'Visits!A' + i,
          row: {
            metric_id: 'cfg_family_views',
            product: 'Конфигуратор Kaspersky',
            segment: 'desktop',
            unit: 'visits',
            date: new Date(start + i * 86400000).toISOString().slice(0, 10),
            value: i % 7 < 5 ? 70 : 10,
          },
        })),
      },
    ]);
    const saved = workspaceOperation(s, user, 'chart', {
      metric: 'cfg_family_views',
      product: 'Конфигуратор Kaspersky',
      segment: 'desktop',
    });
    const visits = materialForResult(s.db, user, thread, {
      calc: saved.id,
      title: 'Визиты на страницу семейства Kaspersky',
      source: 'metric',
    });
    const orders = materialForResult(s.db, user, thread, {
      calc: view.id,
      title: 'Индекс заказов',
      cards: ['trend'],
    });
    const insert = (body, t = thread) =>
      s.db
        .prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES(?,'Агент','assistant',?,?)")
        .run(t, JSON.stringify(body), Date.now());
    insert({ text: 'Вот график визитов.', materials: [visits] });
    async function check(q, expected) {
      let context;
      enqueue(s, user, { thread, caseId, screen, question: q });
      await workJobs(s, accounts, api, async (_url, opts) => {
        context = JSON.parse(JSON.parse(opts.body).messages.at(-1).content).context;
        return say('Проверка сохранённого ряда завершена.');
      });
      const r = messages(s.db, user, thread).items.at(-1).body;
      assert.equal(r.focusMaterialId, expected.id);
      assert.equal(context.visible, null);
      const m = context.materials[0];
      assert.equal(m.id, expected.id);
      if (expected.id === visits.id) {
        assert.equal(m.chart.calcId, saved.id);
        assert.equal(m.chart.metric, 'cfg_family_views');
        assert.equal(m.unit, 'visits');
        assert.equal(m.stepDays, 1);
        assert.equal(m.observations[0].series, 'desktop');
        assert.deepEqual(m.observations[0].byDayType, {
          workdays: { days: 10, mean: 70 },
          weekends: { days: 4, mean: 10 },
        });
        assert.doesNotMatch(JSON.stringify(context.research?.findings), /п\. индекса/);
      } else assert.equal(m.observations[0].byDayType, undefined);
    }
    await check('Почему график так скочет? С чем это связано?', visits);
    insert({ text: 'Индекс заказов по продукту.', materials: [orders] });
    await check('Не, я про график визитов на страницу', visits);
    for (let i = 0; i < 20; i++) insert({ text: 'Реплика без графика' });
    s.close();
    s = openStore(path);
    initEvidence(s.db);
    initWorkbench(s.db);
    await check('А ты видишь как этот график скочет? Вот почему он так делает? Он как елочка', visits);
    await check('А ты видишь как этот график визитов на страницу скочет?', visits);
    insert({ text: 'Сравните два графика.', materials: [visits, orders] });
    enqueue(s, user, { thread, caseId, screen, question: 'А почему он такой?' });
    await workJobs(s, accounts, api, () => {
      throw Error('Уточнение должно происходить до обращения к модели');
    });
    const ask = messages(s.db, user, thread).items.at(-1).body;
    assert.deepEqual(ask.chartChoices, [visits.id, orders.id]);
    assert.match(ask.text, /Визиты/);
    assert.match(ask.text, /Индекс/);
    await check('Визиты', visits);
    insert({ text: 'Какой из них?', chartChoices: [visits.id, orders.id] });
    await check('Про второй', orders);
    enqueue(s, user, { thread, caseId, screen, question: 'Повтори показатели с экрана' });
    await workJobs(s, accounts, {});
    assert.equal(messages(s.db, user, thread).items.at(-1).body.calc, view.id);
    enqueue(s, user, { thread, caseId, screen, question: 'Сменим тему. Что такое CTR?' });
    await workJobs(s, accounts, {});
    enqueue(s, user, { thread, caseId, screen, question: 'Почему он такой?' });
    let ctx;
    await workJobs(s, accounts, api, async (_url, opts) => {
      ctx = JSON.parse(JSON.parse(opts.body).messages.at(-1).content).context;
      return say('Что именно вы хотите уточнить?');
    });
    assert.deepEqual(ctx.materials, []);
    assert.equal(ctx.visible.calc, view.id);
    const other = createThread(s.db, user, 'Другая беседа');
    enqueue(s, user, { thread: other, question: 'А почему он такой?' });
    await workJobs(s, accounts, {}, () => {
      throw Error('offline');
    });
    assert.equal(messages(s.db, user, other).items.at(-1).body.focusMaterialId, undefined);
  } finally {
    s.close();
  }
});
test('a representative chart uses the open case, handles an unavailable tool series and keeps an explicit chart request distinct', async () => {
  const s = open();
  try {
    const { caseId, thread, view } = sample(s);
    const question = 'Дай самый показательный график и скажи почему он такой';
    enqueue(s, user, { thread, caseId, question, screen: { calc: view.id, cards: ['summary', 'timeline'] } });
    let receipt;
    await workJobs(s, { publicUser: () => user }, api, async (_url, options) => {
      const m = JSON.parse(options.body).messages.at(-1);
      if (m.role === 'tool') {
        receipt = JSON.parse(m.content);
        return say(
          'На графике показан недельный индекс заказов. Для объяснения изменения нужно сверить его с событиями.',
        );
      }
      return Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'choice',
                  type: 'function',
                  function: {
                    name: 'chart',
                    arguments: JSON.stringify({
                      metric: 'Astra',
                      product: 'Astra',
                      field: 'events',
                      stat: 'sum',
                    }),
                  },
                },
              ],
            },
          },
        ],
      });
    });
    assert.equal(receipt.metric, 'orders_index');
    const answer = messages(s.db, user, thread).items.at(-1).body;
    assert.equal(answer.outcome, 'done');
    assert.deepEqual(
      answer.materials.map((m) => m.kind),
      ['chart', 'report'],
    );
    const plot = readMaterial(s.db, user, answer.materials[0].id).plot;
    assert.equal(plot.base.calcId, view.id);
    assert.deepEqual(
      plot.lines.map((l) => l.key),
      view.summary.map((v) => v.product),
    );
    const fromCatalog = workspaceOperation(s, user, 'chart', {
      metric: 'family_orders_idx',
      product: 'Astra',
      calc: view.id,
    });
    assert.equal(fromCatalog.id, view.id);
    assert.throws(
      () =>
        workspaceOperation(s, user, 'chart', {
          metric: 'orders_index',
          product: 'Astra',
          segment: 'desktop',
        }),
      /всех устройств/,
    );
  } finally {
    s.close();
  }
});

test('a metric picked by the model becomes the primary chart and old suggestions reopen the same saved points', async () => {
  const s = open();
  try {
    const { caseId, thread, view } = sample(s);
    const metric = 'cfg_family_views',
      product = 'Конфигуратор Астра';
    importDocs(s, [
      {
        file: 'Visits.xlsx',
        facts: [14, 9, 17].map((value, i) => ({
          kind: 'metrics',
          loc: 'Visits!A' + (i + 1),
          row: {
            metric_id: metric,
            product,
            segment: 'desktop',
            date: '2026-10-0' + (i + 1),
            unit: 'visits',
            value,
          },
        })),
      },
    ]);
    const call = { metric, product, title: 'Визиты на страницу семейства' };
    const saved = workspaceOperation(s, user, 'chart', call);
    assert.equal(saved.segment, 'desktop');
    assert.equal(saved.min.value, 9);
    enqueue(s, user, {
      thread,
      caseId,
      question: 'Дай самый показательный график и скажи почему он такой',
      screen: { calc: view.id, cards: ['summary'] },
    });
    await workJobs(s, { publicUser: () => user }, api, async (_url, options) => {
      const m = JSON.parse(options.body).messages.at(-1);
      if (m.role === 'tool')
        return say(
          'Показательным рядом являются визиты на страницу семейства. За три дня значение изменилось с 14 до 17.',
        );
      return Response.json({
        choices: [
          {
            message: {
              tool_calls: [
                {
                  id: 'visits',
                  type: 'function',
                  function: { name: 'chart', arguments: JSON.stringify(call) },
                },
              ],
            },
          },
        ],
      });
    });
    const result = messages(s.db, user, thread).items.at(-1).body;
    assert.equal(result.outcome, 'done');
    assert.equal(readMaterial(s.db, user, result.materials[0].id).plot.base.calcId, saved.id);
    s.db
      .prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES(?,'Агент','assistant',?,?)")
      .run(
        thread,
        JSON.stringify({
          text: 'Сохранённый график',
          steps: ['metrics', 'chart'],
          suggestions: [{ title: saved.title, calc: saved.id, cards: [], source: 'metric' }],
        }),
        Date.now(),
      );
    const recovered = messages(s.db, user, thread).items.at(-1).body.materials;
    assert.deepEqual(
      readMaterial(s.db, user, recovered[0].id).plot.lines[0].points.map((p) => p.value),
      [14, 9, 17],
    );
    assert.deepEqual(messages(s.db, user, thread).items.at(-1).body.materials, recovered);
  } finally {
    s.close();
  }
});
test('a repeated chart call opens the prepared metric and an unfulfilled chart cannot claim success', async () => {
  const s = open();
  try {
    const { thread, caseId, selection } = sample(s),
      accounts = { publicUser: () => user };
    enqueue(s, user, {
      thread,
      caseId,
      selection,
      question: 'Покажи график завершения подбора и разбери причины',
    });
    let receipt;
    await workJobs(s, accounts, api, async (_url, opts) => {
      const last = JSON.parse(opts.body).messages.at(-1);
      if (last.role === 'tool') {
        receipt = JSON.parse(last.content);
        return say('График построен. Завершение подбора снизилось.');
      }
      return Response.json({
        choices: [
          {
            message: {
              tool_calls: [{ id: 'chart-1', type: 'function', function: { name: 'chart', arguments: '{}' } }],
            },
          },
        ],
      });
    });
    assert.equal(receipt.metric, 'cfg_completion_rate');
    const good = messages(s.db, user, thread).items.at(-1).body;
    assert.equal(good.outcome, 'done');
    assert.deepEqual(
      good.materials.map((m) => m.kind),
      ['chart', 'report'],
    );
    const other = createThread(s.db, user, 'Без показателя');
    enqueue(s, user, { thread: other, question: 'Покажи график неизвестной метрики' });
    await workJobs(s, accounts, api, async () => say('График построен.'));
    const missing = messages(s.db, user, other).items.at(-1).body;
    assert.equal(missing.outcome, 'partial');
    assert.doesNotMatch(missing.text, /график построен/i);
    assert.equal(missing.materials.length, 0);
  } finally {
    s.close();
  }
});
test('chart and report retain the exact A/B observations, segment counts, source versions and separate links', async () => {
  const s = open();
  try {
    const { thread, caseId, selection } = sample(s);
    const input = {
      thread,
      caseId,
      question: 'Покажи график завершения подбора и разбери причины',
      requestId: 'once',
      selection,
    };
    const id = enqueue(s, user, input);
    assert.equal(enqueue(s, user, input), id);
    await workJobs(s, { publicUser: () => user }, {});
    const reply = messages(s.db, user, thread).items.at(-1).body;
    assert.deepEqual(
      reply.materials.map((m) => m.kind),
      ['chart', 'report'],
    );
    const [chart, report] = reply.materials.map((m) => readMaterial(s.db, user, m.id));
    assert.deepEqual(chart.ranges, selection.ranges);
    assert.deepEqual(report.ranges, selection.ranges);
    assert.ok(report.children.some((c) => c.id === chart.id));
    const mobile = report.sections
      .find((sec) => sec.title === 'Завершение подбора')
      .rows.find((row) => row[0] === 'Телефоны');
    assert.match(mobile[1], /90\/150/);
    assert.match(mobile[2], /100\/200/);
    assert.match(
      report.sections.find((sec) => sec.title === 'Добавление в корзину').rows[0][1],
      /Нет наблюдений/,
    );
    assert.ok(
      report.sections
        .find((sec) => sec.title === 'Завершение подбора')
        .sources.some((s) => s.includes('mobile!')),
    );
    importDocs(s, [
      {
        file: 'Updated.xlsx',
        facts: [
          {
            kind: 'metrics',
            loc: 'A1',
            row: {
              metric_id: 'cfg_completion_rate',
              product: 'Конфигуратор Астра',
              segment: 'mobile',
              date: '2026-10-05',
              unit: 'ratio',
              value: 0,
              detail_json: '{"open":50,"complete":0}',
            },
          },
        ],
      },
    ]);
    assert.deepEqual(readMaterial(s.db, user, chart.id), chart);
    enqueue(s, user, { ...input, requestId: 'repeat' });
    await workJobs(s, { publicUser: () => user }, {});
    const repeated = messages(s.db, user, thread).items.at(-1).body;
    assert.deepEqual(repeated.materials, reply.materials);
    const peer = { id: 'another', name: 'Коллега' };
    assert.throws(() => readMaterial(s.db, peer, report.id), /недоступен/);
    enqueue(s, user, {
      thread: 'group',
      question: 'Посмотри этот материал',
      materialIds: [report.id],
      shareMaterials: true,
    });
    assert.equal(readMaterial(s.db, peer, report.id, true).id, report.id);
    assert.equal(readMaterial(s.db, peer, chart.id, true).id, chart.id);
    assert.throws(() => workspaceOperation(s, peer, 'calc', { id: selection.calcId }), /недоступен/);
    enqueue(s, peer, {
      thread: 'group',
      question: 'Почему здесь?',
      materialIds: [chart.id],
      selection: { ...chart.plot.base, series: [chart.plot.lines[0].key], ranges: chart.ranges },
    });
  } finally {
    s.close();
  }
});
test('progress can resume a partial turn, updates one message and honours a subsequent topic change', async () => {
  const s = open();
  try {
    const { thread, caseId, selection, view } = sample(s);
    const accounts = { publicUser: () => user };
    const id = enqueue(s, user, { thread, caseId, selection, question: 'Проверь воронки сам' });
    await workJobs(s, accounts, api, async () => new Response('', { status: 401 }));
    const partial = messages(s.db, user, thread).items.at(-1).body;
    assert.equal(partial.outcome, 'partial');
    assert.ok(partial.materials.length);
    assert.equal(partial.canResume, true);
    assert.throws(() => resumeJob(s.db, { id: 'other' }, id));
    s.tx(() => resumeJob(s.db, user, id));
    await workJobs(s, accounts, api, async () => say('Расчёт завершения проверен.'));
    const items = messages(s.db, user, thread).items;
    assert.equal(items.length, 2);
    assert.equal(items[1].body.outcome, 'done');
    enqueue(s, user, { thread, caseId, question: 'Перейдём к другому вопросу. Что такое CTR?' });
    await workJobs(s, accounts, api, async (_url, opts) => {
      const c = JSON.parse(JSON.parse(opts.body).messages.at(-1).content).context;
      assert.equal(c.selection, null);
      return say('CTR — доля визитов с кликом.');
    });
    assert.equal(messages(s.db, user, thread).items.at(-1).body.rangeId, undefined);
    for (const env of [{}, api, { ...api, LLM_DATA_MODE: 'selection' }]) {
      enqueue(s, user, {
        thread,
        caseId,
        question: 'Повтори показатели с экрана',
        screen: { calc: view.id, cards: ['summary'] },
      });
      await workJobs(s, accounts, env, () => {
        throw Error('Сохранённый экран не требует модели');
      });
      assert.equal(messages(s.db, user, thread).items.at(-1).body.calc, view.id);
    }
    const parts = telegramParts(
      { text: '**Начало** ' + 'длинный текст '.repeat(800), materials: partial.materials },
      'https://app.example',
    );
    assert.ok(parts.length > 1 && parts.every((p) => p.length <= 4096));
    assert.ok(parts.join('').includes('/#material/' + partial.materials[0].id));
    assert.ok(!parts[0].includes('**'));
  } finally {
    s.close();
  }
});
test('case pins are idempotent, personal, durable and removable without deleting the linked material', async () => {
  const base = join(await mkdtemp(join(tmpdir(), 'agent-material-')), 'data.sqlite');
  let app;
  async function start() {
    app = createTeamApp({ base, env: { ADMIN_INVITE_KEY: 'local' }, background: false });
    await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  }
  async function post(op, b, cookie = '') {
    const r = await fetch('http://127.0.0.1:' + app.server.address().port + '/api/team/' + op, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(b),
    });
    return { status: r.status, b: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  }
  await start();
  try {
    const a = await post('register', {
      login: 'testpm',
      name: 'PM',
      password: 'test-password',
      code: 'local',
    });
    const s = app.space('team'),
      { thread, caseId, selection } = sample(s, a.b);
    enqueue(s, a.b, { thread, caseId, selection, question: 'Покажи график завершения подбора Astra' });
    await workJobs(s, app.accounts, {});
    const { id } = messages(s.db, a.b, thread).items.at(-1).body.materials[0],
      pin = { id, caseId };
    assert.equal((await post('pin-material', pin, a.cookie)).status, 200);
    await post('pin-material', pin, a.cookie);
    await app.close();
    await start();
    assert.equal((await post('case-materials', { caseId }, a.cookie)).b.items.length, 1);
    assert.deepEqual((await post('material', { id }, a.cookie)).b.pins, [caseId]);
    await post('pin-material', { ...pin, remove: true }, a.cookie);
    assert.equal((await post('case-materials', { caseId }, a.cookie)).b.items.length, 0);
    assert.equal((await post('material', { id }, a.cookie)).status, 200);
    const input = { id, createRequest: 'new-case-request' };
    const made = await post('pin-material', input, a.cookie);
    assert.equal(made.status, 200);
    assert.equal((await post('pin-material', input, a.cookie)).b.caseId, made.b.caseId);
    const preview = (await post('material', { id, preview: true }, a.cookie)).b;
    assert.equal(preview.sections, undefined);
    assert.ok(preview.plot.lines[0].points.length);
    assert.equal((await post('delete-thread', {thread}, a.cookie)).status, 200);
    assert.equal((await post('material', {id}, a.cookie)).status, 200);
    assert.equal((await post('pin-material', {id, caseId:made.b.caseId, remove:true}, a.cookie)).status, 200);
    assert.equal((await post('material', {id}, a.cookie)).status, 200);
  } finally {
    await app.close();
  }
});
