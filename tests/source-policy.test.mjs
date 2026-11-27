import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../server/store.mjs';
import { digest, initEvidence } from '../server/evidence.mjs';
import { approveSource, importApproved, initSourcePolicy, protectedSources, sourceHistory, sourcePermission } from '../server/source-policy.mjs';

const archive = Buffer.from('pinned original archive fixture');
const sha = digest(archive);
const first = 'finance.xlsx';
const second = 'metrics.xlsx';
const report = (file, keys) => ({ file, facts: keys.map((metric_id, i) => ({
  kind: 'metrics', loc: 'Метрики!A' + (i + 2), row: { metric_id, date:'2026-06-01', product:'Astra', segment:'all', value:i },
})) });

function fixture(t) {
  const store = openStore(':memory:', { seedDemo: false });
  initEvidence(store.db);
  initSourcePolicy(store.db);
  t.after(() => store.close());
  const permission = sourcePermission(store.db, sha, archive, 'original.zip');
  importApproved(store, [report(first, ['visits']), report(second, ['cart'])], permission, false);
  return store;
}

test('approved source cannot replace another source’s records or drop records from the current version', t => {
  const store = fixture(t);
  const current = protectedSources(store.db).find(row => row.file === second);
  const snapshot = () => store.db.prepare('SELECT * FROM facts ORDER BY kind,key').all();
  const before = snapshot();
  for (const [tag, keys, error] of [
    ['collision', ['cart', 'visits'], /другому источнику/],
    ['omission', ['retention'], /пропускает записи/],
    ['duplicate', ['cart', 'cart'], /повторяется/],
  ]) {
    const input = Buffer.from(tag);
    approveSource(store, {sha:digest(input), file:second, origin:'Approved by the organizer', previous:current.version}, 'Admin', sha);
    const permission = sourcePermission(store.db, sha, input, second);
    assert.throws(() => importApproved(store, [report(second, keys)], permission, false), error);
    assert.deepEqual(snapshot(), before);
    assert.equal(sourceHistory(store.db, second).length, 1);
  }
});

test('raw archive and reviewed revision replays cannot change the current source', t => {
  const store = fixture(t);
  const upload = (name, input, docs) => importApproved(store, docs, sourcePermission(store.db, sha, input, name), false);
  const old = sourceHistory(store.db, first)[0];
  const previous = old.version;
  const revised = Buffer.from('reviewed snapshot fixture');
  approveSource(store, {sha:digest(revised), file:first, origin:'Updated list', previous}, 'Admin', sha);
  assert.equal(upload(first, revised, [report(first, ['visits', 'conversion'])]).inserted, 1);
  const [head, baseline] = sourceHistory(store.db, first);
  assert.deepEqual(baseline, {...old, active:false});
  assert.equal(head.author, 'Admin');
  assert.equal(head.active, true);
  assert.equal(upload('original.zip', archive, []).inserted, 0);
  assert.equal(upload(first, revised, []).inserted, 0);
  assert.equal(sourceHistory(store.db, first)[0].version, head.version);
  assert.throws(() => upload(first, archive, []), /согласованную администратором/);
});
