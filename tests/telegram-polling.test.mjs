import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { contactAction } from '../server/notification-contacts.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { deliver, messages, workJobs } from '../server/workbench.mjs';

test('Telegram polling resumes from the saved offset and does not duplicate chat turns', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-telegram-polling-'));
  const env = {
    ADMIN_INVITE_KEY: 'fixture-admin',
    TELEGRAM_BOT_TOKEN: 'fixture-token',
    TELEGRAM_BOT_USERNAME: 'signal_fixture_bot',
    TELEGRAM_BIND_POLLING: 'true',
    TELEGRAM_CHAT_IDS: '-123',
    NOTIFICATIONS_ENABLED: 'false',
  };
  const polls = [];
  const batches = [];
  const replies = [];
  const unexpectedRequests = [];
  const send = async (url, request) => {
    const { origin, pathname } = new URL(url);
    if (origin === 'https://api.telegram.org' && pathname === '/botfixture-token/getUpdates') {
      polls.push(JSON.parse(request.body));
      return Response.json({ ok: true, result: batches.shift() ?? [] });
    }
    if (origin === 'https://api.telegram.org' && pathname === '/botfixture-token/sendMessage') {
      replies.push(JSON.parse(request.body));
      return Response.json({ ok: true, result: { message_id: replies.length } });
    }
    unexpectedRequests.push(url);
    throw Error('Unexpected fixture request');
  };
  const start = () => createTeamApp({ base: join(dir, 'team.sqlite'), env, send, background: false });
  let app;
  async function stop() {
    await app.close();
    app = undefined;
  }
  t.after(async () => {
    if (app) await stop();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });

  app = start();
  const { user } = await app.accounts.register({
    login: 'owner', name: 'Owner', password: 'fixture-password', code: env.ADMIN_INVITE_KEY,
  }, env);
  const { command } = await contactAction('bind', {}, user, app.accounts.db, env);
  const update = (id, text) => ({ update_id: id, message: {
    message_id: id, date: 1780000000, from: { id: 31, is_bot: false, first_name: 'Owner' },
    chat: { id: 31, type: 'private', first_name: 'Owner' }, text,
  } });
  const botReply = (id, chatId, text) => {
    const result = update(id, text);
    const chat = { id: chatId, type: 'supergroup', title: 'Команда' };
    result.message.chat = chat;
    result.message.reply_to_message = {
      message_id: 11, date: 1780000000, chat, text: 'Чем помочь?',
      from: { id: 777, is_bot: true, first_name: 'Signal', username: env.TELEGRAM_BOT_USERNAME },
    };
    return result;
  };
  const firstQuestion = update(41, '/ask Обзор');
  batches.push([update(40, command), firstQuestion]);
  await app.tick();
  await stop();

  app = start();
  assert.equal((await contactAction('contacts', {}, user, app.accounts.db, env)).telegram, true);
  const groupQuestion = 'Привет';
  batches.push([firstQuestion, update(42, '/ask Какие есть сигналы?'),
    botReply(43, -123, groupQuestion), botReply(44, -124, groupQuestion)]);
  await app.tick();
  await stop();

  app = start();
  const store = app.space('team');
  const history = messages(store.db, user, 'tg-' + user.id);
  assert.deepEqual(history.items.filter(item => item.role === 'user').map(item => item.body.text), [
    'Обзор', 'Какие есть сигналы?',
  ]);
  assert.deepEqual(polls.map(poll => poll.offset), [0, 42]);
  await t.test('a reply to the bot directs the assistant reply to the allowed group', async () => {
    const group = messages(store.db, user, 'tg-group--123');
    assert.deepEqual(group.items.filter(item => item.role === 'user').map(item => item.body.text), [groupQuestion]);
    assert.throws(() => messages(store.db, user, 'tg-group--124'), /Беседа недоступна/);
    for (let i = 0; i < 3; i++) await workJobs(store, app.accounts, env, send);
    for (let i = 0; i < 3; i++) await deliver(store, env, send, undefined, app.accounts.db);
    assert.equal(replies.filter(reply => reply.chat_id === '-123').length, 1);
    assert.equal(replies.some(reply => reply.chat_id === '-124'), false);
  });
  assert.deepEqual(unexpectedRequests, []);
});
