import { createHash } from 'node:crypto';
export const digest = (value) => createHash('sha256').update(value).digest('hex');
export function productFamily(value = '') {
  const p = value.toLowerCase().trim();
  if (/astra|астр/.test(p)) return 'astra';
  if (/kaspersky|каспер/.test(p)) return 'kaspersky';
  return p;
}
export const metricStepDays = (metric) =>
  ['orders_index', 'family_orders_idx', 'cfg_option_share', 'cfg_step_dropoff', 'lk_reco_ctr'].includes(
    metric,
  )
    ? 7
    : 1;
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
}
export function setting(db, k, fallback) {
  const s = db.prepare('SELECT body FROM settings WHERE key=?').get(k);
  return s ? JSON.parse(s.body) : fallback;
}
export function setSetting(db, k, v) {
  db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k, JSON.stringify(v));
}
export const defaultRules = { threshold: 25, controlTolerance: 10, recovery: 90 };
function identity(f, file) {
  const r = f.row ?? {};
  if (f.kind === 'sales') return JSON.stringify([r.product_family, r.week_start]);
  if (f.kind === 'metrics') return JSON.stringify([r.metric_id, r.date, r.product, r.segment]);
  if (f.kind === 'dictionary') return r.metric_id;
  if (f.kind === 'backlog') return r.task_id;
  if (f.kind === 'releases') return r.release_id;
  return file + '/' + f.loc;
}
export function importDocs(store, docs, { notify = true } = {}) {
  const { db } = store;
  const save = db.prepare(
    'INSERT INTO facts VALUES(?,?,?,?,?,?) ON CONFLICT(kind,key) DO UPDATE SET version=excluded.version,file=excluded.file,loc=excluded.loc,body=excluded.body',
  );
  return store.tx(() => {
    let inserted = 0;
    for (const doc of docs) {
      if (!Array.isArray(doc.facts) || typeof doc.file !== 'string') throw Error('Некорректный документ');
      const version = digest(JSON.stringify(doc));
      if (db.prepare('SELECT 1 FROM documents WHERE version=?').get(version)) continue;
      db.prepare('INSERT INTO documents VALUES(?,?,?,?)').run(
        version,
        doc.file,
        Date.now(),
        JSON.stringify(doc),
      );
      db.prepare("DELETE FROM facts WHERE file=? AND kind IN ('competitor','interview')").run(doc.file);
      for (const f of doc.facts) {
        if (
          !['sales', 'metrics', 'dictionary', 'backlog', 'releases', 'interview', 'competitor'].includes(
            f.kind,
          )
        )
          throw Error('Неизвестный тип данных');
        if (
          f.kind === 'sales' &&
          (!Number.isFinite(f.row.orders_index) || !Number.isFinite(dateMs(f.row.week_start)))
        )
          throw Error('Проверьте дату и индекс продаж в ' + f.loc);
        save.run(f.kind, identity(f, doc.file), version, doc.file, f.loc, JSON.stringify(f.row ?? f.text));
      }
      inserted++;
    }
    if (inserted) scan(db, notify);
    return { inserted, documents: db.prepare('SELECT count(*) n FROM documents').get().n };
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
      version: f.version,
    }))
    .sort((a, b) => a.week.localeCompare(b.week));
}
export function scan(db, notify = true) {
  const all = listSales(db),
    rules = setting(db, 'rules', defaultRules);
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
        run.history.push({ week: w.week, change, value: w.value });
        if (rule === 'absolute' && run.count < 2) continue;
        const id = digest([product, rule, run.start].join('/')).slice(0, 24);
        const desc = rule === 'relative' ? 'Снижение среднего индекса' : 'Индекс ниже порога справочника';
        const info = {
          rule,
          start: run.start,
          week: w.week,
          count: run.count,
          history: run.history,
          change,
          value: w.value,
          threshold: rule === 'relative' ? rules.threshold : Number(absolute[1]),
          source: w.source,
        };
        const existing = db.prepare('SELECT body FROM cases WHERE id=?').get(id);
        const body = { ...(existing ? JSON.parse(existing.body) : {}), signal: info };
        db.prepare(
          'INSERT INTO cases VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body',
        ).run(id, product, desc + ' · ' + product, 'Исследуем', JSON.stringify(body));
        if (run.count === 2) {
          const alert = db
            .prepare('INSERT OR IGNORE INTO alerts VALUES(?,?,?,?)')
            .run(id, id, w.week, JSON.stringify(info));
          if (notify && alert.changes)
            for (const channel of ['telegram', 'smtp']) {
              db.prepare('INSERT OR IGNORE INTO deliveries(id,channel,state,body) VALUES(?,?,?,?)').run(
                id + channel,
                channel,
                'queued',
                JSON.stringify({ caseId: id, text: desc + ' · ' + product + ' · ' + w.week }),
              );
            }
        }
      }
    }
  }
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
  return { ...r, body: JSON.parse(r.body) };
}
export function updateCase(db, c) {
  db.prepare('UPDATE cases SET state=?,body=? WHERE id=?').run(c.state, JSON.stringify(c.body), c.id);
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
export function search(db, query, kinds = ['interview', 'competitor', 'backlog', 'releases'], limit = 8) {
  const words = tokens(query),
    found = [];
  for (const kind of kinds) {
    for (const r of facts(db, kind)) {
      const hay = tokens(JSON.stringify(r.data)).join(' ');
      const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
      const context =
        kind === 'interview' && typeof r.data === 'string' ? (r.data.match(/,/g) || []).length / 12 : 0;
      if (score)
        found.push({
          kind,
          key: r.key,
          score: score + Math.min(context, 0.9),
          source: r.file + ' · ' + r.loc,
          version: r.version,
          data: r.data,
        });
    }
  }
  return found.sort((a, b) => b.score - a.score || a.source.localeCompare(b.source)).slice(0, limit);
}
function salesSummary(all, product, from, to, cut, full) {
  const series = all.filter((x) => x.product === product);
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
export function analysisView(
  db,
  { caseId, product, full = false, control, from, releaseWeek, through, sourceQuery = '' } = {},
) {
  const c = caseId ? getCase(db, caseId) : null,
    all = listSales(db);
  product = c?.product || product || all.at(-1)?.product || '';
  const related = search(db, product, ['releases'], 12);
  const latest = all.filter((x) => x.product === product).at(-1)?.week;
  const anchor = c?.body.signal?.start || latest;
  const release = related
    .filter((x) => String(x.data.release_date) <= String(anchor) && x.data.release_type === 'major')
    .sort((a, b) => b.data.release_date.localeCompare(a.data.release_date))[0];
  const pivot =
    releaseWeek ||
    (release && c?.body.signal?.rule !== 'absolute' ? monday(release.data.release_date) : anchor);
  const base = from || (pivot ? iso(dateMs(pivot) - 13 * WEEK) : '');
  const cut = through || latest;
  const peers = [...new Set(all.map((x) => x.product))].filter((x) => x !== product);
  const compare = control === false ? [] : [control || peers[0]].filter(Boolean);
  const summary = pivot ? [product, ...compare].map((p) => salesSummary(all, p, base, pivot, cut, full)) : [];
  const timeline = pivot
    ? facts(db, 'releases').filter(
        (f) => Math.abs(dateMs(f.data.release_date) - dateMs(pivot)) <= 14 * 86400000,
      )
    : [];
  const ctr = facts(db, 'metrics').filter(
    (f) =>
      f.data.metric_id === 'lk_reco_ctr' &&
      !/неполн/i.test(f.data.comment || '') &&
      (!through || f.data.date <= through),
  );
  const ctrCounts = ctr.reduce(
    (v, f) => {
      const x = JSON.parse(f.data.detail_json || '{}');
      return [v[0] + (x.click_visits || 0), v[1] + (x.viewed_visits || 0)];
    },
    [0, 0],
  );
  const corrections = db
    .prepare('SELECT source,author,comment FROM feedback WHERE product=? ORDER BY id')
    .all(product);
  const latestFeedback = new Map(corrections.map((c) => [c.source, c.comment]));
  const evidence = ['interview', 'competitor', 'backlog'].flatMap((k) =>
    search(db, product + ' ' + String(sourceQuery).slice(0, 400), [k], 12)
      .filter((e) => !latestFeedback.get(e.source)?.startsWith('[Исключить связь]'))
      .slice(0, 3),
  );
  const reach = facts(db, 'metrics').filter(
    (f) =>
      f.data.metric_id === 'cfg_reach_rate' &&
      tokens(product).some((t) => tokens(f.data.product).includes(t)) &&
      (!through || f.data.date <= through),
  );
  const reachCounts = reach.reduce(
    (v, f) => {
      const x = JSON.parse(f.data.detail_json || '{}');
      return [v[0] + (x.configurator_visits || 0), v[1] + (x.family_visits || 0)];
    },
    [0, 0],
  );
  const definition = facts(db, 'dictionary').find((f) => f.data.metric_id === 'cfg_add_to_cart_rate');
  const gap = definition
    ? String(definition.data.comment || '') + ' · ' + definition.file + ' · ' + definition.loc
    : 'Определение события добавления в корзину пока не загружено.';
  const result = {
    product,
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
    backlog: rankBacklog(db, product),
    ctr: { n: ctrCounts[0], d: ctrCounts[1], sources: ctr.map((f) => f.file + ' · ' + f.loc) },
    reach: { n: reachCounts[0], d: reachCounts[1], sources: reach.map((f) => f.file + ' · ' + f.loc) },
    signal: c?.body.signal ?? null,
  };
  const id = digest(JSON.stringify(result));
  db.prepare('INSERT OR IGNORE INTO evidence_calcs VALUES(?,?)').run(id, JSON.stringify(result));
  return { id, ...result };
}
export function rankBacklog(db, product) {
  const ranked = facts(db, 'backlog')
    .filter((f) => !['done', 'closed', 'закрыта'].includes(String(f.data.status).toLowerCase()))
    .map((f) => {
      const task = f.data,
        diagnosis = /ошиб|уч[её]т|аналитик/i.test(task.type + ' ' + task.title);
      const relevant = search(db, product, ['backlog'], 20).some((x) => x.key === f.key);
      const category = diagnosis ? 'Проверить сейчас' : relevant ? 'Готово к разработке' : 'Отложить';
      return {
        key: task.task_id,
        title: task.title,
        category,
        reason: diagnosis
          ? 'Пробел измерения ограничивает проверку гипотезы.'
          : relevant
            ? 'Задача связана с исследуемым продуктом.'
            : 'Прямая связь с текущим сигналом пока не установлена.',
        source: f.file + ' · ' + f.loc,
      };
    });
  const signal = cases(db).find((c) => c.product === product && c.body.signal?.rule === 'relative');
  if (signal)
    ranked.push({
      key: 'Предложение',
      title: 'Проверить путь от выбора до самостоятельного заказа · ' + product,
      category: 'Проверить сейчас',
      reason:
        'Устойчивое изменение индекса. Сверить прохождение пути на разных устройствах и регистрацию его шагов.',
      source: signal.body.signal.source,
    });
  return ranked;
}
export function effect(db, c) {
  const plan = c.body.watch;
  if (!plan) return null;
  const start = iso(dateMs(monday(plan.deployed)) + (monday(plan.deployed) === plan.deployed ? 0 : WEEK));
  const end = iso(dateMs(start) + 3 * WEEK);
  const all = listSales(db),
    collect = (p) => all.filter((x) => x.product === p && !x.partial && x.week >= start && x.week <= end);
  const sample = collect(c.product),
    peer = collect(plan.control);
  if (sample.length < 4 || peer.length < 4)
    return { state: 'Ожидаем данные после исправления', weeks: sample.length, start, end };
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
    ctrl,
    start,
    end,
  };
}
