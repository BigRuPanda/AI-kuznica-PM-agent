import { createHash } from 'node:crypto';

const DAY = 86400000;
const weekly = new Set(['orders_index', 'family_orders_idx', 'cfg_option_share', 'cfg_step_dropoff', 'lk_reco_ctr']);
const devices = new Set(['desktop', 'mobile', 'tablet']);
const counts = new Set(['count', 'visits', 'views', 'events']);
export const ratioFields = {
  lk_reco_ctr: ['click_visits', 'viewed_visits'],
  cfg_reach_rate: ['configurator_visits', 'family_visits'],
  cfg_completion_rate: ['complete', 'open'],
  cfg_back_reset_rate: ['back', 'open'],
  cfg_add_to_cart_rate: ['add_to_cart', 'open'],
};
export const defaultStepDays = (metric) => weekly.has(metric) ? 7 : 1;
export const reportDefinition = (...parts) =>
  createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 20);

export function observationWithin(row, from, through) {
  if (from && row.date < from) return false;
  if (!through) return true;
  const step = row.step_days || defaultStepDays(row.metric_id);
  const end = Date.parse(row.date) + (step - 1) * DAY;
  return end <= Date.parse(through);
}

export function normalizeObservation(row, file) {
  const details = typeof row.detail_json === 'string' ? JSON.parse(row.detail_json) : row.detail_json || {};
  const counter = row.counter_id || details.counter;
  const api = !!counter;
  const pair = ratioFields[row.metric_id] || [];
  const query = api ? new URLSearchParams(details.query) : null;
  const oldDimCount = query?.get('dimensions')?.split(',').length || 1;
  return {
    ...row,
    ...(row.detail_json && typeof row.detail_json !== 'string' && {detail_json: JSON.stringify(details)}),
    source_id: row.source_id || (api ? 'metrika:' + counter + ':' + row.metric_id : 'office:' + file),
    counter_id: counter ? String(counter) : null,
    ...(api && { dimensions: row.dimensions || (oldDimCount === 1 ? [] :
      oldDimCount === 2 ? [row.segment] : row.segment.split('/')) }),
    step_days: row.step_days || (api ? (query.get('dimensions')?.split(',')[0] === 'ym:s:startOfWeek' ? 7 : 1) : defaultStepDays(row.metric_id)),
    definition_id: row.definition_id || (api ? reportDefinition(query.get('metrics'), query.get('dimensions'), query.get('filters') || '', row.unit) : 'office'),
    numerator: row.numerator ?? details[pair[0]] ?? null,
    denominator: row.denominator ?? details[pair[1]] ?? null,
  };
}

export function observationKey(row) {
  return JSON.stringify([row.source_id, row.definition_id, row.metric_id, row.product, row.dimensions || row.segment,
    row.date, row.step_days]);
}

export function metricSeriesChoices(rows) {
  const series = new Map();
  for (const r of rows) {
    for (const sourceId of [r.source_id, r.combine_group].filter(Boolean)) {
      const choice = { metric: r.metric_id, product: r.product, segment: r.segment || 'all', sourceId,
        definitionId: r.definition_id, stepDays: r.step_days, unit: r.unit };
      series.set(JSON.stringify(choice), choice);
    }
  }
  return [...series.values()];
}

export function describeMetricSeries({ product, segment, sourceId, definitionId, stepDays }) {
  const period = stepDays === 7 ? 'неделя' : stepDays === 1 ? 'день' : undefined;
  return [sourceId, product, segment, period, definitionId].filter(Boolean).join(' / ');
}

export function aggregateMetric(rows, metric, { product, segment, from, through, sourceId, definitionId } = {}) {
  const combined = sourceId?.startsWith('group:');
  let selected = rows.filter((r) => r.metric_id === metric && (!product || r.product === product) &&
    (!sourceId || (combined ? r.combine_group === sourceId : r.source_id === sourceId)) && (!definitionId || r.definition_id === definitionId) &&
    (!segment || segment === 'all' || r.segment === segment) && observationWithin(r, from, through));
  const empty = { n: null, d: null, value: null, reason: '', selectedRows: [], dates: [], observations: 0, stepDays: null, sourceId: null, choices: [] };
  if (!selected.length) return { ...empty, reason: 'Нет наблюдений за выбранный период.' };
  const choices = metricSeriesChoices(selected);
  const origins = new Set(selected.map(r => JSON.stringify([combined ? r.combine_members : r.source_id,
    r.definition_id, r.product, r.step_days, r.unit])));
  if (origins.size !== 1) return { ...empty, choices,
    reason: 'Выберите один источник, продукт и определение показателя. Ряды: ' + choices.slice(0, 8).map(describeMetricSeries).join('; ') };
  if (!segment || segment === 'all') {
    const originDate = r => JSON.stringify([r.source_id, r.date]);
    const totals = new Set(selected.filter(r => r.segment === 'all' || !r.segment).map(originDate));
    selected = selected.filter(r => totals.has(originDate(r)) ? r.segment === 'all' || !r.segment : devices.has(r.segment));
  }
  if (!selected.length) return { ...empty, choices,
    reason: 'Общий ряд отсутствует. Выберите сегмент: ' + choices.slice(0, 8).map(describeMetricSeries).join('; ') };
  const dates = [...new Set(selected.map(r => r.date))].sort();
  const first = selected[0];
  const result = { ...empty, dates, observations: selected.length, selectedRows: selected,
    stepDays: first.step_days || defaultStepDays(metric), sourceId: combined ? sourceId : first.source_id || null,
    definitionId: first.definition_id, combineMembers: combined ? first.combine_members : undefined };
  if (combined) {
    const byDate = new Map(dates.map(d => [d, new Set()]));
    for (const r of selected) byDate.get(r.date).add(r.counter_id);
    if (!Array.isArray(first.combine_members) || [...byDate.values()].some(members =>
      first.combine_members.some(id => !members.has(id)) || members.size !== first.combine_members.length))
      return { ...result, reason: 'В периоде отсутствуют наблюдения одного из счётчиков группы.' };
  }
  if (first.unit === 'ratio' || ratioFields[metric]) {
    const pair = ratioFields[metric] || [];
    let n = 0, d = 0;
    for (const r of selected) {
      const detail = r.numerator == null || r.denominator == null ?
        (typeof r.detail_json === 'string' ? JSON.parse(r.detail_json) : r.detail_json || r.details || {}) : {};
      const a = r.numerator ?? detail[pair[0]], b = r.denominator ?? detail[pair[1]];
      if (!Number.isFinite(a) || !Number.isFinite(b) || a < 0 || b < 0 || a > b)
        return { ...result, reason: 'Для доли отсутствует корректный числитель или знаменатель.' };
      n += a; d += b;
    }
    return { ...result, n, d, value: d ? (100 * n) / d : null, reason: d ? '' : 'Знаменатель равен нулю.' };
  }
  if (!selected.every(r => Number.isFinite(r.value))) return { ...result, reason: 'В ряду пропущено значение.' };
  if (selected.length === 1) return { ...result, value: first.value };
  if (counts.has(first.unit)) return { ...result, value: selected.reduce((a, r) => a + r.value, 0) };
  return { ...result, reason: 'Для объединения этих наблюдений требуется формула показателя.' };
}
