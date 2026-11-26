import { readFile, writeFile } from 'node:fs/promises';
import { loadEnvFile } from 'node:process';

const configFile = new URL('.env', import.meta.url);
const template = new URL('.env.example', import.meta.url);

async function telegram(token, method, params = {}) {
  let response;
  try {
    response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
      redirect: 'error',
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new Error('Не удалось связаться с Telegram. Проверь подключение к интернету.');
  }
  if (response.status === 401) throw new Error('Telegram отклонил TELEGRAM_BOT_TOKEN.');
  if (!response.ok) throw new Error(`Ошибка Telegram при ${method} (HTTP ${response.status}).`);
  const data = await response.json();
  if (!data.ok) throw new Error(`Telegram отклонил запрос ${method}.`);
  return data.result;
}

async function checkDestination(token, botId, id, channel) {
  const chat = await telegram(token, 'getChat', { chat_id: id });
  if (channel !== (chat.type === 'channel')) throw new Error('ID указан в поле другого типа. Проверь TELEGRAM_CHANNEL_ID и TELEGRAM_CHAT_IDS.');
  if (chat.type === 'private') return 'Личный чат доступен для просмотра.';
  const member = await telegram(token, 'getChatMember', { chat_id: id, user_id: botId });
  if (channel) {
    if (member.status !== 'creator' && !(member.status === 'administrator' && member.can_post_messages)) {
      throw new Error('Выдай боту право публикации в канале.');
    }
    return `Канал «${chat.title}» доступен для публикации.`;
  }
  const canWrite = member.status === 'administrator' || member.status === 'creator' ||
    (member.status === 'member' && (!chat.permissions || chat.permissions.can_send_messages)) ||
    (member.status === 'restricted' && member.is_member && member.can_send_messages);
  if (!canWrite) throw new Error('Добавь бота в группу с правом отправки сообщений.');
  return `Группа «${chat.title}» доступна для сообщений.`;
}

async function main() {
  const action = process.argv[2];
  if (action === 'init') {
    try {
      await writeFile(configFile, await readFile(template), { flag: 'wx', mode: 0o600 });
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
    }
    console.log('Файл настроек проекта: .env');
    return;
  }
  if (action !== 'check') {
    console.log('node telegram.mjs check | init');
    if (action && action !== '--help') process.exitCode = 2;
    return;
  }
  try {
    loadEnvFile(configFile);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const { TELEGRAM_BOT_TOKEN: token, TELEGRAM_CHANNEL_ID: channelId, TELEGRAM_CHAT_IDS: chatList } = process.env;
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token || '')) throw new Error('Укажи токен бота в TELEGRAM_BOT_TOKEN.');
  const chatIds = new Set(chatList?.trim() ? chatList.split(',').map(value => value.trim()) : []);
  const targets = [];
  if (channelId?.trim()) targets.push({ id: channelId.trim(), channel: true });
  for (const id of chatIds) targets.push({ id, channel: false });
  if (!targets.length) throw new Error('Заполни TELEGRAM_CHANNEL_ID или TELEGRAM_CHAT_IDS.');
  if (targets.some(({ id }) => !/^-?[1-9]\d*$/.test(id))) throw new Error('Используй числовые Telegram ID. Несколько чатов перечисли через запятую.');
  const bot = await telegram(token, 'getMe');
  console.log(`Бот @${bot.username}`);
  for (const { id, channel } of targets) {
    try {
      console.log(id, await checkDestination(token, bot.id, id, channel));
    } catch (error) {
      console.error(id, error.message);
      process.exitCode = 1;
    }
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
