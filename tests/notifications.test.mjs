import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer as createSocketServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openStore } from '../server/store.mjs';
import { digest, initEvidence } from '../server/evidence.mjs';
import { reconcileSignals } from '../server/signal-history.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { deliver, initWorkbench, workJobs } from '../server/workbench.mjs';

async function fixture(t, config = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'pm-contacts-'));
  const env = { ADMIN_INVITE_KEY: 'admin-fixture', DEMO_INVITE_KEY: 'guest-fixture',
    SMTP_HOST: 'mail.invalid', SMTP_FROM: 'sender@example.invalid', SMTP_TO: 'shared@example.invalid',
    TELEGRAM_BOT_TOKEN: 'fake', TELEGRAM_BOT_USERNAME: 'signal_fixture_bot',
    TELEGRAM_WEBHOOK_SECRET: 'fixture-secret', TELEGRAM_CHAT_IDS: '-123',
    NOTIFICATIONS_ENABLED: 'true', ...config };
  const messages = [];
  const send = async (url, init) => {
    messages.push({ method: new URL(url).pathname.split('/').at(-1), ...JSON.parse(init.body) });
    return Response.json({ ok: true, result: { message_id: messages.length } });
  };
  const sendMail = async (text, options, to = options.SMTP_TO) => {
    messages.push({ method: 'smtp', text, to });
  };
  const app = createTeamApp({ base: join(dir, 'team.sqlite'), env, background: false, send, sendMail });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = 'http://127.0.0.1:' + app.server.address().port;
  async function post(op, body = {}, cookie = '') {
    const response = await fetch(base + '/api/team/' + op, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function account(login, code) {
    const registered = await post('register', { login, code, name: login, password: 'test-only-password' });
    assert.equal(registered.status, 200, registered.body.error);
    return { id: registered.body.id, cookie: registered.cookie };
  }
  const owner = await account('owner', env.ADMIN_INVITE_KEY);
  const other = await account('other', app.accounts.invite('team'));
  const guest = await account('guest', env.DEMO_INVITE_KEY);
  async function contact(op, body, cookie = owner.cookie) {
    const result = await post(op, body, cookie);
    assert.equal(result.status, 200, result.body.error);
    return result.body;
  }
  async function hook(id, text, { chat = 31, sender = 31, type = 'private', secret = env.TELEGRAM_WEBHOOK_SECRET } = {}) {
    return fetch(base + '/api/telegram', {
      method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret },
      body: JSON.stringify({ update_id: id, message: { from: { id: sender }, chat: { id: chat, type }, text } }),
    });
  }
  const store = app.space('team');
  const dispatch = () => deliver(store, env, send, sendMail, app.accounts.db);
  return { env, app, store, messages, owner, other, guest, post, contact, hook, dispatch };
}

test('contact confirmation is account-specific, one-use, expires after ten minutes and allows five attempts', async t => {
  const { app, messages, owner, other, guest, post, contact } = await fixture(t);
  const address = 'owner@example.invalid';
  const request = () => contact('email-request', { address });
  const attempt = (code, cookie = owner.cookie) => post('email-confirm', { code }, cookie);
  const currentCode = () => messages.at(-1).text.match(/\b\d{8}\b/)[0];
  const expire = () => app.accounts.db.exec('UPDATE email_limits SET issued=0');
  assert.equal((await post('contacts')).status, 401);
  assert.equal((await post('contacts', {}, guest.cookie)).status, 400);
  assert.equal((await request()).pending, address);
  const first = currentCode();
  assert.equal((await attempt(first, other.cookie)).status, 400);
  for (let n = 0; n < 5; n++) assert.equal((await attempt('00000000')).status, 400);
  assert.equal((await attempt(first)).status, 400);
  expire();
  await request();
  app.accounts.db.prepare('UPDATE email_checks SET issued=?').run(Date.now() - 600000);
  assert.equal((await attempt(currentCode())).status, 400);
  expire();
  await request();
  const verified = currentCode();
  assert.equal((await attempt(verified)).body.email, address);
  assert.equal((await attempt(verified)).status, 400);
  assert.equal((await contact('contacts', {}, other.cookie)).email, null);
});

test('Telegram preserves an existing binding, consumes deep links only in private, and keeps group ask replies', async t => {
  const { app, store, owner, other, guest, post, contact, hook, messages } = await fixture(t, {
    NOTIFICATIONS_ENABLED: 'false', NOTIFICATION_CHANNELS: '', TELEGRAM_BIND_POLLING: 'true',
  });
  app.accounts.db.prepare('INSERT INTO telegram VALUES(?,?,?,?)').run('20', owner.id, 'team', 'private');
  assert.equal((await contact('contacts')).telegram, true);
  assert.equal((await post('bind', {}, guest.cookie)).status, 400);
  const { command, url } = await contact('bind');
  assert.equal(new URL(url).searchParams.get('start'), command.slice(7));
  assert.equal((await hook(1, command, { secret: 'wrong' })).status, 403);
  await hook(2, command, { chat: -123, type: 'group' });
  await hook(3, command, { chat: 32 });
  assert.equal(app.accounts.db.prepare("SELECT user FROM telegram WHERE chat='31'").get(), undefined);
  await hook(4, command);
  const secondLink = await contact('bind', {}, other.cookie);
  await hook(5, secondLink.command);
  assert.equal((await contact('contacts', {}, other.cookie)).telegram, false);
  await contact('email-request', { address: 'owner@example.invalid' });
  const code = messages.at(-1).text.match(/\b\d{8}\b/)[0];
  await contact('email-confirm', { code });
  assert.equal((await contact('contact-unlink', { channel: 'smtp' })).telegram, true);
  await hook(6, '/ask Обзор', { chat: -123, type: 'group' });
  for (let i = 0; i < 3 && !messages.some(row => row.method === 'sendMessage'); i++) {
    await app.tick();
    await new Promise(resolve => setTimeout(resolve, 35));
  }
  assert.deepEqual(messages.filter(row => row.method === 'sendMessage').map(row => row.chat_id), ['-123']);
  assert.equal(messages.some(row => row.method === 'getUpdates'), false);
  assert.equal(store.db.prepare("SELECT count(*) n FROM known_updates WHERE id=6").get().n, 1);
  await contact('contact-unlink', { channel: 'telegram' });
  await hook(7, command);
  assert.equal((await contact('contacts')).telegram, false);
});

test('owner-targeted deliveries wait, recheck changed contacts, and do not use shared addresses', async t => {
  const { app, store, owner, other, env, messages, dispatch } = await fixture(t, { NOTIFICATION_CHANNELS: 'smtp' });
  const sentRecipients = () => messages.filter(row => row.method === 'smtp').map(row => row.to);
  store.db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)')
    .run('private', 'fixture', 'Private case', 'Новый', JSON.stringify({ owner: owner.id }));
  const queue = (id, body, channel = 'smtp') =>
    store.db.prepare("INSERT INTO deliveries(id,channel,state,body) VALUES(?,?,'queued',?)")
      .run(id, channel, JSON.stringify({ text: id, ...body }));
  const contacts = app.accounts.db.prepare('INSERT OR REPLACE INTO email_contacts VALUES(?,?)');
  contacts.run(other.id, 'other@example.invalid');
  queue('personal', { caseId: 'private' });
  await dispatch();
  assert.deepEqual(sentRecipients(), []);
  contacts.run(owner.id, 'owner@example.invalid');
  store.db.prepare('UPDATE deliveries SET next=0').run();
  await dispatch();
  await dispatch();
  assert.deepEqual(sentRecipients(), ['owner@example.invalid']);

  queue('stale', { owner: owner.id, addressHash: digest('owner@example.invalid'), caseId:'private' });
  contacts.run(owner.id, 'changed@example.invalid');
  await dispatch();
  assert.equal(store.db.prepare("SELECT state FROM deliveries WHERE id='stale'").get().state, 'cancelled');
  env.SIGNAL_OWNER_LOGIN = 'OTHER';
  app.accounts.db.prepare('DELETE FROM email_contacts WHERE user=?').run(other.id);
  queue('designated', { caseId: 'shared', signalId: 'shared', revision: 1, proactive: true, recipientLogin: 'OTHER' });
  queue('disabled', { caseId: 'private', owner: owner.id }, 'telegram');
  await dispatch();
  assert.deepEqual(sentRecipients(), ['owner@example.invalid']);
  delete env.SIGNAL_OWNER_LOGIN;
  contacts.run(other.id, 'other@example.invalid');
  store.db.prepare('UPDATE deliveries SET next=0').run();
  await dispatch();
  await dispatch();
  assert.deepEqual(sentRecipients(), ['owner@example.invalid', 'other@example.invalid']);
  assert.equal(store.db.prepare("SELECT state FROM deliveries WHERE id='disabled'").get().state, 'queued');

  env.SIGNAL_OWNER_LOGIN = 'owner';
  queue('broadcast', { caseId: 'shared', broadcast:true });
  await dispatch();
  assert.equal(sentRecipients().at(-1), 'shared@example.invalid');
  queue('ambiguous-legacy', { caseId: 'shared' });
  await dispatch();
  assert.equal(store.db.prepare("SELECT state FROM deliveries WHERE id='ambiguous-legacy'").get().state, 'review');
  assert.equal(sentRecipients().length, 3);
});

test('legacy binding clients still receive a command when the bot is unconfigured', async t => {
  const { contact } = await fixture(t, { TELEGRAM_BOT_TOKEN: '', TELEGRAM_WEBHOOK_SECRET: '' });
  const binding = await contact('bind');
  assert.deepEqual(Object.keys(binding), ['command']);
  assert.match(binding.command, /^\/start [A-Za-z0-9_-]+$/);
});

test('the first claim after restart uses the original assigned audience, including for corrections', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-notice-restart-'));
  const base = join(dir, 'team.sqlite');
  const env = { NOTIFICATIONS_ENABLED:'true', SIGNAL_OWNER_LOGIN:'old', NOTIFICATION_CHANNELS:'smtp',
    SMTP_HOST:'mail.invalid', SMTP_FROM:'sender@example.invalid', SMTP_TO:'shared@example.invalid' };
  let app = createTeamApp({ base, env, background:false });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive:true, force:true, maxRetries:3 });
  });
  app.accounts.db.exec(`INSERT INTO users(id,login,space,role) VALUES
    ('old-owner','old','team','member'),('new-owner','new','team','member');
    INSERT INTO email_contacts VALUES('new-owner','new@example.invalid');`);
  const signal = { product:'Store', rule:'rolling', start:'2026-11-02', week:'2026-11-09',
    confirmedWeek:'2026-11-09', title:'Fixture', threshold:90, history:[{week:'2026-11-09',value:70}] };
  reconcileSignals(app.space('team').db, [signal], ['smtp']);
  await app.close();
  const sent = [];
  const after = {...env, SIGNAL_OWNER_LOGIN:'new'};
  app = createTeamApp({ base, env:after, background:false });
  const store = app.space('team');
  const dispatch = () => deliver(store, after, () => assert.fail('Unexpected Telegram request'),
    (_text,_env,to) => sent.push(to), app.accounts.db);
  await dispatch();
  assert.deepEqual(sent, []);
  app.accounts.db.prepare('INSERT INTO email_contacts VALUES(?,?)').run('old-owner','old@example.invalid');
  store.db.exec("UPDATE deliveries SET next=0 WHERE state='queued'");
  await dispatch();
  assert.deepEqual(sent, ['old@example.invalid']);
  reconcileSignals(store.db, [], ['smtp']);
  await dispatch();
  assert.deepEqual(sent, ['old@example.invalid','old@example.invalid']);

  delete after.SIGNAL_OWNER_LOGIN;
  const teamSignal = { ...signal, product:'Team' };
  reconcileSignals(store.db, [teamSignal], ['smtp']);
  await dispatch();
  after.SIGNAL_OWNER_LOGIN = 'new';
  after.SMTP_TO = 'different-shared@example.invalid';
  reconcileSignals(store.db, [], ['smtp']);
  await dispatch();
  assert.deepEqual(sent, ['old@example.invalid','old@example.invalid','shared@example.invalid','shared@example.invalid']);
});

test('an ownerless archive signal adopts the first assignment across channels and later revisions', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-notice-first-owner-'));
  const base = join(dir, 'team.sqlite');
  const env = { SOURCE_ARCHIVE_SHA256:digest('fixture'), NOTIFICATIONS_ENABLED:'true',
    SMTP_HOST:'mail.invalid', SMTP_FROM:'sender@example.invalid', SMTP_TO:'shared@example.invalid',
    TELEGRAM_BOT_TOKEN:'fixture', TELEGRAM_CHAT_IDS:'-123' };
  let app = createTeamApp({ base, env, background:false });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive:true, force:true, maxRetries:3 });
  });
  const sent = [];
  const send = (_url, {body}) => {
    sent.push(JSON.parse(body).chat_id);
    return Response.json({result:{message_id:1}});
  };
  const mail = (_text, _env, to) => sent.push(to);
  const dispatch = () => deliver(app.space('team'), env, send, mail, app.accounts.db);
  const ready = () => app.space('team').db.exec("UPDATE deliveries SET next=0 WHERE state='queued'");
  const signal = { product:'Store', rule:'rolling', start:'2026-11-02', week:'2026-11-09',
    confirmedWeek:'2026-11-09', title:'Fixture', threshold:90, history:[{week:'2026-11-09',value:70}] };
  const record = values => reconcileSignals(app.space('team').db, values, ['smtp', 'telegram']);
  record([signal]);
  await dispatch();
  assert.deepEqual(sent, []);
  env.SIGNAL_OWNER_LOGIN = 'first';
  ready();
  await dispatch();
  assert.deepEqual(sent, []);
  await app.close();
  env.SIGNAL_OWNER_LOGIN = 'other';
  app = createTeamApp({ base, env, background:false });
  app.accounts.db.exec(`INSERT INTO users(id,login,space,role) VALUES
    ('first-user','first','team','member'),('other-user','other','team','member');
    INSERT INTO email_contacts VALUES('first-user','first@example.invalid'),('other-user','other@example.invalid');
    INSERT INTO telegram VALUES('12','first-user','team','private'),('13','other-user','team','private');`);
  ready();
  await dispatch();
  await dispatch();
  assert.deepEqual(sent, ['first@example.invalid','12']);
  record([]);
  await dispatch();
  await dispatch();
  record([signal]);
  await dispatch();
  await dispatch();
  assert.deepEqual(sent, ['first@example.invalid','12','first@example.invalid','12','first@example.invalid','12']);
});

test('a queued private Telegram reply expires when its original binding is removed', async t => {
  const { app, store, env, messages, contact, hook, dispatch } = await fixture(t);
  const { command } = await contact('bind');
  await hook(31, command);
  await hook(32, '/ask Обзор');
  await workJobs(store, app.accounts, env, () => assert.fail('Unexpected model request'));
  assert.equal(store.db.prepare("SELECT count(*) n FROM deliveries WHERE channel='telegram' AND state='queued'").get().n, 1);
  await contact('contact-unlink', { channel:'telegram' });
  await dispatch();
  assert.deepEqual(messages, []);
});

test('a legacy Telegram job with an unrelated known update waits for review', async t => {
  const { app, store, env, messages, owner, contact, hook, dispatch } = await fixture(t);
  const { command } = await contact('bind');
  await hook(31, command);
  const thread = 'tg-' + owner.id;
  store.db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run(thread, owner.id, 'private', 'Fixture');
  const { id } = await contact('ask', { thread, requestId:'tg31', question:'Обзор' });
  store.db.prepare("UPDATE jobs SET body=json_set(body,'$.telegramChat','31') WHERE id=?").run(id);
  await workJobs(store, app.accounts, env, () => assert.fail('Unexpected model request'));
  assert.equal(store.db.prepare('SELECT status FROM jobs WHERE id=?').get(id).status, 'done');
  assert.equal(store.db.prepare("SELECT state FROM deliveries WHERE channel='telegram'").get().state, 'review');
  await dispatch();
  assert.deepEqual(messages, []);
});

test('web chat submissions cannot inject a Telegram reply destination', async t => {
  const { app, store, env, contact } = await fixture(t);
  const { id } = await contact('thread', { title:'Private' });
  await contact('ask', { thread:id, question:'Обзор', telegramChat:'-123',
    telegramReply:{chat:'-123',group:true} });
  await workJobs(store, app.accounts, env, () => assert.fail('Unexpected model request'));
  assert.equal(store.db.prepare("SELECT count(*) n FROM deliveries WHERE channel='telegram'").get().n, 0);
});

test('the Telegram queue retries a provider limit, skips definite refusals, and holds ambiguous responses', async t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  const clock = t.mock.timers;
  clock.enable({ apis: ['Date'], now: new Date('2026-05-20T09:00:00Z') });
  const env = { NOTIFICATIONS_ENABLED:'true', TELEGRAM_BOT_TOKEN:'fixture', TELEGRAM_CHAT_IDS:'-123' };
  const requests = [];
  const replies = [
    { ok:false, error_code:429, parameters:{retry_after:5} },
    { ok:true, result:{message_id:1} },
    { ok:false, error_code:403 },
    { ok:true, result:{} },
  ];
  const dispatch = () => deliver(store, env, async (_url, { body }) => {
    requests.push(JSON.parse(body).text);
    return Response.json(replies.shift());
  });
  const enqueue = id => store.db.prepare("INSERT INTO deliveries(id,channel,state,body) VALUES(?,'telegram','queued',?)")
    .run(id, JSON.stringify({ text:id }));
  const read = id => store.db.prepare('SELECT state, next, attempts FROM deliveries WHERE id=?').get(id);
  enqueue('limit');
  await dispatch();
  assert.equal(read('limit').state, 'queued');
  assert.equal(read('limit').next, Date.now() + 5000);
  await dispatch();
  assert.equal(read('limit').attempts, 1);
  clock.tick(5000);
  await dispatch();
  assert.equal(read('limit').state, 'delivered');
  enqueue('definite');
  await dispatch();
  assert.equal(read('definite').state, 'failed');
  enqueue('ambiguous');
  await dispatch();
  assert.equal(read('ambiguous').state, 'uncertain');
  await dispatch();
  assert.deepEqual(requests, ['limit', 'limit', 'definite', 'ambiguous']);
});

test('proactive Telegram omits invalid and loopback links and keeps public links', async t => {
  const store = openStore(':memory:');
  t.after(() => store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  const env = { NOTIFICATIONS_ENABLED:'true', TELEGRAM_BOT_TOKEN:'fixture', TELEGRAM_CHAT_IDS:'31' };
  const messages = [];
  const dispatch = () => deliver(store, env, async (_url, {body}) => {
    messages.push(JSON.parse(body));
    return Response.json({ok:true,result:{message_id:messages.length}});
  });
  const enqueueNotice = (id, issueUrl) => store.db
    .prepare("INSERT INTO deliveries(id,channel,state,body) VALUES(?,'telegram','queued',?)")
    .run(id, JSON.stringify({ caseId:'sample', text:'Проверка доставки', broadcast:true, issueUrl }));
  enqueueNotice('local', '/issues/17');
  await dispatch();
  assert.deepEqual(messages[0], { chat_id:'31', text:'Проверка доставки' });
  env.APP_BASE_URL = 'https://app.example.invalid';
  enqueueNotice('public', 'https://tracker.example.invalid/issues/17');
  await dispatch();
  assert.deepEqual(messages[1], { chat_id:'31', text:
    'Проверка доставки\nhttps://tracker.example.invalid/issues/17\nhttps://app.example.invalid/#case/sample' });
});

test('SMTP status and delivery wait for a configured sender', async t => {
  const { store, env, messages, contact, dispatch } = await fixture(t, { SMTP_FROM:'' });
  store.db.prepare("INSERT INTO deliveries(id,channel,state,body) VALUES('mail','smtp','queued',?)")
    .run(JSON.stringify({ caseId:'sample', text:'Тест', broadcast:true }));
  await dispatch();
  assert.equal((await contact('contacts')).smtpReady, false);
  assert.equal((await contact('status')).smtp, false);
  assert.equal(store.db.prepare("SELECT attempts FROM deliveries WHERE id='mail'").get().attempts, 0);
  assert.deepEqual(messages, []);
  env.SMTP_FROM = 'sender@example.invalid';
  store.db.exec("UPDATE deliveries SET next=0 WHERE id='mail'");
  await dispatch();
  assert.equal((await contact('status')).smtp, true);
  assert.deepEqual(messages, [
    { method:'smtp', text:'Тест\nhttp://127.0.0.1:8090/#case/sample', to:'shared@example.invalid' },
  ]);
});

async function smtpQueue(t, outcomes) {
  let accepted = 0;
  const sink = createSocketServer(socket => {
    const outcome = outcomes.shift();
    const send = line => socket.write(line + '\r\n');
    let text = '', data = false;
    socket.setEncoding('utf8');
    socket.on('error', () => {});
    socket.on('data', chunk => {
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
        } else if (line.startsWith('EHLO ') || line.startsWith('MAIL FROM:') || line === 'RSET') {
          send('250 OK');
        } else if (line.startsWith('RCPT TO:')) {
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
  await once(sink.listen(0, '127.0.0.1'), 'listening');
  t.after(() => new Promise(resolve => sink.close(resolve)));
  const port = String(sink.address().port);
  const env = {
    NOTIFICATIONS_ENABLED:'true', DATA_PROFILE:'local',
    SMTP_HOST:'127.0.0.1', SMTP_PORT:port, LOCAL_SMTP_TARGET:'127.0.0.1:' + port,
    SMTP_TLS:'plain', SMTP_FROM:'sender@example.invalid', SMTP_TO:'recipient@example.invalid',
    PYTHON_BIN:process.env.PYTHON_BIN,
  };
  const store = openStore(':memory:');
  t.after(() => store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  store.db.prepare("INSERT INTO deliveries(id,channel,state,body) VALUES('mail','smtp','queued',?)")
    .run(JSON.stringify({ text:'Проверка SMTP' }));
  return {
    accepted: () => accepted,
    run: () => deliver(store, env, () => assert.fail('Unexpected HTTP request')),
    state: () => store.one("SELECT state,attempts,next FROM deliveries WHERE id='mail'"),
    makeDue: () => store.db.exec("UPDATE deliveries SET next=0 WHERE id='mail'"),
  };
}

test('SMTP retries a known temporary rejection without duplicating an accepted mail', async t => {
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

test('SMTP preserves the final DATA acknowledgement if QUIT fails', async t => {
  const queue = await smtpQueue(t, ['quit-error']);
  await queue.run();
  await queue.run();
  assert.equal(queue.state().state, 'delivered');
  assert.equal(queue.state().attempts, 1);
  assert.equal(queue.accepted(), 1);
});

test('SMTP marks definite permanent rejections as failed', async t => {
  const queue = await smtpQueue(t, ['rejected']);
  await queue.run();
  await queue.run();
  assert.equal(queue.state().state, 'failed');
  assert.equal(queue.state().attempts, 1);
  assert.equal(queue.accepted(), 0);
});

test('SMTP never retries automatically after losing the final acknowledgement', async t => {
  const queue = await smtpQueue(t, ['disconnect']);
  await queue.run();
  await queue.run();
  assert.equal(queue.state().state, 'uncertain');
  assert.equal(queue.state().attempts, 1);
  assert.equal(queue.accepted(), 1);
});
