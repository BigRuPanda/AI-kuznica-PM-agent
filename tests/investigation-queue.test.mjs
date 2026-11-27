import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { initEvidence } from '../server/evidence.mjs';
import { initWorkbench } from '../server/workbench.mjs';
import { access, grant } from '../server/chart-ranges.mjs';
import { saveResearchSettings } from '../server/investigation-settings.mjs';
import {
  initInvestigations, syncInvestigations, readInvestigations, visibleRun,
  createAlternative, publishInvestigation, requireActionableRun, workInvestigation,
} from '../server/case-investigations.mjs';

const anna = { id: 'anna', name: 'Анна' };
const dima = { id: 'dima', name: 'Дима' };
const enabled = { LLM_BASE_URL: 'https://example.invalid', LLM_MODEL: 'queue-test', LLM_DATA_MODE: 'analysis' };
function open(path = ':memory:') {
  const store = openStore(path, { seedDemo: false });
  initEvidence(store.db);
  initWorkbench(store.db);
  initInvestigations(store.db);
  return store;
}
function add(db, id, body = {}, state = 'Исследуем') {
  db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(id, 'Kaspersky', id, state, JSON.stringify(body));
}
const noSend = () => { throw Error('Unexpected transport'); };
function fixture(overrides = {}) {
  const options = {
    capture(db, run) {
      const calcId = 'calc-' + run.id;
      db.prepare('INSERT OR IGNORE INTO evidence_calcs VALUES(?,?)').run(calcId, JSON.stringify({ product: 'Kaspersky' }));
      return { calcId, period: { from: '2026-07-01' }, unit: '%', context: { version: 1 },
        measurable: true, summary: '−34%', checks: [{ role: 'calculation', outcome: '−34%' }] };
    },
    async execute({ stage, capture, prior }) {
      assert.equal(capture.context.version, 1);
      return { check: { role: stage, outcome: 'Готово' }, result: { conclusion: stage, preceding: prior.length },
        usage: { input: 20, output: 5 } };
    },
    ...overrides,
  };
  return (store, env = enabled) => workInvestigation(store, env, noSend, options);
}
test('independent roles complete out of order and keep deterministic inputs', async t => {
  const store = open();
  t.after(() => store.close());
  add(store.db, 'parallel');
  const arrived = Promise.withResolvers(), release = Promise.withResolvers(), inputs = {};
  const work = fixture({async execute({stage, prior}) {
    inputs[stage] = prior.map(p => p.check.role);
    if (stage === 'analyst') { arrived.resolve(); await release.promise; }
    return {check:{role:stage}, result:{stage}};
  }});
  const analyst = work(store);
  await arrived.promise;
  try {
    const second = await work(store);
    assert.equal(second?.checks.at(-1).role, 'researcher');
    assert.equal(await work(store), null);
  } finally { release.resolve(); await analyst; }
  await drain(store, work);
  assert.deepEqual(inputs, {analyst:[], researcher:[], lead:['analyst','researcher'], reviewer:['analyst','researcher','lead']});
});

test('legacy retries resume once across restart with completed evidence intact', async t => {
  const dir = mkdtempSync(join(tmpdir(),'legacy-role-'));
  const path = join(dir,'team.sqlite');
  let store=open(path);
  t.after(()=>{store.close(); rmSync(dir,{recursive:true,force:true,maxRetries:3});});
  for (let i=0;i<4;i++) add(store.db,'threshold-'+i);
  add(store.db,'partial');
  syncInvestigations(store.db);
  const partial=readInvestigations(store.db,anna,'partial').current.id;
  store.db.exec(`DROP TABLE case_investigation_role_state;
    ALTER TABLE case_investigations DROP COLUMN prepared;
    ALTER TABLE case_investigation_stages DROP COLUMN attempt;
    ALTER TABLE case_investigation_stages DROP COLUMN failure;
    UPDATE case_investigations SET status='retry',mode='roles',attempts=13,next=900000,
      reason='Не удалось подготовить расчёт. Проверка будет повторена.';`);
  const snapshot={calcId:'legacy',measurable:true,context:{version:1},checks:[]};
  store.db.prepare("UPDATE case_investigations SET capture=?,next=100,attempts=4,reason='Сбой этапа' WHERE id=?")
    .run(JSON.stringify(snapshot),partial);
  const insert=store.db.prepare('INSERT INTO case_investigation_stages(run_id,ordinal,role,output,elapsed,completed) VALUES(?,?,?,?,1,1)');
  for(const [index,role] of ['analyst','researcher'].entries())
    insert.run(partial,index,role,JSON.stringify({check:{role}}));
  store.close();
  store=open(path);
  initInvestigations(store.db);
  assert.equal(store.db.prepare("SELECT count(*) n FROM case_investigations WHERE case_id LIKE 'threshold-%' AND next=0").get().n,4);
  const starts=[];
  await drain(store,fixture({now:()=>101,async execute({stage,run}) {
    starts.push([run.id,stage]);
    return {check:{role:stage},result:{stage}};
  }}));
  assert.deepEqual(starts.filter(([id])=>id===partial).map(([,role])=>role),['lead','reviewer']);
  assert.equal(starts.length,18);
  assert.equal(readInvestigations(store.db,anna,'partial').current.calcId,'legacy');
  store.close(); store=open(path);
  assert.equal(await fixture()(store),null);
});

async function drain(store, work) {
  for (let i = 0; i < 40; i++) if (!(await work(store))) return;
  assert.fail('queue did not drain');
}
test('role stages survive restart and chat deletion; an unfinished review retries against the original calculation', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'investigation-'));
  const path = join(dir, 'store.sqlite');
  let store = open(path);
  t.after(() => {
    store.db.close();
    rmSync(dir, { recursive: true, force: true });
  });
  let now = 3000, attempts = 0;
  const work = fixture({ now: () => now,
    async execute({ stage, capture, prior }) {
      if (stage === 'reviewer' && ++attempts === 1) throw Error('Временный сбой провайдера');
      return { check: { role: stage, evidence: capture.calcId },
        result: { stage, prior: prior.map(p => p.check.role) }, usage: { input: 3, output: 2 } };
    } });
  add(store.db, 'case', { signal: { revision: 2, status: 'confirmed' } });
  syncInvestigations(store.db,'case');
  const id = readInvestigations(store.db, anna, 'case').current.id;
  for (let i = 0; i < 3; i++) await work(store);
  const draft = readInvestigations(store.db, anna, 'case').current;
  assert.deepEqual(draft.checks.map(x => x.role), ['calculation', 'analyst', 'researcher', 'lead']);
  assert.ok(!draft.result);
  assert.throws(() => requireActionableRun(store.db, anna, 'case', id));
  store.db.close();
  store = open(path);
  store.db.exec("DELETE FROM chat_items; DELETE FROM conversations WHERE scope='private'");
  assert.equal((await work(store)).status, 'retry');
  assert.equal(await work(store), null);
  now += 600_000;
  assert.equal((await work(store)).status, 'ready');
  const ready = requireActionableRun(store.db, dima, 'case', id);
  assert.equal(ready.calcId, draft.calcId);
  assert.deepEqual(ready.result.prior, ['analyst', 'researcher', 'lead']);
  assert.equal(ready.checks.length, 5);
  assert.equal(store.db.prepare('SELECT count(*) n FROM costs WHERE job=?').get(id).n, 4);
  assert.equal(await work(store), null);
});

test('a request is idempotent and publishing one version opens only its own immutable evidence', async t => {
  const store = open(), { db } = store;
  t.after(() => db.close());
  add(db, 'case', { owner: anna.id, responsible: anna.name, origin: { calc: 'private-source' } });
  db.prepare('INSERT INTO evidence_calcs VALUES(?,?)').run('private-source', '{"secret":"личное"}');
  grant(db, 'private-source', 'user', anna.id);
  const work = fixture();
  await drain(store, work);
  const root = readInvestigations(db, anna, 'case').current;
  assert.equal(root.owner, anna.id);
  assert.throws(() => readInvestigations(db, dima, 'case'));
  const input = { caseId: 'case', parentId: root.id, question: 'Проверить событие', requestId: 'r1' };
  const alternative = createAlternative(db, anna, input);
  assert.equal(createAlternative(db, anna, input).id, alternative.id);
  assert.throws(() => createAlternative(db, anna, { ...input, question: 'Совсем другое' }));
  await drain(store, work);
  db.prepare("UPDATE cases SET body=json_remove(body,'$.owner') WHERE id='case'").run();
  assert.equal(readInvestigations(db, dima, 'case').current, null);
  assert.equal(visibleRun(db, anna, 'case', alternative.id, true), false);
  assert.throws(() => publishInvestigation(db, dima, { caseId: 'case', id: alternative.id }));
  const publication = { caseId: 'case', id: alternative.id };
  assert.equal(publishInvestigation(db, anna, publication).publishedBy, anna.name);
  assert.equal(publishInvestigation(db, { ...anna, name: 'Новое имя' }, publication).publishedBy, anna.name);
  const shared = readInvestigations(db, dima, 'case').current;
  assert.equal(shared.id, alternative.id);
  assert.equal(shared.publishedBy, anna.name);
  access(db, dima, shared.calcId, true);
  assert.throws(() => access(db, dima, root.calcId));
  assert.throws(() => access(db, dima, 'private-source'));
  assert.equal(visibleRun(db, dima, 'case', root.id), false);

  db.exec('ALTER TABLE case_investigations DROP COLUMN published_by');
  initInvestigations(db);
  const legacy = readInvestigations(db, dima, 'case').current;
  assert.equal(legacy.published, true);
  assert.equal(legacy.publishedBy, undefined);
  access(db, dima, legacy.calcId, true);
});

test('a late response cannot commit after a replacement, withdrawal or lease takeover', async t => {
  const store = open(), { db } = store;
  t.after(() => db.close());
  add(db, 'case', { signal: { revision: 1, status: 'confirmed' } });
  saveResearchSettings(db, { ...anna, role:'admin' }, {scope:'team',mode:'lead'});
  let now = 10, started, finish;
  const arrived = new Promise(resolve => { started = resolve; });
  const blocked = fixture({ now: () => now, leaseMs: 100,
    async execute() {
      started();
      await new Promise(resolve => { finish = resolve; });
      return { check: { role: 'stale' }, result: { stale: true } };
    } });
  const work = fixture({ now: () => now, leaseMs: 100 });
  const pending = blocked(store);
  await arrived;
  assert.equal(await work(store), null);
  now += 101;
  assert.equal((await work(store)).checks.at(-1).role, 'lead');
  finish();
  await pending;
  const original = readInvestigations(db, anna, 'case').current;
  assert.equal(original.checks.at(-1).role, 'lead');
  db.exec("UPDATE cases SET body=json_set(body,'$.signal.revision',2)");
  syncInvestigations(db);
  const corrected = readInvestigations(db, anna, 'case');
  assert.notEqual(corrected.current.id, original.id);
  assert.equal(corrected.history[0].id, original.id);
  await drain(store, work);
  db.exec("UPDATE cases SET body=json_set(body,'$.signal.revision',3,'$.signal.status','withdrawn')");
  assert.equal(readInvestigations(db, anna, 'case').current, null);
  assert.throws(() => requireActionableRun(db, anna, 'case', corrected.current.id));
  assert.equal(await work(store), null);
});

test('backfill includes effect and private cases; missing data wakes on import and model waits keep the measurement', async t => {
  const store = open(), { db } = store;
  t.after(() => db.close());
  add(db, 'effect', { owner: anna.id }, 'Наблюдаем эффект');
  add(db, 'closed', {}, 'Завершено');
  let measurable = false, captures = 0, calls = 0;
  const work = fixture({ now: () => 100,
    capture() { captures++; return { calcId: null, period: {}, context: {}, measurable, checks: [], summary: 'Сводка' }; },
    async execute({ stage }) { calls++; return { check: { role: stage }, result: { stage } }; } });
  assert.equal((await work(store)).status, 'waiting');
  assert.equal(await work(store), null);
  measurable = true;
  db.prepare('INSERT INTO documents VALUES(?,?,?,?)').run('v', 'продажи', 123, '{"facts":[]}');
  assert.equal((await work(store, { DATA_PROFILE: 'local' })).status, 'waiting');
  assert.equal((await work(store, { DATA_PROFILE: 'local' })), null);
  assert.equal(readInvestigations(db, anna, 'effect').current.summary, 'Сводка');
  await drain(store, work);
  assert.equal(captures, 2);
  assert.equal(calls, 4);
  assert.equal(readInvestigations(db, anna, 'closed').current, null);
});

test('waiting freezes the personal mode and reconciliation retains the original private owner', async t => {
  const store = open(), { db } = store;
  t.after(() => db.close());
  saveResearchSettings(db, anna, { scope: 'personal', mode: 'review' });
  store.tx(() => {
    add(db, 'case', { owner: anna.id, signal: { revision: 1, status: 'confirmed' } });
    syncInvestigations(db);
  });
  const work = fixture();
  const first = await work(store, { DATA_PROFILE: 'local' });
  assert.equal(first.mode, 'review');
  assert.equal(first.status, 'waiting');
  saveResearchSettings(db, anna, { scope: 'personal', mode: 'lead' });
  await drain(store, work);
  const ready = requireActionableRun(db, anna, 'case', first.id);
  assert.deepEqual(ready.checks.map(check => check.role), ['calculation', 'lead', 'reviewer']);
  db.exec("UPDATE cases SET body=json_set(json_remove(body,'$.owner'),'$.signal.revision',2)");
  await drain(store, work);
  const second = readInvestigations(db, anna, 'case').current;
  assert.equal(second.owner, anna.id);
  assert.equal(second.mode, 'lead');
  assert.deepEqual(second.checks.map(check => check.role), ['calculation', 'lead']);
  assert.equal(readInvestigations(db, dima, 'case').current, null);
  assert.throws(() => access(db, dima, second.calcId));
});

test('case-scoped repair guards a worker even when full backfill is scheduled separately', async t => {
  const store = open(), { db } = store;
  t.after(() => db.close());
  add(db, 'one', { signal: { revision: 1, status: 'confirmed' } });
  add(db, 'two');
  const work = fixture({ reconcile: false, async execute() {
    db.exec("UPDATE cases SET body=json_set(body,'$.signal.revision',2) WHERE id='one'");
    return { check: { role: 'stale' }, result: { stale: true } };
  } });
  assert.equal(await work(store), null);
  assert.equal(readInvestigations(db,anna,'one').current,null);
  syncInvestigations(db,'one');
  const original = readInvestigations(db, anna, 'one').current;
  assert.equal(db.prepare('SELECT count(*) n FROM case_investigations').get().n, 1);
  assert.equal(await work(store), null);
  const corrected = readInvestigations(db, anna, 'one');
  assert.equal(corrected.current.revision, 2);
  assert.equal(corrected.history[0].id, original.id);
  assert.ok(corrected.history[0].checks.every(check => check.role !== 'stale'));
  syncInvestigations(db);
  assert.equal(db.prepare("SELECT count(*) n FROM case_investigations WHERE case_id='two'").get().n, 1);
});

test('alternatives inherit a measurable parent and rejected credentials wait before another attempt', async t => {
  const store = open(), { db } = store;
  t.after(() => db.close());
  add(db, 'one');
  saveResearchSettings(db, { ...anna, role: 'admin' }, { scope: 'team', mode: 'lead' });
  syncInvestigations(db,'one');
  const original = readInvestigations(db, anna, 'one').current;
  const alternative = createAlternative(db, anna, {
    caseId: 'one', parentId: original.id, question: 'Проверить покупку', requestId: 'purchase',
  });
  let now = 100, measurable = false, authenticated = false, calls = 0;
  const work = fixture({ now: () => now,
    capture(_db, run) {
      if (run.parentId) assert.equal(run.parentCapture.summary, 'основной расчёт');
      return { measurable, context: {}, checks: [], summary: run.parentId ? 'альтернатива' : 'основной расчёт' };
    },
    async execute({ stage }) {
      calls++;
      if (!authenticated) throw Object.assign(Error('Отказано в доступе'), { status: 401 });
      return { check: { role: stage }, result: { stage } };
    },
  });
  assert.equal((await work(store)).id, original.id);
  const child = await work(store);
  assert.equal(child.id, alternative.id);
  assert.match(child.reason, /родительской/);
  assert.equal(await work(store), null);
  measurable = true;
  db.prepare('INSERT INTO documents VALUES(?,?,?,?)').run('new', 'Продажи', 100, '{"facts":[]}');
  assert.match((await work(store)).reason, /Ожидаем доступа к модели/);
  assert.match((await work(store)).reason, /Ожидаем доступа к модели/);
  assert.equal(await work(store), null);
  assert.equal(calls, 2);
  authenticated = true;
  now += 300_000;
  await drain(store, work);
  assert.equal(readInvestigations(db, anna, 'one').alternatives[0].status, 'ready');
  assert.equal(calls, 4);
});

test('only an explicitly requested alternative reads a public page and keeps it across stages', async t=>{
  const store=open(), {db}=store;
  t.after(()=>store.close());
  add(db,'case',{owner:anna.id,signal:{revision:1},plan:{question:'https://museum.example/ в исходных материалах'}});
  const work=fixture();
  await drain(store,work);
  const root=readInvestigations(db,anna,'case').current;
  let fetched=0;
  const run=createAlternative(db,anna,{caseId:'case',parentId:root.id,requestId:'page',question:'Прочитай страницу https://museum.example/ и сверь даты'});
  const worker=fixture({pageOptions:{resolveHost:async()=>[{address:'93.184.216.34',family:4}],
    request:async()=>{fetched++;return new Response('<title>Музей</title><p>Открыто 7 декабря.</p>',{headers:{'content-type':'text/html'}});}}});
  await drain(store,worker);
  assert.equal(fetched,1);
  const capture=JSON.parse(db.prepare('SELECT capture FROM case_investigations WHERE id=?').get(run.id).capture);
  assert.ok(capture.context.findings.some(f=>f.url==='https://museum.example/' && f.text.includes('7 декабря')));
});