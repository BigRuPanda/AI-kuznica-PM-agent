import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StdioClientTransport} from '@modelcontextprotocol/sdk/client/stdio.js';
import {openStore} from '../server/store.mjs';
import {root} from '../server/config.mjs';
import {application} from '../server/http.mjs';
import {page,runTool} from '../server/analytics.mjs';
import {geminiCall} from '../server/gemini.mjs';
import {makeAgent} from '../server/agent.mjs';

test('Gemini Developer API uses the selected URL and a server-side key header',async()=>{
  const env={LLM_BACKEND:'gemini',LLM_MODEL:'gemini-3.5-flash',LLM_API_KEY:'fixture-key'};
  const tool={type:'function',function:{name:'get_release',description:'Релиз',parameters:{type:'object',properties:{}}}};
  const response=await geminiCall(env,[{role:'user',content:'Релиз'}],[tool],'auto',async(url,init)=>{
    assert.equal(url,'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent');
    assert.equal(init.headers['x-goog-api-key'],'fixture-key');
    assert.ok(!init.headers.Authorization);assert.match(init.body,/get_release/);
    return Response.json({candidates:[{content:{parts:[{text:'По'},{thought:true,text:'служебная часть'},{text:'казательным графиком'},{text:' являются визиты.\n\n'},{text:'- Первый период\n- Второй период'}]}}]});
  });
  assert.equal(response.content,'Показательным графиком являются визиты.\n\n- Первый период\n- Второй период');
});

test('Gemini on Google Cloud: project endpoint, ADC headers and opaque thought signature on the second turn',async()=>{
  const env={LLM_BACKEND:'vertex',GOOGLE_CLOUD_PROJECT:'demo-123',GOOGLE_CLOUD_LOCATION:'global',LLM_MODEL:'gemini-3.5-flash-lite'};
  const token={getRequestHeaders:async()=>new Headers({authorization:'Bearer demo','x-goog-user-project':'demo-123'})};
  const tools=[{type:'function',function:{name:'compare_metric',description:'Сравнение',parameters:{type:'object',properties:{}}}}];
  const messages=[{role:'system',content:'Инструменты анализа.'},{role:'user',content:'Сравни.'}];
  let count=0;
  const send=async(url,init)=>{
    const body=JSON.parse(init.body);assert.match(url,/projects\/demo-123\/locations\/global\/publishers\/google\/models\/gemini-3.5-flash-lite:generateContent$/);
    assert.equal(init.headers.authorization,'Bearer demo');assert.equal(body.tools[0].functionDeclarations[0].name,'compare_metric');
    if(!count++){assert.equal(body.toolConfig.functionCallingConfig.mode,'ANY');return Response.json({candidates:[{content:{parts:[{thoughtSignature:'opaque-proof',functionCall:{name:'compare_metric',args:{metric:0}}}]}}]});}
    assert.equal(body.contents[1].parts[0].thoughtSignature,'opaque-proof');
    assert.equal(body.contents.at(-1).parts[0].functionResponse.response.result.n,140);
    return Response.json({candidates:[{content:{parts:[{text:'140'}]}}]});
  };
  const first=await geminiCall(env,messages,tools,'required',send,token);
  messages.push(first,{role:'tool',tool_call_id:first.tool_calls[0].id,content:'{"n":140}'});
  assert.equal((await geminiCall(env,messages,tools,'auto',send,token)).content,'140');
});

test('one company with multiple checkouts counts once and an unavailable model leaves the report usable',async()=>{
  const s=openStore(':memory:');
  try{
    const input=['company_id,order_id,invoice_id,event_type,event_at',
      'C1,O1,I1,checkout_started,2026-10-05T08:00:00Z','C1,O2,I2,checkout_started,2026-10-06T08:00:00Z','C1,O2,I2,payment_received,2026-10-07T08:00:00Z'].join('\n');
    const ds=s.importCSV({name:'Два заказа',csv:input,completeThrough:'2026-10-19T07:00:00Z'});
    const ref=s.release('R-001'),r=s.create({...ref,dataset:ds.dataset,sourceKey:'',activatedAt:new Date(ref.launch).toISOString()});
    const c=runTool(s,'compare_metric',{releaseId:r.id,day:14,metric:0});
    assert.deepEqual([c.result.series.all.after.n,c.result.series.all.after.d],[1,1]);
    await assert.rejects(makeAgent(s,{env:{}}).ask({releaseId:r.id,day:14,author:'Анна',question:'Почему?',requestId:'failed'}),/модел/);
    assert.equal(s.getCalc(c.id).result.status,'ready');assert.equal(s.messages(r.id).length,0);
  }finally{s.close();}
});

test('CSV versions, shared dataset, atomic invalid import and stable old calculation',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'release-db-')),path=join(dir,'db.sqlite');
  let s=openStore(path);
  const source=await readFile(join(root,'demo/events.csv'),'utf8'), a=s.release('R-001');
  const calc=runTool(s,'compare_metric',{releaseId:a.id,metric:0,day:14});
  const imported=s.importCSV({dataset:a.dataset,name:'События',csv:source,completeThrough:'2026-11-16T07:00:00Z'});
  assert.equal(imported.version,calc.context.version);
  const newRelease=s.create({...a,activatedAt:new Date(a.launch).toISOString(),title:'Тестовый релиз'});
  assert.equal(newRelease.dataset,a.dataset);
  assert.throws(()=>s.importCSV({dataset:a.dataset,csv:source+'R-001,C1,O1,I1,new,purchase,bad,payment_received,,100\n'}),/Строка .*event_at/);
  assert.equal(s.version(a.dataset).id,imported.version);
  const few='order_id,invoice_id,event_type,event_at\r\nO1,I1,invoice_issued,2026-10-05T12:00:00Z\r\n';
  const replacement=s.importCSV({dataset:a.dataset,csv:few});
  assert.notEqual(replacement.version,calc.context.version);
  assert.equal(s.getCalc(calc.id).result.series.all.after.n,110);
  const blank=page(s,{releaseId:newRelease.id,day:14});
  assert.equal(blank.cards[0].status,'missing');assert.equal(blank.cards[0].series.all.after.value,null);
  assert.match(blank.cards[0].reason,/company_id/);
  s.close();s=openStore(path);assert.equal(s.release(newRelease.id).title,'Тестовый релиз');
  assert.equal(s.getCalc(calc.id).result.series.all.before.n,140);s.close();
});

test('chart comparison readiness follows the saved source version and observation date',async()=>{
  const store=openStore(':memory:');
  try{
    const query={releaseId:'R-001',day:14,spec:{field:'duration',stat:'median',start:'invoice',end:'payment'}};
    const ready=runTool(store,'build_chart',query);
    assert.equal(ready.result.status,'ready');
    assert.deepEqual([ready.result.before.n,ready.result.after.n],[68,123]);
    assert.equal(runTool(store,'build_chart',{...query,day:1}).result.status,'preliminary');
    const csv=await readFile(join(root,'demo/events.csv'),'utf8');
    store.importCSV({dataset:store.release('R-001').dataset,csv});
    const unconfirmed=runTool(store,'build_chart',query);
    assert.equal(unconfirmed.result.status,'preliminary');
    assert.equal(store.getCalc(unconfirmed.id).result.status,'preliminary');
    assert.deepEqual(store.getCalc(ready.id),ready);
  }finally{store.close();}
});

test('same saved comparison through API and real stdio MCP session',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'release-mcp-')),file=join(dir,'test.sqlite'),s=openStore(file);
  const app=application(s,{env:{}});await new Promise(r=>app.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+app.address().port;
  const client=new Client({name:'acceptance',version:'1'});
  try{
    await client.connect(new StdioClientTransport({command:process.execPath,args:[join(root,'server/mcp.mjs')],env:{...process.env,DATABASE_URL:file}}));
    const input={releaseId:'R-001',metric:0,day:14};
    const web=await (await fetch(base+'/api/compare',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(input)})).json();
    const mcp=JSON.parse((await client.callTool({name:'compare_metric',arguments:input})).content[0].text);
    assert.equal(mcp.id,web.id);assert.deepEqual(mcp.result.series.all,web.result.series.all);
    assert.deepEqual([web.result.series.all.before.n,web.result.series.all.after.n],[140,110]);
    const split=runTool(s,'breakdown',input).result;
    assert.deepEqual(['before','after'].map(p=>split.new.series.all[p].d),[400,600]);
    const inv=page(s,{releaseId:'R-002',day:14}).cards[1];assert.equal(inv.both.length,20);
    assert.deepEqual([inv.series.new.after.n,inv.series.new.after.d,inv.series.old.after.n,inv.series.old.after.d],[48,80,62,120]);
    const early=page(s,{releaseId:'R-002',day:0});
    assert.equal(early.cards[1].series.all.after.value,null);assert.equal(early.cards[1].status,'preliminary');
    assert.equal(early.days.at(-1),-1);
  }finally{await client.close();await new Promise(r=>app.close(r));s.close();}
});

test('connected HTTP tool loop, follow-up history, two profiles, chart publication and restart',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'release-agent-')),file=join(dir,'chat.sqlite');
  let s=openStore(file),sawFollowup=false;
  const env={LLM_BASE_URL:'http://localhost/v1',LLM_MODEL:'fixture'};
  const respond=m=>Response.json({choices:[{message:m}]});
  const tool=(n,args)=>respond({tool_calls:[{id:'tool-1',type:'function',function:{name:n,arguments:JSON.stringify(args)}}]});
  async function model(url,options){
    assert.equal(String(url),'http://localhost/v1/chat/completions');const req=JSON.parse(options.body);
    if(req.tools[0].function.name==='record_findings')return tool('record_findings',{summary:'Сводка для релиза.',highlights:[{metric:0,reason:'Сдвиг конверсии.'}],intervals:[{metric:0,segment:'all',start:0,end:7,reason:'Достаточный объём наблюдений.'}]});
    const {question,history}=JSON.parse(req.messages[1].content);
    if(question.includes('компаний'))sawFollowup=history.some(m=>m.role==='assistant'&&m.refs.length>0);
    if(req.messages.at(-1).role==='tool'){
      const c=JSON.parse(req.messages.at(-1).content);assert.ok(c.id);return respond({content:'Результат подтверждён расчётом '+c.id+'.'});
    }
    if(question.includes('дней'))return tool('build_chart',{spec:{title:'Время до оплаты',field:'duration',stat:'median',start:'invoice',end:'payment'}});
    return tool('breakdown',{metric:0});
  }
  let app=application(s,{env,send:model});await new Promise(r=>app.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+app.address().port;
  const post=async(p,b)=>{const res=await fetch(base+'/api/'+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b)});const data=await res.json();assert.equal(res.status,200,JSON.stringify(data));return data;};
  try{
    const ctx={releaseId:'R-001',day:14,segment:'all',metric:0,author:'Анна'};
    await post('chat',{...ctx,question:'Почему упала конверсия?',requestId:'one'});
    const duplicate=await post('chat',{...ctx,question:'Почему упала конверсия?',requestId:'one'});assert.equal(duplicate.refs[0].op,'breakdown');
    await post('chat',{...ctx,author:'Дмитрий',question:'А сколько компаний было в каждой группе?',requestId:'two'});
    assert(sawFollowup);assert.equal(s.messages(ctx.releaseId).length,4);
    const chart=await post('chat',{...ctx,releaseId:'R-002',question:'Сколько дней обычно проходит до оплаты?',requestId:'chart'});
    const id=chart.refs[0].id,calc=s.getCalc(id);
    assert.deepEqual(calc.result.after,{value:3.5,n:92});assert.match(calc.result.formula,/обоими событиями/);
    await post('boards',{author:'Дмитрий',releaseId:'R-002',name:'Скорость оплаты',calc:id});
    await post('boards',{author:'Анна',releaseId:'R-002',name:'Скорость оплаты',calc:id});
    assert.equal(s.boards('R-002').length,1);assert.equal(s.boards('R-001').length,0);
    const report=page(s,ctx);assert.equal(report.report.highlights.length,1);assert.equal(report.notes.length,1);
    assert.equal(page(s,{...ctx,day:1}).notes.length,0);
  }finally{await new Promise(r=>app.close(r));s.close();}
  s=openStore(file);assert.equal(s.messages('R-001').length,4);assert.equal(s.boards('R-002').length,1);s.close();
});
