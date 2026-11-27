import { initSourcePolicy, approveSource, sourcePermission, importApproved, sourceHistory } from './source-policy.mjs';
import { operations as catalog, workspaceOperation } from './workspace-operations.mjs';
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
  updateCase,
  cases,
  digest,
  defaultRules,
  setSetting,
  setting,
  scan,
  effect,
} from './evidence.mjs';
import {
  initWorkbench,
  dashboard,
  visibleCase,
  createThread,
  renameThread,
  deleteThread,
  enqueue,
  addUserMessage,
  messages,
  thread,
  workJobs,
  deliver,
} from './workbench.mjs';
import { python, telegram } from './connectors.mjs';
import { initMetrikaSync, metrikaStatus, syncMetrika } from './metrika-sync.mjs';
import { preview, revisePage } from './tracker-workflow.mjs';
import { configure, connectionInfo, personalConnection, finishOAuth } from './tracker-connections.mjs';
import { remoteMcp } from './team-mcp.mjs';
import { retainMaterial, readMaterial, attachedMaterials, materialRef, materialPreview } from './materials.mjs';
import { access } from './chart-ranges.mjs';
import { resumeJob } from './workbench.mjs';
import { metricRuleStatus, saveMetricRule } from './metric-rules.mjs';
import { researchSettings, saveResearchSettings } from './investigation-settings.mjs';
import { notificationChannels } from './data-profile.mjs';
import {
  createAlternative, publishInvestigation, readInvestigations,
  syncInvestigations, workInvestigation,
} from './case-investigations.mjs';
import { prepareInvestigationDraft } from './investigation-draft.mjs';

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
    researching = new Set(),
    reconciledAt = new Map(),
    authAttempts = new Map();
  const urlBase = new URL(env.APP_BASE_URL || 'http://127.0.0.1:8090'),
    secure = urlBase.protocol === 'https:';
  function space(id) {
    if (!spaces.has(id)) {
      const s = openStore(workspacePath(base, id),{seedDemo:!env.SOURCE_ARCHIVE_SHA256});
      initEvidence(s.db);
      initWorkbench(s.db);
      initSourcePolicy(s.db);
      initMetrikaSync(s.db);
      reconciledAt.set(id, Date.now());

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
  const safeUser = (u) => ({
    id: u.id, name: u.name, login: u.login, role: u.role, space: u.space, avatar: accounts.avatar(u.id),
  });
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
      if (Date.now() - (reconciledAt.get(id) || 0) >= 60_000) {
        try {
          syncInvestigations(s.db);
          reconciledAt.set(id, Date.now());
        } catch {
          console.error('Не удалось сверить активные исследования');
        }
      }
      if (!researching.has(id)) {
        researching.add(id);
        void workInvestigation(s, env, send, { reconcile: false })
          .catch(() => console.error('Не удалось обработать очередь исследований'))
          .finally(() => researching.delete(id));
      }
      if (busy.has(id)) continue;
      busy.add(id);
      void (async () => {
        await workJobs(s, accounts, env, send);
        const minutes = Number(env.METRIKA_SYNC_MINUTES || 0),
          sync = setting(s.db, 'last_metrika_sync', { at: 0 });
        if (!env.SOURCE_ARCHIVE_SHA256 && id === 'team' && env.METRIKA_TOKEN && minutes >= 5 && Date.now() - sync.at >= minutes * 60000) {
          await syncMetrika(s, env, send).catch(() => {}); // The journal retains failures for each source.
        }
        for (const c of cases(s.db).filter((x) => x.state === 'Наблюдаем эффект' && x.body.watch)) {
          const report = effect(s.db, c);
          if (report?.actual != null && !c.body.watch.reviewed) {
            s.tx(() => {
              c.body.watch.reviewed = true;
              c.state = 'Нужно решение';
              updateCase(s.db, c);
              if (id === 'team')
                for (const channel of notificationChannels(env))
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
      if (p === '/api/integrations/confluence/callback' && method === 'GET') {
        if (!user) return reply(401, { error: 'Войдите и повторите подключение Confluence' });
        await finishOAuth(space(user.space).db, user, url.searchParams, env, send);
        res.writeHead(303, {
          Location: '/#settings/personal',
          'Cache-Control': 'no-store',
          'Referrer-Policy': 'no-referrer',
        });
        res.end();
        return;
      }
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
          env,
          send,
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
          const store=space(user.space);
          const permission=sourcePermission(store.db,env.SOURCE_ARCHIVE_SHA256,raw,name);
          const docs = permission?.alreadyImported?[]:JSON.parse(await python('office_import.py', [name], raw, env));
          return reply(
            200,
            importApproved(store,docs,permission,env.NOTIFICATIONS_ENABLED === 'true' && notificationChannels(env)),
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
        if (op === 'profile') return reply(200, safeUser(accounts.updateProfile(user.id, b)));
        const store = space(user.space),
          db = store.db;
        if(op==='source-history') return reply(200,{versions:sourceHistory(db,b.file)});
        if(op==='approve-source') {
          admin(user);
          if(!env.SOURCE_ARCHIVE_SHA256) throw Error('Согласование доступно в защищённом пространстве.');
          approveSource(store,b,user.name,env.SOURCE_ARCHIVE_SHA256);
          return reply(200,{approved:true});
        }
        if (op === 'investigation-status') return reply(200, readInvestigations(db, user, b.caseId));
        if (op === 'investigation-alternative') return reply(200, createAlternative(db, user, b));
        if (op === 'investigation-publish') return reply(200, publishInvestigation(db, user, b));
        if (op === 'investigation-draft') return reply(200, await prepareInvestigationDraft(store, user, b, env, send));
        if (op === 'investigation-measurement') return reply(200, workspaceOperation(store, user, op, b));
        if (op === 'logout') {
          accounts.logout(token);
          return reply(200, {}, { 'Set-Cookie': tokenCookie('', 0) });
        }
        if (op === 'tracker-preview' || op === 'tracker-revise') {
          const row = db.prepare('SELECT * FROM draft_actions WHERE id=? AND user=?').get(b.id, user.id);
          if (!row) throw Error('Черновик недоступен');
          visibleCase(db, user, row.case_id);
          return reply(
            200,
            op === 'tracker-revise' ? await revisePage(store, user, row, b, env, send) : preview(row),
          );
        }
        if (op === 'integration-config') {
          configure(db, user, b);
          return reply(200, connectionInfo(db, user));
        }
        if (op === 'integration-access') return reply(200, await personalConnection(db, user, b, env, send));
        if (op === 'overview')
          return reply(200, {
            ...dashboard(db, user), archiveOnly:!!env.SOURCE_ARCHIVE_SHA256,
            metrikaSync: user.space === 'team' ? metrikaStatus(db, env) : { reports: [] },
            notificationsEnabled: user.space === 'team' && env.NOTIFICATIONS_ENABLED === 'true',
            notificationChannels: user.space === 'team' ? notificationChannels(env) : [],
            integrations: connectionInfo(db, user),
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
        if (op === 'research-settings') return reply(200, researchSettings(db, user));
        if (op === 'save-research-settings') return reply(200, saveResearchSettings(db, user, b));
        if (op === 'metric-rule-status') return reply(200, metricRuleStatus(db));
        if (op === 'metric-rules') {
          admin(user);
          store.tx(() => {
            saveMetricRule(db, b);
            scan(db, env.NOTIFICATIONS_ENABLED === 'true' && notificationChannels(env));
          });
          return reply(200, metricRuleStatus(db));
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
        if (op === 'rename-thread') return reply(200, renameThread(db, user, b.thread, b.title));
        if (op === 'delete-thread') return reply(200, deleteThread(store, user, b.thread));
        if (op === 'messages') return reply(200, messages(db, user, b.thread));
        if (op === 'material') {
          const m = readMaterial(db, user, b.id);
          const pins = db
            .prepare('SELECT case_id FROM case_materials WHERE user=? AND material=?')
            .all(user.id, b.id);
          let shared = true;
          try {
            access(db, user, b.id, true);
          } catch {
            shared = false;
          }
          return reply(200, {
            ...(b.preview ? materialPreview(m) : m),
            shared,
            pins: pins.map((p) => p.case_id),
          });
        }
        if (op === 'case-materials') {
          visibleCase(db, user, b.caseId);
          const rows = db
            .prepare('SELECT material FROM case_materials WHERE user=? AND case_id=? ORDER BY rowid')
            .all(user.id, b.caseId);
          return reply(200, {
            items: rows.map((r) => materialRef(r.material, readMaterial(db, user, r.material))),
          });
        }
        if (op === 'pin-material') {
          const result = store.tx(() => {
            const m = readMaterial(db, user, b.id);
            let caseId = b.caseId;
            if (
              !caseId &&
              typeof b.createRequest === 'string' &&
              b.createRequest.length <= 100 &&
              b.createRequest &&
              !b.remove
            ) {
              caseId = db
                .prepare('SELECT case_id FROM material_case_requests WHERE user=? AND request=?')
                .get(user.id, b.createRequest)?.case_id;
              if (!caseId) {
                caseId = workspaceOperation(store, user, 'create-case', {
                  title: m.title,
                  product: m.product || b.product,
                }).id;
                db.prepare('INSERT INTO material_case_requests VALUES(?,?,?)').run(
                  user.id,
                  b.createRequest,
                  caseId,
                );
              }
            }
            visibleCase(db, user, caseId);
            if (b.remove === true)
              db.prepare('DELETE FROM case_materials WHERE user=? AND case_id=? AND material=?').run(
                user.id,
                caseId,
                b.id,
              );
            else {
              retainMaterial(db, user.id, b.id);
              db.prepare('INSERT OR IGNORE INTO case_materials VALUES(?,?,?)').run(user.id, caseId, b.id);
            }
            return { pinned: b.remove !== true, caseId };
          });
          return reply(200, result);
        }
        if (op === 'resume-job')
          return reply(
            200,
            store.tx(() => resumeJob(db, user, b.id)),
          );
        if (op === 'say') {
          const t = thread(db, user, b.thread),
            text = String(b.question || '')
              .trim()
              .slice(0, 2400);
          if (t.scope !== 'group' || !text) throw Error('Выберите группу и введите сообщение');
          store.tx(() => {
            const materials = attachedMaterials(
              db,
              user,
              b.materialIds,
              t,
              b.shareMaterials === true,
            );
            addUserMessage(db, user, t.id, { text, materials });
          });
          return reply(200, { ok: true });
        }
        if (op === 'ask') return reply(200, { id: enqueue(store, user, b) });
        if (op === 'range-chat') {
          const result = b.rangeId
            ? workspaceOperation(store, user, 'range_read', { id: b.rangeId })
            : workspaceOperation(store, user, 'range_compare', { selection: b.selection });
          const id = digest(user.id + '/chart/' + result.calcId);
          db.prepare("INSERT OR IGNORE INTO conversations VALUES(?,?,'private',?)").run(
            id,
            user.id,
            result.title,
          );
          return reply(200, { thread: id, id: result.id });
        }
        if (Object.hasOwn(catalog, op) || ['publish', 'confirm', 'approve_preview', 'signal-issue-draft'].includes(op))
          return reply(200, await workspaceOperation(store, user, op, b, env, send));
        if (op === 'metrika') {
          admin(user);
          if(env.SOURCE_ARCHIVE_SHA256) throw Error('В этом пространстве используется архив организатора.');
          return reply(200, await syncMetrika(store, env, send));
        }
        if (op === 'status') {
          admin(user);
          return reply(200, {
            webSearch: !!(env.YANDEX_SEARCH_FOLDER_ID && env.YANDEX_SEARCH_API_KEY),
            metrika: !!env.METRIKA_TOKEN,
            metrikaSync: metrikaStatus(db, env),
            integrations: connectionInfo(db,user),
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
        if(env.SOURCE_ARCHIVE_SHA256 && method==='POST' && p==='/api/import') return reply(403,{error:'Используйте загрузку в разделе Источники.'});
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
    while (busy.size || researching.size) await new Promise((r) => setTimeout(r, 50));
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
