const ids = (value) => String(value || '').split(/[,;|\s]+/u).filter(Boolean);
const source = ({file,loc,version}) => ({file,loc,version,source:file+' · '+loc});
const unknownImpact = 'Охват и ожидаемый финансовый эффект задачи не оценены.';
const trackingWork = /разметк|отслеживан|(?:передач|сбор|регистраци|уч[её]т|отправк|полнот).{0,45}событи|событи.{0,45}(?:теря|потер|переда|не фикс|регистрац)/iu;

function words(value) {
  return String(value || '').toLowerCase()
    .replace(/каспер[а-яё]*/gu, 'kaspersky')
    .replace(/астр[а-яё]*/gu, 'astra')
    .replace(/\bkes\b/gu, 'kaspersky')
    .match(/[\p{L}\d]+/gu) || [];
}

function familyWords(product) {
  const terms = words(product);
  const alias = terms.find((t) => t === 'kaspersky' || t === 'astra');
  return alias ? [alias] : terms;
}

function mentionsFamily(value, family) {
  const tokens = words(value);
  return family.length > 0 && family.every((word) => tokens.includes(word));
}

// A dictionary entry may describe both families with different restrictions.
function measurementLimit(definition, family) {
  const statements = String(definition?.data.comment || '').split(/[.;!?](?:\s+|$)|\n/u);
  return statements.find((s) => mentionsFamily(s, family) &&
    /не (?:фиксиру|счита|собира|регистрир)|не измеря|недоступ|нет (?:метрик|событи|данных)/iu.test(s));
}

const tier = entry => entry.category === 'Ограничение измерения' ? 0 : 1;

export function backlogRecommendations(tasks, definitions, releases, {
  product, through, historical, releaseId, metricId,
}) {
  const family = familyWords(product);
  const definitionsById = new Map(definitions.map((f) => [f.data.metric_id, f]));
  const release = releases.find((f) => f.data.release_id === releaseId &&
    (!through || f.data.release_date <= through));
  const relatedTasks = ids(release?.data.related_task_ids);
  const affectedMetrics = new Set([...ids(release?.data.affected_metrics), ...ids(metricId)]);
  const recommendations = [];
  for (const f of tasks) {
    const t = f.data;
    if ((historical && !t.created_date) || (through && t.created_date > through)) continue;
    if (t.closed_date && (!through || t.closed_date <= through)) continue;
    if (!t.closed_date && /^(?:done|closed|закрыт[ао]?|завершен[ао]?|завершён[ао]?)$/iu.test(t.status)) continue;
    const byRelease = release && (releaseId === t.release_id || relatedTasks.includes(t.task_id));
    const byProduct = mentionsFamily([t.product, t.product_family, t.title, t.description_short].join(' '), family);
    if (!byProduct && !byRelease) continue;
    const links = ids(t.linked_metric_ids);
    const sources = [source(f)];
    if (byRelease) sources.push(source(release));
    let reason = byRelease ? 'Задача связана с релизом ' + releaseId + '.' : 'В задаче указан продукт ' + product + '.';
    let category = 'Связанная задача';
    const matching = links.filter((id) => affectedMetrics.has(id));
    if (matching.length) reason += ' Общие показатели: ' + matching.join(', ') + '.';
    else if (links.length) reason += ' Показатели задачи: ' + links.join(', ') + '.';
    const diagnosticMetrics = trackingWork.test([t.title, t.description_short].join(' ')) ? links : [];
    for (const id of diagnosticMetrics) {
      if (metricId && !['orders_index', 'family_orders_idx', id].includes(metricId) &&
          !affectedMetrics.has(id)) continue;
      const def = definitionsById.get(id);
      const limit = measurementLimit(def, family);
      if (!limit) continue;
      sources.push(source(def));
      category = 'Ограничение измерения';
      reason += ' Ограничение измерения (' + id + '): ' + limit.trim() + '.';
      break;
    }
    recommendations.push({ key: t.task_id, title: t.title, category, relatedMetrics: matching,
      linkedRelease: byRelease ? releaseId : null, reason: reason + ' ' + unknownImpact,
      source:sources.map(row=>row.source).join(' / '), sourceRefs:sources });
  }
  return recommendations.sort((a, b) => tier(a) - tier(b) ||
    Number(Boolean(b.linkedRelease)) - Number(Boolean(a.linkedRelease)) ||
    (b.relatedMetrics?.length || 0) - (a.relatedMetrics?.length || 0) ||
    a.key.localeCompare(b.key, 'ru', { numeric: true }));
}
