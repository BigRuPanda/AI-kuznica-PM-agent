import {useEffect,useRef,useState} from 'react';
import {calcHref,dayDate,fmt} from './types';
import {eventSample,metricSample} from './metric-values';

export const lines:Record<string,{title:string;color:string}>={
  all:{title:'Все',color:'#37373b'},old:{title:'Старая версия',color:'#81818a'},new:{title:'Новая версия',color:'#a20c32'}
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

function valueScale(values:number[],unit:string){
  let min=Infinity,max=-Infinity;
  for(const value of values){min=Math.min(min,value);max=Math.max(max,value);}
  if(!values.length){min=0;max=unit==='%'?100:5;}
  const padding=(max-min)*.07||Math.max(Math.abs(max)*.1,1);
  const bottom=min<0?min-padding:Math.max(0,min-padding),top=unit==='%'?Math.min(100,max+padding):max+padding;
  const rough=(top-bottom)/5,magnitude=10**Math.floor(Math.log10(rough));
  const step=[1,2,2.5,5,10].reduce((best,n)=>Math.abs(n*magnitude-rough)<Math.abs(best*magnitude-rough)?n:best)*magnitude;
  const lo=Math.floor(bottom/step)*step,hi=unit==='%'?Math.min(100,Math.ceil(top/step)*step):Math.ceil(top/step)*step;
  const ticks=Array.from({length:Math.round((hi-lo)/step)+1},(_,i)=>lo+i*step);
  return {lo,hi,ticks};
}
function axisValue(value:number,unit:string){
  if(value>=1000000)return fmt(value/1000000)+' млн';
  if(value>=1000)return fmt(value/1000)+' тыс.';
  return fmt(value)+(unit==='%'?'%':'');
}
const time=new Intl.DateTimeFormat('ru-RU',{hour:'2-digit',minute:'2-digit',timeZone:'Europe/Moscow'});

export function Trend({series,days,launch,unit,title,marks=[],onInspect,rate=false,metric,sampleEvent,unknown}:{
  series:Record<string,Point[]>;days:number[];launch:number;unit:string;title:string;marks?:Mark[];onInspect?:()=>void;rate?:boolean;metric?:number;sampleEvent?:string;unknown?:Point[]
}){
  const [hidden,setHidden]=useState<string[]>([]),[index,choose]=useState<number|null>(null);
  const [tableOpen,setTableOpen]=useState(false);
  const plot=useRef<HTMLDivElement>(null),[width,setWidth]=useState(480);
  useEffect(()=>{
    const element=plot.current;
    if(!element)return;
    const observer=new ResizeObserver(([entry])=>{if(entry.contentRect.width>0)setWidth(entry.contentRect.width);});
    observer.observe(element);
    return ()=>observer.disconnect();
  },[]);
  const keys=Object.keys(series),visible=keys.filter(k=>!hidden.includes(k)),n=days.length;
  if(!n)return <p className="hint">Нет дней для отображения</p>;
  const values=Object.values(series).flat().flatMap(p=>p.value===null?[]:[p.value]);
  const {lo,hi,ticks}=valueScale(values,unit);
  const top=9,base=163,height=172;
  const y=(v:number)=>base-(v-lo)/(hi-lo)*(base-top);
  const edge=(offset:number)=>offset*width/n,center=(index:number)=>edge(index+.5);
  const launchX=edge(-days[0]),releaseVisible=launchX>=0&&launchX<=width;
  const maxLabels=Math.max(2,Math.floor(width/77)+1),stride=Math.max(1,Math.ceil(n/(maxLabels-1)));
  const dateEdges=Array.from({length:Math.ceil(n/stride)},(_,i)=>i*stride).filter(i=>i===0||width-edge(i)>56);
  dateEdges.push(n);
  const picked=index!==null&&index>=0&&index<n?index:null;
  const lastValue=series.all.reduce((last,p,i)=>p.value===null?last:i,-1);
  const noDataWidth=edge(n-lastValue-1);
  function selectAt(e:React.PointerEvent<HTMLDivElement>){
    const rect=e.currentTarget.getBoundingClientRect();
    choose(Math.max(0,Math.min(n-1,Math.floor((e.clientX-rect.left)/rect.width*n))));
  }
  function sample(p:Point){
    if(metric===undefined||p.d===undefined)return eventSample(p.n,sampleEvent);
    return metricSample({...p,d:p.d},metric)??'—';
  }
  return <div className="trend">
    <small className="daily-label">По дням · {unit}</small>
    <div className="graph"><div className="yaxis" aria-hidden="true">{ticks.map(v=><span key={v} style={{top:y(v)/height*100+'%'}}>{axisValue(v,unit)}</span>)}</div>
    <div className="plot" ref={plot} tabIndex={0} role="group" aria-label={title+' по дням. Стрелки выбирают день.'}
      onFocus={()=>{if(picked===null)choose(0);onInspect?.();}} onBlur={()=>choose(null)}
      onPointerMove={selectAt} onPointerUp={selectAt} onPointerLeave={e=>{if(e.pointerType==='mouse')choose(null);}} onKeyDown={e=>{
        if(e.key==='Escape')choose(null);
        if(['ArrowRight','ArrowLeft','Home','End'].includes(e.key)){
          e.preventDefault();
          choose(e.key==='Home'?0:e.key==='End'?n-1:Math.max(0,Math.min(n-1,(picked??0)+(e.key==='ArrowRight'?1:-1))));
        }
      }}>
      <svg viewBox={'0 0 '+width+' '+height} preserveAspectRatio="none" role="img" aria-label={title}>
        {rate&&series.all.map((p,i)=>p.pending?<rect key={i} x={edge(i)} width={edge(1)} y={top} height={base-top} fill="#f0f0f2"/>:null)}
        {marks.map(m=><a className="interval-mark" aria-label={m.reason} href={calcHref(m.calc)} key={m.calc}><title>{m.reason}</title><rect x={edge(m.start-days[0])} width={edge(m.end-m.start)} y={top} height={base-top}/></a>)}
        <g pointerEvents="none">
        {ticks.map(v=><line key={v} x1="0" x2={width} y1={y(v)} y2={y(v)} className={v===lo?'axis-base':'grid-line'}/>)}
        {releaseVisible&&<><line x1={launchX} x2={launchX} y1={top} y2={height} className="launch-rule"/><circle cx={launchX} cy={base} r="3" fill="#a20c32"/></>}
        {visible.map(k=>{
          const {path,isolated}=seriesPath(series[k],center,y);
          return <g key={k}><path d={path} fill="none" stroke={lines[k].color} strokeWidth={k==='all'?3.2:2} strokeDasharray={k==='old'?'6 5':undefined} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke"/>
            {isolated.map(p=><circle key={p.x} cx={p.x} cy={p.y} r="2.8" fill={lines[k].color}/>)}</g>;
        })}
        {picked!==null&&<><line x1={center(picked)} x2={center(picked)} y1={top} y2={base} className="hover-rule"/>
          {visible.map(k=>{const v=series[k][picked].value;return v===null?null:<circle key={k} cx={center(picked)} cy={y(v)} r="3.5" fill={lines[k].color} stroke="white" strokeWidth="1.3"/>;})}</>}
        </g>
      </svg>
      {picked===null&&noDataWidth>=100&&n-lastValue>3&&<span className="empty-span" style={{left:edge(lastValue+1)/width*100+'%'}}>{series.all.slice(lastValue+1).some(p=>p.pending)?'Окно оплаты открыто':'Нет наблюдений'}</span>}
      {picked!==null&&<div role="tooltip" className={'tip '+(picked<n/2?'tip-right':'tip-left')}><strong>{dayDate(launch,days[picked])} – {dayDate(launch,days[picked]+1)} · {time.format(launch)} МСК</strong>
        <table><thead><tr><th>Версия</th><th>Значение</th><th>Выборка</th></tr></thead><tbody>{keys.map(k=>{const p=series[k][picked];return <tr key={k}><td>{lines[k].title}</td><td>{fmt(p.value,unit)}</td><td>{sample(p)}</td></tr>;})}</tbody></table>
        {!!series.all[picked].pending&&<small>Окно оплаты открыто для {series.all[picked].pending} наблюдений</small>}
        {!!series.all[picked].both&&<small>Видели обе версии · {series.all[picked].both}</small>}
        {!!unknown?.[picked]&&((unknown[picked].d||0)+(unknown[picked].pending||0)>0)&&<small>Без версии · {(unknown[picked].d||0)+(unknown[picked].pending||0)}</small>}
      </div>}
      <div className="xaxis">{dateEdges.map(i=><span key={i} style={{left:100*i/n+'%'}}>{dayDate(launch,days[0]+i)}</span>)}
      {releaseVisible&&<b className={launchX>width-18?'at-end':''} style={{left:launchX/width*100+'%'}}>Релиз</b>}</div>
    </div></div>
    {keys.length>1&&<div className="legend" aria-label="Версии интерфейса">{keys.map(k=><button key={k} aria-pressed={visible.includes(k)} disabled={visible.length===1&&visible[0]===k} onClick={()=>{
      setHidden(hidden.includes(k)?hidden.filter(v=>v!==k):[...hidden,k]);
    }}><i style={{borderColor:lines[k].color,borderTopStyle:k==='old'?'dashed':'solid'}}/>{lines[k].title}</button>)}</div>}
    <details className="daily-table" onToggle={e=>setTableOpen(e.currentTarget.open)}><summary>Данные по дням</summary>
      {tableOpen&&<div className="table-scroll"><table className="numbers"><caption>{title} · {time.format(launch)} МСК, начало суток</caption>
        <thead><tr><th scope="col">Дата</th>{keys.map(k=><th scope="col" key={k}>{keys.length===1?'Значение':lines[k].title}</th>)}</tr></thead>
        <tbody>{days.map((d,i)=><tr key={d}><th scope="row">{dayDate(launch,d)}</th>{keys.map(k=>{const p=series[k][i];return <td key={k}>{fmt(p.value,unit)}<small className="table-basis">{sample(p)}</small>{!!p.pending&&<small className="table-basis">Ожидают · {fmt(p.pending)}</small>}</td>;})}</tr>)}</tbody>
      </table></div>}</details>
  </div>;
}
