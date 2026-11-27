import { digest, setting, setSetting } from './evidence.mjs';
import { destination } from './notification-contacts.mjs';
import { integrationTransport, notificationChannels } from './data-profile.mjs';
import { aiOrigin, withAiNotice } from './tracker-clients.mjs';
import { initResultPages, recordResultPage } from './knowledge.mjs';
import { visibleRun } from './case-investigations.mjs';

export function initRedmine(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS redmine_drafts(reference TEXT PRIMARY KEY,draft TEXT UNIQUE,report TEXT);
    CREATE TABLE IF NOT EXISTS redmine_results(id TEXT PRIMARY KEY,case_id TEXT,body TEXT,created INTEGER);`);
  initResultPages(db);
}

async function bridge(env, send, path, body) {
  const base = new URL(env.SIGNAL_BRIDGE_URL);
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(base.hostname) || base.username || base.password || base.search || base.hash)
    throw Error('Укажите локальный адрес Signal Bridge');
  const opts = { redirect: 'error', signal: AbortSignal.timeout(30000) };
  if (body)
    Object.assign(opts, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const response = await integrationTransport(env, send)(new URL(path, base).href, opts);
  const value = await response.json();
  if (!response.ok)
    throw Object.assign(Error(value.error || 'Signal Bridge недоступен'), { status: response.status });
  return value;
}

export async function draftReport(env, send) {
  const { id, start, end, status, web, periods } = await bridge(env, send, '/reports/latest');
  return { id, start, end, status, web, periods };
}

// The shared bridge can only operate on issues created from a case visible to this actor.
export function bridgeTracker(db, user, env, send) {
  const bridgeUrl = env.SIGNAL_BRIDGE_URL.replace(/\/+$/, '');
  function visibleRows() {
    return db
      .prepare(
        `SELECT r.reference,d.external,d.body,d.case_id,json_extract(d.body,'$.investigationId') AS run FROM redmine_drafts r
      JOIN draft_actions d ON d.id=r.draft JOIN cases c ON c.id=d.case_id
      WHERE d.external IS NOT NULL AND COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?)
      AND json_extract(d.body,'$.target.bridge')=1
      AND COALESCE(json_extract(d.body,'$.target.url'),'') IN ('',?) ORDER BY d.rowid DESC`,
      )
      .all(user.id, bridgeUrl)
      .filter(row => !row.run || visibleRun(db, user, row.case_id, row.run));
  }
  const number = (key) =>
    String(key)
      .trim()
      .replace(/^(?:Redmine\s*)?[#№]\s*/i, '');
  function selected(key) {
    if (!/^\d+$/.test(number(key))) throw Error('Укажите номер задачи Redmine цифрами или возьмите точный ключ из issue_search');
    const row = visibleRows().find((r) => number(r.external) === number(key));
    if (!row) throw Error('Задача недоступна в этом рабочем пространстве');
    return row;
  }
  const path = row => '/tasks/' + encodeURIComponent(row.reference);
  function receipt(task, reference, report) {
    if (task.reference !== reference || task.report_id !== report || !Number.isInteger(task.redmine_id))
      throw Error('Ответ Redmine не совпал с черновиком');
    return { key: 'Redmine #' + task.redmine_id, url: task.url };
  }
  function search(query, _all = false, origin) {
    const q = query.trim().toLowerCase();
    return visibleRows()
      .map((r) => {
        const b = JSON.parse(r.body);
        return { key: r.external, url: b.receipt?.url, title: b.title, origin: b.changes?.origin || null };
      })
      .filter((r) => (!origin || r.origin === origin) && (r.key + ' ' + r.title).toLowerCase().includes(q))
      .slice(0, 25);
  }
  async function create(changes, marker, beforeWrite) {
    const id = marker.slice(3);
    const draft = db.prepare('SELECT body FROM draft_actions WHERE id=? AND user=?').get(id, user.id);
    if (!draft) throw Error('Черновик недоступен');
    const body = JSON.parse(draft.body);
    const reference = 'web-draft-' + id;
    const stored = db.prepare('SELECT report FROM redmine_drafts WHERE reference=?').get(reference);
    const report = stored?.report ?? body.report?.id ?? '';
    const { title, priorityId, assigneeId, trackerId } = changes;
    const description = changes.origin === aiOrigin ? withAiNotice(changes.description) : changes.description;
    beforeWrite?.(() => db.prepare('INSERT OR IGNORE INTO redmine_drafts VALUES(?,?,?)').run(reference, id, report));
    const task = await bridge(env, send, '/tasks', {
      reference,
      title,
      description,
      report_id: report,
      confirmed: true,
      fields: { priorityId, assigneeId, trackerId },
    });
    return receipt(task, reference, report);
  }
  return {
    async read(key) {
      const tracked = selected(key);
      const result = await bridge(env, send, path(tracked) + '/details');
      return { ...result, origin: JSON.parse(tracked.body).changes?.origin || null };
    },
    options: () => bridge(env, send, '/issue-options'),
    search,
    async searchProject(queries) {
      const params = new URLSearchParams(queries.map(query => ['query', query]));
      const { items } = await bridge(env, send, '/project-issues?' + params);
      const known = new Set(db.prepare(`SELECT external FROM draft_actions d
        JOIN redmine_drafts r ON r.draft=d.id WHERE external IS NOT NULL`).all().map(row => number(row.external)));
      return [
        ...items.filter(item => !known.has(number(item.key))).map(item => ({ ...item, canComment: false })),
        ...queries.flatMap(query => search(query)),
      ];
    },
    async save(key, changes, marker, beforeWrite) {
      if (!key) return create(changes, marker, beforeWrite);
      const endpoint = path(selected(key)) + '/changes';
      beforeWrite();
      return bridge(env, send, endpoint, { changes, marker, confirmed: true });
    },
    async recover(key, marker, beforeRetry) {
      if (key) {
        const issue = await bridge(env, send, path(selected(key)) + '/details');
        return issue.comments.some((c) => c.text.split(/\r?\n/).includes(marker)) ? issue : null;
      }
      // POST /tasks reconciles this immutable reference with Redmine after a lost response.
      const draft = db
        .prepare('SELECT body FROM draft_actions WHERE id=? AND user=?')
        .get(marker.slice(3), user.id);
      const stored = db.prepare('SELECT reference,report FROM redmine_drafts WHERE draft=?').get(marker.slice(3));
      if (!draft || !stored) return;
      try {
        beforeRetry?.();
      } catch (error) {
        const task = await bridge(env, send, path(stored)).catch(() => null);
        if (task?.redmine_id) return receipt(task, stored.reference, stored.report || '');
        throw error;
      }
      return create(JSON.parse(draft.body).changes, marker);
    },
  };
}

export function saveClosure(db, accounts, caseId, user, row, env, notify = true) {
  const id = row.reference + '/' + row.episode;
  const created = Date.parse(row.closed_on || row.observed);
  const inserted = db
    .prepare('INSERT OR IGNORE INTO redmine_results VALUES(?,?,?,?)')
    .run(id, caseId, JSON.stringify(row), created).changes;
  if (!inserted) return;
  recordResultPage(db, id, caseId, row);
  if (!notify) return;
  const text = 'Redmine #' + row.issue + ' · ' + row.status + '\n' + row.title;
  for (const channel of notificationChannels(env)) {
    const addr = destination(accounts, user, channel);
    db.prepare("INSERT OR IGNORE INTO deliveries(id,channel,state,body) VALUES(?,?,'queued',?)").run(
      id + '/' + channel,
      channel,
      JSON.stringify({ owner: user, addressHash: addr ? digest(addr) : undefined, caseId, issueUrl: row.url, text }),
    );
  }
}

export async function collectClosures(store, accounts, env, send) {
  const db = store.db;
  const bridgeUrl = env.SIGNAL_BRIDGE_URL.replace(/\/+$/, '');
  const cursorKey = 'redmine_closure_cursor/' + digest(bridgeUrl);
  const cursor = setting(db, cursorKey, 0);
  const rows = await bridge(env, send, '/closures?after=' + cursor);
  store.tx(() => {
    for (const row of rows) {
      const draft = db
        .prepare(
          `SELECT d.*,r.report,json_extract(c.body,'$.owner') AS caseOwner FROM redmine_drafts r
        JOIN draft_actions d ON d.id=r.draft JOIN cases c ON c.id=d.case_id
        WHERE r.reference=? AND json_extract(d.body,'$.target.bridge')=1
          AND COALESCE(json_extract(d.body,'$.target.url'),'') IN ('',?)`,
        )
        .get(row.reference, bridgeUrl);
      if (draft && (draft.report || '') === (row.report?.id || '')) {
        const body = JSON.parse(draft.body);
        saveClosure(db, accounts, draft.case_id, draft.user, {
          ...row,
          ...(draft.caseOwner || body.investigationId ? { personalOwner: draft.user } : {}),
          description: body.description,
          report: body.report?.periods ? body.report : row.report,
        }, env);
      }
      setSetting(db, cursorKey, Math.max(row.seq, setting(db, cursorKey, cursor)));
    }
  });
}
