export const compactPresentationVersion=2;
const maxSlides=8;
const slots=['trend','comparison','finding','checks','release'];
const completedChecks=new Set(['Исходный расчёт','Выполненная проверка','Результат проверки']);
const number=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:4});

function uniqueRefs(refs) {
  return [...new Map(refs.filter(ref=>ref?.url?.startsWith('#')).map(ref=>[ref.url,ref])).values()];
}

function slotOf(slide) {
  if(slots.includes(slide.slot)) return slide.slot;
  if(slide.kind==='chart' || slide.kind==='kpi') return 'trend';
  if(slide.kind==='finding' || slide.kind==='quote') return 'finding';
  if(slide.kind==='flow') return slide.steps.some(step=>step.label==='Релиз') ? 'release' : 'checks';
  if(slide.kind==='table' && slide.columns.includes('Условие проверки')) return 'checks';
  return 'comparison';
}

function checkSummary(checks) {
  const steps=checks.filter(check=>completedChecks.has(check.stage)).reverse()
    .map(check=>({label:check.stage,text:check.result,refs:check.refs}));
  if(steps.length) return {kind:'flow',slot:'checks',priority:60,title:'Что проверили',steps};
}

function distinct(items,key) {
  const seen=new Set();
  return items.filter(item=>{
    const value=key(item);
    if(seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

function compactTable({rowRefs,...slide}) {
  const allRows=distinct(slide.rows, row=>JSON.stringify(row));
  const {rows:chosen,noSharedSeries}=tableExcerpt(allRows,slide.columns);
  const refRows=rowRefs && chosen.flatMap(row=>rowRefs[slide.rows.indexOf(row)] || []);
  return {...slide,columns:slide.columns.slice(0,4),rows:chosen.map(row=>row.slice(0,4)),
    totalRows:allRows.length,totalColumns:slide.columns.length,noSharedSeries,refs:refRows?.length?uniqueRefs(refRows):slide.refs};
}

function tableExcerpt(rows,columns) {
  const period=columns.indexOf('Период'), series=columns.indexOf('Ряд');
  if(period>=0 && series>=0) {
    const periods=[...new Set(rows.map(row=>row[period]))];
    if(periods.length>1) {
      const first=rows.filter(row=>row[period]===periods[0]), last=rows.filter(row=>row[period]===periods.at(-1));
      const firstBySeries=new Map(first.map(row=>[row[series],row])), lastBySeries=new Map(last.map(row=>[row[series],row]));
      const shared=[...firstBySeries.keys()].filter(name=>lastBySeries.has(name)).slice(0,2);
      if(shared.length) return {rows:[...shared.map(name=>firstBySeries.get(name)),...shared.map(name=>lastBySeries.get(name))]};
      return {rows:[...first.slice(0,2),...last.slice(0,2)],noSharedSeries:true};
    }
  }
  if(rows.length<=4) return {rows};
  if(columns.includes('Условие проверки')) return {rows:rows.filter(row=>row[0]!=='База').slice(0,4)};
  return {rows:[...rows.slice(0,3),rows.at(-1)]};
}

function compact(slide,slot) {
  if(slide.kind==='table') return compactTable(slide);
  if(slide.kind==='funnel') {
    const periodColumn=slide.columns.indexOf('Период');
    const period=periodColumn<0 ? null : slide.rows.at(-1)?.[periodColumn];
    const rows=periodColumn<0 ? slide.rows : slide.rows.filter(row=>row[periodColumn]===period);
    return {...slide,period,rows:rows.slice(0,5),totalRows:slide.rows.length};
  }
  if(slide.kind==='chart') {
    const series=slide.series.filter(line=>line.points.some(point=>Number.isFinite(point.value))).slice(0,3);
    const dates=series.flatMap(line=>line.points.filter(point=>Number.isFinite(point.value)).map(point=>point.label)).sort();
    return {...slide,series,period:dates[0]===dates.at(-1) ? dates[0] : dates[0]+' — '+dates.at(-1),
      totalSeries:slide.series.length};
  }
  if(slide.kind==='flow') {
    const steps=distinct(slide.steps.filter(step=>step.text),step=>step.text.trim().toLocaleLowerCase('ru-RU'));
    const release=steps.find(step=>step.label==='Релиз');
    const task=steps.find(step=>step.label==='Результат задачи') || steps.find(step=>step.label==='Задача');
    const effect=steps.find(step=>step.label==='Проверка эффекта');
    const displayed=slot==='release' ? [...new Set([release,task,effect,...steps].filter(Boolean))].slice(0,3) : steps.slice(0,3);
    return {...slide,steps:displayed,totalSteps:steps.length,refs:uniqueRefs(displayed.flatMap(step=>step.refs || []))};
  }
  return slide;
}

function hasContent(slide) {
  if(slide.kind==='chart') return slide.series.length>0;
  if(slide.kind==='table' || slide.kind==='funnel') return slide.rows.length>0 && slide.columns.length>0;
  if(slide.kind==='flow') return slide.steps.length>0;
  if(slide.kind==='kpi') return Boolean(slide.value);
  return Boolean(slide.body);
}

function factKey(slide) {
  // The title and link may differ when the same result is saved in two places.
  const content=slide.series || slide.steps?.map(step=>step.text) || slide.rows ||
    (slide.kind==='kpi' ? [slide.value,slide.unit,slide.period,slide.title] : slide.body);
  return JSON.stringify([slide.kind,slide.unit,slide.columns,content]);
}

function headings(slide) {
  const options=[slide.title];
  if(slide.kind==='finding') {
    const first=slide.body.split(/\n|(?<=[.!?])\s+/u)[0];
    if(first.length>=16 && first.length<=106 && first!==slide.title) options.push(first);
  }
  if(slide.kind==='chart' && slide.series.length===1) {
    const points=slide.series[0].points.filter(point=>Number.isFinite(point.value));
    if(points.length>=2 && points[0].value!==points.at(-1).value) {
      const heading=slide.title+' · '+number.format(points[0].value)+' → '+number.format(points.at(-1).value);
      if(heading.length<=106) options.push(heading);
    }
  }
  return options;
}

export function presentationOptions(input) {
  const candidates=[...input.candidates,checkSummary(input.checks)].flatMap((original,index)=>{
    if(!original) return [];
    const slot=slotOf(original), slide=compact(original,slot);
    if(!hasContent(slide)) return [];
    const required=original.required || (input.cover.title.startsWith('Сигнал отозван') &&
      /^(?:Данные первоначального сигнала|Индекс самостоятельных заказов после пересчёта)/u.test(original.title));
    return [{index,slot,slide,required,priority:original.priority ?? 0,headings:headings(slide)}];
  });
  return slots.flatMap(slot=>{
    const ranked=candidates.filter(option=>option.slot===slot).sort((a,b)=>b.priority-a.priority);
    const required=ranked.filter(option=>option.required);
    // Keep the original and recalculated observations distinct when both are cited.
    return distinct(required.length?required:ranked,option=>factKey(option.slide)).slice(0,4);
  });
}

export function fallbackPresentationSelection(options) {
  return distinct(options,option=>option.slot).map(option=>({index:option.index,heading:option.headings.at(-1)}));
}

function sourceGroup(ref) {
  if(!ref.url.startsWith('#knowledge-source/')) return ref.url;
  return ref.url.replace(/(?:!|%21)[A-Z]+\d+$/iu,'');
}

export function assembleDeck(input,selection,options=presentationOptions(input)) {
  const byIndex=new Map(options.map(option=>[option.index,option])), chosen=new Map();
  for(const {index,heading} of [...selection,...fallbackPresentationSelection(options)]) {
    const option=byIndex.get(index);
    if(!option || chosen.has(option.slot)) continue;
    const {priority,required,slot,...content}=option.slide;
    const title=option.headings.includes(heading)?heading:content.title;
    chosen.set(option.slot,{...content,slot:option.slot,title,...(title!==content.title && {subject:content.title})});
  }
  const caseRef=[...input.cover.refs,...input.decision.refs].find(ref=>ref.url.startsWith('#case/'));
  const slides=[input.cover,...slots.flatMap(slot=>chosen.has(slot)?[chosen.get(slot)]:[]),input.decision];
  const cited=slides.map(slide=>uniqueRefs(slide.refs || []).filter(ref=>ref.url!==caseRef?.url));
  const links=distinct([...cited.flatMap(refs=>refs.slice(0,1)),...cited.flat()],sourceGroup).slice(0,6);
  if(links.length) slides.push({kind:'sources',title:'Источники разбора',links});
  if(slides.length>maxSlides) throw Error('Превышен лимит слайдов презентации.');
  return {formatVersion:compactPresentationVersion,product:input.product,title:input.title,created:input.created,
    state:input.state,caseRef,slides};
}
