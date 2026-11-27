import { digest, identity, importDocs } from './evidence.mjs';

const hex = /^[a-f0-9]{64}$/;
const office = /^[^/\\\x00-\x1f]{1,230}\.(xlsx|pptx)$/i;
const archiveOrigin = 'Исходный ZIP организатора';

export function initSourcePolicy(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS source_archive(sha TEXT PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS source_approvals(
      sha TEXT PRIMARY KEY,file TEXT NOT NULL,previous TEXT,origin TEXT NOT NULL,author TEXT NOT NULL,approved INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS source_revisions(
      version TEXT PRIMARY KEY,file TEXT NOT NULL,sha TEXT NOT NULL,origin TEXT NOT NULL,author TEXT,approved INTEGER);
    CREATE INDEX IF NOT EXISTS source_revisions_file ON source_revisions(file);
    CREATE TABLE IF NOT EXISTS archive_indexes(sha TEXT PRIMARY KEY, format INTEGER NOT NULL);`);
}

function head(db, file) {
  return db.prepare('SELECT version FROM source_revisions WHERE file=? ORDER BY rowid DESC LIMIT 1').get(file)?.version ?? null;
}

function checkPrevious(db, file, previous) {
  if (head(db, file) !== previous)
    throw Error('Текущая версия изменилась. Обновите список источников и заново проверьте файл.');
}

export function approveSource(store, { sha, file, origin, previous }, author, expected) {
  if (typeof file !== 'string' || !office.test(file) || typeof sha !== 'string' || !hex.test(sha) || sha === expected ||
      typeof origin !== 'string' || !origin.trim() || origin.length > 400 ||
      (previous !== null && (typeof previous !== 'string' || !hex.test(previous))))
    throw Error('Укажите книгу XLSX или презентацию PPTX, SHA-256, текущую версию и происхождение материала.');
  origin = origin.trim();
  store.tx(() => {
    const { db } = store;
    if (!db.prepare('SELECT 1 FROM source_archive WHERE sha=?').get(expected))
      throw Error('Сначала загрузите исходный ZIP организатора.');
    checkPrevious(db, file, previous);
    const old = db.prepare('SELECT file,previous,origin FROM source_approvals WHERE sha=?').get(sha);
    if (old && (old.file !== file || old.previous !== previous || old.origin !== origin))
      throw Error('Этот файл уже согласовывался с другой версией или другим происхождением.');
    if (!old) db.prepare('INSERT INTO source_approvals VALUES(?,?,?,?,?,?)').run(sha, file, previous, origin, author, Date.now());
  });
}

export function sourcePermission(db, expected, raw, file) {
  if (!expected) return null;
  const sha = digest(raw);
  const indexed = db.prepare('SELECT format FROM archive_indexes WHERE sha=?').get(sha)?.format === 2;
  if (sha === expected && /\.zip$/i.test(file)) {
    const exists = !!db.prepare('SELECT 1 FROM source_archive WHERE sha=?').get(sha);
    return { archive: true, sha, alreadyImported: exists && indexed, refresh: exists && !indexed };
  }
  const approved = db.prepare('SELECT * FROM source_approvals WHERE sha=? AND file=?').get(sha, file);
  if (!approved) throw Error('Загрузите исходный ZIP организатора или версию, согласованную администратором.');
  const exists = !!db.prepare('SELECT 1 FROM source_revisions WHERE sha=? AND file=?').get(sha, file);
  return { ...approved, alreadyImported: exists && indexed, refresh: exists && !indexed };
}

function saveRevision(db, doc, { sha, origin, author = null, approved = null }) {
  db.prepare('INSERT INTO source_revisions VALUES(?,?,?,?,?,?)')
    .run(digest(JSON.stringify(doc)), doc.file, sha, origin, author, approved);
}

function factKeys(doc) {
  const keys = new Map();
  for (const fact of doc.facts) {
    const key = identity(fact, doc.file);
    if (typeof key !== 'string' || !key || keys.has(JSON.stringify([fact.kind, key])))
      throw Error('В источнике повторяется или отсутствует ключ записи: ' + fact.loc);
    keys.set(JSON.stringify([fact.kind, key]), fact.kind);
  }
  return keys;
}

function validateArchive(db, docs, sha) {
  const prior = db.prepare('SELECT sha FROM source_archive').get();
  if (prior?.sha === sha) return false;
  if (prior) throw Error('Этот архив не совпадает с исходным архивом пространства.');
  const inventory = new Map();
  const names = new Set();
  for (const doc of docs) {
    const filename = doc.file.normalize('NFC').toLowerCase();
    if (names.has(filename)) throw Error('В исходном ZIP совпадают имена источников.');
    names.add(filename);
    for (const key of factKeys(doc).keys()) {
      if (inventory.has(key)) throw Error('В исходном ZIP одна запись относится к двум материалам.');
      inventory.set(key, doc.file);
    }
  }
  const existing = db.prepare('SELECT kind,key,file,version FROM facts').all();
  const versions = new Map(docs.map(doc => [doc.file, digest(JSON.stringify(doc))]));
  const imported = db.prepare('SELECT 1 FROM documents WHERE version=?');
  for (const row of existing) {
    const version = versions.get(row.file);
    if (inventory.get(JSON.stringify([row.kind, row.key])) !== row.file ||
        (row.version !== version && imported.get(version)))
      throw Error('Текущие данные расходятся с исходным ZIP. Для этого архива нужно отдельное пространство.');
  }
  for (const doc of docs) saveRevision(db, doc, { sha, origin: archiveOrigin });
  db.prepare('INSERT INTO source_archive VALUES(?)').run(sha);
}

function validateRevision(db, doc, approval) {
  if (db.prepare('SELECT 1 FROM source_revisions WHERE sha=? AND file=?').get(approval.sha, doc.file)) return false;
  checkPrevious(db, doc.file, approval.previous);
  const keys = factKeys(doc);
  const current = db.prepare('SELECT kind,key FROM facts WHERE file=?').all(doc.file);
  if (!approval.previous) {
    const name = doc.file.normalize('NFC').toLowerCase();
    const known = db.prepare('SELECT DISTINCT file FROM documents').all();
    if (known.some(r => r.file.normalize('NFC').toLowerCase() === name))
      throw Error('Это имя уже принадлежит другому источнику.');
  }
  const kinds = new Set(approval.previous ? current.map(r => r.kind) : ['interview', 'competitor']);
  if ([...keys.values()].some(kind => !kinds.has(kind)))
    throw Error('Типы записей должны соответствовать текущему источнику. Для нового материала поддерживаются исследования.');
  if (current.some(r => !keys.has(JSON.stringify([r.kind, r.key]))))
    throw Error('Новая версия пропускает записи текущего источника. Загрузите полную версию с дополнениями или исправлениями.');
  const owner = db.prepare('SELECT file FROM facts WHERE kind=? AND key=?');
  for (const key of keys.keys()) {
    const row = owner.get(...JSON.parse(key));
    if (row && row.file !== doc.file) throw Error('Запись уже принадлежит другому источнику.');
  }
  saveRevision(db, doc, approval);
}

export function importApproved(store, docs, permission, notify) {
  if (!permission) return importDocs(store, docs, { notify });
  if (permission.alreadyImported)
    return { inserted: 0, documents: store.db.prepare('SELECT count(*) n FROM documents').get().n };
  const markIndexed = db => db.prepare('INSERT OR REPLACE INTO archive_indexes VALUES(?,2)').run(permission.sha);
  if (permission.refresh) {
    const candidates = [];
    return importDocs(store, candidates, { notify: false, guard: db => {
      if (db.prepare('SELECT format FROM archive_indexes WHERE sha=?').get(permission.sha)?.format === 2) return false;
      for (const doc of docs) {
        const prior = db.prepare('SELECT * FROM source_revisions WHERE file=? ORDER BY rowid DESC LIMIT 1').get(doc.file);
        if (!prior || prior.sha !== permission.sha) continue;
        const next = permission.archive ? doc : { ...doc, sourceFileSha256: prior.sha };
        if (prior.version === digest(JSON.stringify(next))) continue;
        const keys = factKeys(next);
        const live = db.prepare('SELECT kind,key FROM facts WHERE file=?').all(next.file);
        if (live.some(r => !keys.has(JSON.stringify([r.kind,r.key]))))
          throw Error('При обновлении индекса пропала прежняя строка ' + next.file);
        saveRevision(db, next, prior);
        candidates.push(next);
      }
      markIndexed(db);
      return true;
    }});
  }
  if (permission.archive)
    return importDocs(store, docs, { notify, guard: db => {
      const valid = validateArchive(db, docs, permission.sha);
      if (valid !== false && permission.alreadyImported !== undefined) markIndexed(db);
      return valid;
    } });
  const doc = docs[0];
  if (docs.length !== 1 || doc.file !== permission.file || !doc.facts.length)
    throw Error('В согласованном материале нет распознанных записей.');
  const revision = { ...doc, sourceFileSha256: permission.sha };
  return importDocs(store, [revision], { notify, guard: db => {
    const valid = validateRevision(db, revision, permission);
    if (valid !== false) markIndexed(db);
    return valid;
  } });
}

export function sourceHistory(db, file) {
  if (typeof file !== 'string' || !office.test(file)) throw Error('Выберите книгу или презентацию.');
  const active = head(db, file);
  return db.prepare(`SELECT d.version,d.created,json_array_length(d.body,'$.facts') total,r.origin,r.author,r.approved
    FROM documents d LEFT JOIN source_revisions r ON r.version=d.version
    WHERE d.file=? ORDER BY d.rowid DESC`).all(file).map(row => ({ ...row, active: row.version === active }));
}

export function protectedSources(db) {
  return db.prepare(`SELECT d.file,d.version,d.created updated,json_array_length(d.body,'$.facts') total,
      json_extract(d.body,'$.role') role,(SELECT count(*) FROM documents h WHERE h.file=d.file) versions
    FROM source_revisions r JOIN documents d ON d.version=r.version
    WHERE r.rowid=(SELECT max(h.rowid) FROM source_revisions h WHERE h.file=r.file) ORDER BY d.file`).all();
}
