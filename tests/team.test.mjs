import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs, cases, analysisView, effect, updateCase, digest } from '../server/evidence.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { metrika } from '../server/connectors.mjs';
import { initWorkbench, deliver, createThread, deleteThread, enqueue, messages, workJobs } from '../server/workbench.mjs';
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

test('legacy chat history survives upgrade and deleted message numbers are not reused', () => {
  const store = openStore(':memory:');
  const user = { id: 'owner', name: 'Fixture' };
  try {
    initEvidence(store.db);
    store.db.exec('CREATE TABLE chat_items(seq INTEGER PRIMARY KEY,thread TEXT,author TEXT,role TEXT,body TEXT,created INTEGER)');
    store.db.prepare('INSERT INTO chat_items VALUES(42,?,?,?,?,?)').run('group', user.name, 'user', '{"text":"Old message"}', 1);
    initWorkbench(store.db);
    assert.equal(messages(store.db, user, 'group').items[0].body.text, 'Old message');
    assert.equal(messages(store.db, user, 'group').items[0].own, false);
    const id = createThread(store.db, user, 'Delete fixture');
    store.db.prepare("INSERT INTO chat_items(thread,author,role,body) VALUES(?,?,'user',?)")
      .run(id, 'Old display name', '{"text":"Older private message"}');
    assert.equal(messages(store.db, user, id).items[0].own, true);
    const write = store.db.prepare("INSERT INTO chat_items(thread,body) VALUES(?,'{}')");
    const removedSeq = write.run(id).lastInsertRowid;
    deleteThread(store, user, id);
    assert.ok(write.run('group').lastInsertRowid > removedSeq);
  } finally {
    store.close();
  }
});

test('group chat identifies the sender even if another participant has the same name', () => {
  const store = openStore(':memory:');
  const sender = { id: 'sender', name: 'Fixture' };
  const reader = { id: 'reader', name: 'Fixture' };
  try {
    initEvidence(store.db);
    initWorkbench(store.db);
    enqueue(store, sender, { thread: 'group', question: 'Отправленное сообщение' });
    assert.equal(messages(store.db, { ...sender, name: 'New name' }, 'group').items[0].own, true);
    assert.equal(messages(store.db, reader, 'group').items[0].own, false);
  } finally {
    store.close();
  }
});

test('a conversation can reply, clarify, and then calculate with thread-local chronological memory', async () => {
  const s = openStore(':memory:');
  const u = { id: 'qa', name: 'QA' },
    accounts = { publicUser: () => u };
  const env = {
    LLM_BACKEND: 'api',
    LLM_BASE_URL: 'https://example.invalid',
    LLM_MODEL: 'fixture',
    LLM_DATA_MODE: 'selection',
  };
  try {
    initEvidence(s.db);
    initWorkbench(s.db);
    importDocs(s, doc(Array.from({ length: 18 }, (_, i) => sales(i, 'Product A'))));
    const id = createThread(s.db, u, 'Диалог'),
      other = createThread(s.db, u, 'Отдельная беседа');
    s.db
      .prepare("INSERT INTO chat_items(thread,role,body) VALUES(?,'user',?)")
      .run(other, JSON.stringify({ text: 'Чужая переписка' }));
    const questions = ['Привет', 'Я хочу разобраться в конверсии', 'Посчитай CTR рекомендаций', 'Спасибо'];
    const calls = [];
    const send = async (_url, init) => {
      const request = JSON.parse(init.body);
      calls.push(request);
      const { question } = JSON.parse(request.messages.at(-1).content);
      const message =
        question === questions[2]
          ? {
              role: 'assistant',
              tool_calls: [
                {
                  id: 'analysis',
                  type: 'function',
                  function: {
                    name: 'investigate',
                    arguments: JSON.stringify({
                      product: 'Product A',
                      cards: ['ctr'],
                      full: true,
                      query: question,
                    }),
                  },
                },
              ],
            }
          : {
              role: 'assistant',
              content:
                question === questions[0]
                  ? 'Привет!'
                  : question === questions[1]
                    ? 'О каком шаге воронки речь?'
                    : 'Рад помочь.',
            };
      return Response.json({ choices: [{ message }] });
    };
    // Queue all four before processing to verify later messages cannot leak into earlier turns.
    for (const question of questions) enqueue(s, u, { thread: id, question });
    const count = () => s.one('SELECT count(*) AS n FROM evidence_calcs').n;
    await workJobs(s, accounts, env, send);
    await workJobs(s, accounts, env, send);
    assert.equal(count(), 0);
    await workJobs(s, accounts, env, send);
    assert.equal(count(), 1);
    await workJobs(s, accounts, env, send);
    assert.equal(count(), 1);
    const replies = messages(s.db, u, id)
      .items.filter((m) => m.role === 'assistant')
      .map((m) => m.body);
    assert.equal(replies[0].text, 'Привет!');
    assert.equal(replies[1].text, 'О каком шаге воронки речь?');
    for (const i of [0, 1, 3]) {
      assert.equal(replies[i].calc, undefined);
      assert.equal(replies[i].cards, undefined);
    }
    assert.ok(replies[2].calc);
    assert.deepEqual(replies[2].cards, ['ctr']);
    assert.equal(calls.length, 4);
    assert.ok(calls.every((r) => r.tool_choice === 'auto'));
    assert.deepEqual(
      calls[0].messages.map((m) => m.role),
      ['system', 'user'],
    );
    assert.deepEqual(calls[1].messages.slice(1, -1), [
      { role: 'user', content: 'Привет' },
      { role: 'assistant', content: 'Привет!' },
    ]);
    assert.ok(!JSON.stringify(calls).includes('Чужая переписка'));
    assert.ok(
      !JSON.stringify(calls[3]).includes(replies[2].text),
      'selection mode keeps calculated figures local',
    );
  } finally {
    s.close();
  }
});

test('offline or unavailable model never opens a sales report for small talk; mixed greetings still allow analysis', async () => {
  const s = openStore(':memory:'),
    u = { id: 'qa', name: 'QA' },
    accounts = { publicUser: () => u };
  try {
    initEvidence(s.db);
    initWorkbench(s.db);
    importDocs(s, doc([sales(1, 'Пример', 50)]));
    const id = createThread(s.db, u, 'Личный');
    const turn = async (question, env = {}) => {
      enqueue(s, u, { thread: id, question });
      await workJobs(s, accounts, env, async () => {
        throw Error('offline');
      });
      return messages(s.db, u, id).items.at(-1).body;
    };
    assert.match((await turn('Привет!')).text, /привет/i);
    assert.match((await turn('Что ты умеешь?')).text, /продакт/i);
    assert.equal((await turn('Давай поговорим')).calc, undefined);
    assert.match(
      (await turn('Привет', { LLM_BACKEND: 'gemini', LLM_API_KEY: 'fixture' })).warning,
      /локальный режим/i,
    );
    assert.equal(s.one('SELECT count(*) n FROM evidence_calcs').n, 0);
    const real = await turn('Привет, сравни продажи продукта Пример');
    assert.ok(real.calc);
    assert.match(real.text, /недостаточно/);
    assert.doesNotMatch(real.text, /—%/);
  } finally {
    s.close();
  }
});

test('Telegram fans out once per recipient, SMTP gets one link and repeated worker ticks are idle', async () => {
  const store = openStore(':memory:'),
    db = store.db;
  try {
    initEvidence(db);
    initWorkbench(db);
    const insert = db.prepare("INSERT INTO deliveries(id,channel,state,body) VALUES(?,?,'queued',?)");
    for (const ch of ['smtp', 'telegram'])
      insert.run(ch, ch, JSON.stringify({ caseId: 'example', text: 'Проверка', broadcast:true }));
    const env = {
      NOTIFICATIONS_ENABLED: 'true',
      TELEGRAM_CHAT_IDS: '11,22,11',
      TELEGRAM_CHANNEL_ID: '22',
      TELEGRAM_BOT_TOKEN: 'fixture',
      SMTP_HOST: 'example.invalid',
      SMTP_FROM: 'sender@example.invalid',
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
    assert.equal((await call('rename-thread', { thread: privateThread, title: 'Чужой чат' }, b.cookie)).s, 400);
    for (const title of ['   ', 'а'.repeat(121)]) {
      assert.equal((await call('rename-thread', { thread: privateThread, title }, a.cookie)).s, 400);
    }
    const renamed = await call('rename-thread', { thread: privateThread, title: '  Личный разбор  ' }, a.cookie);
    assert.equal(renamed.s, 200);
    assert.deepEqual(renamed.b, { id: privateThread, title: 'Личный разбор' });
    assert.deepEqual((await call('messages', { thread: privateThread }, a.cookie)).b.items, privateLog);

    const teamThreads = (await call('overview', {}, b.cookie)).b.threads;
    assert.ok(!teamThreads.some((t) => t.id === privateThread));
    assert.equal(teamThreads.find((t) => t.id === 'group').canRename, false);
    assert.equal((await call('rename-thread', { thread: 'group', title: 'Без разрешения' }, b.cookie)).s, 400);
    assert.equal((await call('rename-thread', { thread: 'group', title: 'Команда продукта' }, a.cookie)).s, 200);
    const customTeam = (await call('thread', { title: 'Рабочий чат', group: true }, b.cookie)).b.id;
    assert.equal((await call('rename-thread', { thread: customTeam, title: 'Встречи продукта' }, b.cookie)).s, 200);

    const v = (await call('view', { caseId: c.id }, a.cookie)).b.view;
    // The stored title may have changed since this case conversation was first opened.
    const legacyId = digest(a.b.id + '/' + c.id);
    const rangeThread = digest(a.b.id + '/chart/' + v.id);
    const insertThread = team.db.prepare("INSERT INTO conversations VALUES(?,?,'private',?)");
    insertThread.run(legacyId, a.b.id, renamed.b.title);
    insertThread.run(rangeThread, a.b.id, c.title);
    const rows = (await call('overview', {}, a.cookie)).b.threads;
    assert.equal(rows.find(t => t.id === legacyId).caseId, c.id);
    for (const id of [privateThread, rangeThread, 'group', customTeam]) {
      assert.equal(rows.find(t => t.id === id).caseId, null);
    }
    assert.equal((await call('case-thread', { caseId: c.id }, a.cookie)).b.id, legacyId);
    const memberCaseThread = (await call('case-thread', { caseId: c.id }, b.cookie)).b.id;
    const otherRows = (await call('overview', {}, b.cookie)).b.threads;
    assert.ok(!otherRows.some(t => t.id === legacyId));
    assert.equal(otherRows.find(t => t.id === memberCaseThread).caseId, c.id);
    const preview = await call('prepare_publish', { caseId: c.id, calc: v.id, cards: ['trend'] }, a.cookie);
    assert.equal(preview.s, 200);
    assert.equal(preview.b.recipient, 'Команда продукта');
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
      const task = await call(
        'draft',
        { caseId: c.id, title: 'Для проверки MCP', description: 'Сверить данные' },
        a.cookie,
      );
      const issue = (await call('confirm', { id: task.b.id }, a.cookie)).b;
      const prepared = await mcp.callTool({
        name: 'page_draft',
        arguments: { caseId: c.id, title: 'Страница из MCP', content: 'Вывод', issueKey: issue.key },
      });
      const preview = JSON.parse(prepared.content[0].text);
      assert.ok(preview.revision);
      assert.notEqual(
        (await call('confirm', { id: preview.id, revision: preview.revision }, b.cookie)).s,
        200,
      );
      const page = (await call('confirm', { id: preview.id, revision: preview.revision }, a.cookie)).b;
      for (const [name, args] of [
        ['issue_read', { key: issue.key }],
        ['page_read', { key: page.key }],
        ['page_search', { query: 'Страница из MCP' }],
      ]) {
        const http = await call(name, args, a.cookie);
        const tool = await mcp.callTool({ name, arguments: args });
        assert.equal(http.s, 200);
        assert.deepEqual(JSON.parse(tool.content[0].text), http.b);
      }
    } finally {
      await mcp.close();
    }
    await app.close();
    app = createTeamApp({ base: path, env, background: false });
    base = await localServer(app);
    assert.equal((await call('messages', { thread: privateThread }, a.cookie)).b.items.length, 2);
    const threads = (await call('overview', {}, a.cookie)).b.threads;
    assert.equal(threads.find((t) => t.id === privateThread).title, 'Личный разбор');
    assert.equal(threads.find((t) => t.id === 'group').title, 'Команда продукта');
    assert.equal(threads.find((t) => t.id === 'group').canDelete, false);
    assert.equal((await call('delete-thread', { thread: 'group' }, a.cookie)).s, 400);
    assert.equal((await call('delete-thread', { thread: privateThread }, b.cookie)).s, 400);
    const queued = await call('ask', { thread: privateThread, question: 'Ожидает ответа' }, a.cookie);
    assert.equal(queued.s, 200);
    assert.equal((await call('delete-thread', { thread: privateThread }, a.cookie)).s, 400);
    const db = app.space('team').db;
    db.prepare("UPDATE jobs SET status='done' WHERE id=?").run(queued.b.id);
    db.prepare("INSERT INTO snapshot_access VALUES('fixture-snapshot','thread',?)").run(privateThread);
    assert.deepEqual((await call('delete-thread', { thread: privateThread }, a.cookie)).b, { id: privateThread });
    assert.equal((await call('messages', { thread: privateThread }, a.cookie)).s, 400);
    assert.equal(db.prepare('SELECT count(*) n FROM chat_items WHERE thread=?').get(privateThread).n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM jobs WHERE thread=?').get(privateThread).n, 0);
    assert.equal(db.prepare('SELECT count(*) n FROM snapshot_access WHERE ref=?').get(privateThread).n, 0);
    assert.equal((await call('messages', { thread: 'group' }, b.cookie)).b.items.length, 1);
    assert.equal(
      (await call('login', { login: 'judge-one', password: 'fixture-password' })).b.space,
      judge.b.space,
    );
  } finally {
    await app.close();
  }
});
test('profile changes are limited to the signed-in account and persist across sessions', async () => {
  const base = join(await mkdtemp(join(tmpdir(), 'pm-profile-')), 'releases.sqlite');
  const env = { ADMIN_INVITE_KEY: 'profile-test' };
  const app = createTeamApp({ base, env, background: false });
  try {
    const url = await localServer(app);
    const post = (op, body, token) => fetch(url + '/api/team/' + op, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(token && { cookie: 'pm_session=' + token }) },
      body: JSON.stringify(body),
    });
    const password = 'fixture-password';
    const { user: admin } = await app.accounts.register(
      { login: 'profile-admin', name: 'Админ', password, code: env.ADMIN_INVITE_KEY }, env,
    );
    const { token } = await app.accounts.register(
      { login: 'profile-member', name: 'Участник', password, code: app.accounts.invite('team') }, env,
    );
    assert.equal((await post('profile', { name: 'Гость' })).status, 401);
    assert.equal((await post('profile', { name: '  ' }, token)).status, 400);
    assert.equal((await post('profile', { name: 'Другое имя', avatar: 'data:image/svg+xml;base64,PHN2Zz4=' }, token)).status, 400);
    const session = await fetch(url + '/api/team/session', { headers: { cookie: 'pm_session=' + token } });
    assert.equal((await session.json()).user.name, 'Участник');
    const change = await post('profile', { id: admin.id, role: 'admin', login: 'new-login', name: ' Мария Орлова ' }, token);
    assert.equal(change.status, 200);
    const updated = await change.json();
    assert.equal(updated.name, 'Мария Орлова');
    assert.equal(updated.login, 'profile-member');
    assert.equal(updated.role, 'member');
    assert.equal(app.accounts.publicUser(admin.id).name, 'Админ');
    const login = await post('login', { login: 'profile-member', password });
    assert.deepEqual(await login.json(), updated);
  } finally {
    await app.close();
  }
});
test('Metrika paginates with sampling metadata', async () => {
  let n = 0;
  const r = await metrika({ METRIKA_COUNTER_IDS: '123', METRIKA_TOKEN: 'fixture' }, async (url, init) => {
    assert.equal(init.headers.Authorization, 'OAuth fixture');
    n++;
    return Response.json({
      data: [{ dimensions: [{ name: n === 1 ? '2026-01-01' : '2026-01-02' }], metrics: [3] }],
      total_rows: 2,
      sampled: true,
      sample_share: 0.8,
    });
  });
  assert.equal(n, 2);
  assert.equal(r.docs[0].facts.length, 2);
  assert.equal(r.samples[0].share, 0.8);
});
