import { createMeasurementWatch, importDocs } from '../server/evidence.mjs';
import { measurementSpec } from '../server/watch-measurement.mjs';

const week = index => new Date(Date.UTC(2026, 0, 5 + 7 * index)).toISOString().slice(0, 10);
const product = 'Astra Linux';
const peer = 'Kaspersky';

export function seedWatchFormats(store) {
  const deployed = week(4);
  const rows = Array.from({ length: 8 }, (_, index) => {
    const clicks = index < 4 ? 14 : 42;
    return [
      { kind: 'sales', loc: 'Astra!A' + (index + 2), row: {
        product_family: product, week_start: week(index), orders_index: index < 4 ? 90 : 110,
      } },
      { kind: 'sales', loc: 'Control!A' + (index + 2), row: {
        product_family: peer, week_start: week(index), orders_index: index < 4 ? 80 : 100,
      } },
      { kind: 'metrics', loc: 'CTR!A' + (index + 2), row: {
        metric_id: 'lk_reco_ctr', product: 'ЛК', date: week(index), unit: 'ratio', segment: 'desktop',
        value: clicks / 700, detail_json: JSON.stringify({ click_visits: clicks, viewed_visits: 700 }),
      } },
    ];
  }).flat();
  rows.push({ kind: 'releases', loc: 'Releases!A2', row: {
    release_id: 'R-02', release_date: '2026-01-28', description: product,
    status: 'выпущен', release_type: 'minor', affected_metrics: 'family_orders_idx',
  } });
  importDocs(store, [{ file: 'SavedWatches.xlsx', facts: rows }], { notify: false });
  const measurement = measurementSpec({
    metric: 'lk_reco_ctr', product: 'ЛК', segment: 'desktop',
    comparison: 'gte', targetMode: 'absolute', targetValue: 5,
  }, 'ЛК');
  const insert = store.db.prepare("INSERT INTO cases VALUES(?,?,?,'Наблюдаем эффект',?)");
  insert.run('saved-percent', product, 'Прежняя процентная цель', JSON.stringify({ watch: {
    deployed, target: 100, control: peer, controlBase: 100, tolerance: 10,
  } }));
  insert.run('saved-measurement', 'ЛК', 'Сохранённая проверка KPI', JSON.stringify({
    watch: createMeasurementWatch(store.db, measurement, deployed),
  }));
  insert.run('saved-observation', product, 'Сохранённое архивное наблюдение', JSON.stringify({ watch: {
    version: 2, metric: 'orders_index', title: 'Индекс самостоятельных заказов', segment: 'all',
    deployed: '2026-01-28', releaseId: 'R-02', taskId: null, baselineWeeks: 1, observationWeeks: 1,
    target: 100, direction: 'at-least', condition: 'Уточнить причину изменения контроля',
    control: peer, controlTolerance: 10,
  } }));
}
