import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamApp } from '../server/team-http.mjs';
import { cases, importDocs } from '../server/evidence.mjs';
import { openReleaseCase } from '../server/release-cases.mjs';
import { listInvestigationWork, tryStartInvestigation } from '../server/case-investigations.mjs';
import { openStore } from '../server/store.mjs';
import { initEvidence } from '../server/evidence.mjs';
import { initWorkbench } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { grant, readSnapshot } from '../server/chart-ranges.mjs';

test('generic report publication cannot share the entire calculation of a private investigation', t => {
  const store = openStore(':memory:', {seedDemo:false});
  t.after(() => store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  const anna = {id:'anna',name:'Анна'}, colleague = {id:'b',name:'Борис'};
  const {id:caseId} = workspaceOperation(store,anna,'create-case',{title:'Проверить',product:'Store'});
  const calc = 'private-investigation';
  store.db.prepare('INSERT INTO evidence_calcs VALUES(?,?)').run(calc, JSON.stringify({kind:'investigation-calculation', product:'Store'}));
  grant(store.db,calc,'user',anna.id);
  for (const op of ['prepare_publish','publish']) {
    assert.throws(() => workspaceOperation(store,anna,op,{caseId,calc,cards:['summary']}), /исследован/i);
  }
  assert.throws(() => readSnapshot(store.db,colleague,calc));
});

test('manual and detected cases already have a durable investigation at their normal HTTP entrypoints', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-investigation-entry-'));
  const env = { DATA_PROFILE: 'local', ADMIN_INVITE_KEY: 'investigation-fixture' };
  const app = createTeamApp({ base: join(dir, 'test.sqlite'), env, background: false });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true, maxRetries:3 }); });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port + '/api/team/';
  const post = async (op, body, cookie) => {
    const r = await fetch(base + op, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: JSON.stringify(body) });
    const result = await r.json();
    assert.ok(r.ok, op + ' ' + JSON.stringify(result));
    return { result, cookie: r.headers.get('set-cookie')?.split(';')[0] };
  };
  const { cookie, result: admin } = await post('register', { login: 'inv-pm', name: 'ПМ', password: 'dev-fixture-password', code: env.ADMIN_INVITE_KEY });
  const period = {from:'2026-11-01', through:'2026-11-15'};
  const { result: manual } = await post('create-case', { title: 'Проверить период', product: 'Лицензии', ...period }, cookie);
  const store = app.space(admin.space);
  const facts = [
    { kind: 'dictionary', loc: 'A2', row: { metric_id: 'family_orders_idx', bad_signal: 'Индекс ниже 90 две недели подряд' } },
    ...['2026-11-02','2026-11-09'].map((week_start,i) => ({ kind:'sales', loc:'B'+i, row:{product_family:'Лицензии',week_start,orders_index:65} })),
  ];
  importDocs(store, [{ file:'Сигнал', facts }], {notify:false});
  const signal = cases(store.db).find(c => c.body.signal);
  assert.ok(signal);
  for (const id of [signal.id, manual.id]) {
    const { result: detail } = await post('view', {caseId:id}, cookie);
    if (id === manual.id) assert.equal(detail.case.body.plan.through, period.through);
    assert.equal(detail.investigation?.current?.caseId, id);
    const { result } = await post('investigation-status', {caseId:id}, cookie);
    assert.equal(result.current.id, detail.investigation.current.id);
  }

  const runId=(await post('investigation-status',{caseId:manual.id},cookie)).result.current.id;
  const model={LLM_BASE_URL:'https://fixture.invalid',LLM_MODEL:'fixture',LLM_DATA_MODE:'analysis'};
  const options={capture:()=>({measurable:true,context:{},checks:[]}),execute:async()=>{throw Object.assign(Error('fixture'),{status:429});}};
  const work=()=>listInvestigationWork(store,model,Date.now(),runId);
  await tryStartInvestigation(store,work()[0],model,undefined,options);
  await tryStartInvestigation(store,work().find(item=>item.role==='analyst'),model,undefined,options);
  const {result:failed}=await post('investigation-status',{caseId:manual.id},cookie);
  const stage=failed.current.stages.find(s=>s.canRetry);
  const command={runId,caseId:manual.id,role:stage.role,attempt:stage.attempt};
  const {result:retried}=await post('investigation-retry-stage',command,cookie);
  assert.equal(retried.stages.find(s=>s.role==='analyst').status,'queued');
});

test('startup, committed imports and manual cases wake investigations without reading the case', async t => {
  const dir=await mkdtemp(join(tmpdir(),'investigation-wake-'));
  const base=join(dir,'team.sqlite');
  const env={LLM_BASE_URL:'https://fixture.invalid',LLM_MODEL:'fixture',LLM_DATA_MODE:'analysis'};
  const pm={id:'pm',name:'PM'}, calls=[], gates=[];
  let app=createTeamApp({base,env,background:false});
  const create=title=>workspaceOperation(app.space('team'),pm,'create-case',{title,product:'Store'}).id;
  const first=create('Сохранено до запуска');
  await app.close();
  app=createTeamApp({base,env,background:true,investigationOptions:{
    capture:(_db,run)=>({measurable:true,context:{},calcId:'calc-'+run.id,checks:[]}),
    async execute({run,stage}) {
      const gate=Promise.withResolvers(); gates.push(gate); calls.push(run.caseId);
      await gate.promise;
      return {check:{role:stage},result:{stage}};
    },
  }});
  t.after(async()=>{const closing=app.close(); gates.forEach(g=>g.resolve()); await closing;
    await rm(dir,{recursive:true,force:true,maxRetries:3});});
  async function waitForCalls(n) {
    const deadline=Date.now()+1200;
    while (calls.length<n && Date.now()<deadline) await new Promise(resolve=>setImmediate(resolve));
    assert.ok(calls.length>=n,'work should start before the periodic sweep');
  }
  await waitForCalls(2);
  const second=create('После запуска');
  await waitForCalls(4);
  assert.throws(()=>app.space('team').tx(()=>{ create('Откат'); throw Error('rollback'); }));
  importDocs(app.space('team'),[{file:'Сигнал',facts:[
    {kind:'dictionary',loc:'A2',row:{metric_id:'family_orders_idx',bad_signal:'Индекс ниже 90 две недели подряд'}},
    ...['2026-11-02','2026-11-09'].map((week_start,i)=>({kind:'sales',loc:'B'+i,row:{product_family:'Store',week_start,orders_index:65}})),
  ]}],{notify:false});
  const signal=cases(app.space('team').db).find(c=>c.body.signal);
  assert.ok(signal);
  await waitForCalls(6);
  const release = { kind: 'releases', loc: 'Релизы!A2', row: {
    release_id: 'STORE-1', release_type: 'major', status: 'выпущен', description: 'Обновление Store',
    release_date: '2026-11-16', affected_metrics: 'orders_index',
  } };
  const store = app.space('team');
  importDocs(store, [{ file: 'Календарь', facts: [release] }], { notify: false });
  const releaseCase = cases(store.db).find(c => c.body.release === 'STORE-1');
  assert.ok(releaseCase, 'import immediately saves the release case');
  await waitForCalls(8);
  assert.deepEqual(calls.sort(), [first, first, second, second, signal.id, signal.id, releaseCase.id, releaseCase.id].sort());
});

test('participants explicitly choose a scope and share one durable investigation for a release', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-release-case-'));
  const env = { DATA_PROFILE: 'local', ADMIN_INVITE_KEY: 'admin-case', DEMO_INVITE_KEY: 'judge-case' };
  const open = () => createTeamApp({ base: join(dir, 'team.sqlite'), env, background: false });
  let app = open();
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  async function listen() {
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  }
  async function post(op, input, cookie) {
    const base = 'http://127.0.0.1:' + app.server.address().port + '/api/team/';
    const response = await fetch(base + op, { method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(cookie && { cookie }) }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function register(login, code) {
    const result = await post('register', { login, name: login, code, password: 'fixture-release-password' });
    assert.equal(result.status, 200, result.body.error);
    return result.cookie;
  }
  await listen();
  const admin = await register('release-admin', env.ADMIN_INVITE_KEY);
  const member = await register('release-member', app.accounts.invite('team'));
  const judge = await register('release-judge', env.DEMO_INVITE_KEY);
  const store = app.space('team');
  const releaseId = 'MIX-1';
  importDocs(store, [{ file: 'Календарь', facts: [
    { kind: 'releases', loc: 'Релизы!A2', row: { release_id: releaseId, release_type: 'major',
      status: 'выпущен', release_date: '2026-10-05', description: 'Обновление Astra и Kaspersky',
      affected_metrics: 'orders_index' } },
    ...['Astra', 'Kaspersky'].map((product_family, index) => ({ kind: 'sales', loc: 'Продажи!A' + (index + 2),
      row: { product_family, week_start: '2026-09-28', orders_index: 100 } })),
  ] }], { notify: false });
  const personal = await post('create-case', { title: 'Мой разбор', product: 'Astra', release: releaseId }, admin);
  assert.equal(personal.status, 200, personal.body.error);

  const options = await post('ensure-release-case', { releaseId }, admin);
  assert.equal(options.status, 200, options.body.error);
  assert.deepEqual(options.body, { caseId: null, options: [
    { product: 'Astra', metrics: ['orders_index'] }, { product: 'Kaspersky', metrics: ['orders_index'] },
  ] });
  assert.equal((await post('ensure-release-case', { releaseId, product: 'Store', metric: 'orders_index' }, member)).status, 400);
  assert.equal((await post('ensure-release-case', { releaseId: 'UNKNOWN' }, admin)).status, 400);
  assert.equal((await post('ensure-release-case', { releaseId }, judge)).status, 400);

  const input = { releaseId, product: 'Astra', metric: 'orders_index' };
  const [first, second] = await Promise.all([
    post('ensure-release-case', input, admin), post('ensure-release-case', input, member),
  ]);
  assert.equal(first.status, 200, first.body.error);
  assert.equal(second.status, 200, second.body.error);
  const { caseId } = first.body;
  assert.ok(caseId);
  assert.equal(second.body.caseId, caseId);
  assert.notEqual(caseId, personal.body.id);
  const { body: detail } = await post('view', { caseId }, member);
  assert.equal(detail.case.product, 'Astra');
  assert.equal(detail.case.body.release, releaseId);
  assert.equal(detail.case.body.plan.metric, 'orders_index');
  assert.equal((await post('view', { caseId: personal.body.id }, member)).status, 400);

  const { current } = (await post('investigation-status', { caseId }, member)).body;
  assert.equal(current.caseId, caseId);
  await app.close();
  app = open();
  await listen();
  assert.equal((await post('ensure-release-case', { releaseId }, member)).body.caseId, caseId);
  const restarted = (await post('investigation-status', { caseId }, member)).body;
  assert.equal(restarted.current.id, current.id);
  assert.equal(app.space('team').db.prepare(
    'SELECT count(*) AS n FROM case_investigations WHERE case_id=? AND parent_id IS NULL'
  ).get(caseId).n, 1);
});

test('publishing a calendar release queues one investigation that waits for post-release data', async t => {
  const store = openStore(':memory:', { seedDemo: false });
  t.after(() => store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  const sales = (week_start, orders_index) => ({ kind: 'sales', loc: 'Продажи!' + week_start,
    row: { product_family: 'Astra', week_start, orders_index } });
  const release = (status, description = 'Обновление Astra') => ({ kind: 'releases', loc: 'Релизы!A2',
    row: { release_id: 'R-ASTRA', release_type: 'major', status, description,
      release_date: '2026-10-19', affected_metrics: 'family_orders_idx' } });
  const importCalendar = (...facts) => importDocs(store, [{ file: 'Календарь', facts }], { notify: false });
  const releaseCases = () => cases(store.db).filter(c => c.body.release === 'R-ASTRA');
  importCalendar(release('запланирован'), sales('2026-09-28', 108), sales('2026-10-05', 110), sales('2026-10-12', 102));
  assert.deepEqual(releaseCases(), []);
  assert.throws(() => importCalendar(release('выпущен'), { kind: 'invalid', loc: 'A1' }), /Неизвестный тип данных/);
  assert.deepEqual(releaseCases(), []);

  importCalendar(release('выпущен'));
  const [releaseCase] = releaseCases();
  assert.ok(releaseCase, 'updating the rollout status creates the case');
  const run = () => store.db.prepare('SELECT id,status,wait_for FROM case_investigations WHERE case_id=?').get(releaseCase.id);
  const runId = run().id;
  importCalendar(release('выпущен'));
  importCalendar(release('выпущен', 'Уточнённое обновление Astra'));
  assert.deepEqual(releaseCases().map(c => c.id), [releaseCase.id]);
  assert.equal(run().id, runId);

  const env = { LLM_BASE_URL: 'https://fixture.invalid', LLM_MODEL: 'fixture', LLM_DATA_MODE: 'analysis' };
  const work = () => listInvestigationWork(store, env, Date.now(), runId);
  await tryStartInvestigation(store, work()[0], env);
  assert.deepEqual({ ...run() }, { id: runId, status: 'waiting', wait_for: 'data' });
  assert.deepEqual(work(), []);
  importCalendar(sales('2026-10-26', 101));
  await tryStartInvestigation(store, work()[0], env);
  assert.equal(run().id, runId);
  assert.equal(run().wait_for, null);
  assert.ok(work().some(item => item.role === 'analyst'));

  importCalendar({ kind: 'releases', loc: 'Релизы!A3', row: { release_id: 'R-LK-CTR', release_type: 'minor',
    status: 'выпущен', description: 'Карусель рекомендаций', release_date: '2026-10-19', affected_metrics: 'lk_reco_ctr' } });
  const accountCase = cases(store.db).find(c => c.body.release === 'R-LK-CTR');
  assert.equal(accountCase.product, 'ЛК');
  assert.equal(accountCase.body.plan.metric, 'lk_reco_ctr');
});

test('a release listing recommendation clicks lets the user choose CTR and waits for comparable ratios', async t => {
  const store = openStore(':memory:', { seedDemo: false });
  t.after(() => store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  const releaseId = 'R-LK-CLICKS';
  importDocs(store, [{ file: 'Календарь', facts: [{ kind: 'releases', loc: 'Релизы!A3', row: {
    release_id: releaseId, release_type: 'minor',
    status: 'выпущен', description: 'Карусель рекомендаций', release_date: '2026-10-19',
    affected_metrics: 'lk_reco_click_visits' } }] }], { notify: false });
  assert.equal(cases(store.db).some(c => c.body.release === releaseId), false);
  assert.deepEqual(openReleaseCase(store, { releaseId }), {
    caseId: null, options: [{ product: 'ЛК', metrics: ['lk_reco_ctr'] }],
  });
  const { caseId } = openReleaseCase(store, { releaseId, product: 'ЛК', metric: 'lk_reco_ctr' });
  const read = () => store.db.prepare('SELECT id,wait_for,capture FROM case_investigations WHERE case_id=?').get(caseId);
  const { id } = read();
  const env = { LLM_BASE_URL: 'https://fixture.invalid', LLM_MODEL: 'fixture', LLM_DATA_MODE: 'analysis' };
  const work = () => listInvestigationWork(store, env, Date.now(), id);
  await tryStartInvestigation(store, work()[0], env);
  assert.equal(read().wait_for, 'data');
  const weeks = ['2026-09-21', '2026-09-28', '2026-10-05', '2026-10-12', '2026-10-19'];
  importDocs(store, [{ file: 'CTR', facts: weeks.map((date, i) => ({ kind: 'metrics', loc: 'CTR!A' + (i + 2),
    row: { metric_id: 'lk_reco_ctr', product: 'ЛК', segment: 'all', date, unit: 'ratio',
      numerator: i === 4 ? 20 : 10, denominator: 100 } })) }], { notify: false });
  await tryStartInvestigation(store, work()[0], env);
  const result = read();
  assert.equal(result.id, id);
  assert.equal(result.wait_for, null);
  const [finding] = JSON.parse(result.capture).context.calculation.findings;
  assert.equal(finding.before, 10);
  assert.equal(finding.after, 20);
});

test('a different affected KPI never starts an order-index investigation without an explicit choice', t => {
  const store = openStore(':memory:', { seedDemo: false });
  t.after(() => store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  const releaseId = 'R-CART';
  importDocs(store, [{ file: 'Календарь', facts: [
    { kind: 'sales', loc: 'Продажи!A2', row: { product_family: 'Astra', week_start: '2026-10-05', orders_index: 100 } },
    { kind: 'releases', loc: 'Релизы!A2', row: { release_id: releaseId, release_type: 'major',
      release_date: '2026-10-12', status: 'выпущен', description: 'Корзина Astra', affected_metrics: 'cart' } },
  ] }], { notify: false });
  assert.equal(cases(store.db).find(c => c.body.release === releaseId), undefined);
  assert.deepEqual(openReleaseCase(store, { releaseId }), {
    caseId: null, options: [{ product: 'Astra', metrics: ['orders_index'] }],
  });
  const { caseId } = openReleaseCase(store, { releaseId, product: 'Astra', metric: 'orders_index' });
  assert.equal(cases(store.db).find(c => c.body.release === releaseId)?.id, caseId);
});
