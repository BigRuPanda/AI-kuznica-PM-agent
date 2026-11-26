import {parse} from 'csv-parse/sync';
export const DAY=86400000;
export const kinds=['checkout_started','invoice_issued','invoice_page_viewed','payment_received','subscription_due','subscription_renewed'];
export function instant(text){
  if(typeof text!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d(:\d\d(\.\d{1,9})?)?(Z|[+-]\d\d:\d\d)$/.test(text)||!Number.isFinite(Date.parse(text)))throw Error('Нужна дата ISO с часовым поясом.');
  return Date.parse(text);
}
export function parseEvents(csv){
  if(typeof csv!=='string'||!csv.length||Buffer.byteLength(csv)>12_000_000)throw Error('Выберите CSV размером до 12 МБ.');
  let records;
  try{records=parse(csv,{bom:true,trim:true,skip_empty_lines:true,info:true});}
  catch(e){throw Error('Строка '+(e.lines||1)+', поле '+(e.column||'CSV')+': проверьте кавычки и количество столбцов.');}
  const columns=records.shift()?.record||[];
  if(!columns.length||columns.includes('')||new Set(columns).size!==columns.length)throw Error('Строка 1, поле заголовка: пустые или повторные названия.');
  for(const col of ['event_type','event_at'])if(!columns.includes(col))throw Error('Строка 1, поле '+col+': отсутствует обязательный столбец.');
  if(!columns.includes('order_id')&&!columns.includes('invoice_id'))throw Error('Строка 1, поле order_id или invoice_id: нужен идентификатор.');
  const events=[],seen=new Set();
  for(const {record,info} of records){
    const e=Object.fromEntries(columns.map((c,i)=>[c,record[i]]));
    const fail=(field,msg)=>{throw Error('Строка '+info.lines+', поле '+field+': '+msg);};
    if(!kinds.includes(e.event_type))fail('event_type','неизвестный тип события');
    try{e.at=instant(e.event_at);}catch{fail('event_at','ожидается дата ISO с часовым поясом');}
    if(!e.order_id&&!e.invoice_id)fail('order_id / invoice_id','нет идентификатора');
    if(e.customer_segment&&!['new','returning'].includes(e.customer_segment))fail('customer_segment','ожидается new или returning');
    if(e.ui_version&&!['old','new'].includes(e.ui_version))fail('ui_version','ожидается old или new');
    if(e.event_type==='payment_received'&&columns.includes('amount_rub')){
      if(!e.amount_rub||!Number.isFinite(Number(e.amount_rub))||Number(e.amount_rub)<0)fail('amount_rub','ожидается неотрицательное число');
      e.amount_rub=Number(e.amount_rub);
    }
    const fingerprint=JSON.stringify(record);
    if(!seen.has(fingerprint)){seen.add(fingerprint);events.push(e);}
  }
  return {columns,events};
}

// Join invoice events to orders, retaining the first timestamp per interface version.
export function pack(events,release,cutoff){
  const visible=events.filter(e=>e.at<=cutoff&&(!release.sourceKey||e.release_id===release.sourceKey));
  const sole=new Map(),records=new Map();
  for(const e of visible){
    if(!e.order_id||!e.invoice_id)continue;
    if(!sole.has(e.order_id))sole.set(e.order_id,e.invoice_id);
    else if(sole.get(e.order_id)!==e.invoice_id)sole.set(e.order_id,null);
  }
  for(const e of visible){
    const invoice=e.invoice_id||sole.get(e.order_id),key=invoice?'i/'+invoice:'o/'+e.order_id;
    if(!records.has(key))records.set(key,{r:['unknown',null,null,null,0,null,null,null,null,null,invoice||null,null],views:new Map()});
    const {r,views}=records.get(key),t=e.at-release.launch;
    if(e.customer_segment)r[0]=e.customer_segment;if(e.company_id)r[11]=e.company_id;
    if(e.event_type===release.exposure&&e.ui_version)views.set(e.ui_version,Math.min(t,views.get(e.ui_version)??Infinity));
    const index={checkout_started:1,invoice_issued:2,payment_received:3,subscription_due:5,subscription_renewed:6}[e.event_type];
    if(index!==undefined && (r[index]===null||t<r[index])){
      r[index]=t;if(index===3)r[4]=e.amount_rub??0;
    }
  }
  return [...records.values()].map(({r,views})=>{
    const [first,second]=[...views].sort((a,b)=>a[1]-b[1]);
    if(first)[r[7],r[8]]=first;if(second)r[9]=second[1];return r;
  });
}
