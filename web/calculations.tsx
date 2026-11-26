import {useEffect,useId,useState} from 'react';
import {api,calcHref,dayDate,fmt,segmentNames} from './types';
import type {Context,Derived,Series} from './types';
import {ChartSummary,Comparisons,CustomChart} from './charts';
import {metricSample} from './metric-values';
import {Dialog} from './dialog';
import {seriesPath} from './trend';
import {Icon} from './icons';
type Comparison={title:string;unit:string;reason:string;formula:string;series:Record<string,Series>};
type Base={id:string;context:Context;launch:number};
export type Calculation=Base & (
  {op:'compare_metric';result:Comparison}|{op:'breakdown';result:Record<string,Comparison>}|
  {op:'build_chart';result:Derived}|{op:'funnel';result:{definition:string;missing:string[];steps:{period:string;checkout:number;invoiced:number;paid:number}[]}}|
  {op:'interval';result:{title:string;reason:string;unit:string;metric?:number;start:number;rows:{value:number|null;n:number;d:number}[]}}
);
export function useCalculation(id:string){
  const [calc,set]=useState<Calculation|null>(null),[error,fail]=useState('');
  useEffect(()=>{let active=true;set(null);fail('');api<Calculation>('calculations/'+encodeURIComponent(id)).then(v=>{if(active)set(v);}).catch(e=>{if(active)fail(e.message);});return()=>{active=false;};},[id]);
  return {calc,error};
}
function Sparkline({chart,launch}:{chart:Derived;launch:number}){
  const values=chart.daily.map(p=>p.value),known=values.filter((v):v is number=>v!==null);
  if(!known.length)return <small>Нет наблюдений</small>;
  const lo=known.reduce((a,b)=>Math.min(a,b)),hi=known.reduce((a,b)=>Math.max(a,b)),n=values.length;
  const x=(i:number)=>2+(i+.5)/n*196;
  const {path,isolated}=seriesPath(chart.daily,x,v=>hi===lo?22:39-32*(v-lo)/(hi-lo));
  const releaseX=x(-chart.days[0]-.5);
  return <span className="mini-trend"><span className="daily-label">По дням · {chart.unit}</span>
    <span className="mini-plot"><span className={'mini-scale'+(hi===lo?' flat':'')}><span>{fmt(hi)}</span>{lo!==hi&&<span>{fmt(lo)}</span>}</span>
    <svg className="sparkline" viewBox="0 0 200 46" preserveAspectRatio="none" aria-hidden="true">
    <line x1="0" x2="200" y1="42" y2="42" className="grid-line"/>
    {releaseX>=0&&releaseX<=200&&<line x1={releaseX} x2={releaseX} y1="2" y2="43" className="launch-rule"/>}
    {isolated.map(p=><circle key={p.x} cx={p.x} cy={p.y} r="2"/>)}<path d={path} fill="none" stroke="currentColor" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/></svg>
    <span className="mini-dates"><span>{dayDate(launch,chart.days[0])}</span><span>{dayDate(launch,chart.days[n-1]+1)}</span></span></span></span>;
}
export function SavedChart({id,author,suggested,onSave,preview=false}:{id:string;author?:string;suggested?:string[];onSave?:()=>void;preview?:boolean}){
  const {calc,error}=useCalculation(id),[board,setBoard]=useState('Скорость оплаты'),[state,setState]=useState(''),[open,setOpen]=useState(false),listId=useId();
  if(!calc||calc.op!=='build_chart')return <p>{error||'Загружается график…'}</p>;
  const content=<div className="saved-chart"><small>{segmentNames[calc.context.segment]} · на {dayDate(calc.launch,calc.context.day)}</small>
    <CustomChart calcId={calc.id} version={calc.context.version} chart={calc.result} launch={calc.launch} day={calc.context.day} showTitle={!preview}/><a href={calcHref(id)} target={preview?'_blank':undefined} rel={preview?'noreferrer':undefined}>Источник расчёта ↗</a>
    {author&&<form onSubmit={async e=>{e.preventDefault();if(state==='Сохранение…')return;setState('Сохранение…');try{await api('boards',{calc:id,name:board,releaseId:calc.context.releaseId,author});setState('Сохранено');onSave?.();}catch(ex){setState((ex as Error).message);}}}>
    <label>Дашборд релиза<input value={board} onChange={e=>{setBoard(e.target.value);setState('');}} list={listId} required maxLength={100}/></label>
    <datalist id={listId}>{suggested?.map(s=><option key={s}>{s}</option>)}</datalist>
    <button disabled={state==='Сохранение…'||state==='Сохранено'}>Сохранить в релиз</button><small role="status">{state}</small></form>}</div>;
  if(!preview)return content;
  return <><button className="chart-preview" type="button" aria-haspopup="dialog" aria-label={'Раскрыть график: '+calc.result.title} aria-describedby={listId+'-summary'} onClick={()=>setOpen(true)}>
    <span className="preview-line"><span>{calc.result.title}</span><Icon name="expand"/></span>
    <span id={listId+'-summary'}><ChartSummary chart={calc.result} launch={calc.launch} day={calc.context.day}/></span><Sparkline chart={calc.result} launch={calc.launch}/>
  </button>{open&&<Dialog title={calc.result.title} wide close={()=>setOpen(false)}>{content}</Dialog>}</>;
}
export function CalculationPage({id}:{id:string}){
  const {calc,error}=useCalculation(id);
  if(!calc)return <section className="page"><a href="#">Журнал релизов</a><p>{error||'Открываем расчёт…'}</p></section>;
  return <main className="proof-page"><a href={'#release/'+calc.context.releaseId}>← К релизу {calc.context.releaseId}</a><h1>Сохранённый расчёт</h1>
    <p>{segmentNames[calc.context.segment]} · срез на {dayDate(calc.launch,calc.context.day)} · версия данных {calc.context.version.slice(0,10)}</p>
    {calc.op!=='interval'&&<p className="muted">До запуска {dayDate(calc.launch,-7)} – {dayDate(calc.launch,0)} · {calc.context.day?'после запуска '+dayDate(calc.launch,0)+' – '+dayDate(calc.launch,Math.min(calc.context.day,7)):'срез на момент запуска'}</p>}
    {calc.op==='build_chart'&&<CustomChart calcId={calc.id} version={calc.context.version} chart={calc.result} launch={calc.launch} day={calc.context.day}/>}
    {calc.op==='compare_metric'&&<><h2>{calc.result.title}</h2><p>{calc.result.formula}</p><p>{calc.result.reason}</p><Comparisons series={calc.result.series} unit={calc.result.unit} metric={calc.context.metric}/></>}
    {calc.op==='breakdown'&&Object.entries(calc.result).map(([k,c])=><section key={k}><h2>{segmentNames[k as keyof typeof segmentNames]}</h2><p>{c.title} · {c.formula} {c.reason}</p><Comparisons series={c.series} unit={c.unit} metric={calc.context.metric}/></section>)}
    {calc.op==='funnel'&&<><h2>Шаги воронки</h2><p>{calc.result.definition}</p>{calc.result.missing.length>0&&<p>Нужны {calc.result.missing.join(', ')}</p>}{calc.result.steps.map(s=><p key={s.period}>{s.period==='before'?'До':'После'} · начали {s.checkout} → выставили счёт {s.invoiced} → оплатили {s.paid}</p>)}</>}
    {calc.op==='interval'&&<><h2>{calc.result.title}</h2><p>{calc.result.reason}</p><table className="numbers"><thead><tr><th>Дата</th><th>Значение</th><th>Выборка</th></tr></thead><tbody>{calc.result.rows.map((r,j)=><tr key={j}><td>{dayDate(calc.launch,calc.result.start+j)}</td><td>{fmt(r.value,calc.result.unit)}</td><td>{metricSample(r,calc.result.metric??calc.context.metric)??'—'}</td></tr>)}</tbody></table></>}
  </main>;
}
