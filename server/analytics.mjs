import '../prototype/metrics.js';
import {DAY,pack} from './import.mjs';
import {name} from './store.mjs';
const defs=globalThis.releaseMetrics.metrics;
export const labels=defs.map(d=>d[0]);
const requirements=[
  ['company_id','checkout_started','payment_received'],['invoice_id','invoice_issued','payment_received'],
  ['amount_rub','payment_received'],['amount_rub','payment_received'],['subscription_due','subscription_renewed']
];
const periods={from:-7,launch:0,to:7,paymentWindow:7};
const clean=row=>({n:row.n,d:row.d,pending:row.pending,value:row.value,both:row.bothViews.length});
function summarize(series,i){return {before:clean(series.before[i]),after:clean(series.after[i])};}
function required(v,fields){return fields.filter(f=>!(v.columns.includes(f)||v.recorded.includes(f)));}
function format(v,i){return v===null?'—':new Intl.NumberFormat('ru-RU',{maximumFractionDigits:2}).format(v)+' '+defs[i][1];}
export function analysis(store,input){
  const rel=store.release(input.releaseId),v=store.version(rel.dataset,input.version),scope=v.events.filter(e=>!rel.sourceKey||e.release_id===rel.sourceKey);
  const lastTime=scope.reduce((m,e)=>Math.max(m,e.at),rel.launch);
  const dayNow=Math.floor((Date.now()-rel.launch)/DAY), first=scope.reduce((m,e)=>Math.min(m,Math.floor((e.at-rel.launch)/DAY)),-7);
  const naturalEnd=Math.max(14,Math.ceil((lastTime-rel.launch)/DAY),Math.ceil(((v.completed||rel.launch)-rel.launch)/DAY));
  const last=Math.max(0,Math.min(Math.max(0,dayNow),naturalEnd));
  const day=input.day??last,segment=input.segment??'all',metric=input.metric??rel.target;
  if(!['all','new','returning'].includes(segment)||!Number.isInteger(day)||day<0||day>last||!Number.isInteger(metric)||metric<0||metric>4)throw Error('Недопустимый срез релиза.');
  const context={releaseId:rel.id,version:v.id,day,segment,metric};
  const cutoff=rel.launch+day*DAY,orders=pack(scope,rel,cutoff);
  const report=globalThis.releaseMetrics.snapshot({orders},segment,day,first);
  const cards=defs.map(([title,unit,formula],i)=>{
    const missing=required(v,requirements[i]);if(segment!=='all'&&!v.columns.includes('customer_segment'))missing.push('customer_segment');
    const until=rel.launch+(i<2?14:7)*DAY;
    const ready=!missing.length&&cutoff>=until&&v.completed!==null&&v.completed>=until;
    const status=missing.length?'missing':ready?'ready':'preliminary';
    const reason=missing.length?'Для расчёта нужны '+missing.join(', '):cutoff<until?'Полное окно заканчивается '+new Date(until).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})+' МСК.':
      !ready?'Источник пока не подтвердил полноту нужного периода.':'';
    function values(s){
      const result=summarize(s,i);
      result.daily=s.daily.map(rows=>clean(rows[i]));
      if(missing.length)for(const row of [result.before,result.after,...result.daily])row.value=null;
      return result;
    }
    const series={all:values(report)};
    if(report.hasVersion){series.old=values(report.byVersion.old);series.new=values(report.byVersion.new);}
    const all=series.all;
    const caption=reason|| (all.after.value===null?'Нет наблюдений после запуска.':
      all.before.value===null?'До запуска нет наблюдений с нужными полями.':
      'До запуска '+format(all.before.value,i)+', после — '+format(all.after.value,i)+'.');
    const both=report.after[i].bothViews.map(o=>({id:o[10],first:o[7],seen:rel.launch+o[8],other:rel.launch+o[9]}));
    return {metric:i,title,unit,formula,status,reason,caption,series,both,
      unknown:values(report.byVersion.unknown)};
  });
  return {rel,v,context,orders,scope,cutoff,cards,days:report.days,last,first};
}

function summary(a,i){
  const c=a.cards[i];
  return {metric:i,title:c.title,unit:c.unit,formula:c.formula,status:c.status,reason:c.reason,
    series:Object.fromEntries(Object.entries(c.series).map(([k,v])=>[k,{before:v.before,after:v.after}])),
    unknown:{before:c.unknown.before,after:c.unknown.after},both:c.both};
}
export const eventFields={checkout:[1,'начала оформления','checkout_started'],invoice:[2,'выставления счёта','invoice_issued'],
  payment:[3,'оплаты','payment_received'],due:[5,'срока продления','subscription_due'],renewal:[6,'продления','subscription_renewed']};
const statistics={median:'Медиана',mean:'Среднее',p90:'90-й процентиль',sum:'Сумма',count:'Количество'};
export function derive(a,spec,interval){
  if(!spec||!Object.hasOwn(statistics,spec.stat)||!Object.hasOwn(eventFields,spec.end))throw Error('Нужны поддерживаемые событие и агрегат.');
  const {field,stat,start,end}=spec;
  if(field==='duration'){
    if(!Object.hasOwn(eventFields,start)||start===end||!['median','mean','p90'].includes(stat))throw Error('Для длительности укажите два разных события и median, mean или p90.');
  }else if(field==='amount'){
    if(end!=='payment'||stat==='count')throw Error('Сумма в рублях доступна для оплат.');
  }else if(field!=='events'||stat!=='count')throw Error('Неизвестная формула.');
  const title=name(spec.title||statistics[stat],100),unit=field==='duration'?'сут.':field==='amount'?'₽':'шт.';
  const needed=[eventFields[end][2],...(field==='duration'?[eventFields[start][2]]:field==='amount'?['amount_rub']:[])];
  const absent=required(a.v,needed);if(absent.length)throw Error('Для графика отсутствуют '+absent.join(', '));
  if(a.context.segment!=='all'&&!a.v.columns.includes('customer_segment'))throw Error('Нужно поле customer_segment.');
  const points=a.days.map(()=>[]),before=[],after=[],selected=[];
  for(const o of a.orders){
    if(a.context.segment!=='all'&&o[0]!==a.context.segment)continue;
    const t=o[eventFields[end][0]];if(!Number.isFinite(t)||t>=a.context.day*DAY)continue;
    const day=Math.floor(t/DAY);
    let x=1;if(field==='duration'){const begin=o[eventFields[start][0]];if(!Number.isFinite(begin)||begin>t)continue;x=(t-begin)/DAY;}
    else if(field==='amount')x=o[4];
    if(interval&&day>=interval.from&&day<interval.to)selected.push(x);
    points[day-a.first]?.push(x);if(day>=-7&&day<0)before.push(x);if(day>=0&&day<7)after.push(x);
  }
  function statOf(arr){
    const n=arr.length,sum=arr.reduce((v,x)=>v+x,0);
    if(stat==='count'||stat==='sum')return {value:stat==='sum'?sum:n,n};
    if(!n)return {value:null,n};
    if(stat==='mean')return {value:sum/n,n};
    const sorted=arr.sort((x,y)=>x-y),idx=(n-1)*(stat==='p90'?.9:.5),lo=Math.floor(idx);
    return {value:sorted[lo]+(sorted[Math.ceil(idx)]-sorted[lo])*(idx-lo),n};
  }
  if(interval)return statOf(selected);
  return {title,unit,spec:{title,stat,field,start:field==='duration'?start:null,end},days:a.days,daily:points.map(statOf),before:statOf(before),after:a.context.day?statOf(after):{value:null,n:0},
    formula:statistics[stat]+' '+(field==='duration'?'времени от '+eventFields[start][1]+' до '+eventFields[end][1]+' среди записей с обоими событиями':field==='amount'?'сумм оплат':'событий '+eventFields[end][1])+'. Группировка по дате '+eventFields[end][1]+'.'};
}
export function runTool(store,op,input){
  if(op==='get_calculation')return store.getCalc(input.id);
  if(op==='get_release')return store.release(input.releaseId);
  const a=analysis(store,input),ctx=a.context;
  let result;
  if(op==='compare_metric')result=summary(a,ctx.metric);
  else if(op==='breakdown'){
    result=Object.fromEntries(['all','new','returning'].map(segment=>[segment,summary(segment===ctx.segment?a:analysis(store,{...ctx,segment}),ctx.metric)]));
  }else if(op==='funnel'){
    result={definition:'Оформление, затем счёт и оплата по связанному заказу в течение семи суток от оформления; только зрелые оформления.',
      missing:required(a.v,['checkout_started','invoice_issued','payment_received']),steps:[]};
    for(const [key,lo,hi] of [['before',-7,0],['after',0,7]]){
      const orders=a.orders.filter(o=>Number.isFinite(o[1])&&o[1]>=lo*DAY&&o[1]<hi*DAY&&o[1]+7*DAY<=ctx.day*DAY&&(ctx.segment==='all'||o[0]===ctx.segment));
      const issued=orders.filter(o=>Number.isFinite(o[2])&&o[2]>=o[1]&&o[2]<=o[1]+7*DAY);
      result.steps.push({period:key,checkout:orders.length,invoiced:issued.length,paid:issued.filter(o=>Number.isFinite(o[3])&&o[3]>=o[2]&&o[3]<=o[1]+7*DAY).length});
    }
  }else if(op==='build_chart')result=derive(a,input.spec);
  else throw Error('Неизвестная операция.');
  return store.saveCalc(ctx.releaseId,{op,context:ctx,launch:a.rel.launch,periods,result});
}
export function page(store,input){
  const a=analysis(store,input);
  const stored=store.one('SELECT body FROM report_versions WHERE release=? AND version=?',a.rel.id,a.v.id);
  const report=stored?JSON.parse(stored.body):null;
  let overview=a.cards[a.rel.target].caption;
  if(a.rel.target===0&&a.context.segment==='all'&&a.cards[0].status==='ready'&&a.v.columns.includes('customer_segment')){
    const grouped=['new','returning'].map(s=>globalThis.releaseMetrics.calculate(a.orders,s,-7,0,a.context.day)[0]);
    const later=['new','returning'].map(s=>globalThis.releaseMetrics.calculate(a.orders,s,0,7,a.context.day)[0]);
    if(grouped.every((v,i)=>v.d&&later[i].d&&Math.abs(v.value-later[i].value)<0.000001)){
      const pre=a.cards[0].series.all.before,post=a.cards[0].series.all.after;
      if(pre.d===grouped[0].d+grouped[1].d&&post.d===later[0].d+later[1].d&&Math.abs(pre.value-post.value)>0.001)
        overview+=' В каждом сегменте конверсия сохранилась. Доля новых клиентов изменилась с '+format(grouped[0].d/pre.d*100,0)+' до '+format(later[0].d/post.d*100,0)+'.';
    }
  }
  return {release:a.rel,completed:a.v.completed,context:a.context,last:a.last,days:a.days,cards:a.cards,overview,
    report:report&&report.day<=a.context.day?report:null,
    notes:store.db.prepare('SELECT body FROM notes WHERE release=?').all(a.rel.id).map(r=>JSON.parse(r.body)).filter(n=>n.version===a.v.id&&n.observedDay<=a.context.day&&(a.context.segment==='all'||n.segment==='all'||n.segment===a.context.segment))};
}
