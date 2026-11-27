import { cases, digest, facts, fmt, productFamily } from './evidence.mjs';
import { accountDataDate, isAccountFeature, recommendationEvidence } from './account-release.mjs';
import { marketOffers } from './market-offers.mjs';
import { sourceReader } from './source-reader.mjs';
import { observationWithin } from './metric-observations.mjs';
import { analysisEvidence, analysisText, rowLink } from './analysis-composer.mjs';

const DAY = 86400000;
const addDays = (date, n) => new Date(Date.parse(date + 'T00:00:00Z') + n * DAY).toISOString().slice(0, 10);
const citation = row => ({ file: row.file, loc: row.loc, version: row.version });
const ids = text => String(text || '').split(/[,;]/).map(s => s.trim()).filter(Boolean);
const asText = (...fields) => fields.filter(Boolean).join(' ');
const fullWeek = row => !row.data.partial && !/неполн/i.test(row.data.comment || '');

function mentions(text, product) {
  if (!text) return false;
  const words = String(text).toLowerCase().replace(/каспер[а-яё]*/gu, 'kaspersky')
    .replace(/астр[а-яё]*/gu, 'astra').match(/[\p{L}\p{N}]+/gu) || [];
  const needle = productFamily(product);
  return (' ' + words.join(' ') + ' ').includes(' ' + product.toLowerCase() + ' ') || words.includes(needle);
}

function weeklyTrend(rows, asOf) {
  const available = rows.filter(r => fullWeek(r) && Number.isFinite(r.data.orders_index) && addDays(r.data.week_start, 6) <= asOf)
    .sort((a, b) => a.data.week_start.localeCompare(b.data.week_start));
  const recent = available.at(-1)?.data.week_start;
  if (!recent) return { available: false, reason: 'В данных нет полной недели к выбранной дате.' };
  const dates = new Map(available.map(r => [r.data.week_start, r]));
  const sequence = Array.from({ length: 16 }, (_, i) => dates.get(addDays(recent, 7 * (i - 15))));
  if (sequence.some(r => !r)) return { available: false, reason: 'Для сравнения нужны 16 последовательных полных недель.', latest: recent };
  const period = part => ({
    start: part[0].data.week_start, end: addDays(part.at(-1).data.week_start, 6),
    mean: part.reduce((sum, r) => sum + r.data.orders_index, 0) / part.length,
    rows: part.map(r => ({ date: r.data.week_start, value: r.data.orders_index, ...citation(r) })),
  });
  const baseline = period(sequence.slice(0, 12)), current = period(sequence.slice(12));
  const change = baseline.mean === 0 ? null : (current.mean / baseline.mean - 1) * 100;
  return { available: true, baseline, current, change, latest: recent };
}

function released({ data }) {
  return ['major', 'minor'].includes(data.release_type) && /^(выпущен[аоы]?|released)$/iu.test(data.status || '');
}

export function canDecideRelease(row, products) {
  return matchedProducts(row, products).length > 0;
}

function matchedProducts(row, products) {
  if (!released(row)) return [];
  return isAccountFeature(row) ? ['ЛК'] : products.filter(name => mentions(row.data.description, name));
}

export function legacyReleaseProduct(db, releaseId) {
  const archived = db.prepare(`SELECT json_extract(f.value,'$.row') AS body FROM documents d, json_each(d.body,'$.facts') f
    WHERE json_extract(f.value,'$.kind')='releases' AND json_extract(f.value,'$.row.release_id')=?`).all(releaseId);
  const rows = [...facts(db, 'releases').filter(row => row.data.release_id === releaseId),
    ...archived.map(row => ({ data: JSON.parse(row.body) }))];
  const archivedProducts = db.prepare(`SELECT DISTINCT json_extract(f.value,'$.row.product_family') AS product
    FROM documents d, json_each(d.body,'$.facts') f WHERE json_extract(f.value,'$.kind')='sales'`).all();
  const products = [...new Set([...facts(db, 'sales').map(row => row.data.product_family),
    ...archivedProducts.map(row => row.product)].filter(Boolean))];
  const eligible = [...new Set(rows.flatMap(row => matchedProducts(row, products)))];
  return eligible.length === 1 ? eligible[0] : null;
}

function researchRows(db, read, product, asOf, historical, from, releaseId) {
  const linked = row => row.data && typeof row.data === 'object' && row.data.product
    ? mentions(row.data.product, product) : mentions(JSON.stringify(row.data), product);
  const inPeriod = row => row.data?.date
    ? /^\d{4}-\d{2}-\d{2}$/u.test(row.data.date) && Number.isFinite(Date.parse(row.data.date)) &&
      addDays(row.data.date, 0) === row.data.date && row.data.date <= asOf && (!from || row.data.date >= from)
    : !historical && !from;
  const corrections = db.prepare(`SELECT source,comment FROM feedback WHERE product=?
    AND (? IS NULL OR created<?) ORDER BY id`)
    .all(product, historical ? asOf : null, Date.parse(asOf + 'T21:00:00Z'));
  const excluded = new Map(corrections.map(row => [row.source, row.comment.startsWith('[Исключить связь]')]));
  const visible = row => !excluded.get(row.file + ' · ' + row.loc) &&
    !excluded.get(row.data?.sourceFile + ' · ' + row.data?.sourceLoc);
  const collect = kind => read(kind).filter(row => {
    const release = row.data?.release_id || row.data?.releaseId;
    return (!release || release === releaseId) && linked(row) && inPeriod(row) && visible(row);
  })
    .map(row => {
      const data = row.data;
      if (typeof data !== 'string') return {...data, ...citation(row)};
      const [tags, excerpt] = data.split('\nФрагмент записи: ');
      return {...citation(row), tags:tags.replace(/^Темы ответа: /u, ''), excerpt:excerpt || (tags === data && !tags.startsWith('Темы ответа: ') ? data : null)};
    }).sort((a,b) => Number(Boolean(b.excerpt && b.tags !== b.excerpt)) -
      Number(Boolean(a.excerpt && a.tags !== a.excerpt)) || (b.date || '').localeCompare(a.date || '')).slice(0, 8);
  return {interviews:collect('interview'), competitors:collect('competitor')};
}

const releaseInfo = r => ({ id: r.data.release_id, date: r.data.release_date,
  description: r.data.description, metrics: ids(r.data.affected_metrics),
  relatedTaskIds: ids(r.data.related_task_ids), ...citation(r) });
function taskInfo(r, asOf, historical) {
  const { task_id, title, description_short, status, created_date, closed_date, linked_metric_ids } = r.data;
  const closed = closed_date && closed_date <= asOf;
  return {
    id: task_id, title, date: created_date, metrics: ids(linked_metric_ids),
    description: !historical || closed ? description_short : null,
    status: historical ? (closed ? 'Закрыта' : 'Статус в архиве на дату среза не зафиксирован') : status,
    ...citation(r),
  };
}

function visibleOnDate(signal, through) {
  if (!signal) return false;
  const rows = signal.history || [signal];
  const count = rows.filter(row => addDays(row.week, 6) <= through).length;
  return count >= (signal.rule === 'absolute' ? 2 : 1);
}

export function releaseDecision(db, user, { product, caseId, releaseId, through, from } = {}, sharedOnly = false, observation) {
  if (through && (!/^\d{4}-\d{2}-\d{2}$/.test(through) || !Number.isFinite(Date.parse(through)) || addDays(through, 0) !== through))
    throw Error('Укажите корректную дату среза.');
  if (from && (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !Number.isFinite(Date.parse(from)) || addDays(from, 0) !== from || through && from > through))
    throw Error('Укажите корректное начало периода.');
  let historical = Boolean(through);
  let read = sourceReader(db, through, observation?.sourceSnapshot);
  const accessible = cases(db).filter(c => !c.body.owner || (!sharedOnly && c.body.owner === user.id));
  const requestedCase = caseId ? accessible.find(c => c.id === caseId) : null;
  if (caseId && !requestedCase) throw Error('Разбор недоступен в этом пространстве.');
  const boundRelease = c => c.body.release || c.body.signal?.releaseId;
  if (releaseId && requestedCase && boundRelease(requestedCase) && boundRelease(requestedCase) !== releaseId)
    throw Error('Разбор относится к другому релизу.');
  const caseVisible = (c, asOf) => !historical || visibleOnDate(c.body.signal, asOf);
  const linkedCase = (row, selectedProduct, asOf) => row && accessible.find(c => c.product === selectedProduct &&
    c.body.release === row.data.release_id && caseVisible(c, asOf));
  const signals = accessible.filter(c => c.body.signal && c.body.signal.status !== 'withdrawn').sort((a, b) =>
    b.body.signal.week.localeCompare(a.body.signal.week) ||
    (Number(b.body.signal.rule === 'relative') - Number(a.body.signal.rule === 'relative')) ||
    a.id.localeCompare(b.id));
  const sales = read('sales');
  const products = [...new Set(sales.map(r => r.data.product_family))].sort();
  let calendar = read('releases');
  const accountFeatures = calendar.filter(isAccountFeature);
  const requestedRelease = releaseId && (calendar.find(r => r.data.release_id === releaseId) ||
    facts(db, 'releases').find(r => r.data.release_id === releaseId));
  if (releaseId && !requestedRelease) throw Error('Релиз отсутствует в загруженном календаре.');
  if (!product && !requestedCase && requestedRelease) {
    product = isAccountFeature(requestedRelease) ? 'ЛК' : products.find(name => mentions(requestedRelease.data.description, name));
  }
  if (accountFeatures.length && !products.includes('ЛК')) products.push('ЛК');
  product = requestedCase?.product || product ||
    signals.find(c => products.includes(c.product) && (!historical || visibleOnDate(c.body.signal, through)))?.product || products[0];
  if (product === 'ЛК' && accountFeatures.length) {
    const asOf = through || accountDataDate(db, accountFeatures);
    const releases = accountFeatures.filter(r => r.data.release_date <= asOf)
      .sort((a,b) => b.data.release_date.localeCompare(a.data.release_date));
    const selected = releaseId || requestedCase?.body.release;
    const row = selected ? releases.find(r => r.data.release_id === selected) : releases[0];
    if (releaseId && !row) throw Error('На выбранную дату этого релиза ЛК нет в календаре.');
    const relatedTasks = ids(row?.data.related_task_ids);
    const delivered = row ? read('backlog').filter(r => r.data.created_date <= asOf &&
      (relatedTasks.includes(r.data.task_id) || ids(r.data.release_id).includes(row.data.release_id))) : [];
    const linked = linkedCase(row, product, asOf);
    return { product: 'ЛК', products, scope: 'account', asOf, from, historical, caseId: linked?.id || null,
      releases: releases.map(releaseInfo), release: row ? releaseInfo(row) : null,
      delivered: delivered.map(r => taskInfo(r, asOf, historical)),
      research:researchRows(db, read, product, asOf, historical, from, row?.data.release_id),
      accountEvidence: recommendationEvidence(db, row, calendar, asOf, { ...observation, from:from || observation?.from, read }) };
  }
  if (!requestedCase && product && !products.includes(product)) {
    const similar = products.filter(name => productFamily(name) === productFamily(product));
    if (similar.length === 1) [product] = similar;
  }
  if (!product || !products.includes(product)) throw Error('В книге нет недельных продаж выбранного семейства.');
  let series = sales.filter(r => r.data.product_family === product);
  const latest = series.filter(fullWeek).map(r => r.data.week_start).sort().at(-1);
  const endWeek = (!releaseId && requestedCase?.body.signal?.week) || latest;
  historical ||= Boolean(endWeek && latest && endWeek < latest);
  const productReleases = rows => rows.filter(r => released(r) && !isAccountFeature(r) && mentions(r.data.description, product));
  let familyCalendar = productReleases(calendar);
  const archiveDay = endWeek ? addDays(endWeek, 6) : series.map(r => r.data.week_start).sort().at(-1);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format();
  const asOf = through || (historical ? archiveDay : [archiveDay, ...familyCalendar.map(r => r.data.release_date)
    .filter(date => date <= today)].filter(Boolean).sort().at(-1));
  if (historical && !through) {
    read = sourceReader(db, asOf);
    calendar = read('releases');
    series = read('sales').filter(r => r.data.product_family === product);
    familyCalendar = productReleases(calendar);
  }
  const releases = familyCalendar.filter(r => r.data.release_date <= asOf)
    .sort((a, b) => b.data.release_date.localeCompare(a.data.release_date));
  const selected = releaseId || requestedCase?.body.release;
  const release = selected ? releases.find(r => r.data.release_id === selected) : releases[0];
  if (releaseId && !release) throw Error('В выбранном срезе нет такого релиза семейства.');
  const linked = linkedCase(release, product, asOf);
  const signalCase = requestedCase && caseVisible(requestedCase, asOf) ? requestedCase : linked ||
    signals.find(c => c.product === product && caseVisible(c, asOf) &&
      (release ? boundRelease(c) === release.data.release_id : !boundRelease(c)));
  const backlog = read('backlog').filter(r => r.data.created_date && r.data.created_date <= asOf);
  const delivered = release ? backlog.filter(r => ids(release.data.related_task_ids).includes(r.data.task_id) ||
    ids(r.data.release_id).includes(release.data.release_id)) : [];
  const open = backlog.filter(r => (delivered.includes(r) || (!release || !ids(r.data.release_id).length) &&
    mentions(asText(r.data.product,r.data.product_family,r.data.title,r.data.description_short), product)) &&
    (!r.data.closed_date || r.data.closed_date > asOf) &&
    (historical || r.data.closed_date || !/^(done|closed|закрыта)$/iu.test(r.data.status)));
  const metrics = new Set([...ids(release?.data.affected_metrics), ...[...delivered, ...open].flatMap(row => ids(row.data.linked_metric_ids))]);
  const definitions = read('dictionary').filter(row => metrics.has(row.data.metric_id))
    .map(row => ({...citation(row), metric:row.data.metric_id, title:row.data.metric_name,
      comment:row.data.comment, formula:row.data.formula_or_logic}));
  const period = from || addDays(release?.data.release_date || asOf, -28);
  const metricRows = read('metrics').filter(row => metrics.has(row.data.metric_id) && mentions(row.data.product, product) &&
    observationWithin(row.data, period, asOf)).sort((a,b) => b.data.date.localeCompare(a.data.date));
  const readings = [...metrics].flatMap(metric => metricRows.filter(row => row.data.metric_id === metric).slice(0, 16)
    .map(row => ({...citation(row), data:row.data,
      ...(row.data.unit === 'ratio' && Number.isFinite(row.data.value) && {percent:row.data.value * 100})})));
  const trend = weeklyTrend(series.filter(row => !from || row.data.week_start >= from), asOf);
  const research = researchRows(db, read, product, asOf, historical, from, release?.data.release_id);
  const openTasks = open.map(r => taskInfo(r, asOf, historical));
  return { product, products, caseId: requestedCase?.id && caseVisible(requestedCase, asOf) ? requestedCase.id : signalCase?.id || null,
    asOf, from, releases: releases.map(releaseInfo), release: release ? releaseInfo(release) : null,
    delivered: delivered.map(r => taskInfo(r, asOf, historical)), trend, openTasks, definitions, readings, research,
    backlog: openTasks[0] || null,
    measurement: definitions[0] || null,
    customer: research.interviews.find(row => row.excerpt) || research.interviews[0] || null, historical,
    competitor: marketOffers(db, product, asOf, {from, ...(historical && {versions:[...new Set(read('competitor').map(row => row.version))]})})[0] || null,
  };
}

export function restrictReleaseDecision(db, user, snapshot, period = {}, shared = false) {
  const {decision} = snapshot;
  const from = [decision.from, period.from].filter(Boolean).sort().at(-1);
  const through = [snapshot.through, period.through].filter(Boolean).sort()[0];
  if (from === decision.from && through === snapshot.through) return decision;
  return releaseDecision(db, user, {product:snapshot.product,releaseId:snapshot.releaseId,from,through}, shared,
    {sourceSnapshot:through === snapshot.through ? snapshot : undefined});
}

export function releaseEvidence(db, decision) {
  const {product, release, caseId, asOf, from, historical, trend, research, accountEvidence} = decision;
  const scope = {caseId, product, releaseId:release?.id, from, through:asOf, historical,
    researchCoverage:{interviews:research?.interviews.length || 0, competitors:research?.competitors.length || 0},
    ...(!trend?.available && trend && {missingIndex:trend.reason})};
  const items = [];
  const revision = db.prepare(`SELECT file,body FROM documents WHERE version=?
    AND (lower(file) LIKE '%.xlsx' OR lower(file) LIKE '%.pptx')`);
  const cache = new Map();
  const valid = row => {
    if (!row?.version || !row.loc) return false;
    if (!cache.has(row.version)) {
      const doc = revision.get(row.version);
      cache.set(row.version, doc && {file:doc.file, locations:new Set(JSON.parse(doc.body).facts.map(fact => fact.loc))});
    }
    const doc = cache.get(row.version);
    return doc?.file === row.file && doc.locations.has(row.loc);
  };
  const {version: _v, file: _f, loc: _l, ...releaseData} = release || {};
  const add = (kind, data, sources) => {
    if (sources.length && sources.every(valid)) items.push({kind, data, sources:sources.map(citation)});
  };
  const row = (kind, item) => {
    if (!item) return;
    const {version, file, loc, ...data} = item;
    add(kind, data, [{version,file,loc}]);
  };
  if (!from || release?.date >= from) add('release', releaseData, [release]);
  const tasks = new Map([...decision.delivered, ...(decision.openTasks || [decision.backlog].filter(Boolean))].map(task => [task.id, task]));
  for (const task of tasks.values()) {
    if (!from || task.date >= from) row('backlog', task);
  }
  for (const definition of decision.definitions || [decision.measurement].filter(Boolean)) row('dictionary', definition);
  for (const reading of decision.readings || []) row('metric', reading);
  for (const interview of research?.interviews || [decision.customer].filter(item => item && (!historical || item.date)))
    row('interview', interview);
  for (const competitor of research?.competitors || []) row('competitor', competitor);
  if (decision.competitor) {
    const {url, ...offer} = decision.competitor;
    row('market-offer', offer);
  }
  if (trend?.available) {
    const strip = ({rows, ...period}) => ({...period, weeks:rows.length, rows:rows.map(({date,value}) => ({date,value}))});
    add('orders-index', {baseline:strip(trend.baseline),current:strip(trend.current),change:trend.change},
      [...trend.baseline.rows,...trend.current.rows]);
  }
  if (accountEvidence) add('account-metrics', accountEvidence.measurements, accountEvidence.sources);
  return {scope, evidence:analysisEvidence(scope, items)};
}

export function releaseScopedView(db, view, evidence) {
  const sources = new Set(evidence.flatMap(item=>item.sources.map(rowLink)));
  const visible = row => row?.loc && row.version && sources.has(rowLink(row));
  const ratio = card => card?.rows?.length && card.rows.every(visible) ? card :
    {n:null,d:null,reason:'В срезе нет подтверждённых строк для сравнения.',rows:[]};
  const {id:previousId, ...original} = view;
  const scoped = {...original,
    timeline:view.timeline?.filter(visible),
    evidence:evidence.filter(item=>item.kind==='interview' || item.kind==='competitor').map(item=>({
      ...item.sources[0],kind:item.kind,source:item.sources[0].file+' · '+item.sources[0].loc,
      data:item.data.excerpt || item.data.tags || '',metadata:{date:item.data.date,product:item.data.product},
    })),
    corrections:[],
    gap:visible(view.gapSource) ? view.gap : '',
    gapSource:visible(view.gapSource) ? view.gapSource : undefined,
    backlog:view.backlog?.filter(task=>task.sourceRefs?.every(visible)),
    ctr:view.product==='ЛК' ? ratio(view.ctr) : ratio(),
    reach:ratio(view.reach),
  };
  const body = JSON.stringify(scoped);
  const id = digest(body);
  db.prepare('INSERT OR IGNORE INTO evidence_calcs VALUES(?,?)').run(id, body);
  return {...scoped,id};
}

export function decisionDraft(decision, report, appUrl = '') {
  const {product, release, asOf, trend} = decision;
  const base = appUrl?.replace(/\/+$/, '');
  const link = row => row.file + ' · ' + row.loc + ' · ' + (base ? base + '/' : '') + rowLink(row);
  const index = trend?.available && [
    'Недельный индекс заказов',
    trend.baseline.start + ' — ' + trend.baseline.end + ' · ' + fmt(trend.baseline.mean),
    trend.current.start + ' — ' + trend.current.end + ' · ' + fmt(trend.current.mean),
    ...[...trend.baseline.rows, ...trend.current.rows].map(link),
  ].join('\n');
  const description = [product + ' · ' + release.id + ' · срез ' + asOf, analysisText(report, link), index]
    .filter(Boolean).join('\n\n');
  return {title:report.title, description};
}
