import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, scrypt as deriveKey, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import { digest } from './evidence.mjs';
const scrypt = promisify(deriveKey);
export const secret = () => randomBytes(32).toString('base64url');
export function openAccounts(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(
    'PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY,login TEXT UNIQUE,name TEXT,salt TEXT,hash TEXT,space TEXT,role TEXT);' +
      'CREATE TABLE IF NOT EXISTS sessions(hash TEXT PRIMARY KEY,user TEXT,expires INTEGER);CREATE TABLE IF NOT EXISTS invites(hash TEXT PRIMARY KEY,space TEXT,role TEXT,expires INTEGER);' +
      'CREATE TABLE IF NOT EXISTS bindings(code TEXT PRIMARY KEY,user TEXT,expires INTEGER);CREATE TABLE IF NOT EXISTS telegram(chat TEXT PRIMARY KEY,user TEXT,space TEXT,kind TEXT);' +
      'CREATE TABLE IF NOT EXISTS api_keys(hash TEXT PRIMARY KEY,user TEXT);',
  );
  const publicUser = (id) => db.prepare('SELECT id,login,name,space,role FROM users WHERE id=?').get(id);
  function session(id) {
    const token = secret();
    db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(digest(token), id, Date.now() + 30 * 86400000);
    return { user: publicUser(id), token };
  }
  return {
    db,
    publicUser,
    sessionUser(token) {
      const s = db
        .prepare('SELECT user FROM sessions WHERE hash=? AND expires>?')
        .get(digest(token || ''), Date.now());
      return s && publicUser(s.user);
    },
    bearer(token) {
      const row = db.prepare('SELECT user FROM api_keys WHERE hash=?').get(digest(token || ''));
      return row && publicUser(row.user);
    },
    issueKey(id) {
      const token = secret();
      db.prepare('DELETE FROM api_keys WHERE user=?').run(id);
      db.prepare('INSERT INTO api_keys VALUES(?,?)').run(digest(token), id);
      return token;
    },
    invite(space, role = 'member') {
      const token = secret();
      db.prepare('INSERT INTO invites VALUES(?,?,?,?)').run(
        digest(token),
        space,
        role,
        Date.now() + 7 * 86400000,
      );
      return token;
    },
    logout(token) {
      db.prepare('DELETE FROM sessions WHERE hash=?').run(digest(token));
    },
    async register({ login, name, password, code }, env, prepareDemo) {
      login = String(login || '')
        .trim()
        .toLowerCase();
      name = String(name || '').trim();
      if (
        !/^[\p{L}\p{N}_.@-]{3,80}$/u.test(login) ||
        !name ||
        name.length > 100 ||
        typeof password !== 'string' ||
        password.length < 8 ||
        password.length > 256
      )
        throw Error('Введите имя, логин от 3 символов и пароль от 8 до 256 символов.');
      const salt = secret(),
        hash = (await scrypt(password, salt, 64)).toString('hex'),
        id = randomUUID();
      db.exec('BEGIN IMMEDIATE');
      try {
        const invite = db
          .prepare('SELECT * FROM invites WHERE hash=? AND expires>?')
          .get(digest(String(code || '')), Date.now());
        const demo = !!env.DEMO_INVITE_KEY && code === env.DEMO_INVITE_KEY;
        const admin =
          !!env.ADMIN_INVITE_KEY &&
          code === env.ADMIN_INVITE_KEY &&
          !db.prepare("SELECT id FROM users WHERE role='admin'").get();
        if (!invite && !demo && !admin) throw Error('Требуется действующее приглашение.');
        if (db.prepare('SELECT id FROM users WHERE login=?').get(login))
          throw Error('Выберите другой логин.');
        const space = demo ? id : invite?.space || 'team',
          role = demo ? 'judge' : admin ? 'admin' : invite.role;
        db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?,?)').run(id, login, name, salt, hash, space, role);
        if (invite) db.prepare('DELETE FROM invites WHERE hash=?').run(invite.hash);
        if (demo) prepareDemo(space);
        const result = session(id);
        db.exec('COMMIT');
        return result;
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
    },
    async login({ login, password }) {
      const row = db.prepare('SELECT * FROM users WHERE login=?').get(
        String(login ?? '')
          .trim()
          .toLowerCase(),
      );
      const candidate = await scrypt(
        String(password ?? '').slice(0, 256),
        row?.salt || 'unavailable-user',
        64,
      );
      if (!row || !timingSafeEqual(candidate, Buffer.from(row.hash, 'hex')))
        throw Error('Проверьте логин и пароль.');
      return session(row.id);
    },
  };
}
export function workspacePath(base, space) {
  if (space === 'team') return base;
  if (!/^[a-f0-9-]{36}$/.test(space)) throw Error('Неизвестная команда');
  return join(dirname(base), 'workspaces', space + '.sqlite');
}
