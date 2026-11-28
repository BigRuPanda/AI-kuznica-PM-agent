import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { initWorkbench } from '../server/workbench.mjs';
import { initEvidence, importDocs, getCase, effect, updateCase } from '../server/evidence.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { casePresentationInput } from '../server/presentation-case.mjs';

const user = { id: 'pm', role: 'admin', name: 'PM' };
const week = i => new Date(Date.UTC(2026, 0, 5 + i * 7)).toISOString().slice(0, 10);
const deployed = week(4);
const measure = { metric:'lk_reco_ctr', product:'ЛК', segment:'desktop', control:'ЛК', controlSegment:'mobile',
  comparison:'gte', targetMode:'absolute', targetValue:5 };
function setup(file = ':memory:') {
  const store = openStore(file);
  initEvidence(store.db);
  initWorkbench(store.db);
  return store;
}
function ctr(i, segment, clicks, views = 100) {
  return { kind:'metrics', loc:segment+i, row:{ product:'ЛК', segment, date:week(i), metric_id:'lk_reco_ctr',
    unit:'ratio', value:views ? clicks/views : 0, detail_json:JSON.stringify({click_visits:clicks,viewed_visits:views}) }};
}
function load(store, facts) { importDocs(store,[{file:'fixture.xlsx',facts}],{notify:false}); }
function newCase(store, measurement = measure) {
  return workspaceOperation(store,user,'create-case',{title:'Рекомендации',product:'ЛК',measurement}).id;
}
function watch(store, caseId, more = {}) {
  return workspaceOperation(store,user,'watch',{caseId,deployed,...more});
}
function history(store) {
  load(store,Array.from({length:4},(_, i)=>[ctr(i,'desktop',2),ctr(i,'mobile',10)]).flat());
}
test('the measured KPI uses its own source counts, inclusive target and control, and freezes its baseline across restarts', t => {
  const dir = mkdtempSync(join(tmpdir(),'pm-watch-')), file = join(dir,'watch.sqlite');
  let s = setup(file);
  t.after(()=>{ s.close(); rmSync(dir,{force:true,recursive:true}); });
  history(s);
  const id = newCase(s);
  const inspect = () => effect(s.db,getCase(s.db,id));
  assert.equal(watch(s,id).state,'Недостаточно данных');
  const old = getCase(s.db,id).body.watch;
  assert.equal(old.controlBaseline.value,10);
  load(s, Array.from({length:4},(_,j)=>[ctr(4+j,'desktop',4),ctr(4+j,'mobile',10)]).flat());
  assert.equal(inspect().state,'Цель не достигнута');
  for (const x of [5,6]) {
    load(s,Array.from({length:4},(_,j)=>ctr(4+j,'desktop',x)));
    const out = inspect();
    assert.equal(out.target,5); assert.equal(out.unit,'%'); assert.equal(out.actual,x);
    assert.equal(out.state,'Цель достигнута');
  }
  const presentation=casePresentationInput(s.db,user,id,Date.now());
  const kpi=presentation.candidates.find(candidate=>candidate.kind==='kpi');
  assert.equal(kpi.title,'Показатель после выкладки');
  assert.equal(kpi.value,'6');
  assert.equal(kpi.unit,'%');
  assert.ok(kpi.refs.some(ref=>ref.url.startsWith('#knowledge-source/') && ref.url.endsWith('/desktop7')));
  load(s,[ctr(7,'desktop',0,0),ctr(6,'desktop',1,10)]);
  assert.ok(Math.abs(inspect().actual - 100 * 13 / 210) < 1e-8);
  load(s,[ctr(7,'mobile',0)]);
  assert.match(inspect().state,/Изменился контроль/);
  load(s,Array.from({length:4},(_,j)=>ctr(j,'mobile',0)));
  s.close(); s=setup(file);
  watch(s,id);
  assert.deepEqual(getCase(s.db,id).body.watch,old);
  assert.throws(()=>watch(s,id,{measurement:{...measure,metric:'orders_index'}}),/план проверки/);
});
test('the same measurement resumes a paused watch and preserves a reviewed result', t => {
  const store = setup();
  t.after(() => store.close());
  history(store);
  const adHoc = workspaceOperation(store, user, 'create-case', { title: 'Рекомендации', product: 'ЛК' }).id;
  for (const [caseId, input] of [[newCase(store), {}], [adHoc, { measurement: measure }]]) {
    watch(store, caseId, input);
    const saved = getCase(store.db, caseId).body.watch;
    workspaceOperation(store, user, 'decide', { caseId, state: 'Исследуем' });
    watch(store, caseId, input);
    const resumed = getCase(store.db, caseId);
    assert.equal(resumed.state, 'Наблюдаем эффект');
    assert.deepEqual(resumed.body.watch, saved);
    assert.equal(resumed.body.watchHistory, undefined);

    resumed.state = 'Нужно решение';
    resumed.body.watch.reviewed = true;
    updateCase(store.db, resumed);
    watch(store, caseId, input);
    assert.equal(getCase(store.db, caseId).state, 'Нужно решение');
    assert.equal(getCase(store.db, caseId).body.watch.reviewed, true);
  }
});
test('missing KPI, incomplete window and zero denominator never produce a successful outcome', t=>{
  const s=setup(); t.after(()=>s.close());
  const id = newCase(s,{...measure,control:undefined,controlSegment:undefined});
  load(s,Array.from({length:12},(_,i)=>({kind:'sales',loc:'A'+i,row:{product_family:'ЛК',week_start:week(i),orders_index:120}})));
  assert.equal(watch(s,id).actual,null);
  load(s,[ctr(4,'desktop',80),ctr(5,'desktop',80),ctr(6,'desktop',80)]);
  assert.equal(watch(s,id).state,'Недостаточно данных');
  load(s,Array.from({length:4},(_,j)=>ctr(j+4,'desktop',0,0)));
  assert.equal(watch(s,id).actual,null);
  assert.match(watch(s,id).reason,/знаменател/i);
  const other = workspaceOperation(s,user,'create-case',{title:'Старая цель',product:'ЛК',metric:'CTR',success:'≥ 5%'}).id;
  assert.throws(()=>watch(s,other,{percent:90}),/Уточните/);
  const legacy=getCase(s.db,other);
  legacy.body.watch={deployed,target:80,control:'B',controlBase:100,tolerance:10};
  updateCase(s.db,legacy);
  assert.equal(effect(s.db,legacy).actual,null);
});

test('a changed counter group cannot satisfy the frozen KPI', t => {
  const s = setup();
  t.after(() => s.close());
  const group = 'group:recommendations';
  function observations(start, members) {
    return Array.from({length:4}, (_, i) => members.map(counter => {
      const fact = ctr(start + i, 'desktop', 8);
      return {...fact, row:{...fact.row, source_id:'metrika:' + counter, counter_id:counter,
        combine_group:group, combine_members:members, definition_id:'visits', step_days:7}};
    })).flat();
  }
  load(s, observations(0, ['1','2']));
  const id = newCase(s, {...measure, control:undefined, controlSegment:undefined, sourceId:group});
  assert.equal(watch(s,id).actual,null);
  load(s, observations(4, ['1','3']));
  const result = watch(s,id);
  assert.equal(result.actual,null);
  assert.match(result.reason,/Состав счётчиков/);
});
