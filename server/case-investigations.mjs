import {readPublicPage} from './public-page.mjs';
import {webQuestion,yandexSearch} from './web-search.mjs';
import {noWeb} from './web-search.mjs';
import { randomUUID } from 'node:crypto';
import { apiConfigured } from './agent.mjs';
import { grant } from './chart-ranges.mjs';
import { localData } from './data-profile.mjs';
import { getCase, digest } from './evidence.mjs';
import { captureInvestigation, runInvestigationStage, thresholdObservation } from './investigation-engine.mjs';
import { effectiveResearchMode } from './investigation-settings.mjs';

import { stageOrder, ensureStages, initStages, states, eligible, updateRunProgress, publicStages, failureReason } from './investigation-stages.mjs';
const leaseDuration = 6 * 60_000;
const providerWait = 5 * 60_000;
const revisionOf = "COALESCE(json_extract(c.body,'$.signal.revision'), 0)";
const signalActive = "COALESCE(json_extract(c.body,'$.signal.status'), '') <> 'withdrawn'";
const caseActive = `c.state <> 'Завершено' AND ${signalActive}`;
const parse = (value) => value == null ? null : JSON.parse(value);

const wakeByDatabase = new WeakMap();
export function onInvestigationWork(db, wake) {
  wakeByDatabase.set(db, wake);
  return () => wakeByDatabase.delete(db);
}

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
    initStages(db);
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
    db.prepare(`UPDATE case_investigation_role_state SET status='queued',lease=NULL,lease_until=0
      WHERE lease IS NOT NULL AND run_id IN (SELECT r.id FROM case_investigations r JOIN cases c ON c.id=r.case_id
        WHERE (r.status='superseded' OR c.state='Завершено')${runScope})`).run(...args);
  });
  wakeByDatabase.get(db)?.();
}

function active(c) {
  return c.state !== 'Завершено' && c.body.signal?.status !== 'withdrawn';
}

function canViewCase(c, user, sharedOnly) {
  return !c.body.owner || (!sharedOnly && c.body.owner === user.id);
}

function accessibleCase(db, user, caseId, sharedOnly = false) {
  if (typeof caseId !== 'string' || !caseId) throw Error('Разбор не найден.');
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

function publicRun(db, row, prior = completed(db, row.id), user, signal) {
  const capture = parse(row.capture);
  const calculation = capture?.context?.calculation;
  const baseline = calculation?.baseline;
  const control = calculation?.metric === 'orders_index' ? calculation.findings?.[1]?.product : undefined;
  const mode = row.mode || effectiveResearchMode(db, row.owner);
  const observation = row.status === 'waiting' && row.wait_for === 'data' && !row.parent_id && capture?.calcId
    ? thresholdObservation(calculation,signal) : undefined;
  return {
    id: row.id, caseId: row.case_id, revision: row.revision, owner: row.owner,
    mode, status: row.status, created: row.created,
    ...(row.reason && { reason: row.reason }),
    ...(row.question && { question: row.question }),
    ...(row.parent_id && { parentId: row.parent_id }),
    published: row.published === 1,
    ...(row.published && row.published_by && { publishedBy: row.published_by }),
    ...(row.result && { result: parse(row.result) }),
    stages: publicStages(db,row,mode,user),
    checks: [...(capture?.checks || []), ...prior.map((output) => output.check)],
    ...(capture?.calcId && { calcId: capture.calcId }),
    ...(capture?.period && { period: capture.period }),
    ...(capture?.unit && { unit: capture.unit }),
    ...(capture?.summary && { summary: capture.summary }),
    ...(observation && { thresholdObservation:observation }),
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
    const isCurrent = row => row.status !== 'superseded' && row.revision === (c.body.signal?.revision ?? 0);
    const live = available ? runs.filter(isCurrent) : [];
    const featured = live.find((row) => row.parent_id === null) || live.find((row) => row.published) || live[0];
    const history = available ? runs.filter(row => !isCurrent(row)) : runs;
    return {
      current: featured ? publicRun(db, featured, undefined, user, c.body.signal) : null,
      alternatives: live.filter((row) => row !== featured).map((row) => publicRun(db, row, undefined, user)),
      history: history.map((row) => publicRun(db, row.status === 'superseded' ? row : {
        ...row, status: 'superseded', reason: available ? 'Появилась другая версия сигнала.' : 'Разбор завершён.',
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
    syncInvestigations(db, caseId);
    const parent = getRun(db, caseId, parentId);
    if (!parent || !canViewRun(parent, user, false) || parent.status === 'superseded' || !active(c))
      throw Error('Откройте текущую версию разбора.');
    const id = randomUUID();
    db.prepare(`INSERT INTO case_investigations(id,case_id,revision,owner,parent_id,question,request_id,status,created)
      VALUES(?,?,?,?,?,?,?,'queued',?)`).run(id, caseId, parent.revision, user.id, parent.id, question, requestId, Date.now());
    wakeByDatabase.get(db)?.();
    return publicRun(db, getRun(db, caseId, id));
  });
}

export function retryInvestigationStage(db, user, {caseId,runId,role,attempt}) {
  return transaction(db, () => {
    const c = accessibleCase(db,user,caseId);
    const row = getRun(db,caseId,runId);
    if (!row || (row.owner && row.owner !== user.id)) throw Error('Исследование недоступно.');
    if (!active(c) || row.status === 'superseded' || row.revision !== (c.body.signal?.revision ?? 0))
      throw Error('Откройте текущую версию разбора.');
    const stage = states(db,row.id).find(s => s.role === role);
    if (!stage || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > stage.attempt)
      throw Error('Выберите неудавшуюся попытку.');
    if (stage.status === 'retry' && stage.attempt === attempt && row.status !== 'ready' && !row.wait_for) {
      db.prepare("UPDATE case_investigation_role_state SET status='queued',reason=NULL,next=0 WHERE run_id=? AND role=?")
        .run(runId,role);
      updateRunProgress(db,runId);
      wakeByDatabase.get(db)?.();
    }
    return publicRun(db,getRun(db,caseId,runId),undefined,user);
  });
}

export function publishInvestigation(db, user, { caseId, id }) {
  return transaction(db, () => {
    const c = accessibleCase(db, user, caseId);
    const row = getRun(db, caseId, id);
    if (!row || row.owner !== user.id) throw Error('Опубликовать исследование может его автор.');
    if (row.published) return publicRun(db, row);
    if (c.body.owner) throw Error('Сначала опубликуйте сам разбор.');
    if (!active(c) || row.revision !== (c.body.signal?.revision ?? 0) || row.status !== 'ready' || !row.result) throw Error('Можно опубликовать готовое актуальное исследование.');
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
    if (!active(c) || !row || row.revision !== (c.body.signal?.revision ?? 0) || !canViewRun(row, user, false) || row.status !== 'ready' || !row.result)
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

export function listInvestigationWork(store, env, now, runId = null) {
  const {db} = store;
  const modelReason = modelWait(env);
  const {generation} = db.prepare('SELECT generation FROM case_investigation_sources WHERE id=1').get();
  const rows = db.prepare(`SELECT r.id,r.case_id,r.prepared,r.wait_for,r.reason,r.source_generation,r.parent_id
    FROM case_investigations r JOIN cases c ON c.id=r.case_id
    WHERE ${caseActive} AND r.revision=${revisionOf} AND r.status NOT IN ('ready','superseded')
      AND r.lease_until<=? AND r.next<=? ${runId ? 'AND r.id=?' : ''}
    ORDER BY r.created,r.rowid`).all(now, now, ...(runId ? [runId] : []));
  const work = [];
  for (const r of rows) {
    const item = {caseId:r.case_id, runId:r.id};
    if (r.wait_for === 'data' && r.source_generation === generation) continue;
    if (r.wait_for === 'model' && r.reason === modelReason) continue;
    if (r.wait_for === 'parent' && !db.prepare("SELECT 1 FROM case_investigations WHERE id=? AND json_extract(capture,'$.measurable')=1").get(r.parent_id)) continue;
    if (!r.prepared || modelReason || r.wait_for) {
      work.push({...item, kind:'prepare'});
      continue;
    }
    const siblings = states(db, r.id);
    for (const stage of siblings) {
      if (eligible(stage, siblings, now)) work.push({...item, kind:'role',role:stage.role});
    }
  }
  return work;
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

function saveStage(db, row, stage, ordinal, result, usage, elapsed, env, now, attempt, failure) {
  db.prepare(`INSERT INTO case_investigation_stages(run_id,ordinal,role,output,usage,elapsed,completed,attempt,failure)
    VALUES(?,?,?,?,?,?,?,?,?)`).run(row.id, ordinal, stage, result && JSON.stringify(result), usage && JSON.stringify(usage), elapsed, now, attempt, failure);
  if (usage) {
    db.prepare('INSERT INTO costs(job,model,elapsed,input,output) VALUES(?,?,?,?,?)')
      .run(row.id, env.LLM_MODEL || env.LLM_BACKEND || 'api', elapsed, usage.input ?? null, usage.output ?? null);
  }
}


// Only a PM's own follow-up question can authorize an external read for a background version.
// Store the excerpt with the calculation so all later stages inspect the same evidence.
async function attachRequestedWeb(store,job,env,send,pageOptions) {
  const {row,capture,lease}=job;
  if (!row.parent_id || !row.owner || capture.externalRead || noWeb(row.question || '')) return true;
  const question=row.question || '';
  const url=/(?:прочитай|проверь|открой|сверь|посмотри)/iu.test(question) && question.match(/https?:\/\/[^\s<>«»]+/iu)?.[0];
  const query=webQuestion(question,false);
  if (!url && !query) return true;
  const findings=[];
  let reason;
  try {
    if(url) {
      const page=await readPublicPage(url,env,pageOptions);
      findings.push({url:page.url,label:page.title,text:page.text.slice(0,2000),date:page.checkedAt.slice(0,10)});
    } else {
      if (query.length>400) throw Error('Сократите поисковый запрос до 400 символов.');
      const hits=await yandexSearch(query,env,send,()=>store.db.prepare('INSERT INTO web_requests(job,created) VALUES(?,?)').run(row.id,Date.now()));
      for(const hit of hits) findings.push({url:hit.url,label:hit.title,text:hit.snippet||hit.title,date:new Date().toISOString().slice(0,10)});
      if(!hits.length) reason='Поиск не вернул результатов.';
    }
  } catch(error) { reason=error.message; }
  return store.tx(()=>{
    if(!ownsPreparation(store.db,row,lease,job.now())) return false;
    const records=findings.map((f,i)=>({...f,id:'public-'+(i+1),kind:'lookup',source:f.url}));
    const context={...capture.context,findings:[...(capture.context.findings||[]),...records]};
    const raw=JSON.stringify(context), calcId=digest(raw);
    store.db.prepare('INSERT OR IGNORE INTO evidence_calcs VALUES(?,?)').run(calcId,raw);
    grant(store.db,calcId,'user',row.owner);
    Object.assign(capture,{context,calcId,externalRead:true,checks:[...capture.checks,{
      role:'researcher',status:reason?'unavailable':'done',question,
      result:reason || (url?'Прочитана публичная страница.':'Получены фрагменты выдачи Яндекса.'),
      sources:records.map(f=>({label:f.label,url:f.url})),
    }]});
    store.db.prepare('UPDATE case_investigations SET capture=? WHERE id=? AND lease=?').run(JSON.stringify(capture),row.id,lease);
    return true;
  });
}

function currentRevision(db, row) {
  const c = getCase(db, row.case_id);
  return active(c) && row.revision === (c.body.signal?.revision ?? 0);
}

function ownsPreparation(db, row, lease, now) {
  const current = getRun(db,row.case_id,row.id);
  return current?.lease === lease && current.lease_until > now && currentRevision(db,row);
}

function prepareJob(db, row, env, options, start) {
  const {capture:captureInputs = captureInvestigation, now = Date.now, leaseMs = leaseDuration} = options;
  const modelReason = modelWait(env);
  const {generation} = db.prepare('SELECT generation FROM case_investigation_sources WHERE id=1').get();
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

  const lease = randomUUID();
  db.prepare("UPDATE case_investigations SET status='running',reason=NULL,wait_for=NULL,lease=?,lease_until=? WHERE id=?")
    .run(lease,start + leaseMs,row.id);
  return {row,run,capture,mode,lease,now};
}

async function finishPreparation(store, job, env, send, options) {
  const {db} = store;
  const {row,mode,lease,now} = job;
  try {
    if (!await attachRequestedWeb(store,job,env,send,options.pageOptions)) return null;
    return store.tx(() => {
      if (!ownsPreparation(db,row,lease,now())) return null;
      ensureStages(db,row.id,mode);
      db.prepare('UPDATE case_investigations SET prepared=1,lease=NULL,lease_until=0,next=0,attempts=0 WHERE id=?').run(row.id);
      updateRunProgress(db,row.id);
      return publicRun(db,getRun(db,row.case_id,row.id));
    });
  } catch (error) {
    return store.tx(() => {
      if (!ownsPreparation(db,row,lease,now())) return null;
      setRetry(db,row,now(),'Не удалось подготовить расчёт. Проверка будет повторена.');
      return publicRun(db,getRun(db,row.case_id,row.id));
    });
  }
}

function claimRole(db,row,stage,start,leaseMs) {
  const state = states(db,row.id).find(s => s.role === stage);
  const lease = randomUUID();
  db.prepare(`UPDATE case_investigation_role_state SET status='running',lease=?,lease_until=?,attempt=attempt+1,
    next=0,reason=NULL WHERE run_id=? AND role=?`).run(lease,start+leaseMs,row.id,stage);
  updateRunProgress(db,row.id);
  const outputs = completed(db,row.id);
  const prior = ['lead','reviewer'].includes(stage) ? outputs : [];
  const capture = parse(row.capture);
  const run = publicRun(db,row,outputs);
  return {row,stage,ordinal:state.ordinal,attempt:state.attempt+1,lease,start,prior,capture,run};
}

async function executeRole(store, job, env, send, options) {
  const {row,stage,ordinal,attempt,lease,start,prior,capture,run} = job;
  const {now = Date.now, execute = runInvestigationStage} = options;
  const final = stage === stageOrder[row.mode].at(-1);
  let output, usage, failure, providerDenied = false;
  try {
    const candidate = await execute({env,send,stage,run,capture,prior});
    usage = candidate?.usage;
    if (!candidate?.check || (['lead','reviewer'].includes(stage) && !candidate.result))
      throw Object.assign(Error('Некорректный результат проверки.'), {invalidModelResponse:true});
    output = candidate;
  } catch (error) {
    usage ??= error?.usage;
    providerDenied = [401,403,404].includes(error?.status);
    failure = failureReason(error);
  }
  const {db} = store;
  return store.tx(() => {
    const finished = now();
    syncInvestigations(db,row.case_id);
    const state = states(db,row.id).find(s => s.role === stage);
    const owns = state?.lease === lease && state.lease_until > finished && currentRevision(db,row);
    saveStage(db,row,stage,ordinal,owns && output ? output : null,usage || null,
      Math.max(0,finished-start),env,finished,attempt,owns ? failure || null : 'Истёк срок попытки.');
    if (!owns) return null;
    const delay = providerDenied ? providerWait : Math.min(300_000,15_000 * 2 ** Math.min(attempt-1,5));
    db.prepare(`UPDATE case_investigation_role_state SET status=?,reason=?,next=?,lease=NULL,lease_until=0
      WHERE run_id=? AND role=?`).run(output ? 'done' : 'retry',failure || null,output ? 0 : finished+delay,row.id,stage);
    if (final && output)
      db.prepare("UPDATE case_investigations SET status='ready',reason=NULL,result=? WHERE id=?").run(JSON.stringify(output.result),row.id);
    else updateRunProgress(db,row.id);
    return publicRun(db,getRun(db,row.case_id,row.id));
  });
}

export function tryStartInvestigation(store,work,env,send,options = {}) {
  const now = options.now || Date.now;
  const job = store.tx(() => {
    const start = now();
    if (!listInvestigationWork(store,env,start,work.runId).some(w => w.kind === work.kind && w.role === work.role)) return null;
    const row = getRun(store.db,work.caseId,work.runId);
    if (!row) return null;
    return work.kind === 'prepare' ? prepareJob(store.db,row,env,options,start)
      : claimRole(store.db,row,work.role,start,options.leaseMs ?? leaseDuration);
  });
  if (!job) return null;
  if (job.saved) return Promise.resolve(job.saved);
  return work.kind === 'prepare' ? finishPreparation(store,job,env,send,options) : executeRole(store,job,env,send,options);
}

export async function workInvestigation(store, env = process.env, send = fetch, options = {}) {
  if (options.reconcile !== false) syncInvestigations(store.db);
  const now = options.now || Date.now;
  const work = listInvestigationWork(store,env,now())[0];
  if (!work) return null;
  const run = await tryStartInvestigation(store,work,env,send,options);
  if (!run || work.kind === 'role') return run;
  const role = listInvestigationWork(store,env,now(),work.runId).find(w => w.kind === 'role');
  return role ? tryStartInvestigation(store,role,env,send,options) : run;
}
