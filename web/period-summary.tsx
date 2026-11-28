import {dayDate} from './types';
import {changeText,metricValue} from './metric-values';

type Period={value:number|null;sample:string|null;pending?:number};
type Props={before:Period;after:Period;unit:string;launch:number;day:number;status?:'ready'|'preliminary'|'missing';asTable?:boolean};

export function PeriodSummary({before,after,unit,launch,day,status,asTable}:Props){
  const partial=day<7||status==='preliminary';
  const change=changeText(before.value,after.value,unit);
  const end=Math.max(0,Math.min(day,7));
  function period(label:string,from:number,to:number,p:Period){
    const started=to>from;
    const sample=status==='missing'?'Нет нужных данных':!started?'':p.sample??(p.pending?'':'Нет наблюдений');
    return <span className="period-cell">
      {label&&<span className="period-label">{label}</span>}
      <span className="period-dates">{started?dayDate(launch,from)+' – '+dayDate(launch,to):'На момент запуска'}</span>
      <strong className="period-value">{started?metricValue(p.value,unit):'—'}</strong>
      {sample&&<span className="period-basis">{sample}</span>}
      {started&&status!=='missing'&&!!p.pending&&<span className="period-basis">Ожидают окончания окна · {p.pending}</span>}
    </span>;
  }
  if(asTable) return <table className="release-table metric-period-table" aria-label="Сравнение периодов выпуска">
    <thead><tr><th scope="col">До выпуска</th><th scope="col">После выпуска</th><th scope="col">Изменение</th></tr></thead>
    <tbody><tr>
      <td>{period('',-7,0,before)}</td>
      <td>{period('',0,end,after)}</td>
      <td>{status==='missing'?'—':partial?<span>Предварительно{day<7&&<small className="table-basis">{end} из 7 суток</small>}</span>:change??'—'}</td>
    </tr></tbody>
  </table>;
  return <span className="period-summary">
    <span className="period-pair">{period('До запуска',-7,0,before)}{period('После запуска',0,end,after)}</span>
    {status==='missing'?null:partial?<span className="period-change">Предварительный срез{day<7?' · после запуска '+end+' из 7 суток':''}</span>:
      change&&<span className="period-change">Изменение <b>{change}</b></span>}
  </span>;
}
