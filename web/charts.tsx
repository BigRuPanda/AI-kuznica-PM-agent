import {api,dayDate,fmt,segmentNames} from './types';
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
export function MetricChart({card,report,openCalculation}:{
  card:Card;report:Report;openCalculation:(id:string)=>void;
}){
  const series = Object.fromEntries(Object.entries(card.series).map(([key, value]) => [key, value.daily]));
  return <Trend days={report.days} launch={report.release.launch} unit={card.unit} title={card.title}
    series={series} marks={report.notes.filter(note => note.metric === card.metric)} openCalculation={openCalculation}
    metric={card.metric} completed={report.completed}
    pick={async (series, ranges) => {
      const saved = await api<{id:string}>('compare', { ...report.context, metric: card.metric });
      return { label: '', selection: {
        source: 'release', calcId: saved.id, version: report.context.version, metric: String(card.metric), series, ranges,
      } };
    }}/>;
}

export function MetricEvidence({card:c,report:r,openCalculation}:{
  card:Card;report:Report;openCalculation:(id:string)=>void;
}){
  const mark = r.report?.highlights.find(item => item.metric === c.metric);
  const notes = r.notes.filter(note => note.metric === c.metric);
  return <details className="paper">
    <summary>Источники и охват</summary>
    <p>Сравниваются семь суток до и после запуска. Границы суток в {launchTime.format(r.release.launch)} МСК.</p>
    {mark&&<p className="hint">Первый разбор · <button type="button" className="text-action"
      onClick={()=>openCalculation(mark.calc)}>{mark.reason}</button></p>}
    {notes.map(n=><p key={n.calc} className="hint"><button type="button" className="text-action"
      onClick={()=>openCalculation(n.calc)}>{dayDate(r.release.launch,n.start)} – {dayDate(r.release.launch,n.end)} · {segmentNames[n.segment]} · {n.reason}</button></p>)}
    {Object.keys(c.series).length===1&&<small>Нет данных о версии интерфейса</small>}
    {!!(c.unknown.after.d+c.unknown.after.pending)&&<p>После запуска без версии · {c.unknown.after.d+c.unknown.after.pending}</p>}
    {!!c.both.length&&<details><summary>Видели обе версии · {c.both.length}</summary><p>Учтены по первому показу.</p>{c.both.map((o,j)=><p key={j}>{o.id} · {lines[o.first].title} → {lines[o.first==='old'?'new':'old'].title} · {new Date(o.other).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК</p>)}</details>}
  </details>;
}

export function MetricCard({card:c,report:r,insight,openComparison,openCalculation}:{
  card:Card;report:Report;insight?:string;openComparison:()=>void;openCalculation:(id:string)=>void;
}){
  const mark = r.report?.highlights.find(item => item.metric === c.metric);
  const {before,after} = c.series.all;
  return <article className={'card ' + (mark ? 'important' : '')}>
    <div className="metric-head">
      <h3>{c.title}</h3>
      <PeriodSummary before={{...before,sample:metricSample(before,c.metric)}} after={{...after,sample:metricSample(after,c.metric)}}
        unit={c.unit} launch={r.release.launch} day={r.context.day} status={c.status} asTable/>
    </div>
    <MetricChart card={c} report={r} openCalculation={openCalculation}/>
    <p className="caption">{c.status==='ready'&&mark&&r.context.segment==='all'&&r.report?.version===r.context.version ? mark.reason : c.caption}</p>
    {insight&&<p className="caption">{insight}</p>}
    <button type="button" className="text-action release-card-action" aria-haspopup="dialog" onClick={openComparison}>
      Показать расчёт
    </button>
  </article>;
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
