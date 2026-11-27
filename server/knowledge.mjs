import { digest } from './evidence.mjs';
import { escapeXml } from './tracker-clients.mjs';
import { localHref } from './tracker-demo.mjs';

export function issuePages(db, user, issueUrl, sharedOnly = false) {
  return db.prepare(`
    WITH linked(key) AS (
      SELECT rp.page FROM redmine_results r JOIN redmine_result_pages rp ON rp.result=r.id
      WHERE json_extract(r.body,'$.url')=? AND COALESCE(json_extract(r.body,'$.personalOwner'),'') IN ('',?)
      UNION SELECT d.external FROM draft_actions d WHERE d.state IN ('done','partial')
        AND json_extract(d.body,'$.kind')='page' AND json_extract(d.body,'$.target.local')=1
        AND json_extract(d.body,'$.issue.url')=?
    )
    SELECT p.key,p.title,p.version FROM linked JOIN demo_pages p ON p.key=linked.key
    JOIN cases c ON c.id=p.case_id LEFT JOIN private_wiki_pages acl ON acl.page=p.key
    WHERE COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?) AND (acl.user IS NULL OR acl.user=?)
    ORDER BY p.key
  `).all(issueUrl, sharedOnly ? '' : user.id, issueUrl, sharedOnly ? '' : user.id, sharedOnly ? '' : user.id)
    .map(page => ({ ...page, url: localHref('confluence', page.key) }));
}

export function issueClosure(db, user, issueUrl, sharedOnly = false) {
  const actor = sharedOnly ? '' : user.id;
  const row = db.prepare(`
    SELECT r.body FROM redmine_results r JOIN cases c ON c.id=r.case_id
    WHERE json_extract(r.body,'$.url')=? AND COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?)
    AND COALESCE(json_extract(r.body,'$.personalOwner'),'') IN ('',?) ORDER BY r.created DESC,r.id DESC LIMIT 1
  `).get(issueUrl, actor, actor);
  if (!row) return {};
  const result = JSON.parse(row.body);
  return { closingNote: result.closing_note ?? null, originalReport: result.report ?? null };
}

export function pageByIssue(db, user, issueKey, sharedOnly = false) {
  const number = String(issueKey).trim().replace(/^(?:Redmine\s*)?[#№]?\s*/i, '');
  const urls = db.prepare(`
    SELECT json_extract(body,'$.url') AS url FROM redmine_results
      WHERE CAST(json_extract(body,'$.issue') AS TEXT)=?
    UNION SELECT json_extract(body,'$.issue.url') AS url FROM draft_actions
      WHERE state IN ('done','partial') AND json_extract(body,'$.kind')='page'
      AND json_extract(body,'$.issue.key') IN (?,?,?,?)
  `).all(number, issueKey, number, 'Redmine #' + number, '#' + number);
  const pages = new Map(urls.filter(row => row.url)
    .map(({ url }) => [url, issuePages(db, user, url, sharedOnly)]).filter(([, pages]) => pages.length));
  if (pages.size !== 1) {
    if (pages.size > 1) throw Error('Найдено несколько задач с таким номером. Укажите ключ страницы из поиска.');
    throw Error('Страница по задаче недоступна.');
  }
  const [url, linked] = pages.entries().next().value;
  const preferred = db.prepare(`
    SELECT rp.page FROM redmine_results r JOIN redmine_result_pages rp ON rp.result=r.id
    WHERE json_extract(r.body,'$.url')=? ORDER BY r.created DESC,r.id DESC
  `).all(url).find(row => linked.some(page => page.key === row.page));
  return preferred?.page || linked[0].key;
}

export function knowledge(db, user) {
  const pages = db.prepare(`
    SELECT p.key,p.title,p.version,p.case_id AS caseId
    FROM demo_pages p JOIN cases c ON c.id=p.case_id LEFT JOIN private_wiki_pages acl ON acl.page=p.key
    WHERE COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?) AND (acl.user IS NULL OR acl.user=?)
    ORDER BY p.rowid DESC
  `).all(user.id, user.id);
  const visiblePages = new Set(pages.map(page => page.key));
  const results = db.prepare(`
    SELECT r.body,r.case_id AS caseId,rp.page AS pageKey FROM redmine_results r JOIN cases c ON c.id=r.case_id
    LEFT JOIN redmine_result_pages rp ON rp.result=r.id
    WHERE COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?)
    AND COALESCE(json_extract(r.body,'$.personalOwner'),'') IN ('',?) ORDER BY r.created DESC,r.id DESC
  `).all(user.id, user.id);
  const publications = db.prepare(`
    SELECT p.id,p.case_id AS caseId,p.created,p.body,c.title FROM published p JOIN cases c ON c.id=p.case_id
    WHERE COALESCE(json_extract(c.body,'$.owner'),'') IN ('',?) ORDER BY p.created DESC
  `).all(user.id);
  return {
    results: results.map(({body,caseId,pageKey}) => ({ ...JSON.parse(body), caseId,
      pageKey: visiblePages.has(pageKey) ? pageKey : null })),
    sources: excelSources(db),
    pages,
    publications: publications.map(({body,...publication}) => ({ ...publication, conclusion: JSON.parse(body).conclusion || '' })),
  };
}

export function sourceLinks(db, versions, target, env) {
  return [...new Set(versions)].map(version => {
    const row = db.prepare("SELECT file FROM documents WHERE version=? AND lower(file) LIKE '%.xlsx'").get(version);
    if (!row) throw Error('Версия Excel недоступна в этом пространстве');
    const href = '#knowledge-source/' + version;
    return { file: row.file, version, url: target.local ? href : new URL(href, env.APP_BASE_URL || 'http://127.0.0.1:8090').href };
  });
}

export function excelSources(db) {
  return db
    .prepare(
      `SELECT version,file,created,json_array_length(body,'$.facts') AS total
    FROM documents WHERE lower(file) LIKE '%.xlsx' ORDER BY created DESC,file,version`,
    )
    .all();
}

function workbookRevision(db, version) {
  return db
    .prepare("SELECT file,body,created FROM documents WHERE version=? AND (lower(file) LIKE '%.xlsx' OR lower(file) LIKE '%.pptx')")
    .get(version);
}

const matchesLocation = (fact,loc) => fact.loc === loc || fact.links?.some(link => link.loc === loc);

export function sourceRows(db, version, offset = 0, loc) {
  if (!Number.isSafeInteger(offset) || offset < 0) throw Error('Проверьте номер строки');
  const doc = workbookRevision(db,version);
  if (!doc) throw Error('Версия Excel недоступна в этом пространстве');
  const { facts } = JSON.parse(doc.body);
  if (loc) {
    const index = facts.findIndex(fact => matchesLocation(fact,loc));
    if (index < 0) throw Error('Строка отсутствует в этой версии документа');
    offset = index;
  }
  return {
    file: doc.file,
    version,
    created: doc.created,
    total: facts.length,
    offset,
    rows: facts.slice(offset, offset + 40).map((f) => ({ loc: f.loc,
      links: f.links || [], offer: Boolean(f.comparison), value: f.detail ? f.detail.field + ' · ' + f.detail.answer : f.row || f.text })),
  };
}

export function withArchivedSignalSources(db, signal) {
  const evidence = signal?.evidence;
  if (!signal?.metric || !evidence) return signal;
  const revisions = new Map();
  const resolveRow = row => {
    if ((row.file && row.loc) || !row.version || typeof row.source !== 'string') return row;
    if (!revisions.has(row.version)) {
      const doc = workbookRevision(db,row.version);
      revisions.set(row.version,doc && {file:doc.file, facts:JSON.parse(doc.body).facts});
    }
    const doc = revisions.get(row.version);
    if (!doc) return row;
    const prefix = doc.file + ' · ';
    if (!row.source.startsWith(prefix)) return row;
    const loc = row.source.slice(prefix.length);
    if (!loc || (row.file && row.file !== doc.file) || (row.loc && row.loc !== loc)) return row;
    // The extract route also accepts linked cells. A citation must identify one actual row.
    const matches = doc.facts.filter(fact => matchesLocation(fact,loc));
    const [fact] = matches;
    if (matches.length !== 1 || fact.loc !== loc || fact.kind !== 'metrics') return row;
    if (fact.row?.metric_id !== signal.metric || fact.row.date !== row.date || fact.row.segment !== row.segment) return row;
    return {...row,file:doc.file,loc};
  };
  const withRowSources = sample => ({...sample,rows:sample.rows.map(resolveRow)});
  return {...signal,evidence:{...evidence,baseline:evidence.baseline.map(withRowSources),latest:withRowSources(evidence.latest)}};
}


export function cellSource(db,version,loc) {
  if(typeof version!=='string' || !loc || typeof loc!=='string') throw Error('Выберите версию книги и координату ячейки.');
  const doc=sourceRows(db,version,0,loc);
  const row=doc.rows[0];
  const candidates=row.links.filter(link=>link.loc===loc);
  const links=candidates.length?candidates:row.links;
  if (!links.length) throw Error('В этой записи нет сохранённого URL. Для старой версии повторно загрузите исходную книгу.');
  if (new Set(links.map(link=>link.url)).size>1) throw Error('В строке несколько ссылок. Выберите конкретную ячейку.');
  return {version,file:doc.file,loc,url:links[0].url,value:row.value};
}

export function sourceValues(db,{product,metric,date,segment,sourceId,definitionId,stepDays}) {
  const weekly=metric==='orders_index';
  return db.prepare('SELECT version,file,loc,body FROM facts WHERE kind=? AND json_extract(body,?)=?')
    .all(weekly?'sales':'metrics',weekly?'$.week_start':'$.date',date)
    .map(row=>({...row,data:JSON.parse(row.body)}))
    .filter(({data:d})=>String(weekly?d.product_family:d.product).toLowerCase()===product.toLowerCase())
    .filter(({data:d})=> weekly ? !segment || segment==='all' : d.metric_id===metric && (!segment || d.segment===segment)
       && (!sourceId || d.source_id===sourceId) && (!definitionId || d.definition_id===definitionId) && (!stepDays || d.step_days===stepDays))
    .map(({version,file,loc,data:d})=>({version,file,loc,product,date,metric,segment:d.segment,value:weekly?d.orders_index:d.value,
      unit:weekly?'индекс':d.unit,comment:d.comment,sourceId:d.source_id,definitionId:d.definition_id,stepDays:d.step_days}));
}

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
        escapeXml((r.periods || []).map((p) => p.at(-1) + '/' + p[0]).join(' → ')) +
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
