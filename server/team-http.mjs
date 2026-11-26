import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { root, databasePath, liveModelEnv } from './config.mjs';
import { openStore } from './store.mjs';
import { openAccounts, workspacePath, secret } from './accounts.mjs';
import { application } from './http.mjs';
import {
  initEvidence,
  importDocs,
  analysisView,
  getCase,
  updateCase,
  cases,
  search,
  digest,
  defaultRules,
  setSetting,
  setting,
  scan,
  effect,
  rankBacklog,
} from './evidence.mjs';
import {
  initWorkbench,
  dashboard,
  visibleCase,
  createThread,
  enqueue,
  messages,
  thread,
  workJobs,
  deliver,
  draft,
  confirm,
  cardTypes,
} from './workbench.mjs';
import { python, metrika, jira, telegram } from './connectors.mjs';
import { remoteMcp } from './team-mcp.mjs';

export function createTeamApp({
  base = databasePath(),
  env = liveModelEnv,
  send = fetch,
  background = true,
} = {}) {
  const accounts = openAccounts(join(dirname(base), 'accounts.sqlite')),
    spaces = new Map(),
    legacy = new Map(),
    busy = new Set(),
    authAttempts = new Map();
  const urlBase = new URL(env.APP_BASE_URL || 'http://127.0.0.1:8090'),
    secure = urlBase.protocol === 'https:';
  function space(id) {
    if (!spaces.has(id)) {
      const s = openStore(workspacePath(base, id));
      initEvidence(s.db);
      initWorkbench(s.db);
      spaces.set(id, s);
    }
    return spaces.get(id);
  }
  space('team');
  function seedDemo(id) {
    const db = space('team').db,
      versions = setting(db, 'demo_versions', []);
    const docs = versions.map((v) =>
      JSON.parse(db.prepare('SELECT body FROM documents WHERE version=?').get(v).body),
    );
    importDocs(space(id), docs, { notify: false });
  }
  const safeUser = (u) => ({ id: u.id, name: u.name, login: u.login, role: u.role, space: u.space });
  function admin(u) {
    if (u.role !== 'admin') throw Error('Требуются права администратора');
  }
  function tokenCookie(token, days = 30) {
    return (
      'pm_session=' +
      token +
      '; HttpOnly; SameSite=Lax; Path=/; Max-Age=' +
      days * 86400 +
      (secure ? '; Secure' : '')
    );
  }
  async function readBody(req, max) {
    let n = 0;
    const chunks = [];
    for await (const b of req) {
      n += b.length;
      if (n > max) throw Error('Файл слишком большой');
      chunks.push(b);
    }
    return Buffer.concat(chunks);
  }
  async function tick() {
    if (spaces.size === 0) return;
    for (const [id, s] of spaces) {
      if (busy.has(id)) continue;
      busy.add(id);
      void (async () => {
        await workJobs(s, accounts, env, send);
        const minutes = Number(env.METRIKA_SYNC_MINUTES || 0),
          sync = setting(s.db, 'last_metrika_sync', { at: 0 });
        if (id === 'team' && env.METRIKA_TOKEN && minutes >= 5 && Date.now() - sync.at >= minutes * 60000) {
          setSetting(s.db, 'last_metrika_sync', { at: Date.now(), status: 'running' });
          try {
            const data = await metrika(env, send);
            importDocs(s, data.docs);
            setSetting(s.db, 'last_metrika_sync', { at: Date.now(), status: 'ready', samples: data.samples });
          } catch (e) {
            setSetting(s.db, 'last_metrika_sync', { at: Date.now(), status: 'error', reason: e.message });
          }
        }
        for (const c of cases(s.db).filter((x) => x.state === 'Наблюдаем эффект' && x.body.watch)) {
          const report = effect(s.db, c);
          if (report?.actual != null && !c.body.watch.reviewed) {
            s.tx(() => {
              c.body.watch.reviewed = true;
              c.state = 'Нужно решение';
              updateCase(s.db, c);
              if (id === 'team')
                for (const channel of ['telegram', 'smtp'])
                  s.db
                    .prepare("INSERT OR IGNORE INTO deliveries(id,channel,state,body) VALUES(?,?,'queued',?)")
                    .run(
                      digest(c.id + JSON.stringify(c.body.watch)) + channel,
                      channel,
                      JSON.stringify({ caseId: c.id, text: report.state }),
                    );
            });
          }
        }
        if (id === 'team') await deliver(s, env, send);
      })()
        .catch(() => console.error('Фоновое поручение завершилось ошибкой'))
        .finally(() => busy.delete(id));
    }
  }
  // Discover persisted guest work after a restart without requiring the owner to log in.
  for (const u of accounts.db.prepare("SELECT DISTINCT space FROM users WHERE role='judge'").all())
    space(u.space);
  const timer = background ? setInterval(tick, 1500) : null;
  timer?.unref();
  const server = createServer(async (req, res) => {
    const reply = (status, data, headers = {}) => {
      res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        ...headers,
      });
      res.end(JSON.stringify(data));
    };
    try {
      const url = new URL(req.url, 'http://localhost'),
        p = url.pathname,
        method = req.method;
      const allowedHost =
        req.headers.host === urlBase.host ||
        (!secure && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || ''));
      if (!allowedHost) return reply(403, { error: 'Неизвестный адрес стенда' });
      if (
        req.headers.origin &&
        req.headers.origin !== urlBase.origin &&
        !(!secure && req.headers.origin === 'http://' + req.headers.host)
      )
        return reply(403, { error: 'Проверьте адрес приложения' });
      if (p === '/health') return reply(200, { ok: true });
      if (p === '/api/telegram' && method === 'POST') {
        if (
          !env.TELEGRAM_WEBHOOK_SECRET ||
          req.headers['x-telegram-bot-api-secret-token'] !== env.TELEGRAM_WEBHOOK_SECRET
        )
          return reply(403, { error: 'Недоступно' });
        const update = JSON.parse((await readBody(req, 100000)).toString()),
          msg = update.message,
          db = space('team').db;
        if (!msg?.text || db.prepare('SELECT id FROM known_updates WHERE id=?').get(update.update_id))
          return reply(200, { ok: true });
        const chat = String(msg.chat.id),
          sender = String(msg.from.id),
          group = msg.chat.type !== 'private';
        if (!group && msg.text.startsWith('/start ')) {
          const code = digest(msg.text.slice(7).trim()),
            link = accounts.db
              .prepare('SELECT user FROM bindings WHERE code=? AND expires>?')
              .get(code, Date.now());
          if (link) {
            accounts.db
              .prepare('INSERT OR REPLACE INTO telegram VALUES(?,?,?,?)')
              .run(sender, link.user, 'team', 'private');
            accounts.db.prepare('DELETE FROM bindings WHERE code=?').run(code);
          }
        } else {
          const bind = accounts.db.prepare('SELECT user FROM telegram WHERE chat=?').get(sender),
            allowed = String(env.TELEGRAM_CHAT_IDS || '')
              .split(',')
              .map((x) => x.trim());
          if (
            bind &&
            (!group || allowed.includes(chat)) &&
            (!group || msg.text.startsWith('/ask') || msg.reply_to_message?.from?.is_bot)
          ) {
            const user = accounts.publicUser(bind.user),
              tid = group ? 'tg-group-' + chat : 'tg-' + user.id;
            db.prepare('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?)').run(
              tid,
              user.id,
              group ? 'group' : 'private',
              'Telegram · ' + (group ? 'Команда' : user.name),
            );
            enqueue(space('team'), user, {
              question: msg.text.replace(/^\/ask(?:@\w+)?\s*/, '').trim() || 'Обзор',
              thread: tid,
              requestId: 'tg' + update.update_id,
              telegramChat: chat,
            });
          }
        }
        db.prepare('INSERT OR IGNORE INTO known_updates VALUES(?)').run(update.update_id);
        return reply(200, { ok: true });
      }
      const token = req.headers.cookie?.match(/(?:^|;\s*)pm_session=([A-Za-z0-9_-]+)/)?.[1] || '';
      const user = accounts.sessionUser(token);
      if (p === '/mcp') {
        const actor = accounts.bearer(req.headers.authorization?.replace(/^Bearer /, ''));
        if (!actor)
          return reply(401, { error: 'Требуется персональный ключ MCP' }, { 'WWW-Authenticate': 'Bearer' });
        return await remoteMcp(
          req,
          res,
          method === 'POST' ? JSON.parse((await readBody(req, 1e6)).toString()) : undefined,
          space(actor.space),
          actor,
        );
      }
      if (p.startsWith('/api/team/')) {
        const op = p.slice('/api/team/'.length);
        if (op === 'session' && method === 'GET') return reply(200, { user: user ? safeUser(user) : null });
        if (method !== 'POST') return reply(405, { error: 'Требуется POST' });
        if (!user && !['login', 'register'].includes(op))
          return reply(401, { error: 'Войдите в приложение' });
        if (op === 'upload') {
          admin(user);
          const name = decodeURIComponent(String(req.headers['x-file-name'] || ''));
          if (!/\.(xlsx|zip|pptx)$/i.test(name) || name.length > 250)
            throw Error('Выберите XLSX, PPTX или ZIP');
          const raw = await readBody(req, 32 * 1024 * 1024);
          const docs = JSON.parse(await python('office_import.py', [name], raw, env));
          return reply(
            200,
            importDocs(space(user.space), docs, { notify: env.NOTIFICATIONS_ENABLED === 'true' }),
          );
        }
        if (!req.headers['content-type']?.startsWith('application/json'))
          return reply(415, { error: 'Требуется JSON' });
        const b = JSON.parse((await readBody(req, 512000)).toString() || '{}');
        if (['register', 'login'].includes(op)) {
          const key = req.socket.remoteAddress || 'local',
            now = Date.now(),
            attempt = authAttempts.get(key) || { start: now, n: 0 };
          if (now - attempt.start > 60000) {
            attempt.n = 0;
            attempt.start = now;
          }
          authAttempts.set(key, attempt);
          if (++attempt.n > 40) return reply(429, { error: 'Повторите через минуту' });
          const result = op === 'login' ? await accounts.login(b) : await accounts.register(b, env, seedDemo);
          return reply(200, safeUser(result.user), { 'Set-Cookie': tokenCookie(result.token) });
        }
        const store = space(user.space),
          db = store.db;
        if (op === 'logout') {
          accounts.logout(token);
          return reply(200, {}, { 'Set-Cookie': tokenCookie('', 0) });
        }
        if (op === 'overview')
          return reply(200, {
            ...dashboard(db, user),
            issueMode: user.role === 'judge' || !env.JIRA_BASE_URL ? 'local' : 'jira',
          });
        if (op === 'invite') {
          admin(user);
          return reply(200, { code: accounts.invite(user.space) });
        }
        if (op === 'mcp-key') return reply(200, { key: accounts.issueKey(user.id) });
        if (op === 'bind') {
          if (user.role === 'judge') throw Error('Используйте командный аккаунт');
          const code = secret();
          accounts.db
            .prepare('INSERT INTO bindings VALUES(?,?,?)')
            .run(digest(code), user.id, Date.now() + 600000);
          return reply(200, { command: '/start ' + code });
        }
        if (op === 'rules') {
          admin(user);
          const threshold = Number(b.threshold);
          if (!(threshold > 0 && threshold <= 100)) throw Error('Порог от 0 до 100%');
          store.tx(() => {
            setSetting(db, 'rules', { ...setting(db, 'rules', defaultRules), threshold });
            scan(db, false);
          });
          return reply(200, { threshold });
        }
        if (op === 'case-thread') {
          const c = visibleCase(db, user, b.caseId),
            id = digest(user.id + '/' + c.id);
          db.prepare("INSERT OR IGNORE INTO conversations VALUES(?,?,'private',?)").run(id, user.id, c.title);
          return reply(200, { id });
        }
        if (op === 'thread') return reply(200, { id: createThread(db, user, b.title, !!b.group) });
        if (op === 'messages') return reply(200, messages(db, user, b.thread));
        if (op === 'say') {
          const t = thread(db, user, b.thread),
            text = String(b.question || '')
              .trim()
              .slice(0, 2400);
          if (t.scope !== 'group' || !text) throw Error('Выберите группу и введите сообщение');
          db.prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES(?,?,'user',?,?)").run(
            t.id,
            user.name,
            JSON.stringify({ text }),
            Date.now(),
          );
          return reply(200, { ok: true });
        }
        if (op === 'ask') return reply(200, { id: enqueue(store, user, b) });
        if (op === 'create-case') {
          if (!String(b.title || '').trim() || !String(b.product || '').trim())
            throw Error('Нужны вопрос и продукт');
          const plan = {
            hypothesis: String(b.hypothesis || '').slice(0, 1200),
            metric: String(b.metric || '').slice(0, 180),
            baseline: String(b.baseline || '').slice(0, 280),
            control: String(b.control || '').slice(0, 180),
            success: String(b.success || '').slice(0, 500),
          };
          const id = randomUUID();
          let origin = null;
          if (b.message) {
            const row = db
              .prepare("SELECT thread,body FROM chat_items WHERE seq=? AND role='assistant'")
              .get(b.message);
            if (!row) throw Error('Ответ не найден');
            thread(db, user, row.thread);
            const reply = JSON.parse(row.body);
            if (reply.product !== b.product) throw Error('Продукт исходного ответа отличается');
            origin = { calc: reply.calc, cards: reply.cards, full: reply.full };
          }
          db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(
            id,
            String(b.product).slice(0, 140),
            String(b.title).slice(0, 200),
            'Исследуем',
            JSON.stringify({
              owner: user.id,
              responsible: user.name,
              release: b.release || null,
              plan,
              origin,
            }),
          );
          return reply(200, { id });
        }
        if (op === 'view') {
          const c = visibleCase(db, user, b.caseId),
            view = analysisView(db, {
              caseId: c.id,
              full: !!b.full,
              control: b.control,
              sourceQuery: b.sourceQuery,
            });
          return reply(200, {
            case: c,
            view,
            effect: effect(db, c),
            backlog: rankBacklog(db, c.product),
            published: db
              .prepare('SELECT * FROM published WHERE case_id=? ORDER BY created DESC LIMIT 6')
              .all(c.id)
              .map((x) => ({ ...x, body: JSON.parse(x.body) })),
            drafts: db
              .prepare('SELECT * FROM draft_actions WHERE case_id=? AND (user=? OR state=?)')
              .all(c.id, user.id, 'done')
              .map((x) => ({ ...x, body: JSON.parse(x.body) })),
          });
        }
        if (op === 'calc') {
          const r = db.prepare('SELECT body FROM evidence_calcs WHERE id=?').get(b.id);
          if (!r) throw Error('Расчёт недоступен');
          return reply(200, JSON.parse(r.body));
        }
        if (op === 'publish') {
          const c = visibleCase(db, user, b.caseId),
            r = db.prepare('SELECT body FROM evidence_calcs WHERE id=?').get(b.calc);
          if (!r || JSON.parse(r.body).product !== c.product) throw Error('Расчёт не относится к продукту');
          const cards = Array.isArray(b.cards) ? b.cards.filter((x) => cardTypes.includes(x)) : [];
          if (!cards.length) throw Error('Выберите материалы');
          const conclusion = String(b.conclusion || '')
            .trim()
            .slice(0, 1400);
          store.tx(() => {
            delete c.body.owner;
            updateCase(db, c);
            db.prepare('INSERT INTO published VALUES(?,?,?,?,?)').run(
              randomUUID(),
              c.id,
              user.name,
              JSON.stringify({ calc: b.calc, cards, conclusion }),
              Date.now(),
            );
            db.prepare(
              "INSERT INTO chat_items(thread,author,role,body,created) VALUES('group',?,'user',?,?)",
            ).run(
              user.name,
              JSON.stringify({
                text: 'Опубликован разбор: ' + c.title + (conclusion ? '\n' + conclusion : ''),
                caseId: c.id,
                calc: b.calc,
                cards,
              }),
              Date.now(),
            );
          });
          return reply(200, { ok: true });
        }
        if (op === 'feedback') {
          const c = visibleCase(db, user, b.caseId);
          if (!b.source || !b.comment) throw Error('Нужны источник и поправка');
          db.prepare('INSERT INTO feedback(source,product,author,comment,created) VALUES(?,?,?,?,?)').run(
            String(b.source).slice(0, 500),
            c.product,
            user.name,
            String(b.comment).slice(0, 1400),
            Date.now(),
          );
          return reply(200, { ok: true });
        }
        if (op === 'watch') {
          const c = visibleCase(db, user, b.caseId),
            v = analysisView(db, { caseId: c.id, control: b.control });
          if (
            !/^\d{4}-\d\d-\d\d$/.test(b.deployed) ||
            !Number.isFinite(Date.parse(b.deployed)) ||
            !(b.percent > 0 && b.percent <= 300) ||
            !v.summary[1]?.before ||
            !v.summary[0]?.before
          )
            throw Error('Нужны дата выкладки, две базы и целевой процент');
          c.body.watch = {
            deployed: b.deployed,
            target: (v.summary[0].before * b.percent) / 100,
            control: v.summary[1].product,
            controlBase: v.summary[1].before,
            tolerance: setting(db, 'rules', defaultRules).controlTolerance,
          };
          c.state = 'Наблюдаем эффект';
          updateCase(db, c);
          return reply(200, effect(db, c));
        }
        if (op === 'decide') {
          const c = visibleCase(db, user, b.caseId);
          if (!['Исследуем', 'Нужно решение', 'Завершено'].includes(b.state))
            throw Error('Неизвестное решение');
          c.state = b.state;
          updateCase(db, c);
          return reply(200, { ok: true });
        }
        if (op === 'search') return reply(200, search(db, String(b.query || '')));
        if (op === 'jira-search') {
          if (user.role === 'judge' || !env.JIRA_BASE_URL)
            return reply(200, {
              local: true,
              items: [
                ...new Map([
                  ...search(db, b.query, ['backlog']).map((f) => [
                    f.key,
                    { title: f.data.title, key: f.key },
                  ]),
                  ...db
                    .prepare('SELECT key,title,priority FROM local_issues WHERE title LIKE ? OR key=?')
                    .all('%' + String(b.query || '') + '%', String(b.query || ''))
                    .map((f) => [f.key, f]),
                ]).values(),
              ],
            });
          return reply(200, { local: false, items: await jira(env, send).search(b.query) });
        }
        if (op === 'draft') return reply(200, draft(store, user, b));
        if (op === 'confirm') return reply(200, await confirm(store, user, b.id, env, send));
        if (op === 'metrika') {
          admin(user);
          const result = await metrika(env, send);
          const update = importDocs(store, result.docs);
          setSetting(db, 'last_metrika_sync', { at: Date.now(), status: 'ready', samples: result.samples });
          return reply(200, { ...update, samples: result.samples });
        }
        if (op === 'status') {
          admin(user);
          return reply(200, {
            metrika: !!env.METRIKA_TOKEN,
            jira: !!env.JIRA_BASE_URL,
            telegram: !!env.TELEGRAM_BOT_TOKEN,
            smtp: !!env.SMTP_HOST,
            llm: env.LLM_MODEL || '',
            notifications: env.NOTIFICATIONS_ENABLED === 'true',
          });
        }
        return reply(404, { error: 'Неизвестная операция' });
      }
      if (p.startsWith('/api/')) {
        if (!user) return reply(401, { error: 'Войдите в приложение' });
        if (method === 'POST' && ['/api/import', '/api/releases'].includes(p) && user.role !== 'admin')
          return reply(403, { error: 'Импорт архива доступен администратору' });
        req.pmActor = user.name;
        if (!legacy.has(user.space)) legacy.set(user.space, application(space(user.space), { env, send }));
        req.headers.host = '127.0.0.1';
        if (req.headers.origin) req.headers.origin = 'http://127.0.0.1';
        legacy.get(user.space).emit('request', req, res);
        return;
      }
      if (method !== 'GET') return reply(405, { error: 'Требуется GET' });
      const assets = {
        '/': 'index.html',
        '/app.js': 'app.js',
        '/app.css': 'app.css',
        '/legacy.js': 'legacy.js',
        '/legacy.css': 'legacy.css',
        '/report-fonts.css': 'report-fonts.css',
      };
      if (!Object.hasOwn(assets, p)) return reply(404, { error: 'Не найдено' });
      const file = assets[p],
        data = await readFile(join(root, 'dist', file));
      res.writeHead(200, {
        'Content-Type':
          (file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'text/html') +
          '; charset=utf-8',
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(data);
    } catch (e) {
      if (!res.headersSent) reply(400, { error: e.message?.slice(0, 500) || 'Ошибка запроса' });
    }
  });
  async function close() {
    if (timer) clearInterval(timer);
    if (server.listening) await new Promise((r) => server.close(r));
    while (busy.size) await new Promise((r) => setTimeout(r, 50));
    for (const s of spaces.values()) s.close();
    accounts.db.close();
  }
  return { server, accounts, space, close, tick };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const a = createTeamApp(),
    port = Number(process.env.PORT || 8090);
  a.server.listen(port, process.env.BIND_HOST || '127.0.0.1', () =>
    console.log('Softline PM · ' + (process.env.APP_BASE_URL || 'http://127.0.0.1:' + port)),
  );
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, () => a.close().then(() => process.exit(0)));
}
