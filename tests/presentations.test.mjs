import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTeamApp} from '../server/team-http.mjs';
import {digest,importDocs} from '../server/evidence.mjs';
import {listPresentations,readPresentation,requestsPresentation,startPresentation,workPresentations} from '../server/presentations.mjs';
import {addUserMessage,bindReleaseThreadCase,createThread,dashboard,enqueue,messages,openCaseThread,openReleaseThread,resumeJob,workJobs} from '../server/workbench.mjs';
import {assembleDeck,composeSlide} from '../server/presentation-layout.mjs';
import {casePresentationInput} from '../server/presentation-case.mjs';
import {exportPptx,presentationHtml} from '../server/presentation-export.mjs';

const author={id:'pm',name:'Продакт'},peer={id:'peer',name:'Коллега'};
const local={LLM_BACKEND:'api',LLM_BASE_URL:'http://127.0.0.1:8080/v1',LLM_MODEL:'qwen',LLM_DATA_MODE:'analysis'};
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'signal-presentations-'));
  const app=createTeamApp({base:join(dir,'test.sqlite'),env:{},background:false});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const store=app.space('team');
  store.db.exec('CREATE TABLE IF NOT EXISTS redmine_results(id TEXT PRIMARY KEY,case_id TEXT,body TEXT,created INTEGER)');
  store.db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run('sample','Сервис','Оформление заказа','Исследуем',JSON.stringify({
    plan:{hypothesis:'Посетители прерывают оформление',success:'Измерить завершение заказа'},
  }));
  return store;
}
test('case deck freezes its evidence, checks access on every version and resumes a leased job',async t=>{
  const store=await fixture(t),db=store.db;
  const doc={file:'Research.xlsx',facts:[
    {kind:'interview',loc:'Survey!H4',text:'Ответ',detail:{field:'Выбор поставщика',answer:'Доступные цены и гарантия.'}},
  ]};
  importDocs(store,[doc],{notify:false});
  const version=db.prepare('SELECT version FROM documents WHERE file=?').get(doc.file).version;
  const tid=digest(author.id+'/sample');
  db.prepare('INSERT INTO conversations VALUES(?,?,?,?)').run(tid,author.id,'private','Разбор');
  const insert=db.prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES(?,?,'assistant',?,?)");
  const msg={text:'Респондент назвал гарантию.',readSources:[{label:'Источник',url:'#knowledge-source/'+version+'/Survey!H4'}]};
  insert.run(tid,'Signal',JSON.stringify(msg),Date.now());
  insert.run(tid,'Signal',JSON.stringify(msg),Date.now());
  const {id}=startPresentation(store,author,'sample','same-request');
  assert.equal(startPresentation(store,author,'sample','same-request').id,id);
  assert.throws(()=>readPresentation(db,peer,id),/недоступна/);
  assert.equal(listPresentations(db,peer,'sample').length,0);
  db.prepare("INSERT INTO redmine_results VALUES('private-closure','sample',?,?)").run(JSON.stringify({
    issue:42,status:'Закрыто',title:'Личный результат',personalOwner:author.id
  }),Date.now());
  const peerVersion=startPresentation(store,peer,'sample','peer-version');
  const peerInput=JSON.parse(db.prepare('SELECT body FROM presentation_inputs WHERE id=?').get(peerVersion.id).body);
  assert.equal(peerInput.personal,false);
  assert.ok(!JSON.stringify(peerInput).includes('Личный результат'));
  db.prepare("UPDATE presentations SET status='running',lease=0 WHERE id=?").run(id);
  db.prepare("UPDATE cases SET title='Другая версия' WHERE id='sample'").run();
  let calls=0;
  await workPresentations(store,local,async()=>{
    calls++;return Response.json({choices:[{message:{content:'{"slides":[1,0]}'}}]});
  });
  const {deck,notice}=readPresentation(db,author,id);
  assert.equal(calls,1);assert.equal(notice,null);assert.equal(deck.title,'Оформление заказа');
  assert.ok(deck.slides.some(s=>s.kind==='quote' && s.body.includes('гарантия')));
  assert.equal(deck.slides.filter(s=>s.kind==='log').flatMap(s=>s.rows).filter(r=>r[2].includes('Респондент назвал')).length,1);
  assert.ok(presentationHtml(deck,'http://localhost').includes('#knowledge-source/'+version));
  const buffer=await exportPptx(deck,'http://localhost');
  assert.equal(buffer.subarray(0,2).toString(),'PK');
  await workPresentations(store,{},()=>assert.fail());
  const next=startPresentation(store,author,'sample','next-request');
  await workPresentations(store,local,async()=>Response.json({choices:[{message:{content:'{"slides":[{"id":900,"heading":0}]}'}}]}));
  assert.match(readPresentation(db,author,next.id).notice,/шаблону/);
  assert.equal(readPresentation(db,author,next.id).deck.title,'Другая версия');
});

test('chat commands use the case exporter once, expose its real status and respect personal materials',async t=>{
  const store=await fixture(t),db=store.db;
  for(const q of ['сделай презентацию','собери по этому разбору презу','Можно подготовить слайды для руководства?','выгрузи разбор в PDF'])
    assert.equal(requestsPresentation(q),true,q);
  for(const q of ['не делай презентацию','как собрать презентацию?','найди презентацию в архиве','создай задачу по презентации'])
    assert.equal(requestsPresentation(q),false,q);
  const noModel=()=>assert.fail('general chat and web search should not run');
  const thread=createThread(db,author,'Презентации');
  const question='О графике «Продажи». Сделай презентацию';
  const id=enqueue(store,author,{thread,caseId:'sample',question,typedQuestion:'Сделай презентацию',webSearch:true});
  // Older builds sometimes recorded the model's refusal as a completed turn.
  const legacy={mode:'analysis',outcome:'done',caseId:'sample',jobId:id,text:'Не могу создать презентацию.',actions:[]};
  legacy.inReplyTo=JSON.parse(db.prepare('SELECT body FROM jobs WHERE id=?').get(id).body).questionSeq;
  db.prepare("UPDATE jobs SET status='done',result=? WHERE id=?").run(JSON.stringify(legacy),id);
  db.prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES(?,'Агент','assistant',?,?)").run(thread,JSON.stringify(legacy),Date.now());
  assert.equal(messages(db,author,thread).items.at(-1).body.missingPresentation,true);
  resumeJob(db,author,id);
  await workJobs(store,{publicUser:()=>author},local,noModel);
  let reply=messages(db,author,thread).items.at(-1).body;
  assert.equal(reply.presentationStatus,'queued');
  assert.match(reply.text,/Собираю/);
  const deckId=reply.presentationId;
  // Worker restart after committing the snapshot but before acknowledging the chat turn.
  db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(id);
  await workJobs(store,{publicUser:()=>author},local,noModel);
  await workPresentations(store,{},noModel);
  reply=messages(db,author,thread).items.at(-1).body;
  assert.equal(reply.presentationStatus,'ready');
  assert.equal(reply.presentationId,deckId);
  assert.equal(listPresentations(db,author,'sample').length,1);
  assert.equal(messages(db,author,thread).items.length,2);
  enqueue(store,author,{thread,question:'Сделай презентацию'});
  await workJobs(store,{publicUser:()=>author},local,noModel);
  assert.equal(messages(db,author,thread).items.at(-1).body.outcome,'clarification');
  assert.equal(listPresentations(db,author,'sample').length,1);
  const caseThread=digest(author.id+'/sample');
  db.prepare("INSERT INTO conversations VALUES(?,?,'private','Из списка чатов')").run(caseThread,author.id);
  enqueue(store,author,{thread:caseThread,question:'Подготовь презентацию'});
  await workJobs(store,{publicUser:()=>author},local,noModel);
  assert.ok(messages(db,author,caseThread).items.at(-1).body.presentationId);
  db.prepare('INSERT INTO redmine_results VALUES(?,?,?,?)').run('private-result','sample',JSON.stringify({personalOwner:author.id,issue:1,title:'Личный материал'}),Date.now());
  enqueue(store,author,{thread:'group',caseId:'sample',question:'Собери презентацию'});
  await workJobs(store,{publicUser:()=>author},local,noModel);
  assert.ok(messages(db,author,'group').items.at(-1).body.presentationId);
  assert.equal(messages(db,peer,'group').items.at(-1).body.presentationId,undefined);
});

test('an accepted release discussion remains grouped with its case and can queue a deck from Chats',async t=>{
  const store=await fixture(t),db=store.db;
  const decision={release:{id:'R-42'},product:'Сервис',scope:'product'};
  const thread=openReleaseThread(store,author,decision);
  const otherProduct=openReleaseThread(store,author,{...decision,product:'Другой сервис'});
  const otherOwner=openReleaseThread(store,peer,decision);
  addUserMessage(db,author,thread,{text:'История обсуждения релиза'});
  db.prepare("UPDATE cases SET body=json_set(body,'$.release','R-42','$.owner',?) WHERE id='sample'").run(author.id);
  bindReleaseThreadCase(db,author,'R-42','sample','Сервис');

  assert.equal(openCaseThread(db,author,'sample'),thread);
  const originIds=Object.fromEntries(dashboard(db,author).threads.map(row=>[row.id,row.caseId]));
  assert.equal(originIds[thread],'sample');
  assert.equal(originIds[otherProduct],null);
  assert.equal(dashboard(db,peer).threads.find(row=>row.id===otherOwner)?.caseId,null);
  assert.ok(!dashboard(db,peer).threads.some(row=>row.id===thread));
  assert.equal(messages(db,author,thread).items[0].body.text,'История обсуждения релиза');

  enqueue(store,author,{thread,question:'Сделай презентацию'});
  const [version]=listPresentations(db,author,'sample');
  assert.ok(version?.id,'the accepted release discussion queues the case presentation');
  await workJobs(store,{publicUser:()=>author},local,()=>assert.fail('the command must use the case exporter'));
  assert.equal(messages(db,author,thread).items.at(-1).body.presentationId,version.id);
  assert.equal(listPresentations(db,author,'sample').length,1);
});

test('a slide cover keeps a percentage together at the configured title size',()=>{
  const title='Доля завершённых заказов · 48 % за 2026-11-03';
  const deck={product:'Интернет-магазин',state:'Исследуем',created:Date.now(),
    slides:[{kind:'cover',title,keyValue:'48',keyLabel:'Доля завершённых заказов',body:'Оформление заказа',decision:'Сопоставить результат'}]};
  const heading=composeSlide(deck,0).find(object=>object.type==='text' && object.lines[0].startsWith('Доля завершённых заказов'));
  assert.equal(heading.size,47);
  assert.ok(heading.lines.some(line=>/48\s%/u.test(line)),JSON.stringify(heading.lines));
  assert.match(presentationHtml(deck,'http://localhost'),/48\s% за 2026-11-03/u);
});

test('empty and long cases preserve every check and export without a model',async t=>{
  const store=await fixture(t), db=store.db;
  db.prepare("UPDATE cases SET body='{}' WHERE id='sample'").run();
  const first=startPresentation(store,author,'sample','empty-case');
  await workPresentations(store,{...local,DATA_PROFILE:'local'},()=>assert.fail('local profile must never call a model'));
  assert.deepEqual(readPresentation(db,peer,first.id).deck.slides.map(s=>s.kind),['cover','decision','sources']);
  const long=Array(180).fill('Проверили оформление заказа.').join(' ')+' Конечная строка.';
  db.prepare("UPDATE cases SET state='Завершено',body=? WHERE id='sample'").run(JSON.stringify({owner:author.id,notes:[{text:long,created:Date.now()}]}));
  const next=startPresentation(store,author,'sample','long-case');
  await workPresentations(store,local,async()=>{throw new Error('offline');});
  const result=readPresentation(db,author,next.id);
  assert.match(result.notice,/шаблону/);
  assert.ok(result.deck.slides.filter(s=>s.kind==='log').length>1);
  assert.ok(result.deck.slides.filter(s=>s.kind==='log').at(-1).rows.at(-1)[2].includes('Конечная строка'));
  assert.throws(()=>readPresentation(db,peer,first.id),/недоступен/);
  for(const [i] of result.deck.slides.entries())
    for(const o of composeSlide(result.deck,i)) assert.ok(o.y+o.h<=720,o.type+' overflows slide '+i);
});

test('a chat request freezes the case before the worker runs and can repair an unavailable version',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'signal-presentation-restart-'));
  const open=()=>createTeamApp({base:join(dir,'test.sqlite'),env:{},background:false});
  let app=open();
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  let store=app.space('team'), db=store.db;
  db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run('sample','Покупки','Первый заголовок','Исследуем','{}');
  const thread=createThread(db,author,'Разбор покупки');
  const request={thread,caseId:'sample',question:'Сделай презентацию',requestId:'chat-restart'};
  const job=enqueue(store,author,request);
  assert.equal(enqueue(store,author,request),job);
  const [version]=listPresentations(db,author,'sample');
  db.prepare("UPDATE presentations SET status='running',lease=0 WHERE id=?").run(version.id);
  db.prepare("UPDATE cases SET title='Другой заголовок' WHERE id='sample'").run();
  await app.close();
  app=open();
  store=app.space('team');
  db=store.db;
  const noModel=()=>assert.fail('a local presentation must never call a model');
  const env={...local,DATA_PROFILE:'local'};
  const reply=()=>messages(db,author,thread).items.at(-1).body;
  await workJobs(store,{publicUser:()=>author},env,noModel);
  await workPresentations(store,env,noModel);
  assert.equal(reply().presentationId,version.id);
  assert.equal(readPresentation(db,author,version.id).deck.title,'Первый заголовок');

  db.prepare('UPDATE presentations SET deck=NULL WHERE id=?').run(version.id);
  assert.equal(reply().missingPresentation,true);
  resumeJob(db,author,job);
  await workJobs(store,{publicUser:()=>author},env,noModel);
  await workPresentations(store,env,noModel);
  assert.equal(reply().presentationStatus,'ready');
  assert.equal(readPresentation(db,author,version.id).deck.title,'Первый заголовок');

  db.prepare('DELETE FROM presentations WHERE id=?').run(version.id);
  assert.equal(reply().missingPresentation,true);
  resumeJob(db,author,job);
  await workJobs(store,{publicUser:()=>author},env,noModel);
  await workPresentations(store,env,noModel);
  assert.equal(reply().presentationId,version.id);
  assert.equal(reply().presentationStatus,'ready');
  assert.equal(readPresentation(db,author,version.id).deck.title,'Первый заголовок');
  assert.equal(listPresentations(db,author,'sample').length,1);
  assert.equal(messages(db,author,thread).items.length,2);
});

test('an upgraded donor workspace preserves UUID links and reports a lost original snapshot',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'signal-presentation-donor-'));
  const env={DATA_PROFILE:'local',ADMIN_INVITE_KEY:'presentation-upgrade'};
  const open=()=>createTeamApp({base:join(dir,'test.sqlite'),env,background:false});
  let app=open();
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const register=(login,code)=>app.accounts.register({login,name:login,password:'synthetic-password',code},env);
  const {user,token}=await register('donor-owner',env.ADMIN_INVITE_KEY);
  const {token:peerToken}=await register('donor-peer',app.accounts.invite('team'));
  let store=app.space('team'), db=store.db;
  db.exec('DROP TABLE presentation_inputs');
  db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run('sample','Покупки','Исходное название','Исследуем',JSON.stringify({owner:user.id}));
  const now=Date.now(), thread=createThread(db,user,'Чат из донора');
  const snapshot=casePresentationInput(db,user,'sample',now);
  function donorJob(state) {
    const job=randomUUID(), id=randomUUID();
    const questionSeq=Number(db.prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES(?,?,'user',?,?)")
      .run(thread,user.name,JSON.stringify({text:'Сделай презентацию',authorId:user.id}),now).lastInsertRowid);
    const result={mode:'presentation',caseId:'sample',presentationId:id,text:'Презентация добавлена в материалы разбора.',outcome:'done'};
    db.prepare('INSERT INTO jobs VALUES(?,?,?,?,?,?,?)')
      .run(job,thread,user.id,JSON.stringify({thread,caseId:'sample',question:'Сделай презентацию',questionSeq}),'done',JSON.stringify(result),now);
    db.prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES(?,'Агент','assistant',?,?)")
      .run(thread,JSON.stringify({...result,inReplyTo:questionSeq,jobId:job}),now);
    if(state!=='lost') db.prepare('INSERT INTO presentations(id,case_id,author,personal,request,created,status,input,deck) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(id,'sample',user.id,1,'chat-'+job,now,state,state==='ready'?null:JSON.stringify(snapshot),
        state==='ready'?JSON.stringify(assembleDeck(snapshot,[])):null);
    return {job,id};
  }
  const existing=donorJob('ready'), recoverable=donorJob('failed'), waiting=donorJob('queued'), lost=donorJob('lost');
  db.prepare("UPDATE cases SET title='Изменённое название' WHERE id='sample'").run();
  for(let retry=0;retry<2;retry++) {
    await app.close();
    app=open();
    store=app.space('team');
    db=store.db;
  }
  assert.equal(db.prepare('SELECT count(*) AS n FROM presentation_inputs').get().n,2);
  const noModel=()=>assert.fail('a local presentation must never call a model');
  await workPresentations(store,env,noModel);
  assert.equal(readPresentation(db,user,waiting.id).deck.title,'Исходное название');
  await new Promise((resolve,reject)=>app.server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.server.address().port;
  const download=(id,session)=>fetch(base+'/api/presentations/'+id+'/pptx',{headers:{Cookie:'pm_session='+session}});
  const post=async(op,body,session=token)=>fetch(base+'/api/team/'+op,{
    method:'POST',headers:{Cookie:'pm_session='+session,'Content-Type':'application/json'},body:JSON.stringify(body),
  });
  const reply=job=>messages(db,user,thread).items.find(m=>m.body.jobId===job).body;
  const first=await download(existing.id,token);
  assert.equal(first.status,200);
  assert.equal(Buffer.from(await first.arrayBuffer()).subarray(0,2).toString(),'PK');
  assert.equal((await download(existing.id,peerToken)).status,404);
  assert.equal((await post('presentation-status',{id:existing.id},peerToken)).status,400);

  db.prepare('DELETE FROM presentations WHERE id=?').run(recoverable.id);
  assert.equal(reply(recoverable.job).canResume,true);
  assert.equal((await post('resume-job',{id:recoverable.job},peerToken)).status,400);
  assert.equal((await post('resume-job',{id:recoverable.job})).status,200);
  await workJobs(store,app.accounts,env,noModel);
  await workPresentations(store,env,noModel);
  assert.equal(reply(recoverable.job).presentationId,recoverable.id);
  assert.equal(readPresentation(db,user,recoverable.id).deck.title,'Исходное название');
  assert.equal((await download(recoverable.id,token)).status,200);
  assert.equal((await download(recoverable.id,peerToken)).status,404);

  assert.equal(reply(lost.job).replacePresentation,true);
  assert.equal(reply(lost.job).canResume,undefined);
  assert.match(reply(lost.job).text,/текущим данным/);
  assert.equal((await post('resume-job',{id:lost.job})).status,200);
  db.prepare("UPDATE jobs SET status='queued' WHERE id=?").run(lost.job);
  await workJobs(store,app.accounts,env,noModel);
  assert.equal(reply(lost.job).presentationId,lost.id);
  assert.equal((await download(lost.id,token)).status,404);
  const fresh=await post('ask',{thread,caseId:'sample',question:'Сделай презентацию',requestId:'new-after-loss'});
  assert.equal(fresh.status,200);
  const {id:newJob}=await fresh.json();
  await workJobs(store,app.accounts,env,noModel);
  await workPresentations(store,env,noModel);
  const replacement=reply(newJob).presentationId;
  assert.notEqual(replacement,lost.id);
  assert.equal(readPresentation(db,user,replacement).deck.title,'Изменённое название');
  assert.equal(reply(lost.job).replacePresentation,true);
});

test('a presentation labels a withdrawn signal and cites each sales workbook version',async t=>{
  const store=await fixture(t), db=store.db;
  const product='Магазин контрольных продаж';
  const sheet='Продажи после выкладки.xlsx';
  const weeks=['2026-11-02','2026-11-09'];
  const sales=values=>({file:sheet,facts:weeks.map((week,i)=>({
    kind:'sales',loc:'Продажи!C'+(i+2),row:{product_family:product,week_start:week,orders_index:values[i]},
  }))});
  const old=sales([75,80]), current=sales([95,105]);
  const rule={file:'Порог.xlsx',facts:[{
    kind:'dictionary',loc:'Справочник!A2',row:{metric_id:'family_orders_idx',bad_signal:'Индекс ниже 90 две недели подряд'},
  }]};
  importDocs(store,[rule,old],{notify:false});
  const {id:caseId}=db.prepare('SELECT id FROM cases WHERE product=?').get(product);
  const first=startPresentation(store,author,caseId,'initial-sales');
  importDocs(store,[current],{notify:false});
  const next=startPresentation(store,author,caseId,'reimport-sales');
  await workPresentations(store,{},()=>assert.fail());
  await workPresentations(store,{},()=>assert.fail());
  const oldVersion=digest(JSON.stringify(old)), currentVersion=digest(JSON.stringify(current));
  const firstDeck=readPresentation(db,author,first.id).deck;
  const deck=readPresentation(db,author,next.id).deck;
  assert.equal(firstDeck.slides[0].keyValue,'80');
  assert.equal(firstDeck.slides[0].refs.some(r=>r.url.includes(currentVersion)),false);
  assert.match(deck.slides[0].title,/Сигнал отозван/);
  assert.equal(deck.slides[0].keyValue,'105');
  const chart=deck.slides.find(slide=>slide.kind==='chart');
  assert.deepEqual(chart.series[0].points.map(p=>p.value),[95,105]);
  assert.ok(chart.refs.every(r=>r.url.includes(currentVersion)));
  const original=deck.slides.find(slide=>slide.title.startsWith('Данные первоначального сигнала'));
  assert.deepEqual(original.rows.map(row=>row[1]),['75','80']);
  assert.ok(original.refs.every(r=>r.url.includes(oldVersion)));
  const html=presentationHtml(deck,'http://localhost');
  for(const match of [/Сигнал отозван/,/Порог исходного сигнала|порог 90/,/105/,new RegExp(oldVersion),new RegExp(currentVersion)])
    assert.match(html,match);
  assert.equal((await exportPptx(deck,'http://localhost')).subarray(0,2).toString(),'PK');
});

test('the presentation editor cannot send a private snapshot through ProxyAPI',async t=>{
  const store=await fixture(t), db=store.db;
  db.prepare("UPDATE cases SET body=json_set(body,'$.owner',?) WHERE id='sample'").run(author.id);
  const version=startPresentation(store,author,'sample','proxyapi-guard');
  let calls=0;
  await workPresentations(store,{...local,LLM_BACKEND:'proxyapi',PROXYAPI_API_KEY:'synthetic-key'},async()=>{
    calls++;
    return Response.json({choices:[{message:{content:'{"slides":[0]}'}}]});
  });
  assert.equal(calls,0);
  const result=readPresentation(db,author,version.id);
  assert.equal(result.status,'ready');
  assert.match(result.notice,/по шаблону/);
});

test('the loopback presentation editor requests a strict JSON schema',async t=>{
  const store=await fixture(t),db=store.db;
  const {id}=startPresentation(store,author,'sample','strict-editor-schema');
  const requests=[];
  await workPresentations(store,local,async (url,{body})=>{
    requests.push({url:String(url),body:JSON.parse(body)});
    return Response.json({choices:[{message:{content:'{"slides":[0]}'}}]});
  });
  assert.equal(requests.length,1);
  assert.equal(requests[0].url,'http://127.0.0.1:8080/v1/chat/completions');
  const format=requests[0].body.response_format;
  assert.equal(format?.type,'json_schema');
  assert.equal(format.json_schema.name,'presentation');
  assert.equal(format.json_schema.strict,true);
  assert.deepEqual(format.json_schema.schema.required,['slides']);
  assert.equal(format.json_schema.schema.additionalProperties,false);
  assert.equal(readPresentation(db,author,id).status,'ready');
});
