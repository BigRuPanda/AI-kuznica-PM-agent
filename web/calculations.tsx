import {useEffect,useId,useState} from 'react';
import {api,calcHref,dayDate,fmt,segmentNames} from './types';
import type {Card,Context,Derived,Row,Segment,Series} from './types';
import {ChartSummary,Comparisons,CustomChart} from './charts';
import {metricSample} from './metric-values';
import {PeriodSummary} from './period-summary';
import {Dialog} from './dialog';
import {seriesPath} from './trend';
import {Icon} from './icons';
import './calculations.css';

type PeriodSeries=Pick<Series,'before'|'after'>;
type Comparison={title:string;unit:string;reason:string;formula:string;status?:Card['status'];series:Record<string,PeriodSeries>};
type IntervalRow=Pick<Row,'value'|'n'|'d'> & {pending?:number};
type Base={id:string;context:Context;launch:number};
export type Calculation=Base & (
  {op:'compare_metric';result:Comparison}|{op:'breakdown';result:Record<string,Comparison>}|
  {op:'build_chart';result:Derived}|{op:'funnel';result:{definition:string;missing:string[];steps:{period:string;checkout:number;invoiced:number;paid:number}[]}}|
  {op:'interval';result:{title:string;reason:string;unit:string;formula?:string;metric?:number;start:number;end?:number;rows:IntervalRow[]}}
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
  if(!preview)return <div className="release-chart">{content}</div>;
  return <div className="release-chart"><button className="chart-preview" type="button" aria-haspopup="dialog" aria-label={'Раскрыть график: '+calc.result.title} aria-describedby={listId+'-summary'} onClick={()=>setOpen(true)}>
    <span className="preview-line"><span>{calc.result.title}</span><Icon name="expand"/></span>
    <span id={listId+'-summary'}><ChartSummary chart={calc.result} launch={calc.launch} day={calc.context.day}/></span><Sparkline chart={calc.result} launch={calc.launch}/>
  </button>{open&&<Dialog title={calc.result.title} wide close={()=>setOpen(false)}><div className="release-chart">{content}</div></Dialog>}</div>;
}
const fullDate = new Intl.DateTimeFormat('ru-RU', { dateStyle: 'short', timeZone: 'Europe/Moscow' });

function versionSeries({series}:Comparison) {
  return Object.fromEntries(Object.entries(series).filter(([key]) => key !== 'all'));
}

function ComparisonVersions({comparison,metric,label}:{comparison:Comparison;metric:number;label:string}) {
  const versions = versionSeries(comparison);
  if (!Object.keys(versions).length) return null;
  return <div className="table-scroll" role="region" tabIndex={0} aria-label={label}>
    <Comparisons series={versions} unit={comparison.unit} metric={metric}/>
  </div>;
}

function BreakdownResult({result,metric}:{result:Record<string,Comparison>;metric:number}) {
  const segments = Object.entries(result);
  const segmentsWithVersions = segments.filter(([, {series}]) => Object.keys(series).some(key => key !== 'all'));
  return <>
    <h2>По сегментам</h2>
    <div className="table-scroll" role="region" tabIndex={0} aria-label="Значения по сегментам">
      <table className="numbers">
        <thead><tr><th scope="col">Сегмент</th><th scope="col">До запуска</th><th scope="col">После запуска</th></tr></thead>
        <tbody>{segments.map(([key, comparison]) => <tr key={key}>
          <th scope="row">{segmentNames[key as Segment] ?? key}{comparison.reason && <small className="table-basis">{comparison.reason}</small>}</th>
          {(['before', 'after'] as const).map(period => {
            const row = comparison.series.all?.[period];
            return <td key={period}>{row ? fmt(row.value, comparison.unit) : '—'}
              {row && <small className="table-basis">{metricSample(row, metric)}</small>}
              {!!row?.pending && <small className="table-basis">Ожидают · {fmt(row.pending)}</small>}
            </td>;
          })}
        </tr>)}</tbody>
      </table>
    </div>
    {segmentsWithVersions.length > 0 && <details>
      <summary>Версии по сегментам</summary>
      {segmentsWithVersions.map(([key, comparison]) => <div key={key}>
        <h3>{segmentNames[key as Segment] ?? key}</h3>
        <ComparisonVersions comparison={comparison} metric={metric} label={'Версии · ' + (segmentNames[key as Segment] ?? key)}/>
      </div>)}
    </details>}
  </>;
}

function CalculationResult({calc}:{calc:Calculation}) {
  const {context,launch} = calc;
  if (calc.op === 'build_chart') return <CustomChart calcId={calc.id} version={context.version} chart={calc.result}
    launch={launch} day={context.day} showTitle={false} showFormula={false}/>;
  if (calc.op === 'compare_metric') {
    const {before,after} = calc.result.series.all;
    const withSample = (row:Row) => ({ ...row, sample: metricSample(row, context.metric) });
    return <>
      <PeriodSummary before={withSample(before)} after={withSample(after)} unit={calc.result.unit} launch={launch}
        day={context.day} status={calc.result.status}/>
      {calc.result.reason && <p>{calc.result.reason}</p>}
      <ComparisonVersions comparison={calc.result} metric={context.metric} label="Результат по версиям интерфейса"/>
    </>;
  }
  if (calc.op === 'breakdown') return <BreakdownResult result={calc.result} metric={context.metric}/>;
  if (calc.op === 'funnel') return <>
    {calc.result.missing.length > 0 && <p>Для расчёта нужны {calc.result.missing.join(', ')}</p>}
    <div className="table-scroll" role="region" tabIndex={0} aria-label="Шаги воронки">
      <table className="numbers">
        <thead><tr><th scope="col">Период</th><th scope="col">Начали оформление</th><th scope="col">Выставили счёт</th><th scope="col">Оплатили</th></tr></thead>
        <tbody>{calc.result.steps.map(step => <tr key={step.period}>
          <th scope="row">{step.period === 'before' ? 'До запуска' : 'После запуска'}</th>
          <td>{fmt(step.checkout)}</td><td>{fmt(step.invoiced)}</td><td>{fmt(step.paid)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
  const {reason,rows,start,unit,metric = context.metric} = calc.result;
  return <>
    {reason && <p className="proof-finding">{reason}</p>}
    <div className="table-scroll" role="region" tabIndex={0} aria-label="Исходные значения по дням">
      <table className="numbers">
        <thead><tr><th scope="col">Дата</th><th scope="col">Значение</th><th scope="col">Выборка</th></tr></thead>
        <tbody>{rows.map((row,index) => <tr key={start + index}>
          <th scope="row">{dayDate(launch, start + index)}</th>
          <td>{fmt(row.value, unit)}</td>
          <td>{metricSample(row, metric) ?? '—'}{!!row.pending && <small className="table-basis">Ожидают · {fmt(row.pending)}</small>}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </>;
}

export function CalculationPage({id}:{id:string}){
  const {calc,error}=useCalculation(id);
  if (!calc) return <section className="proof-page calculation-proof">
    <a className="crumb" href="#releases">← К релизам</a>
    {error ? <p role="alert">{error}</p> : <p role="status">Открываем расчёт…</p>}
  </section>;
  const {context,launch} = calc;
  const metric = calc.op === 'breakdown' ? calc.result.all ?? Object.values(calc.result)[0] : calc.result;
  const title = calc.op === 'funnel' ? 'Шаги воронки' : metric && 'title' in metric ? metric.title : 'Расчёт по сегментам';
  const formula = calc.op === 'funnel' ? calc.result.definition : metric && 'formula' in metric ? metric.formula : undefined;
  const period = calc.op === 'interval' ? dayDate(launch, calc.result.start) + ' – ' + dayDate(launch, calc.result.end ?? calc.result.start + calc.result.rows.length) :
    dayDate(launch, -7) + ' – ' + dayDate(launch, Math.min(context.day, 7));
  return <section className="proof-page calculation-proof">
    <a className="crumb" href={'#release/' + encodeURIComponent(context.releaseId)}>← К релизу {context.releaseId}</a>
    <header className="proof-header">
      <h1>{title}</h1>
      <dl className="proof-context">
        <div><dt>Срез на</dt><dd>{fullDate.format(launch + context.day * 86400000)}</dd></div>
        <div><dt>Период</dt><dd>{period}</dd></div>
        <div><dt>Сегмент</dt><dd>{segmentNames[context.segment]}</dd></div>
      </dl>
    </header>
    <div className="paper proof-result"><CalculationResult calc={calc}/></div>
    <details className="paper proof-method">
      <summary>{formula ? 'Формула и версия данных' : 'Версия данных'}</summary>
      {formula && <p>{formula}</p>}
      <p>Версия данных <code>{context.version}</code></p>
    </details>
  </section>;
}
