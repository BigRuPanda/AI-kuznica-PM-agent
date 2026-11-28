import { createHash } from 'node:crypto';
import { planWatch, prepareMeasurement, measuredEffect, measuredSignal, legacyOrderMetric, watchKind } from './watch-measurement.mjs';
import { observedEffect } from './effect-plan.mjs';
import {initResearchSearch, removeResearchIndex, indexResearchFile, searchResearch} from './research-search.mjs';
import { initSignalHistory, reconcileSignals } from './signal-history.mjs';
import { initInvestigations, syncInvestigations } from './case-investigations.mjs';
import { getMetricEpisodes } from './metric-rules.mjs';
import { aggregateMetric, defaultStepDays, normalizeObservation, observationKey } from './metric-observations.mjs';
import { backlogRecommendations } from './backlog.mjs';
import { withArchivedSignalSources } from './knowledge.mjs';
import { released } from './release-decision.mjs';
import { ensureReleaseCase, releaseInvestigationInput } from './release-cases.mjs';
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function productFamily(value = '') {
  const p = value.toLowerCase().trim();
  if (/astra|астр/.test(p)) return 'astra';
  if (/kaspersky|каспер/.test(p)) return 'kaspersky';
  return p;
}
export const metricStepDays = defaultStepDays;
const WEEK = 7 * 86400000;
const dateMs = (s) => Date.parse(s + 'T00:00:00Z');
const iso = (t) => new Date(t).toISOString().slice(0, 10);
const avg = (a) => (a.length ? a.reduce((s, r) => s + Number(r.value), 0) / a.length : null);
const delta = (v, b) => (b > 0 && v !== null ? (v / b - 1) * 100 : null);
const monday = (d) => {
  const t = dateMs(d);
  return iso(t - ((new Date(t).getUTCDay() + 6) % 7) * 86400000);
};
export const fmt = (n) => (n == null ? '—' : Number(n).toLocaleString('ru-RU', { maximumFractionDigits: 2 }));

export function initEvidence(db) {
  db.exec(
    'CREATE TABLE IF NOT EXISTS documents(version TEXT PRIMARY KEY,file TEXT NOT NULL,created INTEGER NOT NULL,body TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS facts(kind TEXT NOT NULL,key TEXT NOT NULL,version TEXT NOT NULL,file TEXT NOT NULL,loc TEXT NOT NULL,body TEXT NOT NULL, PRIMARY KEY(kind,key));' +
      'CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY,body TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS cases(id TEXT PRIMARY KEY,product TEXT NOT NULL,title TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS alerts(id TEXT PRIMARY KEY,case_id TEXT NOT NULL,week TEXT NOT NULL,body TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS deliveries(id TEXT PRIMARY KEY,channel TEXT NOT NULL,state TEXT NOT NULL,body TEXT NOT NULL,attempts INTEGER DEFAULT 0,next INTEGER DEFAULT 0);' +
      'CREATE TABLE IF NOT EXISTS evidence_calcs(id TEXT PRIMARY KEY,body TEXT NOT NULL);' +
      'CREATE TABLE IF NOT EXISTS feedback(id INTEGER PRIMARY KEY,source TEXT NOT NULL,product TEXT NOT NULL,author TEXT NOT NULL,comment TEXT NOT NULL,created INTEGER NOT NULL);',
  );
  initResearchSearch(db);
  initSignalHistory(db);
  initInvestigations(db);
  if (!db.prepare("SELECT 1 FROM settings WHERE key='observation_schema_v2'").get()) {
    db.exec('SAVEPOINT migrate_metric_observations');
    try {
      db.prepare("DELETE FROM facts WHERE kind='metrics'").run();
      const save = db.prepare("INSERT OR REPLACE INTO facts VALUES('metrics',?,?,?,?,?)");
      for (const doc of db.prepare('SELECT version,file,body FROM documents ORDER BY rowid').iterate()) {
        for (const item of JSON.parse(doc.body).facts) {
          if (item.kind !== 'metrics') continue;
          const row = normalizeObservation(item.row, doc.file);
          save.run(observationKey(row), doc.version, doc.file, item.loc, JSON.stringify(row));
        }
      }
      setSetting(db, 'observation_schema_v2', true);
      db.exec('RELEASE migrate_metric_observations');
    } catch (error) {
      db.exec('ROLLBACK TO migrate_metric_observations; RELEASE migrate_metric_observations');
      throw error;
    }
  }
}
export function setting(db, k, fallback) {
  const s = db.prepare('SELECT body FROM settings WHERE key=?').get(k);
  return s ? JSON.parse(s.body) : fallback;
}
export function setSetting(db, k, v) {
  db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k, JSON.stringify(v));
}
export const defaultRules = { threshold: 25, controlTolerance: 10, recovery: 90 };
export function identity(f, file) {
  const r = f.row ?? {};
  if (f.kind === 'sales') return JSON.stringify([r.product_family, r.week_start]);
  if (f.kind === 'metrics') return observationKey(normalizeObservation(r, file));
  if (f.kind === 'dictionary') return r.metric_id;
  if (f.kind === 'backlog') return r.task_id;
  if (f.kind === 'releases') return r.release_id;
  return file + '/' + f.loc;
}
export function importDocs(store, docs, { notify = true, onImported, guard } = {}) {
  const { db } = store;
  const save = db.prepare(
    'INSERT INTO facts VALUES(?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET version=excluded.version,file=excluded.file,loc=excluded.loc,body=excluded.body',
  );
  return store.tx(() => {
    const imported = [];
    if (guard?.(db) === false) return {inserted:0, documents:db.prepare("SELECT count(*) n FROM documents").get().n};
    const releaseBefore = db.prepare("SELECT body FROM facts WHERE kind='releases' AND key=?");
    const previouslyReleased = new Map();
    for (const doc of docs) {
      if (!Array.isArray(doc.facts) || typeof doc.file !== 'string') throw Error('Некорректный документ');
      const version = digest(JSON.stringify(doc));
      const researchOnly = doc.facts.every(f => ['interview','competitor','reference'].includes(f.kind));
      const archived = db.prepare('SELECT 1 FROM documents WHERE version=?').get(version);
      if (archived) {
        if (!researchOnly || db.prepare('SELECT version FROM research_file_versions WHERE file=?').get(doc.file)?.version === version) continue;
      } else {
        db.prepare('INSERT INTO documents VALUES(?,?,?,?)').run(version, doc.file, Date.now(), JSON.stringify(doc));
      }
      // Old official ZIP imports stored these nested interview workbooks by basename.
      // Their archived documents and any already published snapshot keep their old addresses.
      const oldFiles = doc.legacyInterviewFile ? [doc.file, doc.legacyInterviewFile] : [doc.file];
      for (const file of oldFiles) {
        removeResearchIndex(db, file);
        db.prepare("DELETE FROM facts WHERE file=? AND kind IN ('competitor','interview','reference')").run(file);
        if (file !== doc.file) db.prepare('DELETE FROM research_file_versions WHERE file=?').run(file);
      }
      for (const f of doc.facts) {
        if (
          !['sales', 'metrics', 'dictionary', 'backlog', 'releases', 'interview', 'competitor', 'reference'].includes(
            f.kind,
          )
        )
          throw Error('Неизвестный тип данных');
        if (
          f.kind === 'sales' &&
          (!Number.isFinite(f.row.orders_index) || !Number.isFinite(dateMs(f.row.week_start)))
        )
          throw Error('Проверьте дату и индекс продаж в ' + f.loc);
        const body = f.kind === 'metrics' ? normalizeObservation(f.row, doc.file) : f.row ?? f.text;
        const key = f.kind === 'metrics' ? observationKey(body) : identity(f, doc.file);
        if (f.kind === 'releases' && !previouslyReleased.has(key)) {
          const previous = releaseBefore.get(key);
          previouslyReleased.set(key, previous ? released({ data: JSON.parse(previous.body) }) : false);
        }
        save.run(f.kind, key, version, doc.file, f.loc, JSON.stringify(body));
      }
      indexResearchFile(db, doc.file);
      if (researchOnly) db.prepare('INSERT OR REPLACE INTO research_file_versions VALUES(?,?)').run(doc.file, version);
      else db.prepare('DELETE FROM research_file_versions WHERE file=?').run(doc.file);
      imported.push({file:doc.file, version});
    }
    for (const [releaseId, wasReleased] of previouslyReleased) {
      if (wasReleased) continue;
      const input = releaseInvestigationInput(db, releaseId);
      if (input) ensureReleaseCase(db, input);
    }
    if (imported.length) scan(db, notify, imported);
    onImported?.();
    return { inserted:imported.length, documents: db.prepare('SELECT count(*) n FROM documents').get().n };
  });
}
export function facts(db, kind) {
  return db
    .prepare('SELECT key,version,file,loc,body FROM facts WHERE kind=? ORDER BY key')
    .all(kind)
    .map(({ body, ...meta }) => ({ ...meta, data: JSON.parse(body) }));
}
export function listSales(db) {
  return facts(db, 'sales')
    .map((f) => ({
      product: f.data.product_family,
      week: f.data.week_start,
      value: f.data.orders_index,
      partial: /неполн/i.test(f.data.comment || ''),
      source: f.file + ' · ' + f.loc,
      file: f.file,
      loc: f.loc,
      version: f.version,
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}
export function scan(db, notify = true, imported = []) {
  const all = listSales(db),
    rules = setting(db, 'rules', defaultRules);
  const episodes = new Map();
  const def = facts(db, 'dictionary').find((f) => f.data.metric_id === 'family_orders_idx');
  const absolute = def?.data.bad_signal?.match(/ниже\s+(\d+(?:[.,]\d+)?)\s+две недели подряд/i);
  for (const product of new Set(all.map((r) => r.product))) {
    const rows = all.filter((r) => r.product === product && !r.partial);
    const previous = { relative: null, absolute: null };
    for (let i = 0; i < rows.length; i++) {
      const w = rows[i],
        span = rows.slice(Math.max(0, i - 15), i + 1);
      let change = null;
      if (span.length === 16 && dateMs(w.week) - dateMs(span[0].week) === 15 * WEEK)
        change = delta(avg(span.slice(12)), avg(span.slice(0, 12)));
      for (const rule of ['relative', 'absolute']) {
        const active =
          rule === 'relative'
            ? change !== null && change <= -rules.threshold
            : absolute && w.value < Number(absolute[1].replace(',', '.'));
        if (!active) {
          previous[rule] = null;
          continue;
        }
        let run = previous[rule];
        if (!run || dateMs(w.week) - dateMs(run.last) !== WEEK)
          run = { start: w.week, count: 0, history: [] };
        run.count++;
        run.last = w.week;
        previous[rule] = run;
        run.history.push({ week: w.week, change, value: w.value, version: w.version, source: w.source });
        if (rule === 'absolute' && run.count < 2) continue;
        const desc = rule === 'relative' ? 'Снижение среднего индекса' : 'Индекс ниже порога справочника';
        const info = {
          product,
          title: desc,
          rule,
          start: run.start,
          week: w.week,
          count: run.count,
          history: run.history,
          change,
          value: w.value,
          confirmedWeek: run.history[1]?.week,
          threshold: rule === 'relative' ? rules.threshold : Number(absolute[1].replace(',', '.')),
          source: w.source,
        };
        episodes.set(JSON.stringify([product,rule,run.start]), info);
      }
    }
  }
  reconcileSignals(db, [...episodes.values(), ...getMetricEpisodes(db)], notify, imported);
  syncInvestigations(db);
}
export function cases(db) {
  return db
    .prepare('SELECT * FROM cases ORDER BY rowid DESC')
    .all()
    .map((r) => ({ ...r, body: JSON.parse(r.body) }));
}
export function getCase(db, id) {
  const r = db.prepare('SELECT * FROM cases WHERE id=?').get(id);
  if (!r) throw Error('Разбор не найден');
  const body = JSON.parse(r.body);
  if (body.signal) body.signal = withArchivedSignalSources(db,body.signal);
  return { ...r, body };
}
export function updateCase(db, c) {
  // A PM can save a plan or note from a case opened before the latest source correction.
  db.prepare(`UPDATE cases SET state=?,body=CASE WHEN json_type(body,'$.signal')='object'
    THEN json_set(?, '$.signal', json_extract(body,'$.signal')) ELSE ? END WHERE id=?`)
    .run(c.state, JSON.stringify(c.body), JSON.stringify(c.body), c.id);
}
function tokens(input) {
  return [
    ...new Set(
      String(input)
        .toLowerCase()
        .replace(/каспер[а-я]*/g, 'kaspersky')
        .replace(/астр[а-я]*/g, 'astra')
        .replace(/\bkes\b/g, 'kaspersky')
        .match(/[\p{L}\d-]{3,}/gu) || [],
    ),
  ];
}
export function search(db, query, kinds = ['interview', 'competitor', 'backlog', 'releases'], limit = 8, { asOf, excluded = [] } = {}) {
  checkDate(asOf);
  const words = tokens(query),
    found = searchResearch(db, query, kinds, limit, asOf, excluded);
  for (const kind of kinds.filter(k => k !== 'interview' && k !== 'competitor')) {
    for (const r of facts(db, kind)) {
      const date = kind === 'backlog' ? r.data.created_date : kind === 'releases' ? r.data.release_date : undefined;
      if (asOf && ['backlog','releases'].includes(kind) && (!date || date > asOf)) continue;
      const source = r.file + ' · ' + r.loc;
      if (excluded.includes(source)) continue;
      const hay = tokens(JSON.stringify(r.data)).join(' ');
      const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      if (score)
        found.push({
          kind,
          key: r.key,
          score,
          source, file:r.file, loc:r.loc,
          version: r.version,
          data: r.data,
        });
    }
  }
  return found.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source)).slice(0, limit);
}
function sourceCorrections(db, product) {
  return db.prepare('SELECT source,author,comment FROM feedback WHERE product=? ORDER BY id').all(product);
}
function excludedSources(corrections) {
  const latest = new Map(corrections.map(c => [c.source, c.comment]));
  return [...latest].filter(([, comment]) => comment.startsWith('[Исключить связь]')).map(([source]) => source);
}
export function caseEvidenceSearch(db, product, query, kinds, asOf) {
  return search(db, query, kinds, 8, { asOf, excluded: excludedSources(sourceCorrections(db, product)) });
}
function salesSummary(all, product, from, to, cut, full) {
  const series = all.filter((x) => x.product === product && x.week >= from && dateMs(x.week) + WEEK - 86400000 <= dateMs(cut));
  const before = series.filter((r) => r.week >= from && r.week < to && !r.partial);
  const after = series.filter((r) => r.week > to && r.week <= cut && (!full || !r.partial));
  const transition = series.filter((r) => r.week === to && r.week <= cut && (!full || !r.partial));
  const rows = [...before, ...transition, ...after].map((row) => {
    const group = series.filter(
      (r) => !r.partial && r.week <= row.week && dateMs(row.week) - dateMs(r.week) < 4 * WEEK,
    );
    return { ...row, rolling: group.length === 4 ? avg(group) : null };
  });
  return {
    product,
    before: avg(before),
    after: avg(after),
    change: delta(avg(after), avg(before)),
    baseWeeks: before.length,
    weeks: after.length,
    rows,
  };
}
function checkDate(value) {
  if (value !== undefined && (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
      !Number.isFinite(dateMs(value)) || iso(dateMs(value)) !== value))
    throw Error('Укажите календарную дату в формате ГГГГ-ММ-ДД.');
}
function ratioCard(rows, metric, limits, selection) {
  const available = aggregateMetric(rows, metric, limits);
  const result = selection ? aggregateMetric(rows, metric, { ...limits, ...selection }) : available;
  const selected = result.selectedRows.map(({date,numerator,denominator,source,file,loc,version}) => ({
    date, n:numerator, d:denominator, source, file, loc, version,
  }));
  return { n: result.n, d: result.d, reason: result.reason,
    ...(available.choices.length && {choices: available.choices}),
    ...(selection && {selection}),
    rows: selected, sources: selected.map(r => r.source) };
}
export function analysisView(
  db,
  { caseId, product, full = false, control, from, releaseWeek, through, sourceQuery = '', ratioSelections = {} } = {},
) {
  for (const date of [from, through, releaseWeek]) checkDate(date);
  if (from && through && from > through) throw Error('Начало периода должно быть не позже конца.');
  const c = caseId ? getCase(db, caseId) : null,
    all = listSales(db);
  product = c?.product || product || all.at(-1)?.product || '';
  const metrics = facts(db, 'metrics').map(({data,file,loc,version}) => ({
    ...data, source: file + ' · ' + loc, file, loc, version,
  }));
  const reported = all.filter(x => x.product === product);
  const latestWeek = reported.at(-1)?.week;
  const latestDay = metrics.reduce((max, r) => {
    const observed = dateMs(r.date) + ((r.step_days || metricStepDays(r.metric_id)) - 1) * 86400000;
    return Number.isFinite(observed) ? Math.max(max, observed) : max;
  }, -Infinity);
  const cut = through || [latestWeek && iso(dateMs(latestWeek) + WEEK - 86400000),
    Number.isFinite(latestDay) && iso(latestDay)].filter(Boolean).sort().at(-1) || '';
  const related = search(db, product, ['releases'], Number.MAX_SAFE_INTEGER, { asOf: through });
  const weekEnded = week => dateMs(week) + WEEK - 86400000 <= dateMs(cut);
  const latest = reported.filter(x => weekEnded(x.week) && (!through || !full || !x.partial)).at(-1)?.week;
  let signal = c?.body.signal ?? null;
  if (through && signal && !weekEnded(signal.week)) {
    const history = (signal.history || []).filter(row => weekEnded(row.week));
    const last = history.at(-1);
    signal = history.length >= (signal.rule === 'absolute' ? 2 : 1)
      ? { ...signal, ...last, history, count: history.length, source: reported.find(row => row.week === last.week)?.source ?? null }
      : null;
  }
  const anchor = signal?.start || latest || (!through && cut ? monday(cut) : '');
  const release = related
    .filter((x) => x.data.release_date <= anchor && x.data.release_type === 'major')
    .sort((a, b) => b.data.release_date.localeCompare(a.data.release_date))[0];
  const pivot =
    releaseWeek ||
    (release && signal?.rule !== 'absolute' ? monday(release.data.release_date) : anchor);
  const base = from || (pivot ? iso(dateMs(pivot) - 13 * WEEK) : '');
  const peers = [...new Set(all.map((x) => x.product))].filter((x) => x !== product);
  const compare = control === false ? [] : [control || peers[0]].filter(Boolean);
  const summary = pivot ? [product, ...compare].map((p) => salesSummary(all, p, base, pivot, cut, full)) : [];
  const timeline = pivot
    ? facts(db, 'releases').filter(
        (f) => f.data.release_date >= base && f.data.release_date <= cut &&
          Math.abs(dateMs(f.data.release_date) - dateMs(pivot)) <= 14 * 86400000,
      )
    : [];
  const limits = { from: base || undefined, through: cut || undefined };
  const kpi = c?.body.watch?.measurement || c?.body.plan?.measurement;
  const ctrSeries = kpi?.metric === 'lk_reco_ctr' ? kpi : signal?.metric === 'lk_reco_ctr' ? signal : null;
  const ctr = ratioCard(metrics.filter(r => !full || !r.partial && !/неполн/i.test(r.comment || '')), 'lk_reco_ctr', limits,
    ratioSelections.ctr || (ctrSeries && { product: ctrSeries.product || product, segment: ctrSeries.segment,
      sourceId: ctrSeries.sourceId, definitionId: ctrSeries.definitionId }));
  const corrections = sourceCorrections(db, product);
  const excluded = excludedSources(corrections);
  const evidence = ['interview', 'competitor', 'backlog'].flatMap((k) =>
    search(db, product + ' ' + String(sourceQuery).slice(0, 400), [k], 12, { asOf: through, excluded }).slice(0, 3),
  );
  const reach = ratioCard(metrics.filter(r => product && productFamily(r.product) === productFamily(product) &&
    (!full || !/неполн/i.test(r.comment || ''))), 'cfg_reach_rate', limits, ratioSelections.reach);
  const definition = facts(db, 'dictionary').find((f) => f.data.metric_id === 'cfg_add_to_cart_rate');
  const gap = definition
    ? String(definition.data.comment || '') + ' · ' + definition.file + ' · ' + definition.loc
    : 'Определение события добавления в корзину пока не загружено.';
  const watch = c?.body.watch;
  const archiveObservation = watchKind(watch) === 'archive-observation';
  const result = {
    product,
    calendarPeriod: true,
    requested: { from, through, releaseWeek },
    asOf: through,
    releaseVersions: db.prepare("SELECT version FROM documents WHERE version IN (SELECT version FROM facts WHERE kind='releases') ORDER BY rowid")
      .all().map(row => row.version),
    metricVersions: db
      .prepare(
        "SELECT version FROM documents WHERE version IN (SELECT version FROM facts WHERE kind='metrics') ORDER BY rowid",
      )
      .all()
      .map((row) => row.version),
    base,
    pivot,
    cut,
    full,
    summary,
    timeline,
    evidence,
    corrections,
    gap,
    backlog: rankBacklog(db, product, {
      through: cut, historical: Boolean(through),
      releaseId: c?.body.release || release?.data.release_id,
      metricId: c?.body.plan?.measurement?.metric || signal?.metric || c?.body.plan?.metric,
      signal,
    }),
    ctr,
    reach,
    signal: signal ?? null,
    ...(watch && { monitoring: {
      ...(archiveObservation && { kind: 'archive-observation' }),
      plan: watch,
      result: effect(db, c, through),
    } }),
  };
  const id = digest(JSON.stringify(result));
  db.prepare('INSERT OR IGNORE INTO evidence_calcs VALUES(?,?)').run(id, JSON.stringify(result));
  return { id, ...result };
}
export function rankBacklog(db, product, context = {}) {
  const signal = context.signal || cases(db).find((c) => c.product === product &&
    c.body.signal?.rule === 'relative' && c.body.signal.status !== 'withdrawn' &&
    (!context.through || c.body.signal.week <= context.through))?.body.signal;
  return backlogRecommendations(facts(db, 'backlog'), facts(db, 'dictionary'), facts(db, 'releases'), {
    ...context, product, signal,
  });
}
function measurementRows(db, spec) {
  return spec.metric === 'orders_index' ? listSales(db) : facts(db, 'metrics')
    .filter(f => f.data.metric_id === spec.metric)
    .map(f => ({ ...f.data, version: f.version, evidenceSource: f.file + ' · ' + f.loc }));
}
export function createMeasurementWatch(db, spec, deployed) {
  return planWatch(measurementRows(db, spec), spec, deployed, setting(db, 'rules', defaultRules).controlTolerance);
}
export function createMeasurementAgreement(db, spec) {
  return prepareMeasurement(measurementRows(db, spec), spec, setting(db, 'rules', defaultRules).controlTolerance, true);
}
export function effect(db, c, through) {
  const plan = c.body.watch;
  if (!plan) return null;
  const kind = watchKind(plan);
  if (kind === 'measurement') return measuredEffect(measurementRows(db, plan.measurement), plan, through);
  if (kind === 'archive-observation') return observedEffect(db, c, through);
  if (c.body.plan?.measurement || measuredSignal(c.body.signal?.metric) || !legacyOrderMetric(c.body.plan?.metric))
    return { state: 'Уточните метрику наблюдения',
      reason: 'В прошлой версии записан индекс заказов. Назначьте проверку с критерием для нужной метрики.',
      metric: c.body.plan?.measurement?.metric || c.body.signal?.metric, actual: null, weeks: 0, controlWeeks: 0 };
  const start = iso(dateMs(monday(plan.deployed)) + (monday(plan.deployed) === plan.deployed ? 0 : WEEK));
  const end = iso(dateMs(start) + 3 * WEEK);
  const cutoff = through ? dateMs(through) : null;
  const all = listSales(db),
    collect = (p) => all.filter((x) => x.product === p && !x.partial && x.week >= start && x.week <= end &&
      (cutoff === null || (new Date(dateMs(x.week)).getUTCDay() === 1 && dateMs(x.week) + 6 * 86400000 <= cutoff)));
  const sample = collect(c.product),
    peer = collect(plan.control);
  if (sample.length < 4 || peer.length < 4)
    return { state: 'Ожидаем данные после исправления', weeks: sample.length, controlWeeks: peer.length, start, end };
  const actual = avg(sample),
    ctrl = delta(avg(peer), plan.controlBase);
  return {
    state:
      Math.abs(ctrl) > plan.tolerance
        ? 'Изменился контроль — требуется проверка'
        : actual >= plan.target
          ? 'Цель достигнута'
          : 'Пересмотреть гипотезу',
    actual,
    weeks: sample.length,
    controlWeeks: peer.length,
    ctrl,
    start,
    end,
  };
}
