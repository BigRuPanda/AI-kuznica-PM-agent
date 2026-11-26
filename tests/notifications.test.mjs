import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamApp } from '../server/team-http.mjs';
import { collectClosures } from '../server/redmine-bridge.mjs';
import { deliver } from '../server/workbench.mjs';

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
    assert.equal((await call('knowledge')).results.length, 1);
    assert.equal((await call('knowledge', {}, other.cookie)).results.length, 0);
    assert.equal((await call('knowledge', {}, guest.cookie)).results.length, 0);
    assert.equal(mail.length, 2);
    assert.equal(mail[1].to, 'owner@example.invalid');
    assert.match(mail[1].text, /Closed/);
    assert.equal(telegram.length, 1);
    assert.equal(telegram[0].chat_id, '31');
    closures.push({ ...closures[0], seq: 2, episode: 2 });
    await collect();
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
    await rm(dir, { recursive: true, force: true });
  }
});
