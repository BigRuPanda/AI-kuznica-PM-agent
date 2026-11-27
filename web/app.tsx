import React,{useEffect,useRef,useState} from 'react';
import {api,calcHref,contextQuery,date,dayDate,fmt,metricNames,segmentNames} from './types';
import type {Release,Report,Journal,Segment,Message,Board} from './types';
import {MetricCard} from './charts';
import {CalculationPage,SavedChart} from './calculations';
import {DataForm} from './forms';
import {Answer} from './answer';
import {Icon} from './icons';
import './style.css';

function stored(key:string){try{return localStorage.getItem('release-v1/'+key)||'';}catch{return '';}}
function remember(key:string,value:string){try{localStorage.setItem('release-v1/'+key,value);}catch{}}
const clock=new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'});
function Avatar({name,agent=false}:{name:string;agent?:boolean}){
  const initials=name.trim().split(/\s+/).slice(0,2).map(word=>word[0]).join('');
  return <span aria-hidden="true" className={'avatar '+(agent?'agent-avatar':name==='Дмитрий'?'second-avatar':'person-avatar')}>{agent?<Icon name="agent"/>:initials}</span>;
}
function Headline({report:r}:{report:Report}){
  const c=r.cards[r.release.target],{before,after}=c.series.all;
  if(c.status!=='ready'||before.value===null||after.value===null)return <p className="lead">{r.overview}</p>;
  const subjects=['Конверсия','Доля оплаченных счетов','Сумма оплат','Средний чек','Доля своевременных продлений'];
  const masculine=c.metric===3;
  const verb=after.value>before.value?(masculine?'вырос':'выросла'):(masculine?'снизился':'снизилась');
  const value=(v:number)=>fmt(v,c.unit).replace(/\s+%/u,'%');
  const change=after.value===before.value?' '+(masculine?'сохранился':'сохранилась')+' на уровне '+value(after.value):
    ' '+verb+' с '+value(before.value)+' до '+value(after.value);
  const explanation=r.overview.startsWith(c.caption)?r.overview.slice(c.caption.length).trim():'';
  const supportingFact=explanation.split(/(?<=[.!?])\s+(?=[А-ЯЁ])/u).at(-1);
  return <p className="lead">{subjects[c.metric]}{change}.{supportingFact&&<span>{supportingFact.replace(/\s+%/gu,'%')}</span>}</p>;
}
export function ReleaseAnalytics({ route, requestedId, author, admin }: {
  route: string; requestedId?: string; author: string; admin: boolean;
}) {
  const [journal, setJournal] = useState<Journal | null>(null);
  const [error, fail] = useState('');
  const [form, setForm] = useState<'import' | 'release' | null>(null);
  const [generation, bump] = useState(0);
  useEffect(() => {
    let active = true;
    api<Journal>('journal').then(data => { if (active) setJournal(data); })
      .catch(e => { if (active) fail(e.message); });
    return () => { active = false; };
  }, [generation]);
  const id = route === 'release' ? requestedId :
    journal?.releases.find(r => r.id === stored('last'))?.id || journal?.releases[0]?.id;
  useEffect(() => {
    if (id && journal?.releases.some(r => r.id === id)) remember('last', id);
  }, [id, journal]);
  return <section className="release-workspace">
    <a className="crumb" href="#releases-list">← Журнал релизов</a>
    {error && <p role="alert">{error}</p>}
    {route === 'calc' ? <CalculationPage id={requestedId || ''}/> :
      journal && id ? <Releases key={id} id={id} journal={journal} author={author}
        generation={generation} onForm={admin ? setForm : undefined}/> :
      <p role="status">{journal ? 'В журнале пока нет релизов.' : 'Загрузка журнала…'}</p>}
    {admin && form && journal && <DataForm kind={form} journal={journal} close={() => setForm(null)}
      onDone={next => { setForm(null); bump(n => n + 1); if (next) location.hash = 'release/' + next; }}/>}
  </section>;
}
function Releases({id,journal,author,generation,onForm}:{id:string;journal:Journal;author:string;generation:number;onForm?:(s:'import'|'release')=>void}){
  const [day,setDay]=useState<number|undefined>(stored(id+'/day')?Number(stored(id+'/day')):undefined),[seg,setSeg]=useState<Segment>((stored(id+'/seg')||'all') as Segment);
  const [r,setReport]=useState<Report|null>(null),[error,fail]=useState(''),[metric,select]=useState<number|null>(null);
  const [messages,setMessages]=useState<Message[]>([]),[boards,setBoards]=useState<Board[]>([]),[board,setBoard]=useState(''),[question,write]=useState(''),[busy,wait]=useState(false);
  const [left,showLeft]=useState(stored('left')!=='false'),[right,showRight]=useState(stored('right')!=='false'),[pane,setPane]=useState('main');
  const [lw,setLw]=useState(()=>Number(stored('lw'))||Math.max(200,Math.min(280,Math.round(innerWidth*.18)))),[rw,setRw]=useState(()=>Number(stored('rw'))||Math.max(270,Math.min(420,Math.round(innerWidth*.26))));
  const [narrow,setNarrow]=useState(()=>matchMedia('(max-width: 850px)').matches);
  const chatLog=useRef<HTMLDivElement>(null),chatFlow=useRef<HTMLDivElement>(null),followChat=useRef(true);
  const [history,setHistory]=useState<{day:number;start:number}|null>(null);
  const lastActivity=useRef('');
  const [refresh,rerun]=useState(0);const initial=useRef(new Set<string>()),activitySeq=useRef(0),alive=useRef(true);
  const requestId=useRef(''),chatBox=useRef<HTMLInputElement>(null);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  useEffect(()=>{
    const media=matchMedia('(max-width: 850px)');
    const changed=()=>setNarrow(media.matches);
    media.addEventListener('change',changed);return()=>media.removeEventListener('change',changed);
  },[]);
  useEffect(()=>{
    const log=chatLog.current,flow=chatFlow.current;
    if(!log||!flow)return;
    const observer=new ResizeObserver(()=>{
      if(followChat.current&&!document.querySelector('dialog[open]'))log.scrollTop=log.scrollHeight;
    });
    observer.observe(flow);return()=>observer.disconnect();
  },[]);
  useEffect(()=>{let active=true;fail('');setReport(null);
    api<Report>('report?'+contextQuery({releaseId:id,segment:seg,day})).then(p=>{
      if(!active)return;
      setReport(p);
    }).catch(e=>{if(active)fail(e.message);});
    return()=>{active=false;};},[id,day,seg,generation,refresh]);
  async function activity(){
    const seq=++activitySeq.current;
    try{
      const a=await api<{messages:Message[];boards:Board[]}>('activity?'+contextQuery({releaseId:id}));
      if(!alive.current||seq!==activitySeq.current)return;
      const snapshot=JSON.stringify(a);
      if(lastActivity.current!==snapshot){lastActivity.current=snapshot;setMessages(a.messages);setBoards(a.boards);}
    }
    catch(e){if(alive.current)fail((e as Error).message);}
  }
  useEffect(()=>{
    const check=()=>{if(!document.hidden)void activity();};
    void activity();const t=setInterval(check,2500);document.addEventListener('visibilitychange',check);
    return()=>{clearInterval(t);document.removeEventListener('visibilitychange',check);};
  },[id]);
  useEffect(()=>{
    if(!r||r.report||['offline','local'].includes(journal.mode)||r.cards[r.release.target].status!=='ready')return;
    const key=r.context.version+'/'+r.context.day;if(initial.current.has(key))return;initial.current.add(key);
    api('initial',{...r.context,segment:'all'}).then(()=>{if(alive.current)rerun(n=>n+1);}).catch(e=>{if(alive.current)fail(e.message);});
  },[r,journal.mode]);
  async function ask(e:React.FormEvent){
    e.preventDefault();if(!r||busy||!question.trim())return;wait(true);fail('');
    if(!requestId.current)requestId.current=crypto.randomUUID();
    try{await api('chat',{...r.context,metric:metric??r.release.target,author,question,requestId:requestId.current});write('');requestId.current='';await activity();if(alive.current)rerun(v=>v+1);}
    catch(ex){fail((ex as Error).message);}finally{if(alive.current)wait(false);}
  }
  function grip(side:'left'|'right'){
    const value=side==='left'?lw:rw,sign=side==='left'?1:-1,min=side==='left'?130:205;
    const resize=(n:number)=>{const v=Math.min(side==='left'?280:420,Math.max(min,n));(side==='left'?setLw:setRw)(v);remember(side==='left'?'lw':'rw',String(v));};
    return <div className={'grip '+side} role="separator" aria-label={side==='left'?'Ширина списка':'Ширина чата'} aria-orientation="vertical" aria-valuemin={min} aria-valuemax={side==='left'?280:420} aria-valuenow={value} tabIndex={0}
      onKeyDown={e=>{if(e.key==='ArrowLeft'||e.key==='ArrowRight'){e.preventDefault();resize(value+(e.key==='ArrowRight'?12:-12)*sign);}}}
      onPointerDown={e=>{const el=e.currentTarget,x=e.clientX;el.setPointerCapture(e.pointerId);el.onpointermove=p=>resize(value+(p.clientX-x)*sign);el.onlostpointercapture=()=>{el.onpointermove=null;};}}/>;
  }
  function toggle(side:string){
    if(narrow){setPane(pane===side?'main':side);return;}
    if(side==='left'){showLeft(!left);remember('left',String(!left));}else{showRight(!right);remember('right',String(!right));}
  }
  const rel=r?.release||journal.releases.find(e=>e.id===id),names=[...new Set(boards.map(b=>b.name))];
  const cutoff=r?.context.day??day;
  const eligible=messages.filter(m=>cutoff!==undefined&&m.context.day<=cutoff);
  const latestQuestion=Math.max(0,eligible.map(m=>m.role).lastIndexOf('user'));
  const historyStart=history&&history.day===cutoff?history.start:latestQuestion;
  useEffect(()=>{
    if(cutoff!==undefined&&eligible.length&&history?.day!==cutoff)setHistory({day:cutoff,start:latestQuestion});
  },[cutoff,eligible.length,history?.day,latestQuestion]);
  function showHistory(){
    if(cutoff===undefined)return;
    followChat.current=false;setHistory({day:cutoff,start:0});
    requestAnimationFrame(()=>chatLog.current?.scrollTo(0,0));
  }
  const viewMetric=metric??rel?.target??0;
  function sideHeading(side:'left'|'right',heading:string){
    const open=narrow?pane===side:(side==='left'?left:right);
    const label=narrow?'К разбору':(open?'Свернуть ':'Открыть ')+(side==='left'?'список релизов':'обсуждение');
    return <header className="side-heading"><h2>{heading}</h2><button type="button" className="icon-button fold-button" aria-label={label} title={label} aria-controls={side+'-content'} aria-expanded={open} onClick={()=>toggle(side)}><Icon name={(side==='left')===open?'left':'right'}/></button></header>;
  }
  return <div className="layout" data-pane={pane} style={{'--lw':left?lw+'px':'44px','--rw':right?rw+'px':'44px','--lg':left?'6px':'1px','--rg':right?'6px':'1px'} as React.CSSProperties}>
    <aside className={'sidebar'+(!left&&!narrow?' folded':'')} aria-label="Список релизов">{sideHeading('left','Релизы')}
    <div className="side-body" id="left-content"><div className="release-list">{journal.releases.map(v=><a href={'#release/'+v.id} key={v.id} aria-current={id===v.id?'page':undefined} className={'release-link '+(id===v.id?'chosen':'')} onClick={()=>setPane('main')}><small>{v.id} · {date(v.launch)}</small><strong>{v.title}</strong></a>)}</div>
    {onForm&&<div className="side-actions"><button onClick={()=>onForm('release')}><Icon name="plus"/>Добавить релиз</button><button onClick={()=>onForm('import')}><Icon name="download"/>Импорт CSV</button></div>}</div></aside>{left&&grip('left')}
    <section className="dashboard" aria-label="Аналитика релиза"><div className="report-head"><div className="mobile-switch"><button onClick={()=>toggle('left')}>‹ Список релизов</button><button onClick={()=>toggle('right')}>Обсуждение ›</button></div>
    <small className="eyebrow">{id}{rel?' · '+date(rel.launch):''}{r?' · '+({ready:'Разбор готов',missing:'Нужны данные',preliminary:'Предварительный разбор'}[r.cards[r.release.target].status]):''}</small><h1>{rel?.title||'Релиз'}</h1>
    {error&&<p role="alert" className="error">{error}</p>}
    {r&&<Headline report={r}/>}</div>
    {r?<><div className="filter-area">
    <div className="filters"><label className="icon-select" title="Данные на дату"><Icon name="calendar"/><select aria-label="Данные на" value={r.context.day} onChange={e=>{setDay(+e.target.value);remember(id+'/day',e.target.value);}}>{Array.from({length:r.last+1},(_,j)=><option key={j} value={j}>{dayDate(r.release.launch,j)}</option>)}</select></label>
    <label className="icon-select" title="Сегмент клиентов"><Icon name="people"/><select aria-label="Клиенты" value={seg} onChange={e=>{setSeg(e.target.value as Segment);remember(id+'/seg',e.target.value);}}>{Object.entries(segmentNames).map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></label>
    {names.length>0&&<label>Дашборд <select value={board} onChange={e=>setBoard(e.target.value)}><option value="">Основной обзор</option>{names.map(n=><option key={n}>{n}</option>)}</select></label>}</div>
    <details className="about"><summary>О релизе</summary><p>{r.release.description}</p><p>Аудитория · {r.release.audience}</p><p>Главный вопрос · {r.release.question}</p>
    {r.report?.summaryMetric===r.release.target&&r.report.version===r.context.version&&<details><summary>Первый разбор · {dayDate(r.release.launch,r.report.day)}</summary><Answer text={r.report.answer}/><a href={calcHref(r.report.calc)}>Открыть расчёт</a></details>}</details></div>
    {board?<section><h2>{board}</h2>{boards.filter(b=>b.name===board).map(b=><SavedChart key={b.calc} id={b.calc}/>)}</section>:<>
    <p className="period">Сравнение за семь суток до и после запуска. Границы периодов в {clock.format(r.release.launch)} МСК.</p>
    {r.cards.map(c=><MetricCard key={r.context.version+'/'+seg+'/'+r.context.day+'/'+c.metric} card={c} report={r} select={()=>select(c.metric)}/>)}</>}</>:!error&&<p>Загружаем расчёты…</p>}</section>
    {right&&grip('right')}<aside className={'thread'+(!right&&!narrow?' folded':'')} aria-label="Обсуждение релиза">{sideHeading('right','Обсуждение релиза')}
      <div className="thread-body" id="right-content"><small className="thread-id">{id} · общая ветка</small>
      <div className="chat" ref={chatLog} onScroll={e=>{const el=e.currentTarget;followChat.current=el.scrollHeight-el.scrollTop-el.clientHeight<28;}}><div className="chat-flow" ref={chatFlow}>
      {historyStart>0&&<button type="button" className="earlier" onClick={showHistory}>Предыдущие сообщения <span>{historyStart}</span></button>}
      {eligible.slice(historyStart).map((m,j)=><article key={j+historyStart} className={'msg '+m.role}><header><Avatar name={m.author} agent={m.role==='assistant'}/><strong>{m.author}</strong><time dateTime={new Date(m.created).toISOString()} title={new Date(m.created).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК'}>{clock.format(m.created)}</time></header><div className="message-body"><Answer text={m.text} compact={m.role==='assistant'&&m.refs?.some(ref=>ref.op==='build_chart')}/>
      {m.refs?.filter(ref=>ref.op==='build_chart').map(ref=><SavedChart key={ref.id} id={ref.id} preview author={author} suggested={names} onSave={()=>void activity()}/>)}
      {m.refs?.filter(ref=>ref.op!=='build_chart').map(ref=><a className="ref" href={calcHref(ref.id)} key={ref.id}>{ref.title} ↗</a>)}<small className="message-context">{segmentNames[m.context.segment]} · срез на {rel?dayDate(rel.launch,m.context.day):''}</small></div></article>)}</div></div>
      <footer className="chat-footer">{journal.mode==='offline'&&<p className="hint">Для ответа подключите модель в серверном .env.</p>}{journal.mode==='local'&&<p className="hint">Локальный режим. В ответе доступны расчёт выбранной метрики и его источник.</p>}
      <button className="suggest" onClick={()=>{write('Сколько дней обычно проходит от выставления счёта до оплаты? Построй график медианы.');requestId.current='';chatBox.current?.focus();}}>Исследовать скорость оплаты</button>
      <form className="composer" onSubmit={ask}><small>{busy?'Агент проверяет данные…':metricNames[viewMetric]+' · '+segmentNames[seg]}</small><div className="compose-field"><input ref={chatBox} aria-label="Спросить агента" required maxLength={1500} value={question} placeholder="Спросить агента…" onChange={e=>{write(e.target.value);requestId.current='';}}/>
      <button className="primary send" aria-label="Отправить вопрос" title="Отправить вопрос" disabled={!r||busy||!question.trim()}><Icon name="send"/></button></div></form></footer></div>
    </aside></div>;
}
