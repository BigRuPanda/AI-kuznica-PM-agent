import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTeamApp} from '../server/team-http.mjs';
import {digest,importDocs} from '../server/evidence.mjs';
import {listPresentations,readPresentation,requestsPresentation,startPresentation,workPresentations} from '../server/presentations.mjs';
import {createThread,enqueue,messages,resumeJob,workJobs} from '../server/workbench.mjs';
import {composeSlide} from '../server/presentation-layout.mjs';
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
