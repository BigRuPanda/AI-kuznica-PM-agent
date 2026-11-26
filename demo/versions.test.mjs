import assert from 'node:assert/strict';
import test from 'node:test';
import '../prototype/data.js';
import '../prototype/metrics.js';

const {DAY, snapshot} = globalThis.releaseMetrics;
test('mixed views are a subset of the original invoice cohorts', () => {
  const result = snapshot(globalThis.releaseDemo['R-002'], 'all', 14);
  for (const [row, paid, total, both] of [
    [result.after[1], 110, 200, 20],
    [result.byVersion.old.after[1], 62, 120, 12],
    [result.byVersion.new.after[1], 48, 80, 8]
  ]) {
    assert.deepEqual([row.n, row.d, row.bothViews.length], [paid, total, both]);
    assert.equal(new Set(row.bothViews.map(order => order[10])).size, both);
  }
  for (const segment of ['new', 'returning']) {
    const slice = snapshot(globalThis.releaseDemo['R-002'], segment, 14);
    assert.equal(slice.after[1].bothViews.length, 10);
    assert.equal(slice.daily.reduce((n, rows) => n + rows[1].bothViews.length, 0), 10);
  }
});

test('only a known second version seen before payment is marked', () => {
  function analyse(second, paid, day, first='old') {
    const order = ['new', 0, 0, paid, 100, null, null, first, DAY/2, second, 'example'];
    return snapshot({orders:[order]}, 'all', day);
  }
  assert.equal(analyse(2*DAY, 3*DAY, 1).after[1].bothViews.length, 0);
  assert.equal(analyse(2*DAY, 3*DAY, 2).after[1].bothViews.length, 1);
  assert.equal(analyse(2*DAY, null, 2, 'new').byVersion.new.after[1].bothViews.length, 1);
  assert.equal(analyse(2*DAY, DAY, 14).after[1].bothViews.length, 0);
  assert.equal(analyse(2*DAY, 2*DAY, 14).after[1].bothViews.length, 0);
  assert.equal(analyse(null, null, 14).after[1].bothViews.length, 0);
});
