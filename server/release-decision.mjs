import { cases, facts, productFamily } from './evidence.mjs';
import { accountDataDate, isAccountFeature, recommendationEvidence } from './account-release.mjs';
import { marketOffers } from './market-offers.mjs';
import { findReleaseCaseId } from './release-cases.mjs';

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

export function released({ data }) {
  return ['major', 'minor'].includes(data.release_type) && /^(выпущен[аоы]?|released)$/iu.test(data.status || '');
}

export function canDecideRelease(row, products) {
  return matchedProducts(row, products).length > 0;
}

export function matchedProducts(row, products) {
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

function interview(db, product) {
  const related = facts(db, 'interview').filter(f => typeof f.data === 'string' && mentions(f.data, product));
  const candidate = related.find(f => f.data.includes('\nФрагмент записи: ')) ||
    related.find(f => /сложно|сложност|консультац|менеджер/i.test(f.data));
  if (!candidate) return null;
  const [tags, excerpt] = candidate.data.split('\nФрагмент записи: ');
  return { ...citation(candidate), tags: tags.replace(/^Темы ответа: /u, ''), excerpt: excerpt || null };
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

export function releaseDecision(db, user, { product, caseId, releaseId, through } = {}, sharedOnly = false, observation) {
  if (through && (!/^\d{4}-\d{2}-\d{2}$/.test(through) || !Number.isFinite(Date.parse(through)) || addDays(through, 0) !== through))
    throw Error('Укажите корректную дату среза.');
  let historical = Boolean(through);
  const accessible = cases(db).filter(c => !c.body.owner || (!sharedOnly && c.body.owner === user.id));
  const requestedCase = caseId ? accessible.find(c => c.id === caseId) : null;
  if (caseId && !requestedCase) throw Error('Разбор недоступен в этом пространстве.');
  const boundRelease = c => c.body.release || c.body.signal?.releaseId;
  if (releaseId && requestedCase && boundRelease(requestedCase) && boundRelease(requestedCase) !== releaseId)
    throw Error('Разбор относится к другому релизу.');
  const caseVisible = (c, asOf) => !historical || visibleOnDate(c.body.signal, asOf);
  const sharedCase = row => {
    const id = row && findReleaseCaseId(db, row.data.release_id);
    return id ? accessible.find(c => c.id === id) : null;
  };
  const linkedCase = (row, selectedProduct, asOf, sharedId) => row && accessible.find(c =>
    c.product === selectedProduct && c.body.release === row.data.release_id &&
    (c.id !== sharedId || c.id === caseId) && caseVisible(c, asOf));
  const signals = accessible.filter(c => c.body.signal && c.body.signal.status !== 'withdrawn').sort((a, b) =>
    b.body.signal.week.localeCompare(a.body.signal.week) ||
    (Number(b.body.signal.rule === 'relative') - Number(a.body.signal.rule === 'relative')) ||
    a.id.localeCompare(b.id));
  const sales = facts(db, 'sales');
  const products = [...new Set(sales.map(r => r.data.product_family))].sort();
  const calendar = facts(db, 'releases');
  const accountFeatures = calendar.filter(isAccountFeature);
  const requestedRelease = releaseId && calendar.find(r => r.data.release_id === releaseId);
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
    const delivered = row ? facts(db, 'backlog').filter(r => r.data.created_date <= asOf &&
      (relatedTasks.includes(r.data.task_id) || ids(r.data.release_id).includes(row.data.release_id))) : [];
    const shared = sharedCase(row);
    const linked = linkedCase(row, product, asOf, shared?.id);
    return { product: 'ЛК', products, scope: 'account', asOf, historical, caseId: linked?.id || null,
      releaseCaseId: shared?.id ?? null, releaseCaseProduct: shared?.product ?? null,
      releases: releases.map(releaseInfo), release: row ? releaseInfo(row) : null,
      delivered: delivered.map(r => taskInfo(r, asOf, historical)),
      accountEvidence: recommendationEvidence(db, row, calendar, asOf, observation),
      recommendation: { title: 'Проверить эффект в личном кабинете', next: 'Сопоставьте целевой показатель с датами выкладки и изменениями учёта.' } };
  }
  if (!requestedCase && product && !products.includes(product)) {
    const similar = products.filter(name => productFamily(name) === productFamily(product));
    if (similar.length === 1) [product] = similar;
  }
  if (!product || !products.includes(product)) throw Error('В книге нет недельных продаж выбранного семейства.');
  const series = sales.filter(r => r.data.product_family === product);
  const latest = series.filter(fullWeek).map(r => r.data.week_start).sort().at(-1);
  const endWeek = (!releaseId && requestedCase?.body.signal?.week) || latest;
  historical ||= Boolean(endWeek && latest && endWeek < latest);
  const familyCalendar = calendar.filter(r => released(r) && !isAccountFeature(r) && mentions(r.data.description, product));
  const archiveDay = endWeek ? addDays(endWeek, 6) : series.map(r => r.data.week_start).sort().at(-1);
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format();
  const asOf = through || (historical ? archiveDay : [archiveDay, ...familyCalendar.map(r => r.data.release_date)
    .filter(date => date <= today)].filter(Boolean).sort().at(-1));
  const releases = familyCalendar.filter(r => r.data.release_date <= asOf)
    .sort((a, b) => b.data.release_date.localeCompare(a.data.release_date));
  const selected = releaseId || requestedCase?.body.release;
  const release = selected ? releases.find(r => r.data.release_id === selected) : releases[0];
  if (releaseId && !release) throw Error('В выбранном срезе нет такого релиза семейства.');
  const shared = sharedCase(release);
  const linked = linkedCase(release, product, asOf, shared?.id);
  const signalCase = requestedCase && caseVisible(requestedCase, asOf) ? requestedCase : linked ||
    signals.find(c => c.product === product && caseVisible(c, asOf) &&
      (release ? boundRelease(c) === release.data.release_id : !boundRelease(c)));
  const backlog = facts(db, 'backlog').filter(r => r.data.created_date && r.data.created_date <= asOf);
  const delivered = release ? backlog.filter(r => ids(release.data.related_task_ids).includes(r.data.task_id) ||
    ids(r.data.release_id).includes(release.data.release_id)) : [];
  const open = backlog.filter(r => mentions(asText(r.data.title,r.data.description_short), product) &&
    (!r.data.closed_date || r.data.closed_date > asOf) &&
    (historical || r.data.closed_date || !/^(done|closed|закрыта)$/iu.test(r.data.status)));
  const issue = open.find(r => /(?:передач|регистрац|разметк|сбор).{0,60}(?:метрик|событи)|(?:метрик|событи).{0,45}(?:передач|разметк)/iu.test(asText(r.data.title,r.data.description_short)));
  const measurement = issue && facts(db, 'dictionary').find(r => ids(issue.data.linked_metric_ids).includes(r.data.metric_id));
  const task = issue || open[0];
  const trend = weeklyTrend(series, asOf);
  const recommendation = issue && !historical ? {
    title: 'Проверить измерение по ' + issue.data.task_id,
    reason: issue.data.description_short,
    next: 'Сверить отправку и получение событий на одном прохождении. Затем повторить расчёт по сопоставимым данным.',
    uncertainty: 'UX-гипотеза: сложность выбора версии мешает оформить самостоятельный заказ. Её можно проверить по наблюдениям за подбором и исправной воронке.',
  } : {
    title: task ? 'Уточнить задачу ' + task.data.task_id : 'Проверить результат релиза',
    reason: historical ? null : task?.data.description_short ||
      'В загруженном бэклоге не найдена открытая задача, прямо упоминающая это семейство.',
    next: 'Сопоставить цель релиза с наблюдаемым рядом и проверить альтернативные объяснения перед новой задачей.',
    uncertainty: 'Изменение индекса заказов само по себе не устанавливает влияние релиза.',
  };
  return { product, products, caseId: signalCase?.id || null, asOf, releases: releases.map(releaseInfo),
    releaseCaseId: shared?.id ?? null, releaseCaseProduct: shared?.product ?? null,
    release: release ? releaseInfo(release) : null, delivered: delivered.map(r => taskInfo(r, asOf, historical)), trend,
    backlog: task ? taskInfo(task, asOf, historical) : null,
    measurement: measurement && !historical ? { ...citation(measurement), metric: measurement.data.metric_id, title: measurement.data.metric_name,
      comment: measurement.data.comment, formula: measurement.data.formula_or_logic } : null,
    customer: historical ? null : interview(db, product), historical, competitor: marketOffers(db, product, asOf)[0] || null,
    recommendation, measurementIssue: Boolean(issue && !historical) };
}

export function decisionDraft(decision, appUrl = '') {
  const { backlog, measurement, measurementIssue, product, release, recommendation, trend } = decision;
  const number = value => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const source = row => row.file + ' · ' + row.loc + (appUrl ?
    ' · ' + appUrl.replace(/\/+$/, '') + '/#knowledge-source/' + row.version + '/' + encodeURIComponent(row.loc) : '');
  const title = measurementIssue ? 'Проверить передачу событий · ' + product : 'Проверить эффект ' + release.id + ' · ' + product;
  const index = trend?.available && 'Недельный индекс заказов: ' +
    trend.baseline.start + '–' + trend.baseline.end + ' — ' + number(trend.baseline.mean) + '; ' +
    trend.current.start + '–' + trend.current.end + ' — ' + number(trend.current.mean) + '.';
  const evidence = [release, backlog, measurement, trend?.baseline?.rows.at(-1), trend?.current?.rows.at(-1),
    ...(decision.accountEvidence?.sources || [])]
    .filter(Boolean).map(source);
  const description = [
    product + ' · ' + release.id + ' · срез ' + decision.asOf + '.',
    release.description, index, ...(decision.accountEvidence?.lines || []),
    backlog && backlog.id + ' — ' + backlog.title + '. ' + backlog.description,
    measurement?.comment, recommendation.next, recommendation.uncertainty,
    'Исходные строки:\n' + evidence.join('\n'),
  ].filter(Boolean).join('\n\n');
  return { title, description };
}
