import {useState} from 'react';
import {api,calcHref,dayDate,fmt,segmentNames} from './types';
import type {Card,Report,Row,Series,Derived} from './types';
import {Trend,lines} from './trend';
import {eventSample,metricSample} from './metric-values';
import {PeriodSummary} from './period-summary';

export function Comparisons({series,unit,metric}:{series:Record<string,Pick<Series,'before'|'after'>>,unit:string;metric:number}){
  function cell(row:Row){
    return <td>{fmt(row.value,unit)}<small className="table-basis">{metricSample(row,metric)}</small>
      {!!row.pending&&<small className="table-basis">Ожидают · {fmt(row.pending)}</small>}</td>;
  }
  return <table className="numbers"><thead><tr><th>Версия</th><th>До запуска</th><th>После запуска</th></tr></thead><tbody>{Object.entries(series).map(([k,s])=><tr key={k}><td>{lines[k]?.title||k}</td>{cell(s.before)}{cell(s.after)}</tr>)}</tbody></table>;
}
const launchTime = new Intl.DateTimeFormat('ru-RU', {
  hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow',
});
export function MetricCard({card:c,report:r,select,insight}:{card:Card;report:Report;select:()=>void;insight?:string}){
  const mark=r.report?.highlights.find(h=>h.metric===c.metric),notes=r.notes.filter(n=>n.metric===c.metric);
  const [proof,setProof]=useState(''),[error,setError]=useState('');
  const {before,after}=c.series.all;
  return <article className={'card '+(mark?'important':'')}><div className="metric-head"><h3>{c.title}</h3>
    <PeriodSummary before={{...before,sample:metricSample(before,c.metric)}} after={{...after,sample:metricSample(after,c.metric)}} unit={c.unit} launch={r.release.launch} day={r.context.day} status={c.status} asTable/></div>
    <Trend days={r.days} launch={r.release.launch} unit={c.unit} title={c.title} series={Object.fromEntries(Object.entries(c.series).map(([k,v])=>[k,v.daily]))} marks={notes} onInspect={select} rate={c.metric<2} unknown={c.unknown.daily} metric={c.metric} completed={r.completed} pick={async(series,ranges)=>{const saved=await api<{id:string}>('compare',{...r.context,metric:c.metric});return {label:'',selection:{source:'release',calcId:saved.id,version:r.context.version,metric:String(c.metric),series,ranges}};}}/>
    <p className="caption">{c.status==='ready'&&mark&&r.context.segment==='all'&&r.report?.version===r.context.version?mark.reason:c.caption}</p>
    {insight&&<p className="caption">{insight}</p>}
    <details onToggle={e=>{if(e.currentTarget.open)select();}}><summary>Показать расчёт</summary>
    <p>Сравниваются семь суток до и после запуска. Границы суток в {launchTime.format(r.release.launch)} МСК.</p>
    {mark&&<p className="hint">Первый разбор · <a href={calcHref(mark.calc)}>{mark.reason}</a></p>}
    {notes.map(n=><p key={n.calc} className="hint"><a href={calcHref(n.calc)}>{dayDate(r.release.launch,n.start)} – {dayDate(r.release.launch,n.end)} · {segmentNames[n.segment]} · {n.reason}</a></p>)}
    <p>{c.formula}</p><div className="table-scroll"><Comparisons series={c.series} unit={c.unit} metric={c.metric}/></div>
    {Object.keys(c.series).length===1&&<small>Нет данных о версии интерфейса</small>}
    {!!(c.unknown.after.d+c.unknown.after.pending)&&<p>После запуска без версии · {c.unknown.after.d+c.unknown.after.pending}</p>}
    {!!c.both.length&&<details><summary>Видели обе версии · {c.both.length}</summary><p>Учтены по первому показу.</p>{c.both.map((o,j)=><p key={j}>{o.id} · {lines[o.first].title} → {lines[o.first==='old'?'new':'old'].title} · {new Date(o.other).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК</p>)}</details>}
    {proof?<a href={calcHref(proof)}>Открыть сохранённый расчёт</a>:<button onClick={async()=>{try{setProof((await api<{id:string}>('compare',{...r.context,metric:c.metric})).id);}catch(e){setError(String(e));}}}>Получить ссылку на расчёт</button>}
    {error&&<p role="alert">{error}</p>}</details></article>;
}
export function ChartSummary({chart,launch,day}:{chart:Derived;launch:number;day:number}){
  const {before,after,spec}=chart;
  return <><PeriodSummary before={{...before,sample:eventSample(before.n,spec?.end)}} after={{...after,sample:eventSample(after.n,spec?.end)}} unit={chart.unit} launch={launch} day={day} status={chart.status}/>
    {chart.status==='preliminary'&&day>=7&&<small>Источник пока не подтвердил полноту этих семи суток.</small>}</>;
}
export function CustomChart({chart,launch,day,showTitle=true,showFormula=true,calcId,version}:{chart:Derived;launch:number;day:number;showTitle?:boolean;showFormula?:boolean;calcId?:string;version?:string}){
  return <section className="custom">{showTitle&&<h3>{chart.title}</h3>}
    <ChartSummary chart={chart} launch={launch} day={day}/>
    <Trend series={{all:chart.daily}} days={chart.days} launch={launch} unit={chart.unit} title={chart.title} sampleEvent={chart.spec?.end} pick={calcId?(series,ranges)=>({label:'',selection:{source:'release',calcId,version,metric:'derived',series,ranges}}):undefined}/>
    {showFormula&&<p>{chart.formula}</p>}</section>;
}
