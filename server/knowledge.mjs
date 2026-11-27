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
    const index = facts.findIndex(r => r.loc === loc || r.links?.some(link => link.loc === loc));
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
