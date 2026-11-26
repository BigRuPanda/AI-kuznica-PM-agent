import { randomInt } from 'node:crypto';
import { secret } from './accounts.mjs';
import { digest } from './evidence.mjs';

export function initContacts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS email_contacts(user TEXT PRIMARY KEY,address TEXT UNIQUE COLLATE NOCASE);
    CREATE TABLE IF NOT EXISTS email_checks(user TEXT PRIMARY KEY,address TEXT,hash TEXT,issued INTEGER,attempts INTEGER);
    CREATE TABLE IF NOT EXISTS email_limits(key TEXT PRIMARY KEY,issued INTEGER);`);
}

export function destination(db, user, channel) {
  if (channel === 'smtp')
    return db.prepare('SELECT address FROM email_contacts WHERE user=?').get(user)?.address;
  return db
    .prepare("SELECT chat FROM telegram WHERE user=? AND kind='private' ORDER BY rowid DESC LIMIT 1")
    .get(user)?.chat;
}

export function bindTelegram(db, message) {
  if (message.chat.type !== 'private' || String(message.chat.id) !== String(message.from.id)) return;
  const code = digest(message.text.slice(7).trim());
  const link = db.prepare('SELECT user FROM bindings WHERE code=? AND expires>?').get(code, Date.now());
  if (!link) return;
  const chat = String(message.chat.id);
  const previous = db.prepare('SELECT user FROM telegram WHERE chat=?').get(chat);
  if (previous && previous.user !== link.user) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('DELETE FROM telegram WHERE user=?').run(link.user);
    db.prepare('INSERT INTO telegram VALUES(?,?,?,?)').run(chat, link.user, 'team', 'private');
    db.prepare('DELETE FROM bindings WHERE user=?').run(link.user);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function contactAction(op, data, user, db, env, sendMail, botName) {
  if (user.role === 'judge' || user.space !== 'team') throw Error('Используйте командный аккаунт');
  const id = user.id;
  const time = Date.now();
  const enabledBot =
    !!env.TELEGRAM_BOT_TOKEN && (!!env.TELEGRAM_WEBHOOK_SECRET || env.TELEGRAM_BIND_POLLING === 'true');
  const status = () => ({
    email: destination(db, id, 'smtp') || null,
    pending:
      db
        .prepare('SELECT address FROM email_checks WHERE user=? AND issued>? AND attempts<5')
        .get(id, time - 600000)?.address || null,
    telegram: !!destination(db, id, 'telegram'),
    smtpReady: !!(env.SMTP_HOST && env.SMTP_FROM),
    testMailbox: env.SMTP_TLS === 'local-test',
    telegramReady: enabledBot,
  });
  if (op === 'contacts') return status();
  if (op === 'contact-unlink') {
    if (data.channel === 'smtp') {
      db.prepare('DELETE FROM email_contacts WHERE user=?').run(id);
      db.prepare('DELETE FROM email_checks WHERE user=?').run(id);
    } else if (data.channel === 'telegram') {
      db.prepare('DELETE FROM telegram WHERE user=?').run(id);
      db.prepare('DELETE FROM bindings WHERE user=?').run(id);
    } else throw Error('Неизвестный канал');
    return status();
  }
  if (op === 'bind') {
    if (!enabledBot) throw Error('Администратору нужно подключить бота');
    const name = String(env.TELEGRAM_BOT_USERNAME || (await botName())).replace(/^@/, '');
    if (!/^[A-Za-z0-9_]{5,32}$/.test(name)) throw Error('Проверьте имя Telegram-бота');
    const code = secret();
    db.prepare('DELETE FROM bindings WHERE user=? OR expires<=?').run(id, time);
    db.prepare('INSERT INTO bindings VALUES(?,?,?)').run(digest(code), id, time + 600000);
    return { command: '/start ' + code, url: 'https://t.me/' + name + '?start=' + code };
  }
  if (op === 'email-request') {
    if (!env.SMTP_HOST || !env.SMTP_FROM) throw Error('Администратору нужно настроить SMTP');
    const address = String(data.address || '')
      .trim()
      .toLowerCase();
    if (address.length > 254 || !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+$/i.test(address))
      throw Error('Введите один адрес электронной почты');
    db.prepare('DELETE FROM email_limits WHERE issued<=?').run(time - 60000);
    const keys = ['user:' + id, 'address:' + digest(address)];
    if (keys.some((k) => db.prepare('SELECT 1 FROM email_limits WHERE key=?').get(k)))
      throw Error('Новый код можно запросить через минуту');
    for (const k of keys) db.prepare('INSERT INTO email_limits VALUES(?,?)').run(k, time);
    const code = String(randomInt(10000000, 100000000));
    const hash = digest([id, address, code].join('/'));
    db.prepare('INSERT OR REPLACE INTO email_checks VALUES(?,?,?,?,0)').run(id, address, hash, time);
    try {
      await sendMail('Код привязки почты к Signal: ' + code + '. Срок действия — 10 минут.', address);
    } catch (e) {
      db.prepare('DELETE FROM email_checks WHERE user=? AND hash=?').run(id, hash);
      throw e;
    }
    return status();
  }
  const check = db
    .prepare('SELECT * FROM email_checks WHERE user=? AND issued>? AND attempts<5')
    .get(id, time - 600000);
  if (!check) throw Error('Запросите новый код');
  if (digest([id, check.address, String(data.code)].join('/')) !== check.hash) {
    db.prepare('UPDATE email_checks SET attempts=attempts+1 WHERE user=?').run(id);
    throw Error('Код не подошёл');
  }
  const owner = db.prepare('SELECT user FROM email_contacts WHERE address=?').get(check.address);
  if (owner && owner.user !== id) throw Error('Адрес уже привязан к аккаунту');
  db.prepare(
    'INSERT INTO email_contacts VALUES(?,?) ON CONFLICT(user) DO UPDATE SET address=excluded.address',
  ).run(id, check.address);
  db.prepare('DELETE FROM email_checks WHERE user=?').run(id);
  return status();
}
