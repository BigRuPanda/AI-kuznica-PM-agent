import { explicitDates } from './day-comparison.mjs';
import { facts, fmt, listSales, productFamily } from './evidence.mjs';
import { sourceValues } from './knowledge.mjs';
import { observationWithin } from './metric-observations.mjs';

function namedProducts(text,catalog) {
  const families = new Set((text.match(/[\p{L}\p{N}_-]+/gu) || []).map(productFamily));
  const exact = catalog.filter(p => text.includes(p.toLowerCase()));
  return catalog.filter(p => exact.includes(p) || families.has(productFamily(p)) &&
    !exact.some(other => productFamily(other) === productFamily(p)));
}

// A single dated week is an exact lookup. Leave chart requests, explanations,
// multi-period analyses and compound tasks in the analytical workflow.
export function weeklySourceAnswer(db, question, previous, { from, through, full, snapshot, versions, now = Date.now() } = {}) {
  const q = question.toLowerCase();
  const sameWeek = /(?:ту же|эту же|за ту же самую) недел/u.test(q);
  if (!/недел/u.test(q) || /почему|объясни|причин|график|построй|релиз|задач|визит|конверси|динамик|средн(?:ее|ий)|прогноз|интервью|до и после|и (?:составь|подготовь|найди|создай|посчитай изменение)/u.test(q)) return;
  const dates = explicitDates(q, String(new Date(now).getFullYear()));
  const date = dates.length === 1 ? dates[0] : !dates.length && sameWeek ? previous?.weeklyContext?.date : undefined;
  if (!date) return;
  const revenue = /выручк/u.test(q);
  if (!revenue && !/индекс.{0,28}заказ|заказ.{0,28}индекс/u.test(q) && !(sameWeek && previous?.weeklyContext)) return;
  const current = listSales(db).filter(row=>!versions || versions.includes(row.version));
  const weeks = snapshot ? (snapshot.summary || []).flatMap(series=>
    (series.rows || []).map(row=>({...row,product:series.product}))) : current;
  const included = week => observationWithin({date:week,step_days:7},from,through);
  const catalog = [...new Set([snapshot?.product,...weeks.map(r=>r.product),...current.map(r=>r.product)].filter(Boolean))];
  const products = namedProducts(q,catalog);
  if (!products.length) return;
  const timestamp=Date.parse(date+'T00:00:00Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0,10)!==date)
    return {mode:'source-value',outcome:'clarification',readSources:[],text:'Проверьте календарную дату начала недели: '+date+'.'};
  if (revenue) {
    if (snapshot) return {mode:'source-value',steps:['source_value'],outcome:'done',readSources:[],
      text:'На выбранном экране нет подтверждённого ряда выручки за неделю с '+date+'.'};
    if (facts(db,'dictionary').some(r => /выручк|revenue/iu.test([r.data.metric_id,r.data.metric_name].join(' '))) ||
        facts(db,'metrics').some(r => /выручк|revenue/iu.test(r.data.metric_id))) return;
    return {mode:'source-value', steps:['source_value'], outcome:'done', readSources:[],
      text:'В загруженных таблицах продаж есть индекс заказов, а данных о выручке за неделю с '+date+' нет. Рассчитать сумму в рублях по индексу нельзя.'};
  }
  const readSources = [], lines = [], measured = [];
  const comparePrior=/(?:предыдущ|прошл)[а-яё]*\s+недел/u.test(q);
  const requestedDates=comparePrior ? [new Date(timestamp-7*86400000).toISOString().slice(0,10),date] : [date];
  const booked = snapshot && db.prepare('SELECT file FROM documents WHERE version=?');
  for (const product of products) for(const requestedDate of requestedDates) {
    const available = weeks.filter(r=>r.product===product && included(r.week) && (!full || !r.partial));
    let rows = [];
    if (included(requestedDate)) {
      rows = snapshot ? available.filter(r=>r.week===requestedDate && r.version && r.source).flatMap(r=>{
        const file = booked.get(r.version)?.file;
        const prefix = file + ' · ';
        if (!file || !r.source.startsWith(prefix)) return [];
        return [{ version:r.version,file,loc:r.source.slice(prefix.length),product,date:r.week,
          metric:'orders_index',value:r.value,comment:r.partial ? 'Неполная неделя' : undefined }];
      }) : sourceValues(db,{product,metric:'orders_index',date:requestedDate});
      rows = rows.filter(r=>Number.isFinite(r.value) && (!versions || versions.includes(r.version)));
    }
    if (!rows.length) {
      const source = snapshot ? 'На выбранном экране' : 'В доступных продажах';
      lines.push(source+' для '+product+' нет строки за неделю с '+requestedDate+'.' +
        (available.length ? ' Первая неделя в данных — '+available[0].week+', последняя — '+available.at(-1).week+'.' : ''));
    }
    for (const r of rows) {
      const label = r.file+' · '+r.loc;
      lines.push('Индекс самостоятельных заказов '+product+' за неделю с '+requestedDate+' — '+fmt(r.value)+'. '+label+(r.comment ? '. '+r.comment : ''));
      readSources.push({label, url:'#knowledge-source/'+r.version+'/'+encodeURIComponent(r.loc), detail:r.metric+' = '+r.value+' · '+requestedDate});
      measured.push(r);
    }
  }
  if (comparePrior) {
    for (const product of products) {
      const [before,after]=requestedDates.map(day=>measured.filter(r=>r.product===product && r.date===day));
      if (before.length===1 && after.length===1)
        lines.push('Изменение '+product+' к предыдущей неделе — '+fmt(after[0].value-before[0].value)+' п.');
    }
  } else if (measured.length === 2 && measured[0].product !== measured[1].product) {
    const subtract=q.match(/(?:вычти|вычесть|вычитаем)\s+([^.!?]+?)\s+из\s+([^.!?]+)/u);
    const minus=q.match(/([^.!?]+?)\s+минус\s+([^.!?]+)/u);
    let ordered=measured.toSorted((a,b)=>b.value-a.value);
    if(subtract || minus) {
      const operands=subtract ? [subtract[2],subtract[1]] : [minus[1],minus[2]];
      const matches=operands.map(s=>namedProducts(s,products));
      if(matches.every(m=>m.length===1) && matches[0][0]!==matches[1][0])
        ordered=matches.map(([p])=>measured.find(r=>r.product===p));
      else return {mode:'source-value',outcome:'clarification',readSources,text:lines.join('\n')+'\nУточните, из индекса какого продукта вычесть второй индекс.'};
    }
    const [a,b]=ordered;
    lines.push('Разница ('+a.product+' минус '+b.product+') — '+fmt(a.value-b.value)+' п.');
  }
  return {mode:'source-value', steps:['source_value'], outcome:'done', readSources,
    product:products.length===1 ? products[0] : undefined, weeklyContext:{date}, text:lines.join('\n')};
}
