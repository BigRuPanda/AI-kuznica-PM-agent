export type Segment='all'|'new'|'returning';
export type Context={releaseId:string;version:string;day:number;segment:Segment;metric:number};
export type Release={id:string;title:string;description:string;launch:number;audience:string;question:string;dataset:string;target:number;sourceKey:string;exposure:string};
export type Row={n:number;d:number;pending:number;value:number|null;both:number};
export type Series={before:Row;after:Row;daily:Row[]};
export type Card={metric:number;title:string;formula:string;unit:string;status:'ready'|'missing'|'preliminary';reason:string;caption:string;series:Record<string,Series>;unknown:Series;both:{id:string;first:string;seen:number;other:number}[]};
export type Note={start:number;end:number;metric:number;segment:Segment;reason:string;calc:string};
export type Report={completed?:number|null;release:Release;context:Context;last:number;days:number[];cards:Card[];overview:string;report:null|{day:number;answer:string;summaryMetric?:number;version:string;calc:string;highlights:{metric:number;reason:string;calc:string}[]};notes:Note[]};
export type Ref={id:string;title:string;op:string};
export type Message={role:string;author:string;own:boolean;text:string;created:number;context:Context;refs?:Ref[]};
export type Board={name:string;calc:string};
export type Journal={releases:Release[];datasets:{id:string;name:string}[];profiles:string[];mode:string};
export type Derived={title:string;formula:string;unit:string;spec?:{end:string};status?:'ready'|'preliminary';before:{value:number|null;n:number};after:{value:number|null;n:number};days:number[];daily:{value:number|null;n:number}[]};
export const segmentNames:Record<Segment,string>={all:'Все клиенты',new:'Новые клиенты',returning:'Постоянные клиенты'};
export const metricNames=['Конверсия из оформления в оплату','Доля оплаченных счетов','Сумма оплат','Средний чек','Своевременные продления'];
const numberFormat=new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2});
const dateFormat=new Intl.DateTimeFormat('ru-RU',{day:'numeric',month:'short',timeZone:'Europe/Moscow'});
export const fmt=(v:number|null,unit='')=>v===null?'—':numberFormat.format(v)+(unit==='%'?'%':unit?'\u00a0'+unit:'');
export const date=(t:number)=>dateFormat.format(t).replace(/\.$/u,'');
export const dayDate=(launch:number,day:number)=>date(launch+86400000*day);
export const contextQuery=(c:object)=>new URLSearchParams(Object.entries(c).filter(([,v])=>v!==undefined).map(([k,v])=>[k,String(v)])).toString();
export async function api<T>(path:string,body?:unknown):Promise<T>{
  const res=await fetch('/api/'+path,body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
  const value=await res.json();if(!res.ok)throw Error(value.error||'Ошибка запроса');return value;
}
export const calcHref=(id:string)=>'#calc/'+encodeURIComponent(id);
