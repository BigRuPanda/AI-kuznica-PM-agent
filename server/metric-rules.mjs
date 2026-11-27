import { facts, productFamily, setting, setSetting } from './evidence.mjs';
import { aggregateMetric, defaultStepDays } from './metric-observations.mjs';

const DAY = 86400000;
const WEEK = 7 * DAY;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);
const monday = (ms) => ms - (new Date(ms).getUTCDay() + 6) % 7 * DAY;
const settingsKey = 'metric_signal_rules';
const specs = {
  lk_reco_ctr: { title: 'CTR рекомендаций ЛК', product: 'ЛК', unit: '%', threshold: 30, minDenominator: 100, minBaselineNumerator: 10 },
  cfg_completion_rate: { title: 'Завершение подбора Astra', product: 'Конфигуратор Астра', unit: 'п.п.', threshold: 5, minDenominator: 30, minBaselineNumerator: 0 },
};

function configs(db) {
  const saved = setting(db, settingsKey, {});
  return Object.entries(specs).map(([metric, spec]) => ({
    metric, product: spec.product, threshold: spec.threshold, minDenominator: spec.minDenominator,
    minBaselineNumerator: spec.minBaselineNumerator, segment: 'all', sourceId: '', releaseId: '',
    confirmations: 2, enabled: true, ...saved[metric],
  }));
}

export function saveMetricRule(db, input) {
  if (!Object.hasOwn(specs, input.metric)) throw Error('Выберите поддерживаемую метрику.');
  const config = {...configs(db).find((rule) => rule.metric === input.metric)};
  for (const key of ['product','segment','sourceId','releaseId']) {
    if (input[key] === undefined) continue;
    if (typeof input[key] !== 'string' || input[key].length > 400) throw Error('Проверьте параметры ряда.');
    config[key] = input[key].trim();
  }
  if (!config.product || !config.segment) throw Error('Укажите продукт и сегмент.');
  if (config.metric === 'cfg_completion_rate' && productFamily(config.product) !== 'astra')
    throw Error('Завершение пошагового подбора измеряется для Astra.');
  for (const [key, min, max] of [
    ['threshold',0.000001,100], ['minDenominator',1,1e9], ['minBaselineNumerator',0,1e9], ['confirmations',1,12],
  ]) {
    if (input[key] === undefined) continue;
    const v = input[key];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (key !== 'threshold' && !Number.isInteger(v)))
      throw Error('Проверьте порог и объём наблюдений.');
    config[key] = v;
  }
  if (input.enabled !== undefined) {
    if (typeof input.enabled !== 'boolean') throw Error('Проверьте состояние правила.');
    config.enabled = input.enabled;
  }
  if (config.releaseId && !facts(db,'releases').some(f => f.data.release_id === config.releaseId))
    throw Error('Выберите релиз из загруженного календаря.');
  setSetting(db, settingsKey, {...setting(db,settingsKey,{}), [config.metric]:config});
  return config;
}

function readInputs(db) {
  const rows = facts(db,'metrics').filter(f => Object.hasOwn(specs, f.data.metric_id))
    .map(({data,file,loc,version}) => ({...data, source: file + ' · ' + loc, file, loc, version}));
  return {rows, releases: facts(db,'releases').map(f => f.data)};
}

function weekEvidence(week, sample) {
  return {
    week, n: sample.n, d: sample.d,
    rows: sample.selectedRows.map(r => ({ date:r.date, segment:r.segment, n:r.numerator, d:r.denominator,
      sourceId:r.source_id, source:r.source, file:r.file, loc:r.loc, version:r.version })),
  };
}

function measureWeek(rows, rule, start) {
  const from = iso(start), through = iso(start + 6 * DAY);
  const result = aggregateMetric(rows, rule.metric, {...rule, from, through});
  if (result.reason) return result;
  const partial = result.selectedRows.some(r => r.partial || /неполн/i.test(r.comment || ''));
  const complete = result.stepDays === 7
    ? result.dates.length === 1 && result.dates[0] === from
    : result.stepDays === 1 && result.dates.length === 7;
  if (partial || !complete) return {...result, reason: 'Неполное покрытие недели ' + from + '.'};
  if (result.d < rule.minDenominator)
    return {...result, reason: 'Малый знаменатель за неделю ' + from + ': ' + result.d + ' из ' + rule.minDenominator + '.'};
  const first = result.selectedRows[0];
  const members = rule.sourceId.startsWith('group:') ? first.combine_members : null;
  return {...result, seriesDefinition:JSON.stringify([result.sourceId, first.definition_id, first.unit, result.stepDays, members])};
}

function evaluateRelease(rule, inputs, release, asOf) {
  const spec = specs[rule.metric], episodes = [];
  const outcome = (status, detail, week = '') => ({config: rule, title: spec.title, unit: spec.unit, status, detail, week,
    releaseId: release?.release_id, episodes});
  if (!rule.enabled) return outcome('disabled','Правило выключено.');
  if (!release) return outcome('insufficient','Выберите релиз для четырёхнедельной базы.');
  const releaseDay = Date.parse(release.release_date);
  if (!Number.isFinite(releaseDay) || release.release_date > asOf) return outcome('insufficient','Ожидаем подтверждённую дату выкладки.');
  const pivot = monday(releaseDay), baselineFrom = iso(pivot - 4 * WEEK), baselineThrough = iso(pivot - DAY);
  const after = pivot === releaseDay ? pivot : pivot + WEEK;
  const rows = inputs.rows.filter(r => r.metric_id === rule.metric && r.product === rule.product &&
    (rule.segment === 'all' || r.segment === rule.segment) &&
    (!rule.sourceId || r.source_id === rule.sourceId || r.combine_group === rule.sourceId));
  if (!rows.length) return outcome('insufficient','Нет наблюдений для выбранного продукта, источника и сегмента.');
  const origin = new Set(rows.filter(r => r.date >= baselineFrom && r.date <= asOf).map(r => r.source_id || ''));
  if (origin.size > 1 && !rule.sourceId) return outcome('insufficient','Выберите один источник наблюдений.');
  const baseline = [];
  for (let i = 4; i > 0; i--) {
    const week = measureWeek(rows, rule, pivot - i * WEEK);
    if (week.reason) return outcome('insufficient','База ' + baselineFrom + ' — ' + baselineThrough + '. ' + week.reason);
    baseline.push({...week, week:iso(pivot - i * WEEK)});
  }
  const seriesDefinition = baseline[0].seriesDefinition;
  if (baseline.some(w => w.seriesDefinition !== seriesDefinition))
    return outcome('insufficient','Определение метрики, частота или состав счётчиков менялись внутри базы.');
  const baseN = baseline.reduce((sum,w) => sum + w.n, 0), baseD = baseline.reduce((sum,w) => sum + w.d, 0);
  const baseValue = baseN / baseD * 100;
  if (baseN < rule.minBaselineNumerator || (!baseN && spec.unit === '%'))
    return outcome('insufficient','В базовом окне недостаточно целевых событий для сравнения (' + baseN + ').');
  const lastObservation = rows.reduce((end, r) =>
    Math.max(end, Date.parse(r.date) + ((r.step_days || defaultStepDays(rule.metric)) - 1) * DAY), -Infinity);
  const end = Math.min(Date.parse(asOf), lastObservation);
  let episode, last = outcome('insufficient','Ожидаем полную неделю после релиза.');
  for (let start = after; start <= end; start += WEEK) {
    const week = iso(start);
    const sample = measureWeek(rows, rule, start);
    if (start + 6 * DAY > end || sample.reason || sample.seriesDefinition !== seriesDefinition) {
      last = outcome('insufficient', start + 6 * DAY > end ? 'Неделя ещё не закрыта.' : sample.reason ||
        'Определение метрики, частота или состав счётчиков отличаются от базы.', week);
      episode = undefined;
      continue;
    }
    const change = spec.unit === '%' ? (sample.value - baseValue) / baseValue * 100 : sample.value - baseValue;
    if (change >= -rule.threshold - 1e-10) {
      last = outcome('ok','Отклонение в пределах порога.',week);
      episode = undefined;
      continue;
    }
    if (!episode) {
      const seriesKey = JSON.stringify([rule.product, rule.segment, sample.sourceId, release.release_id]);
      episode = {product:rule.product, metric:rule.metric, rule:'metric:' + rule.metric, seriesKey, start:week,
        releaseId:release.release_id, segment:rule.segment, sourceId:sample.sourceId, definitionId:sample.selectedRows[0].definition_id,
        stepDays:sample.stepDays, counterIds:sample.sourceId?.startsWith('group:')
          ? sample.selectedRows[0].combine_members?.map(String).sort() : undefined, baselineFrom,baselineThrough,
        baseN,baseD,baseValue, threshold:rule.threshold, changeUnit:spec.unit, minDenominator:rule.minDenominator,
        title:'Снижение показателя «' + spec.title + '» · ' + rule.segment, history:[],count:0};
      episode.evidence = { baseline:baseline.map(sample => weekEvidence(sample.week, sample)) };
      episodes.push(episode);
    }
    episode.count++;
    Object.assign(episode, {week,value:sample.value,n:sample.n,d:sample.d,change,source:sample.selectedRows.at(-1).source});
    episode.evidence.latest = weekEvidence(week, sample);
    episode.history.push({week,value:sample.value,n:sample.n,d:sample.d,change});
    if (episode.count === rule.confirmations) episode.confirmedWeek = week;
    last = episode.confirmedWeek
      ? outcome('confirmed','Порог превышен. Отклонение подтверждено.',week)
      : outcome('preliminary','Предварительное отклонение (' + episode.count + ' из ' + rule.confirmations + ' недель).',week);
  }
  return last;
}

function evaluate(rule, inputs, asOf) {
  if (rule.releaseId) return evaluateRelease(rule, inputs, inputs.releases.find(r => r.release_id === rule.releaseId), asOf);
  const releases = inputs.releases.filter(r => r.release_date <= asOf &&
    String(r.affected_metrics || '').split(/[,;\s]+/).includes(rule.metric))
    .sort((a,b) => a.release_date.localeCompare(b.release_date) || a.release_id.localeCompare(b.release_id));
  if (!releases.length) return evaluateRelease(rule, inputs, null, asOf);
  // Bound earlier episodes at the next release so a new rollout keeps the original signal history.
  const spans = releases.map((release, i) => evaluateRelease(rule, inputs, release,
    releases[i+1] ? iso(Date.parse(releases[i+1].release_date) - DAY) : asOf));
  return {...spans.at(-1), episodes:spans.flatMap(span => span.episodes)};
}

const yesterday = () => iso(Date.now() - DAY);
export function getMetricEpisodes(db, asOf = yesterday()) {
  const inputs = readInputs(db);
  return configs(db).flatMap(rule => evaluate(rule, inputs, asOf).episodes);
}
export function metricRuleStatus(db, asOf = yesterday()) {
  const inputs = readInputs(db);
  const series = new Map();
  for (const r of inputs.rows) {
    const choice = {metric:r.metric_id,product:r.product,segment:r.segment || 'all',sourceId:r.source_id || ''};
    series.set(JSON.stringify(choice), choice);
    if (r.combine_group) {
      const group = {...choice, sourceId:r.combine_group};
      series.set(JSON.stringify(group), group);
    }
  }
  return {
    rules: configs(db).map(rule => {
      const {episodes, ...state} = evaluate(rule, inputs, asOf);
      return state;
    }),
    releases: inputs.releases.map(r => ({id:r.release_id,date:r.release_date,description:r.description})),
    series: [...series.values()],
  };
}
