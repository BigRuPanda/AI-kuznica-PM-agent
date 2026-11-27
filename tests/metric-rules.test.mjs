import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { digest, initEvidence, importDocs, scan, setSetting, setting } from '../server/evidence.mjs';
import { getMetricEpisodes, metricRuleStatus, saveMetricRule } from '../server/metric-rules.mjs';
import { deliver, initWorkbench } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { grant } from '../server/chart-ranges.mjs';

const DAY = 86400000;
const date = n => new Date(Date.UTC(2025, 0, 6) + n * DAY).toISOString().slice(0,10);
const ctr = 'lk_reco_ctr';
const completion = 'cfg_completion_rate';
function weeklyCounts(metric, week, n, d=100, sourceId='demo') {
  const product = metric === ctr ? 'ЛК' : 'Конфигуратор Астра';
  const daily = metric === completion;
  return Array.from({length:daily ? 7 : 1}, (_,i) => ({
    kind:'metrics', loc:metric + '-' + week + '-' + i,
    row:{date:date(week*7+i),product,segment:'desktop',source_id:sourceId,step_days:daily ? 1 : 7,
      metric_id:metric,unit:'ratio',value:n/d,numerator:n,denominator:d},
  }));
}
const release = (metric, week=4) => ({kind:'releases',loc:'R'+week,
  row:{release_id:'R'+week,release_date:date(week*7),affected_metrics:metric}});
function fixture(t, records) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  initEvidence(store.db);
  importDocs(store,[{file:'пример.xlsx',facts:records}],{notify:false});
  return store;
}
const ruleStatus = (db, metric, asOf) => metricRuleStatus(db, asOf).rules.find(r => r.config.metric === metric);

test('CTR uses weighted pre-release baseline, strict threshold and consecutive complete weeks', t => {
  const metric = ctr;
  const store = fixture(t,[release(metric),
    ...[10,20,10,20].flatMap((n,i)=>weeklyCounts(metric,i,n,i%2 ? 200 : 100)),
    ...[7,5,3,10,2].flatMap((n,i)=>weeklyCounts(metric,i+4,n)),
  ]);
  const episodes = getMetricEpisodes(store.db,date(62));
  assert.equal(episodes.length,2);
  const [first, second] = episodes;
  assert.equal(first.baseN,60);
  assert.equal(first.baseD,600);
  assert.equal(first.start,date(35));
  assert.equal(first.week,date(42));
  assert.equal(first.confirmedWeek,date(42));
  assert.equal(first.change,-70);
  assert.equal(first.count,2);
  assert.equal(second.confirmedWeek,undefined);
  assert.equal(ruleStatus(store.db,metric,date(55)).status,'ok');
  assert.equal(ruleStatus(store.db,metric,date(61)).status,'insufficient');
  assert.equal(ruleStatus(store.db,metric,date(62)).status,'preliminary');
  saveMetricRule(store.db,{metric, enabled:false});
  assert.deepEqual(getMetricEpisodes(store.db),[]);
});

test('Astra uses percentage points, seven measured days, minimum sample and no synthetic zeros', t => {
  const store = fixture(t,[release(completion),
    ...[80,80,80,80,75,74,60,73,70,2].flatMap((n,i) => weeklyCounts(completion,i,n, i===9 ? 3 : 100)
      .filter((_,j) => i!==6 || j!==3)),
  ]);
  const [first, second] = getMetricEpisodes(store.db,date(69));
  assert.equal(first.start,date(35));
  assert.equal(first.confirmedWeek,undefined);
  assert.equal(second.confirmedWeek,date(56));
  assert.equal(second.change,-10);
  assert.equal(second.changeUnit,'п.п.');
  assert.match(ruleStatus(store.db,completion,date(48)).detail,/Неполное покрытие/);
  assert.match(ruleStatus(store.db,completion,date(69)).detail,/Малый знаменатель/);
});

test('a late correction, an ambiguous source, and a second release do not silently mix data', t => {
  const store = fixture(t,[release(ctr),...[10,10,10,10,4,3,10,10].flatMap((n,i)=>weeklyCounts(ctr,i,n))]);
  const before=getMetricEpisodes(store.db)[0];
  assert.equal(before.confirmedWeek,date(35));
  importDocs(store,[{file:'ещё один релиз.xlsx',facts:[release(ctr,8)]}],{notify:false});
  assert.equal(getMetricEpisodes(store.db)[0].confirmedWeek,date(35));
  importDocs(store,[{file:'исправление.xlsx',facts:weeklyCounts(ctr,5,10)}],{notify:false});
  assert.equal(getMetricEpisodes(store.db)[0].confirmedWeek,undefined);
  importDocs(store,[{file:'другой счётчик.xlsx',facts:weeklyCounts(ctr,3,10,100,'счётчик2')}],{notify:false});
  saveMetricRule(store.db,{metric:ctr,releaseId:'R4'});
  assert.match(ruleStatus(store.db,ctr).detail,/источник/);
  saveMetricRule(store.db,{metric:ctr,sourceId:'demo',confirmations:1});
  assert.equal(getMetricEpisodes(store.db)[0].confirmedWeek,date(28));
});

test('unavailable release, baseline too small and partial data are visible to the administrator', t => {
  const store=fixture(t,[...weeklyCounts(ctr,3,1)]);
  assert.match(ruleStatus(store.db,ctr).detail,/релиз/);
  importDocs(store,[{file:'релиз.xlsx',facts:[release(ctr),...[1,1,1].flatMap((n,i)=>weeklyCounts(ctr,i,n))]}]);
  assert.match(ruleStatus(store.db,ctr).detail,/недостаточно целевых событий/);
  assert.throws(()=>saveMetricRule(store.db,{metric:ctr,threshold:-1}),/порог/);
  assert.throws(()=>saveMetricRule(store.db,{metric:ctr,releaseId:'несуществующий'}),/релиз/);
  saveMetricRule(store.db,{metric:ctr,minBaselineNumerator:1});
  const partial=weeklyCounts(ctr,4,1);
  partial[0].row.comment='Неполная неделя';
  importDocs(store,[{file:'текущее.xlsx',facts:partial}]);
  assert.match(ruleStatus(store.db,ctr).detail,/Неполное покрытие/);
});

test('weekly metric import opens a case, queues one notice per channel, and cancels on a correction', t => {
  const s=fixture(t,[release(ctr),...[10,10,10,10].flatMap((n,i)=>weeklyCounts(ctr,i,n))]);
  const load = (week,n) => importDocs(s,[{file:'пример.xlsx',facts:weeklyCounts(ctr,week,n)}]);
  const readCase = () => s.db.prepare("SELECT id,json_extract(body,'$.signal.status') status FROM cases").all();
  const notices = () => s.db.prepare('SELECT channel,state FROM deliveries ORDER BY channel').all().map(row=>[row.channel,row.state]);
  load(4,4);
  assert.equal(readCase()[0].status,'provisional');
  assert.deepEqual(notices(),[]);
  const previousId=readCase()[0].id;
  load(5,2);
  load(5,2);
  assert.deepEqual(readCase().map(({id,status})=>[id,status]),[[previousId,'confirmed']]);
  assert.deepEqual(notices(),[['smtp','queued'],['telegram','queued']]);
  load(4,10);
  assert.ok(readCase().some(({status})=> status==='provisional'));
  assert.deepEqual(notices(),[['smtp','cancelled'],['telegram','cancelled']]);
});

test('product rule settings preserve sales settings and a new source starts a separate series', t => {
  const store = fixture(t,[release(ctr),...[10,10,10,10,4,3].flatMap((n,i)=>weeklyCounts(ctr,i,n)),
    ...[20,20,20,20,10,12].flatMap((n,i)=>weeklyCounts(ctr,i,n,200,'second'))]);
  const rules = {threshold:42,controlTolerance:9,recovery:88};
  setSetting(store.db,'rules',rules);
  setSetting(store.db,'metric_signal_rules',{[ctr]:{threshold:32},[completion]:{enabled:false}});
  assert.match(ruleStatus(store.db,ctr).detail,/источник/);
  saveMetricRule(store.db,{metric:ctr,sourceId:'demo'});
  const first = getMetricEpisodes(store.db)[0];
  assert.equal(first.threshold,32);
  assert.equal(first.baseD,400);
  assert.equal(first.definitionId,'office');
  scan(store.db,false);
  saveMetricRule(store.db,{metric:ctr,sourceId:'second'});
  const second = getMetricEpisodes(store.db)[0];
  assert.equal(second.baseD,800);
  assert.equal(second.sourceId,'second');
  assert.notEqual(second.seriesKey,first.seriesKey);
  assert.equal(ruleStatus(store.db,completion).status,'disabled');
  assert.deepEqual(setting(store.db,'rules'),rules);
});

test('changing the membership of a grouped source invalidates comparison to its baseline', t => {
  const group = (week, n, members) => members.flatMap(counter => weeklyCounts(ctr,week,n,100,'metrika:'+counter+':'+ctr)
    .map(f => ({...f,row:{...f.row,counter_id:counter,combine_group:'group:'+ctr,combine_members:members,definition_id:'same'}})));
  const store = fixture(t,[release(ctr),...[10,10,10,10].flatMap((n,i)=>group(i,n,['1','2'])),
    ...group(4,2,['1','3']), ...group(5,3,['1','3'])]);
  saveMetricRule(store.db,{metric:ctr,sourceId:'group:'+ctr});
  assert.match(ruleStatus(store.db,ctr,date(41)).detail,/состав счётчиков отличаются от базы/);
  assert.deepEqual(getMetricEpisodes(store.db,date(41)),[]);
});

test('first CTR episode exposes its measured sources and delivers one actionable mail after confirmation', async t => {
  const store = fixture(t,[release(ctr), ...[10,10,10,10].flatMap((n,i)=>weeklyCounts(ctr,i,n,100,'metrika:1:'+ctr))]);
  initWorkbench(store.db);
  const user = {id:'member', role:'member', space:'team'};
  const env = {NOTIFICATIONS_ENABLED:'true',APP_BASE_URL:'http://127.0.0.1:8090',SMTP_HOST:'fixture.test',SMTP_TO:'product@example.test'};
  const messages = [];
  const sendUnexpected = () => assert.fail('Unexpected network request');
  const flush = () => deliver(store,env,sendUnexpected,async (text,{SMTP_TO}) => messages.push({text,to:SMTP_TO}));
  const load = (week,n,d=100) => importDocs(store,[{file:'пример.xlsx',facts:weeklyCounts(ctr,week,n,d,'metrika:1:'+ctr)}]);
  load(4,3,99);
  assert.equal(store.db.prepare('SELECT count(*) n FROM cases').get().n,0);
  load(5,4);
  const {id} = store.db.prepare('SELECT id FROM cases').get();
  const first = workspaceOperation(store,user,'view',{caseId:id});
  assert.equal(first.case.body.signal.status,'provisional');
  const {signal} = workspaceOperation(store,user,'calc',{id:first.view.id});
  assert.deepEqual([signal.baseN,signal.baseD,signal.n,signal.d],[40,400,4,100]);
  const [row] = signal.evidence.latest.rows;
  assert.deepEqual([row.date,row.n,row.d,row.sourceId],[date(35),4,100,'metrika:1:'+ctr]);
  assert.ok(row.source.includes('пример.xlsx') && row.version.length === 64);
  await flush();
  assert.deepEqual(messages,[]);
  load(6,3);
  await flush();
  await flush();
  load(7,2);
  load(7,2);
  await flush();
  assert.deepEqual(messages.map(m=>m.to),['product@example.test']);
  assert.match(messages[0].text,new RegExp('/#case/'+id+'$'));
  assert.equal(workspaceOperation(store,user,'view',{caseId:id}).case.body.signal.status,'confirmed');
  assert.equal(workspaceOperation(store,user,'calc',{id:first.view.id}).signal.week,date(35));
});

test('an upgraded case links its exact archived signal rows after an unchanged import', t => {
  const folder = mkdtempSync(join(tmpdir(),'signal-evidence-upgrade-'));
  const path = join(folder,'workspace.sqlite');
  const user = {id:'member',role:'member',space:'team'};
  const file = 'Отчёт.xlsx';
  const doc = {file, facts:[
    release(ctr),
    {kind:'dictionary',loc:'Metrics!A2',row:{metric_id:'unrelated'}},
    ...[10,10,10,10,4,2].flatMap((n,i) => weeklyCounts(ctr,i,n)
      .map(f => ({...f,loc:'Metrics!A'+(i+2)}))),
  ]};
  const open = () => {
    const store = openStore(path,{seedDemo:false});
    initEvidence(store.db);
    initWorkbench(store.db);
    return store;
  };

  let store = open();
  t.after(() => {
    store.close();
    rmSync(folder,{recursive:true,force:true});
  });
  importDocs(store,[doc],{notify:false});
  const {id:caseId,body} = store.db.prepare('SELECT id,body FROM cases').get();
  const {id:initialId,...initialView} = workspaceOperation(store,user,'view',{caseId}).view;
  const legacyCase = JSON.parse(body);
  for (const sample of [...legacyCase.signal.evidence.baseline,legacyCase.signal.evidence.latest]) {
    for (const row of sample.rows) {
      delete row.file;
      delete row.loc;
    }
  }
  const caseBody = JSON.stringify(legacyCase);
  const snapshotBody = JSON.stringify({...initialView,signal:legacyCase.signal});
  const snapshotId = digest(snapshotBody);
  importDocs(store,[{file,facts:weeklyCounts(ctr,5,6).map(f => ({...f,loc:'Metrics!C9'}))}],{notify:false});
  store.db.prepare('UPDATE cases SET body=? WHERE id=?').run(caseBody,caseId);
  store.db.prepare('UPDATE evidence_calcs SET id=?,body=? WHERE id=?').run(snapshotId,snapshotBody,initialId);
  grant(store.db,snapshotId,'user',user.id);
  store.close();

  store = open();
  assert.equal(importDocs(store,[doc],{notify:false}).inserted,0);
  assert.equal(store.db.prepare("SELECT loc FROM facts WHERE kind='metrics' AND json_extract(body,'$.date')=?")
    .get(date(35)).loc,'Metrics!C9');
  const current = workspaceOperation(store,user,'view',{caseId});
  const saved = workspaceOperation(store,user,'calc',{id:current.view.id});
  const legacyLatest = legacyCase.signal.evidence.latest.rows[0];
  const resolvedLatest = {...legacyLatest,file,loc:'Metrics!A7'};
  for (const signal of [current.case.body.signal,current.view.signal,saved.signal]) {
    assert.deepEqual(signal.evidence.latest.rows,[resolvedLatest]);
    const [ambiguous,unique] = signal.evidence.baseline;
    assert.deepEqual(ambiguous.rows,legacyCase.signal.evidence.baseline[0].rows);
    assert.equal(unique.rows[0].loc,'Metrics!A3');
  }
  const {rows:[archived]} = workspaceOperation(store,user,'knowledge-source',
    {version:resolvedLatest.version,loc:resolvedLatest.loc});
  assert.deepEqual([archived.loc,archived.value.numerator],['Metrics!A7',2]);
  assert.notEqual(current.view.id,snapshotId);
  assert.equal(store.db.prepare('SELECT body FROM cases WHERE id=?').get(caseId).body,caseBody);
  assert.deepEqual(workspaceOperation(store,user,'calc',{id:snapshotId}).signal,legacyCase.signal);
  assert.equal(store.db.prepare('SELECT body FROM evidence_calcs WHERE id=?').get(snapshotId).body,snapshotBody);
});
