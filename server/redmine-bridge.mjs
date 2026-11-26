import { digest, setting, setSetting } from './evidence.mjs';
import { destination } from './notification-contacts.mjs';
import { excelSources, initResultPages, recordResultPage } from './knowledge.mjs';

export function initRedmine(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS redmine_drafts(reference TEXT PRIMARY KEY,draft TEXT UNIQUE,report TEXT);
    CREATE TABLE IF NOT EXISTS redmine_results(id TEXT PRIMARY KEY,case_id TEXT,body TEXT,created INTEGER);`);
  initResultPages(db);
}

async function bridge(env, send, path, body) {
  const base = new URL(env.SIGNAL_BRIDGE_URL);
  if (base.protocol !== 'http:' || !['localhost', '127.0.0.1'].includes(base.hostname))
    throw Error('Укажите локальный адрес Signal Bridge');
  const opts = { redirect: 'error', signal: AbortSignal.timeout(30000) };
  if (body)
    Object.assign(opts, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  const response = await send(new URL(path, base).href, opts);
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
  function visibleRows() {
    return db
      .prepare(
        `SELECT r.reference,d.external,d.body FROM redmine_drafts r
      JOIN draft_actions d ON d.id=r.draft JOIN cases c ON c.id=d.case_id
      WHERE d.external IS NOT NULL AND COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?) ORDER BY d.rowid DESC`,
      )
      .all(user.id);
  }
  const number = (key) =>
    String(key)
      .trim()
      .replace(/^(?:Redmine\s*)?#\s*/i, '');
  function path(key) {
    const row = visibleRows().find((r) => number(r.external) === number(key));
    if (!row) throw Error('Задача недоступна в этом рабочем пространстве');
    return '/tasks/' + encodeURIComponent(row.reference);
  }
  async function create(changes, marker, beforeWrite) {
    const id = marker.slice(3);
    const draft = db.prepare('SELECT body FROM draft_actions WHERE id=? AND user=?').get(id, user.id);
    if (!draft) throw Error('Черновик недоступен');
    const body = JSON.parse(draft.body);
    const reference = 'web-draft-' + id;
    const stored = db.prepare('SELECT report FROM redmine_drafts WHERE reference=?').get(reference);
    const report = stored?.report || body.report?.id;
    if (!report) throw Error('У черновика нет снимка Метрики. Подготовьте новый черновик.');
    db.prepare('INSERT OR IGNORE INTO redmine_drafts VALUES(?,?,?)').run(reference, id, report);
    const { title, description, priorityId, assigneeId, trackerId } = changes;
    beforeWrite();
    const task = await bridge(env, send, '/tasks', {
      reference,
      title,
      description,
      report_id: report,
      confirmed: true,
      fields: { priorityId, assigneeId, trackerId },
    });
    if (task.reference !== reference || task.report_id !== report || !Number.isInteger(task.redmine_id))
      throw Error('Ответ Redmine не совпал с черновиком');
    return { key: 'Redmine #' + task.redmine_id, url: task.url };
  }
  return {
    read: (key) => bridge(env, send, path(key) + '/details'),
    options: () => bridge(env, send, '/issue-options'),
    search(query) {
      const q = query.trim().toLowerCase();
      return visibleRows()
        .map((r) => {
          const b = JSON.parse(r.body);
          return { key: r.external, url: b.receipt?.url, title: b.title };
        })
        .filter((r) => (r.key + ' ' + r.title).toLowerCase().includes(q))
        .slice(0, 25);
    },
    async save(key, changes, marker, beforeWrite) {
      if (!key) return create(changes, marker, beforeWrite);
      const endpoint = path(key) + '/changes';
      beforeWrite();
      return bridge(env, send, endpoint, { changes, marker, confirmed: true });
    },
    async recover(key, marker) {
      if (key) {
        const issue = await bridge(env, send, path(key) + '/details');
        return issue.comments.some((c) => c.text.split(/\r?\n/).includes(marker)) ? issue : null;
      }
      // POST /tasks reconciles this immutable reference with Redmine after a lost response.
      const draft = db
        .prepare('SELECT body FROM draft_actions WHERE id=? AND user=?')
        .get(marker.slice(3), user.id);
      if (draft) return create(JSON.parse(draft.body).changes, marker, () => {});
    },
  };
}

export function saveClosure(db, accounts, caseId, user, row, notify = true) {
  const id = row.reference + '/' + row.episode;
  const created = Date.parse(row.closed_on || row.observed);
  const inserted = db
    .prepare('INSERT OR IGNORE INTO redmine_results VALUES(?,?,?,?)')
    .run(id, caseId, JSON.stringify(row), created).changes;
  if (!inserted) return;
  recordResultPage(db, id, caseId, row);
  if (!notify) return;
  const text = 'Redmine #' + row.issue + ' · ' + row.status + '\\n' + row.title;
  for (const channel of ['smtp', 'telegram']) {
    const addr = destination(accounts, user, channel);
    if (addr)
      db.prepare("INSERT OR IGNORE INTO deliveries(id,channel,state,body) VALUES(?,?,'queued',?)").run(
        id + '/' + channel,
        channel,
        JSON.stringify({ owner: user, addressHash: digest(addr), caseId, issueUrl: row.url, text }),
      );
  }
}

export async function collectClosures(store, accounts, env, send) {
  const db = store.db;
  const cursor = setting(db, 'redmine_closure_cursor', 0);
  const rows = await bridge(env, send, '/closures?after=' + cursor);
  store.tx(() => {
    for (const row of rows) {
      const draft = db
        .prepare(
          `SELECT d.*,r.report FROM redmine_drafts r JOIN draft_actions d ON d.id=r.draft
        WHERE r.reference=?`,
        )
        .get(row.reference);
      if (draft && draft.report === row.report.id) {
        saveClosure(db, accounts, draft.case_id, draft.user, {
          ...row,
          description: JSON.parse(draft.body).description,
        });
      }
      setSetting(db, 'redmine_closure_cursor', row.seq);
    }
  });
}

export function knowledge(db, user) {
  const records = db
    .prepare(
      `SELECT r.body,r.case_id,rp.page FROM redmine_results r JOIN cases c ON c.id=r.case_id LEFT JOIN redmine_result_pages rp ON rp.result=r.id
    WHERE COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?)
    AND COALESCE(json_extract(r.body,'$.personalOwner'),'') IN ('',?) ORDER BY r.created DESC`,
    )
    .all(user.id, user.id);
  const publications = db
    .prepare(
      `SELECT p.id,p.case_id,p.created,p.body,c.title FROM published p JOIN cases c ON c.id=p.case_id
    WHERE COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?) ORDER BY p.created DESC`,
    )
    .all(user.id);
  return {
    results: records.map((r) => ({ ...JSON.parse(r.body), caseId: r.case_id, pageKey: r.page })),
    sources: excelSources(db),
    pages: db
      .prepare(
        `SELECT p.key,p.title,p.version,p.case_id AS caseId FROM demo_pages p JOIN cases c ON c.id=p.case_id
      LEFT JOIN private_wiki_pages acl ON acl.page=p.key
      WHERE COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?) AND (acl.user IS NULL OR acl.user=?)
      ORDER BY p.rowid DESC`,
      )
      .all(user.id, user.id),
    publications: publications.map((p) => ({
      id: p.id,
      caseId: p.case_id,
      title: p.title,
      conclusion: JSON.parse(p.body).conclusion || '',
      created: p.created,
    })),
  };
}
