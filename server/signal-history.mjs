import { createHash } from 'node:crypto';

const fingerprint = (value) => createHash('sha256').update(value).digest('hex');
const series = (s) => JSON.stringify([s.product, s.rule, s.seriesKey ?? s.product]);

export function initSignalHistory(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS signal_revisions(
    case_id TEXT NOT NULL, revision INTEGER NOT NULL, created INTEGER NOT NULL, body TEXT NOT NULL,
    PRIMARY KEY(case_id, revision));
    CREATE INDEX IF NOT EXISTS deliveries_signal ON deliveries(json_extract(body,'$.signalId'));`);
  // A legacy case has a snapshot but no revision timestamp. Keep that snapshot as the baseline.
  db.exec(`INSERT OR IGNORE INTO signal_revisions(case_id,revision,created,body)
    SELECT c.id,0,0,json_patch(json_extract(c.body,'$.signal'),json_object(
      'product',c.product,'confirmedWeek',COALESCE(json_extract(c.body,'$.signal.confirmedWeek'),a.week),
      'status',COALESCE(json_extract(c.body,'$.signal.status'),CASE WHEN a.week IS NULL THEN 'provisional' ELSE 'confirmed' END)))
    FROM cases c LEFT JOIN alerts a ON a.case_id=c.id
    WHERE json_type(c.body,'$.signal')='object' AND json_extract(c.body,'$.signal.revision') IS NULL`);
  // Previous releases used the alert id followed by a channel and optional Telegram recipient.
  db.exec(`UPDATE deliveries AS d SET body=json_set(body,'$.signalId',json_extract(body,'$.caseId'),
    '$.revision',0,'$.event','confirmed','$.proactive',json('true')) WHERE json_extract(body,'$.signalId') IS NULL
    AND EXISTS(SELECT 1 FROM alerts a WHERE a.id=json_extract(d.body,'$.caseId')
      AND (d.id=a.id||d.channel OR substr(d.id,1,length(a.id||d.channel)+1)=a.id||d.channel||'/'))`);
}

function sentTo(channel, body) {
  return channel === 'telegram' ? body.chat : body.emailTo;
}

function updateNotices(db, id, revision, event, summary, notify) {
  const text = event === 'withdrawn' ? 'Сигнал отозван после пересчёта: ' + summary
    : event === 'corrected' ? 'Данные сигнала уточнены: ' + summary : summary;
  const payload = { signalId: id, caseId: id, revision, event, proactive: true, text };
  const insert = db.prepare('INSERT OR IGNORE INTO deliveries(id,channel,state,body) VALUES(?,?,?,?)');
  if (event === 'confirmed') {
    // A pending withdrawal no longer describes an episode that has since been re-confirmed.
    db.prepare(`UPDATE deliveries SET state='cancelled' WHERE state IN ('queued','review') AND json_extract(body,'$.signalId')=?
      AND json_extract(body,'$.event')='withdrawn'`).run(id);
    const channels = Array.isArray(notify) ? notify : notify ? ['telegram','smtp'] : [];
    for (const ch of channels) insert.run(id + '/' + revision + '/' + ch, ch, 'queued', JSON.stringify(payload));
    return;
  }
  const receipts = new Map();
  const pending = [];
  for (const row of db.prepare("SELECT * FROM deliveries WHERE json_extract(body,'$.signalId')=? ORDER BY rowid").all(id)) {
    const body = JSON.parse(row.body);
    if (row.state === 'queued' || row.state === 'review') { pending.push({ row, body }); continue; }
    if (!['delivered','sending','uncertain'].includes(row.state)) continue;
    const dest = sentTo(row.channel, body);
    const key = row.channel + '/' + (dest || row.id);
    receipts.set(key, { row, body, dest });
  }
  for (const {row, body} of pending) {
    // Keep the scheduled destination when an amendment supersedes a still-unsent announcement.
    if (row.state === 'queued' && event === 'corrected' && !body.after &&
        !receipts.has(row.channel + '/' + sentTo(row.channel, body)))
      db.prepare('UPDATE deliveries SET body=? WHERE id=?').run(JSON.stringify({...body, ...payload}), row.id);
    else db.prepare("UPDATE deliveries SET state='cancelled' WHERE id=?").run(row.id);
  }
  for (const [key, {row, body, dest}] of receipts) {
    if (event === 'withdrawn' && body.event === 'withdrawn' && row.state === 'delivered') continue;
    const message = {...payload};
    if (dest) message[row.channel === 'telegram' ? 'chat' : 'emailTo'] = dest;
    if (row.state === 'sending') message.after = row.id;
    const state = !dest || row.state === 'uncertain' ? 'review' : 'queued';
    insert.run(id + '/' + revision + '/' + fingerprint(key).slice(0,24), row.channel, state, JSON.stringify(message));
  }
}

function evidenceChanged(old, next) {
  if (old.start !== next.start || old.week > next.week || old.threshold !== next.threshold ||
      old.confirmedWeek !== next.confirmedWeek || old.baseN !== next.baseN || old.baseD !== next.baseD) return true;
  const numbers = (r) => Object.entries(r).filter(([,v]) => typeof v === 'number').sort(([a],[b])=>a.localeCompare(b));
  const updated = new Map(next.history.map((r) => [r.week, JSON.stringify(numbers(r))]));
  return old.history.some((r) => updated.get(r.week) !== JSON.stringify(numbers(r)));
}

// Called in the same transaction as the import or rule change. Preserve a case's identity across late weeks.
export function reconcileSignals(db, episodes, notify, imported = []) {
  const previous = db.prepare("SELECT * FROM cases WHERE json_type(body,'$.signal')='object'").all().map((r) => {
    const body = JSON.parse(r.body);
    const s = body.signal;
    const confirmedWeek = s.status ? s.confirmedWeek : db.prepare('SELECT week FROM alerts WHERE case_id=?').get(r.id)?.week;
    return { id:r.id, body, signal:{...s, product:r.product, confirmedWeek, status:s.status || (confirmedWeek ? 'confirmed' : 'provisional')} };
  });
  const used = new Set();
  const pairs = episodes.map((e) => {
    const old = previous.find((p) => series(p.signal) === series(e) && p.signal.start === e.start);
    if (old) used.add(old.id);
    return {episode:e, old};
  });
  for (const pair of pairs) {
    const e = pair.episode;
    if (!pair.old) {
      const overlaps = previous.filter(({id,signal:s}) => !used.has(id) &&
        series(s) === series(e) && s.start <= e.week && e.start <= s.week);
      pair.old = overlaps.find(p => p.signal.status !== 'withdrawn') || overlaps[0];
      if (pair.old) used.add(pair.old.id);
    }
  }
  for (const p of previous)
    if (!used.has(p.id) && p.signal.status !== 'withdrawn') pairs.push({old:p});
  for (const {episode, old} of pairs) {
    const { revision: earlierRevision, ...prior } = old?.signal || {};
    const { confirmedWeek: oldWeek, ...last } = prior;
    const next = episode
      ? {...episode, status:episode.confirmedWeek ? 'confirmed' : 'provisional'}
      : {...last, status:'withdrawn'};
    const revision = (earlierRevision || 0) + 1;
    // A rescan may reconstruct identical history with different property insertion order.
    if (earlierRevision && canonical(next) === canonical(prior)) continue;
    const id = old?.id || fingerprint([next.product,next.rule,...(next.seriesKey ? [next.seriesKey] : []),next.start].join('/')).slice(0,24);
    const signal = {...next, revision};
    const title = next.title || old?.body.signal.title || (next.rule === 'relative' ? 'Снижение среднего индекса' : 'Индекс ниже порога справочника');
    db.prepare(`INSERT INTO cases VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body`)
      .run(id,next.product,title + ' · ' + next.product,'Исследуем',JSON.stringify({...old?.body,signal}));
    let event;
    if (next.status === 'confirmed') {
      db.prepare(`INSERT INTO alerts VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET week=excluded.week, body=excluded.body`)
        .run(id,id,next.confirmedWeek,JSON.stringify(signal));
      if (prior.status !== 'confirmed') event = 'confirmed';
      else if (evidenceChanged({...prior,confirmedWeek:oldWeek},next)) event = 'corrected';
    } else if (prior.status === 'confirmed') {
      db.prepare('UPDATE alerts SET body=? WHERE case_id=?').run(JSON.stringify(signal),id);
      event = 'withdrawn';
    }
    db.prepare('INSERT INTO signal_revisions VALUES(?,?,?,?)')
      .run(id,revision,Date.now(),JSON.stringify({...signal, event, imported}));
    if (event) updateNotices(db,id,revision,event,title + ' · ' + next.product + ' · ' + next.week,notify);
  }
}

export function signalHistory(db, caseId) {
  return db.prepare(`SELECT revision,created,json_extract(body,'$.status') status,
    json_extract(body,'$.event') event,json_extract(body,'$.metric') metric,json_extract(body,'$.week') week,
    json_extract(body,'$.value') value,json_extract(body,'$.imported') imported
    FROM signal_revisions WHERE case_id=? ORDER BY revision DESC`).all(caseId).map(row => ({
      ...row, imported:JSON.parse(row.imported || '[]'),
    }));
}

function canonical(value) {
  return JSON.stringify(value, (_,v) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.keys(v).sort().map((k)=>[k,v[k]])) : v);
}
