import { createCipheriv, createDecipheriv, randomBytes, randomUUID, createHash } from 'node:crypto';
import { confluence, redmine, exchange } from './tracker-clients.mjs';

export function initConnections(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS integration_sites(service TEXT PRIMARY KEY,config TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS integration_tokens(user TEXT,site TEXT,secret TEXT NOT NULL,PRIMARY KEY(user,site));
    CREATE TABLE IF NOT EXISTS integration_oauth(state TEXT PRIMARY KEY,user TEXT,site TEXT,expires INTEGER);`);
}
const services = ['redmine', 'confluence'];
function siteId(target) {
  return createHash('sha256').update(JSON.stringify(target)).digest('hex');
}
export function targetFor(db, user, service, env = process.env) {
  if (!services.includes(service)) throw Error('Неизвестный сервис');
  const cfg =
    user.role !== 'judge' && db.prepare('SELECT config FROM integration_sites WHERE service=?').get(service);
  if (cfg) return JSON.parse(cfg.config);
  if (service === 'redmine' && user.role !== 'judge' && env.SIGNAL_BRIDGE_URL)
    return { service, bridge: true, url: env.SIGNAL_BRIDGE_URL.replace(/\/+$/, ''), scope: 'Signal Bridge' };
  return { service, local: true };
}
export function configure(db, user, b) {
  if (user.role !== 'admin') throw Error('Требуются права администратора');
  if (!services.includes(b.service)) throw Error('Неизвестный сервис');
  if (typeof b.url !== 'string') throw Error('Укажите адрес сервиса');
  if (!b.url) {
    db.prepare('DELETE FROM integration_sites WHERE service=?').run(b.service);
    return;
  }
  const url = new URL(b.url);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash || url.search)
    throw Error('Укажите HTTPS-адрес сервиса без параметров');
  const scope = String(b.scope || '').trim();
  if (!/^[\p{L}\d_.~-]{1,128}$/u.test(scope))
    throw Error('Проверьте идентификатор проекта или ключ пространства');
  const config = { service: b.service, url: url.href.replace(/\/+$/, ''), scope };
  if (b.service === 'confluence') {
    if (!['cloud', 'dc'].includes(b.edition)) throw Error('Выберите редакцию Confluence');
    config.edition = b.edition;
    if (b.edition === 'cloud') config.url = url.origin;
  }
  db.prepare('INSERT OR REPLACE INTO integration_sites VALUES(?,?)').run(b.service, JSON.stringify(config));
}
function encryptionKey(env) {
  const key = Buffer.from(env.INTEGRATION_KEY || '', 'base64url');
  if (key.length !== 32) throw Error('Выполните pnpm setup для настройки ключа шифрования подключений');
  return key;
}
function seal(env, context, data) {
  const iv = randomBytes(12),
    cipher = createCipheriv('aes-256-gcm', encryptionKey(env), iv);
  cipher.setAAD(Buffer.from(context));
  const body = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), body].map((x) => x.toString('base64url')).join('.');
}
function open(env, context, data) {
  const [iv, tag, body] = data.split('.').map((x) => Buffer.from(x, 'base64url'));
  const cipher = createDecipheriv('aes-256-gcm', encryptionKey(env), iv);
  cipher.setAAD(Buffer.from(context));
  cipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([cipher.update(body), cipher.final()]).toString());
}
function remember(db, user, target, env, credential) {
  const site = siteId(target);
  db.prepare('INSERT OR REPLACE INTO integration_tokens VALUES(?,?,?)').run(
    user.id,
    site,
    seal(env, user.id + site, credential),
  );
}
function adapter(target, credential, send) {
  return target.service === 'redmine'
    ? redmine(target, credential.token, send)
    : confluence(target, credential, send);
}
export function connectionInfo(db, user, env = process.env) {
  return Object.fromEntries(
    services.map((service) => {
      const t = targetFor(db, user, service, env);
      return [
        service,
        {
          ...t,
          connected:
            !!t.bridge ||
            (!t.local &&
              !!db
                .prepare('SELECT 1 FROM integration_tokens WHERE user=? AND site=?')
                .get(user.id, siteId(t))),
        },
      ];
    }),
  );
}
function redirectUri(env) {
  return new URL('/api/integrations/confluence/callback', env.APP_BASE_URL || 'http://127.0.0.1:8090').href;
}
async function oauthToken(env, send, data) {
  if (!env.CONFLUENCE_CLIENT_ID || !env.CONFLUENCE_CLIENT_SECRET)
    throw Error('Настройте OAuth-приложение Confluence Cloud');
  return exchange(send, 'Confluence · авторизация', 'https://auth.atlassian.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: env.CONFLUENCE_CLIENT_ID,
      client_secret: env.CONFLUENCE_CLIENT_SECRET,
      ...data,
    }),
  });
}
const refreshing = new WeakMap();
export async function remoteClient(db, user, target, env, send) {
  if (target.local || siteId(targetFor(db, user, target.service, env)) !== siteId(target))
    throw Error('Назначение изменилось. Создайте новый черновик');
  const site = siteId(target),
    ctx = user.id + site;
  const row = db.prepare('SELECT secret FROM integration_tokens WHERE user=? AND site=?').get(user.id, site);
  if (!row) throw Error('Подключите личный доступ к ' + target.service + ' в настройках');
  let cred = open(env, ctx, row.secret);
  if (target.edition === 'cloud' && cred.expires <= Date.now() + 60000) {
    if (!refreshing.has(db)) refreshing.set(db, new Map());
    const pending = refreshing.get(db);
    if (!pending.has(ctx))
      pending.set(
        ctx,
        (async () => {
          const r = await oauthToken(env, send, { grant_type: 'refresh_token', refresh_token: cred.refresh });
          const updated = {
            ...cred,
            token: r.access_token,
            refresh: r.refresh_token || cred.refresh,
            expires: Date.now() + r.expires_in * 1000,
          };
          const saved = db
            .prepare('UPDATE integration_tokens SET secret=? WHERE user=? AND site=? AND secret=?')
            .run(seal(env, ctx, updated), user.id, site, row.secret);
          if (!saved.changes) throw Error('Подключение изменилось. Повторите запрос');
          return updated;
        })()
          .catch(() => {
            throw Error('Переподключите Confluence Cloud в настройках');
          })
          .finally(() => pending.delete(ctx)),
      );
    cred = await pending.get(ctx);
  }
  return adapter(target, cred, send);
}
export async function personalConnection(db, user, b, env, send) {
  const target = targetFor(db, user, b.service, env);
  if (target.local || target.bridge)
    throw Error('Сначала настройте адрес персонального подключения для команды');
  const site = siteId(target);
  if (b.action === 'disconnect') {
    db.prepare('DELETE FROM integration_tokens WHERE user=? AND site=?').run(user.id, site);
    db.prepare('DELETE FROM integration_oauth WHERE user=? AND site=?').run(user.id, site);
  } else if (b.action === 'check') {
    await (await remoteClient(db, user, target, env, send)).check();
  } else if (b.action === 'connect') {
    encryptionKey(env);
    if (target.edition === 'cloud') {
      if (!env.CONFLUENCE_CLIENT_ID || !env.CONFLUENCE_CLIENT_SECRET)
        throw Error('Настройте OAuth-приложение Confluence Cloud');
      const state = randomUUID();
      db.prepare('DELETE FROM integration_oauth WHERE expires<? OR (user=? AND site=?)').run(
        Date.now(),
        user.id,
        site,
      );
      db.prepare('INSERT INTO integration_oauth VALUES(?,?,?,?)').run(
        state,
        user.id,
        site,
        Date.now() + 600000,
      );
      const params = new URLSearchParams({
        audience: 'api.atlassian.com',
        client_id: env.CONFLUENCE_CLIENT_ID,
        scope:
          'read:confluence-content.all read:confluence-space.summary search:confluence write:confluence-content read:page:confluence write:page:confluence read:space:confluence offline_access',
        response_type: 'code',
        prompt: 'consent',
        state,
        redirect_uri: redirectUri(env),
      });
      return { authorize: 'https://auth.atlassian.com/authorize?' + params };
    }
    if (typeof b.token !== 'string' || !b.token.trim() || b.token.length > 16000)
      throw Error('Введите персональный токен');
    const credential = { token: b.token.trim() };
    await adapter(target, credential, send).check();
    remember(db, user, target, env, credential);
  } else throw Error('Неизвестное действие подключения');
  return connectionInfo(db, user, env);
}
export async function finishOAuth(db, user, params, env, send) {
  const target = targetFor(db, user, 'confluence'),
    site = siteId(target);
  const taken = db
    .prepare('DELETE FROM integration_oauth WHERE state=? AND user=? AND site=? AND expires>?')
    .run(params.get('state') || '', user.id, site, Date.now());
  if (!taken.changes || target.edition !== 'cloud' || !params.get('code'))
    throw Error('Повторите подключение Confluence Cloud');
  const r = await oauthToken(env, send, {
    grant_type: 'authorization_code',
    code: params.get('code'),
    redirect_uri: redirectUri(env),
  });
  const resources = await exchange(
    send,
    'Confluence',
    'https://api.atlassian.com/oauth/token/accessible-resources',
    { headers: { Authorization: 'Bearer ' + r.access_token } },
  );
  const resource = resources.find(
    (x) => new URL(x.url).origin === target.url && x.scopes?.some((s) => s.includes('confluence')),
  );
  if (!resource || !r.refresh_token) throw Error('Выберите настроенный сайт и разрешите доступ Confluence');
  const cred = {
    cloudId: resource.id,
    token: r.access_token,
    refresh: r.refresh_token,
    expires: Date.now() + r.expires_in * 1000,
  };
  await adapter(target, cred, send).check();
  remember(db, user, target, env, cred);
}
