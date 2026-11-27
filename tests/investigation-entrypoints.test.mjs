import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamApp } from '../server/team-http.mjs';
import { cases, importDocs } from '../server/evidence.mjs';
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
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true }); });
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
});
