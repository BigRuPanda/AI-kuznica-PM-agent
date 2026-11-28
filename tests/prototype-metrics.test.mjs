import assert from 'node:assert/strict';
import test from 'node:test';
import '../prototype/metrics.js';

const { DAY, snapshot } = globalThis.releaseMetrics;

test('mixed views remain in the first invoice cohort and the matching segment and day', () => {
  const invoice = (id, segment, firstVersion, issuedDay, paidDay, secondViewDay) => {
    const issued = issuedDay * DAY;
    const paid = paidDay == null ? null : paidDay * DAY;
    const secondView = secondViewDay == null ? null : secondViewDay * DAY;
    return [segment, issued, issued, paid, paid === null ? 0 : 250,
      null, null, firstVersion, issued, secondView, id];
  };
  const release = { orders: [
    invoice('invoice-a', 'new', 'old', 0, 2, 1),
    invoice('invoice-b', 'returning', 'old', 1),
    invoice('invoice-c', 'returning', 'new', 1, null, 2),
    invoice('invoice-d', 'new', 'new', 2, 3),
    invoice('invoice-e', 'returning', 'new', 3, 5),
  ] };
  const result = snapshot(release, 'all', 14);
  for (const [row, paid, total, both] of [
    [result.after[1], 3, 5, ['invoice-a', 'invoice-c']],
    [result.byVersion.old.after[1], 1, 2, ['invoice-a']],
    [result.byVersion.new.after[1], 2, 3, ['invoice-c']],
  ]) {
    assert.deepEqual([row.n, row.d, row.bothViews.map(order => order[10])], [paid, total, both]);
  }
  for (const [segment, both, day] of [['new', 'invoice-a', 0], ['returning', 'invoice-c', 1]]) {
    const slice = snapshot(release, segment, 14);
    assert.deepEqual(slice.after[1].bothViews.map(order => order[10]), [both]);
    assert.deepEqual(slice.daily.flatMap((rows, i) => rows[1].bothViews.map(order => [slice.days[i], order[10]])),
      [[day, both]]);
  }
});

test('only a known second version seen by the cutoff and before payment is marked', () => {
  function analyse(second, paid, day, first = 'old') {
    const order = ['new', 0, 0, paid, 100, null, null, first, DAY / 2, second, 'invoice-test'];
    return snapshot({ orders: [order] }, 'all', day);
  }
  assert.equal(analyse(2 * DAY, 3 * DAY, 1).after[1].bothViews.length, 0);
  assert.equal(analyse(2 * DAY, 3 * DAY, 2).after[1].bothViews.length, 1);
  assert.equal(analyse(2 * DAY, null, 2, 'new').byVersion.new.after[1].bothViews.length, 1);
  assert.equal(analyse(2 * DAY, DAY, 14).after[1].bothViews.length, 0);
  assert.equal(analyse(2 * DAY, 2 * DAY, 14).after[1].bothViews.length, 0);
  assert.equal(analyse(null, null, 14).after[1].bothViews.length, 0);
});
