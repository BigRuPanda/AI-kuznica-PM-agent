import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createServer as createSocketServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamApp } from '../server/team-http.mjs';
import { openAccounts } from '../server/accounts.mjs';
import { initContacts } from '../server/notification-contacts.mjs';
import { collectClosures } from '../server/redmine-bridge.mjs';
import { createThread, deliver, enqueue } from '../server/workbench.mjs';
import { digest, getCase, importDocs, initEvidence } from '../server/evidence.mjs';
import { observedEffect } from '../server/effect-plan.mjs';
import { approveSource, importApproved, sourceHistory, sourcePermission } from '../server/source-policy.mjs';
import { openStore } from '../server/store.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';

test('verified contacts, private results, Redmine confirmation and one delivery per channel', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-web-'));
  const env = {
    ADMIN_INVITE_KEY: 'admin-invite',
    TELEGRAM_BOT_TOKEN: 'fixture',
    TELEGRAM_WEBHOOK_SECRET: 'test-secret',
    TELEGRAM_BOT_USERNAME: 'signal_test_bot',
    SIGNAL_BRIDGE_URL: 'http://localhost:18880',
    SMTP_HOST: 'mail.invalid',
    SMTP_FROM: 'test@example.invalid',
    DEMO_INVITE_KEY: 'guest',
  };
  const mail = [],
    telegram = [],
    tasks = [],
    report = {
      id: 'snapshot',
      start: '2026-10-01',
      end: '2026-10-14',
      periods: [
        [40, 2],
        [60, 5],
      ],
      web: 'https://metrika.yandex.ru/',
      status: 'Наблюдение',
    };
  let closures = [];
  const notes = [];
  const send = async (url, opts) => {
    const path = new URL(url).pathname;
    if (path === '/reports/latest') return Response.json(report);
    if (path === '/tasks') {
      const body = JSON.parse(opts.body);
      tasks.push(body);
      return Response.json({ ...body, redmine_id: 17, url: 'http://localhost:18881/issues/17' });
    }
    if (path === '/closures')
      return Response.json(closures.filter((r) => r.seq > Number(new URL(url).searchParams.get('after'))));
    if (path === '/tasks/' + tasks[0]?.reference + '/details')
      return Response.json({
        key: 'Redmine #17',
        url: 'http://localhost:18881/issues/17',
        title: tasks[0].title,
        comments: notes,
      });
    if (path === '/tasks/' + tasks[0]?.reference + '/changes') {
      const { changes, marker } = JSON.parse(opts.body);
      notes.push({ text: changes.comment + '\n' + marker, author: 'Test' });
      return Response.json({ key: 'Redmine #17', url: 'http://localhost:18881/issues/17' });
    }
    if (path.endsWith('/sendMessage')) {
      telegram.push(JSON.parse(opts.body));
      return Response.json({ ok: true, result: { message_id: 1 } });
    }
    throw Error('Unexpected request');
  };
  const sendMail = async (text, _env, to) => {
    mail.push({ text, to });
  };
  const app = createTeamApp({ base: join(dir, 'data.sqlite'), env, send, sendMail, background: false });
  try {
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const post = (op, body = {}, cookie = '') =>
      fetch(base + '/api/team/' + op, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', cookie },
        body: JSON.stringify(body),
      });
    async function account(login, code) {
      const r = await post('register', { login, code, name: login, password: 'test-only-password' });
      assert.equal(r.status, 200);
      return { user: await r.json(), cookie: r.headers.get('set-cookie').split(';')[0] };
    }
    const owner = await account('owner', 'admin-invite'),
      guest = await account('guest', 'guest');
    const other = await account('other', app.accounts.invite('team'));
    const call = async (op, body, cookie = owner.cookie) => {
      const r = await post(op, body, cookie);
      const v = await r.json();
      assert.equal(r.status, 200, v.error);
      return v;
    };
    assert.equal((await post('contacts')).status, 401);
    assert.equal((await post('bind', {}, guest.cookie)).status, 400);
    const pending = await call('email-request', { address: 'owner@example.invalid' });
    assert.equal(pending.email, null);
    assert.equal((await post('email-confirm', { code: 'wrong' }, owner.cookie)).status, 400);
    const code = mail[0].text.match(/\b\d{8}\b/)[0];
    assert.equal((await post('email-confirm', { code }, other.cookie)).status, 400);
    assert.equal((await call('email-confirm', { code })).email, 'owner@example.invalid');
    const start = await call('bind');
    assert.equal(new URL(start.url).searchParams.get('start'), start.command.slice(7));
    const hook = async (chat, type, id, token) =>
      fetch(base + '/api/telegram', {
        method: 'POST',
        headers: { 'x-telegram-bot-api-secret-token': token },
        body: JSON.stringify({
          update_id: id,
          message: { from: { id: 31 }, chat: { id: chat, type }, text: start.command },
        }),
      });
    assert.equal((await hook(31, 'private', 1, 'wrong')).status, 403);
    await hook(33, 'group', 2, 'test-secret');
    await hook(32, 'private', 3, 'test-secret');
    assert.equal((await call('contacts')).telegram, false);
    await hook(31, 'private', 4, 'test-secret');
    assert.equal((await call('contacts')).telegram, true);
    const store = app.space('team');
    store.db
      .prepare('INSERT INTO cases VALUES(?,?,?,?,?)')
      .run('case-test', 'Example', 'Проверка', 'Новый', JSON.stringify({ owner: owner.user.id }));
    const draft = await call('draft', {
      caseId: 'case-test',
      title: 'Проверить путь покупки',
      description: 'Проверить корзину',
      includeReport: true,
    });
    const key = await call('confirm', { id: draft.id });
    assert.equal(key.key, 'Redmine #17');
    await call('confirm', { id: draft.id });
    assert.equal(tasks.length, 1);
    closures = [
      {
        reference: tasks[0].reference,
        seq: 1,
        episode: 1,
        issue: 17,
        title: tasks[0].title,
        observed: new Date().toISOString(),
        status: 'Closed',
        url: key.url,
        closing_note: { text: 'Проверка завершена.', author: 'QA' },
        report,
      },
    ];
    const collect = () => collectClosures(store, app.accounts.db, env, send);
    const dispatch = () => deliver(store, env, send, sendMail, app.accounts.db);
    await collect();
    await collect();
    await dispatch();
    await dispatch();
    await dispatch();
    assert.deepEqual((await call('overview')).deliveries.map((row) => row.state), ['delivered', 'delivered']);
    assert.deepEqual((await call('overview', {}, other.cookie)).deliveries, []);
    assert.deepEqual((await call('overview', {}, guest.cookie)).deliveries, []);
    assert.equal((await call('knowledge')).results.length, 1);
    assert.equal((await call('knowledge', {}, other.cookie)).results.length, 0);
    assert.equal((await call('knowledge', {}, guest.cookie)).results.length, 0);
    assert.equal(mail.length, 2);
    assert.equal(mail[1].to, 'owner@example.invalid');
    assert.match(mail[1].text, /Closed/);
    assert.equal(telegram.length, 1);
    assert.equal(telegram[0].chat_id, '31');
    const knowledge = await call('knowledge');
    assert.equal(knowledge.pages.length, 1);
    const page = knowledge.results[0].pageKey;
    const before = await call('page_read', { key: page, local: true });
    assert.equal(before.version, 1);
    assert.ok(before.text.split('\n').includes('Проверка завершена.'));
    assert.match(before.text, /2\/40 → 5\/60/);
    assert.equal((await post('page_read', { key: page, local: true }, other.cookie)).status, 400);
    const workbook = (value) => ({
      file: 'Путь покупки.xlsx',
      facts: [{ kind: 'competitor', loc: 'Витрина!C3', text: value }],
    });
    importDocs(store, [workbook('Первый вывод')], { notify: false });
    const [{ version }] = await call('knowledge-sources');
    const pageDraft = await call('page_draft', {
      caseId: 'case-test',
      key: page,
      baseVersion: 1,
      issueKey: '17',
      sourceVersions: [version],
    });
    assert.equal(notes.length, 0);
    importDocs(store, [workbook('Обновлённый вывод')], { notify: false });
    const confirmed = await call('confirm', { id: pageDraft.id, revision: pageDraft.revision });
    assert.equal(confirmed.key, page);
    await call('confirm', { id: pageDraft.id, revision: pageDraft.revision });
    const linkedPage = await call('page_read', { key: page, local: true });
    assert.equal(linkedPage.version, 2);
    assert.ok(linkedPage.links.some((l) => l.url === '#knowledge-source/' + version));
    assert.equal((await call('knowledge-source', { version })).rows[0].value, 'Первый вывод');
    assert.equal((await post('knowledge-source', { version }, guest.cookie)).status, 400);
    assert.equal(notes.length, 1);
    assert.ok(notes[0].text.includes('http://127.0.0.1:8090/#demo-page/' + page));
    closures.push({ ...closures[0], seq: 2, episode: 2 });
    await collect();
    const reopened = await call('page_read', { key: page, local: true });
    assert.equal(reopened.version, 3);
    assert.equal((await call('page_read', { issueKey: '№17' })).key, page);
    assert.equal((await call('page_read', { key: '17' })).key, page);
    assert.equal((await call('issue_read', { key: '17' })).pages[0].version, 3);
    assert.notEqual((await post('page_read', { issueKey: '17' }, other.cookie)).status, 200);
    assert.notEqual((await post('page_read', { issueKey: '17' }, guest.cookie)).status, 200);
    assert.match(reopened.text, /Закрытие №2/);
    assert.ok(reopened.links.some((l) => l.url === '#knowledge-source/' + version));
    assert.equal((await call('knowledge')).pages.length, 1);
    await call('contact-unlink', { channel: 'smtp' });
    await call('contact-unlink', { channel: 'telegram' });
    await dispatch();
    await dispatch();
    assert.equal(mail.length, 2);
    assert.equal(telegram.length, 1);
    await hook(31, 'private', 5, 'test-secret');
    assert.equal((await call('contacts')).telegram, false);
  } finally {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  }
});

async function telegramQueue(t, replies) {
  const requests = [];
  const sink = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, body: JSON.parse(Buffer.concat(chunks)) });
    const reply = replies.shift() ?? { status: 500, body: {} };
    if (reply.disconnect) return res.destroy();
    res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
    res.end(JSON.stringify(reply.body));
  });
  await new Promise((resolve, reject) => sink.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => sink.close(resolve)));
  const send = (url, options) => {
    const upstream = new URL(url);
    assert.equal(upstream.host, 'api.telegram.org');
    return fetch('http://127.0.0.1:' + sink.address().port + upstream.pathname, options);
  };
  const store = openStore(':memory:', { seedDemo: false });
  t.after(() => store.close());
  initEvidence(store.db);
  const env = { TELEGRAM_BOT_TOKEN: 'test-only' };
  const enqueue = (body = {}) => store.db.prepare(
    "INSERT INTO deliveries(id,channel,state,body) VALUES('tg','telegram','queued',?)",
  ).run(JSON.stringify({ chat: '31', text: 'Проверка доставки', ...body }));
  return {
    requests, enqueue, run: () => deliver(store, env, send),
    state: () => store.one("SELECT state,attempts,next FROM deliveries WHERE id='tg'"),
    makeDue: () => store.db.exec("UPDATE deliveries SET next=0 WHERE id='tg'"),
  };
}

test('Telegram envelope rejection is recorded as failed and skipped on repeat ticks', async (t) => {
  const queue = await telegramQueue(t, [{ status: 200, body: { ok: false, error_code: 403 } }]);
  queue.enqueue();
  await queue.run();
  await queue.run();
  assert.equal(queue.state().state, 'failed');
  assert.equal(queue.state().attempts, 1);
  assert.equal(queue.requests.length, 1);
});

test('Telegram limits postpone delivery by the API retry delay before trying once again', async (t) => {
  const queue = await telegramQueue(t, [
    { status: 429, body: { ok: false, error_code: 429, parameters: { retry_after: 90 } } },
    { status: 429, headers: { 'Retry-After': '140' }, body: {} },
    { status: 200, body: { ok: true, result: { message_id: 1 } } },
  ]);
  queue.enqueue();
  let before = Date.now();
  await queue.run();
  assert.equal(queue.state().state, 'queued');
  assert.ok(queue.state().next >= before + 90_000, 'respect Bot API response parameters');
  await queue.run();
  assert.equal(queue.requests.length, 1);
  queue.makeDue();
  before = Date.now();
  await queue.run();
  assert.equal(queue.state().state, 'queued');
  assert.ok(queue.state().next >= before + 140_000, 'respect fallback Retry-After header');
  queue.makeDue();
  await queue.run();
  await queue.run();
  assert.equal(queue.state().state, 'delivered');
  assert.equal(queue.state().attempts, 3);
  assert.equal(queue.requests.length, 3);
});

test('Telegram responses without a provider receipt stay uncertain', async (t) => {
  const queue = await telegramQueue(t, [{ status: 200, body: { ok: true, result: {} } }]);
  queue.enqueue();
  await queue.run();
  await queue.run();
  assert.equal(queue.state().state, 'uncertain');
  assert.equal(queue.requests.length, 1);
});

test('Telegram drops an invalid issue URL and a loopback application link before delivery', async (t) => {
  const queue = await telegramQueue(t, [{ status: 200, body: { ok: true, result: { message_id: 1 } } }]);
  queue.enqueue({ issueUrl: '/issues/17', caseId: 'sample' });
  await queue.run();
  assert.equal(queue.state().state, 'delivered');
  assert.deepEqual(queue.requests, [{
    path: '/bottest-only/sendMessage', body: { chat_id: '31', text: 'Проверка доставки' },
  }]);
});

test('SMTP readiness and delivery both wait for a configured sender', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-smtp-config-'));
  const env = {
    ADMIN_INVITE_KEY: 'admin-invite', NOTIFICATIONS_ENABLED: 'true',
    SMTP_HOST: 'mail.invalid', SMTP_TO: 'qa@example.invalid',
  };
  let sent = 0;
  const sendMail = async () => { sent++; };
  const app = createTeamApp({ base: join(dir, 'data.sqlite'), env, sendMail, background: false });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api/team/';
  const post = (op, body, cookie = '') => fetch(base + op, {
    method: 'POST', headers: { 'content-type': 'application/json', cookie }, body: JSON.stringify(body),
  });
  const registered = await post('register', { login: 'owner', code: 'admin-invite', name: 'Owner', password: 'test-only-password' });
  assert.equal(registered.status, 200);
  const cookie = registered.headers.get('set-cookie').split(';')[0];
  const settings = async (op) => (await post(op, {}, cookie)).json();
  const store = app.space('team');
  store.db.exec("INSERT INTO deliveries(id,channel,state,body) VALUES('mail','smtp','queued','{\"text\":\"Тест\"}')");
  await deliver(store, env, fetch, sendMail, app.accounts.db);
  assert.equal((await settings('contacts')).smtpReady, false);
  assert.equal((await settings('status')).smtp, false);
  assert.equal(store.one("SELECT attempts FROM deliveries WHERE id='mail'").attempts, 0);
  assert.equal(sent, 0);
  env.SMTP_FROM = 'sender@example.invalid';
  store.db.exec("UPDATE deliveries SET next=0 WHERE id='mail'");
  await deliver(store, env, fetch, sendMail, app.accounts.db);
  assert.equal((await settings('status')).smtp, true);
  assert.equal(store.one("SELECT state FROM deliveries WHERE id='mail'").state, 'delivered');
  assert.equal(sent, 1);
});

async function smtpQueue(t, outcomes) {
  let accepted = 0;
  const sink = createSocketServer((socket) => {
    const outcome = outcomes.shift();
    const send = (line) => socket.write(line + '\r\n');
    let text = '', data = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', (chunk) => {
      text += chunk;
      let end;
      while ((end = text.indexOf('\r\n')) >= 0) {
        const line = text.slice(0, end).toUpperCase();
        text = text.slice(end + 2);
        if (data) {
          if (line !== '.') continue;
          data = false;
          accepted++;
          if (outcome === 'disconnect') return socket.destroy();
          send('250 Accepted');
        } else if (line.startsWith('EHLO ') || line.startsWith('MAIL FROM:') || line === 'RSET') send('250 OK');
        else if (line.startsWith('RCPT TO:')) {
          send(outcome === 'temporary' ? '451 Try later' : outcome === 'rejected' ? '550 Unknown user' : '250 OK');
        } else if (line === 'DATA') {
          data = true;
          send('354 Send Message');
        } else if (line === 'QUIT') {
          socket.end(outcome === 'quit-error' ? '500 Unexpected command\r\n' : '221 Bye\r\n');
        } else send('500 Unexpected command');
      }
    });
    send('220 Local SMTP fixture');
  });
  await new Promise((resolve, reject) => sink.once('error', reject).listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => sink.close(resolve)));
  const env = {
    NOTIFICATIONS_ENABLED: 'true', SMTP_HOST: '127.0.0.1', SMTP_PORT: String(sink.address().port),
    SMTP_TLS: 'local-test', SMTP_FROM: 'sender@example.invalid', SMTP_TO: 'recipient@example.invalid',
    PYTHON_BIN: process.env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3'),
  };
  const store = openStore(':memory:', { seedDemo: false });
  t.after(() => store.close());
  initEvidence(store.db);
  store.db.prepare("INSERT INTO deliveries(id,channel,state,body) VALUES('mail','smtp','queued',?)").run(
    JSON.stringify({ text: 'Проверка SMTP' }),
  );
  return {
    accepted: () => accepted, run: () => deliver(store, env, fetch),
    state: () => store.one("SELECT state,attempts,next FROM deliveries WHERE id='mail'"),
    makeDue: () => store.db.exec("UPDATE deliveries SET next=0 WHERE id='mail'"),
  };
}

test('SMTP retries a known temporary rejection without duplicating an accepted mail', async (t) => {
  const queue = await smtpQueue(t, ['temporary', 'accepted']);
  const started = Date.now();
  await queue.run();
  assert.equal(queue.state().state, 'queued');
  assert.ok(queue.state().next >= started + 60_000);
  assert.equal(queue.accepted(), 0);
  await queue.run();
  assert.equal(queue.state().attempts, 1);
  queue.makeDue();
  await queue.run();
  await queue.run();
  assert.equal(queue.state().state, 'delivered');
  assert.equal(queue.state().attempts, 2);
  assert.equal(queue.accepted(), 1);
});

test('SMTP preserves the final DATA acknowledgement if QUIT fails', async (t) => {
  const queue = await smtpQueue(t, ['quit-error']);
  await queue.run();
  await queue.run();
  assert.equal(queue.state().state, 'delivered');
  assert.equal(queue.state().attempts, 1);
  assert.equal(queue.accepted(), 1);
});

test('SMTP marks definite permanent rejections as failed', async (t) => {
  const queue = await smtpQueue(t, ['rejected']);
  await queue.run();
  await queue.run();
  assert.equal(queue.state().state, 'failed');
  assert.equal(queue.state().attempts, 1);
  assert.equal(queue.accepted(), 0);
});

test('SMTP never retries automatically after losing the final acknowledgement', async (t) => {
  const queue = await smtpQueue(t, ['disconnect']);
  await queue.run();
  await queue.run();
  assert.equal(queue.state().state, 'uncertain');
  assert.equal(queue.state().attempts, 1);
  assert.equal(queue.accepted(), 1);
});

test('a named signal waits for the verified recipient and cannot use broad destinations', async () => {
  const store = openStore(':memory:', { seedDemo: false });
  const accounts = openAccounts(':memory:').db;
  try {
    initEvidence(store.db);
    initContacts(accounts);
    accounts.exec(`
      INSERT INTO users(id,login,space,role) VALUES('owner','product','team','member'),('other','other','team','member');
      INSERT INTO email_contacts VALUES('other','other@example.invalid');
      INSERT INTO email_checks VALUES('owner','owner@example.invalid','pending',1,0);
    `);
    const enqueue = store.db.prepare("INSERT INTO deliveries(id,channel,state,body) VALUES(?,?,'queued',?)");
    const payload = { kind: 'product-signal', caseId: 'signal', text: 'Точка проверки' };
    enqueue.run('old-fanout', 'telegram', JSON.stringify({ ...payload, chat: 'global', proactive: true }));
    enqueue.run('mail', 'smtp', JSON.stringify(payload));
    enqueue.run('chat', 'telegram', JSON.stringify(payload));
    const env = {
      NOTIFICATIONS_ENABLED: 'true', SIGNAL_OWNER_LOGIN: 'product',
      SMTP_HOST: 'mail.invalid', SMTP_FROM: 'sender@example.invalid', SMTP_TO: 'global@example.invalid',
      TELEGRAM_BOT_TOKEN: 'fixture', TELEGRAM_CHAT_IDS: 'global,another-global',
    };
    const sent = [];
    const step = () => deliver(store, env, () => assert.fail('Unexpected Telegram call'),
      (text, config, address) => sent.push({ text, address }), accounts);
    await step();
    await step();
    await step();
    assert.equal(store.one("SELECT state FROM deliveries WHERE id='old-fanout'").state, 'cancelled');
    assert.equal(store.one("SELECT attempts FROM deliveries WHERE id='mail'").attempts, 0);
    assert.equal(store.one('SELECT count(*) n FROM deliveries').n, 3);
    assert.deepEqual(sent, []);

    accounts.exec("INSERT INTO email_contacts VALUES('owner','owner@example.invalid')");
    store.db.exec('UPDATE deliveries SET next=0');
    await step();
    await step();
    await step();
    assert.equal(store.one("SELECT state FROM deliveries WHERE id='mail'").state, 'delivered');
    assert.equal(store.one("SELECT state FROM deliveries WHERE id='chat'").state, 'queued');
    assert.deepEqual(sent, [{ text: 'Точка проверки\nhttp://127.0.0.1:8090/#case/signal', address: 'owner@example.invalid' }]);
  } finally {
    accounts.close();
    store.close();
  }
});

test('effect preview requires full comparable coverage and a linked rollout while watch persists the pending plan', () => {
  const store = openStore(':memory:', { seedDemo: false });
  try {
    initEvidence(store.db);
    const u = { id: 'product', role: 'member' };
    const env = { SOURCE_ARCHIVE_SHA256: 'archive' };
    const call = (op, body) => workspaceOperation(store, u, op, body, env);
    const insertCase = store.db.prepare("INSERT INTO cases VALUES(?,?,?,'Исследуем','{}')");
    insertCase.run('astra', 'Astra Linux Special Edition', 'Astra');
    insertCase.run('kaspersky', 'Kaspersky Endpoint Security', 'Kaspersky');
    const table = (kind, loc, row) => ({kind, loc, row});
    const samples = (first, value, loc) => Array.from({ length: 7 }, (_, i) => table('metrics', 'Metrics!A' + (loc + i), {
      metric_id: 'cfg_family_views', product: 'Конфигуратор Астра', segment: 'desktop', unit: 'visits',
      date: '2026-05-' + String(first + i).padStart(2, '0'), value,
    }));
    const release = (release_id, release_date, release_type, affected_metrics, related_task_ids = '') => ({
      release_id, release_date, release_type, affected_metrics, related_task_ids, status: 'выпущен',
      description: 'Конфигуратор Astra Linux',
    });
    importDocs(store, [{ file: 'Fixture.xlsx', facts: [
      table('dictionary', 'Dictionary!A2', { metric_id: 'cfg_family_views', metric_name: 'Визиты' }),
      table('dictionary', 'Dictionary!A3', { metric_id: 'cfg_add_to_cart_rate', metric_name: 'Добавления' }),
      table('backlog', 'Tasks!A2', {
        task_id: 'T-02', title: 'Astra', release_id: 'R-02', linked_metric_ids: 'cfg_family_views',
      }),
      table('backlog', 'Tasks!A3', {
        task_id: 'T-08', title: 'Kaspersky', linked_metric_ids: 'cfg_add_to_cart_rate',
      }),
      table('releases', 'Release!A2', release('R-02', '2026-05-12', 'minor', 'cfg_family_views', 'T-02')),
      table('releases', 'Release!A3', release('R-03', '2026-05-15', 'analytics', 'cfg_open')),
      ...samples(5, 10, 2), ...samples(13, 15, 9),
      table('metrics', 'Metrics!A16', {
        metric_id: 'cfg_family_views', product: 'Конфигуратор Kaspersky', segment: 'desktop',
        unit: 'visits', date: '2026-05-20', value: 8,
      }),
    ] }], { notify: false });
    const retro = {
      caseId: 'astra', taskId: 'T-02', releaseId: 'R-02', metric: 'cfg_family_views', segment: 'desktop',
      baselineWeeks: 1, observationWeeks: 1, asOf: '2026-05-19',
    };
    const report = call('effect-preview', retro);
    assert.equal(report.plan.target, null);
    assert.equal(report.actual, 15);
    assert.equal(report.change, 5);
    assert.equal(report.baseline.total, 70);
    assert.equal(report.observed.total, 105);
    assert.equal(report.baseline.sources.length, 7);
    assert.equal(report.observed.sources.length, 7);
    assert.equal(report.context[0].id, 'R-03');
    assert.equal(report.breaks.length, 0);
    assert.equal(store.one("SELECT body FROM cases WHERE id='astra'").body, '{}');
    assert.equal(call('effect-preview', { ...retro, asOf: '2026-05-18' }).actual, undefined);

    const selected = call('watch', retro);
    importDocs(store, [{ file: 'Fixture.xlsx', facts: [
      table('releases', 'Release!A4', release('R-02', '2026-05-13', 'minor', 'cfg_family_views', 'T-02')),
    ] }], { notify: false });
    assert.deepEqual(observedEffect(store.db,getCase(store.db,'astra')).plan, selected.plan);
    assert.equal(selected.plan.deployed, '2026-05-12');

    importDocs(store, [{ file: 'Change.xlsx', facts: [
      table('releases', 'Release!A2', release('R-08', '2026-05-18', 'infrastructure', 'cfg_family_views')),
    ] }], { notify: false });
    const interrupted = call('effect-preview', retro);
    assert.equal(interrupted.breaks[0].id, 'R-08');
    assert.equal(interrupted.actual, undefined);
    assert.equal(interrupted.change, undefined);

    const pending = call('watch', { caseId: 'kaspersky', taskId: 'T-08', metric: 'cfg_add_to_cart_rate', segment: 'desktop' });
    assert.equal(pending.plan.deployed, null);
    assert.equal(pending.plan.releaseId, null);
    assert.equal(pending.checkAfter, undefined);
    assert.equal(pending.baseline, undefined);
    assert.match(pending.state, /Ожидаем/);
    assert.match(pending.plan.condition, /событием электронной торговли/);
    assert.equal(JSON.parse(store.one("SELECT body FROM cases WHERE id='kaspersky'").body).watch.deployed, null);
    assert.throws(() => call('watch', { caseId: 'kaspersky', taskId: 'T-08', metric: 'cfg_add_to_cart_rate', deployed: '2026-05-12' }),
      /из журнала релизов/);
  } finally {
    store.close();
  }
});

test('late approved rollout resolves a saved watch and notifies the product owner once with comparable data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-effect-'));
  const archive = Buffer.from('Observation source fixture');
  const env = {
    SOURCE_ARCHIVE_SHA256: digest(archive), SIGNAL_OWNER_LOGIN: 'prod',
    NOTIFICATIONS_ENABLED: 'true', SMTP_HOST: 'mail.invalid', SMTP_FROM: 'sender@example.invalid', SMTP_TO: 'global@example.invalid',
    TELEGRAM_BOT_TOKEN: 'fixture', TELEGRAM_CHAT_IDS: 'global',
  };
  const sent = [];
  const app = createTeamApp({ base:join(dir,'data.sqlite'), env, background:false,
    send: () => assert.fail('Unexpected Telegram call'),
    sendMail: (text, _env, to) => sent.push({text,to}),
  });
  t.after(async () => {
    await app.close();
    await rm(dir, {recursive:true, force:true});
  });
  const clock = t.mock.timers;
  clock.enable({apis:['Date'], now:new Date('2026-05-10T09:00:00Z')});
  const store = app.space('team');
  const u = { id:'product', role:'member' };
  app.accounts.db.exec(`
    INSERT INTO users(id,login,space,role) VALUES('product','prod','team','member');
    INSERT INTO email_contacts VALUES('product','product@example.invalid');
  `);
  const metric = 'cfg_add_to_cart_rate', product = 'Kaspersky Endpoint Security';
  const fact = (kind, loc, row) => ({kind,loc,row});
  const task = (fields = {}) => fact('backlog', 'Tasks!A2', {
    task_id:'TASK-FIX', title:'Проверка события', product, created_date:'2026-05-01',
    status:'открыта', linked_metric_ids:metric, ...fields,
  });
  const release = (id, row, fields = {}) => fact('releases', 'Releases!A' + row, {
    release_id:id, release_date:'2026-05-12', release_type:'minor', description:product,
    status:'выпущен', affected_metrics:metric, related_task_ids:'TASK-FIX', ...fields,
  });
  const unrelated = release('UNRELATED', 2, {related_task_ids:'OTHER'});
  const old = release('OLD', 3, {release_date:'2026-05-08'});
  const samples = (first, actions, open = 20) => Array.from({length:7}, (_, i) => fact('metrics', 'Metrics!A' + (first+i), {
    metric_id:metric, product, segment:'desktop', unit:'ratio',
    date:'2026-05-' + String(first+i).padStart(2,'0'), value:open ? actions/open : 0,
    detail_json:JSON.stringify({add_to_cart:actions, open}),
  }));
  const backlog = facts => ({file:'Backlog.xlsx',facts});
  const journal = facts => ({file:'Journal.xlsx',facts:[unrelated,old,...facts]});
  const metrics = facts => ({file:'Metrics.xlsx',facts});
  const permission = (raw, file) => sourcePermission(store.db, env.SOURCE_ARCHIVE_SHA256, raw, file);
  importApproved(store, [
    backlog([task()]), journal([]), metrics(samples(5,2)), {file:'Dictionary.xlsx', facts:[
      fact('dictionary','Dictionary!A2',{metric_id:metric, metric_name:'Добавление в корзину'}),
    ]},
  ], permission(archive,'original.zip'), false);
  const revise = doc => {
    const raw = Buffer.from(JSON.stringify(doc));
    approveSource(store, {sha:digest(raw), file:doc.file,
      previous:sourceHistory(store.db,doc.file)[0].version, origin:'Approved test fixture',
    }, 'fixture-admin', env.SOURCE_ARCHIVE_SHA256);
    importApproved(store,[doc],permission(raw,doc.file),false);
    return sourceHistory(store.db,doc.file)[0].version;
  };
  store.db.prepare("INSERT INTO cases VALUES(?,?,?,'Исследуем','{}')").run('watch-fix',product,'Проверка');
  const call = (op, body = {}) => workspaceOperation(store,u,op,{caseId:'watch-fix',...body},env);
  const original = call('watch', {taskId:'TASK-FIX', metric, segment:'desktop',
    baselineWeeks:1, observationWeeks:1, target:20, condition:'Сверить тестовое событие и знаменатель',
  });
  assert.equal(original.plan.deployed, null);
  assert.equal(original.rollout, undefined);
  const tick = async () => {
    await app.tick();
    await new Promise(setImmediate);
  };
  const read = () => call('view').effect;
  const checkState = () => getCase(store.db,'watch-fix').state;
  assert.equal(checkState(), 'Наблюдаем эффект');

  clock.setTime(Date.parse('2026-05-13T09:00:00Z'));
  const taskVersion = revise(backlog([task({release_id:'FIX', status:'закрыта'})]));
  revise(journal([release('FIX',4,{release_date:'2026-05-25'})]));
  assert.equal(read().rollout, undefined);
  revise(journal([release('FIX',4,{release_date:'2026-04-31'})]));
  assert.match(read().state, /дата.*требует проверки/i);
  const wrong = release('FIX',4,{description:'Astra Linux'});
  const wrongVersion = revise(journal([wrong]));
  const conflict = read();
  assert.match(conflict.state, /семейств/i);
  assert.ok(conflict.rolloutSources.some(s => s.version === wrongVersion));
  assert.equal(conflict.actual, undefined);

  const fixed = release('FIX',4);
  const competing = release('OTHER-FIX',5);
  revise(journal([fixed,competing]));
  assert.match(read().state, /расходят|несколько/);
  const withdrawn = release('OTHER-FIX',5,{status:'отменён'});
  const releaseVersion = revise(journal([fixed,withdrawn]));
  const view = read();
  assert.deepEqual(view.plan, original.plan);
  assert.equal(view.rollout.id, 'FIX');
  assert.equal(view.rollout.date, '2026-05-12');
  assert.deepEqual(view.rollout.sources.map(s => [s.version,s.loc]), [
    [taskVersion,'Tasks!A2'],[releaseVersion,'Releases!A4'],
  ]);
  assert.equal(call('knowledge-source',{version:releaseVersion,loc:'Releases!A4'}).rows[0].loc,'Releases!A4');
  assert.equal(observedEffect(store.db,getCase(store.db,'watch-fix'),'2026-05-11').rollout, undefined);
  assert.match(view.state, /окончание окна/);
  await tick();
  assert.deepEqual(sent, []);

  clock.setTime(Date.parse('2026-05-20T09:00:00Z'));
  await tick();
  assert.match(read().state, /Недостаточно сопоставимых/);
  revise(metrics([...samples(5,2), ...samples(13,0,0)]));
  await tick();
  assert.match(read().state, /Недостаточно сопоставимых/);
  const invalid = samples(13,5);
  invalid.at(-1).row.detail_json = '{"add_to_cart":5,"open":-1}';
  revise(metrics([...samples(5,2), ...invalid]));
  await tick();
  assert.match(read().state, /Недостаточно сопоставимых/);
  assert.equal(checkState(), 'Наблюдаем эффект');
  assert.deepEqual(sent, []);
  const metricsVersion = revise(metrics([...samples(5,2), ...samples(13,5)]));

  await Promise.all([tick(),tick(),tick()]);
  await tick();
  await tick();
  assert.equal(checkState(), 'Нужно решение');
  const outcome = read();
  assert.equal(outcome.state, 'Цель достигнута');
  assert.equal(outcome.actual, 25);
  assert.equal(outcome.change, 15);
  assert.deepEqual(outcome.plan, original.plan);
  assert.deepEqual(outcome.rollout, view.rollout);
  assert.ok(outcome.observed.sources.every(s => s.version === metricsVersion));
  assert.deepEqual(sent,[{text:'Цель достигнута\nhttp://127.0.0.1:8090/#case/watch-fix',to:'product@example.invalid'}]);
  assert.equal(store.one("SELECT count(*) n FROM deliveries WHERE state='delivered'").n,1);
});

test('background tick delivers a due observation while a chat job waits for the model', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-effect-queue-'));
  const env = {
    LLM_BASE_URL:'https://model.invalid/v1', LLM_MODEL:'fixture', LLM_DATA_MODE:'analysis',
    SIGNAL_OWNER_LOGIN:'prod', NOTIFICATIONS_ENABLED:'true', SMTP_HOST:'mail.invalid', SMTP_FROM:'sender@example.invalid',
  };
  const started = Promise.withResolvers(), modelReply = Promise.withResolvers();
  let calls = 0;
  let closing;
  const sent = [];
  const app = createTeamApp({base:join(dir,'data.sqlite'), env, background:false,
    send: url => {
      assert.equal(new URL(url).hostname, 'model.invalid');
      calls++;
      started.resolve();
      return modelReply.promise;
    },
    sendMail: (text, _env, to) => sent.push({text,to}),
  });
  const reply = () => modelReply.resolve(Response.json({
    choices:[{message:{role:'assistant',content:'Для оценки соберите данные по заказам.'}}],
  }));
  t.after(async () => {
    reply();
    await (closing || app.close());
    await rm(dir,{recursive:true,force:true});
  });
  const store = app.space('team');
  const user = {id:'product',name:'Продакт',role:'member'};
  app.accounts.db.exec(`
    INSERT INTO users(id,login,name,space,role) VALUES('product','prod','Продакт','team','member');
    INSERT INTO email_contacts VALUES('product','product@example.invalid');
  `);
  const thread = createThread(store.db,user,'Чат');
  const job = enqueue(store,user,{thread,question:'Помоги составить план продуктового исследования.'});
  const queued = enqueue(store,user,{thread,question:'Сформулируй вопросы для интервью.'});
  const jobState = id => store.one('SELECT status FROM jobs WHERE id=?',id).status;
  await app.tick();
  const modelStarted = await Promise.race([started.promise.then(() => true), new Promise(resolve => {
    const timeout = setTimeout(() => resolve(false),1000);
    timeout.unref();
  })]);
  assert.equal(modelStarted,true);
  assert.equal(jobState(job),'running');

  const product = 'Astra Linux';
  store.db.prepare("INSERT INTO cases VALUES(?,?,?,'Исследуем','{}')").run('ready',product,'Наблюдение');
  const metric = 'cfg_family_views';
  const samples = (start,value) => Array.from({length:7},(_,i) => {
    const n = start+i;
    return {kind:'metrics',loc:'Metrics!A'+n,row:{metric_id:metric,product,segment:'desktop',
      date:'2026-05-'+String(n).padStart(2,'0'),unit:'visits',value}};
  });
  importDocs(store,[{file:'Observation.xlsx',facts:[
    {kind:'dictionary',loc:'Dictionary!A2',row:{metric_id:metric,metric_name:'Визиты'}},
    ...samples(5,10),...samples(13,15),
  ]}],{notify:false});
  workspaceOperation(store,user,'watch',{caseId:'ready',metric,segment:'desktop',deployed:'2026-05-12',
    baselineWeeks:1,observationWeeks:1,target:11},env);
  for (let i=0; i<4; i++) {
    await app.tick();
    await new Promise(setImmediate);
  }
  assert.equal(calls,1);
  assert.equal(jobState(job),'running');
  assert.equal(jobState(queued),'queued');
  assert.equal(getCase(store.db,'ready').state,'Нужно решение');
  assert.deepEqual(sent,[{text:'Цель достигнута\nhttp://127.0.0.1:8090/#case/ready',to:'product@example.invalid'}]);
  closing = app.close();
  const closed = await Promise.race([closing.then(() => true),new Promise(setImmediate).then(() => false)]);
  assert.equal(closed,false);
  reply();
  await closing;
});
