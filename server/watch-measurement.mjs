import { aggregateMetric, defaultStepDays, observationWithin } from './metric-observations.mjs';

const day = 86400000;
const date = (ms) => new Date(ms).toISOString().slice(0, 10);
const ms = (s) => Date.parse(s + 'T00:00:00Z');
const monday = (t) => t - ((new Date(t).getUTCDay() + 6) % 7) * day;
const isDate = (s) => /^\d{4}-\d\d-\d\d$/.test(s) && Number.isFinite(ms(s)) && date(ms(s)) === s;
const units = { orders_index: 'п. индекса', lk_reco_ctr: '%', cfg_completion_rate: '%', cfg_reach_rate: '%' };
export const measuredSignal = (metric) => Object.hasOwn(units, metric) && metric !== 'orders_index';
export const legacyOrderMetric = (metric) =>
  !metric?.trim() || ['orders_index', 'family_orders_idx', 'индекс заказов'].includes(metric.trim().toLowerCase());

export function measurementSpec(input, product) {
  if (!Object.hasOwn(units, input.metric)) throw Error('Выберите поддерживаемую метрику проверки эффекта.');
  const spec = { ...input, product: input.product || product, segment: input.segment || 'all', unit: units[input.metric] };
  if (!spec.product) throw Error('Укажите продукт целевого ряда.');
  if (spec.metric === 'orders_index' && (spec.segment !== 'all' || spec.controlSegment && spec.controlSegment !== 'all'))
    throw Error('Индекс заказов доступен только для всех устройств.');
  if (spec.control && spec.control === spec.product && (spec.controlSegment || spec.segment) === spec.segment &&
    (spec.controlSourceId || spec.sourceId) === spec.sourceId)
    throw Error('Выберите отдельный контрольный ряд.');
  if (!spec.control && (spec.controlSegment || spec.controlSourceId || spec.controlDefinitionId))
    throw Error('Укажите продукт контрольного ряда.');
  if (spec.targetMode === 'absolute' && spec.unit === '%' && spec.targetValue > 100)
    throw Error('Введите целевое значение от 0 до 100 процентов.');
  if (spec.baselineFrom || spec.baselineThrough) {
    if (!isDate(spec.baselineFrom) || !isDate(spec.baselineThrough) || spec.baselineFrom > spec.baselineThrough)
      throw Error('Укажите начало и конец базового периода.');
  }
  return spec;
}

function measure(rows, spec, from, through, control = false, asOf) {
  const product = control ? spec.control : spec.product;
  const segment = control ? spec.controlSegment || spec.segment : spec.segment;
  const sourceId = control ? spec.controlSourceId || spec.sourceId : spec.sourceId;
  const definitionId = control
    ? spec.controlDefinitionId || (sourceId === spec.sourceId ? spec.definitionId : undefined)
    : spec.definitionId;
  const requiredStep = control ? spec.controlStepDays : spec.stepDays;
  const first = ms(from), last = ms(through);
  let sample, dates, step, value, reason, n, d, source, definition, counters;
  if (spec.metric === 'orders_index') {
    sample = rows.filter(r => r.product === product && !r.partial && r.week >= from &&
      ms(r.week) + 6 * day <= last && (!asOf || ms(r.week) + 6 * day <= ms(asOf)));
    dates = sample.map(r => r.week);
    step = 7;
    value = sample.length ? sample.reduce((sum, r) => sum + r.value, 0) / sample.length : null;
  } else {
    const all = rows.filter(r => !r.partial && !/неполн/i.test(r.comment || '') &&
      (!requiredStep || r.step_days === requiredStep) && (!asOf || observationWithin(r, from, asOf)));
    const a = aggregateMetric(all, spec.metric, { product, segment, sourceId, definitionId, from, through });
    ({ value, reason, n, d, dates = [], stepDays: step, sourceId: source } = a);
    sample = a.selectedRows || [];
    definition = sample[0]?.definition_id;
    const members = sample[0]?.combine_members;
    counters = source?.startsWith('group:') && Array.isArray(members) ? members.map(String).sort() : undefined;
    const expectedCounters = control ? spec.controlCounterIds : spec.counterIds;
    if (counters && expectedCounters && JSON.stringify(counters) !== JSON.stringify(expectedCounters))
      reason ||= 'Состав счётчиков отличается от базового окна.';
    const min = spec.minDenominator ?? 1;
    if (d > 0 && d < min) reason ||= 'Малый знаменатель за окно: ' + d + ' из ' + min + '.';
  }
  step ||= requiredStep || defaultStepDays(spec.metric);
  const distinct = new Set(dates), expectedDates = [];
  const firstDate = step === 7 ? monday(first) + (monday(first) === first ? 0 : 7 * day) : first;
  for (let t = firstDate; t + (step - 1) * day <= last; t += step * day) expectedDates.push(date(t));
  const available = expectedDates.filter(s => distinct.has(s)).length;
  if (!expectedDates.length || available !== expectedDates.length || !Number.isFinite(value))
    reason ||= 'Недостаточно данных выбранного ряда за полное окно.';
  return {
    value: reason ? null : value, n, d, reason: reason || undefined, available, expected: expectedDates.length,
    step, sourceId: source || sourceId, definitionId: definition || definitionId, counterIds: counters,
    sources: [...new Set(sample.map(r => r.evidenceSource || r.source).filter(Boolean))],
    versions: [...new Set(sample.map(r => r.version).filter(Boolean))],
  };
}

function validDeployment(deployed) {
  if (!isDate(deployed)) throw Error('Укажите действительную дату выкладки.');
}

export function startMeasurementWatch(plan, deployed) {
  validDeployment(deployed);
  if (plan.measurement.baselineThrough >= deployed) throw Error('База должна завершаться до даты выкладки.');
  return { ...plan, deployed };
}

export function planWatch(rows, spec, deployed, tolerance) {
  validDeployment(deployed);
  const priorMonday = monday(ms(deployed));
  const from = spec.baselineFrom || date(priorMonday - 28 * day);
  const through = spec.baselineThrough || date(priorMonday - day);
  if (through >= deployed) throw Error('База должна завершаться до даты выкладки.');
  return { ...prepareMeasurement(rows, { ...spec, baselineFrom: from, baselineThrough: through }, tolerance), deployed };
}

export function prepareMeasurement(rows, spec, tolerance, requireBaseline = false) {
  const { baselineFrom: from, baselineThrough: through } = spec;
  const baseline = measure(rows, spec, from, through);
  const controlBaseline = spec.control && measure(rows, spec, from, through, true);
  if (requireBaseline && baseline.value == null)
    throw Error('Недостаточно данных выбранного ряда за базовый период. ' + (baseline.reason || ''));
  const target = spec.targetMode === 'absolute' ? spec.targetValue :
    baseline.value != null && baseline.value > 0 ? baseline.value * spec.targetValue / 100 : null;
  if (target == null) throw Error('Недостаточно данных для ненулевой базы относительной цели.');
  if (controlBaseline && !(controlBaseline.value > 0))
    throw Error('Недостаточно данных для ненулевой базы выбранного контроля.');
  return { version: 2, target, control: spec.control, tolerance,
    measurement: { ...spec,
      sourceId: baseline.sourceId || spec.sourceId, controlSourceId: controlBaseline?.sourceId || spec.controlSourceId,
      definitionId: baseline.definitionId || spec.definitionId, controlDefinitionId: controlBaseline?.definitionId || spec.controlDefinitionId,
      stepDays: baseline.available ? baseline.step : spec.stepDays,
      controlStepDays: controlBaseline?.available ? controlBaseline.step : spec.controlStepDays,
      counterIds: spec.counterIds || baseline.counterIds, controlCounterIds: spec.controlCounterIds || controlBaseline?.counterIds },
    baseline, controlBaseline: controlBaseline || undefined };
}

export function watchKind(plan) {
  if (!plan) return null;
  if (plan.measurement) return 'measurement';
  if (plan.kind === 'archive-observation' || (plan.version === 2 &&
      typeof plan.metric === 'string' && Number.isInteger(plan.baselineWeeks) &&
      Number.isInteger(plan.observationWeeks))) return 'archive-observation';
  return 'legacy-percent';
}

export function measuredEffect(rows, watch, asOf) {
  const spec = watch.measurement;
  const first = ms(watch.deployed), wk = monday(first), start = date(wk === first ? wk : wk + 7 * day);
  const end = date(ms(start) + 27 * day);
  const sample = measure(rows, spec, start, end, false, asOf);
  const peer = spec.control ? measure(rows, spec, start, end, true, asOf) : undefined;
  const result = { start, end, unit: spec.unit, metric: spec.metric, target: watch.target, revision: watch.revision ?? 1,
    sample, peer: peer || undefined, weeks: Math.floor(sample.available * sample.step / 7),
    controlWeeks: peer ? Math.floor(peer.available * peer.step / 7) : 0 };
  if (sample.value == null || (peer && peer.value == null)) {
    const pending = watch.agreementId && (result.weeks < 4 || peer && result.controlWeeks < 4);
    return { ...result, actual: null, state: pending ? 'Ожидаем данные после исправления' : 'Недостаточно данных',
      reason: sample.reason || peer?.reason };
  }
  const ctrl = peer ? (peer.value / watch.controlBaseline.value - 1) * 100 : null;
  if (ctrl != null && Math.abs(ctrl) > watch.tolerance + 1e-9)
    return { ...result, actual: sample.value, ctrl, state: 'Изменился контроль — требуется проверка' };
  const achieved = spec.comparison === 'lte' ? sample.value <= watch.target + 1e-9 : sample.value >= watch.target - 1e-9;
  return { ...result, actual: sample.value, ctrl, state: achieved ? 'Цель достигнута' : 'Цель не достигнута' };
}
