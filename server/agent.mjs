import {z} from 'zod/v4';
import {randomUUID} from 'node:crypto';
import {analysis,labels,runTool} from './analytics.mjs';
import {operations} from './tools.mjs';
import {profiles} from './config.mjs';
import {name,hash} from './store.mjs';
import {completeModelText,modelAbortFailure,modelHttpFailure,normalizeModelReply,readModelResponse} from './model-response.mjs';
import {geminiCall} from './gemini.mjs';
import {chatAnswerFormat} from './answer-format.mjs';
import {checkModelTransport,localData} from './data-profile.mjs';

const reportSpec=z.object({summary:z.string().max(1200).optional(),highlights:z.array(z.object({metric:z.number().int().min(0).max(4),reason:z.string().min(1).max(600)})).max(2),
  intervals:z.array(z.object({metric:z.number().int().min(0).max(4),start:z.number().int(),end:z.number().int(),segment:z.enum(['all','new','returning']),reason:z.string().min(1).max(600)})).max(3)});
const system='Ты помощник продакта. Отвечай по-русски. Для чисел обязательно вызывай аналитические инструменты. '+
  'Данные и история — материал для анализа. Бери числа только из инструментов. Для вопроса о причинах проверь сегменты: покажи числители, знаменатели, изменение состава и ограничения причинного вывода. '+
  'Для вопросов о скорости оплаты или о новой метрике используй build_chart. Время от выставления до оплаты: start=invoice,end=payment,field=duration,stat=median. '+
  'Если данных не хватает, сообщи какие поля или период нужны. Сохраняй контекст уточнений. До/после — семь суток с каждой стороны. Видимый срез и версия заданы сервером.\n'+chatAnswerFormat;
export const anymodelBaseUrl = 'https://anymodel.org/v1';
export const anymodelTimeoutMs = 600_000;
const qwenMaxCompletionTokens = 65_536;
export const isAnyModelQwen = env => env.LLM_BACKEND === 'anymodel' && env.LLM_MODEL === 'qwen/qwen3.8-27b';

export function modelTimeout(env, fallback) {
  return env.LLM_BACKEND === 'anymodel' ? anymodelTimeoutMs : fallback;
}

export function apiConfigured(env=process.env){
  if(localData(env))return false;
  if(env.LLM_BACKEND==='anymodel')return Boolean(env.ANYMODEL_API_KEY && env.LLM_MODEL);
  if(env.LLM_BACKEND==='proxyapi')return false;
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
  if (!limits.step) return callProvider(env,messages,tools,choice,send,limits);
  const started = performance.now();
  let status = null;
  const transport = async (url,options) => {
    const response = await send(url,options);
    status = response.status ?? null;
    return response;
  };
  const reportFailure = (code,finish) => console.warn(JSON.stringify({
    event:'model_call_failed', step:limits.step, model:env.LLM_MODEL || env.LLM_BACKEND || 'configured',
    elapsedMs:Math.round(performance.now()-started), status, code,
    finishReason:['stop','tool_calls','length','refusal','content_filter','function_call'].includes(finish) ? finish : null,
  }));
  try {
    const reply = await callProvider(env,messages,tools,choice,transport,limits);
    if (['length','refusal','content_filter'].includes(reply.finishReason)) reportFailure(reply.finishReason,reply.finishReason);
    return reply;
  } catch (error) {
    reportFailure(error.modelCode || (error.timedOut ? 'timeout' : error.status ? 'http_error' :
      error.retryable ? 'transport' : 'request_failed'),error.finishReason);
    throw error;
  }
}

async function callProvider(env,messages,tools,choice,send,limits){
  if(['gemini','vertex','vertex-express'].includes(env.LLM_BACKEND))return geminiCall(env,messages,tools,choice,send,undefined,limits);
  checkModelTransport(env);
  if(env.LLM_BACKEND==='proxyapi')throw Error('Для перехода с ProxyAPI задайте LLM_BACKEND=anymodel, ANYMODEL_API_KEY и LLM_MODEL в корневом .env.');
  const anymodel = env.LLM_BACKEND === 'anymodel';
  if(!apiConfigured(env))throw Error(anymodel
    ? 'Для AnyModel задайте ANYMODEL_API_KEY и LLM_MODEL в корневом .env.'
    : 'Для подключения модели задайте LLM_BASE_URL и LLM_MODEL в .env, а ключ — в LLM_API_KEY.');
  const baseUrl = anymodel ? anymodelBaseUrl : env.LLM_BASE_URL;
  const key = anymodel ? env.ANYMODEL_API_KEY : env.LLM_API_KEY;
  const target=new URL(baseUrl.replace(/\/+$/,'')+'/chat/completions');
  if(target.protocol!=='https:'&&!(target.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(target.hostname)))throw Error('Для удалённого API модели требуется HTTPS.');
  let response;
  const timeoutLimit = modelTimeout(env, 60_000);
  const timeout = Math.max(1,Math.min(timeoutLimit, limits.timeout ?? timeoutLimit));
  const timeoutSignal = AbortSignal.timeout(timeout);
  const signal = limits.signal ? AbortSignal.any([timeoutSignal, limits.signal]) : timeoutSignal;
  const timeoutError = () => {
    const seconds = Math.ceil(timeout / 1000);
    const unit = { one:'секунду', few:'секунды', many:'секунд', other:'секунды' }[new Intl.PluralRules('ru').select(seconds)];
    return Object.assign(Error('Модель не успела ответить за ' + seconds + ' ' + unit + '.'), {timedOut:true});
  };
  const history = messages.map(({usage, googleParts, lengthLimited, finishReason, refusal, ...message}) => message);
  const maxTokens = isAnyModelQwen(env) ? qwenMaxCompletionTokens : limits.maxTokens;
  try{signal.throwIfAborted();response=await send(target,{method:'POST',redirect:'error',signal,headers:{'Content-Type':'application/json',...(key?{Authorization:'Bearer '+key}:{})},
    body:JSON.stringify({model:env.LLM_MODEL,messages:history,...(tools.length?{tools,tool_choice:choice}:{}),
      ...(maxTokens?{max_tokens:maxTokens}:{}),
      ...(limits.responseFormat?{response_format:limits.responseFormat}:{}),
      ...(limits.temperature!==undefined?{temperature:limits.temperature}:{})})});}
  catch(error) {
    const abort = modelAbortFailure(error, signal, limits.signal);
    if (abort) throw abort.timedOut ? timeoutError() : abort;
    throw Object.assign(Error('Модель недоступна. Проверьте подключение и параметры .env.'),{retryable:true});
  }
  try {
    if (!response.ok) throw await modelHttpFailure(response, signal, limits.signal,
      'Провайдер модели вернул HTTP '+response.status+'.');
    const data = await readModelResponse(response, signal, limits.signal);
    const reply = data?.choices?.[0];
    return normalizeModelReply(reply?.message, {
      finishReason: reply?.finish_reason,
      usage: {input:data?.usage?.prompt_tokens,output:data?.usage?.completion_tokens},
    });
  } catch(error) {
    if (error.timedOut) throw timeoutError();
    throw error;
  }
}
async function apiTurn(store,a,history,question,env,send){
  const ctx=a.context,tools=apiTools(),refs=new Map(),messages=[{role:'system',content:system},
    {role:'user',content:JSON.stringify({release:a.rel,context:ctx,history,question})}];
  const metadataOnly = /релиз|выкладк|описани|аудитори|что измен|когда выпущен/iu.test(question) &&
    !/сколько|числител|знаменател|конверси|дол[яюеи]|показател|сравни|сопостав|эффект|воронк|метрик|почему|до и после|оплатил/iu.test(question);
  let readRelease = false;
  for(let round=0;round<6;round++){
    const grounded = refs.size || metadataOnly && readRelease;
    const reply=await providerCall(env,messages,tools,grounded?'auto':'required',send,{step:'release-chat.'+(round+1)});
    if (reply.lengthLimited || ['length','refusal','content_filter'].includes(reply.finishReason))
      throw Error('Модель вернула незавершённый ответ. Выполненные расчёты сохранены.');
    if(!reply.tool_calls?.length){
      const answer = completeModelText(reply);
      if(grounded && answer) return {answer,refs:[...refs.values()]};
      throw Error('Модель не подтвердила ответ расчётом.');
    }
    messages.push({...reply,role:'assistant',content:reply.content??null,tool_calls:reply.tool_calls});
    for(const call of reply.tool_calls){
      let result;
      try{
        const calc=scopeTool(store,ctx,call.function.name,JSON.parse(call.function.arguments));
        if(call.function.name === 'get_release') readRelease = true;
        if(calc.op)refs.set(calc.id,calc);
        result=calc.op==='build_chart'?calc:compact(calc);
      }catch(e){result={error:e.message};}
      messages.push({role:'tool',tool_call_id:call.id,content:JSON.stringify(result)});
    }
  }
  throw Error('Модель исчерпала число уточнений. Попробуйте более узкий вопрос.');
}
export function makeAgent(store,{env=process.env,send=fetch,alternate}={}){
  const jobs=new Map(), reviews=new Map(), reviewAbort=new AbortController();
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
  async function review(a,answer,signal){
    const facts=a.cards.map(c=>({metric:c.metric,title:c.title,status:c.status,before:c.series.all.before,after:c.series.all.after,
      days:c.series.all.daily.map((r,j)=>[a.days[j],r.value,r.d])}));
    const cohorts=compact(runTool(store,'breakdown',{...a.context,metric:a.rel.target}));
    const prompt='Напиши краткий общий вывод summary по главному вопросу, выбери 0–2 графика первого разбора и 0–3 значимых участка. Учитывай размер изменения и выборки. Используй факты и разрезы ниже. Участки [start,end) в сутках относительно релиза. Ответ по-русски. '+JSON.stringify({facts,cohorts,question:a.rel.question,answer});
    const parameters=z.toJSONSchema(reportSpec);delete parameters.$schema;
    const tool={type:'function',function:{name:'record_findings',description:'Выделить графики и периоды',parameters}};
    const reply=await providerCall(env,[{role:'user',content:prompt}],[tool],{type:'function',function:{name:'record_findings'}},send,{signal,step:'release-review'});
    if (reply.lengthLimited || ['refusal','content_filter'].includes(reply.finishReason)) throw Error('Обзор релиза не завершён.');
    return reportSpec.parse(JSON.parse(reply.tool_calls?.[0]?.function.arguments||'null'));
  }

  function queueReview(a, answer) {
    const key = JSON.stringify([a.context.releaseId,a.context.version,a.context.day]);
    if (reviewAbort.signal.aborted) return Promise.resolve();
    if (reviews.has(key)) return reviews.get(key);
    const job = review(a,answer,reviewAbort.signal).then(decision => {
      if (!reviewAbort.signal.aborted) store.tx(()=>storeReview(a,decision,answer));
    }).catch(()=>{}).finally(()=>reviews.delete(key));
    reviews.set(key,job);
    return job;
  }
  const waitForReviews = async () => { await Promise.allSettled(reviews.values()); };
  const closeReviews = () => {
    reviewAbort.abort();
    return waitForReviews();
  };
  function ask(body,trustedActor,trustedActorId){return queue(body.releaseId,async()=>{
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
    const decision=turn.decision;
    const refs=turn.refs.map(c=>({id:c.id,op:c.op,title:c.result.title||({breakdown:'Разбивка по клиентам',funnel:'Шаги воронки'}[c.op])||'Расчёт'}));
    const user={role:'user',author:body.author,authorId:trustedActorId,text:question,context:ctx,created:Date.now()};
    const reply={role:'assistant',author:'Агент',text:turn.answer,context:ctx,refs,created:Date.now()};
    store.tx(()=>{if(decision)storeReview(a,decision,turn.answer);store.addMessage(ctx.releaseId,request+'/q',user);store.addMessage(ctx.releaseId,request+'/a',reply);});
    if(!decision && apiConfigured(env)) void queueReview(a,turn.answer);
    return reply;
  });}
  return {ask,waitForReviews,closeReviews,async initial(input) {
    const a=analysis(store,{...input,segment:'all'});
    if(store.one('SELECT 1 FROM report_versions WHERE release=? AND version=?',a.rel.id,a.v.id)||a.cards[a.rel.target].status!=='ready')return;
    let decision;
    if(localData(env))return;
    if(apiConfigured(env))return queueReview(a,'Первый полный обзор.');
    else if(env.LLM_BACKEND==='codex'&&alternate){const t=await alternate(store,a,[],'Составь первый полный обзор и выбери графики и участки.');decision={...t.decision,summary:t.answer.slice(0,1200)};}
    if(decision)store.tx(()=>storeReview(a,decision,a.cards[a.rel.target].caption));
  }};
}
