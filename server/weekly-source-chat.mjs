import { explicitDates } from './day-comparison.mjs';
import { facts, fmt, listSales, productFamily, sourceValues } from './evidence.mjs';

function namedProducts(text,catalog) {
  const families = new Set((text.match(/[\p{L}\p{N}_-]+/gu) || []).map(productFamily));
  const exact = catalog.filter(p => text.includes(p.toLowerCase()));
  return catalog.filter(p => exact.includes(p) || families.has(productFamily(p)) &&
    !exact.some(other => productFamily(other) === productFamily(p)));
}

// A single dated week is an exact lookup. Leave chart requests, explanations,
// multi-period analyses and compound tasks in the analytical workflow.
export function weeklySourceAnswer(db, question, previous) {
  const q = question.toLowerCase();
  const sameWeek = /(?:ту же|эту же|за ту же самую) недел/u.test(q);
  if (!/недел/u.test(q) || /почему|объясни|причин|график|построй|релиз|задач|визит|конверси|динамик|средн(?:ее|ий)|прогноз|интервью|до и после|и (?:составь|подготовь|найди|создай|посчитай изменение)/u.test(q)) return;
  const dates = explicitDates(q, String(new Date().getFullYear()));
  const date = dates.length === 1 ? dates[0] : !dates.length && sameWeek ? previous?.weeklyContext?.date : undefined;
  if (!date) return;
  const revenue = /выручк/u.test(q);
  if (!revenue && !/индекс.{0,28}заказ|заказ.{0,28}индекс/u.test(q) && !(sameWeek && previous?.weeklyContext)) return;
  const weeks = listSales(db);
  const catalog = [...new Set(weeks.map(r => r.product))];
  const products = namedProducts(q,catalog);
  if (!products.length) return;
  const timestamp=Date.parse(date+'T00:00:00Z');
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString().slice(0,10)!==date)
    return {mode:'source-value',outcome:'clarification',readSources:[],text:'Проверьте календарную дату начала недели: '+date+'.'};
  if (revenue) {
    if (facts(db,'dictionary').some(r => /выручк|revenue/iu.test([r.data.metric_id,r.data.metric_name].join(' '))) ||
        facts(db,'metrics').some(r => /выручк|revenue/iu.test(r.data.metric_id))) return;
    return {mode:'source-value', steps:['source_value'], outcome:'done', readSources:[],
      text:'В загруженных таблицах продаж есть индекс заказов, а данных о выручке за неделю с '+date+' нет. Рассчитать сумму в рублях по индексу нельзя.'};
  }
  const readSources = [], lines = [], measured = [];
  const comparePrior=/(?:предыдущ|прошл)[а-яё]*\s+недел/u.test(q);
  const requestedDates=comparePrior ? [new Date(timestamp-7*86400000).toISOString().slice(0,10),date] : [date];
  for (const product of products) for(const requestedDate of requestedDates) {
    const rows = sourceValues(db, {product, metric:'orders_index', date:requestedDate});
    if (!rows.length) {
      const available = weeks.filter(r => r.product === product);
      lines.push('В загруженных продажах '+product+' нет строки за неделю с '+requestedDate+'. Первая неделя в данных — '+available[0].week+', последняя — '+available.at(-1).week+'.');
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
      const [before,after]=measured.filter(r=>r.product===product);
      if (before && after) lines.push('Изменение '+product+' к предыдущей неделе — '+fmt(after.value-before.value)+' п.');
    }
  } else if (measured.length === 2) {
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
