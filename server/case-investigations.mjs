import { randomUUID } from 'node:crypto';
import { apiConfigured } from './agent.mjs';
import { grant } from './chart-ranges.mjs';
import { localData } from './data-profile.mjs';
import { getCase } from './evidence.mjs';
import { captureInvestigation, runInvestigationStage } from './investigation-engine.mjs';
import { effectiveResearchMode } from './investigation-settings.mjs';

const stages = {
  lead: ['lead'],
  review: ['lead', 'reviewer'],
  roles: ['analyst', 'researcher', 'lead', 'reviewer'],
};
const leaseDuration = 6 * 60_000;
const providerWait = 5 * 60_000;
const revisionOf = "COALESCE(json_extract(c.body,'$.signal.revision'), 0)";
const signalActive = "COALESCE(json_extract(c.body,'$.signal.status'), '') <> 'withdrawn'";
const caseActive = `c.state <> 'Завершено' AND ${signalActive}`;
const parse = (value) => value == null ? null : JSON.parse(value);

function transaction(db, fn) {
  db.exec('SAVEPOINT investigation');
  try {
    const result = fn();
    db.exec('RELEASE investigation');
    return result;
  } catch (error) {
    db.exec('ROLLBACK TO investigation; RELEASE investigation');
    throw error;
  }
}

export function initInvestigations(db) {
  transaction(db, () => {
    db.exec(`CREATE TABLE IF NOT EXISTS case_investigations (
      id TEXT PRIMARY KEY, case_id TEXT NOT NULL, revision INTEGER NOT NULL, owner TEXT,
      parent_id TEXT, question TEXT, request_id TEXT, mode TEXT, status TEXT NOT NULL, reason TEXT,
      published INTEGER NOT NULL DEFAULT 0, published_by TEXT, capture TEXT, result TEXT, created INTEGER NOT NULL,
      wait_for TEXT, source_generation INTEGER, next INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0
    );
    CREATE UNIQUE INDEX IF NOT EXISTS case_investigation_revision ON case_investigations(case_id, revision) WHERE parent_id IS NULL;
    CREATE UNIQUE INDEX IF NOT EXISTS case_investigation_request ON case_investigations(case_id, owner, request_id) WHERE request_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS case_investigation_case ON case_investigations(case_id, revision);
    CREATE TABLE IF NOT EXISTS case_investigation_stages (
      id INTEGER PRIMARY KEY, run_id TEXT NOT NULL REFERENCES case_investigations(id), ordinal INTEGER NOT NULL,
      role TEXT NOT NULL, output TEXT, usage TEXT, elapsed INTEGER NOT NULL, completed INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS case_investigation_stage_result ON case_investigation_stages(run_id, ordinal) WHERE output IS NOT NULL;
    CREATE TABLE IF NOT EXISTS case_investigation_sources (id INTEGER PRIMARY KEY CHECK(id=1), generation INTEGER NOT NULL);
    INSERT OR IGNORE INTO case_investigation_sources VALUES (1, 0);
    CREATE TABLE IF NOT EXISTS snapshot_access (id TEXT NOT NULL, scope TEXT NOT NULL, ref TEXT NOT NULL, PRIMARY KEY(id,scope,ref));
    CREATE TABLE IF NOT EXISTS costs (id INTEGER PRIMARY KEY, job TEXT, model TEXT, elapsed INTEGER, input INTEGER, output INTEGER);`);
    if (!db.prepare('PRAGMA table_info(case_investigations)').all().some(({ name }) => name === 'published_by'))
      db.exec('ALTER TABLE case_investigations ADD COLUMN published_by TEXT');
  });
  for (const table of ['documents', 'facts', 'feedback', 'research_file_versions']) {
    for (const action of ['INSERT', 'UPDATE', 'DELETE']) {
      db.exec(`CREATE TRIGGER IF NOT EXISTS investigate_${table}_${action} AFTER ${action} ON ${table}
        BEGIN UPDATE case_investigation_sources SET generation=generation+1 WHERE id=1; END;`);
    }
  }
  syncInvestigations(db);
}

export function syncInvestigations(db, caseId) {
  const args = caseId === undefined ? [] : [caseId];
  const caseScope = args.length ? ' AND c.id=?' : '';
  const runScope = args.length ? ' AND r.case_id=?' : '';
  transaction(db, () => {
    db.prepare(`INSERT OR IGNORE INTO case_investigations(id, case_id, revision, owner, status, created)
      SELECT lower(hex(randomblob(16))), c.id, ${revisionOf},
        COALESCE((SELECT owner FROM case_investigations WHERE case_id=c.id AND parent_id IS NULL
          ORDER BY revision ASC LIMIT 1), NULLIF(json_extract(c.body,'$.owner'), '')), 'queued', ?
      FROM cases c WHERE ${caseActive}${caseScope} AND NOT EXISTS (
        SELECT 1 FROM case_investigations WHERE case_id=c.id AND revision=${revisionOf} AND parent_id IS NULL
      )`).run(Date.now(), ...args);
    db.prepare(`UPDATE case_investigations AS r
      SET status='superseded', lease=NULL, lease_until=0,
        reason=CASE WHEN EXISTS (SELECT 1 FROM cases c WHERE c.id=r.case_id AND NOT (${signalActive}))
          THEN 'Сигнал отозван.' ELSE 'Появилась другая версия сигнала.' END
      WHERE status<>'superseded'${runScope} AND NOT EXISTS (
        SELECT 1 FROM cases c WHERE c.id=r.case_id AND ${signalActive} AND r.revision=${revisionOf}
      )`).run(...args);
    db.prepare(`UPDATE case_investigations AS r SET status='queued', lease=NULL, lease_until=0
      WHERE lease IS NOT NULL${runScope} AND EXISTS (
        SELECT 1 FROM cases WHERE id=r.case_id AND state='Завершено'
      )`).run(...args);
  });
}

function active(c) {
  return c.state !== 'Завершено' && c.body.signal?.status !== 'withdrawn';
}

function canViewCase(c, user, sharedOnly) {
  return !c.body.owner || (!sharedOnly && c.body.owner === user.id);
}

function accessibleCase(db, user, caseId, sharedOnly = false) {
  if (typeof caseId !== 'string' || !caseId) throw Error('Разбор не найден.');
  syncInvestigations(db, caseId);
  const c = getCase(db, caseId);
  if (!canViewCase(c, user, sharedOnly)) throw Error('Разбор недоступен.');
  return c;
}

function canViewRun(row, user, sharedOnly) {
  return !row.owner || row.published === 1 || (!sharedOnly && row.owner === user.id);
}

function completed(db, id) {
  return db.prepare(`SELECT output FROM case_investigation_stages
    WHERE run_id=? AND output IS NOT NULL ORDER BY ordinal`).all(id).map(({ output }) => parse(output));
}

function publicRun(db, row, prior = completed(db, row.id)) {
  const capture = parse(row.capture);
  const calculation = capture?.context?.calculation;
  const baseline = calculation?.baseline;
  const control = calculation?.metric === 'orders_index' ? calculation.findings?.[1]?.product : undefined;
  return {
    id: row.id, caseId: row.case_id, revision: row.revision, owner: row.owner,
    mode: row.mode || effectiveResearchMode(db, row.owner), status: row.status, created: row.created,
    ...(row.reason && { reason: row.reason }),
    ...(row.question && { question: row.question }),
    ...(row.parent_id && { parentId: row.parent_id }),
    published: row.published === 1,
    ...(row.published && row.published_by && { publishedBy: row.published_by }),
    ...(row.result && { result: parse(row.result) }),
    checks: [...(capture?.checks || []), ...prior.map((output) => output.check)],
    ...(capture?.calcId && { calcId: capture.calcId }),
    ...(capture?.period && { period: capture.period }),
    ...(capture?.unit && { unit: capture.unit }),
    ...(capture?.summary && { summary: capture.summary }),
    ...(baseline && { measurementContext: { baselineFrom: baseline.from, baselineThrough: baseline.through, control } }),
  };
}

function getRun(db, caseId, id) {
  return typeof id === 'string'
    ? db.prepare('SELECT * FROM case_investigations WHERE case_id=? AND id=?').get(caseId, id)
    : undefined;
}

export function visibleRun(db, user, caseId, id, sharedOnly = false) {
  if (typeof caseId !== 'string') return false;
  const c = db.prepare('SELECT body FROM cases WHERE id=?').get(caseId);
  if (!c || !canViewCase({ body: parse(c.body) }, user, sharedOnly)) return false;
  const row = getRun(db, caseId, id);
  return Boolean(row && canViewRun(row, user, sharedOnly));
}

export function readInvestigations(db, user, caseId, sharedOnly = false) {
  return transaction(db, () => {
    const c = accessibleCase(db, user, caseId, sharedOnly);
    const runs = db.prepare(`SELECT * FROM case_investigations WHERE case_id=? ORDER BY revision DESC, rowid DESC`)
      .all(caseId).filter((row) => canViewRun(row, user, sharedOnly));
    const available = active(c);
    const live = available ? runs.filter((row) => row.status !== 'superseded') : [];
    const featured = live.find((row) => row.parent_id === null) || live.find((row) => row.published) || live[0];
    const history = available ? runs.filter((row) => row.status === 'superseded') : runs;
    return {
      current: featured ? publicRun(db, featured) : null,
      alternatives: live.filter((row) => row !== featured).map((row) => publicRun(db, row)),
      history: history.map((row) => publicRun(db, row.status === 'superseded' ? row : {
        ...row, status: 'superseded', reason: 'Разбор завершён.',
      })),
    };
  });
}

export function createAlternative(db, user, { caseId, parentId, question, requestId }) {
  question = typeof question === 'string' ? question.trim() : '';
  if (!question || question.length > 2400) throw Error('Введите вопрос до 2400 символов.');
  if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 200)
    throw Error('Укажите идентификатор поручения.');
  return transaction(db, () => {
    const c = accessibleCase(db, user, caseId);
    const prior = db.prepare('SELECT * FROM case_investigations WHERE case_id=? AND owner=? AND request_id=?')
      .get(caseId, user.id, requestId);
    if (prior) {
      if (prior.question !== question || prior.parent_id !== parentId)
        throw Error('Идентификатор уже использован для другого поручения.');
      return publicRun(db, prior);
    }
    const parent = getRun(db, caseId, parentId);
    if (!parent || !canViewRun(parent, user, false) || parent.status === 'superseded' || !active(c))
      throw Error('Откройте текущую версию разбора.');
    const id = randomUUID();
    db.prepare(`INSERT INTO case_investigations(id,case_id,revision,owner,parent_id,question,request_id,status,created)
      VALUES(?,?,?,?,?,?,?,'queued',?)`).run(id, caseId, parent.revision, user.id, parent.id, question, requestId, Date.now());
    return publicRun(db, getRun(db, caseId, id));
  });
}

export function publishInvestigation(db, user, { caseId, id }) {
  return transaction(db, () => {
    const c = accessibleCase(db, user, caseId);
    const row = getRun(db, caseId, id);
    if (!row || row.owner !== user.id) throw Error('Опубликовать исследование может его автор.');
    if (row.published) return publicRun(db, row);
    if (c.body.owner) throw Error('Сначала опубликуйте сам разбор.');
    if (!active(c) || row.status !== 'ready' || !row.result) throw Error('Можно опубликовать готовое актуальное исследование.');
    const publishedBy = typeof user.name === 'string' ? user.name.trim() || null : null;
    db.prepare('UPDATE case_investigations SET published=1, published_by=? WHERE id=?').run(publishedBy, id);
    grant(db, parse(row.capture)?.calcId, 'case', caseId);
    return publicRun(db, { ...row, published: 1, published_by: publishedBy });
  });
}

export function requireActionableRun(db, user, caseId, id) {
  return transaction(db, () => {
    const c = accessibleCase(db, user, caseId);
    const row = getRun(db, caseId, id);
    if (!active(c) || !row || !canViewRun(row, user, false) || row.status !== 'ready' || !row.result)
      throw Error('Откройте готовое исследование для текущей версии разбора.');
    return publicRun(db, row);
  });
}

function modelWait(env) {
  if (localData(env)) return 'Локальный режим отключает передачу данных модели.';
  if (!apiConfigured(env)) return 'Ожидаем подключения модели.';
  if (env.LLM_DATA_MODE !== 'analysis') return 'Ожидаем разрешения аналитического режима модели.';
  return null;
}

function nextRun(db, now, modelReason, generation) {
  return db.prepare(`SELECT r.* FROM case_investigations r JOIN cases c ON c.id=r.case_id
    WHERE ${caseActive} AND r.revision=${revisionOf} AND (r.next<=? OR (r.wait_for='provider' AND ? IS NOT NULL))
      AND r.lease_until<=?
      AND (r.status IN ('queued','running','retry') OR (r.status='waiting' AND (
        (r.wait_for='data' AND r.source_generation<>?) OR (r.wait_for='model' AND r.reason IS NOT ?) OR
        r.wait_for='provider' OR (r.wait_for='parent' AND EXISTS (
          SELECT 1 FROM case_investigations p WHERE p.id=r.parent_id AND json_extract(p.capture,'$.measurable')=1
        ))
      )))
    ORDER BY r.created, r.rowid LIMIT 1`).get(now, modelReason, now, generation, modelReason);
}

function setWaiting(db, id, waitFor, reason, next = 0) {
  db.prepare(`UPDATE case_investigations SET status='waiting', wait_for=?, reason=?, lease=NULL, lease_until=0, next=?
    WHERE id=?`).run(waitFor, reason, next, id);
}

function setRetry(db, row, now, reason) {
  const next = now + Math.min(300_000, 15_000 * 2 ** Math.min(row.attempts, 5));
  db.prepare(`UPDATE case_investigations SET status='retry', reason=?, wait_for=NULL, next=?, attempts=attempts+1,
    lease=NULL, lease_until=0 WHERE id=?`).run(reason, next, row.id);
}

function saveStage(db, row, stage, ordinal, result, usage, elapsed, env, now) {
  if (!result && !usage) return;
  db.prepare(`INSERT INTO case_investigation_stages(run_id,ordinal,role,output,usage,elapsed,completed)
    VALUES(?,?,?,?,?,?,?)`).run(row.id, ordinal, stage, result && JSON.stringify(result), usage && JSON.stringify(usage), elapsed, now);
  if (usage) {
    db.prepare('INSERT INTO costs(job,model,elapsed,input,output) VALUES(?,?,?,?,?)')
      .run(row.id, env.LLM_MODEL || env.LLM_BACKEND || 'api', elapsed, usage.input ?? null, usage.output ?? null);
  }
}

export async function workInvestigation(store, env = process.env, send = fetch, options = {}) {
  const { db } = store;
  const { now = Date.now, leaseMs = leaseDuration, capture: captureInputs = captureInvestigation,
    execute = runInvestigationStage, reconcile = true } = options;
  const modelReason = modelWait(env);
  const job = store.tx(() => {
    if (reconcile) syncInvestigations(db);
    const start = now();
    const { generation } = db.prepare('SELECT generation FROM case_investigation_sources WHERE id=1').get();
    const row = nextRun(db, start, modelReason, generation);
    if (!row) return null;
    const mode = row.mode || effectiveResearchMode(db, row.owner);
    const c = getCase(db, row.case_id);
    const question = row.question || c.body.plan?.question || c.body.plan?.hypothesis || c.title;
    db.prepare('UPDATE case_investigations SET mode=?, question=? WHERE id=?').run(mode, question, row.id);
    const saved = () => publicRun(db, getRun(db, row.case_id, row.id));
    const prior = completed(db, row.id);
    const run = {
      ...publicRun(db, { ...row, mode, question }, prior), caseState: c.state, signal: c.body.signal,
      origin: c.body.origin, measurement: c.body.watch?.measurement || c.body.plan?.measurement,
      period: {
        from: c.body.plan?.from, through: c.body.plan?.through, control: c.body.plan?.control,
        ...(c.body.period || c.body.origin?.requested),
      },
    };
    let capture = parse(row.capture);
    if (!capture?.measurable) {
      const parent = getRun(db, row.case_id, row.parent_id);
      const parentCapture = parse(parent?.capture);
      if (row.parent_id && !parentCapture?.measurable) {
        setWaiting(db, row.id, 'parent', 'Ожидаем расчёт родительской версии.');
        return { saved: saved() };
      }
      try {
        capture = transaction(db, () => {
          const value = captureInputs(db, { ...run, parentCapture });
          db.prepare('UPDATE case_investigations SET capture=?, source_generation=? WHERE id=?')
            .run(JSON.stringify(value), generation, row.id);
          grant(db, value.calcId, row.owner ? 'user' : 'case', row.owner || row.case_id);
          return value;
        });
      } catch {
        setRetry(db, row, now(), 'Не удалось подготовить расчёт. Проверка будет повторена.');
        return { saved: saved() };
      }
    }
    if (!capture.measurable) {
      setWaiting(db, row.id, 'data', capture.reason || 'Ожидаем данные для расчёта.');
      return { saved: saved() };
    }
    if (modelReason) {
      setWaiting(db, row.id, 'model', modelReason);
      return { saved: saved() };
    }
    const ordinal = prior.length;
    const stage = stages[mode][ordinal];
    const lease = randomUUID();
    db.prepare(`UPDATE case_investigations SET status='running', wait_for=NULL, reason=NULL, lease=?, lease_until=?
      WHERE id=?`).run(lease, now() + leaseMs, row.id);
    return { row, run, capture, prior, mode, stage, ordinal, lease, start };
  });
  if (!job || job.saved) return job?.saved || null;

  const { row, run, capture, prior, mode, stage, ordinal, lease, start } = job;
  const final = ordinal === stages[mode].length - 1;
  let output, usage, providerStatus;
  try {
    const candidate = await execute({ env, send, stage, run, capture, prior });
    usage = candidate?.usage;
    if (candidate?.check && (!final || candidate.result)) output = candidate;
  } catch (error) {
    usage = error?.usage;
    providerStatus = error?.status;
  }
  return store.tx(() => {
    syncInvestigations(db, row.case_id);
    const finished = now();
    const current = getRun(db, row.case_id, row.id);
    if (!current) return null;
    const ownsLease = current.lease === lease && current.lease_until > finished;
    saveStage(db, row, stage, ordinal, ownsLease && output ? output : null, usage || null,
      Math.max(0, finished - start), env, finished);
    if (!ownsLease) return null;
    if (output) {
      db.prepare(`UPDATE case_investigations SET status=?, result=?, attempts=0, next=0, lease=NULL, lease_until=0
        WHERE id=?`).run(final ? 'ready' : 'running', final ? JSON.stringify(output.result) : null, row.id);
    } else if ([401, 403, 404].includes(providerStatus)) {
      setWaiting(db, row.id, 'provider', 'Провайдер отклонил подключение. Ожидаем доступа к модели.', finished + providerWait);
    } else {
      setRetry(db, current, finished, 'Не удалось завершить проверку. Этап будет повторён.');
    }
    return publicRun(db, getRun(db, row.case_id, row.id));
  });
}
