import { initSourcePolicy, approveSource, sourcePermission, importApproved, sourceHistory, protectedSources, protectedProducts } from './source-policy.mjs';
import { operations as catalog, workspaceOperation } from './workspace-operations.mjs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { root, databasePath, liveModelEnv } from './config.mjs';
import { openStore } from './store.mjs';
import { openAccounts, workspacePath } from './accounts.mjs';
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
  caseThreadId,
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
import { mail, python, probeMetrika, smtpConfigured, telegram } from './connectors.mjs';
import { bindTelegram, contactAction, initContacts, notificationAudience, telegramGroupAllowed, telegramPolling } from './notification-contacts.mjs';
import { configureSignalAudience } from './signal-history.mjs';
import { initMetrikaSync, metrikaStatus, syncMetrika } from './metrika-sync.mjs';
import { preview, revisePage } from './tracker-workflow.mjs';
import { configure, connectionInfo, personalConnection, finishOAuth } from './tracker-connections.mjs';
import { collectClosures } from './redmine-bridge.mjs';
import { syncWatches } from './redmine-watch.mjs';
import { remoteMcp } from './team-mcp.mjs';
import { retainMaterial, readMaterial, attachedMaterials, materialRef, materialPreview } from './materials.mjs';
import { access } from './chart-ranges.mjs';
import { resumeJob } from './workbench.mjs';
import { metricRuleStatus, saveMetricRule } from './metric-rules.mjs';
import { createInvestigationScheduler } from './investigation-scheduler.mjs';
import { readInvestigationLimit, saveInvestigationLimit, researchSettings, saveResearchSettings } from './investigation-settings.mjs';
import { notificationChannels } from './data-profile.mjs';
import { watchKind } from './watch-measurement.mjs';
import {
  createAlternative, publishInvestigation, readInvestigations,
  syncInvestigations, onInvestigationWork, retryInvestigationStage,
} from './case-investigations.mjs';
import { prepareInvestigationDraft } from './investigation-draft.mjs';

export function createTeamApp({
  base = databasePath(),
  env = liveModelEnv,
  send = fetch,
  sendMail = mail,
  background = true,
  investigationOptions,
} = {}) {
  const accounts = openAccounts(join(dirname(base), 'accounts.sqlite')),
    spaces = new Map(),
    legacy = new Map(),
    busy = new Set(),
    investigationSubscriptions = [],
    tracking = new Set(),
    chatting = new Set(),
    reconciledAt = new Map(),
    authAttempts = new Map();
  initContacts(accounts.db);
  let nextTelegram = 0;
  let nextClosures = 0;
  const urlBase = new URL(env.APP_BASE_URL || 'http://127.0.0.1:8090'),
    secure = urlBase.protocol === 'https:';
  const investigations = createInvestigationScheduler({spaces,env,send,options:investigationOptions,
    getLimit:() => readInvestigationLimit(spaces.get('team').db)});
  function space(id) {
    if (!spaces.has(id)) {
      const s = openStore(workspacePath(base, id),{seedDemo:!env.SOURCE_ARCHIVE_SHA256});
      initEvidence(s.db);
      if (id === 'team') configureSignalAudience(s.db, () => notificationAudience(env, accounts.db));
      initWorkbench(s.db, env);
      initSourcePolicy(s.db);
      initMetrikaSync(s.db);
      reconciledAt.set(id, Date.now());

      spaces.set(id, s);
      if (background) {
        investigationSubscriptions.push(onInvestigationWork(s.db,investigations.wake));
        investigations.wake();
      }
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
  function handleTelegram(update) {
    const msg = update?.message;
    if (!Number.isSafeInteger(update?.update_id) || typeof msg?.text !== 'string' ||
        !Number.isSafeInteger(msg.chat?.id) || !Number.isSafeInteger(msg.from?.id)) return;
    const store = space('team'), db = store.db;
    if (db.prepare('SELECT id FROM known_updates WHERE id=?').get(update.update_id)) return;
    const chat = String(msg.chat.id), sender = String(msg.from.id), group = msg.chat.type !== 'private';
    if (!group && chat !== sender) return;
    if (!group && msg.text.startsWith('/start ')) {
      bindTelegram(accounts.db, msg);
    } else {
      const binding = accounts.db.prepare("SELECT user FROM telegram WHERE chat=? AND kind='private'").get(sender);
      const user = binding && accounts.publicUser(binding.user);
      if (user?.space === 'team' && user.role !== 'judge' &&
          (!group || telegramGroupAllowed(env, chat)) &&
          (!group || msg.text.startsWith('/ask') || msg.reply_to_message?.from?.is_bot)) {
        const thread = group ? 'tg-group-' + chat : 'tg-' + user.id;
        db.prepare('INSERT OR IGNORE INTO conversations VALUES(?,?,?,?)').run(
          thread, user.id, group ? 'group' : 'private', 'Telegram · ' + (group ? 'Команда' : user.name),
        );
        enqueue(store, user, {
          question: msg.text.replace(/^\/ask(?:@\w+)?\s*/, '').trim() || 'Обзор',
          thread, requestId: 'tg' + update.update_id,
        }, { telegramReply: { chat, group } });
      }
    }
    db.prepare('INSERT OR IGNORE INTO known_updates VALUES(?)').run(update.update_id);
  }
  async function pollTelegram(store) {
    if (!telegramPolling(env) || Date.now() < nextTelegram) return;
    nextTelegram = Date.now() + 5000;
    try {
      const updates = await telegram('getUpdates', {
        offset: setting(store.db, 'telegram_offset', 0), timeout: 0, allowed_updates: ['message'],
      }, env, send);
      for (const update of updates) {
        if (!Number.isSafeInteger(update?.update_id)) continue;
        handleTelegram(update);
        setSetting(store.db, 'telegram_offset', update.update_id + 1);
      }
    } catch {
      nextTelegram = Date.now() + 60000;
    }
  }
  async function tick() {
    if (spaces.size === 0) return;
    investigations.wake();
    for (const [id, s] of spaces) {
      if (Date.now() - (reconciledAt.get(id) || 0) >= 60_000) {
        try {
          syncInvestigations(s.db);
          reconciledAt.set(id, Date.now());
        } catch {
          console.error('Не удалось сверить активные исследования');
        }
      }
      if (id === 'team' && !tracking.has(id)) {
        tracking.add(id);
        const operations = [syncWatches(s, accounts, env, send)];
        if (env.SIGNAL_BRIDGE_URL && Date.now() >= nextClosures) {
          nextClosures = Date.now() + 60_000;
          operations.push(collectClosures(s, accounts.db, env, send).then(
            () => setSetting(s.db, 'redmine_sync', { ok: true, at: Date.now() }),
            () => setSetting(s.db, 'redmine_sync', { ok: false, at: Date.now() }),
          ));
        }
        void Promise.allSettled(operations).finally(() => tracking.delete(id));
      }
      if (!chatting.has(id)) {
        chatting.add(id);
        void workJobs(s, accounts, env, send)
          .catch(() => console.error('Не удалось обработать очередь чата'))
          .finally(() => chatting.delete(id));
      }
      if (busy.has(id)) continue;
      busy.add(id);
      void (async () => {
        const minutes = Number(env.METRIKA_SYNC_MINUTES || 0),
          sync = setting(s.db, 'last_metrika_sync', { at: 0 });
        if (!env.SOURCE_ARCHIVE_SHA256 && id === 'team' && env.METRIKA_TOKEN && minutes >= 5 && Date.now() - sync.at >= minutes * 60000) {
          await syncMetrika(s, env, send).catch(() => {}); // The journal retains failures for each source.
        }
        for (const c of cases(s.db).filter((x) => x.state === 'Наблюдаем эффект' && x.body.watch)) {
          const plan = c.body.watch;
          if (c.body.watchReviewed || plan.reviewed) continue;
          const archive = watchKind(plan) === 'archive-observation';
          const report = effect(s.db, c);
          if (Number.isFinite(report?.actual)) {
            s.tx(() => {
              if (archive) c.body.watchReviewed = true;
              else plan.reviewed = true;
              c.state = 'Нужно решение';
              updateCase(s.db, c);
              if (id === 'team')
                for (const channel of notificationChannels(env))
                  s.db
                    .prepare("INSERT OR IGNORE INTO deliveries(id,channel,state,body) VALUES(?,?,'queued',?)")
                    .run(
                      digest(c.id + JSON.stringify({ ...plan, reviewed: true })) + channel,
                      channel,
                      JSON.stringify({
                        caseId: c.id,
                        ...notificationAudience(env, accounts.db, c.body.owner, { requireOwner: archive }),
                        text: report.state,
                      }),
                    );
            });
          }
        }
        if (id === 'team') {
          await pollTelegram(s);
          await deliver(s, env, send, sendMail, accounts.db);
        }
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
        handleTelegram(JSON.parse((await readBody(req, 100000)).toString()));
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
          const args = permission?.archive ? [name, '--references'] : [name];
          const docs = permission?.alreadyImported?[]:JSON.parse(await python('office_import.py', args, raw, env));
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
        if (op === 'investigation-retry-stage') return reply(200,retryInvestigationStage(db,user,b));
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
          configure(db, user, b, env);
          return reply(200, connectionInfo(db, user, env));
        }
        if (op === 'integration-access') return reply(200, await personalConnection(db, user, b, env, send));
        if (op === 'overview')
          return reply(200, {
            ...dashboard(db, user), archiveOnly:!!env.SOURCE_ARCHIVE_SHA256,
            ...(env.SOURCE_ARCHIVE_SHA256 && user.space === 'team' && {sources: protectedSources(db), products: protectedProducts(db)}),
            metrikaProbe: env.SOURCE_ARCHIVE_SHA256 && user.role === 'admin' ? setting(db, 'metrika_probe', null) : null,
            metrikaSync: user.space === 'team' ? metrikaStatus(db, env) : { reports: [] },
            notificationsEnabled: user.space === 'team' && env.NOTIFICATIONS_ENABLED === 'true',
            notificationChannels: user.space === 'team' ? notificationChannels(env) : [],
            integrations: connectionInfo(db, user, env),
            bridgeEnabled: user.role !== 'judge' && !!env.SIGNAL_BRIDGE_URL && !env.SOURCE_ARCHIVE_SHA256,
          });
        if (op === 'invite') {
          admin(user);
          return reply(200, { code: accounts.invite(user.space) });
        }
        if (op === 'mcp-key') return reply(200, { key: accounts.issueKey(user.id) });
        if (['contacts', 'email-request', 'email-confirm', 'contact-unlink', 'bind'].includes(op))
          return reply(200, await contactAction(
            op, b, user, accounts.db, env,
            (text, address) => sendMail(text, env, address),
            async () => (await telegram('getMe', {}, env, send)).username,
          ));
        if (op === 'research-settings' || op === 'save-research-settings') {
          const modes = op === 'research-settings' ? researchSettings(db,user) : saveResearchSettings(db,user,b);
          return reply(200,{...modes,maxConcurrentChecks:readInvestigationLimit(space('team').db)});
        }
        if (op === 'save-investigation-limit') {
          const maxConcurrentChecks = saveInvestigationLimit(space('team').db,user,b.maxConcurrentChecks);
          if (background) investigations.wake();
          return reply(200,{maxConcurrentChecks});
        }
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
            id = caseThreadId(user.id, c.id);
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
                }, env, send).id;
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
        if (op === 'metrika-probe') {
          admin(user);
          if (!env.SOURCE_ARCHIVE_SHA256) throw Error('Проверка Reports API доступна в архивном режиме.');
          let result;
          try {
            result = await probeMetrika(env, send);
          } catch (error) {
            setSetting(db, 'metrika_probe', { at: Date.now(), status: 'error', reason: error.message });
            throw error;
          }
          setSetting(db, 'metrika_probe', result);
          return reply(200, result);
        }
        if (op === 'status') {
          admin(user);
          return reply(200, {
            webSearch: !!(env.YANDEX_SEARCH_FOLDER_ID && env.YANDEX_SEARCH_API_KEY),
            metrika: !!env.METRIKA_TOKEN,
            metrikaSync: metrikaStatus(db, env),
            integrations: connectionInfo(db, user, env),
            redmineSync: setting(db, 'redmine_sync', null),
            redmineWatchErrors: db.prepare('SELECT count(*) AS n FROM redmine_watches WHERE error IS NOT NULL').get().n,
            telegram: !!env.TELEGRAM_BOT_TOKEN,
            smtp: smtpConfigured(env),
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
        req.pmActorId = user.id;
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
    investigationSubscriptions.forEach(unsubscribe => unsubscribe());
    await investigations.close();
    while (busy.size || chatting.size || tracking.size) await new Promise((r) => setTimeout(r, 50));
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
