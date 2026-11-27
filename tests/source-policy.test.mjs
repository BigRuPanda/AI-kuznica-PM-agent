import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../server/store.mjs';
import { digest, initEvidence } from '../server/evidence.mjs';
import { approveSource, importApproved, initSourcePolicy, protectedSources, sourceHistory, sourcePermission } from '../server/source-policy.mjs';
import { archiveAnswer, archiveEvidence } from '../server/archive-search.mjs';
import { sourceRows } from '../server/knowledge.mjs';
import { initWorkbench } from '../server/workbench.mjs';

const archive = Buffer.from('pinned original archive fixture');
const sha = digest(archive);
const first = 'finance.xlsx';
const second = 'metrics.xlsx';
test('an already indexed ZIP can add reference inventory without replacing an indexed book', t => {
  const book = report('Data/metrics.xlsx', ['reach']);
  const reference = { file: 'Reference/Instructions.pdf', facts: [], role: 'reference' };
  const store = fixture(t, [book]);
  const before = protectedSources(store.db).find(row => row.file === book.file);
  store.db.prepare('UPDATE archive_indexes SET format=3 WHERE sha=?').run(sha);
  const permission = sourcePermission(store.db, sha, archive, 'original.zip');
  assert.equal(permission.refresh, true);
  assert.equal(importApproved(store, [book, reference], permission, false).inserted, 1);
  const inventory = protectedSources(store.db);
  const indexed = inventory.find(row => row.file === book.file);
  const supporting = inventory.find(row => row.file === reference.file);
  assert.deepEqual(indexed, before);
  assert.deepEqual([supporting.file, supporting.role, supporting.total, supporting.versions], [reference.file, 'reference', 0, 1]);
  const [version] = sourceHistory(store.db, reference.file);
  assert.equal(version.origin, 'Исходный ZIP организатора');
  assert.equal(version.author, null);
  assert.equal(version.active, true);
  assert.equal(sourcePermission(store.db, sha, archive, 'original.zip').alreadyImported, true);
});

test('reimporting a donor ZIP preserves the original ID of an unambiguous flattened reference', t => {
  const old = {file:'guide.pdf', facts:[], role:'reference'};
  const store = fixture(t, [old]);
  const [original] = sourceHistory(store.db, old.file);
  store.db.prepare('UPDATE archive_indexes SET format=2 WHERE sha=?').run(sha);
  const permission = sourcePermission(store.db, sha, archive, 'original.zip');
  const nested = {...old, file:'reference/guide.pdf'};
  assert.equal(importApproved(store, [nested], permission, false).inserted, 0);
  assert.deepEqual(protectedSources(store.db).filter(row => row.role === 'reference').map(row => [row.file, row.version]),
    [[old.file, original.version]]);
  assert.deepEqual(sourceHistory(store.db, old.file), [original]);
  assert.equal(sourcePermission(store.db, sha, archive, 'original.zip').alreadyImported, true);
});

test('an ambiguous flattened reference does not claim either archive path with the same basename', t => {
  const old = {file:'guide.pdf', facts:[], role:'reference'};
  const store = fixture(t, [old]);
  const [original] = sourceHistory(store.db, old.file);
  store.db.prepare('UPDATE archive_indexes SET format=2 WHERE sha=?').run(sha);
  const docs = [{...old, file:'a/guide.pdf'}, {...old, file:'b/guide.pdf'}];
  assert.equal(importApproved(store, docs, sourcePermission(store.db, sha, archive, 'original.zip'), false).inserted, 2);
  const inventory = protectedSources(store.db).filter(row => row.role === 'reference');
  assert.deepEqual(inventory.map(row => row.file), ['a/guide.pdf', 'b/guide.pdf', 'guide.pdf']);
  assert.equal(inventory.find(row => row.file === old.file).version, original.version);
  assert.equal(new Set(inventory.map(row => row.version)).size, 3);
});
const report = (file, keys) => ({ file, facts: keys.map((metric_id, i) => ({
  kind: 'metrics', loc: 'Метрики!A' + (i + 2), row: { metric_id, date:'2026-06-01', product:'Astra', segment:'all', value:i },
})) });

function fixture(t, docs = [report(first, ['visits']), report(second, ['cart'])]) {
  const store = openStore(':memory:', { seedDemo: false });
  initEvidence(store.db);
  initSourcePolicy(store.db);
  t.after(() => store.close());
  const permission = sourcePermission(store.db, sha, archive, 'original.zip');
  importApproved(store, docs, permission, false);
  return store;
}

test('approved source cannot replace another source’s records or drop records from the current version', t => {
  const store = fixture(t);
  const current = protectedSources(store.db).find(row => row.file === second);
  const snapshot = () => store.db.prepare('SELECT * FROM facts ORDER BY kind,key').all();
  const before = snapshot();
  for (const [tag, keys, error] of [
    ['collision', ['cart', 'visits'], /другому источнику/],
    ['omission', ['retention'], /пропускает записи/],
    ['duplicate', ['cart', 'cart'], /повторяется/],
  ]) {
    const input = Buffer.from(tag);
    approveSource(store, {sha:digest(input), file:second, origin:'Approved by the organizer', previous:current.version}, 'Admin', sha);
    const permission = sourcePermission(store.db, sha, input, second);
    const doc=report(second,keys);
    // main identifies metric series by source. Claim the same series to exercise an actual collision.
    if(tag==='collision') doc.facts.at(-1).row.source_id='office:'+first;
    assert.throws(() => importApproved(store, [doc], permission, false), error);
    assert.deepEqual(snapshot(), before);
    assert.equal(sourceHistory(store.db, second).length, 1);
  }
});

test('raw archive and reviewed revision replays cannot change the current source', t => {
  const store = fixture(t);
  const upload = (name, input, docs) => importApproved(store, docs, sourcePermission(store.db, sha, input, name), false);
  const old = sourceHistory(store.db, first)[0];
  const previous = old.version;
  const revised = Buffer.from('reviewed snapshot fixture');
  approveSource(store, {sha:digest(revised), file:first, origin:'Updated list', previous}, 'Admin', sha);
  assert.equal(upload(first, revised, [report(first, ['visits', 'conversion'])]).inserted, 1);
  const [head, baseline] = sourceHistory(store.db, first);
  assert.deepEqual(baseline, {...old, active:false});
  assert.equal(head.author, 'Admin');
  assert.equal(head.active, true);
  assert.equal(upload('original.zip', archive, []).inserted, 0);
  assert.equal(upload(first, revised, []).inserted, 0);
  assert.equal(sourceHistory(store.db, first)[0].version, head.version);
  assert.throws(() => upload(first, archive, []), /согласованную администратором/);
});

test('reindexing an original archive preserves superseding revisions, old links, and interview row boundaries', async t => {
  const store = fixture(t);
  const previous = sourceHistory(store.db, first)[0].version;
  const changed = Buffer.from('revised finance');
  approveSource(store, {sha:digest(changed),file:first,origin:'Finance',previous},'PM',sha);
  importApproved(store,[report(first,['visits','payers'])],sourcePermission(store.db,sha,changed,first),false);
  const file = 'Research.xlsx';
  const notes = (details) => ({file, facts:details.map(([loc,field,answer]) => ({
    kind:'interview',loc,text:'Тема: оплата',detail:{field,answer},
  }))});
  const old = {file,facts:[{kind:'interview',loc:'Pilot!D3',text:'Тема: оплата'}]};
  // Simulate a workspace whose original version used the earlier importer.
  store.db.prepare('DELETE FROM archive_indexes WHERE sha=?').run(sha);
  const oldVersion=digest(JSON.stringify(old));
  store.db.prepare('INSERT INTO documents VALUES(?,?,?,?)').run(oldVersion,file,0,JSON.stringify(old));
  store.db.prepare('INSERT INTO source_revisions VALUES(?,?,?,?,?,?)').run(oldVersion,file,sha,'Archive',null,null);
  const current=notes([['Pilot!C3','Модель','LumenValve'],['Pilot!D3','Причина покупки','Нужна гарантия'],
    ['Pilot!C4','Модель','Triton'],['Pilot!D4','Причина покупки','Срочный заказ без гарантии']]);
  const refresh=sourcePermission(store.db,sha,archive,'archive.zip');
  assert.equal(refresh.refresh,true);
  assert.equal(importApproved(store,[report(first,['visits']),current],refresh,false).inserted,1);
  assert.equal(sourceHistory(store.db,first)[0].origin,'Finance');
  assert.equal(sourceRows(store.db,oldVersion,0,'Pilot!D3').rows[0].value,'Тема: оплата');
  const evidence=archiveEvidence(store.db,'Как клиент выбирал LumenValve?');
  assert.match(evidence[0].text,/Нужна гарантия/);
  assert.doesNotMatch(evidence[0].text,/Triton/);
  assert.ok(evidence[0].refs.every(r=>r.loc.endsWith('3')));
  const offline=await archiveAnswer(store,'LumenValve?',evidence,{LLM_DATA_MODE:'selection'},()=>assert.fail(), 'job');
  assert.equal(offline.readSources.length,2);
  const rendered=await archiveAnswer(store,'LumenValve?',evidence,{
    LLM_DATA_MODE:'analysis',LLM_BASE_URL:'http://localhost',LLM_MODEL:'fixture'
  },()=>assert.fail('Do not rewrite a respondent’s account'), 'job');
  assert.equal(rendered.outcome,'done');
  assert.match(rendered.text,/Причина покупки — Нужна гарантия/);
  assert.equal(importApproved(store,[current],refresh,false).inserted,0);
});

test('a long research digest cannot displace a focused record with the same matching words', t => {
  const store = openStore(':memory:', {seedDemo:false});
  t.after(() => store.close());
  initEvidence(store.db);
  initSourcePolicy(store.db);
  const subject = 'маяк калибровка';
  const unrelated = Array.from({length:150}, (_,i) => 'sensor'+i).join(' ');
  const doc = {file:'Workshop.xlsx',facts:[
    {kind:'interview',loc:'Notes!C3',text:'Survey',detail:{field:'Обзор',answer:subject+' '+unrelated}},
    {kind:'dictionary',loc:'Units!A2',row:{metric_id:'lab',metric_name:'Сигнал',formula_or_logic:subject}},
  ]};
  importApproved(store,[doc],sourcePermission(store.db,sha,archive,'archive.zip'),false);
  const rows=archiveEvidence(store.db,'Что известно про маяк и калибровку?');
  assert.equal(rows[0].refs[0].loc,'Units!A2');
  assert.ok(rows.every(row => !row.text.includes('sensor')));
});

test('archive task identifiers come from both sides of the relationship and survive rendering', async t => {
  const store=openStore(':memory:',{seedDemo:false});
  t.after(()=>store.close());
  initEvidence(store.db);
  initSourcePolicy(store.db);
  const facts=[
    {kind:'releases',loc:'Calendar!A2',row:{release_id:'SHIP-41',release_date:'2026-03-03',description:'Калибровка спектрометра',related_task_ids:'LAB-813'}},
    {kind:'backlog',loc:'Plan!A2',row:{task_id:'LAB-813',title:'Калибровка спектрометра'}},
    {kind:'backlog',loc:'Plan!A3',row:{task_id:'LAB-205',title:'Сверка эталона',release_id:'SHIP-41, SHIP-92'}},
    {kind:'releases',loc:'Calendar!A3',row:{release_id:'SHIP-92',release_date:'2026-05-12',description:'Очередь заявок'}},
    {kind:'releases',loc:'Calendar!A4',row:{release_id:'SHIP-33',release_date:'2026-03-04',description:'Освещение',related_task_ids:'нет данных'}},
  ];
  importApproved(store,[{file:'Lab.xlsx',facts}],sourcePermission(store.db,sha,archive,'archive.zip'),false);
  const q='Какие задачи стояли за калибровкой спектрометра?';
  const evidence=archiveEvidence(store.db,q);
  const reply=await archiveAnswer(store,q,evidence,{LLM_DATA_MODE:'analysis',LLM_BASE_URL:'http://localhost',LLM_MODEL:'fixture'},
    ()=>assert.fail('The exact identifiers and titles are already available'),'test-job');
  assert.match(reply.text,/LAB-813 — Калибровка спектрометра/);
  assert.match(reply.text,/LAB-205 — Сверка эталона/);
  assert.doesNotMatch(reply.text,/SHIP-92/);
  assert.deepEqual(reply.readSources.map(s=>s.label.split(' · ')[1]).sort(),['Calendar!A2','Plan!A2','Plan!A3']);
  assert.match(archiveEvidence(store.db,'Укажи номер задачи релиза SHIP-33').map(x=>x.text).join(' '),/не подтверждена/);
  const contextual=archiveEvidence(store.db,'Назови номер задачи',{releaseId:'SHIP-92'});
  assert.match(contextual.map(x=>x.text).join(' '),/LAB-205/);
  assert.doesNotMatch(contextual.map(x=>x.text).join(' '),/LAB-813|SHIP-41/);
  assert.deepEqual(archiveEvidence(store.db,'Какая задача у SHIP-999?'),[]);
});

test('dates and affected metric both constrain calendar evidence in a measurement answer', t => {
  const store=openStore(':memory:',{seedDemo:false});
  t.after(()=>store.close());
  initEvidence(store.db);
  initSourcePolicy(store.db);
  const facts=[
    {kind:'dictionary',loc:'Metric!A2',row:{metric_id:'echo',metric_name:'Эхосигналы'}},
    {kind:'metrics',loc:'Readings!A2',row:{date:'2026-03-04',metric_id:'echo',segment:'desktop',value:25,unit:'импульсов'}},
    ...[
      ['EXP-21','2026-03-04','echo','Смена режима'],
      ['EXP-31','2026-03-04','echo_noise','Эхосигналы на стенде'],
      ['EXP-42','2026-03-05','echo','Эхосигналы'],
    ].map(([release_id,release_date,affected_metrics,description],i)=>({kind:'releases',loc:'Calendar!A'+(i+2),row:{release_id,release_date,affected_metrics,description}})),
  ];
  importApproved(store,[{file:'Lab.xlsx',facts}],sourcePermission(store.db,sha,archive,'archive.zip'),false);
  const q='Эхосигналы за 2026-03-04 с компьютеров';
  const evidence=archiveEvidence(store.db,q+' — каким релизом можно объяснить изменение?');
  const answer=evidence.map(x=>x.text).join(' ');
  assert.match(answer,/25 импульсов/);
  assert.match(answer,/EXP-21/);
  assert.doesNotMatch(answer,/EXP-31|EXP-42/);
  assert.deepEqual(evidence.flatMap(e=>e.refs).filter(s=>s.loc.startsWith('Calendar')).map(s=>s.loc),['Calendar!A2']);
  assert.ok(archiveEvidence(store.db,q+'?').every(e=>e.refs.every(s=>!s.loc.startsWith('Calendar'))));
});

test('archive answers fall back to the retrieved source on timeout or an invented number', async t => {
  const store = fixture(t);
  initWorkbench(store.db);
  const evidence=[{text:'Инвентаризация: 72 прибора.',refs:[{file:'Assets.xlsx',version:'one',loc:'Stock!C5'}]}];
  const env={LLM_DATA_MODE:'analysis',LLM_BASE_URL:'http://127.0.0.1:9999',LLM_MODEL:'fixture'};
  const series=[{...evidence[0],kind:'measurement'},{...evidence[0],kind:'measurement',text:'Следующий замер: 43 прибора.'}];
  const measured=await archiveAnswer(store,'Как менялось число приборов?',series,env,()=>assert.fail('Preserve both observations'),'fixture');
  assert.match(measured.text,/72 прибора[\s\S]*43 прибора/);
  for (const reply of [null,'На складе 450 приборов.']) {
    const result=await archiveAnswer(store,'Сколько приборов?',evidence,env,async (_url,opts)=>{
      const req=JSON.parse(opts.body);
      assert.equal(req.tools,undefined);
      assert.match(req.messages.at(-1).content,/72 прибора/);
      assert.ok(opts.signal instanceof AbortSignal);
      if (!reply) throw new DOMException('deadline','TimeoutError');
      return Response.json({choices:[{message:{content:reply}}]});
    },'fixture');
    assert.match(result.text,/72 прибора/);
    assert.doesNotMatch(result.text,/450/);
    assert.equal(result.outcome,'partial');
    assert.equal(result.readSources[0].label,'Assets.xlsx · Stock!C5');
  }
});

test('an archive explanation uses the model and cites the rows behind its hypothesis', async t => {
  const store = fixture(t);
  initWorkbench(store.db);
  const source = {file:'Assets.xlsx',version:'a'.repeat(64),loc:'Stock!C5'};
  const evidence = [{kind:'measurement',text:'Зарегистрировано 72 прибора.',refs:[source]}];
  const env = {LLM_DATA_MODE:'analysis',LLM_BASE_URL:'http://127.0.0.1:9999',LLM_MODEL:'fixture'};
  const explanation = await archiveAnswer(store,'Почему изменилось число приборов?',evidence,env,async (_url,{body})=>{
    const context = JSON.parse(JSON.parse(body).messages.at(-1).content);
    const sources = [context.evidence[0].id];
    const report = {observations:[{text:'Зарегистрировано 72 прибора.',sources}],
      hypotheses:[{text:'Мог измениться порядок регистрации.',test:'Сопоставить журналы регистрации на обе даты.',sources}],
      recommendations:[],missing:['Нужен журнал регистрации.']};
    return Response.json({choices:[{message:{content:JSON.stringify(report)}}]});
  },'fixture');
  assert.match(explanation.text,/Гипотезы[\s\S]*порядок регистрации[\s\S]*Сопоставить журналы/);
  assert.equal(explanation.readSources[0].url,'#knowledge-source/'+source.version+'/Stock!C5');
  const offline = await archiveAnswer(store,'Почему изменилось число приборов?',evidence,{},()=>assert.fail('No model'), 'fixture');
  assert.match(offline.text,/Модель[\s\S]*72 прибора/);
  assert.doesNotMatch(offline.text,/порядок регистрации/);
});
