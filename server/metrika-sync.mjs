import { digest, importDocs, setSetting } from './evidence.mjs';
import { metrika } from './connectors.mjs';
import { observationWithin } from './metric-observations.mjs';
import { notificationChannels } from './data-profile.mjs';

const active = new WeakMap();
const day = 86400000;
const iso = (time) => new Date(time).toISOString().slice(0, 10);
const addDays = (date, n) => iso(Date.parse(date + 'T00:00:00Z') + n * day);
const weekday = (date) => new Date(date).getUTCDay();

export function initMetrikaSync(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS metrika_sync_runs(
    id INTEGER PRIMARY KEY, source TEXT NOT NULL, start_date TEXT NOT NULL, end_date TEXT NOT NULL,
    started INTEGER NOT NULL, finished INTEGER, state TEXT NOT NULL, rows_read INTEGER, observed TEXT,
    lag INTEGER, sample_share REAL, pages INTEGER, reason TEXT);
    CREATE INDEX IF NOT EXISTS metrika_sync_by_source ON metrika_sync_runs(source,id);`);
  const recovered = db.prepare("UPDATE metrika_sync_runs SET state='error',finished=?,reason='Процесс прервался до завершения импорта' WHERE state='running'")
    .run(Date.now());
  if (recovered.changes) setSetting(db,'last_metrika_sync',{at:0,status:'error'});
}

function absoluteDate(expression, today) {
  if (expression === 'today') return today;
  if (expression === 'yesterday') return addDays(today, -1);
  const match = /^(\d+)daysAgo$/i.exec(expression);
  if (match) return addDays(today, -Number(match[1]));
  if (/^\d{4}-\d\d-\d\d$/.test(expression) && Number.isFinite(Date.parse(expression)) && iso(Date.parse(expression)) === expression)
    return expression;
  throw Error('Проверьте дату отчёта Метрики: используйте YYYY-MM-DD, today, yesterday или NdaysAgo.');
}

function sources(env, now) {
  if (!env.METRIKA_COUNTER_IDS && !env.METRIKA_TOKEN) return [];
  if (!/^\d+(,\d+)*$/.test(env.METRIKA_COUNTER_IDS || '')) throw Error('Проверьте METRIKA_COUNTER_IDS');
  let maps;
  try {
    maps = JSON.parse(env.METRIKA_REPORTS_JSON || '[{"id":"visits","metric":"ym:s:visits","unit":"visits"}]');
  } catch {
    throw Error('Проверьте JSON в настройке METRIKA_REPORTS_JSON');
  }
  if (!Array.isArray(maps) || !maps.length) throw Error('В METRIKA_REPORTS_JSON нужен хотя бы один отчёт');
  const timeZone = env.METRIKA_TIME_ZONE || 'Europe/Moscow';
  const today = new Intl.DateTimeFormat('sv-SE', {
    timeZone, year:'numeric', month:'2-digit', day:'2-digit',
  }).format(now);
  const counters = new Set(env.METRIKA_COUNTER_IDS.split(','));
  return [...counters].flatMap((counter) => maps.map((map) => {
    if (!map || typeof map.id !== 'string' || !map.id.trim()) throw Error('Отчёту Метрики нужен id');
    if (map.dimensions != null && typeof map.dimensions !== 'string') throw Error('Проверьте группировки отчёта Метрики');
    if (Array.isArray(map.disjointCounters) && map.disjointCounters.some(id => !counters.has(String(id))))
      throw Error('Все счётчики из disjointCounters должны быть указаны в METRIKA_COUNTER_IDS');
    const {date1, date2, ...definition} = map;
    let from = absoluteDate(date1 || '30daysAgo', today);
    let to = absoluteDate(date2 || 'yesterday', today);
    if (from > to) throw Error('Начало отчёта Метрики позже его окончания');
    const weekly = map.dimensions?.split(',')[0] === 'ym:s:startOfWeek';
    if (weekly) {
      from = addDays(from, (8 - weekday(from)) % 7);
      if (to >= today) to = addDays(today, -1);
      to = addDays(to, -weekday(to));
    }
    const key = digest(JSON.stringify([counter, Object.entries(definition).sort(([a],[b]) => a.localeCompare(b)),
      timeZone, env.METRIKA_REPLAY_ORIGIN || '']));
    return { key, counter, map, from, to, weekly };
  }));
}

function coverage(db, key) {
  return db.prepare(`SELECT max(id) lastGood,min(start_date) coveredFrom,max(end_date) coveredThrough,
    max(finished) lastSuccess,max(observed) lastObservation FROM metrika_sync_runs
    WHERE source=? AND state IN ('ready','empty')`).get(key);
}

function history(db, key) {
  return db.prepare(`SELECT start_date AS "from",end_date AS "to", started,finished,state,rows_read AS rows,
    observed,lag,sample_share AS sampleShare,pages,reason FROM metrika_sync_runs
    WHERE source=? ORDER BY id DESC LIMIT 8`).all(key);
}

export function metrikaStatus(db, env, now = Date.now()) {
  let configured;
  try { configured = sources(env, now); }
  catch (e) { return { reports: [], configurationError: e.message }; }
  const interval = Number(env.METRIKA_SYNC_MINUTES) * 60000;
  const reports = configured.map(({ key,counter,map,from,to }) => {
    const {lastGood, ...confirmed} = coverage(db,key);
    const attempts = history(db,key);
    const waitingForPeriod = from > to;
    const stale = !waitingForPeriod && (attempts[0]?.state === 'error' || !confirmed.coveredThrough ||
      confirmed.coveredFrom > from || confirmed.coveredThrough < to ||
      (interval >= 300000 && now - confirmed.lastSuccess > 2 * interval));
    return { counter, report: map.id, replay: Boolean(env.METRIKA_REPLAY_ORIGIN),
      expectedThrough: waitingForPeriod ? null : to, waitingForPeriod, stale,
      lastAttempt: attempts[0]?.started ?? null, ...confirmed, attempts };
  });
  return { reports, ...(configured.length && !env.METRIKA_TOKEN ? {configurationError:'Токен Метрики не задан'} : {}) };
}

async function synchronize(store, env, send, clock) {
  const {db} = store;
  const totals = {inserted:0,samples:[]};
  const errors = [];
  const at = clock();
  setSetting(db,'last_metrika_sync',{at,status:'running'});
  try {
    const configured = sources(env, at);
    if (!env.METRIKA_TOKEN || !configured.length) throw Error('Заполните METRIKA_TOKEN');
    for (const {counter, map, key, from, to, weekly} of configured) {
      if (from > to) continue;
      const previous = coverage(db,key);
      const pending = db.prepare('SELECT min(start_date) firstDate FROM metrika_sync_runs WHERE source=? AND id>?')
        .get(key,previous.lastGood || 0).firstDate;
      // Re-read the configured overlap for late corrections and bridge a gap even after a long outage.
      let start = [from,pending,previous.coveredThrough && addDays(previous.coveredThrough,1)].filter(Boolean).sort()[0];
      while (start <= to) {
        const end = [to,addDays(start,weekly ? 27 : 30)].sort()[0];
        const attempt = db.prepare(`INSERT INTO metrika_sync_runs(source,start_date,end_date,started,state)
          VALUES(?,?,?,?,'running')`).run(key,start,end,clock()).lastInsertRowid;
        try {
          const requestEnv = Object.create(env, {
            METRIKA_COUNTER_IDS: {value:counter},
            METRIKA_REPORTS_JSON: {value:JSON.stringify([{...map,date1:start,date2:end}])},
          });
          const {docs,samples} = await metrika(requestEnv,send);
          const entries = docs.flatMap(d => d.facts);
          if (entries.some(({row}) => !observationWithin(row,start,end) || (weekly && weekday(row.date) !== 1)))
            throw Error('Метрика вернула наблюдение за пределами запрошенного периода или неполную неделю.');
          const observed = entries.reduce((latest,f) => f.row?.date > (latest || '') ? f.row.date : latest,null);
          const lags = samples.map(s => s.lag).filter(Number.isFinite);
          const shares = samples.map(s => s.share).filter(Number.isFinite);
          const result = importDocs(store,entries.length ? docs : [],{
            notify: notificationChannels(env),
            onImported: () => db.prepare(`UPDATE metrika_sync_runs SET state=?,finished=?,rows_read=?,
              observed=?,lag=?,sample_share=?,pages=? WHERE id=?`).run(entries.length?'ready':'empty',
              clock(),entries.length,observed,lags.length?Math.max(...lags):null,shares.length?Math.min(...shares):null,samples.length,attempt),
          });
          totals.inserted += result.inserted;
          totals.samples.push(...samples);
        } catch (e) {
          const reason = String(e.message || 'Ошибка синхронизации').replaceAll(env.METRIKA_TOKEN,'[скрыто]').slice(0,300);
          db.prepare("UPDATE metrika_sync_runs SET state='error',finished=?,reason=? WHERE id=?").run(clock(),reason,attempt);
          errors.push(counter + '/' + map.id + ': ' + reason);
          break;
        }
        start = addDays(end,1);
      }
    }
    if (errors.length) throw Error(errors.join(' · '));
    setSetting(db,'last_metrika_sync',{at:clock(), status:'ready'});
    return { ...totals, documents: db.prepare('SELECT count(*) n FROM documents').get().n };
  } catch (e) {
    setSetting(db,'last_metrika_sync',{at:clock(),status:'error'});
    throw e;
  }
}

export function syncMetrika(store, env, send = fetch, {now = Date.now} = {}) {
  if (!active.has(store.db)) {
    const pending = synchronize(store,env,send,typeof now === 'function' ? now : () => now)
      .finally(() => active.delete(store.db));
    active.set(store.db,pending);
  }
  return active.get(store.db);
}
