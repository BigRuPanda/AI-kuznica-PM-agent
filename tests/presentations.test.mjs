import assert from 'node:assert/strict';
import test from 'node:test';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createTeamApp} from '../server/team-http.mjs';
import {digest,importDocs} from '../server/evidence.mjs';
import {listPresentations,readPresentation,startPresentation,workPresentations} from '../server/presentations.mjs';
import {composeSlide} from '../server/presentation-layout.mjs';
import {exportPptx,presentationHtml} from '../server/presentation-export.mjs';

const author={id:'pm'},peer={id:'peer'};
const local={LLM_BACKEND:'api',LLM_BASE_URL:'http://127.0.0.1:8080/v1',LLM_MODEL:'qwen',LLM_DATA_MODE:'analysis'};
async function fixture(t) {
  const dir=await mkdtemp(join(tmpdir(),'signal-presentations-'));
  const app=createTeamApp({base:join(dir,'test.sqlite'),env:{},background:false});
  t.after(async()=>{await app.close();await rm(dir,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
  const store=app.space('team');
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
  const peerInput=JSON.parse(db.prepare('SELECT input FROM presentations WHERE id=?').get(peerVersion.id).input);
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

test('empty and long cases preserve every check and export without a model',async t=>{
  const store=await fixture(t), db=store.db;
  db.prepare("UPDATE cases SET body='{}' WHERE id='sample'").run();
  const first=startPresentation(store,author,'sample','empty-case');
  await workPresentations(store,{},()=>assert.fail());
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
