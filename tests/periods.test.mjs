import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs } from '../server/evidence.mjs';
import { initWorkbench, createThread, enqueue, messages, workJobs } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';

const user = { id: 'pm-period', name: 'PM', role: 'admin' };
const period = { from: '2026-11-02', through: '2026-11-08' };
const metric = (date, n, d) => ({kind: 'metrics', loc: 'Metrics!' + date, row: {
  date, product: 'ЛК', segment: 'all', metric_id: 'lk_reco_ctr', unit: 'ratio',
  value: n / d, detail_json: JSON.stringify({ click_visits: n, viewed_visits: d }),
}});
const weekly = (week_start, orders_index) => ({ kind: 'sales', loc: 'BI!' + week_start, row: {
  product_family: 'Kaspersky', week_start, orders_index,
}});
const release = (release_id, release_date) => ({kind: 'releases', loc: release_id, row: {
  release_id, release_date, release_type: 'major', description: 'Kaspersky',
}});

test('calendar period bounds reach view, chat and immutable evidence; future releases stay outside the as-of view', async () => {
  const s = openStore(':memory:');
  try {
    initEvidence(s.db); initWorkbench(s.db);
    importDocs(s, [
      {file: 'metrics.xlsx', facts: [metric('2026-10-26', 1, 118), metric('2026-11-02', 0, 117)]},
      {file: 'calendar.xlsx', facts: [release('R-08', '2026-09-29'), release('R-09', '2026-10-01'), release('R-10', '2026-10-08')]},
      {file: 'sales.xlsx', facts: [weekly('2026-09-07', 101), weekly('2026-09-21', 102), weekly('2026-11-02', 103)]},
    ], {notify:false});
    const view = (args) => workspaceOperation(s, user, 'view', {product: 'Kaspersky', ...args}).view;
    const snap = view(period);
    assert.deepEqual([snap.ctr.n, snap.ctr.d, snap.ctr.sources.length], [0, 117, 1]);
    assert.deepEqual(view({through: '2026-09-30'}).timeline.map(f=>f.data.release_id), ['R-08']);
    assert.deepEqual(view({through: '2026-09-15'}).summary[0].rows.map(x=>x.week), ['2026-09-07']);
    assert.equal(snap.releaseVersions.length, 1);
    assert.throws(() => view({from: '2026-11-31'}), /дату/);
    assert.throws(() => view({from: period.through, through: period.from}), /периода/);
    const thread = createThread(s.db, user, 'Период');
    enqueue(s, user, {thread, question:'Какой CTR рекомендаций за 2–8 ноября 2026?'});
    await workJobs(s, {publicUser: () => user}, {LLM_DATA_MODE:'selection'});
    const reply = messages(s.db, user, thread).items.at(-1).body;
    assert.match(reply.text, /0 \/ 117 = 0%/);
    assert.equal(workspaceOperation(s,user,'calc',{id:reply.calc}).cut, period.through);
    enqueue(s, user, {thread, question:'Какие релизы были известны по состоянию на 30 сентября 2026?'});
    await workJobs(s, {publicUser: () => user}, {LLM_DATA_MODE:'selection'});
    const historical = messages(s.db, user, thread).items.at(-1).body;
    assert.match(historical.text, /R-08/);
    assert.doesNotMatch(historical.text, /R-09|R-10/);
    assert.equal(workspaceOperation(s,user,'calc',{id:historical.calc}).cut, '2026-09-30');
    importDocs(s, [{file: 'metrics.xlsx', facts: [metric('2026-11-02', 2, 117)]}], {notify:false});
    assert.equal(workspaceOperation(s,user,'calc',{id:snap.id}).ctr.n, 0);
    assert.equal(view(period).ctr.n, 2);
    assert.notEqual(snap.id, view(period).id);
  } finally { s.close(); }
});
