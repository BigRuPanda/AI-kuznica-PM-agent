import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { importDocs, initEvidence } from '../server/evidence.mjs';
import { openStore } from '../server/store.mjs';
import { initWorkbench } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { seedWatchFormats } from './watch-fixture.mjs';

test('effect preview requires full comparable coverage and a linked rollout while watch persists the pending plan', t => {
  const store = openStore(':memory:');
  try {
    initEvidence(store.db);
    initWorkbench(store.db);
    const u = { id: 'product', role: 'member' };
    const env = { SOURCE_ARCHIVE_SHA256: 'archive' };
    const call = (op, body) => workspaceOperation(store, u, op, body, env);
    const insertCase = store.db.prepare("INSERT INTO cases VALUES(?,?,?,'Исследуем','{}')");
    insertCase.run('astra', 'Astra Linux Special Edition', 'Astra');
    insertCase.run('kaspersky', 'Kaspersky Endpoint Security', 'Kaspersky');
    const table = (kind, loc, row) => ({kind, loc, row});
    const samples = (first, value, loc) => Array.from({ length: 7 }, (_, i) => table('metrics', 'Metrics!A' + (loc + i), {
      metric_id: 'cfg_family_views', product: 'Конфигуратор Астра', segment: 'desktop', unit: 'visits',
      date: '2026-05-' + String(first + i).padStart(2, '0'), value,
    }));
    const release = (release_id, release_date, release_type, affected_metrics, related_task_ids = '') => ({
      release_id, release_date, release_type, affected_metrics, related_task_ids, status: 'выпущен',
      description: 'Конфигуратор Astra Linux',
    });
    importDocs(store, [{ file: 'Fixture.xlsx', facts: [
      table('dictionary', 'Dictionary!A2', { metric_id: 'cfg_family_views', metric_name: 'Визиты' }),
      table('dictionary', 'Dictionary!A3', { metric_id: 'cfg_add_to_cart_rate', metric_name: 'Добавления' }),
      table('backlog', 'Tasks!A2', {
        task_id: 'T-02', title: 'Astra', release_id: 'R-02', linked_metric_ids: 'cfg_family_views',
      }),
      table('backlog', 'Tasks!A3', {
        task_id: 'T-08', title: 'Kaspersky', linked_metric_ids: 'cfg_add_to_cart_rate',
      }),
      table('releases', 'Release!A2', release('R-02', '2026-05-12', 'minor', 'cfg_family_views', 'T-02')),
      table('releases', 'Release!A3', release('R-03', '2026-05-15', 'analytics', 'cfg_open')),
      ...samples(5, 10, 2), ...samples(13, 15, 9),
      table('metrics', 'Metrics!A16', {
        metric_id: 'cfg_family_views', product: 'Конфигуратор Kaspersky', segment: 'desktop',
        unit: 'visits', date: '2026-05-20', value: 8,
      }),
    ] }], { notify: false });
    const retro = {
      caseId: 'astra', taskId: 'T-02', releaseId: 'R-02', metric: 'cfg_family_views', segment: 'desktop',
      baselineWeeks: 1, observationWeeks: 1, asOf: '2026-05-19',
    };
    const report = call('effect-preview', retro);
    assert.deepEqual(call('watch-options', {caseId:'astra'}).examples.retro.releaseId, 'R-02');
    assert.deepEqual(call('watch-options', {caseId:'kaspersky'}).examples.cart.taskId, 'T-08');
    assert.equal(report.plan.target, null);
    assert.equal(report.actual, 15);
    assert.equal(report.change, 5);
    assert.equal(report.baseline.total, 70);
    assert.equal(report.observed.total, 105);
    assert.equal(report.baseline.sources.length, 7);
    assert.equal(report.observed.sources.length, 7);
    assert.equal(report.context[0].id, 'R-03');
    assert.equal(report.breaks.length, 0);
    assert.equal(store.one("SELECT body FROM cases WHERE id='astra'").body, '{}');
    assert.equal(call('effect-preview', { ...retro, asOf: '2026-05-18' }).actual, undefined);
    const longest = call('effect-preview', { ...retro, baselineWeeks: 12, observationWeeks: 12 });
    assert.equal(longest.baseline.expected, 84);
    assert.equal(longest.observed.expected, 84);
    for (const field of ['baselineWeeks', 'observationWeeks']) {
      for (const invalid of [0, 13]) {
        assert.throws(() => call('effect-preview', { ...retro, [field]: invalid }), new RegExp(field));
        assert.throws(() => call('watch', { ...retro, [field]: invalid }), new RegExp(field));
      }
    }

    const selected = call('watch', retro);
    assert.equal(selected.plan.kind, 'archive-observation');
    const saved = store.one("SELECT body FROM cases WHERE id='astra'").body;
    call('decide', { caseId: 'astra', state: 'Исследуем' });
    call('watch', retro);
    const resumed = store.one("SELECT state,body FROM cases WHERE id='astra'");
    assert.equal(resumed.state, 'Наблюдаем эффект');
    assert.equal(resumed.body, saved);
    assert.equal(call('effect-preview', { ...retro, asOf: '2026-05-18' }).actual, undefined);
    assert.equal(store.one("SELECT body FROM cases WHERE id='astra'").body, saved);
    importDocs(store, [{ file: 'Fixture.xlsx', facts: [
      table('releases', 'Release!A4', release('R-02', '2026-05-13', 'minor', 'cfg_family_views', 'T-02')),
    ] }], { notify: false });
    assert.deepEqual(call('view', {caseId:'astra'}).effect.plan, selected.plan);
    assert.equal(selected.plan.deployed, '2026-05-12');

    importDocs(store, [{ file: 'Change.xlsx', facts: [
      table('releases', 'Release!A2', release('R-08', '2026-05-18', 'infrastructure', 'cfg_family_views')),
    ] }], { notify: false });
    const interrupted = call('effect-preview', retro);
    assert.equal(interrupted.breaks[0].id, 'R-08');
    assert.equal(interrupted.actual, undefined);
    assert.equal(interrupted.change, undefined);

    const clock = t.mock.timers;
    clock.enable({ apis: ['Date'], now: new Date('2026-05-20T09:00:00Z') });
    const plan = { caseId: 'kaspersky', taskId: 'T-08', metric: 'cfg_add_to_cart_rate', segment: 'desktop' };
    const pending = call('watch', plan);
    assert.equal(pending.plan.deployed, null);
    assert.equal(pending.plan.releaseId, null);
    assert.equal(pending.checkAfter, undefined);
    assert.equal(pending.baseline, undefined);
    assert.match(pending.state, /Ожидаем/);
    assert.match(pending.plan.condition, /событием электронной торговли/);
    const savedPending = store.one("SELECT body FROM cases WHERE id='kaspersky'").body;
    call('watch', plan);
    assert.equal(store.one("SELECT body FROM cases WHERE id='kaspersky'").body, savedPending);
    assert.equal(JSON.parse(store.one("SELECT body FROM cases WHERE id='kaspersky'").body).watch.deployed, null);
    assert.throws(() => call('watch', { caseId: 'kaspersky', taskId: 'T-08', metric: 'cfg_add_to_cart_rate', deployed: '2026-05-12' }),
      /из журнала релизов/);
    clock.setTime(Date.parse('2026-06-03T09:00:00Z'));
    importDocs(store, [{ file: 'FollowUp.xlsx', facts: [
      table('backlog', 'Tasks!A2', { task_id: 'T-08', title: 'Kaspersky', release_id: 'R-09',
        linked_metric_ids: 'cfg_add_to_cart_rate' }),
      table('backlog', 'Tasks!A3', { task_id: 'T-09', title: 'Kaspersky', linked_metric_ids: 'cfg_add_to_cart_rate' }),
      table('releases', 'Release!A2', { ...release('R-09', '2026-06-02', 'minor', 'cfg_add_to_cart_rate', 'T-08'),
        description: 'Конфигуратор Kaspersky' }),
    ] }], { notify: false });
    const resolved = call('view', { caseId: plan.caseId }).effect;
    assert.equal(resolved.rollout.id, 'R-09');
    const edited = call('watch', { ...plan, target: 12 });
    assert.deepEqual(edited.rollout, resolved.rollout);
    assert.equal(edited.plan.scheduledOn, pending.plan.scheduledOn);
    assert.equal(edited.plan.sourceCursor, pending.plan.sourceCursor);
    assert.equal(edited.plan.target, 12);
    const different = call('watch', { ...plan, taskId: 'T-09', target: 12 });
    assert.equal(different.rollout, undefined);
    assert.equal(different.plan.scheduledOn, '2026-06-03');
    assert.ok(different.plan.sourceCursor > pending.plan.sourceCursor);
  } finally {
    store.close();
  }
});

test('both saved version 2 formats and the legacy target survive a restart and read-only preview', t => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-formats-'));
  const file = join(dir, 'watches.sqlite');
  const user = { id: 'fixture', role: 'admin' };
  let store;
  t.after(() => {
    store?.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  function open() {
    store = openStore(file);
    initEvidence(store.db);
    initWorkbench(store.db);
  }
  const call = (op, input) => workspaceOperation(store, user, op, input, {});
  function verify() {
    const results = {};
    for (const caseId of ['saved-percent', 'saved-measurement', 'saved-observation']) {
      const readBody = () => store.one('SELECT body FROM cases WHERE id=?', caseId).body;
      const savedBody = readBody();
      const { view, effect } = call('view', { caseId });
      const preview = call('effect-preview', { caseId, asOf: '2026-03-08' });
      assert.equal(readBody(), savedBody);
      assert.equal(preview.actual, effect.actual);
      results[caseId] = { kind: view.monitoring.kind, effect: { ...effect, asOf: undefined } };
    }
    assert.equal(results['saved-percent'].effect.actual, 110);
    assert.equal(results['saved-percent'].kind, undefined);
    assert.equal(results['saved-percent'].effect.state, 'Цель достигнута');
    const kpi = results['saved-measurement'].effect;
    assert.equal(results['saved-measurement'].kind, undefined);
    assert.deepEqual([kpi.actual, kpi.sample.n, kpi.sample.d], [6, 168, 2800]);
    const archive = results['saved-observation'].effect;
    assert.equal(results['saved-observation'].kind, 'archive-observation');
    assert.equal(archive.plan.kind, undefined);
    assert.equal(archive.state, 'Изменился контроль — требуется проверка');
    assert.equal(archive.control.baseline.value, 80);
    assert.equal(archive.control.observed.value, 100);
    assert.equal(archive.control.relativeChange, 25);
    assert.deepEqual([archive.control.baseline.sources[0].loc, archive.control.observed.sources[0].loc],
      ['Control!A4', 'Control!A6']);
    return results;
  }
  open();
  seedWatchFormats(store);
  const before = verify();
  const preview = (caseId, asOf) => call('effect-preview', { caseId, asOf });
  const legacy = preview('saved-percent', '2026-02-01');
  assert.equal(legacy.state, 'Ожидаем данные после исправления');
  assert.equal(legacy.actual, undefined);
  assert.deepEqual([legacy.weeks, legacy.controlWeeks], [0, 0]);
  assert.equal(preview('saved-percent', '2026-02-07').weeks, 0);
  assert.equal(preview('saved-percent', '2026-02-08').weeks, 1);
  assert.equal(preview('saved-percent', '2026-02-28').actual, undefined);
  assert.equal(preview('saved-percent', '2026-03-01').actual, 110);
  for (const caseId of ['saved-percent', 'saved-measurement', 'saved-observation']) {
    for (const invalid of ['', '2026-2-03', '2026-02-30', '2099-01-01'])
      assert.throws(() => preview(caseId, invalid), /дату оценки/i);
  }
  store.close();
  open();
  assert.deepEqual(verify(), before);
  const incomplete = call('effect-preview', { caseId: 'saved-observation', metric: 'orders_index', releaseId: 'R-02',
    baselineWeeks: 1, observationWeeks: 5, asOf: '2026-04-01' });
  assert.equal(incomplete.observed.count, 4);
  assert.equal(incomplete.observed.expected, 5);
  assert.match(incomplete.state, /Недостаточно сопоставимых наблюдений/);
});

test('archive watches require complete periods from one comparable series before notifying', async t => {
  const invalidRows = {
    partial: i => i === 3 ? { partial: true } : {},
    cadence: i => i === 3 ? { step_days: 7 } : {},
    mixed: i => i === 3 ? { source_id: 'alternate' } : {},
    switched: () => ({ definition_id: 'updated' }),
  };
  for (const [variant, override] of Object.entries(invalidRows)) await t.test(variant, async t => {
    const dir = mkdtempSync(join(tmpdir(), 'archive-watch-'));
    const env = { SOURCE_ARCHIVE_SHA256: 'fixture', NOTIFICATION_CHANNELS: 'smtp' };
    const app = createTeamApp({ base: join(dir, 'watches.sqlite'), env, background: false });
    t.after(async () => {
      await app.close();
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
    });
    const store = app.space('team');
    const product = 'Astra Linux', metric = 'cfg_family_views';
    const samples = (start, value, overrides) => Array.from({ length: 7 }, (_, i) => ({
      kind: 'metrics', loc: 'Metrics!A' + (start + i), row: { product, metric_id: metric, segment: 'desktop',
        unit: 'visits', date: '2026-05-' + String(start + i).padStart(2, '0'), value, ...overrides?.(i) },
    }));
    importDocs(store, [{ file: 'Archive.xlsx', facts: [
      { kind: 'dictionary', loc: 'Metrics!B2', row: { metric_id: metric, metric_name: 'Визиты' } },
      { kind: 'releases', loc: 'Releases!A2', row: { release_id: 'R-02', release_date: '2026-05-12',
        description: product, status: 'выпущен', release_type: 'minor', affected_metrics: metric } },
      ...samples(5, 10), ...samples(13, 20, override),
    ] }], { notify: false });
    store.db.prepare("INSERT INTO cases VALUES('archive',?,?,'Исследуем','{}')").run(product, 'Наблюдение');
    const user = { id: 'admin', role: 'admin' };
    const watch = workspaceOperation(store, user, 'watch', {
      caseId: 'archive', metric, segment: 'desktop', releaseId: 'R-02', baselineWeeks: 1, observationWeeks: 1,
      target: 15,
    }, env);
    assert.equal(watch.baseline.value, 10);
    assert.equal(watch.actual, undefined);
    assert.equal(watch.state, 'Недостаточно сопоставимых наблюдений');
    if (variant === 'mixed') assert.equal(watch.reason, 'В окне есть строки из разных рядов.');
    if (variant === 'switched') assert.equal(watch.reason, 'До и после выкладки использованы разные ряды.');
    await app.tick();
    assert.equal(store.one("SELECT state FROM cases WHERE id='archive'").state, 'Наблюдаем эффект');
    assert.equal(store.one('SELECT count(*) AS n FROM deliveries').n, 0);
  });
});

test('background calculation dispatches all three watch formats and queues each due result once', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'watch-queue-'));
  const start = () => createTeamApp({
    base: join(dir, 'watches.sqlite'), background: false,
    env: { NOTIFICATION_CHANNELS: 'smtp', NOTIFICATIONS_ENABLED: 'false' },
  });
  let app = start();
  t.after(async () => {
    await app.close();
    rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  let store = app.space('team');
  seedWatchFormats(store);
  const rows = () => store.db.prepare(
    "SELECT body FROM deliveries ORDER BY json_extract(body,'$.caseId')",
  ).all().map(row => JSON.parse(row.body));
  const expected = ['saved-measurement', 'saved-observation', 'saved-percent'];
  await Promise.all([app.tick(), app.tick(), app.tick()]);
  assert.deepEqual(rows().map(row => row.caseId), expected);
  assert.equal(rows().find(row => row.caseId === 'saved-observation').awaitingOwner, true);
  assert.equal(rows().find(row => row.caseId === 'saved-percent').awaitingOwner, undefined);
  for (const id of expected) assert.equal(store.one('SELECT state FROM cases WHERE id=?', id).state, 'Нужно решение');
  await app.close();
  app = start();
  store = app.space('team');
  await app.tick();
  assert.deepEqual(rows().map(row => row.caseId), expected);
});
