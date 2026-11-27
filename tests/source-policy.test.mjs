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
const report = (file, keys) => ({ file, facts: keys.map((metric_id, i) => ({
  kind: 'metrics', loc: 'Метрики!A' + (i + 2), row: { metric_id, date:'2026-06-01', product:'Astra', segment:'all', value:i },
})) });

function fixture(t) {
  const store = openStore(':memory:', { seedDemo: false });
  initEvidence(store.db);
  initSourcePolicy(store.db);
  t.after(() => store.close());
  const permission = sourcePermission(store.db, sha, archive, 'original.zip');
  importApproved(store, [report(first, ['visits']), report(second, ['cart'])], permission, false);
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
    assert.throws(() => importApproved(store, [report(second, keys)], permission, false), error);
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

test('archive answers fall back to the retrieved source on timeout or an invented number', async t => {
  const store = fixture(t);
  initWorkbench(store.db);
  const evidence=[{text:'Инвентаризация: 72 прибора.',refs:[{file:'Assets.xlsx',version:'one',loc:'Stock!C5'}]}];
  const env={LLM_DATA_MODE:'analysis',LLM_BASE_URL:'http://127.0.0.1:9999',LLM_MODEL:'fixture'};
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
