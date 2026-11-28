import test from 'node:test';
import assert from 'node:assert/strict';
import { runAttempt, coverage, combineReports } from '../scripts/acceptance/runner.mjs';
import { workspaceCases } from '../scripts/acceptance/cases-workspace.mjs';
import { openWorkspace } from '../scripts/acceptance/workspace-fixture.mjs';

const target = 'https://anymodel.org/v1/chat/completions';
const toy = {type:'function',function:{name:'look',parameters:{type:'object',properties:{id:{type:'string'}},required:['id'],additionalProperties:false}}};
const request = (choice='auto', messages=[]) => ({method:'POST',body:JSON.stringify({tools:[toy],tool_choice:choice,messages})});
const wire = (args, id='x') => Response.json({choices:[{message:{role:'assistant',tool_calls:[{id,type:'function',function:{name:'look',arguments:args}}]},finish_reason:'tool_calls'}],usage:{prompt_tokens:19,completion_tokens:3}});
const spec = (run, overrides={}) => ({id:'a',family:'workspace',prompts:['one','two','three'],tools:['look'],run,...overrides});
const run = (entry, replies) => runAttempt(entry,1,{},async()=>replies.shift());

test('corporate Confluence preview saves the original external page request with zero external writes',async()=>{
  const forwarded=[];
  const fixture=workspaceCases.find(c=>c.id==='workspace-page-draft').fixture ?? openWorkspace;
  const x=await fixture({},async(url,init)=>{forwarded.push([String(url),init?.method]);throw Error('External network forbidden');});
  try {
    const result=await x.op('page_draft',{caseId:x.caseId,title:'Сверка CTR',
      content:'Контрольная выборка 240 визитов.',pageTarget:'external'});
    const rows=x.all('SELECT id,state,external,body FROM draft_actions');
    assert.equal(rows.length,1);
    assert.equal(rows[0].id,result.id);
    assert.equal(rows[0].state,'draft');
    assert.equal(rows[0].external,null);
    const body=JSON.parse(rows[0].body);
    assert.equal(body.target.url,'https://wiki.acceptance.invalid');
    assert.equal(body.title,'Сверка CTR');
    assert.match(body.storage,/240 визитов/u);
    assert.equal(x.one('SELECT count(*) n FROM demo_pages').n,1);
    assert.deepEqual(forwarded,[]);
    assert.ok(x.wikiRequests.every(r=>r.method==='GET'));
  } finally {x.close();}
});

test('natural selection includes observed schemas, call IDs, usage and validated arguments',async()=>{
  const entry=spec(async({send})=>{ await send(target,request()); return {receipt:3}; });
  const r=await run(entry,[wire('{"id":"abc"}')]);
  assert.equal(r.status,'passed');
  assert.deepEqual(r.receipt,{receipt:3});
  assert.deepEqual(r.selected,['look']);
  assert.equal(r.calls[0].tools[0].id,'x');
  assert.equal(r.calls[0].tools[0].valid,true);
  assert.equal(r.calls[0].usage.input,19);
  assert.deepEqual(coverage([entry],[r]).families.workspace.verified,[]);
  assert.deepEqual(coverage([entry],[r,{...r,attempt:2},{...r,attempt:3}]).families.workspace.verified,['look']);
});

test('first malformed arguments survive a later successful call and correction',async()=>{
  const entry=spec(async({send})=>{
    await send(target,request());
    await send(target,request('auto',[{role:'user',content:JSON.stringify({correction:'try again'})}]));
  });
  const r=await run(entry,[wire('{"id":3}'),wire('{"id":"abc"}','y')]);
  assert.equal(r.status,'failed');
  assert.match(r.firstMismatch,/argument/i);
  assert.ok(r.mismatches.some(m=>/correction/i.test(m)));
  assert.deepEqual(coverage([entry],[r]).families.workspace.verified,[]);
});

test('forced selection, failed HTTP recovery, unexpected exposure and local traffic cannot pass',async()=>{
  const entry=spec(async({send})=>{await send(target,request());await send(target,request({type:'function',function:{name:'look'}}));});
  const r=await run(entry,[new Response('',{status:429}),wire('{"id":"a"}')]);
  assert.equal(r.status,'failed');
  assert.match(r.firstMismatch,/429/);
  assert.deepEqual(r.selected,[]);
  const local=spec(async({send})=>{await send(target,request());},{local:true,tools:[]});
  const l=await run(local,[wire('{"id":"a"}')]);
  assert.equal(l.status,'failed');
  assert.deepEqual(coverage([local],[l]).families.workspace.unexpected,['look']);
});

test('guard blocks all external destinations before transport, even when app catches the error',async()=>{
  let forwarded=0;
  const entry=spec(async({send})=>{await send('https://example.invalid',request()).catch(()=>{});},{local:true,tools:[]});
  const r=await runAttempt(entry,1,{},async()=>{forwarded++;});
  assert.equal(forwarded,0);
  assert.equal(r.status,'failed');
  assert.match(r.firstMismatch,/destination/i);
});

test('combined reports reject overlaps, omitted attempts, changed fingerprints and retain the first failure',async()=>{
  const entry=spec(async({send})=>{await send(target,request());});
  const rows=[];
  for (const a of [1,2,3]) rows.push(await runAttempt(entry,a,{},async()=>wire(a===1?'{}':'{"id":"a"}')));
  const report={runId:'initial',head:'head',model:'model',productionFingerprint:'code',runtimeDiffSha256:'diff',status:'failed'};
  const a={...report,results:rows.slice(0,1),total:1}, b={...report,results:rows.slice(1),total:2};
  assert.equal(combineReports([entry],[a,b]).status,'failed');
  assert.match(combineReports([entry],[a,b]).firstMismatch,/argument/i);
  assert.throws(()=>combineReports([entry],[a,a,b]),/Duplicate/);
  assert.throws(()=>combineReports([entry],[a]),/Missing attempts/);
  assert.throws(()=>combineReports([entry],[a,{...b,head:'next'}]),/fingerprint/);
});

test('wire evidence scrubs synthetic credentials and preserves response and argument evidence',async()=>{
  const entry=spec(async({send})=>{await send(target,request());});
  const env={ANYMODEL_API_KEY:'sensitive_value'};
  const r=await runAttempt(entry,1,env,async()=>Response.json({choices:[{message:{
    content:'Bearer sensitive_value',tool_calls:[{id:'c',type:'function',function:{name:'look',arguments:'{"id":"sensitive_value"}'}}]}}]}));
  assert.doesNotMatch(JSON.stringify(r),/sensitive_value/);
  assert.equal(r.calls[0].tools[0].arguments.id,'[redacted]');
  assert.ok(r.calls[0].responseText.includes('[redacted]'));
});

test('all workspace prompt variants reach the intended entry point and account for every advertised name offline',async()=>{
  const env={LLM_BACKEND:'anymodel',LLM_MODEL:'offline-model',ANYMODEL_API_KEY:'offline',LLM_DATA_MODE:'analysis'};
  const planned=new Set(workspaceCases.flatMap(s=>s.tools)), advertised=new Set();
  let local=0;
  for (const scenario of workspaceCases) for(const attempt of [1,2,3]) {
    const row=await runAttempt(scenario,attempt,env,async()=>new Response(null,{status:401}));
    for (const name of row.exposed) advertised.add(name);
    if (scenario.local) {
      assert.equal(row.status,'passed',row.id+': '+row.firstMismatch);
      assert.equal(row.calls.length,0);
      local++;
    } else {
      assert.equal(row.status,'failed',row.id);
      assert.equal(row.firstMismatch,'Provider HTTP 401',row.id+' #'+attempt+': '+row.firstMismatch);
      assert.ok(row.calls[0].advertised.length>0,row.id);
    }
  }
  assert.equal(local,9);
  assert.deepEqual([...advertised].sort(),[...planned].sort());
});
