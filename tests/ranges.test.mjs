import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs } from '../server/evidence.mjs';
import { initWorkbench, enqueue, workJobs, messages, createThread } from '../server/workbench.mjs';
import { grant, readRange, compareRanges } from '../server/chart-ranges.mjs';
import { workspaceOperation as op } from '../server/workspace-operations.mjs';
import { runTool } from '../server/analytics.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
const a = { id: 'one', name: 'PM', role: 'member' },
  b = { id: 'two', name: 'QA', role: 'member' };
const week = 604800000,
  day = 86400000,
  start = Date.UTC(2026, 8, 7);
const at = (n) => start + n * week;
const windows = [
  { from: at(0), to: at(2) },
  { from: at(2), to: at(5) },
];
function open() {
  const s = openStore(':memory:');
  initEvidence(s.db);
  initWorkbench(s.db);
  return s;
}
function seed(s) {
  const rows = { Product: [0, 0, 80, null, 40], Control: [0, null, 70, 210, 50] };
  const facts = Object.entries(rows).flatMap(([product, values]) =>
    values.flatMap((v, i) =>
      v === null
        ? []
        : [
            {
              kind: 'sales',
              loc: product + '!A' + (i + 2),
              row: {
                product_family: product,
                week_start: new Date(at(i)).toISOString().slice(0, 10),
                orders_index: v,
                comment: i === 4 ? 'неполная неделя' : null,
              },
            },
          ],
    ),
  );
  importDocs(s, [{ file: 'Synthetic.xlsx', facts }], { notify: false });
}
function scene(s, user = a) {
  const c = op(s, user, 'create-case', { title: 'Example', product: 'Product' });
  const v = op(s, user, 'view', { caseId: c.id, releaseWeek: '2026-09-14' }).view;
  return {
    c,
    v,
    ref: {
      source: 'weekly',
      metric: 'orders_index',
      calcId: v.id,
      version: v.id,
      series: ['Product', 'Control'],
      ranges: windows,
    },
  };
}
test('weekly ranges use frozen rows, unequal windows, common weeks and explicit zero/missing/partial values', () => {
  const s = open();
  try {
    seed(s);
    const { c, ref } = scene(s);
    const r = compareRanges(s, a, ref);
    assert.equal(r.periods[0].series[0].value, 0);
    assert.equal(r.periods[0].expected, 2);
    assert.equal(r.periods[1].expected, 3);
    assert.equal(r.periods[1].series[0].available, 2);
    assert.equal(r.periods[1].series[0].value, 60);
    assert.equal(r.periods[1].series[0].partial, 1);
    assert.equal(r.periods[1].commonDates.length, 2);
    assert.equal(r.periods[1].series[1].commonValue, 60);
    assert.equal(r.periods[1].series[1].value, 110);
    assert.equal(r.differences[0].absolute, 60);
    assert.equal(r.differences[0].relative, null);
    assert.throws(() => compareRanges(s, b, ref), /недоступен/);
    assert.throws(() => readRange(s.db, b, r.id), /недоступен/);
    assert.throws(() => compareRanges(s, a, { ...ref, version: 'other' }), /Версия/);
    assert.throws(() => compareRanges(s, a, { ...ref, ranges: [{ from: at(0) + 1, to: at(1) }] }), /Границы/);
    assert.throws(() => enqueue(s, a, { thread: 'group', question: 'здесь?', rangeId: r.id }), /недоступен/);
    const pending = op(s, a, 'prepare_publish', { caseId: c.id, rangeId: r.id, conclusion: 'Пример.' });
    assert.throws(() => op(s, b, 'approve_preview', { id: pending.id }), /недоступен/);
    op(s, a, 'approve_preview', { id: pending.id });
    op(s, a, 'approve_preview', { id: pending.id });
    assert.deepEqual(readRange(s.db, b, r.id), r);
    assert.match(
      op(s, a, 'selection_context', { id: r.id }, {}, fetch, true).reason,
      /только выбранные интервалы/,
    );
    assert.equal(s.one('select count(*) n from published').n, 1);
    importDocs(s, [
      {
        file: 'Correction.xlsx',
        facts: [
          {
            kind: 'sales',
            loc: 'Product!D4',
            row: { product_family: 'Product', week_start: '2026-09-21', orders_index: 314 },
          },
        ],
      },
    ]);
    assert.equal(compareRanges(s, a, ref).id, r.id);
  } finally {
    s.close();
  }
});
test('release ranges recompute unique companies, median and P90 over observations on the original version', () => {
  const s = open();
  try {
    const origin = Date.parse('2026-10-05T07:00:00Z'),
      time = (i, h = 0) => new Date(origin + i * day + h * 3600000).toISOString();
    const csv = [
      'company_id,order_id,invoice_id,event_type,event_at,amount_rub',
      ...[10, 20, 30, 200].flatMap((price, i) => [
        'C1,O' + i + ',I' + i + ',checkout_started,' + time(i === 3 ? 1 : 0, 1) + ',',
        'C1,O' + i + ',I' + i + ',payment_received,' + time(i === 3 ? 1 : 0, 2) + ',' + price,
      ]),
    ].join('\n');
    const ds = s.importCSV({ name: 'Fixture', csv, completeThrough: time(18) }),
      rel = s.create({
        title: 'Оплаты по дням', description: 'Изменение оформления заказа', audience: 'Компании',
        question: 'Как изменились оплаты?', dataset: ds.dataset, activatedAt: time(0),
      });
    for (const [metric, stat, expected] of [
      ['0', null, 100],
      ['derived', 'median', 25],
      ['derived', 'p90', 149],
    ]) {
      const q = { releaseId: rel.id, day: 14, metric: 0, spec: { field: 'amount', stat, end: 'payment' } };
      const c = runTool(s, stat ? 'build_chart' : 'compare_metric', q);
      const ref = {
        source: 'release',
        calcId: c.id,
        version: c.context.version,
        metric,
        series: ['all'],
        ranges: [{ from: origin, to: origin + 2 * day }],
      };
      const r = compareRanges(s, a, ref).periods[0].series[0];
      assert.ok(Math.abs(r.value - expected) < 1e-7);
      if (!stat) assert.deepEqual([r.n, r.d], [1, 1]);
    }
  } finally {
    s.close();
  }
});
const env = {
  LLM_BACKEND: 'api',
  LLM_MODEL: 'fixture',
  LLM_BASE_URL: 'https://example.invalid',
  LLM_DATA_MODE: 'analysis',
};
function say(text) {
  return { role: 'assistant', content: text };
}
function call(name, args, id = 'tool') {
  return {
    role: 'assistant',
    content: '',
    tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  };
}
function model(fn) {
  return async (url, init) => {
    const req = JSON.parse(init.body);
    return Response.json({
      choices: [{ message: fn(req) }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    });
  };
}
test('case follow-ups receive the displayed figures and retry an unrelated greeting', async () => {
  const s = open();
  try {
    seed(s);
    const { c, v } = scene(s);
    const thread = createThread(s.db, a, 'Обсуждение разбора');
    const accounts = { publicUser: () => a };
    const screen = { calc: v.id, cards: ['trend'] };
    const questions = ['Что об этом думаешь?', 'То думаешь об этом разборе?'];
    for (const [i, question] of questions.entries()) {
      let calls = 0;
      enqueue(s, a, { thread, caseId: c.id, question, screen });
      await workJobs(s, accounts, env, model((req) => {
        const current = JSON.parse(req.messages.at(-1).content);
        assert.equal(current.question, question);
        assert.equal(current.context.investigation.title, c.title);
        assert.equal(current.context.visible.calc, v.id);
        assert.equal(current.context.visible.period.comparisonWeek, v.pivot);
        assert.equal(current.context.visible.ordersIndex[0].after, v.summary[0].after);
        assert.equal(current.context.visible.ordersIndex[0].before, 0);
        assert.equal(current.context.visible.ordersIndex[0].rows, undefined);
        if (++calls === 1 || i === 1) return say('Привет!');
        assert.match(req.messages[0].content, /Дай содержательный ответ/);
        return say('После контрольной недели индекс вырос. Проверьте, сохраняется ли рост без неполной недели.');
      }));
      const reply = messages(s.db, a, thread).items.at(-1).body;
      assert.equal(calls, 2);
      assert.match(reply.text, i === 0 ? /индекс вырос/ : /что оценить в разборе/);
    }
  } finally {
    s.close();
  }
});
test('conversation, selection investigation, follow-up, a single persisted draft and crash replay', async () => {
  const s = open();
  try {
    seed(s);
    const { c, ref } = scene(s),
      tid = createThread(s.db, a, 'Личное'),
      accounts = { publicUser: () => a };
    const turn = async (question, fn, extra = {}) => {
      const id = enqueue(s, a, { thread: tid, caseId: c.id, question, requestId: question, ...extra });
      await workJobs(s, accounts, env, model(fn));
      return { id, reply: messages(s.db, a, tid).items.at(-1).body };
    };
    const hello = await turn('Привет', () => say('Привет!'));
    assert.equal(hello.reply.text, 'Привет!');
    assert.equal(hello.reply.steps.length, 0);
    let calls = 0;
    const investigation = await turn(
      'Почему здесь снизился индекс?',
      (req) => {
        if (calls++ === 0) {
          assert.equal(JSON.parse(req.messages.at(-1).content).context.selection.periods.length, 2);
          return call('search', { query: 'Product', kinds: ['releases'] });
        }
        if (calls === 2) {
          assert.equal(req.messages.at(-1).role, 'tool');
          assert.ok(req.messages.at(-2).tool_calls?.length);
          return call('view', { caseId: c.id });
        }
        return say('В выделении две доступные недели. Контекст проверен.');
      },
      { selection: ref },
    );
    assert.equal(investigation.reply.steps.length, 2);
    assert.ok(investigation.reply.rangeId);
    assert.ok(!investigation.reply.personal);
    const follow = await turn('Что могло бы опровергнуть гипотезу?', (req) => {
      if (req.messages.at(-1).role === 'tool') return say('Проверяем альтернативу.');
      assert.equal(JSON.parse(req.messages.at(-1).content).context.selection.id, investigation.reply.rangeId);
      return call('selection_context', { id: investigation.reply.rangeId });
    });
    assert.equal(follow.reply.rangeId, investigation.reply.rangeId);
    let n = 0;
    const draft = await turn('Подготовь задачу для QA с планом проверки причины снижения, пока никому не отправляй', () =>
      ++n <= 2
        ? call('draft', { title: 'Проверить', description: 'Сверить события.' }, String(n))
        : say('Черновик сохранён.'),
    );
    assert.equal(draft.reply.outcome, 'done');
    assert.equal(n, 3);
    assert.equal(s.one('select count(*) n from draft_actions').n, 1);
    assert.ok(draft.reply.actions[0].description.includes('#range/'));
    assert.equal(s.one('select count(*) n from local_issues').n, 0);
    // Simulate recovery after receipt persistence, before the final chat write.
    s.db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(draft.id);
    await workJobs(
      s,
      accounts,
      env,
      model(() => {
        throw Error('completed plan should be reused');
      }),
    );
    assert.equal(s.one('select count(*) n from draft_actions').n, 1);
    assert.equal(s.one('select count(*) n from agent_steps where job=?', draft.id).n, 2);
  } finally {
    s.close();
  }
});
test('web and remote MCP return the same range snapshot and deny a second private account', async () => {
  const base = join(await mkdtemp(join(tmpdir(), 'range-acl-')), 'db.sqlite'),
    app = createTeamApp({ base, env: { ADMIN_INVITE_KEY: 'secret' }, background: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const url = 'http://127.0.0.1:' + app.server.address().port;
  const post = async (op, b, cookie = '') => {
    const r = await fetch(url + '/api/team/' + op, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(b),
    });
    return { status: r.status, body: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const client = new Client({ name: 'ranges', version: '1' });
  try {
    const admin = await post('register', {
        login: 'admin',
        name: 'PM',
        password: 'fixture-pass',
        code: 'secret',
      }),
      invite = await post('invite', {}, admin.cookie);
    const other = await post('register', {
      login: 'partner',
      name: 'QA',
      password: 'fixture-pass',
      code: invite.body.code,
    });
    const s = app.space('team');
    seed(s);
    const { ref } = scene(s, admin.body);
    const web = await post('range_compare', { selection: ref }, admin.cookie);
    assert.equal(web.status, 200);
    const token = (await post('mcp-key', {}, admin.cookie)).body.key;
    await client.connect(
      new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
        requestInit: { headers: { Authorization: 'Bearer ' + token } },
      }),
    );
    const remote = await client.callTool({ name: 'range_compare', arguments: { selection: ref } });
    assert.deepEqual(JSON.parse(remote.content[0].text), web.body);
    assert.notEqual((await post('calc', { id: ref.calcId }, other.cookie)).status, 200);
    assert.notEqual((await post('range_read', { id: web.body.id }, other.cookie)).status, 200);
  } finally {
    await client.close();
    await app.close();
  }
});
test('metric chart A/B combines raw numerators and denominators and explains missing aggregation support', () => {
  const s = open();
  try {
    const raw = [
      [1, 10],
      [9, 90],
      [3, 5],
    ];
    const rows = raw.map(([clicks, visits], i) => ({
      kind: 'metrics',
      loc: 'M!A' + (i + 2),
      row: {
        metric_id: 'lk_reco_ctr',
        product: 'Store',
        segment: 'all',
        date: new Date(at(i)).toISOString().slice(0, 10),
        value: clicks / visits,
        unit: 'ratio',
        detail_json: JSON.stringify({ click_visits: clicks, viewed_visits: visits }),
      },
    }));
    importDocs(s, [{ file: 'Synthetic.xlsx', facts: rows }], { notify: false });
    const chart = op(s, a, 'chart', { metric: 'lk_reco_ctr', product: 'Store', segment: 'all' }),
      r = op(s, a, 'range_compare', {
        selection: {
          source: 'metric',
          calcId: chart.id,
          metric: 'lk_reco_ctr',
          series: ['all'],
          ranges: [{ from: at(0), to: at(3) }],
        },
      });
    assert.equal(r.periods[0].series[0].n, 13);
    assert.equal(r.periods[0].series[0].d, 105);
    assert.equal(r.periods[0].series[0].value, 1300 / 105);
    assert.throws(() => op(s, b, 'calc', { id: chart.id }), /недоступен/);
  } finally {
    s.close();
  }
});
test('checkpoint before final answer resumes without a second write; repeating a denied write stops', async () => {
  const s = open();
  try {
    seed(s);
    const { c } = scene(s),
      t = createThread(s.db, a, 'Private'),
      accounts = { publicUser: () => a };
    const j = enqueue(s, a, { thread: t, caseId: c.id, question: 'Подготовь черновик для QA' });
    let checkpoint,
      n = 0;
    await workJobs(
      s,
      accounts,
      env,
      model((req) => {
        if (!n++) return call('draft', { title: 'QA', description: 'Check measure' });
        checkpoint = s.one('SELECT body FROM agent_turns WHERE job=?', j).body;
        assert.ok(req.messages.at(-2).tool_calls?.length);
        return say('Готово.');
      }),
    );
    s.db.prepare('UPDATE agent_turns SET body=? WHERE job=?').run(checkpoint, j);
    s.db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(j);
    n = 0;
    await workJobs(
      s,
      accounts,
      env,
      model(() =>
        !n++ ? call('draft', { title: 'QA', description: 'Check measure' }, 'replayed') : say('Готово.'),
      ),
    );
    assert.equal(s.one('select count(*) n from draft_actions').n, 1);
    enqueue(s, a, { thread: t, caseId: c.id, question: 'Стоит ли создать задачу?' });
    n = 0;
    await workJobs(
      s,
      accounts,
      env,
      model(() => call('draft', { title: 'Unwanted', description: 'Another draft' }, String(++n))),
    );
    assert.equal(n, 2);
    assert.equal(s.one('select count(*) n from draft_actions').n, 1);
    enqueue(s, a, { thread: t, caseId: c.id, question: 'Проверь варианты' });
    n = 0;
    await workJobs(
      s,
      accounts,
      env,
      model(() => call('search', { query: 'variant ' + ++n })),
    );
    assert.equal(n, 6);
    assert.match(messages(s.db, a, t).items.at(-1).body.text, /шесть/);
  } finally {
    s.close();
  }
});

test('temporary provider outage repeats only the model turn and preserves the selected facts and draft', async () => {
  const s = open();
  try {
    seed(s);
    const { c, ref } = scene(s),
      id = createThread(s.db, a, 'Retry'),
      accounts = { publicUser: () => a };
    enqueue(s, a, { thread: id, caseId: c.id, question: 'Подготовь черновик задачи для QA', selection: ref });
    let attempts = 0;
    await workJobs(s, accounts, env, async (url, init) => {
      attempts++;
      if (attempts === 1)
        return model(() => call('draft', { title: 'QA review', description: 'Check range' }))(url, init);
      return new Response('', { status: 503 });
    });
    const answer = messages(s.db, a, id).items.at(-1).body;
    assert.equal(attempts, 3);
    assert.match(answer.warning, /503/);
    assert.match(answer.text.split('\n')[0],/^Не удалось.*503/);
    assert.match(answer.text, /A · Product/);
    assert.equal(s.one('select count(*) n from draft_actions').n, 1);
    assert.equal(answer.actions.filter((x) => x.op === 'draft').length, 1);
    assert.ok(answer.rangeId);
  } finally {
    s.close();
  }
});
