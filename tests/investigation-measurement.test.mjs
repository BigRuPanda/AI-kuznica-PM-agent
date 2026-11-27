import assert from 'node:assert/strict';
import test from 'node:test';
import { createAlternative, publishInvestigation, readInvestigations, syncInvestigations } from '../server/case-investigations.mjs';
import { getCase, initEvidence, setSetting } from '../server/evidence.mjs';
import { openStore } from '../server/store.mjs';
import { initWorkbench } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';

const pm = { id: 'pm', name: 'ПМ', role: 'member' };
const peer = { id: 'peer', name: 'Коллега', role: 'member' };
const caseId = 'sales-signal';
const week = offset => new Date(Date.UTC(2026, 8, 7 + offset * 7)).toISOString().slice(0, 10);
const baselineFrom = week(0), baselineThrough = '2026-10-04', deployed = week(4);
const measurement = {
  metric: 'orders_index', control: 'Astra', baselineFrom, baselineThrough,
  comparison: 'gte', targetMode: 'baseline_percent', targetValue: 95,
};

function scenario(t, body = {}, product = 'Kaspersky') {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const { db } = store;
  initEvidence(db);
  initWorkbench(db);
  const signal = { revision: 1, status: 'confirmed', start: week(3), week: week(4), rule: 'relative', ...body.signal };
  db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)')
    .run(caseId, product, 'Снижение показателя', 'Исследуем', JSON.stringify({ ...body, signal }));
  syncInvestigations(db,caseId);
  const current = () => readInvestigations(db, pm, caseId).current;
  const ready = (runId = current().id) => {
    const capture = { context: { calculation: { metric: measurement.metric,
      baseline: { from: baselineFrom, through: baselineThrough }, findings: [{ product }, { product: 'Astra' }] } } };
    db.prepare("UPDATE case_investigations SET status='ready',result=?,capture=? WHERE id=?")
      .run(JSON.stringify({ plan: 'Проверить оформление' }), JSON.stringify(capture), runId);
    return runId;
  };
  const row = db.prepare("INSERT OR REPLACE INTO facts VALUES('sales',?,'test','Продажи.xlsx',?,?)");
  const sales = (product, i, orders_index) => row.run(product + '/' + i, product + '/' + i,
    JSON.stringify({ product_family: product, week_start: week(i), orders_index }));
  for (let i = 0; i < 4; i++) {
    sales('Kaspersky', i, 100);
    sales('Astra', i, 110);
  }
  const op = (name, input, user = pm) => workspaceOperation(store, user, name, { caseId, ...input });
  const agree = (input, user) => op('investigation-measurement', { expectedAgreementId: null, measurement, ...input }, user);
  const watch = (input, user) => op('watch', { deployed, ...input }, user);
  const get = () => getCase(db, caseId);
  const revise = (revision, status = 'confirmed') => {
    db.prepare("UPDATE cases SET body=json_set(body,'$.signal.revision',?,'$.signal.status',?) WHERE id=?")
      .run(revision, status, caseId);
    syncInvestigations(db,caseId);
  };
  return { agree, watch, current, ready, revise, get, sales, db };
}

test('an agreed rule, control and baseline are frozen before deployment and observations use that agreement', t => {
  const s = scenario(t);
  const runId = s.current().id;
  assert.throws(() => s.agree({ runId }), /готовое исследование/);
  s.ready(runId);
  assert.deepEqual(s.current().measurementContext, { baselineFrom, baselineThrough, control: 'Astra' });
  const agreed = s.agree({ runId });
  assert.equal(agreed.agreement.baseline.value, 100);
  assert.equal(agreed.agreement.controlBaseline.value, 110);
  assert.equal(agreed.agreement.target, 95);
  assert.equal(s.agree({ runId }).agreement.id, agreed.agreement.id);
  assert.equal(s.get().body.watch, undefined);
  assert.equal(s.get().state, 'Исследуем');

  const edit = { ...measurement, targetValue: 98 };
  assert.throws(() => s.agree({ runId, measurement: edit }), /уже обновлён/);
  const accepted = s.agree({ runId, expectedAgreementId: agreed.agreement.id, measurement: edit });
  assert.notEqual(accepted.agreement.id, agreed.agreement.id);
  setSetting(s.db, 'rules', { controlTolerance: 1, threshold: 25, recovery: 90 });
  s.sales('Kaspersky', 0, 500);
  assert.throws(() => s.watch({ agreementId: agreed.agreement.id }), /уже обновлён/);
  assert.throws(() => s.watch({ deployed: baselineThrough }), /до даты выкладки/);
  assert.throws(() => s.watch({ percent: 90, measurement }), /согласованный критерий/);
  assert.throws(() => s.watch({ metric: 'orders_index', baselineWeeks: 1, observationWeeks: 1 }), /согласованный критерий/);
  assert.equal(s.watch({ agreementId: accepted.agreement.id }).state, 'Ожидаем данные после исправления');
  const watch = s.get().body.watch;
  assert.equal(watch.target, 98);
  assert.equal(watch.baseline.value, 100);
  assert.equal(watch.controlBaseline.value, 110);
  assert.equal(watch.tolerance, 10);
  assert.throws(() => s.agree({ runId, expectedAgreementId: accepted.agreement.id }), /зафиксирован/);
  for (let i = 4; i < 8; i++) {
    s.sales('Kaspersky', i, 98);
    s.sales('Astra', i, 115);
  }
  assert.equal(s.watch().state, 'Цель достигнута');
  assert.deepEqual(s.get().body.watch, watch);
  s.revise(2);
  assert.equal(s.watch().target, 98);
});

test('a corrected signal requires fresh confirmation for a pending agreement', t => {
  const s = scenario(t);
  const first = s.ready();
  const { agreement } = s.agree({ runId: first });
  s.revise(2);
  assert.throws(() => s.watch(), /Сигнал уточнён/);
  assert.throws(() => s.agree({ runId: first, expectedAgreementId: agreement.id }), /текущей версии/);
  const current = s.ready();
  const next = s.agree({ runId: current, expectedAgreementId: agreement.id });
  assert.equal(next.agreement.signalRevision, 2);
  assert.notEqual(next.agreement.id, agreement.id);
  s.revise(3, 'withdrawn');
  assert.throws(() => s.watch(), /Сигнал уточнён/);
});

test('private alternatives cannot set a team agreement until published', t => {
  const s = scenario(t);
  const parentId = s.ready();
  const alt = createAlternative(s.db, pm, { caseId, parentId, question: 'Личное поручение', requestId: 'private' });
  s.ready(alt.id);
  assert.throws(() => s.agree({ runId: alt.id }), /Опубликуйте/);
  assert.throws(() => s.agree({ runId: alt.id }, peer), /готовое исследование/);
  assert.equal(s.get().body.plan, undefined);
  publishInvestigation(s.db, pm, { caseId, id: alt.id });
  assert.equal(s.agree({ runId: alt.id }, peer).agreement.runId, alt.id);
});

test('series, complete base and separate control are validated without replacing a manual plan', t => {
  const s = scenario(t);
  const runId = s.ready();
  assert.throws(() => s.agree({ runId, measurement: { ...measurement, product: 'Astra' } }), /ряд сигнала/);
  assert.throws(() => s.agree({ runId, measurement: { ...measurement, baselineThrough: undefined } }), /базового периода/);
  assert.throws(() => s.agree({ runId, measurement: { ...measurement, baselineThrough: week(5) } }), /базовый период/);
  assert.throws(() => s.agree({ runId, measurement: { ...measurement, control: 'Kaspersky' } }), /отдельный контрольный/);
  s.db.prepare("UPDATE cases SET body=json_set(body,'$.plan.measurement',json(?)) WHERE id=?")
    .run(JSON.stringify(measurement), caseId);
  assert.throws(() => s.agree({ runId }), /уже согласован/);
  assert.equal(s.watch().target, 95);
});

test('a ratio signal retains its device, source, definition and minimum denominator', t => {
  const signal = { metric: 'lk_reco_ctr', segment: 'desktop', sourceId: 'office:CTR', definitionId: 'visits',
    baselineFrom, baselineThrough, stepDays: 7, minDenominator: 100 };
  const s = scenario(t, { signal }, 'ЛК');
  const runId = s.ready();
  const row = s.db.prepare("INSERT INTO facts VALUES('metrics',?,'test','CTR.xlsx',?,?)");
  for (const segment of ['desktop', 'mobile']) {
    for (let i = 0; i < 8; i++) {
      const key = segment + '/' + i;
      row.run(key, key, JSON.stringify({ product: 'ЛК', metric_id: signal.metric, segment, source_id: signal.sourceId,
        definition_id: signal.definitionId, date: week(i), unit: 'ratio', step_days: 7, denominator: 100,
        numerator: segment === 'desktop' ? (i < 4 ? 4 : 5) : 90 }));
    }
  }
  const spec = { metric: signal.metric, baselineFrom, baselineThrough, comparison: 'gte', targetMode: 'absolute', targetValue: 5 };
  assert.throws(() => s.agree({ runId, measurement: { ...spec, segment: 'mobile' } }), /ряд сигнала/);
  assert.throws(() => s.agree({ runId, measurement: { ...spec, sourceId: 'another-source' } }), /ряд сигнала/);
  const approved = s.agree({ runId, measurement: spec });
  assert.equal(approved.measurement.segment, signal.segment);
  assert.equal(approved.measurement.sourceId, signal.sourceId);
  assert.equal(approved.measurement.definitionId, signal.definitionId);
  assert.equal(approved.measurement.minDenominator, signal.minDenominator);
  assert.deepEqual([approved.agreement.baseline.n, approved.agreement.baseline.d], [16, 400]);
  const result = s.watch({ agreementId: approved.agreement.id });
  assert.equal(result.actual, 5);
  assert.equal(result.state, 'Цель достигнута');
});
