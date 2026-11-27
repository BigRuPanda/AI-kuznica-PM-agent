import { defaultRules, digest, facts, metricStepDays, productFamily, setting } from './evidence.mjs';

const day = 86400000;
const pairs = {
  cfg_reach_rate: ['configurator_visits', 'family_visits'],
  cfg_completion_rate: ['complete', 'open'],
  cfg_back_reset_rate: ['back', 'open'],
  cfg_add_to_cart_rate: ['add_to_cart', 'open'],
  lk_reco_ctr: ['click_visits', 'viewed_visits'],
};
const date = t => new Date(t).toISOString().slice(0, 10);
const time = d => Date.parse(d + 'T00:00:00Z');
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
const validDate = value => Number.isFinite(time(value)) && date(time(value)) === value;
const ref = ({ file, loc, version }) => ({ file, loc, version });
const ids = s => String(s || '').split(',').map(x => x.trim()).filter(Boolean);
const sameFamily = (s, product) => productFamily(s || '') === productFamily(product);
const countUnits = { visits: 'визитов', views: 'просмотров', count: 'событий', events: 'событий' };
const cartMetric = 'cfg_add_to_cart_rate';
const cartCheck = 'После подтверждённой выкладки сверить тестовое добавление из конфигуратора Kaspersky с событием электронной торговли в Метрике и проверить знаменатель. Затем собрать 4 полные недели с корректным учётом.';
const cartBaseline = 'Четыре недели до выкладки проверяются по справочнику. В архиве событие добавления в корзину у Kaspersky почти не фиксировалось. Первые 4 недели корректного учёта могут стать базой для следующих сравнений.';

export function observationOptions(db, c) {
  const definitions = facts(db, 'dictionary');
  const controls = [...new Set(facts(db, 'sales').map(row => row.data.product_family))]
    .filter(product => !sameFamily(product, c.product)).sort();
  const backlog = facts(db, 'backlog').filter(({data}) =>
    sameFamily([data.product, data.title, data.description_short].join(' '), c.product));
  const releases = facts(db, 'releases').filter(({data}) =>
    data.status === 'выпущен' && validDate(data.release_date) && (sameFamily(data.description, c.product) ||
      backlog.some(t => ids(t.data.release_id).includes(data.release_id) ||
        ids(data.related_task_ids).includes(t.data.task_id))));
  const series = db.prepare(`SELECT DISTINCT json_extract(body,'$.product') AS product,
    json_extract(body,'$.segment') AS segment, json_extract(body,'$.unit') AS unit,
    json_extract(body,'$.metric_id') AS metric
    FROM facts WHERE kind='metrics'`).all().filter(row => sameFamily(row.product, c.product));
  const segmentsFor = metric => [...new Set(series
    .filter(row => row.metric === metric && row.segment && (pairs[metric] || countUnits[row.unit]))
    .map(row => row.segment))].sort();
  const salesDef = definitions.find(row => row.data.metric_id === 'family_orders_idx');
  const metrics = [{
    id: 'orders_index', title: 'Индекс самостоятельных заказов', segments: ['all'],
    note: salesDef?.data.comment, source: salesDef && ref(salesDef),
  }];
  const cartTask = backlog.find(row => row.data.task_id === 'T-08' &&
    ids(row.data.linked_metric_ids).includes(cartMetric));
  for (const row of definitions) {
    const d = row.data;
    if (d.metric_id === 'family_orders_idx') continue;
    const segments = segmentsFor(d.metric_id);
    const prospective = !segments.length && d.metric_id === cartMetric && !!cartTask;
    if (!segments.length && !backlog.some(t => ids(t.data.linked_metric_ids).includes(d.metric_id))) continue;
    metrics.push({
      id: d.metric_id, title: d.metric_name, segments: prospective ? segmentsFor('cfg_family_views') : segments,
      prospective, note: d.comment, source: ref(row),
    });
  }
  const tasks = backlog.map(row => {
    const t = row.data;
    return {
      id: t.task_id, title: t.title, status: t.status, created: t.created_date, source: ref(row),
      releaseIds: releases.filter(r => ids(t.release_id).includes(r.data.release_id) ||
        ids(r.data.related_task_ids).includes(t.task_id)).map(r => r.data.release_id),
      metrics: ids(t.linked_metric_ids),
    };
  });
  const examples = {};
  if (cartTask && tasks.some(t => t.id === 'T-08' && !t.releaseIds.length) &&
      metrics.some(m => m.id === cartMetric && m.segments.includes('desktop'))) {
    examples.cart = { taskId: 'T-08', metric: cartMetric, segment: 'desktop', condition: cartCheck };
  }
  const astraRelease = releases.find(r => r.data.release_id === 'R-02' && ids(r.data.affected_metrics).includes('cfg_family_views'));
  if (astraRelease && tasks.some(t => t.id === 'T-02' && t.releaseIds.includes('R-02')) &&
      metrics.some(m => m.id === 'cfg_family_views' && m.segments.includes('desktop'))) {
    examples.retro = {
      taskId: 'T-02', releaseId: 'R-02', metric: 'cfg_family_views', segment: 'desktop',
      asOf: date(time(astraRelease.data.release_date) + 28 * day),
    };
  }
  return {
    metrics, tasks, examples, controls,
    releases: releases.map(row => {
      const r = row.data;
      return { id: r.release_id, date: r.release_date, title: r.description, source: ref(row), metrics: ids(r.affected_metrics) };
    }).sort((a, b) => a.date.localeCompare(b.date)),
  };
}

export function makeObservationPlan(db, c, input) {
  const choices = observationOptions(db, c);
  const metric = choices.metrics.find(x => x.id === input.metric);
  if (!metric) throw Error('Выберите доступный показатель этого продукта.');
  const task = input.taskId && choices.tasks.find(x => x.id === input.taskId);
  const release = input.releaseId && choices.releases.find(x => x.id === input.releaseId);
  if ((input.taskId && !task) || (input.releaseId && !release))
    throw Error('Задача или релиз не найдены в источниках этого продукта.');
  if (input.asOf && (release?.date > input.asOf || task?.created > input.asOf))
    throw Error('На дату оценки этой записи ещё не было.');
  if (task && (release || input.deployed) && (!release || !task.releaseIds.includes(release.id)))
    throw Error('Для этой задачи нужна связанная выкладка в источниках.');
  if (release && input.deployed && input.deployed !== release.date) throw Error('Дата расходится со строкой релиза.');
  const deployed = release?.date || input.deployed || null;
  if (deployed && !validDate(deployed))
    throw Error('Проверьте дату выкладки.');
  const segment = input.segment || metric.segments[0] || 'all';
  if (metric.segments.length && !metric.segments.includes(segment)) throw Error('Выберите разрез из исходного ряда.');
  const control = metric.id === 'orders_index'
    ? input.control?.trim() ?? (choices.controls.length === 1 ? choices.controls[0] : '')
    : '';
  if (input.control && metric.id !== 'orders_index')
    throw Error('Контрольное семейство доступно для недельного индекса заказов.');
  if (control && !choices.controls.includes(control))
    throw Error('Выберите другое семейство из исходного ряда для контроля.');
  const comparison = control ? {
    control, controlTolerance: setting(db, 'rules', defaultRules).controlTolerance ?? defaultRules.controlTolerance,
  } : {};
  const cartRepair = task?.id === 'T-08' && metric.id === cartMetric;
  const scheduling = task && !deployed ? {
    scheduledOn: today(),
    sourceCursor: db.prepare('SELECT coalesce(max(rowid),0) AS cursor FROM documents').get().cursor,
  } : {};
  const criteria = {
    metric:metric.id, segment, deployed, releaseId:release?.id || null, taskId:task?.id || null,
    baselineWeeks:input.baselineWeeks ?? 4, observationWeeks:input.observationWeeks ?? 4,
    target:input.target ?? null, direction:input.direction || 'at-least',
    condition:input.condition?.trim() || (cartRepair ? cartCheck : null),
    ...comparison,
  };
  return { version:2, kind:'archive-observation', ...criteria, title:metric.title, ...scheduling,
    request:digest(JSON.stringify(criteria)),
    sources:[task?.source,release?.source,metric.source].filter(Boolean),
    metricNote:metric.note || null, baselineNote:cartRepair ? cartBaseline : null };
}

function confirmsFamily(product, fields) {
  const expected = productFamily(product);
  const values = fields.filter(value => typeof value === 'string' && value.trim());
  const named = values.flatMap(value => (value.match(/\p{L}+/gu) || []).map(productFamily))
    .filter(family => family === 'astra' || family === 'kaspersky');
  return named.every(family => family === expected) &&
    values.some(value => sameFamily(value, product));
}

function resolveRollout(db, product, plan, cutoff) {
  const waiting = {state:'Ожидаем подтверждённую дату исправления'};
  if (!plan.taskId) return waiting;
  const scheduled = plan.scheduledOn && plan.sourceCursor != null;
  if (scheduled && cutoff <= plan.scheduledOn) return waiting;

  const task = facts(db,'backlog').find(t => t.data.task_id === plan.taskId);
  if (!task) return {state:'Связь с выкладкой требует проверки. Задача отсутствует в текущем бэклоге.'};
  const declared = ids(task.data.release_id);
  const revision = db.prepare('SELECT rowid AS cursor FROM documents WHERE version=?');
  const releases = facts(db,'releases').filter(row => {
    const r = row.data;
    if (r.status !== 'выпущен' || !r.release_id ||
        (!declared.includes(r.release_id) && !ids(r.related_task_ids).includes(plan.taskId))) return false;
    if (validDate(r.release_date) && (r.release_date > cutoff || (scheduled && r.release_date <= plan.scheduledOn)))
      return false;
    return !scheduled || revision.get(row.version)?.cursor > plan.sourceCursor;
  });
  if (!releases.length) return waiting;
  const fail = state => ({state, rolloutSources:[ref(task),...releases.map(ref)]});
  if (!scheduled)
    return fail('У сохранённого плана отсутствует дата постановки. Выберите подтверждённую выкладку из журнала.');
  if (releases.length > 1) return fail('Найдено несколько связанных выкладок. Проверьте бэклог и журнал релизов.');

  const [release] = releases;
  const r = release.data, related = ids(r.related_task_ids);
  if ((declared.length && !declared.includes(r.release_id)) || (related.length && !related.includes(plan.taskId)))
    return fail('Связи задачи и выкладки расходятся в бэклоге и журнале релизов.');
  if (!validDate(r.release_date))
    return fail('Дата связанной выкладки требует проверки по журналу релизов.');
  if (!confirmsFamily(product,[task.data.product,task.data.title,task.data.description_short]) ||
      !confirmsFamily(product,[r.product_family,r.product,r.description]))
    return fail('Семейства задачи и выкладки требуют проверки по бэклогу и журналу релизов.');
  return {rollout:{id:r.release_id, date:r.release_date, title:r.description, sources:[ref(task),ref(release)]}};
}

function period(db, product, plan, start, end, asOf, step) {
  const sales = plan.metric === 'orders_index';
  const records = (sales ? facts(db,'sales') : db.prepare(
    "SELECT file,loc,version,body FROM facts WHERE kind='metrics' AND json_extract(body,'$.metric_id')=? AND json_extract(body,'$.segment')=?",
  ).all(plan.metric,plan.segment).map(r => ({...r,data:JSON.parse(r.body)})))
    .filter(({data:d}) => {
      const sourceDate = sales ? d.week_start : d.date;
      const at = time(sourceDate), value = sales ? d.orders_index : d.value;
      return (sales ? d.product_family === product : sameFamily(d.product,product)) &&
        validDate(sourceDate) && at >= start && at < end && at + (step - 1) * day <= asOf &&
        !/неполн|неполный/i.test(d.comment || '') && Number.isFinite(value) && value >= 0;
    }).sort((a, b) => (sales ? a.data.week_start : a.data.date).localeCompare(sales ? b.data.week_start : b.data.date));
  const expected = (end - start) / (day * step);
  const dates = new Set(records.map(r => time(sales ? r.data.week_start : r.data.date)));
  const result = {
    from: date(start), through: date(end - day), expected, count: dates.size, value: null,
    unit: sales ? 'п. индекса' : pairs[plan.metric] ? '%' : null,
    sources: records.map(row => ({
      ...ref(row), date: sales ? row.data.week_start : row.data.date,
      value: sales ? row.data.orders_index : row.data.value, rawUnit: sales ? 'index' : row.data.unit,
    })),
  };
  if (records.length !== expected || !Array.from({length:expected}, (_,i) => dates.has(start + i * step * day)).every(Boolean))
    return result;
  if (sales) result.value = records.reduce((s,r) => s + r.data.orders_index,0) / expected;
  else if (pairs[plan.metric]) {
    if (records.some(row => row.data.unit !== 'ratio')) return result;
    const [num,den] = pairs[plan.metric];
    const data = records.map(r => { try { return JSON.parse(r.data.detail_json) || {}; } catch { return {}; } });
    if (data.some(d => !Number.isFinite(d[num]) || !Number.isFinite(d[den]) ||
        d[num] < 0 || d[den] < 0 || (d[den] === 0 && d[num] > 0))) return result;
    const n = data.reduce((s,d) => s+d[num],0), d = data.reduce((s,r) => s+r[den],0);
    result.value = d > 0 ? 100 * n / d : null;
    result.numerator = n;
    result.denominator = d;
  } else {
    const unit = records[0].data.unit;
    if (!countUnits[unit] || records.some(row => row.data.unit !== unit)) return result;
    result.total = records.reduce((s,r) => s+r.data.value,0);
    result.value = result.total / expected;
    result.unit = countUnits[unit] + (step === 7 ? ' в неделю' : ' в день');
  }
  return result;
}

export function observedEffect(db, c, cutoff = today()) {
  const plan = c.body.watch;
  const asOf = time(cutoff);
  if (!validDate(cutoff) || cutoff > today()) throw Error('Проверьте дату оценки.');
  const base = { plan, asOf:cutoff };
  const resolved = plan.deployed ? {} : resolveRollout(db,c.product,plan,cutoff);
  if (resolved.state) return {...base,...resolved};
  const deployed = time(plan.deployed || resolved.rollout.date);
  if (deployed > asOf) return {...base, state:'Ожидаем выкладку'};
  const step = metricStepDays(plan.metric);
  const weekday = (new Date(deployed).getUTCDay()+6)%7;
  const beforeEnd = step === 7 ? deployed-weekday*day : deployed;
  const afterStart = step === 7 ? deployed+(7-weekday)*day : deployed+day;
  const start = beforeEnd-plan.baselineWeeks*7*day, end = afterStart+plan.observationWeeks*7*day;
  const baseline = period(db,c.product,plan,start,beforeEnd,asOf,step);
  const observed = period(db,c.product,plan,afterStart,end,asOf,step);
  let control;
  if (plan.control) {
    const controlBaseline = period(db,plan.control,plan,start,beforeEnd,asOf,step);
    const controlObserved = period(db,plan.control,plan,afterStart,end,asOf,step);
    const complete = Number.isFinite(controlBaseline.value) && Number.isFinite(controlObserved.value);
    control = {
      product: plan.control,
      baseline: controlBaseline,
      observed: controlObserved,
      change: complete ? controlObserved.value - controlBaseline.value : null,
      relativeChange: complete && controlBaseline.value > 0
        ? (controlObserved.value / controlBaseline.value - 1) * 100 : null,
      tolerance: plan.controlTolerance ?? defaultRules.controlTolerance,
    };
  }
  const accounting = facts(db,'releases').filter(({data:r}) => {
    const t = time(r.release_date);
    return t >= start && t < end && t <= asOf && r.status === 'выпущен' &&
      ['analytics','infrastructure'].includes(r.release_type);
  });
  const metric = plan.metric === 'orders_index' ? 'family_orders_idx' : plan.metric;
  const affected = r => ids(r.data.affected_metrics).includes(metric);
  const releaseRef = r => ({...ref(r), id:r.data.release_id, date:r.data.release_date, title:r.data.description});
  const breaks = accounting.filter(affected).map(releaseRef);
  const context = accounting.filter(r => !affected(r)).map(releaseRef);
  const result = {...base, ...resolved, baseline, observed, ...(control && {control}), breaks, context,
    checkAfter:date(end-day), unit:observed.unit || baseline.unit};
  if (breaks.length) return {...result, state:'Сравнение ограничено изменением учёта'};
  if (end-day > asOf) return {...result, state:'Ожидаем окончание окна наблюдения'};
  if (!Number.isFinite(baseline.value) || !Number.isFinite(observed.value) || baseline.unit !== observed.unit)
    return {...result, state:'Недостаточно сопоставимых наблюдений'};
  if (control && control.change == null)
    return {...result, state:'Недостаточно сопоставимых наблюдений по контролю'};
  const measured = {...result, actual:observed.value, change:observed.value-baseline.value};
  if (control && control.relativeChange == null)
    return {...measured, state:'Контроль требует проверки: нулевая база'};
  if (control && Math.abs(control.relativeChange) > control.tolerance)
    return {...measured, state:'Изменился контроль — требуется проверка'};
  const target = plan.target;
  const passed = target != null && (plan.direction === 'at-most' ? observed.value <= target : observed.value >= target);
  return {...measured,
    state:target == null ? 'Изменение измерено. Цель не задана' : passed ? 'Цель достигнута' : 'Цель не достигнута'};
}
