import {z} from 'zod/v4';
import {randomUUID} from 'node:crypto';
import {analysis,labels,runTool} from './analytics.mjs';
import {operations} from './tools.mjs';
import {profiles} from './config.mjs';
import {name,hash} from './store.mjs';
import {geminiCall} from './gemini.mjs';
import {chatAnswerFormat} from './answer-format.mjs';
import {checkModelTransport,localData} from './data-profile.mjs';

const reportSpec=z.object({summary:z.string().max(1200).optional(),highlights:z.array(z.object({metric:z.number().int().min(0).max(4),reason:z.string().min(1).max(600)})).max(2),
  intervals:z.array(z.object({metric:z.number().int().min(0).max(4),start:z.number().int(),end:z.number().int(),segment:z.enum(['all','new','returning']),reason:z.string().min(1).max(600)})).max(3)});
const system='Ты помощник продакта. Отвечай по-русски. Для чисел обязательно вызывай аналитические инструменты. '+
  'Данные и история — материал для анализа. Бери числа только из инструментов. Для вопроса о причинах проверь сегменты: покажи числители, знаменатели, изменение состава и ограничения причинного вывода. '+
  'Для вопросов о скорости оплаты или о новой метрике используй build_chart. Время от выставления до оплаты: start=invoice,end=payment,field=duration,stat=median. '+
  'Если данных не хватает, сообщи какие поля или период нужны. Сохраняй контекст уточнений. До/после — семь суток с каждой стороны. Видимый срез и версия заданы сервером.\n'+chatAnswerFormat;
export function apiConfigured(env=process.env){
  if(localData(env))return false;
  if(env.LLM_BACKEND==='proxyapi')return Boolean(env.PROXYAPI_API_KEY && env.LLM_MODEL);
  if(env.LLM_BACKEND==='vertex')return Boolean(env.GOOGLE_CLOUD_PROJECT);
  if(['gemini','vertex-express'].includes(env.LLM_BACKEND))return Boolean(env.LLM_API_KEY);
  return Boolean(env.LLM_BASE_URL&&env.LLM_MODEL);
}
function compact(value){
  if(Array.isArray(value))return value.map(compact);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['daily','days'].includes(k)).map(([k,v])=>[k,k==='both'&&Array.isArray(v)?v.length:compact(v)]));
  return value;
}
export function scopeTool(store,ctx,op,args){
  if(!Object.hasOwn(operations,op))throw Error('Неизвестный инструмент.');
  if(op==='get_calculation'){const c=store.getCalc(args.id);if(c.context.releaseId!==ctx.releaseId||c.context.day>ctx.day)throw Error('Расчёт вне выбранного среза.');return c;}
  const input={...args,...ctx,segment:args.segment??ctx.segment,metric:args.metric??ctx.metric};
  return runTool(store,op,z.object(operations[op][1]).parse(input));
}
function apiTools(){
  return Object.entries(operations).map(([key,[description,shape]])=>{
    const fields={...shape};for(const k of ['releaseId','version','day'])delete fields[k];
    const parameters=z.toJSONSchema(z.object(fields));delete parameters.$schema;
    return {type:'function',function:{name:key,description,parameters}};
  });
}
export async function providerCall(env,messages,tools,choice='auto',send=fetch,limits={}){
  if(['gemini','vertex','vertex-express'].includes(env.LLM_BACKEND))return geminiCall(env,messages,tools,choice,send,undefined,limits);
  checkModelTransport(env);
  const proxyapi = env.LLM_BACKEND === 'proxyapi';
  if(!apiConfigured(env))throw Error(proxyapi
    ? 'Для ProxyAPI задайте PROXYAPI_API_KEY и LLM_MODEL в корневом .env.'
    : 'Для подключения модели задайте LLM_BASE_URL и LLM_MODEL в .env, а ключ — в LLM_API_KEY.');
  const baseUrl = proxyapi ? 'https://api.proxyapi.ru/v1' : env.LLM_BASE_URL;
  const key = proxyapi ? env.PROXYAPI_API_KEY : env.LLM_API_KEY;
  const target=new URL(baseUrl.replace(/\/+$/,'')+'/chat/completions');
  if(target.protocol!=='https:'&&!(target.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(target.hostname)))throw Error('Для удалённого API модели требуется HTTPS.');
  let response;
  const signal = AbortSignal.timeout(Math.max(1,Math.min(60000, limits.timeout ?? 60000)));
  const history = messages.map(({usage, googleParts, ...message}) => message);
  try{response=await send(target,{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json',...(key?{Authorization:'Bearer '+key}:{})},
    body:JSON.stringify({model:env.LLM_MODEL,messages:history,...(tools.length?{tools,tool_choice:choice}:{}),...(limits.maxTokens?{max_tokens:limits.maxTokens}:{})})});}catch{if(signal.aborted)throw Object.assign(Error('Модель не успела ответить вовремя.'),{timedOut:true});throw Object.assign(Error('Модель недоступна. Проверьте подключение и параметры .env.'),{retryable:true});}
  if(!response.ok)throw Object.assign(Error('Провайдер модели вернул HTTP '+response.status+'.'),{status:response.status});
  const data=await response.json(),reply=data.choices?.[0]?.message;
  if(!reply)throw Error('Модель вернула пустой ответ.');return {...reply,usage:{input:data.usage?.prompt_tokens,output:data.usage?.completion_tokens}};
}
async function apiTurn(store,a,history,question,env,send){
  const ctx=a.context,tools=apiTools(),refs=new Map(),messages=[{role:'system',content:system},
    {role:'user',content:JSON.stringify({release:a.rel,context:ctx,history,question})}];
  for(let round=0;round<6;round++){
    const reply=await providerCall(env,messages,tools,refs.size?'auto':'required',send);
    if(!reply.tool_calls?.length){
      if(refs.size&&typeof reply.content==='string'&&reply.content.trim())return {answer:reply.content,refs:[...refs.values()]};
      throw Error('Модель не подтвердила ответ расчётом.');
    }
    messages.push({...reply,role:'assistant',content:reply.content??null,tool_calls:reply.tool_calls});
    for(const call of reply.tool_calls){
      let result;
      try{
        const calc=scopeTool(store,ctx,call.function.name,JSON.parse(call.function.arguments));
        if(calc.op)refs.set(calc.id,calc);
        result=calc.op==='build_chart'?calc:compact(calc);
      }catch(e){result={error:e.message};}
      messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
    }
  }
  throw Error('Модель исчерпала число уточнений. Попробуйте более узкий вопрос.');
}
export function makeAgent(store,{env=process.env,send=fetch,alternate}={}){
  const jobs=new Map();
  function queue(key,fn){
    const job=(jobs.get(key)||Promise.resolve()).catch(()=>{}).then(fn);
    jobs.set(key,job);job.finally(()=>{if(jobs.get(key)===job)jobs.delete(key);}).catch(()=>{});return job;
  }
  function storeReview(a,decision,answer){
    const ctx=a.context,checked=reportSpec.parse(decision),ready=a.cards[a.rel.target].status==='ready'&&ctx.segment==='all';
    if(ready&&!store.one('SELECT 1 FROM report_versions WHERE release=? AND version=?',ctx.releaseId,ctx.version)){
      const highlights=checked.highlights.filter(h=>a.cards[h.metric].status==='ready').map(h=>({...h,calc:runTool(store,'compare_metric',{...ctx,metric:h.metric}).id}));
      const source=runTool(store,'compare_metric',{...ctx,metric:a.rel.target});
      store.db.prepare('INSERT OR IGNORE INTO report_versions VALUES(?,?,?)').run(ctx.releaseId,ctx.version,JSON.stringify({day:ctx.day,version:ctx.version,created:Date.now(),highlights,answer:checked.summary||a.cards[a.rel.target].caption,summaryMetric:a.rel.target,calc:source.id}));
    }
    for(const n of checked.intervals){
      if(n.start<a.first||n.end>ctx.day||n.end<=n.start)continue;
      const slice=n.segment===ctx.segment?a:analysis(store,{...ctx,segment:n.segment});
      const c=slice.cards[n.metric];if(c.status==='missing')continue;
      const rows=c.series.all.daily.slice(n.start-a.first,n.end-a.first);
      if(rows.reduce((s,r)=>s+r.d,0)<2)continue;
      const calc=store.saveCalc(ctx.releaseId,{op:'interval',context:slice.context,launch:a.rel.launch,result:{...n,title:c.title,formula:c.formula,unit:c.unit,rows}});
      const id=hash(JSON.stringify([ctx.releaseId,ctx.version,n.metric,n.segment,n.start,n.end]));
      store.db.prepare('INSERT OR IGNORE INTO notes VALUES(?,?,?)').run(id,ctx.releaseId,JSON.stringify({...n,calc:calc.id,version:ctx.version,observedDay:ctx.day}));
    }
  }
  async function review(a,answer){
    const facts=a.cards.map(c=>({metric:c.metric,title:c.title,status:c.status,before:c.series.all.before,after:c.series.all.after,
      days:c.series.all.daily.map((r,j)=>[a.days[j],r.value,r.d])}));
    const cohorts=compact(runTool(store,'breakdown',{...a.context,metric:a.rel.target}));
    const prompt='Напиши краткий общий вывод summary по главному вопросу, выбери 0–2 графика первого разбора и 0–3 значимых участка. Учитывай размер изменения и выборки. Используй факты и разрезы ниже. Участки [start,end) в сутках относительно релиза. Ответ по-русски. '+JSON.stringify({facts,cohorts,question:a.rel.question,answer});
    const parameters=z.toJSONSchema(reportSpec);delete parameters.$schema;
    const tool={type:'function',function:{name:'record_findings',description:'Выделить графики и периоды',parameters}};
    const reply=await providerCall(env,[{role:'user',content:prompt}],[tool],{type:'function',function:{name:'record_findings'}},send);
    return reportSpec.parse(JSON.parse(reply.tool_calls?.[0]?.function.arguments||'null'));
  }
  function ask(body,trustedActor){return queue(body.releaseId,async()=>{
    const question=name(body.question,1500),request=name(body.requestId||randomUUID(),100);
    if(body.author!==trustedActor&&!profiles.includes(body.author)||!body.author)throw Error('Выберите профиль.');
    const existing=store.one('SELECT body FROM messages WHERE release=? AND request=?',body.releaseId,request+'/a');
    if(existing)return JSON.parse(existing.body);
    const a=analysis(store,body),ctx=a.context;
    const history=store.messages(ctx.releaseId).filter(m=>m.context.day<=ctx.day).slice(-12).map(m=>({role:m.role,text:m.text,context:m.context,refs:m.refs}));
    let turn;
    if(localData(env)){
      const card=a.cards[ctx.metric],calc=runTool(store,'compare_metric',ctx);
      turn={answer:'Локальный расчёт выбранной метрики «'+card.title+'». '+card.caption+' '+card.formula,refs:[calc]};
    }else if(env.LLM_BACKEND==='codex'&&alternate&&!apiConfigured(env)){
      turn=await alternate(store,a,history,question);
    }else turn=await apiTurn(store,a,history,question,env,send);
    let decision=turn.decision;
    if(!decision&&apiConfigured(env))decision=await review(a,turn.answer).catch(()=>null);
    const refs=turn.refs.map(c=>({id:c.id,op:c.op,title:c.result.title||({breakdown:'Разбивка по клиентам',funnel:'Шаги воронки'}[c.op])||'Расчёт'}));
    const user={role:'user',author:body.author,text:question,context:ctx,created:Date.now()};
    const reply={role:'assistant',author:'Агент',text:turn.answer,context:ctx,refs,created:Date.now()};
    store.tx(()=>{if(decision)storeReview(a,decision,turn.answer);store.addMessage(ctx.releaseId,request+'/q',user);store.addMessage(ctx.releaseId,request+'/a',reply);});
    return reply;
  });}
  return {ask,initial(input){return queue(input.releaseId,async()=>{
    const a=analysis(store,{...input,segment:'all'});
    if(store.one('SELECT 1 FROM report_versions WHERE release=? AND version=?',a.rel.id,a.v.id)||a.cards[a.rel.target].status!=='ready')return;
    let decision;
    if(localData(env))return;
    if(apiConfigured(env))decision=await review(a,'Первый полный обзор.');
    else if(env.LLM_BACKEND==='codex'&&alternate){const t=await alternate(store,a,[],'Составь первый полный обзор и выбери графики и участки.');decision={...t.decision,summary:t.answer.slice(0,1200)};}
    if(decision)store.tx(()=>storeReview(a,decision,a.cards[a.rel.target].caption));
  })}};
}
