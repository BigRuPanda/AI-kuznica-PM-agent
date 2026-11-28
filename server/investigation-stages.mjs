import { InvestigationValidationError } from './investigation-validation.mjs';

export const stageOrder = {
  lead: ['lead'],
  review: ['lead', 'reviewer'],
  roles: ['analyst', 'researcher', 'lead', 'reviewer'],
};

export function ensureStages(db, runId, mode) {
  const insert = db.prepare(`INSERT OR IGNORE INTO case_investigation_role_state(run_id, role, ordinal)
    VALUES(?,?,?)`);
  stageOrder[mode].forEach((role, ordinal) => insert.run(runId, role, ordinal));
}

// Called inside the investigation schema transaction. Existing successes and charges stay in their journal.
export function initStages(db) {
  if (db.prepare('PRAGMA table_info(case_investigations)').all().some(c => c.name === 'prepared')) return;
  db.exec(`ALTER TABLE case_investigations ADD COLUMN prepared INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE case_investigation_stages ADD COLUMN attempt INTEGER;
    ALTER TABLE case_investigation_stages ADD COLUMN failure TEXT;
    CREATE TABLE case_investigation_role_state (
      run_id TEXT NOT NULL REFERENCES case_investigations(id), role TEXT NOT NULL, ordinal INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued', attempt INTEGER NOT NULL DEFAULT 0, reason TEXT,
      next INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(run_id,role)
    )`);
  for (const row of db.prepare('SELECT * FROM case_investigations WHERE mode IS NOT NULL').all()) {
    ensureStages(db, row.id, row.mode);
    const history = db.prepare(`SELECT role, count(*) AS n, max(output IS NOT NULL) AS done
      FROM case_investigation_stages WHERE run_id=? GROUP BY role`).all(row.id);
    for (const stage of history) {
      db.prepare('UPDATE case_investigation_role_state SET status=?, attempt=? WHERE run_id=? AND role=?')
        .run(stage.done ? 'done' : 'queued', stage.n, row.id, stage.role);
    }
    if (['ready','superseded'].includes(row.status)) continue;
    const capture = row.capture && JSON.parse(row.capture);
    if (!capture?.measurable) {
      if (row.status === 'retry') db.prepare('UPDATE case_investigations SET next=0 WHERE id=?').run(row.id);
      continue;
    }
    const pending = db.prepare(`SELECT * FROM case_investigation_role_state WHERE run_id=? AND status<>'done'
      ORDER BY ordinal LIMIT 1`).get(row.id);
    if (pending && (row.status === 'retry' || row.wait_for === 'provider')) {
      db.prepare(`UPDATE case_investigation_role_state SET status='retry',attempt=?,next=?,reason=? WHERE run_id=? AND role=?`)
        .run(Math.max(1, row.attempts, pending.attempt), row.next, row.reason, row.id, pending.role);
      db.prepare("UPDATE case_investigations SET next=0,wait_for=NULL,status='retry' WHERE id=?").run(row.id);
    }
    // Re-enter preparation once to account for legacy model waits and optional external evidence.
    // A still-valid run lease continues to bar preparation until it expires.
  }
}

export function states(db, id) {
  return db.prepare('SELECT * FROM case_investigation_role_state WHERE run_id=? ORDER BY ordinal').all(id);
}

export function retryPending(stage, now) {
  return stage.status === 'retry' ||
    (stage.status === 'running' && stage.lease != null && stage.lease_until <= now);
}

export function retryReason(stage, now) {
  if (stage.status === 'running' && retryPending(stage, now)) return 'Истёк срок попытки.';
  return stage.reason?.replace(/ (?:Этап будет повторён|Проверка будет повторена)\.$/u, '');
}

export function eligible(stage, siblings, now, automaticRetries = false) {
  if (stage.status === 'done' || stage.next > now || stage.lease_until > now ||
      (!automaticRetries && retryPending(stage, now))) return false;
  return !['lead','reviewer'].includes(stage.role) ||
    siblings.every(s => s.ordinal >= stage.ordinal || s.status === 'done');
}

export function updateRunProgress(db, id) {
  const rows = states(db, id);
  const failure = rows.find(s => s.status === 'retry');
  const status = rows.some(s => s.status === 'running') ? 'running' : failure ? 'retry' : 'queued';
  db.prepare('UPDATE case_investigations SET status=?,reason=? WHERE id=?').run(status, failure?.reason ?? null, id);
}

export function failureReason(error) {
  if ([401,403,404].includes(error?.status)) return 'Провайдер отклонил подключение. Ожидаем доступа к модели.';
  if (error?.status === 429) return 'Провайдер ограничил частоту запросов.';
  if (error?.timedOut || error?.name === 'TimeoutError') return 'Модель не успела ответить вовремя.';
  if (error?.status >= 500) return 'На стороне провайдера произошла ошибка.';
  if (error?.retryable) return 'Не удалось связаться с провайдером.';
  if (error instanceof InvestigationValidationError) return 'Ответ модели не прошёл проверку. ' + error.message;
  if (error?.invalidModelResponse || error instanceof SyntaxError) return 'Ответ модели не прошёл проверку.';
  return 'Не удалось завершить проверку.';
}

export function publicStages(db,row,mode,user,automaticRetries,now) {
  const stored=states(db,row.id);
  const canAct=Boolean(user && (!row.owner || row.owner === user.id) &&
    !['superseded','ready'].includes(row.status) && !row.wait_for && row.lease_until<=now);
  const roles = ['ready','superseded'].includes(row.status) ? stored.filter(s=>s.status==='done').map(s=>s.role) : stageOrder[mode];
  return roles.map(role=>{
    const s=stored.find(item=>item.role===role);
    let status=s && retryPending(s,now) ? 'retry' : s?.status || 'queued';
    let reason=s && retryReason(s,now);
    if (status!=='done' && (row.wait_for || (!row.prepared && status!=='retry'))) {
      status='waiting'; reason=row.reason || 'Ожидаем подготовку расчёта.';
    } else if (status==='queued' && s && !eligible(s,stored,Infinity)) {
      status='waiting'; reason='Ожидаем результаты предыдущих ролей.';
    }
    return {role,status,attempt:s?.attempt || 0,canRetry:canAct && status==='retry' && s.lease_until<=now,
      ...(reason && {reason}), ...(automaticRetries && status==='retry' && s?.next && {retryAt:s.next})};
  });
}
