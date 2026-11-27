import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamApp } from '../server/team-http.mjs';
import { cases, importDocs } from '../server/evidence.mjs';
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
  assert.deepEqual(calls.sort(),[first,first,second,second,signal.id,signal.id].sort());
});
