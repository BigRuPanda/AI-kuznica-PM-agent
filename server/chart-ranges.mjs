import { analysis, derive } from './analytics.mjs';
import { DAY } from './import.mjs';
import { digest } from './evidence.mjs';

export function initRanges(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS range_results(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS snapshot_access(id TEXT NOT NULL,scope TEXT NOT NULL,ref TEXT NOT NULL,PRIMARY KEY(id,scope,ref));
    CREATE INDEX IF NOT EXISTS chat_thread_seq ON chat_items(thread,seq);`);
  if (!db.prepare("SELECT 1 FROM settings WHERE key='snapshot_acl_v1'").get()) {
    db.exec(`BEGIN IMMEDIATE;
      INSERT OR IGNORE INTO snapshot_access SELECT json_extract(body,'$.calc'),'thread',thread FROM chat_items WHERE json_type(body,'$.calc')='text';
      INSERT OR IGNORE INTO snapshot_access SELECT json_extract(body,'$.calc'),'case',case_id FROM published WHERE json_type(body,'$.calc')='text';
      INSERT OR IGNORE INTO snapshot_access SELECT json_extract(body,'$.origin.calc'),'case',id FROM cases WHERE json_type(body,'$.origin.calc')='text';
      INSERT OR IGNORE INTO settings VALUES('snapshot_acl_v1','true'); COMMIT;`);
  }
  db.exec(`CREATE TABLE IF NOT EXISTS agent_turns(job TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS agent_steps(job TEXT,signature TEXT,body TEXT NOT NULL,PRIMARY KEY(job,signature));
    CREATE TABLE IF NOT EXISTS agent_previews(id TEXT PRIMARY KEY,owner TEXT,kind TEXT,body TEXT,state TEXT,result TEXT);
    CREATE TABLE IF NOT EXISTS personal_views(user TEXT,case_id TEXT,body TEXT,PRIMARY KEY(user,case_id));`);
}
export function grant(db, id, scope, ref) {
  if (id && ref) db.prepare('INSERT OR IGNORE INTO snapshot_access VALUES(?,?,?)').run(id, scope, ref);
}
export function access(db, user, id, sharedOnly = false) {
  if (
    typeof id !== 'string' ||
    !db
      .prepare(
        `SELECT 1 FROM snapshot_access a
    LEFT JOIN conversations t ON a.scope='thread' AND t.id=a.ref
    LEFT JOIN cases c ON a.scope='case' AND c.id=a.ref
    WHERE a.id=? AND (t.scope='group' OR (c.id IS NOT NULL AND json_extract(c.body,'$.owner') IS NULL)
      OR (?=0 AND ((a.scope='user' AND a.ref=?) OR t.owner=? OR json_extract(c.body,'$.owner')=?))) LIMIT 1`,
      )
      .get(id, sharedOnly ? 1 : 0, user.id, user.id, user.id)
  )
    throw Error('Снимок недоступен в этом контексте.');
}
export function readSnapshot(db, user, id) {
  access(db, user, id);
  const row = db.prepare('SELECT body FROM evidence_calcs WHERE id=?').get(id);
  if (!row) throw Error('Снимок не найден.');
  return JSON.parse(row.body);
}
export function readRange(db, user, id) {
  access(db, user, id);
  const row = db.prepare('SELECT body FROM range_results WHERE id=?').get(id);
  if (!row) throw Error('Выделение не найдено.');
  return { id, ...JSON.parse(row.body) };
}
function normalize(ref, min, max, step, keys) {
  if (!Array.isArray(ref.series) || !ref.series.length || ref.series.some((k) => !keys.includes(k)))
    throw Error('Проверьте ряды графика.');
  const series = keys.filter((k) => ref.series.includes(k));
  if (!Array.isArray(ref.ranges) || ref.ranges.length < 1 || ref.ranges.length > 2)
    throw Error('Выберите один или два периода.');
  const ranges = ref.ranges.map(({ from, to }) => {
    if (
      !Number.isSafeInteger(from) ||
      !Number.isSafeInteger(to) ||
      from < min ||
      to > max ||
      to <= from ||
      (from - min) % step ||
      (to - min) % step ||
      (to - from) / step > 10000
    )
      throw Error('Границы выходят за сохранённый график.');
    return { from, to };
  });
  return { series, ranges };
}
const mean = (rows) => (rows.length ? rows.reduce((a, b) => a + b.value, 0) / rows.length : null);
function weekly(db, user, ref, sharedOnly) {
  access(db, user, ref.calcId, sharedOnly);
  const v = readSnapshot(db, user, ref.calcId);
  if (
    ref.metric !== 'orders_index' ||
    !Array.isArray(v.summary) ||
    v.summary.some((s) => !Array.isArray(s.rows))
  )
    throw Error('Снимок не содержит недельного индекса.');
  const step = 7 * DAY,
    at = (r) => Date.parse(r.week + 'T00:00:00Z');
  const dates = v.summary.flatMap((s) => s.rows.map(at));
  if (!dates.length) throw Error('В снимке нет наблюдений.');
  const { series, ranges } = normalize(
    ref,
    Math.min(...dates),
    Math.max(...dates) + step,
    step,
    v.summary.map((s) => s.product),
  );
  const periods = ranges.map(({ from, to }) => {
    const rows = series.map((key) =>
      v.summary
        .find((s) => s.product === key)
        .rows.filter((r) => at(r) >= from && at(r) < to && Number.isFinite(r.value)),
    );
    const coverage = rows.map((group) => new Set(group.map((r) => r.week)));
    const common = rows[0].map((r) => r.week).filter((w) => coverage.every((set) => set.has(w)));
    return {
      from,
      to,
      expected: (to - from) / step,
      commonDates: common,
      series: series.map((key, i) => ({
        key,
        value: mean(rows[i]),
        available: rows[i].length,
        partial: rows[i].filter((r) => r.partial).length,
        commonValue: mean(rows[i].filter((r) => common.includes(r.week))),
        sources: rows[i].map((r) => ({ date: r.week, location: r.source, version: r.version })),
      })),
    };
  });
  const points = Object.fromEntries(
    series.map((key) => [
      key,
      v.summary
        .find((s) => s.product === key)
        .rows.filter((r) => ranges.some((p) => at(r) >= p.from && at(r) < p.to))
        .map((r) => ({ at: at(r), value: r.value, partial: r.partial, rolling: r.rolling })),
    ]),
  );
  return {
    points,
    step,
    source: 'weekly',
    calcId: ref.calcId,
    version: ref.calcId,
    metric: 'orders_index',
    title: 'Индекс самостоятельных заказов',
    unit: 'п. индекса',
    product: v.product,
    asOf: v.cut,
    filters: { full: v.full, control: v.summary[1]?.product || null },
    series,
    ranges,
    periods,
  };
}
function aggregateChart(db, user, ref, sharedOnly) {
  access(db, user, ref.calcId, sharedOnly);
  const v = readSnapshot(db, user, ref.calcId);
  if (v.kind !== 'metric-chart' || v.metric !== ref.metric || !v.step)
    throw Error('Старый снимок не содержит шага или исходных оснований. Постройте новую версию графика.');
  const step = v.step,
    rows = v.points.map((p) => ({ ...p, at: Date.parse(p.date + 'T00:00:00Z') }));
  const { series, ranges } = normalize(ref, rows[0].at, rows.at(-1).at + step, step, [v.segment]);
  const pairs = {
    lk_reco_ctr: ['click_visits', 'viewed_visits'],
    cfg_reach_rate: ['configurator_visits', 'family_visits'],
    cfg_completion_rate: ['complete', 'open'],
    cfg_back_reset_rate: ['back', 'open'],
    cfg_add_to_cart_rate: ['add_to_cart', 'open'],
  };
  const ratio = v.unit === 'ratio',
    unit = ratio ? '%' : v.unit;
  const periods = ranges.map(({ from, to }) => {
    const group = rows.filter((r) => r.at >= from && r.at < to && Number.isFinite(r.value));
    let n,
      d,
      value = null,
      reason;
    const pair = pairs[v.metric];
    if (!group.length) reason = 'В выбранном периоде нет числовых наблюдений.';
    else if (ratio && pair && group.every((r) => pair.every((k) => Number.isFinite(r.details?.[k])))) {
      n = group.reduce((s, r) => s + r.details[pair[0]], 0);
      d = group.reduce((s, r) => s + r.details[pair[1]], 0);
      value = d ? (100 * n) / d : null;
    } else if (!ratio && ['views', 'visits', 'count', 'events'].includes(v.unit)) {
      value = group.length ? group.reduce((s, r) => s + r.value, 0) : null;
    } else if (group.length === 1) value = group[0].value * (ratio ? 100 : 1);
    else reason = 'Для объединения этих точек нужны исходные наблюдения или определение общей формулы.';
    return {
      from,
      to,
      expected: (to - from) / step,
      series: [
        {
          key: v.segment,
          value,
          n,
          d,
          reason,
          available: group.length,
          partial: group.filter((r) => r.partial).length,
          sources: group.map((r) => ({ date: r.date, location: r.source, version: r.version })),
        },
      ],
    };
  });
  return {
    source: 'metric',
    step,
    version: ref.calcId,
    calcId: ref.calcId,
    metric: v.metric,
    product: v.product,
    title: v.title,
    unit,
    asOf: rows.at(-1).date,
    filters: { segment: v.segment },
    series,
    ranges,
    periods,
    points: {
      [v.segment]: rows
        .filter((r) => ranges.some((p) => r.at >= p.from && r.at < p.to))
        .map((r) => ({
          at: r.at,
          value: r.value == null ? null : r.value * (ratio ? 100 : 1),
          partial: r.partial,
        })),
    },
  };
}
function archived(store, ref) {
  // Legacy release reports and their calculations belong to the authenticated workspace.
  const calc = store.getCalc(ref.calcId);
  if (!['compare_metric', 'build_chart'].includes(calc.op) || !calc.context?.version)
    throw Error('Для этого архивного снимка нет исходной версии событий.');
  const a = analysis(store, calc.context),
    derived = calc.op === 'build_chart',
    index = calc.context.metric;
  const metric = derived ? 'derived' : String(index);
  if (ref.metric !== metric || !a.days.length) throw Error('График не соответствует архивному расчёту.');
  const origin = a.rel.launch,
    card = a.cards[index];
  const { series, ranges } = normalize(
    ref,
    origin + a.days[0] * DAY,
    origin + (a.days.at(-1) + 1) * DAY,
    DAY,
    derived ? ['all'] : Object.keys(card.series),
  );
  const selected = a.orders.filter((o) => a.context.segment === 'all' || o[0] === a.context.segment);
  const { groups, firstSeen } = globalThis.releaseMetrics.partition(selected, a.context.day);
  const periods = ranges.map(({ from, to }) => {
    const lo = (from - origin) / DAY,
      hi = (to - origin) / DAY;
    return {
      from,
      to,
      expected: hi - lo,
      series: series.map((key) => {
        const daily = derived ? calc.result.daily : card.series[key].daily;
        const available = daily.slice(lo - a.first, hi - a.first).filter((r) => r.value !== null).length;
        const incomplete =
          a.v.completed == null ||
          a.v.completed < to ||
          (!derived && index < 2 && (a.cutoff < to + 7 * DAY || a.v.completed < to + 7 * DAY));
        if (derived)
          return { key, ...derive(a, calc.result.spec, { from: lo, to: hi }), available, incomplete };
        const row = globalThis.releaseMetrics.calculate(
          key === 'all' ? selected : groups[key],
          'all',
          lo,
          hi,
          a.context.day,
        )[index];
        const value =
          card.status === 'missing' || (index === 2 && key !== 'all' && firstSeen[key] >= hi * DAY)
            ? null
            : row.value;
        return {
          key,
          value,
          n: row.n,
          d: row.d,
          pending: row.pending,
          available,
          incomplete: incomplete || !!row.pending,
        };
      }),
    };
  });
  const points = Object.fromEntries(
    series.map((key) => [
      key,
      a.days.flatMap((day, i) => {
        const at = origin + day * DAY;
        if (!ranges.some((p) => at >= p.from && at < p.to)) return [];
        const r = derived ? calc.result.daily[i] : card.series[key].daily[i];
        return [
          {
            at,
            value: r.value,
            n: r.n,
            d: r.d,
            partial: !!r.pending || a.v.completed == null || a.v.completed < at + DAY,
          },
        ];
      }),
    ]),
  );
  return {
    points,
    step: DAY,
    source: 'release',
    calcId: ref.calcId,
    version: a.v.id,
    metric,
    title: calc.result.title,
    unit: calc.result.unit,
    product: a.rel.title,
    asOf: new Date(a.cutoff).toISOString(),
    filters: { segment: a.context.segment, releaseId: a.rel.id, launch: origin, day: a.context.day },
    series,
    ranges,
    periods,
  };
}
export function compareRanges(store, user, ref, { sharedOnly = false } = {}) {
  if (
    !ref ||
    typeof ref !== 'object' ||
    typeof ref.calcId !== 'string' ||
    !['weekly', 'release', 'metric'].includes(ref.source)
  )
    throw Error('Требуется ссылка на сохранённый график.');
  const result =
    ref.source === 'weekly'
      ? weekly(store.db, user, ref, sharedOnly)
      : ref.source === 'metric'
        ? aggregateChart(store.db, user, ref, sharedOnly)
        : archived(store, ref);
  if (ref.version && ref.version !== result.version) throw Error('Версия графика изменилась.');
  if (result.periods.length === 2) {
    result.differences = result.series.map((key, i) => {
      const a = result.periods[0].series[i],
        b = result.periods[1].series[i];
      const diff = (x, y) => (x == null || y == null ? null : y - x);
      const change = diff(a.value, b.value);
      return {
        key,
        absolute: change,
        relative: change != null && a.value !== 0 ? (100 * change) / a.value : null,
        commonAbsolute: diff(a.commonValue, b.commonValue),
      };
    });
  }
  const body = JSON.stringify(result),
    id = digest('range/v1/' + body);
  store.db.prepare('INSERT OR IGNORE INTO range_results VALUES(?,?)').run(id, body);
  grant(store.db, id, 'user', user.id);
  return { id, ...result };
}
export function neighboring(store, user, id, sharedOnly = false) {
  const r = readRange(store.db, user, id),
    ref = { source: r.source, calcId: r.calcId, version: r.version, metric: r.metric, series: r.series };
  const first = Math.min(...r.ranges.map((x) => x.from)),
    length = r.ranges.find((x) => x.from === first).to - first;
  let lower,
    upper,
    events = [],
    evidence = [],
    backlog = [],
    gap = '';
  if (sharedOnly && r.source !== 'release') {
    try {
      access(store.db, user, r.calcId, true);
    } catch {
      return { scope: 'Вне выделения', reason: 'В группу опубликованы только выбранные интервалы.' };
    }
  }
  if (r.source === 'weekly') {
    try {
      const v = readSnapshot(store.db, user, r.calcId);
      const weeks = v.summary
        .filter((s) => r.series.includes(s.product))
        .flatMap((s) => s.rows.map((row) => Date.parse(row.week + 'T00:00:00Z')));
      lower = Math.min(...weeks);
      upper = Math.max(...weeks) + r.step;
      events = v.timeline.map((e) => ({
        id: e.data.release_id,
        date: e.data.release_date,
        description: e.data.description,
        source: e.file + ' · ' + e.loc,
      }));
      evidence = v.evidence;
      backlog = v.backlog;
      gap = v.gap;
    } catch {
      return {
        scope: 'Вне выделения',
        reason: 'Доступна только опубликованная часть снимка. Исходный график не опубликован.',
      };
    }
  } else if (r.source === 'metric') {
    const v = readSnapshot(store.db, user, r.calcId);
    lower = Date.parse(v.points[0].date + 'T00:00:00Z');
    upper = Date.parse(v.points.at(-1).date + 'T00:00:00Z') + r.step;
  } else {
    const c = store.getCalc(r.calcId),
      a = analysis(store, c.context);
    lower = a.rel.launch + a.first * DAY;
    upper = a.cutoff;
    events = [{ id: a.rel.id, date: new Date(a.rel.launch).toISOString(), description: a.rel.description }];
  }
  const before = { from: Math.max(lower, first - length), to: first };
  const comparison =
    before.from < before.to && before.to <= upper
      ? compareRanges(store, user, { ...ref, ranges: [before, r.ranges.find((x) => x.from === first)] })
      : null;
  return {
    scope: 'Вне выделения — соседний период и доступные свидетельства',
    sourceCalc: r.source === 'weekly' ? r.calcId : null,
    comparison: comparison
      ? {
          id: comparison.id,
          periods: comparison.periods.map((p) => ({
            from: p.from,
            to: p.to,
            series: p.series.map(({ sources, ...v }) => v),
          })),
        }
      : null,
    events,
    evidence,
    backlog,
    gap,
  };
}
