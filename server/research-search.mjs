// The index contains only material already accepted by the local importer.
const noise = new Set(('как для про где что чего чем какие какой какая какие какой почему при без есть это если или когда который которых том этом найти покажи говорят участники клиенты чтобы после нам нужно').split(' '));
const searchKinds = new Set(['interview', 'competitor']);

function terms(text) {
  const words = String(text).toLowerCase().replaceAll('ё', 'е')
    .replace(/каспер[а-я]*|\bkes\b/gu, 'kaspersky').replace(/астр[а-я]*/gu, 'astra')
    .match(/[\p{L}\d]{2,}/gu) || [];
  return [...new Set(words.filter(w => !noise.has(w)).map(w => {
    if (w.length < 5 || !/^[а-я]+$/u.test(w)) return w;
    // Both query and document use the same stem. Prefix matching covers related forms.
    return w.replace(/(?:иями|ение|ению|ения|ами|ями|ого|его|ому|ему|ыми|ими|ах|ях|ов|ев|ия|ие|ию|ой|ей|ам|ям|ом|ем|ую|юю|ая|яя|ые|ии|ий|ый|а|е|и|о|у|ы|ю|я|ь)$/u, '');
  }))];
}

function researchFields(raw) {
  return typeof raw === 'string' ? {excerpt: raw} : raw;
}
function indexRows(db, rows) {
  const insert = db.prepare('INSERT INTO research_fts(rowid, terms) VALUES (?,?)');
  for (const row of rows) {
    const v = researchFields(JSON.parse(row.body));
    insert.run(row.rowid, terms([v.excerpt, v.question, v.product, v.hypothesis].filter(Boolean).join(' ')).join(' '));
  }
}
export function initResearchSearch(db) {
  db.exec('CREATE INDEX IF NOT EXISTS facts_by_file_kind ON facts(file,kind)');
  db.exec('CREATE TABLE IF NOT EXISTS research_file_versions(file TEXT PRIMARY KEY, version TEXT NOT NULL)');
  if (db.prepare("SELECT 1 FROM sqlite_master WHERE name='research_fts'").get()) return;
  db.exec('SAVEPOINT research_search');
  try {
    db.exec('CREATE VIRTUAL TABLE research_fts USING fts5(terms, tokenize="unicode61")');
    indexRows(db, db.prepare("SELECT rowid,body FROM facts WHERE kind IN ('interview','competitor')").all());
    db.exec("INSERT OR IGNORE INTO research_file_versions SELECT DISTINCT file,version FROM facts WHERE kind IN ('interview','competitor')");
    db.exec('RELEASE research_search');
  } catch (error) {
    db.exec('ROLLBACK TO research_search; RELEASE research_search');
    throw error;
  }
}
export function removeResearchIndex(db, file) {
  db.prepare(`DELETE FROM research_fts WHERE rowid IN
    (SELECT rowid FROM facts WHERE file=? AND kind IN ('interview','competitor'))`).run(file);
}
export function indexResearchFile(db, file) {
  indexRows(db, db.prepare("SELECT rowid,body FROM facts WHERE file=? AND kind IN ('interview','competitor')").all(file));
}
export function searchResearch(db, query, kinds, limit, asOf, excluded) {
  const selected = kinds.filter(k => searchKinds.has(k));
  const words = terms(query).slice(0, 30);
  if (!selected.length || !words.length) return [];
  const match = words.map(w => '"' + w + '"' + (w.length >= 4 ? '*' : '')).join(' OR ');
  const dated = asOf ? "AND json_extract(f.body,'$.date') BETWEEN '0001-01-01' AND ?" : '';
  const source = "COALESCE(json_extract(f.body,'$.sourceFile') || ' · ' || json_extract(f.body,'$.sourceLoc'), f.file || ' · ' || f.loc)";
  const omissions = excluded.length ? `AND ${source} NOT IN (SELECT value FROM json_each(?))` : '';
  const results = db.prepare(`SELECT f.kind,f.key,f.version,f.file,f.loc,f.body,rank FROM research_fts
    JOIN facts f ON f.rowid=research_fts.rowid WHERE research_fts MATCH ?
    AND f.kind IN (${selected.map(() => '?').join(',')}) ${dated} ${omissions}
    ORDER BY rank, f.file, f.loc LIMIT ?`).all(match, ...selected, ...(asOf ? [asOf] : []),
      ...(excluded.length ? [JSON.stringify(excluded)] : []), limit);
  return results.map(({kind,key,version,file,loc,body,rank}) => {
    const parsed = JSON.parse(body);
    const v = researchFields(parsed);
    const display = v.sourceFile && v.sourceLoc ? v.sourceFile + ' · ' + v.sourceLoc : file + ' · ' + loc;
    const tokens = terms([v.excerpt, v.question, v.product, v.hypothesis].filter(Boolean).join(' '));
    const hits = words.filter(w => tokens.some(t => w.length < 4 ? t === w : t.startsWith(w))).length;
    const metadata = typeof parsed === 'string' ? undefined : {
      product: v.product, question: v.question, date: v.date, importedFrom: file + ' · ' + loc, sourceFile:v.sourceFile,sourceLoc:v.sourceLoc,
      hypothesis: v.hypothesis, relation: v.relation || 'упоминание',
    };
    return {kind,key,version,file,loc,source:display,data:v.excerpt,metadata,score:hits + Math.min(0.99, -rank/(1-rank))};
  });
}
