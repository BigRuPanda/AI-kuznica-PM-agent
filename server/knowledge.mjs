import { digest } from './evidence.mjs';
import { escapeXml } from './tracker-clients.mjs';

export function issuePages(db, user, issueUrl, sharedOnly) {
  return db.prepare(`
    WITH linked(key) AS (
      SELECT rp.page FROM redmine_results r JOIN redmine_result_pages rp ON rp.result=r.id
      WHERE json_extract(r.body,'$.url')=?
      UNION SELECT d.external FROM draft_actions d WHERE d.state IN ('done','partial')
        AND json_extract(d.body,'$.kind')='page' AND json_extract(d.body,'$.target.local')=1
        AND json_extract(d.body,'$.issue.url')=?
    )
    SELECT p.key, p.title, p.version FROM linked JOIN demo_pages p ON p.key=linked.key
    JOIN cases c ON c.id=p.case_id
    LEFT JOIN private_wiki_pages acl ON acl.page=p.key
    WHERE COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?)
      AND (acl.user IS NULL OR acl.user=?) ORDER BY p.key
  `).all(issueUrl, issueUrl, sharedOnly ? '' : user.id, sharedOnly ? '' : user.id);
}

export function excelSources(db) {
  return db
    .prepare(
      `SELECT version,file,created,json_array_length(body,'$.facts') AS total
    FROM documents WHERE lower(file) LIKE '%.xlsx' ORDER BY created DESC,file,version`,
    )
    .all();
}

export function sourceRows(db, version, offset = 0, loc) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Проверьте номер строки');
  const doc = db
    .prepare("SELECT file,body,created FROM documents WHERE version=? AND (lower(file) LIKE '%.xlsx' OR lower(file) LIKE '%.pptx')")
    .get(version);
  if (!doc) throw Error('Версия Excel недоступна в этом пространстве');
  const { facts } = JSON.parse(doc.body);
  if (loc) {
    const index = facts.findIndex(r => r.loc === loc);
    if (index < 0) throw Error('Строка отсутствует в этой версии документа');
    offset = index;
  }
  return {
    file: doc.file,
    version,
    created: doc.created,
    total: facts.length,
    offset,
    rows: facts.slice(offset, offset + 40).map((f) => ({ loc: f.loc, value: f.row || f.text })),
  };
}

export function sourceLinks(db, versions, target, env) {
  return [...new Set(versions || [])].map((version) => {
    const row = db
      .prepare("SELECT file FROM documents WHERE version=? AND lower(file) LIKE '%.xlsx'")
      .get(version);
    if (!row) throw Error('Версия Excel недоступна в этом пространстве');
    const href = '#knowledge-source/' + version;
    return {
      file: row.file,
      version,
      url: target.local ? href : new URL(href, env.APP_BASE_URL || 'http://127.0.0.1:8090').href,
    };
  });
}

// Runs within the closure transaction. Retain authored text and append each observed closing once.
export function recordResultPage(db, id, caseId, row) {
  if (db.prepare('SELECT 1 FROM redmine_result_pages WHERE result=?').get(id)) return;
  const previous = db
    .prepare(
      `SELECT p.key FROM redmine_result_pages rp JOIN demo_pages p ON p.key=rp.page
    JOIN redmine_results r ON r.id=rp.result WHERE r.case_id=? AND json_extract(r.body,'$.reference')=?
    ORDER BY r.created DESC LIMIT 1`,
    )
    .get(caseId, row.reference);
  const authored =
    previous ||
    (!row.personalOwner &&
      db
        .prepare(
          `SELECT p.key FROM draft_actions d JOIN demo_pages p ON p.key=d.external
    WHERE p.case_id=? AND d.case_id=? AND d.state IN ('done','partial','uncertain') AND json_extract(d.body,'$.kind')='page'
    AND json_extract(d.body,'$.target.local')=1 AND json_extract(d.body,'$.issue.url')=?
    AND NOT EXISTS(SELECT 1 FROM private_wiki_pages acl WHERE acl.page=p.key)
    ORDER BY d.rowid DESC LIMIT 1`,
        )
        .get(caseId, caseId, row.url));
  const key = authored?.key || 'PAGE-' + digest(caseId + '/' + row.reference);
  const issue = '<a href="' + escapeXml(row.url) + '">Redmine #' + escapeXml(row.issue) + '</a>';
  const content = [
    '<h2>Закрытие №' + escapeXml(row.episode) + '</h2>',
    '<p>' + issue + ' · ' + escapeXml(row.status) + ' · ' + escapeXml(row.closed_on || row.observed) + '</p>',
    '<p>Постановка: ' + escapeXml(row.description || row.title) + '</p>',
  ];
  if (row.closing_note) {
    const note = row.closing_note;
    content.push(
      '<p>Комментарий при закрытии' + (note.author ? ' · ' + escapeXml(note.author) : '') + '</p>',
      ...note.text.split(/\r?\n/).map((line) => '<p>' + escapeXml(line) + '</p>'),
    );
  }
  if (row.report) {
    const r = row.report;
    content.push(
      '<p>Исходный отчёт Метрики: ' +
        escapeXml(r.start) +
        ' — ' +
        escapeXml(r.end) +
        '. ' +
        escapeXml(r.status) +
        '</p>',
      '<p>Визиты с корзиной / все визиты по неделям: ' +
        escapeXml(r.periods.map((p) => p.at(-1) + '/' + p[0]).join(' → ')) +
        '</p>',
      '<p><a href="' + escapeXml(r.web) + '">Отчёт Метрики</a></p>',
    );
  }
  db.prepare(
    `INSERT INTO demo_pages(key,case_id,title,storage,version) VALUES(?,?,?,?,1)
    ON CONFLICT(key) DO UPDATE SET storage=demo_pages.storage||excluded.storage,version=demo_pages.version+1`,
  ).run(key, caseId, 'Redmine #' + row.issue + ' · ' + row.title, content.join(''));
  db.prepare('INSERT INTO redmine_result_pages VALUES(?,?)').run(id, key);
  if (row.personalOwner)
    db.prepare('INSERT OR IGNORE INTO private_wiki_pages VALUES(?,?)').run(key, row.personalOwner);
}

export function initResultPages(db) {
  db.exec('CREATE TABLE IF NOT EXISTS redmine_result_pages(result TEXT PRIMARY KEY,page TEXT NOT NULL)');
  const missing = db
    .prepare(
      `SELECT id,case_id,body FROM redmine_results r WHERE NOT EXISTS(
    SELECT 1 FROM redmine_result_pages rp WHERE rp.result=r.id) ORDER BY created,id`,
    )
    .all();
  if (!missing.length) return;
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const r of missing) recordResultPage(db, r.id, r.case_id, JSON.parse(r.body));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
