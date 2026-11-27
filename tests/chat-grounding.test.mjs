import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../server/store.mjs';
import { analysisView, initEvidence, importDocs } from '../server/evidence.mjs';
import { grant, readSnapshot } from '../server/chart-ranges.mjs';
import { readMaterial } from '../server/materials.mjs';
import { answer, initWorkbench, createThread, enqueue, workJobs, messages } from '../server/workbench.mjs';
import { webQuestion } from '../server/web-search.mjs';
import { competitorQuestion } from '../server/competitor-chat.mjs';
import { releaseDecision } from '../server/release-decision.mjs';

const user = {id:'tester', name:'Продакт', role:'admin'};
function context(t) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  const row = (kind, loc, data) => ({kind, loc, row:data});
  importDocs(store, [{file:'sample.xlsx', facts:[
    row('sales','Sales!A2',{product_family:'Astra OS', week_start:'2026-04-06', orders_index:33}),
    row('sales','Sales!A3',{product_family:'Kaspersky Pro', week_start:'2026-04-06', orders_index:21}),
    row('sales','Sales!A4',{product_family:'Astra OS', week_start:'2026-03-30', orders_index:40}),
    row('sales','Sales!A5',{product_family:'Astra OS', week_start:'2026-04-20', orders_index:55, comment:'Неполная неделя'}),
    row('releases','Calendar!A2',{release_id:'R-38',release_date:'2026-04-06',description:'Доставка через архив',related_task_ids:'T-871,T-999'}),
    row('backlog','Tasks!A2',{task_id:'T-999',created_date:'2026-05-01',title:'Поздняя задача',release_id:'R-999'}),
    row('dictionary','Dictionary!A2',{metric_id:'impressions',metric_name:'Видимые показы витрины',what_it_means:'Видимый показ требует 72% площади за 3 секунды',formula_or_logic:'Число событий видимого показа'}),
    {kind:'interview',loc:'Interview!C8',text:'Недостающую лицензию доставили, устанавливал отдел инженеров.',detail:{field:'Опыт клиента',answer:'Недостающую лицензию доставили, устанавливал отдел инженеров.'}},
    {kind:'competitor',loc:'Prices!A4',prices:{'Продукт':'Лицензия для доставки'},row:{}},
    {kind:'interview',loc:'Research!D2',text:'Организовали выставку.',detail:{field:'Проект',answer:'Организовали выставку.'}},
    {kind:'interview',loc:'Research!D3',text:'Акция продлилась три недели.',detail:{field:'Проект',answer:'Акция продлилась три недели.'}},
  ]}], {notify:false});
  const thread = createThread(store.db,user,'Аудит');
  const other = createThread(store.db,user,'Другой разговор');
  const ask = async (question,{ otherThread, ...options }={}) => {
    const target = otherThread ? other : thread;
    enqueue(store,user,{thread:target,question,...options});
    await workJobs(store,{publicUser:()=>user},{});
    return messages(store.db,user,target).items.at(-1).body;
  };
  return Object.assign(ask,{store,thread});
}
test('weekly comparisons and subsequent questions resolve the named products and the same week', async t => {
  const ask=context(t);
  const both=await ask('Сравни индекс заказов Астры и Касперского за неделю с 6 апреля 2026. Какова разница в пунктах?');
  assert.match(both.text,/33/);
  assert.match(both.text,/21/);
  assert.match(both.text,/12 п/);
  assert.equal(both.readSources.length,2);
  const follow=await ask('А у Kaspersky за ту же неделю?');
  assert.equal(follow.readSources.length,1);
  assert.match(follow.text,/2026-04-06.*21/);
  assert.doesNotMatch(follow.text,/Astra/);
  const other=await ask('А у Kaspersky за ту же неделю?',{otherThread:true});
  assert.equal(other.weeklyContext,undefined);
  assert.doesNotMatch(other.text,/2026-04-06.*21/);
});
test('weekly changes respect the preceding week and the requested order of subtraction', async t => {
  const ask=context(t);
  const change=await ask('Сравни индекс заказов Астры за неделю с 6 апреля 2026 с предыдущей неделей. На сколько пунктов он изменился?');
  assert.match(change.text,/2026-03-30.*40/);
  assert.match(change.text,/[−-]7 п/);
  const difference=await ask('Сравни индекс заказов Касперского и Астры за неделю с 6 апреля 2026. Вычти индекс Астры из индекса Касперского.');
  assert.match(difference.text,/Kaspersky Pro минус Astra OS.*[−-]12 п/);
  const invalid=await ask('Какой индекс заказов Астры за неделю с 31 февраля 2026?');
  assert.equal(invalid.outcome,'clarification');
  assert.equal(invalid.weeklyContext,undefined);
});
test('unavailable revenue and absent archive IDs do not produce unrelated records', async t => {
  const ask=context(t);
  const missing=await ask('Что известно в архиве о релизе R-284?');
  assert.match(missing.text,/R-284/);
  assert.equal(missing.readSources.length,0);
  const money=await ask('Сколько составила выручка Астры в рублях за неделю с 6 апреля 2026 года?');
  assert.match(money.text,/выручк/iu);
  assert.match(money.text,/нет|отсутств|недоступ/iu);
  assert.doesNotMatch(money.text,/33|доставк/);
});
test('a linked task without a backlog row and a mix of known and unknown IDs retain their evidence', async t => {
  const ask=context(t);
  const linked=await ask('Указана ли задача T-871 в релизе R-38?');
  assert.match(linked.text,/T-871/);
  assert.ok(linked.readSources.some(s=>s.label.includes('Calendar!A2')));
  const other=await ask('А кто устанавливал лицензию по словам респондента?');
  assert.match(other.text,/отдел инженеров/);
  assert.ok(other.readSources.every(s=>s.label.includes('Interview!')));
  const result=await ask('Что известно в архиве о релизах R-38 и R-999?');
  assert.match(result.text,/Доставка через архив/);
  assert.match(result.text,/R-999/);
  assert.ok(result.readSources.some(s=>s.label.includes('Calendar!A2')));
});
test('historical archive lookup excludes releases beyond the selected cutoff', async t => {
  const ask=context(t);
  const reply=await ask('Что известно в архиве о релизе R-38 по состоянию на 2026-04-01?');
  assert.match(reply.text,/R-38/);
  assert.doesNotMatch(reply.text,/Доставка через архив/);
  assert.ok(!reply.readSources?.some(s=>s.label.includes('Calendar!A2')));
  const linked=await ask('Что известно в архиве о задачах релиза R-38 по состоянию на 2026-04-20?');
  assert.match(linked.text,/T-871/);
  assert.doesNotMatch(linked.text,/T-999|Поздняя задача/);
  assert.ok(!linked.readSources.some(s=>s.label.includes('Tasks!A2')));
});

test('selected screen enforces its date bounds and complete-week filter before archive lookup', async t => {
  const ask=context(t);
  const db=ask.store.db;
  const snapshot=analysisView(db,{product:'Astra OS',from:'2026-04-13',through:'2026-04-26',full:true});
  grant(db,snapshot.id,'thread',ask.thread);
  const screen={calc:snapshot.id,asOf:'2026-05-10',full:false};
  const early=await ask('Какой индекс заказов Астры за неделю с 2026-04-06?',{screen});
  const partial=await ask('Какой индекс заказов Астры за неделю с 2026-04-20?',{screen});
  const release=await ask('Что известно в архиве о релизе R-38?',{screen});
  const later=await ask('Что известно в архиве о задаче T-999 по состоянию на 2026-05-10?',{screen});
  for (const reply of [early,partial,release,later]) assert.deepEqual(reply.readSources,[]);
  assert.doesNotMatch(early.text,/33/u);
  assert.doesNotMatch(partial.text,/55/u);
  assert.doesNotMatch(release.text,/Доставка через архив/u);
  assert.doesNotMatch(later.text,/Поздняя задача/u);
});

test('an exact weekly question on a saved screen uses the cited version after a new import', async t => {
  const ask=context(t);
  const db=ask.store.db;
  const snapshot=analysisView(db,{product:'Astra OS',from:'2026-04-06',through:'2026-04-12'});
  grant(db,snapshot.id,'thread',ask.thread);
  const old=snapshot.summary[0].rows[0].version;
  importDocs(ask.store,[{file:'sample.xlsx',facts:[{kind:'sales',loc:'Sales!A2',
    row:{product_family:'Astra OS',week_start:'2026-04-06',orders_index:99},
  }]}],{notify:false});
  const question='Какой индекс заказов Астры за неделю с 2026-04-06?';
  const selected=await ask(question,{screen:{calc:snapshot.id}});
  assert.match(selected.text,/— 33/u);
  assert.equal(selected.readSources[0].url,'#knowledge-source/'+old+'/Sales!A2');
  const current=await ask(question);
  assert.match(current.text,/— 99/u);
});
test('source requests use the meaning field and respondents’ own accounts', async t => {
  const ask=context(t);
  const term=await ask('Как в справочнике определяют видимые показы витрины?');
  assert.match(term.text,/72%.*3 секунды/);
  const interview=await ask('Кто устанавливал лицензию по словам респондента?');
  assert.match(interview.text,/отдел инженеров/);
  assert.ok(interview.readSources.every(r=>r.label.includes('Interview!')));
  const project=await ask('Что сказали про акцию в интервью?');
  assert.match(project.text,/три недели/iu);
  assert.deepEqual(project.readSources?.map(s=>s.label),['sample.xlsx · Research!D3']);
});
test('an explicit request to stay offline overrides the internet checkbox', () => {
  assert.equal(webQuestion('Объясни без интернета',true),null);
  assert.equal(webQuestion('Не ищи в интернете, посмотри в архиве',true),null);
  assert.ok(webQuestion('Не ищи в архиве, найди в интернете отзывы',true));
  assert.equal(competitorQuestion('Не ищи в интернете, проверь цену конкурента allsoft.ru по архиву'),false);
});

test('carousel chat links the release, its task and actual clicks from the imported workbook', async t => {
  const store = openStore(':memory:', { seedDemo:false });
  t.after(() => store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  const row = (kind, loc, data) => ({ kind, loc, row:data });
  importDocs(store, [{ file:'account.xlsx', facts:[
    row('releases','Calendar!A2',{ release_id:'R-50', release_type:'minor', status:'выпущен',
      release_date:'2026-08-20', description:'Прокрутка карусели в ЛК',
      affected_metrics:'lk_reco_click_visits', related_task_ids:'T-9' }),
    row('releases','Calendar!A3',{ release_id:'R-65', release_type:'analytics', status:'выпущен',
      release_date:'2026-10-21', description:'Начало измерения просмотров',
      affected_metrics:'lk_reco_viewed_visits,lk_reco_ctr' }),
    row('backlog','Tasks!A2',{ task_id:'T-9', title:'Карусель', created_date:'2026-08-15' }),
    ...Array.from({ length:29 }, (_, i) => row('metrics','Clicks!A'+(i+2),{
      date:new Date(Date.UTC(2026,7,6+i)).toISOString().slice(0,10), product:'ЛК',
      metric_id:'lk_reco_click_visits', segment:'mobile', unit:'visits', value:i===14 ? 500 : i<14 ? 1 : 2,
    })),
  ] }], { notify:false });
  const thread=createThread(store.db,user,'Личный кабинет');
  const ask=async (suffix,question='После обновления карусели пользователи стали чаще переходить в магазин?')=>{
    enqueue(store,user,{thread,question:question + suffix});
    await workJobs(store,{publicUser:()=>user},{});
    return messages(store.db,user,thread).items.at(-1).body;
  };
  const reply=await ask('');
  assert.match(reply.text,/R-50/);
  assert.match(reply.text,/T-9/);
  assert.match(reply.text,/14 → 28/);
  assert.doesNotMatch(reply.text,/R-65|осталось прежним/);
  assert.ok(reply.readSources.every(s=>/^#knowledge-source\/[a-f0-9]{64}\//u.test(s.url)));
  assert.ok(reply.readSources.some(s=>s.label.includes('Calendar!A2')));
  assert.ok(reply.readSources.some(s=>s.label.includes('Tasks!A2')));
  assert.ok(reply.readSources.some(s=>s.label.includes('Clicks!')));
  const broad=await ask('','Что известно про карусель рекомендаций ЛК после выкладки?');
  assert.match(broad.text,/14 → 28/u);
  assert.ok(broad.readSources.some(s=>s.label.includes('Clicks!')));
  assert.match((await ask(' На 2026-10-30.')).text,/R-65/);
  assert.match((await ask(' На 2026-08-10.')).text,/нет такой выпущенной/);
  const through='2026-09-01';
  const version=store.db.prepare("SELECT version FROM facts WHERE loc='Calendar!A2'").get().version;
  const historical=await answer(store,user,{thread,question:'После обновления карусели изменились визиты с кликом? На 2026-10-30.',
    decisionReleaseId:'R-50',decisionThrough:through,
    releaseDecisionSnapshot:{releaseId:'R-50',product:'ЛК',through,releaseVersions:[version],metricVersions:[version]}},
    {},()=>assert.fail('Expected a local archive answer'));
  assert.equal(historical.decisionThrough,through);
  assert.match(historical.text,/12\/14/u);
  assert.doesNotMatch(historical.text,/14 → 28|R-65/u);
  const prompts=[];
  await answer(store,user,{thread,question:'Как сформулировать ограничение этого вывода?',decisionReleaseId:'R-50',
    decisionThrough:through,releaseDecisionSnapshot:{releaseId:'R-50',product:'ЛК',through,
      releaseVersions:[version],metricVersions:[version]}},
    {LLM_DATA_MODE:'analysis',LLM_BASE_URL:'http://localhost',LLM_MODEL:'fixture'},async(_url,options)=>{
      prompts.push(JSON.parse(options.body).messages);
      return Response.json({choices:[{message:{content:'Ограничение следует привязать к выбранной дате.'}}]});
    });
  assert.equal(prompts.length,1);
  assert.doesNotMatch(JSON.stringify(prompts[0]),/14 → 28|Просмотры блока начали измерять 2026-10-21/u);
});

test('carousel chat on a saved screen admits only the selected metric versions and calendar window', async t => {
  const store=openStore(':memory:',{seedDemo:false});
  t.after(()=>store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  const row=(kind,loc,data)=>({kind,loc,row:data});
  const calendar={file:'calendar.xlsx',facts:[
    row('releases','Calendar!A2',{release_id:'R-50',release_type:'minor',status:'выпущен',release_date:'2026-08-20',
      description:'Прокрутка карусели в ЛК',affected_metrics:'lk_reco_click_visits'}),
    row('releases','Calendar!A3',{release_id:'R-65',release_type:'analytics',status:'выпущен',release_date:'2026-08-01',
      description:'Начало измерения просмотров',affected_metrics:'lk_reco_viewed_visits,lk_reco_ctr'}),
  ]};
  const book=after=>({file:'clicks.xlsx',facts:Array.from({length:29},(_,i)=>row('metrics','Clicks!A'+(i+2),{
    date:new Date(Date.UTC(2026,7,6+i)).toISOString().slice(0,10),product:'ЛК',
    metric_id:'lk_reco_click_visits',segment:'mobile',unit:'visits',value:i<=14 ? 1 : after,
  }))});
  importDocs(store,[calendar,book(2)],{notify:false});
  const thread=createThread(store.db,user,'Сохранённый ЛК');
  const view=analysisView(store.db,{product:'ЛК',from:'2026-08-06',through:'2026-09-03'});
  grant(store.db,view.id,'thread',thread);
  const decision=releaseDecision(store.db,user,{product:'ЛК',releaseId:'R-50',through:view.cut});
  const ask=async()=>{
    enqueue(store,user,{thread,screen:{calc:view.id},question:'Что известно про карусель рекомендаций ЛК после выкладки?'});
    await workJobs(store,{publicUser:()=>user},{},()=>assert.fail('Expected a local archive answer'));
    return messages(store.db,user,thread).items.at(-1).body;
  };
  const confirmed=await ask();
  assert.match(confirmed.text,/14 → 28/u);
  assert.ok(confirmed.readSources.some(s=>s.label.includes('Clicks!')));
  assert.ok(confirmed.readSources.every(s=>!s.label.includes('Calendar!A3')));
  importDocs(store,[book(99)],{notify:false});
  const changed=await ask();
  assert.match(changed.text,/в выбранном снимке.{0,60}версии/iu);
  assert.doesNotMatch(changed.text,/1.?386/u);
  assert.ok(changed.readSources.every(s=>!s.label.includes('Clicks!')));
  const frozen=await answer(store,user,{thread,question:'Как изменились визиты с кликом после выкладки?',
    decisionReleaseId:'R-50',decisionThrough:view.cut,
    releaseDecisionSnapshot:{releaseId:'R-50',product:'ЛК',through:view.cut,releaseVersions:view.releaseVersions,
      metricVersions:view.metricVersions,decision}}, {},()=>assert.fail('Expected a local archive answer'));
  assert.match(frozen.text,/14 → 28/u);
  assert.ok(frozen.readSources.some(s=>s.url.includes(view.metricVersions[0]) && s.label.includes('Clicks!')));
});

test('released-decision chart preparation applies the signed cutoff before saving source rows', async t => {
  const store=openStore(':memory:',{seedDemo:false});
  t.after(()=>store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  const facts=[['2026-04-27',45],['2026-05-04',35],['2026-05-11',999],['2026-05-18',1234]].map(([week,value],i)=>({
    kind:'sales',loc:'Sales!A'+(i+2),row:{product_family:'Astra OS',week_start:week,orders_index:value},
  }));
  importDocs(store,[{file:'weekly-release.xlsx',facts}],{notify:false});
  const salesVersion=store.db.prepare("SELECT version FROM facts WHERE kind='sales' LIMIT 1").get().version;
  const thread=createThread(store.db,user,'Разбор релиза');
  const through='2026-05-10';
  const release={decisionReleaseId:'R-02',decisionThrough:through,releaseDecisionSnapshot:{
    releaseId:'R-02',product:'Astra OS',through,salesVersions:[salesVersion],releaseVersions:[],metricVersions:[],
  }};
  const chart=async (scope,suffix='')=>{
    const job='chart-fixture-'+(suffix || (scope.decisionThrough ? 'saved' : 'current'));
    const reply=await answer(store,user,{thread,product:'Astra OS',...scope,
      question:'Построй график индекса самостоятельных заказов'+suffix},{},()=>assert.fail('Expected a local chart'),job);
    const prepared=JSON.parse(store.db.prepare('SELECT body FROM job_research WHERE job=?').get(job).body);
    const material=readMaterial(store.db,user,(reply.chartMaterial || prepared.requestedChart).id);
    return readSnapshot(store.db,user,material.plot.base.calcId);
  };
  const current=await chart({});
  assert.ok(current.summary[0].rows.some(r=>r.value===1234));
  const saved=await chart(release);
  assert.equal(saved.cut,through);
  assert.deepEqual(saved.summary[0].rows.map(r=>r.value),[45,35]);
  const narrower=await chart(release,' по состоянию на 2026-05-03');
  assert.equal(narrower.cut,'2026-05-03');
  assert.deepEqual(narrower.summary[0].rows.map(r=>r.value),[45]);
  importDocs(store,[{file:'weekly-release.xlsx',facts:facts.map(f=>({...f,row:{...f.row,orders_index:17}}))}],{notify:false});
  await assert.rejects(chart(release),/нет подтверждённых версий/u);
});
