import {dayDate} from './types';
import {changeText,metricValue} from './metric-values';

type Period={value:number|null;sample:string|null;pending?:number};
type Props={before:Period;after:Period;unit:string;launch:number;day:number;status?:'ready'|'preliminary'|'missing'};

export function PeriodSummary({before,after,unit,launch,day,status}:Props){
  const partial=day<7||status==='preliminary';
  const change=changeText(before.value,after.value,unit);
  const end=Math.max(0,Math.min(day,7));
  function period(label:string,from:number,to:number,p:Period){
    const started=to>from;
    const sample=status==='missing'?'Нет нужных данных':!started?'':p.sample??(p.pending?'':'Нет наблюдений');
    return <span className="period-cell">
      <span className="period-label">{label}</span>
      <span className="period-dates">{started?dayDate(launch,from)+' – '+dayDate(launch,to):'На момент запуска'}</span>
      <strong className="period-value">{started?metricValue(p.value,unit):'—'}</strong>
      {sample&&<span className="period-basis">{sample}</span>}
      {started&&status!=='missing'&&!!p.pending&&<span className="period-basis">Ожидают окончания окна · {p.pending}</span>}
    </span>;
  }
  return <span className="period-summary">
    <span className="period-pair">{period('До запуска',-7,0,before)}{period('После запуска',0,end,after)}</span>
    {status==='missing'?null:partial?<span className="period-change">Предварительный срез{day<7?' · после запуска '+end+' из 7 суток':''}</span>:
      change&&<span className="period-change">Изменение <b>{change}</b></span>}
  </span>;
}
