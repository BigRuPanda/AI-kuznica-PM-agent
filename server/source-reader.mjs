import { facts, identity } from './evidence.mjs';
import { normalizeObservation, observationKey } from './metric-observations.mjs';

// The first indexed workbook makes the original dated archive available retrospectively.
// Later versions apply from their approval or import date.
export function sourceReader(db, through, snapshot) {
  if (!through && !snapshot) {
    const cache = new Map();
    return kind => {
      if (!cache.has(kind)) cache.set(kind, facts(db, kind));
      return cache.get(kind);
    };
  }
  const until = Date.parse(through + 'T23:59:59.999+03:00') + 1;
  const revisions = db.prepare("SELECT 1 FROM sqlite_schema WHERE name='source_revisions'").get();
  const versions = db.prepare(`SELECT d.file,d.version,d.created,d.body,${revisions ? 'r.approved' : 'NULL AS approved'} FROM documents d
    ${revisions ? 'LEFT JOIN source_revisions r ON r.version=d.version' : ''} ORDER BY d.rowid`).all();
  const covered = new Set(versions.map(row => row.version));
  const pinned = snapshot && new Map([
    ['sales',snapshot.salesVersions], ['metrics',snapshot.metricVersions], ['releases',snapshot.releaseVersions],
    ['dictionary',snapshot.dictionaryVersions], ['backlog',snapshot.backlogVersions],
    ['interview',snapshot.interviewVersions], ['competitor',snapshot.competitorVersions],
  ].filter(([, ids])=>ids).map(([kind, ids])=>[kind,new Set(ids)]));
  const first = new Set();
  const rows = new Map(), research = new Map();
  for (const doc of versions) {
    const original = !first.has(doc.file) && !doc.approved;
    first.add(doc.file);
    if (!pinned && !original && (doc.approved ?? doc.created) >= until) continue;
    const body = JSON.parse(doc.body);
    if (body.legacyInterviewFile) research.delete(body.legacyInterviewFile);
    const entries = [];
    for (const fact of body.facts) {
      const {kind,loc} = fact;
      if (pinned && !pinned.get(kind)?.has(doc.version)) continue;
      const data = kind === 'metrics' ? normalizeObservation(fact.row, doc.file) : fact.row ?? fact.text;
      const key = kind === 'metrics' ? observationKey(data) : identity(fact, doc.file);
      const row = {kind,key,file:doc.file,version:doc.version,loc,data};
      if (['interview','competitor','reference'].includes(kind)) entries.push(row);
      else rows.set(JSON.stringify([kind,key]), row);
    }
    if (!pinned || entries.length) research.set(doc.file, entries);
  }
  const grouped = new Map();
  for (const row of [...rows.values(), ...[...research.values()].flat()]) {
    if (!grouped.has(row.kind)) grouped.set(row.kind, []);
    grouped.get(row.kind).push(row);
  }
  return kind => [...(grouped.get(kind) || []), ...facts(db, kind).filter(row =>
    !covered.has(row.version) && (!pinned || pinned.get(kind)?.has(row.version)))];
}
