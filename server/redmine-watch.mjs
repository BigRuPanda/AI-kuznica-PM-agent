import { digest } from './evidence.mjs';
import { remoteClient } from './tracker-connections.mjs';
import { saveClosure } from './redmine-bridge.mjs';

export function initWatches(db) {
  const installed = db
    .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='redmine_watches'")
    .get();
  if (installed) return;
  db.exec('SAVEPOINT install_redmine_watches');
  try {
    db.exec(`CREATE TABLE IF NOT EXISTS redmine_watches(id TEXT PRIMARY KEY,case_id TEXT,user TEXT,
    target TEXT,issue TEXT,description TEXT,report TEXT,closed INTEGER DEFAULT 0,episode INTEGER DEFAULT 0,
    next INTEGER DEFAULT 0,error TEXT);
    CREATE INDEX IF NOT EXISTS redmine_due ON redmine_watches(next);`);
    const old = db
      .prepare(
        `SELECT * FROM draft_actions WHERE state='done' AND json_extract(body,'$.kind')='issue'
      AND json_extract(body,'$.receipt.key') IS NOT NULL ORDER BY rowid`,
      )
      .all();
    for (const row of old) watchIssue(db, row, JSON.parse(row.body), true);
  } catch (error) {
    db.exec('ROLLBACK TO install_redmine_watches');
    throw error;
  } finally {
    db.exec('RELEASE install_redmine_watches');
  }
}

export function watchIssue(db, row, body, baseline = false) {
  const t = body.target;
  if (body.kind !== 'issue' || body.key || !body.receipt?.key || !t || t.local || t.bridge) return;
  const id = digest(JSON.stringify([row.case_id, t.url, t.scope, body.receipt.key]));
  db.prepare(
    `INSERT OR IGNORE INTO redmine_watches(id,case_id,user,target,issue,description,report,closed)
    VALUES(?,?,?,?,?,?,?,?)`,
  ).run(
    id,
    row.case_id,
    row.user,
    JSON.stringify(t),
    body.receipt.key,
    body.description || body.title,
    JSON.stringify(body.report || null),
    baseline ? -1 : 0,
  );
}

export async function syncWatches(store, accounts, env, send) {
  const db = store.db;
  const due = db
    .prepare('SELECT * FROM redmine_watches WHERE next<=? ORDER BY next,id LIMIT 5')
    .all(Date.now());
  for (const w of due) {
    if (
      !db
        .prepare('UPDATE redmine_watches SET next=? WHERE id=? AND next=?')
        .run(Date.now() + 60000, w.id, w.next).changes
    )
      continue;
    try {
      const user = accounts.publicUser(w.user);
      if (!user || user.role === 'judge') throw Error('Личный доступ недоступен');
      const api = await remoteClient(db, user, JSON.parse(w.target), env, send);
      const issue = await api.read(w.issue);
      const closed = await api.isClosed(issue);
      store.tx(() => {
        const state = db.prepare('SELECT closed,episode FROM redmine_watches WHERE id=?').get(w.id);
        let episode = state.episode;
        if (closed && state.closed !== 1) {
          episode++;
          saveClosure(
            db,
            accounts.db,
            w.case_id,
            w.user,
            {
              reference: 'redmine-' + w.id,
              personalOwner: w.user,
              episode,
              issue: issue.key,
              title: issue.title,
              status: issue.status,
              url: issue.url,
              closed_on: issue.closedOn,
              observed: new Date().toISOString(),
              closing_note: issue.closingNote,
              description: w.description,
              report: JSON.parse(w.report),
            },
            env,
            state.closed !== -1,
          );
        }
        db.prepare('UPDATE redmine_watches SET closed=?,episode=?,error=NULL WHERE id=?').run(
          Number(closed),
          episode,
          w.id,
        );
      });
    } catch (e) {
      db.prepare('UPDATE redmine_watches SET error=? WHERE id=?').run(e.message, w.id);
    }
  }
}
