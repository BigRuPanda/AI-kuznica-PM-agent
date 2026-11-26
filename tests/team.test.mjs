import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs, cases, analysisView, effect, updateCase } from '../server/evidence.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { jira, metrika } from '../server/connectors.mjs';
import { initWorkbench, deliver } from '../server/workbench.mjs';
const WEEK = 604800000;
const date = (i) => new Date(Date.UTC(2026, 0, 5) + i * WEEK).toISOString().slice(0, 10);
function sales(i, p = 'A', value = i < 12 ? 100 : 40, partial = false) {
  return {
    kind: 'sales',
    loc: 'Продажи!A' + (i + 2),
    row: {
      week_start: date(i),
      product_family: p,
      orders_index: value,
      comment: partial ? 'Неделя неполная' : null,
    },
  };
}
const doc = (facts) => [{ file: 'Generated for testing.xlsx', facts }];

test('Telegram fans out once per recipient, SMTP gets one link and repeated worker ticks are idle', async () => {
  const store = openStore(':memory:'),
    db = store.db;
  try {
    initEvidence(db);
    initWorkbench(db);
    const insert = db.prepare("INSERT INTO deliveries(id,channel,state,body) VALUES(?,?,'queued',?)");
    for (const ch of ['smtp', 'telegram'])
      insert.run(ch, ch, JSON.stringify({ caseId: 'example', text: 'Проверка' }));
    const env = {
      NOTIFICATIONS_ENABLED: 'true',
      TELEGRAM_CHAT_IDS: '11,22,11',
      TELEGRAM_CHANNEL_ID: '22',
      TELEGRAM_BOT_TOKEN: 'fixture',
      SMTP_HOST: 'example.invalid',
      SMTP_TO: 'demo@example.invalid',
      APP_BASE_URL: 'https://example.invalid',
    };
    const ids = [],
      emails = [];
    for (let i = 0; i < 7; i++)
      await deliver(
        store,
        env,
        async (url, init) => {
          ids.push(JSON.parse(init.body).chat_id);
          return Response.json({ result: { message_id: 1 } });
        },
        async (text) => emails.push(text),
      );
    assert.deepEqual(ids, ['11', '22']);
    assert.equal(emails.length, 1);
    assert.match(emails[0], /#case\/example/);
  } finally {
    store.close();
  }
});
async function localServer(app) {
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  return 'http://127.0.0.1:' + app.server.address().port;
}
test('weekly replay, versioned calculations, source threshold, duplicate import, no partial-week promotion', () => {
  const s = openStore(':memory:');
  try {
    initEvidence(s.db);
    importDocs(
      s,
      doc([
        {
          kind: 'dictionary',
          loc: 'Dictionary!A2',
          row: { metric_id: 'family_orders_idx', bad_signal: 'Индекс ниже 90 две недели подряд' },
        },
      ]),
    );
    for (let i = 0; i < 16; i++) importDocs(s, doc([sales(i), sales(i, 'B', 110)]));
    const first = cases(s.db).find((c) => c.body.signal.rule === 'relative');
    assert.ok(first);
    assert.equal(first.body.signal.change, -60);
    assert.equal(first.body.signal.count, 1);
    assert.equal(s.db.prepare('select count(*) n from alerts where case_id=?').get(first.id).n, 0);
    importDocs(s, doc([sales(16, 'A', 40, true)]));
    assert.equal(cases(s.db).find((c) => c.id === first.id).body.signal.count, 1);
    const complete = doc([sales(16), sales(16, 'B', 110)]);
    importDocs(s, complete);
    const alert = s.db.prepare('select * from alerts where case_id=?').get(first.id);
    assert.equal(alert.week, date(16));
    assert.equal(importDocs(s, complete).inserted, 0);
    assert.equal(s.db.prepare('select count(*) n from deliveries where id like ?').get(first.id + '%').n, 2);
    const a = analysisView(s.db, { caseId: first.id }),
      old = JSON.stringify(a.summary);
    importDocs(s, doc([sales(15, 'A', 35)]));
    assert.equal(
      JSON.stringify(
        JSON.parse(s.db.prepare('select body from evidence_calcs where id=?').get(a.id).body).summary,
      ),
      old,
    );
    first.body.watch = { deployed: date(17), control: 'B', controlBase: 110, target: 90, tolerance: 10 };
    updateCase(s.db, first);
    assert.match(effect(s.db, first).state, /Ожидаем/);
    for (let i = 17; i <= 20; i++) importDocs(s, doc([sales(i, 'A', 95), sales(i, 'B', 110)]));
    assert.equal(effect(s.db, first).state, 'Цель достигнута');
  } finally {
    s.close();
  }
});
test('accounts, private and group chat, isolated judges, publish, MCP parity, durable task, confirmed local issue and restart', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'pm-team-')), 'legacy.sqlite');
  const env = { ADMIN_INVITE_KEY: 'admin-test', DEMO_INVITE_KEY: 'judge-test' };
  let app = createTeamApp({ base: path, env, background: false }),
    base = await localServer(app);
  const call = async (op, b, cookie) => {
    const r = await fetch(base + '/api/team/' + op, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) },
      body: JSON.stringify(b),
    });
    return { s: r.status, b: await r.json(), cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const register = async (login, code) => {
    const r = await call('register', { login, name: login, code, password: 'fixture-password' });
    assert.equal(r.s, 200, JSON.stringify(r.b));
    return r;
  };
  try {
    const a = await register('analyst', 'admin-test'),
      inv = await call('invite', {}, a.cookie),
      b = await register('product', inv.b.code);
    assert.notEqual(
      (await call('register', { login: 'intruder', name: 'I', password: '12345678', code: inv.b.code })).s,
      200,
    );
    const team = app.space('team');
    importDocs(team, doc(Array.from({ length: 18 }, (_, i) => sales(i))));
    team.db.prepare('INSERT INTO settings VALUES(?,?)').run(
      'demo_versions',
      JSON.stringify(
        team.db
          .prepare('SELECT version FROM documents')
          .all()
          .map((r) => r.version),
      ),
    );
    const c = cases(team.db)[0],
      privateThread = (await call('thread', { title: 'Private' }, a.cookie)).b.id;
    assert.notEqual((await call('messages', { thread: privateThread }, b.cookie)).s, 200);
    const question = {
      thread: privateThread,
      caseId: c.id,
      question: 'Почему изменилось?',
      requestId: 'once',
    };
    const job = (await call('ask', question, a.cookie)).b.id;
    assert.equal((await call('ask', question, a.cookie)).b.id, job);
    await app.tick();
    for (
      let i = 0;
      i < 25 && team.db.prepare('select status from jobs where id=?').get(job).status !== 'done';
      i++
    )
      await new Promise((r) => setTimeout(r, 20));
    const privateLog = (await call('messages', { thread: privateThread }, a.cookie)).b.items;
    assert.equal(privateLog.length, 2);
    const v = (await call('view', { caseId: c.id }, a.cookie)).b.view;
    await call('publish', { caseId: c.id, calc: v.id, cards: ['trend'] }, a.cookie);
    const shared = (await call('messages', { thread: 'group' }, b.cookie)).b.items;
    assert.equal(shared.length, 1);
    assert.equal(shared[0].body.calc, v.id);
    const judge = await register('judge-one', 'judge-test'),
      judge2 = await register('judge-two', 'judge-test');
    const dc = (await call('overview', {}, judge.cookie)).b.cases[0];
    const draft = (
      await call(
        'draft',
        { caseId: dc.id, title: 'Проверка пути', description: 'Проверить события' },
        judge.cookie,
      )
    ).b;
    const confirm = (await call('confirm', { id: draft.id }, judge.cookie)).b;
    assert.match(confirm.key, /^DEMO-/);
    assert.equal((await call('confirm', { id: draft.id }, judge.cookie)).b.key, confirm.key);
    assert.notEqual((await call('confirm', { id: draft.id }, judge2.cookie)).s, 200);
    assert.equal((await call('messages', { thread: 'group' }, judge.cookie)).b.items.length, 0);
    const key = (await call('mcp-key', {}, a.cookie)).b.key;
    const mcp = new Client({ name: 'pm-acceptance', version: '1' });
    try {
      await mcp.connect(
        new StreamableHTTPClientTransport(new URL(base + '/mcp'), {
          requestInit: { headers: { Authorization: 'Bearer ' + key } },
        }),
      );
      const result = await mcp.callTool({ name: 'analyze_case', arguments: { caseId: c.id } });
      assert.equal(JSON.parse(result.content[0].text).id, v.id);
    } finally {
      await mcp.close();
    }
    await app.close();
    app = createTeamApp({ base: path, env, background: false });
    base = await localServer(app);
    assert.equal((await call('messages', { thread: privateThread }, a.cookie)).b.items.length, 2);
    assert.equal(
      (await call('login', { login: 'judge-one', password: 'fixture-password' })).b.space,
      judge.b.space,
    );
  } finally {
    await app.close();
  }
});
test('Jira Cloud and Data Center select matching APIs and tag confirmed issues; Metrika paginates with sampling metadata', async () => {
  for (const edition of ['cloud', 'dc']) {
    const calls = [];
    const api = jira(
      {
        JIRA_EDITION: edition,
        JIRA_BASE_URL: 'https://example.invalid',
        JIRA_EMAIL: 'pm@example.invalid',
        JIRA_TOKEN: 'fixture',
        JIRA_PROJECT: 'PM',
      },
      async (url, init) => {
        calls.push({ url, init });
        return Response.json(url.includes('search') ? { issues: [] } : { key: 'PM-1' });
      },
    );
    await api.search('лицензия');
    await api.create('Проверить', 'Описание', 'pm-123');
    assert.ok(calls[0].url.endsWith(edition === 'cloud' ? '/3/search/jql' : '/2/search'));
    const fields = JSON.parse(calls[1].init.body).fields;
    assert.ok(fields.labels.includes('ai-generated'));
    assert.match(JSON.stringify(fields.description), /сгенерирована ИИ-помощником/);
  }
  let n = 0;
  const r = await metrika({ METRIKA_COUNTER_IDS: '123', METRIKA_TOKEN: 'fixture' }, async (url, init) => {
    assert.equal(init.headers.Authorization, 'OAuth fixture');
    n++;
    return Response.json({
      data: [{ dimensions: [{ name: '2026-01-01' }], metrics: [3] }],
      total_rows: n === 1 ? 10001 : 1,
      sampled: true,
      sample_share: 0.8,
    });
  });
  assert.equal(n, 2);
  assert.equal(r.docs[0].facts.length, 2);
  assert.equal(r.samples[0].share, 0.8);
});
