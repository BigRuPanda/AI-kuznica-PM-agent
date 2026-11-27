import { facts, fmt } from './evidence.mjs';
import { observedEffect } from './effect-plan.mjs';

const clicks = 'lk_reco_click_visits';
const views = 'lk_reco_viewed_visits';
const ctr = 'lk_reco_ctr';
const ids = text => String(text || '').split(/[,;]/).map(id => id.trim()).filter(Boolean);
const source = ({ file, loc, version }) => ({ file, loc, version });
const device = { mobile: 'Телефоны', desktop: 'Компьютеры', tablet: 'Планшеты', all: 'Все устройства' };

export function isAccountFeature({ data }) {
  const metrics = ids(data.affected_metrics);
  return ['minor', 'major'].includes(data.release_type) && /^(выпущен[аоы]?|released)$/iu.test(data.status) &&
    metrics.length > 0 && metrics.every(id => id.startsWith('lk_'));
}

export function accountDataDate(db, releases) {
  const { latest } = db.prepare(`SELECT max(json_extract(body,'$.date')) AS latest FROM facts
    WHERE kind='metrics' AND json_extract(body,'$.product')='ЛК'`).get();
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format();
  return [latest, ...releases.map(row => row.data.release_date)].filter(d => d && d <= today).sort().at(-1) || today;
}

export function recommendationEvidence(db, release, calendar, asOf, {
  segment, baselineWeeks = 2, observationWeeks = 2, from, metricVersions, releaseVersions, dictionaryVersions,
} = {}) {
  if (!release || !ids(release.data.affected_metrics).includes(clicks)) return;
  const sources = new Map();
  const cite = row => { if (row) sources.set(row.version + '/' + row.loc, source(row)); };
  const definitions = facts(db, 'dictionary').filter(row => !dictionaryVersions || dictionaryVersions.includes(row.version));
  cite(definitions.find(row => row.data.metric_id === clicks));
  const deployed = release.data.release_date;
  const available = db.prepare(`SELECT DISTINCT json_extract(body,'$.segment') AS segment FROM facts
    WHERE kind='metrics' AND json_extract(body,'$.product')='ЛК' AND json_extract(body,'$.metric_id')=?
    AND json_extract(body,'$.date')<=? ORDER BY segment`).all(clicks, asOf).map(row => row.segment);
  const segments = !segment || segment === 'all' && !available.includes('all') ? available : [segment];
  const lines = [];
  let unchanged = segments.length > 0;
  let period;
  for (const id of segments) {
    const watch = { deployed, metric: clicks, segment: id, baselineWeeks, observationWeeks };
    const effect = observedEffect(db, { product: 'ЛК', body: { watch } }, asOf);
    const before = effect.baseline, after = effect.observed;
    if (!before || !after) {
      unchanged = false;
      continue;
    }
    if (from && before.from < from) {
      unchanged = false;
      lines.push((device[id] || id) + ' — окно до выкладки выходит за начало выбранного периода.');
      continue;
    }
    const used = [...before.sources, ...after.sources];
    if (metricVersions && used.some(row => !metricVersions.includes(row.version)) ||
        releaseVersions && effect.breaks?.some(row => !releaseVersions.includes(row.version))) {
      unchanged = false;
      lines.push((device[id] || id) + ' — в выбранном снимке нет подтверждённой версии всех строк сравнения.');
      continue;
    }
    period = 'До релиза сравниваем ' + before.from + ' — ' + before.through + ', после — ' + after.from + ' — ' + after.through + '. День выкладки исключён.';
    for (const row of used) cite(row);
    for (const row of effect.breaks || []) cite(row);
    unchanged &&= effect.actual != null && before.value === after.value;
    const change = effect.actual == null
      ? effect.state + '. Покрытие в днях до и после — ' +
        before.count + '/' + before.expected + ' и ' + after.count + '/' + after.expected + '.'
      : 'визиты с кликом ' + fmt(before.total) + ' → ' + fmt(after.total) + ' (' +
        fmt(before.value) + ' → ' + fmt(after.value) + ' в день).';
    lines.push((device[id] || id) + ' — ' + change);
  }
  const tracking = calendar.filter(({ data, version }) => data.release_date <= asOf &&
    (!from || data.release_date >= from) && (!releaseVersions || releaseVersions.includes(version)) && data.release_type === 'analytics' &&
    /^(выпущен[аоы]?|released)$/iu.test(data.status) && ids(data.affected_metrics).includes(views))
    .sort((a,b) => a.data.release_date.localeCompare(b.data.release_date))[0];
  const limitation = 'Частоту переходов (CTR) считают как долю визитов с кликом среди визитов, в которых блок увидели.';
  let conclusion = 'Число визитов с кликом само по себе не показывает, что пользователи стали переходить чаще благодаря обновлению.';
  if (tracking) {
    cite(tracking);
    cite(definitions.find(row => row.data.metric_id === ctr));
    if (tracking.data.release_date > deployed)
      conclusion += ' Просмотры блока начали измерять ' + tracking.data.release_date + ' (' + tracking.data.release_id +
        '), поэтому сравнить CTR до и после этой выкладки нельзя.';
  } else conclusion += ' В доступном на эту дату календаре нет подтверждения начала учёта просмотров блока.';
  const summary = unchanged ? 'Среднее число визитов с кликом в день осталось прежним по каждому из указанных устройств.' : null;
  return { lines: [summary, period, ...lines, !lines.length && 'В срезе ещё нет данных о визитах с кликом.', limitation, conclusion].filter(Boolean),
    sources: [...sources.values()] };
}
