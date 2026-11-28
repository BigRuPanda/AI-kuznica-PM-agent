import test from 'node:test';
import assert from 'node:assert/strict';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { openStore } from '../server/store.mjs';
import { initEvidence } from '../server/evidence.mjs';
import { createInvestigationScheduler } from '../server/investigation-scheduler.mjs';
import { saveResearchSettings } from '../server/investigation-settings.mjs';
import { syncInvestigations, createAlternative, readInvestigations } from '../server/case-investigations.mjs';

const env={LLM_BASE_URL:'https://fixture.invalid',LLM_MODEL:'fixture',LLM_DATA_MODE:'analysis'};
async function until(check) {
  const deadline=Date.now()+3000;
  while (!check()) { if(Date.now()>deadline) assert.fail('scheduler missed a wakeup'); await nextTurn(); }
}
function setup(t, initialLimit) {
  const spaces=new Map(), starts=[], held=[];
  let limit=initialLimit, peak=0;
  for(const id of ['team','judge']) {
    const store=openStore(':memory:');
    initEvidence(store.db); spaces.set(id,store);
  }
  const scheduler=createInvestigationScheduler({spaces,env,getLimit:()=>limit,options:{
    capture:(_db,run)=>({measurable:true,context:{},calcId:'calc-'+run.id,checks:[]}),
    async execute({stage,run}) {
      starts.push([run.caseId,stage,run.id]);
      const gate=Promise.withResolvers();
      held.push(gate); peak=Math.max(peak,held.length);
      await gate.promise;
      return {check:{role:stage},result:{stage}};
    },
  }});
  t.after(async()=>{const closing=scheduler.close(); held.splice(0).forEach(g=>g.resolve()); await closing;
    for(const store of spaces.values()) store.close();});
  function add(space,id) {
    const {db}=spaces.get(space);
    db.prepare("INSERT INTO cases VALUES(?,?,?,'Исследуем','{}')").run(id,id,id);
    syncInvestigations(db,id);
  }
  return {spaces,starts,held,scheduler,add,peak:()=>peak,limit:n=>{limit=n;scheduler.wake();}};
}
test('five cases start ten blocked roles without page reads', async t=>{
  const x=setup(t,10);
  for(let i=0;i<5;i++) x.add(i<3?'team':'judge','case'+i);
  x.scheduler.wake();
  await until(()=>x.held.length===10);
  assert.equal(new Set(x.starts.map(([id])=>id)).size,5);
  assert.ok(x.starts.every(([,role])=>['analyst','researcher'].includes(role)));
  assert.equal(x.peak(),10);
});
test('round robin spans workspaces and case alternatives',async t=>{
  const x=setup(t,2);
  x.add('team','one');x.add('team','two');x.add('judge','three');
  const db=x.spaces.get('team').db, user={id:'pm'};
  const parent=readInvestigations(db,user,'one').current;
  createAlternative(db,user,{caseId:'one',parentId:parent.id,question:'Прочитать архив',requestId:'fixture'});
  x.scheduler.wake();
  await until(()=>x.held.length===2);
  x.held.shift().resolve();
  await until(()=>x.starts.length===3);
  assert.equal(new Set(x.starts.map(([id])=>id)).size,3);
  assert.equal(x.peak(),2);
});

test('a limit change affects admissions immediately',async t=>{
  const x=setup(t,2);
  for(let i=0;i<5;i++) x.add('team','case'+i);
  x.scheduler.wake();
  await until(()=>x.held.length===2);
  x.limit(4);
  await until(()=>x.held.length===4);
  x.limit(1);
  x.held.splice(0,3).forEach(g=>g.resolve());
  await nextTurn(); await nextTurn();
  assert.equal(x.starts.length,4);
  x.held.shift().resolve();
  await until(()=>x.starts.length===5);
  assert.equal(x.held.length,1);
  assert.equal(x.peak(),4);
});

test('new arrivals join behind a case already waiting for its second role', async t=>{
  const x=setup(t,1);
  x.add('team','first'); x.scheduler.wake();
  await until(()=>x.starts.length===1);
  x.add('judge','arrival'); x.scheduler.wake();
  const db=x.spaces.get('judge').db;
  await until(()=>db.prepare("SELECT prepared FROM case_investigations WHERE case_id='arrival'").get()?.prepared===1);
  x.held.shift().resolve();
  await until(()=>x.starts.length===2);
  assert.deepEqual(x.starts[1].slice(0,2),['first','researcher']);
  x.held.shift().resolve();
  await until(()=>x.starts.length===3);
  assert.equal(x.starts[2][0],'arrival');
});

test('superseded role aborts and releases its scheduler slot',async t=>{
  for(const condition of ['superseded','expired']) await t.test(condition,async t=>{
    const store=openStore(':memory:'),{db}=store;
    initEvidence(db);
    const user={id:'pm',role:'admin'};
    saveResearchSettings(db,user,{scope:'team',mode:'lead'});
    const add=id=>{
      db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(id,id,id,'Исследуем',
        JSON.stringify({signal:{status:'confirmed',revision:1}}));
      syncInvestigations(db,id);
    };
    add('first');
    const old=readInvestigations(db,user,'first').current;
    const held=Promise.withResolvers(), started=Promise.withResolvers();
    let now=10_000, oldSignal;
    const scheduler=createInvestigationScheduler({spaces:new Map([['team',store]]),getLimit:()=>1,env,
      options:{now:()=>now,leaseMs:1000,
        capture(_db,run){return {calcId:'fixture-'+run.id,measurable:true,context:{},checks:[]};},
        async execute({run,stage,signal}){
          if(run.id===old.id){
            oldSignal=signal;
            started.resolve();
            signal?.addEventListener('abort',()=>held.reject(signal.reason),{once:true});
            await held.promise;
            return {check:{role:'stale'},result:{stale:true}};
          }
          return {check:{role:stage},result:{current:true}};
        },
      }});
    t.after(async()=>{held.resolve(); await scheduler.close(); store.close();});
    scheduler.wake();
    await started.promise;
    if(condition==='superseded'){
      db.prepare("UPDATE cases SET body=json_set(body,'$.signal.revision',2) WHERE id='first'").run();
      syncInvestigations(db,'first');
    }else{
      now+=1001;
      add('new');
      syncInvestigations(db);
    }
    scheduler.wake();
    await until(()=>readInvestigations(db,user,condition==='superseded'?'first':'new').current.status==='ready');
    assert.equal(oldSignal?.aborted,true);
    const previous=db.prepare('SELECT result FROM case_investigations WHERE id=?').get(old.id);
    assert.equal(previous.result,null);
  });
});
