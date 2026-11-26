import {useState} from 'react';
import {RangeChart,DAY} from './range-chart';
import type {Pick as RangePick} from './range-chart';
import {calcHref,dayDate,fmt} from './types';
import {eventSample,metricSample} from './metric-values';

export const lines:Record<string,{title:string;color:string}>={
  all:{title:'Все',color:'var(--fg)'},old:{title:'Старая версия',color:'var(--series-control)'},new:{title:'Новая версия',color:'var(--series-main)'}
};
type Point={value:number|null;n:number;d?:number;pending?:number;both?:number};
type Mark={start:number;end:number;reason:string;calc:string};

export function seriesPath(points:{value:number|null}[],x:(index:number)=>number,y:(value:number)=>number){
  let path='';
  const isolated:{x:number;y:number}[]=[];
  points.forEach(({value},i)=>{
    if(value===null)return;
    const start=points[i-1]?.value==null,px=x(i),py=y(value);
    path+=(start?'M':'L')+px.toFixed(2)+' '+py.toFixed(2)+' ';
    if(start&&points[i+1]?.value==null)isolated.push({x:px,y:py});
  });
  return {path,isolated};
}

const time=new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'});
export function Trend({series,days,launch,unit,title,marks=[],metric,sampleEvent,pick,completed}:{
 series:Record<string,Point[]>;days:number[];launch:number;unit:string;title:string;marks?:Mark[];onInspect?:()=>void;rate?:boolean;metric?:number;sampleEvent?:string;unknown?:Point[];pick?:RangePick;completed?:number|null
}){
 const [tableOpen,setTableOpen]=useState(false),keys=Object.keys(series);
 function sample(p:Point){return metric===undefined||p.d===undefined?eventSample(p.n,sampleEvent):metricSample({...p,d:p.d},metric)??'—';}
 if(!days.length)return <p>Нет дней для отображения</p>;
 return <div className="trend"><small className="daily-label">По дням · {unit} · начало суток {time.format(launch)} МСК</small>
 <RangeChart release title={title} unit={unit} step={DAY} pivot={launch} pick={pick}
 markers={marks.map(m=>({from:launch+m.start*DAY,to:launch+m.end*DAY,reason:m.reason,href:calcHref(m.calc)}))}
 lines={keys.map(k=>({key:k,name:lines[k].title,color:lines[k].color,points:series[k].map((p,i)=>({at:launch+days[i]*DAY,...p,partial:!!p.pending||completed===null||(completed!==undefined&&completed<launch+(days[i]+1)*DAY)}))}))}/>
    <details className="daily-table" onToggle={e=>setTableOpen(e.currentTarget.open)}><summary>Данные по дням</summary>
      {tableOpen&&<div className="table-scroll"><table className="numbers"><caption>{title} · {time.format(launch)} МСК, начало суток</caption>
        <thead><tr><th scope="col">Дата</th>{keys.map(k=><th scope="col" key={k}>{keys.length===1?'Значение':lines[k].title}</th>)}</tr></thead>
        <tbody>{days.map((d,i)=><tr key={d}><th scope="row">{dayDate(launch,d)}</th>{keys.map(k=>{const p=series[k][i];return <td key={k}>{fmt(p.value,unit)}<small className="table-basis">{sample(p)}</small>{!!p.pending&&<small className="table-basis">Ожидают · {fmt(p.pending)}</small>}</td>;})}</tr>)}</tbody>
      </table></div>}</details>
  </div>;
}
