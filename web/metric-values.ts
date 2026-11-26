import {fmt} from './types';
import type {Row} from './types';

const plurals=new Intl.PluralRules('ru-RU');
type Forms=readonly [string,string,string,string?];
function counted(n:number,forms:Forms){
  const form=plurals.select(Math.abs(n));
  const word=form==='one'?forms[0]:form==='few'?forms[1]:form==='other'&&forms[3]?forms[3]:forms[2];
  return fmt(n)+' '+word;
}
const days:Forms=['день','дня','дней','дня'];
const payments:Forms=['оплата','оплаты','оплат'];
const observations:Forms=['наблюдение','наблюдения','наблюдений'];
const eventNouns:Record<string,Forms>={
  payment:payments,invoice:['счёт','счёта','счетов'],checkout:['оформление','оформления','оформлений'],
  due:['срок продления','срока продления','сроков продления'],renewal:['продление','продления','продлений']
};

export function metricValue(value:number|null,unit:string){
  return value!==null&&unit==='сут.'?counted(value,days):fmt(value,unit);
}
export function changeText(before:number|null,after:number|null,unit:string){
  if(before===null||after===null)return null;
  const delta=after-before;
  if(delta===0)return 'Без изменений';
  const signed=(n:number,u:string)=>(n<0?'−':'+')+metricValue(Math.abs(n),u);
  const absolute=signed(delta,unit==='%'?'п. п.':unit);
  return unit==='%'||before<=0?absolute:absolute+' ('+signed(100*delta/before,'%')+')';
}
export function eventSample(n:number,end?:string){
  return counted(n,eventNouns[end??'']??observations);
}
export function metricSample(row:Pick<Row,'n'|'d'|'value'>,metric:number){
  if(row.value===null)return null;
  if(metric===2)return counted(row.d,payments);
  if(metric===3)return fmt(row.n,'₽')+' / '+counted(row.d,payments);
  const one=plurals.select(row.d)==='one';
  const noun=metric===0?(one?'компании':'компаний'):metric===1?(one?'счёта':'счетов'):(one?'подписки':'подписок');
  return fmt(row.n)+' из '+fmt(row.d)+' '+noun;
}
