import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../server/store.mjs';
import { metrika } from '../server/connectors.mjs';
import { facts, importDocs, initEvidence } from '../server/evidence.mjs';
import { aggregateMetric, normalizeObservation } from '../server/metric-observations.mjs';
import { createThread, initWorkbench } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { grant } from '../server/chart-ranges.mjs';

const user = { id: 'tester', name: 'PM', role: 'admin' };
const date = '2026-11-02';
const nextDate = '2026-11-03';
const day = 86400000;
const report = { id: 'lk_reco_ctr', numerator: 'click', denominator: 'seen', product: 'ЛК',
  unit: 'ratio', disjointCounters: ['101','202'] };
const env = (map = report) => ({ METRIKA_COUNTER_IDS: '101,202', METRIKA_TOKEN: 'test', METRIKA_REPORTS_JSON: JSON.stringify([map]) });

function api(counter) {
  const values = counter === '101' ? [1, 10] : [10, 50];
  return [{ dimensions: [{ name: date }], metrics: values }];
}
function mem(t) {
  const s = openStore(':memory:');
  initEvidence(s.db); initWorkbench(s.db);
  t.after(() => s.close());
  return s;
}

test('two counters, weighted bases, explicit nonoverlap and separate Excel scope', async t => {
  const s = mem(t);
  const respond = async url => {
    const params = new URL(url).searchParams;
    assert.equal(params.get('metrics'), 'click,seen');
    return Response.json({ data: api(params.get('ids')), total_rows: 1 });
  };
  const ungrouped = await metrika(env({...report, disjointCounters:undefined}), respond);
  importDocs(s,ungrouped.docs);
  assert.equal(workspaceOperation(s,user,'metrics',{}).metrics.length,2);
  assert.ok(workspaceOperation(s,user,'metrics',{}).metrics.every(c => c.sourceId.startsWith('metrika:')));
  const {docs} = await metrika(env(), respond);
  assert.equal(importDocs(s,docs).inserted,1);
  assert.equal(importDocs(s,docs).inserted,0);
  const observations = () => facts(s.db,'metrics').map(f => f.data);
  assert.equal(observations().length,2);
  const ambiguous = aggregateMetric(observations(),report.id);
  assert.match(ambiguous.reason, /Выберите.*metrika:101.*metrika:202/);
  assert.deepEqual(ambiguous.choices.map(c => c.sourceId).sort(), ['group:lk_reco_ctr','metrika:101:lk_reco_ctr','metrika:202:lk_reco_ctr']);
  const group = aggregateMetric(observations(),report.id,{sourceId:'group:lk_reco_ctr'});
  assert.deepEqual([group.n,group.d,group.value], [11,60,1100/60]);
  assert.ok(aggregateMetric(observations().slice(1),report.id,{sourceId:'group:lk_reco_ctr'}).reason);
  const explicit = workspaceOperation(s,user,'chart',{metric:report.id,sourceId:'group:lk_reco_ctr'});
  assert.equal(workspaceOperation(s,user,'calc',{id:explicit.id}).points[0].denominator,60);
  assert.equal(workspaceOperation(s,user,'calc',{id:explicit.id}).step,86400000);
  assert.throws(() => workspaceOperation(s,user,'chart',{metric:report.id}),/Уточните ряд/);
  const office = {metric_id:report.id,product:'ЛК',segment:'all',date,unit:'ratio',value:0.1,
    detail_json:JSON.stringify({click_visits:1,viewed_visits:10})};
  importDocs(s,[{file:'Результаты.xlsx',facts:[{kind:'metrics',loc:'A1',row:office}]}]);
  assert.equal(observations().length,3);
  const sourceId = 'office:Результаты.xlsx';
  assert.equal(aggregateMetric(observations(), report.id, {sourceId,from:date,through:'2026-11-03'}).value,null);
  assert.equal(aggregateMetric(observations(), report.id, {sourceId,from:date,through:'2026-11-08'}).value,10);
  assert.equal(aggregateMetric(observations(),report.id,{sourceId:'metrika:202:lk_reco_ctr',from:date,through:date}).value,20);
  const sources = workspaceOperation(s,user,'metrics',{}).metrics;
  assert.deepEqual(sources.map(c => [c.sourceId, c.stepDays]), [
    ['group:lk_reco_ctr',1], ['metrika:101:lk_reco_ctr',1], ['metrika:202:lk_reco_ctr',1], [sourceId,7],
  ]);
  const unselected = workspaceOperation(s,user,'view',{product:'ЛК',from:date,through:date}).view.ctr;
  assert.equal(unselected.n,null);
  assert.equal(unselected.choices.length,3);
  const chosen = workspaceOperation(s,user,'view',{product:'ЛК',from:date,through:date,
    ratioSelections:{ctr:sources[0]}}).view.ctr;
  assert.deepEqual([chosen.n,chosen.d,chosen.sources.length], [11,60,2]);
});

test('legacy documents restore overwritten counters while keeping saved snapshots and keys stable on resync', async t => {
  const s = mem(t);
  const map = {id:'visits',metric:'visits',unit:'visits',product:'Store'};
  const {docs} = await metrika(env(map), async url=>Response.json({
    data:[{dimensions:[{name:date}],metrics:[new URL(url).searchParams.get('ids')==='101'?10:30]}],total_rows:1
  }));
  const legacy = {file:docs[0].file,facts:docs[0].facts.map(({loc,kind,row}) => {
    const {metric_id,segment,date,product,value,unit,sample_size,detail_json,comment}=row;
    return {kind,loc,row:{metric_id,segment,date,product,value,unit,sample_size,detail_json,comment}};
  })};
  const snap = '{"id":"old","period":"frozen"}';
  s.db.prepare("INSERT INTO evidence_calcs VALUES('old',?)").run(snap);
  grant(s.db,'old','user',user.id);
  s.db.prepare("INSERT INTO documents VALUES('v1',?,0,?)").run(legacy.file,JSON.stringify(legacy));
  const last=legacy.facts[1];
  s.db.prepare("INSERT INTO facts VALUES('metrics','legacy-key','v1',?,?,?)").run(legacy.file,last.loc,JSON.stringify(last.row));
  s.db.prepare("DELETE FROM settings WHERE key='observation_schema_v2'").run();
  initEvidence(s.db);
  assert.equal(facts(s.db,'metrics').length,2);
  importDocs(s,docs);initEvidence(s.db);
  assert.equal(facts(s.db,'metrics').length,2);
  assert.equal(s.one("SELECT body FROM evidence_calcs WHERE id='old'").body,snap);
  assert.deepEqual(workspaceOperation(s,user,'calc',{id:'old'}),JSON.parse(snap));
});

test('same source can hold distinct daily and weekly report definitions', async t => {
  const s = mem(t);
  const daily = {...report, disjointCounters:undefined};
  const weekly = {...daily, dimensions:'ym:s:startOfWeek'};
  const both = {...env(), METRIKA_COUNTER_IDS:'101', METRIKA_REPORTS_JSON:JSON.stringify([daily,weekly])};
  const {docs} = await metrika(both, async url => {
    const dimensions = new URL(url).searchParams.get('dimensions');
    return Response.json({data:[{dimensions:[{name:date}],metrics:dimensions === weekly.dimensions ? [6,15] : [1,10]}],total_rows:1});
  });
  importDocs(s,docs);
  const catalog = workspaceOperation(s,user,'metrics',{}).metrics;
  assert.equal(catalog.length,2);
  const sourceId = catalog[0].sourceId;
  assert.equal(catalog[1].sourceId,sourceId);
  assert.throws(() => workspaceOperation(s,user,'chart',{metric:report.id,sourceId}),/Уточните ряд.*(?:день.*неделя|неделя.*день)/);
  const week = catalog.find(c => c.stepDays === 7);
  assert.throws(() => workspaceOperation(s,user,'chart',{...week,from:date,through:nextDate}),/нет наблюдений/i);
  const chart = workspaceOperation(s,user,'chart',{...week,from:date,through:'2026-11-08'});
  const snapshot = workspaceOperation(s,user,'calc',{id:chart.id});
  assert.equal(snapshot.step,7 * day);
  assert.deepEqual([snapshot.points[0].value,snapshot.points[0].numerator,snapshot.points[0].denominator],[0.4,6,15]);
});

test('A/B retains both counter sources and rejects days with a missing group member', async t => {
  const s = mem(t);
  const {docs} = await metrika(env(), async url => {
    const counter = new URL(url).searchParams.get('ids');
    const data = api(counter);
    data.push({dimensions:[{name:nextDate}],metrics:counter === '101' ? [3,30] : [2,10]});
    if (counter === '101') data.push({dimensions:[{name:'2026-11-04'}],metrics:[5,20]});
    return Response.json({data,total_rows:data.length});
  });
  importDocs(s,docs);
  const chart = workspaceOperation(s,user,'chart',{metric:report.id,sourceId:'group:lk_reco_ctr'});
  const start = Date.parse(date);
  const selected = workspaceOperation(s,user,'range_compare',{selection:{source:'metric',calcId:chart.id,
    metric:report.id,series:['all'],ranges:[{from:start,to:start+2*day},{from:start+day,to:start+3*day}]}});
  const [a,b] = selected.periods.map(p => p.series[0]);
  assert.deepEqual([a.n,a.d,a.value], [16,100,16]);
  assert.match(a.sources[0].location,/Счётчик 101/);
  assert.match(a.sources[1].location,/Счётчик 202/);
  assert.equal(b.value,null);
  assert.match(b.reason,/одного из счётчиков/);
});

test('funnel follows the chosen counter, its definition and the versions current when the chart was saved', async t => {
  const s = mem(t);
  const map = {id:'cfg_completion_rate',product:'Astra',numerator:'complete',denominator:'open'};
  async function ingest(counter, metrics) {
    const data = metrics.map(([name, n, d]) => ({dimensions:[{name}],metrics:[n,d]}));
    const {docs} = await metrika({...env(map), METRIKA_COUNTER_IDS:counter}, async () => Response.json({data,total_rows:data.length}));
    importDocs(s,docs);
  }
  await ingest('101', [[date,1,10],[nextDate,2,90]]);
  await ingest('101', [[date,6,10]]);
  await ingest('202', [[date,42,100],[nextDate,50,100]]);
  const sourceId = 'metrika:101:cfg_completion_rate';
  const chart = workspaceOperation(s,user,'chart',{metric:map.id,sourceId});
  await ingest('101', [[date,10,10]]);
  const thread = createThread(s.db,user,'Проверка воронки');
  const result = workspaceOperation(s,user,'funnel',{thread,calc:chart.id});
  assert.ok(result.chart);
  const completion = result.evidence.find(section => section.title === 'Завершение подбора');
  assert.match(completion.rows[0][1], /8\/100/);
  const before = workspaceOperation(s,user,'calc',{id:chart.id});
  assert.deepEqual(before.points.map(p => p.numerator),[6,2]);
  const fresh = workspaceOperation(s,user,'chart',{metric:map.id,sourceId});
  assert.notEqual(fresh.id,chart.id);
  assert.deepEqual(workspaceOperation(s,user,'calc',{id:fresh.id}).points.map(p => p.numerator),[10,2]);
});

test('funnel requests a series choice when A and B contain different counters on different dates', async t => {
  const s = mem(t);
  const map = {id:'cfg_completion_rate',product:'Astra',numerator:'complete',denominator:'open'};
  const through = '2026-11-16';
  const {docs} = await metrika(env(map), async url => {
    const isFirst = new URL(url).searchParams.get('ids') === '101';
    return Response.json({data:[{dimensions:[{name:isFirst ? date : through}],metrics:isFirst ? [1,10] : [10,50]}],total_rows:1});
  });
  importDocs(s,docs);
  const {view} = workspaceOperation(s,user,'view',{product:'Astra',from:date,releaseWeek:'2026-11-09',through});
  const thread = createThread(s.db,user,'Проверка выбора ряда');
  const result = workspaceOperation(s,user,'funnel',{thread,calc:view.id});
  assert.equal(result.chart,null);
  const [label,a,b] = result.evidence.find(section => section.title === 'Завершение подбора').rows[0];
  assert.equal(label,'Все устройства');
  for (const value of [a,b]) {
    assert.match(value,/Выберите.*metrika:101.*metrika:202/);
    assert.doesNotMatch(value,/10%|20%/);
  }
});

test('missing page or metric bases give explicit failure and zero denominators remain unknown', async () => {
  let request=0;
  await assert.rejects(metrika(env(), async () => Response.json({
    data:++request===1?api('101'):[],total_rows:2
  })), /неполную страницу/);
  await assert.rejects(metrika(env(), async () => Response.json({data:api('101'),total_rows:2})), /повторяющееся наблюдение/);
  await assert.rejects(metrika(env(), async () => Response.json({data:api('101'),total_rows:1,total_rows_rounded:true})), /неполный или изменившийся отчёт/);
  const row=normalizeObservation({metric_id:report.id,date,product:'ЛК',unit:'ratio',segment:'all',value:0.1},'test');
  assert.ok(aggregateMetric([row],report.id).reason);
  const zero=aggregateMetric([{...row,numerator:0,denominator:0}],report.id);
  assert.equal(zero.n,0);assert.equal(zero.d,0);assert.equal(zero.value,null);
});
