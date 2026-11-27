import { digest, effect, facts, fmt, listSales } from './evidence.mjs';
import { visibleCase } from './workbench.mjs';
import { readMaterial } from './materials.mjs';
import { access,readSnapshot,readRange } from './chart-ranges.mjs';
import { releaseEvidence } from './release-decision.mjs';

const clean = v => String(v ?? '').replace(/\*\*|\x00/g, '').trim();
const source = (label, url) => ({ label: clean(label), url });
const caseLink = id => '#case/' + encodeURIComponent(id);
const date = value => {
  const d=new Date(value);
  return value && Number.isFinite(d.getTime()) ? d.toISOString().slice(0,10) : '';
};
const unique = refs => [...new Map(refs.filter(r => r?.url).map(r => [r.url, r])).values()];
const allowed=(db,user,id,shared=false)=>{try {access(db,user,id,shared);return true;} catch {return false;}};
const archiveRef = r => source(r.file + ' · ' + r.loc, '#knowledge-source/' + r.version + '/' + encodeURIComponent(r.loc));
const salesRef = r => source(r.source,'#knowledge-source/'+r.version+'/'+encodeURIComponent(r.source.split(' · ').at(-1)));
const titleOf = (s, fallback) => clean(s).split(/\n/u)[0] || fallback;

export function releasePresentationInput(db, user, caseId, created, decision) {
  const c = visibleCase(db,user,caseId);
  if ((c.body.release || c.body.signal?.releaseId) !== decision.release.id || c.product !== decision.product)
    throw Error('Срез относится к другому разбору.');
  const {scope,evidence} = releaseEvidence(db,decision);
  const checks = [], candidates = [];
  const missing = 'Решение по этому срезу не зафиксировано.';
  for (const {kind,data,sources} of evidence) {
    const refs = sources.map(archiveRef);
    if (kind === 'orders-index') {
      const title = 'Недельный индекс самостоятельных заказов';
      candidates.push({kind:'chart',title,unit:'п. индекса',series:[{name:c.product,
        points:[...data.baseline.rows,...data.current.rows].map(row=>({label:row.date,value:row.value}))}],refs});
      checks.push({date:scope.through,stage:title,result:fmt(data.baseline.mean)+' → '+fmt(data.current.mean)+' п.',refs});
    } else if (kind === 'interview' && data.excerpt) {
      candidates.push({kind:'quote',title:'Интервью',body:clean(data.excerpt),refs});
    } else if (kind === 'release' || kind === 'backlog') {
      checks.push({date:data.date,stage:kind==='release'?'Релиз':'Бэклог',
        result:[data.id,data.title || data.description].filter(Boolean).join(' · '),refs});
    } else if (kind === 'account-metrics') {
      const rows = data.comparisons.map(row=>[row.segment,fmt(row.baseline.total),fmt(row.observation.total),row.state]);
      if (rows.length) candidates.push({kind:'table',title:'Визиты с кликом',refs,
        columns:['Сегмент','До','После','Состояние измерения'],rows});
    }
  }
  const title = decision.product+' · '+decision.release.id;
  const period = (scope.from ? scope.from+' — ' : 'По ')+scope.through;
  const card = source('Карточка разбора',caseLink(caseId));
  return {caseId,product:c.product,title,state:'Исторический срез',created,personal:true,checks,candidates,savedDecision:false,
    cover:{kind:'cover',title,body:'Срез данных · '+period,decision:missing,decisionTitle:'Статус решения',refs:[card]},
    decision:{kind:'decision',title:'Статус решения',body:missing,rows:[],refs:[]}};
}

// Collect a coherent version while the caller holds its SQLite transaction.
export function casePresentationInput(db, user, caseId, created) {
  const c = visibleCase(db,user,caseId), b = c.body;
  const card = source('Карточка разбора',caseLink(c.id));
  const candidates=[], checks=[], seenChecks=new Map(), seenMaterials=new Set();
  let personal=Boolean(b.owner);
  function check(when, stage, result, refs=[card]) {
    result=clean(result);
    if (!result) return;
    const key=stage+'\n'+result;
    const prior=seenChecks.get(key);
    if (prior) { prior.refs=unique([...prior.refs,...refs]); return; }
    const row={date:when ? date(when) : '',stage,result,refs:unique(refs)};
    checks.push(row); seenChecks.set(key,row);
  }
  function candidate(slide) {
    const entry={...slide,refs:unique(slide.refs || [card])};
    if (!candidates.some(s=>JSON.stringify(s)===JSON.stringify(entry))) candidates.push(entry);
  }
  const signal=b.signal, plan=b.plan || {}, watch=b.watch;
  const observed=watch ? effect(db,c) : null;
  let headline='', keyValue='', keyLabel='', leadRefs=[card];
  const withdrawn=signal?.status==='withdrawn';
  if(withdrawn) {
    headline='Сигнал отозван после пересчёта';
    check(signal.week,'Статус сигнала',headline);
  }
  if (signal?.metric) {
    const rows=[...(signal.evidence?.baseline || []),signal.evidence?.latest].filter(Boolean);
    const refs=rows.flatMap(week=>(week.rows || []).filter(r=>r.version && r.source).map(salesRef));
    if(!withdrawn) {
      if(refs.length) leadRefs=refs;
      keyLabel=signal.title || signal.metric;
      keyValue=Number.isFinite(signal.change) ? fmt(signal.change)+' '+(signal.changeUnit || '') : '';
      headline=keyValue ? keyLabel+' · изменение '+keyValue : keyLabel;
      check(signal.week,'Исходный сигнал',headline,leadRefs);
    }
    if(rows.length && (!withdrawn || refs.length)) candidate({kind:'table',
      title:withdrawn?'Данные первоначального сигнала':'Наблюдения по сигналу',
      columns:['Начало недели','Числитель','Знаменатель'],rows:rows.map(r=>[r.week,fmt(r.n),fmt(r.d)]),refs:refs.length?refs:[card]});
  } else if (signal) {
    const history=listSales(db).filter(r=>r.product===c.product && !r.partial && r.week<=signal.week);
    const rows=signal.rule==='relative' ? history.slice(-16) : history.filter(r=>r.week>=signal.start);
    const refs=rows.map(salesRef);
    if (refs.length) leadRefs=refs;
    const relative=signal.rule==='relative' && Number.isFinite(signal.change);
    if(withdrawn) {
      const last=rows.find(r=>r.week===signal.week);
      if(last) {
        keyValue=fmt(last.value);
        keyLabel='индекс за '+last.week+' после пересчёта';
        check(last.week,'Пересчёт сигнала','Индекс самостоятельных заказов составил '+keyValue,[salesRef(last)]);
      }
      const original=(signal.history || []).filter(r=>r.version && r.source && Number.isFinite(r.value));
      if(original.length) {
        const threshold=signal.rule==='absolute' && Number.isFinite(signal.threshold) ? ' · порог '+fmt(signal.threshold) : '';
        candidate({kind:'table',title:'Данные первоначального сигнала'+threshold,columns:['Начало недели','Индекс'],
          rows:original.map(r=>[r.week,fmt(r.value)]),refs:original.map(salesRef)});
      }
    } else {
      keyValue=relative ? fmt(signal.change)+'%' : Number.isFinite(signal.value) ? fmt(signal.value) : '';
      keyLabel=relative ? 'изменение индекса заказов' : 'индекс самостоятельных заказов';
      headline=relative ? 'Средний индекс заказов за четыре недели '+(signal.change<0?'снизился':'вырос')+' на '+fmt(Math.abs(signal.change))+'%' :
        'Недельный индекс самостоятельных заказов составил '+keyValue;
      check(signal.week,'Исходный сигнал',headline,leadRefs);
    }
    if (rows.length) candidate({kind:'chart',
      title:withdrawn?'Индекс самостоятельных заказов после пересчёта':'Как менялся индекс самостоятельных заказов',unit:'пункты индекса',
      series:[{name:c.product,points:rows.map(r=>({label:r.week,value:r.partial ? null : r.value}))}],refs:leadRefs});
    if(relative && rows.length===16 && Date.parse(rows.at(-1).week)-Date.parse(rows[0].week)===15*7*86400000) {
      const groups=[rows.slice(0,12),rows.slice(12)];
      candidate({kind:'table',title:'Четыре недели в сравнении с предыдущими двенадцатью',columns:['Окно','Первые дни недель','Средний индекс'],
        rows:groups.map((g,i)=>[i?'Наблюдение':'База',g[0].week+' — '+g.at(-1).week,fmt(g.reduce((sum,r)=>sum+r.value,0)/g.length)]),refs:leadRefs});
    }
  }
  if (plan.hypothesis) {
    check(null,'Исходная гипотеза',plan.hypothesis);
    candidate({kind:'table',title:'Как проверяем гипотезу',columns:['Условие проверки','Что зафиксировано'],
      rows:[['Гипотеза',plan.hypothesis],['Показатель',plan.metric],['База',plan.baseline],['Контроль',plan.control],['Критерий успеха',plan.success]].filter(r=>r[1])});
  }
  const notes=b.notes || [];
  for (const n of notes) {
    const refs=[card];
    if(n.rangeId && allowed(db,user,n.rangeId)) {
      refs.unshift(source('Проверенный период','#range/'+n.rangeId));
      if(!allowed(db,user,n.rangeId,true)) personal=true;
    }
    check(n.created,'Сохранённый вывод',n.text,refs);
  }
  if (notes.length) {
    candidate({kind:'finding',title:'Вывод продакта',body:notes.at(-1).text,refs:checks.findLast(r=>r.stage==='Сохранённый вывод')?.refs});
  }
  let publishedConclusion='';
  for(const row of db.prepare('SELECT body,created FROM published WHERE case_id=? ORDER BY created').all(c.id)) {
    const publication=JSON.parse(row.body);
    const refs=publication.rangeId ? [source('Опубликованный период','#range/'+publication.rangeId),card] :
      publication.calc ? [source('Опубликованный расчёт','#snapshot/'+publication.calc),card] : [card];
    check(row.created,'Публикация в команду',publication.conclusion || 'Опубликованы материалы разбора',refs);
    if(publication.conclusion) {
      publishedConclusion=publication.conclusion;
      candidate({kind:'finding',title:'Вывод, переданный команде',body:publishedConclusion,refs});
    }
  }
  const releases=facts(db,'releases');
  const release=releases.find(r=>r.data.release_id===(b.release || watch?.releaseId));
  const steps=[];
  if (release) {
    const r=release.data, ref=archiveRef(release);
    const releaseText=[r.release_id,r.release_date,r.description].filter(Boolean).join(' · ');
    check(r.release_date,'Релиз',releaseText,[ref]);
    steps.push({label:'Релиз',text:releaseText,refs:[ref]});
    const ids=String(r.related_task_ids || '').split(/[,;]/).map(v=>v.trim());
    for (const task of facts(db,'backlog').filter(t=>ids.includes(t.data.task_id) || String(t.data.release_id || '').split(/[,;]/).some(v=>v.trim()===r.release_id))) {
      const text=task.data.task_id+' · '+task.data.title, ref=archiveRef(task);
      check(task.data.closed_date || task.data.created_date,'Связанная задача',text,[ref]);
      steps.push({label:'Задача',text,refs:[ref]});
    }
  }
  if (watch) {
    const text=[watch.metric || watch.plan?.title,watch.success || plan.success,observed?.end || observed?.checkAfter].filter(Boolean).join(' · ');
    if(text) { steps.push({label:'Проверка эффекта',text,refs:[card]}); check(watch.deployed,'Проверка эффекта',text); }
    if(Number.isFinite(observed?.actual)) check(observed.end,'Измеренный эффект',fmt(observed.actual)+' '+(observed.unit || '%'));
    if(watch.taskId && !steps.some(s=>s.label==='Задача' && s.text.split(' · ')[0]===watch.taskId))
      steps.push({label:'Задача',text:watch.taskId,refs:[card]});
  }
  const trackerResults=db.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='redmine_results'").get()
    ? db.prepare('SELECT body,created FROM redmine_results WHERE case_id=? ORDER BY created').all(c.id) : [];
  for(const row of trackerResults) {
    const t=JSON.parse(row.body);
    if(t.personalOwner && t.personalOwner!==user.id) continue;
    if(t.personalOwner) personal=true;
    const text=['#'+t.issue,t.status,t.title,t.closing_note?.text].filter(Boolean).join(' · ');
    check(row.created,'Результат задачи',text,[card]);
    steps.push({label:'Результат задачи',text,refs:[card]});
  }
  if(steps.length) candidate({kind:'flow',title:'От изменения продукта до проверки результата',steps,refs:steps.flatMap(s=>s.refs)});

  function plot(title,unit,lines,ref) {
    const series=lines.map(l=>({name:clean(l.key),points:(l.points || []).map(p=>({label:date(p.at),value:Number.isFinite(p.value) && !p.partial ? p.value : null}))}));
    if(series.some(s=>s.points.some(p=>p.value!==null))) candidate({kind:'chart',title,unit,series,refs:[ref]});
  }
  if(b.origin?.calc && allowed(db,user,b.origin.calc)) {
    if(!allowed(db,user,b.origin.calc,true)) personal=true;
    const snap=readSnapshot(db,user,b.origin.calc);
    const ref=source('Сохранённый расчёт','#snapshot/'+b.origin.calc);
    check(null,'Исходный расчёт',snap.title || c.title,[ref]);
    if(snap.points) plot(snap.title || 'Динамика показателя',snap.unit || '',[{key:snap.segment || c.product,points:snap.points.map(p=>({...p,at:p.date}))}],ref);
    else if(snap.summary) plot('Индекс самостоятельных заказов','пункты индекса',snap.summary.map(s=>({key:s.product,points:s.rows.map(r=>({...r,at:r.week}))})),ref);
  }
  function material(id,when) {
    if(seenMaterials.has(id) || !allowed(db,user,id)) return;
    const m=readMaterial(db,user,id);
    seenMaterials.add(id);
    const ref=source(m.title,'#material/'+id);
    check(when,'Материал разбора',m.summary || m.title,[ref]);
    for(const text of m.checks || []) check(when,'Выполненная проверка',text,[ref]);
    for(const text of m.findings || []) {
      check(when,'Результат проверки',text,[ref]);
      candidate({kind:'finding',title:m.title,body:clean(text),refs:[ref]});
    }
    if(m.plot) plot(m.plot.title || m.title,m.plot.unit || '',m.plot.lines || [],ref);
    for(const s of m.sections || []) {
      if(s.text) check(when,s.title,s.text,[ref]);
      if(!s.columns?.length || !s.rows?.length) continue;
      const rows=s.rows.map(r=>r.map(clean));
      check(when,s.title,rows.map(r=>r.join(' · ')).join('\n'),[ref]);
      const funnel=s.columns.includes('Дошли') && s.columns.includes('Шаг');
      candidate({kind:funnel?'funnel':'table',title:s.title,columns:s.columns.map(clean),rows,refs:[ref]});
    }
    for(const child of m.children || []) material(child.id,when);
  }
  const pins=db.prepare('SELECT material FROM case_materials WHERE user=? AND case_id=? ORDER BY rowid').all(user.id,c.id);
  if(pins.length) personal=true;
  for(const p of pins) material(p.material,null);

  const chat=db.prepare(`SELECT a.body,a.created,a.thread,t.scope FROM chat_items a JOIN conversations t ON t.id=a.thread
    LEFT JOIN jobs j ON j.id=json_extract(a.body,'$.jobId')
    WHERE a.role='assistant' AND (t.owner=? OR t.scope='group') AND
    COALESCE(json_extract(a.body,'$.mode'),'')<>'presentation' AND
    (a.thread=? OR json_extract(j.body,'$.caseId')=? OR json_extract(a.body,'$.caseId')=?) ORDER BY a.created,a.seq`)
    .all(user.id,digest(user.id+'/'+caseId),caseId,caseId);
  const docs=new Map();
  for(const row of chat) {
    const msg=JSON.parse(row.body), refs=[], measurements=new Map(),events=[];
    for(const s of msg.readSources || []) {
      const match=/^#knowledge-source\/([a-f\d]{64})\/(.+)$/iu.exec(s.url || '');
      if(!match) continue;
      let loc; try {loc=decodeURIComponent(match[2]);} catch {continue;}
      if(!docs.has(match[1])) {
        const doc=db.prepare('SELECT file,body FROM documents WHERE version=?').get(match[1]);
        docs.set(match[1],doc && {file:doc.file,facts:new Map(JSON.parse(doc.body).facts.map(f=>[f.loc,f]))});
      }
      const doc=docs.get(match[1]), f=doc?.facts.get(loc);
      if(!f) continue;
      const ref=archiveRef({file:doc.file,version:match[1],loc}); refs.push(ref);
      if(f.kind==='interview' && f.detail) candidate({kind:'quote',title:clean(f.detail.field),body:clean(f.detail.answer),refs:[ref]});
      if(f.kind==='releases') events.push({row:f.row,ref});
      if(f.kind==='metrics' && f.row && Number.isFinite(f.row.value)) {
        const d=f.row,key=JSON.stringify([d.metric_id,d.product,d.segment,d.unit]);
        if(!measurements.has(key)) measurements.set(key,[]);
        measurements.get(key).push({d,ref});
      }
    }
    for(const group of measurements.values()) {
      group.sort((a,b)=>a.d.date.localeCompare(b.d.date));
      const first=group[0].d,last=group.at(-1).d,ratio=first.unit==='ratio',unit=ratio?'%':first.unit;
      const label=facts(db,'dictionary').find(r=>r.data.metric_id===first.metric_id)?.data.metric_name || first.metric_id;
      const metricRefs=group.map(p=>p.ref),value=d=>ratio?d.value*100:d.value;
      const event=events.find(({row:r})=>r && r.release_date>=first.date && r.release_date<=last.date &&
        String(r.affected_metrics || '').split(/[,;]/).some(m=>m.trim()===first.metric_id));
      const title=label+' · '+first.segment;
      candidate({kind:'chart',title,unit,style:group.length<=2?'bar':'line',
        series:[{name:first.product+' · '+first.segment,points:group.map(p=>({label:p.d.date,value:value(p.d)}))}],
        event:event && {date:event.row.release_date,text:event.row.description},refs:[...metricRefs,...(event?[event.ref]:[])]});
      if(!keyValue) {
        headline=label+' · '+fmt(value(last))+(unit?' '+unit:'')+' за '+last.date;
        keyValue=fmt(value(last));keyLabel=label;leadRefs=metricRefs;
      }
    }
    for(const m of msg.materials || []) {
      if(!allowed(db,user,m.id)) continue;
      material(m.id,row.created); refs.push(source(m.title,'#material/'+m.id));
      if(!allowed(db,user,m.id,true)) personal=true;
    }
    if(msg.calc && allowed(db,user,msg.calc)) {
      refs.push(source('Расчёт из чата','#snapshot/'+msg.calc));
      if(!allowed(db,user,msg.calc,true)) personal=true;
    }
    for(const id of new Set([msg.rangeId,...(msg.rangeIds || [])].filter(Boolean))) {
      if(!allowed(db,user,id)) continue;
      const range=readRange(db,user,id),ref=source('Сравнение периодов','#range/'+id);
      refs.push(ref);
      if(!allowed(db,user,id,true)) personal=true;
      if(range.periods?.length) {
        const rows=range.periods.flatMap(p=>(p.series || []).map(s=>[date(p.from)+' — '+date(p.to-1),s.key,Number.isFinite(s.value)?fmt(s.value):'Нет наблюдения']));
        if(rows.length) candidate({kind:'table',title:'Сравнение выбранных периодов',columns:['Период','Ряд','Значение'],rows,refs:[ref]});
      }
    }
    if(!refs.length) continue;
    if(row.scope!=='group') personal=true;
    if(msg.text) check(row.created,'Проверка в чате',msg.text,refs);
  }
  const actionStages={draft:'Подготовлен черновик',done:'Действие выполнено',partial:'Действие выполнено частично',
    sending:'Действие отправляется',uncertain:'Запись ожидает подтверждения',obsolete:'Черновик устарел'};
  for(const action of db.prepare('SELECT body,state,external FROM draft_actions WHERE case_id=? AND user=? ORDER BY rowid').all(c.id,user.id)) {
    const body=JSON.parse(action.body);
    const text=[body.title || body.changes?.subject || body.issue?.title,action.external].filter(Boolean).join(' · ');
    if(text) {personal=true;check(null,actionStages[action.state] || 'Действие по разбору',text);}
  }
  checks.sort((a,b)=>(a.date || '9999').localeCompare(b.date || '9999'));
  const latestNote=notes.at(-1)?.text;
  const savedDecision = checks.findLast(row=>row.stage==='Публикация в команду' && row.result===clean(publishedConclusion));
  const decision = savedDecision?.result || 'Решение в разборе пока не зафиксировано.';
  const supporting=candidates.find(s=>s.kind==='finding' || s.kind==='quote');
  const planOnly=plan.hypothesis && checks.every(row=>row.stage==='Исходная гипотеза') && candidates.every(s=>s.kind==='table');
  return {caseId,product:c.product,title:c.title,state:c.state,created,personal,checks,candidates,savedDecision:Boolean(savedDecision),
    cover:{kind:'cover',title:titleOf(withdrawn ? headline : publishedConclusion || latestNote || headline || supporting?.body,c.title),
      body:planOnly ? 'Гипотеза сформулирована. Результат проверки пока не зафиксирован.' :
        checks.length || candidates.length ? c.title : 'Подтверждённых результатов в разборе пока нет.',
      keyValue,keyLabel,decision,decisionTitle:savedDecision?'Сохранённое решение':'Статус решения',
      refs:unique([card,...leadRefs,...(supporting?.refs || [])])},
    decision:{kind:'decision',title:savedDecision?'Сохранённое решение':'Статус решения',body:decision,
      rows:[['Ответственный',b.responsible],['Критерий успеха',plan.success || watch?.condition],['Контроль',plan.control],
        ['Дата проверки',observed?.checkAfter || observed?.end]].filter(r=>r[1]),refs:savedDecision?.refs || [card]}};
}
