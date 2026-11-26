import { digest, setting, setSetting } from './evidence.mjs';
import { destination } from './notification-contacts.mjs';

export function trackerMode(user, env) {
  if (user.role === 'judge') return 'local';
  if (env.SIGNAL_BRIDGE_URL) return 'redmine';
  return env.JIRA_BASE_URL ? 'jira' : 'local';
}

export function initRedmine(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS redmine_drafts(reference TEXT PRIMARY KEY,draft TEXT UNIQUE,report TEXT);
    CREATE TABLE IF NOT EXISTS redmine_results(id TEXT PRIMARY KEY,case_id TEXT,body TEXT,created INTEGER);`);
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
  if (!response.ok) throw Error(value.error || 'Signal Bridge недоступен');
  return value;
}

export async function confirmRedmine(db, draft, body, env, send) {
  if (body.key) throw Error('В Redmine доступно создание новой задачи. Подготовьте отдельный черновик.');
  if (!body.description.trim()) throw Error('Укажите проверку и критерий успеха');
  const reference = 'web-draft-' + draft.id;
  let link = db.prepare('SELECT report FROM redmine_drafts WHERE reference=?').get(reference);
  if (!link) {
    const report = await bridge(env, send, '/reports/latest');
    db.prepare('INSERT OR IGNORE INTO redmine_drafts VALUES(?,?,?)').run(reference, draft.id, report.id);
    link = db.prepare('SELECT report FROM redmine_drafts WHERE reference=?').get(reference);
  }
  const task = await bridge(env, send, '/tasks', {
    reference,
    title: body.title,
    description: body.description,
    report_id: link.report,
    confirmed: true,
  });
  if (task.reference !== reference || task.report_id !== link.report || !Number.isInteger(task.redmine_id))
    throw Error('Ответ Redmine не совпал с черновиком');
  const key = 'Redmine #' + task.redmine_id;
  db.prepare("UPDATE draft_actions SET state='done',external=? WHERE id=?").run(key, draft.id);
  return { key, url: task.url };
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
        const id = row.reference + '/' + row.episode;
        const created = Date.parse(row.closed_on || row.observed);
        const inserted = db
          .prepare('INSERT OR IGNORE INTO redmine_results VALUES(?,?,?,?)')
          .run(
            id,
            draft.case_id,
            JSON.stringify({ ...row, description: JSON.parse(draft.body).description }),
            created,
          ).changes;
        if (inserted) {
          const text = 'Redmine #' + row.issue + ' · ' + row.status + '\n' + row.title;
          for (const channel of ['smtp', 'telegram']) {
            const addr = destination(accounts, draft.user, channel);
            if (addr)
              db.prepare(
                "INSERT OR IGNORE INTO deliveries(id,channel,state,body) VALUES(?,?,'queued',?)",
              ).run(
                id + '/' + channel,
                channel,
                JSON.stringify({ owner: draft.user, addressHash: digest(addr), caseId: draft.case_id, issueUrl: row.url, text }),
              );
          }
        }
      }
      setSetting(db, 'redmine_closure_cursor', row.seq);
    }
  });
}

export function knowledge(db, user) {
  const records = db
    .prepare(
      `SELECT r.body,r.case_id FROM redmine_results r JOIN cases c ON c.id=r.case_id
    WHERE COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?) ORDER BY r.created DESC`,
    )
    .all(user.id);
  const publications = db
    .prepare(
      `SELECT p.id,p.case_id,p.created,p.body,c.title FROM published p JOIN cases c ON c.id=p.case_id
    WHERE COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?) ORDER BY p.created DESC`,
    )
    .all(user.id);
  return {
    results: records.map((r) => ({ ...JSON.parse(r.body), caseId: r.case_id })),
    publications: publications.map((p) => ({
      id: p.id,
      caseId: p.case_id,
      title: p.title,
      conclusion: JSON.parse(p.body).conclusion || '',
      created: p.created,
    })),
  };
}
