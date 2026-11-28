import assert from 'node:assert/strict';
import test from 'node:test';
import { initInvestigations, workInvestigation } from '../server/case-investigations.mjs';
import { initEvidence } from '../server/evidence.mjs';
import { runInvestigationStage } from '../server/investigation-engine.mjs';
import { saveResearchSettings } from '../server/investigation-settings.mjs';
import { openStore } from '../server/store.mjs';
import { createThread, enqueue, initWorkbench, messages, resumeJob, workJobs } from '../server/workbench.mjs';
import { runAssistant } from '../server/workspace-agent.mjs';

const anymodel = { LLM_BACKEND: 'anymodel', ANYMODEL_API_KEY: 'fixture-key', LLM_MODEL: 'fixture', LLM_DATA_MODE: 'analysis' };
const findings = [{ id: 'calculation', kind: 'calculation', text: 'Снимок' }];
const start = 1_800_000_000_000;

function watchTimeouts(t) {
  const values = [];
  t.mock.method(AbortSignal, 'timeout', timeout => {
    values.push(timeout);
    return new AbortController().signal;
  });
  return values;
}

function toolReply(name, args) {
  return Response.json({ choices: [{ message: { tool_calls: [{
    id: name, type: 'function', function: { name, arguments: JSON.stringify(args) },
  }] } }] });
}

function open(t) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  return store;
}

test('AnyModel workspace requests share one six-hundred-second deadline', async t => {
  const store = open(t);
  const user = { id: 'owner', name: 'Владелец', role: 'member' };
  const thread = createThread(store.db, user, 'Время на модель');
  const input = { thread, question: 'Какие факты есть в рабочем пространстве?' };
  const job = enqueue(store, user, input);
  const timeouts = watchTimeouts(t);
  let time = start;
  t.mock.method(Date, 'now', () => time);
  let calls = 0;
  const send = async () => {
    calls++;
    if (calls === 1) {
      time += 90_000;
      return toolReply('overview', {});
    }
    time += 510_000;
    return toolReply('metrics', {});
  };
  const output = await runAssistant(store, user, input, anymodel, send, job, []);
  assert.equal(calls, 2);
  assert.deepEqual(timeouts, [600_000, 510_000]);
  assert.equal(output.outcome, 'partial');
  assert.match(output.text, /Время разбора истекло/);
});

test('all AnyModel calls within one investigation role share its deadline', async t => {
  const timeouts = watchTimeouts(t);
  let time = start;
  t.mock.method(Date, 'now', () => time);
  let calls = 0;
  const send = async () => {
    calls++;
    if (calls === 1) {
      time += 400_000;
      return toolReply('read_findings', { ids: ['calculation'] });
    }
    time += 200_000;
    return toolReply('submit_check', { question: 'Что изменилось?', result: 'Расчёт', impact: 'Сверить', findingIds: ['calculation'] });
  };
  const capture = { calcId: 'fixture', context: { findings } };
  await assert.rejects(runInvestigationStage({ env: anymodel, stage: 'analyst', run: {}, capture, send }),
    error => error.timedOut === true && error.usage.calls === 2);
  assert.equal(calls, 2);
  assert.deepEqual(timeouts, [600_000, 200_000]);
});

test('AnyModel role calls finish within the scheduler lease, including a custom lease', async t => {
  for (const [leaseMs, expectedLease] of [[undefined, 600_000], [5_500, 5_500]]) {
    await t.test(String(leaseMs ?? 'default'), async t => {
      const store = open(t);
      const { db } = store;
      initInvestigations(db);
      db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run('case', 'Product', 'Case', 'Исследуем', '{}');
      saveResearchSettings(db, { id: 'owner', role: 'admin' }, { scope: 'team', mode: 'lead' });
      let now = start;
      let claimedUntil;
      const timeouts = watchTimeouts(t);
      const capture = () => {
        db.prepare('INSERT INTO evidence_calcs VALUES(?,?)').run('fixture', '{}');
        return { calcId: 'fixture', context: { findings }, measurable: true, checks: [] };
      };
      const send = async () => {
        claimedUntil = store.one("SELECT lease_until FROM case_investigation_role_state WHERE role='lead'").lease_until;
        now += timeouts[0];
        throw new DOMException('timeout', 'TimeoutError');
      };
      const result = await workInvestigation(store, anymodel, send, { now: () => now, leaseMs, capture });
      assert.equal(claimedUntil, start + expectedLease);
      assert.equal(timeouts.length, 1);
      assert.ok(timeouts[0] < expectedLease && timeouts[0] >= expectedLease - 100);
      assert.equal(result.status, 'retry');
      assert.equal(result.stages[0].reason, 'Модель не успела ответить вовремя.');
    });
  }
});

test('chat compacts after an interrupted body and respects retry-after', async t => {
  const store=open(t);
  const user={id:'owner',name:'Владелец',role:'member'};
  const accounts={publicUser:()=>user};
  let now=start;
  t.mock.method(Date,'now',()=>now);
  const make=(label)=>{
    const thread=createThread(store.db,user,label);
    return {thread,id:enqueue(store,user,{thread,question:'Сделай разбор показателей по данным.'})};
  };
  const output = () => Response.json({choices:[{finish_reason:'stop',message:{content:'Проверенный результат.'}}]});
  for (const variant of ['body','context','length']) {
    const job=make(variant), requests=[];
    await workJobs(store,accounts,anymodel,async (_url,options)=>{
      requests.push(JSON.parse(options.body));
      if(requests.length===1)return toolReply('overview',{});
      if(requests.length!==2)return output();
      if(variant==='body')return new Response(new ReadableStream({start(c){c.error(new TypeError('fixture disconnected'));}}));
      if(variant==='context')return Response.json({error:{code:'context_length_exceeded'}},{status:400});
      return Response.json({choices:[{finish_reason:'length',message:{content:null}}]});
    });
    assert.equal(requests.length,3,variant);
    assert.ok(requests[2].tools.length<requests[1].tools.length,variant);
    assert.ok(requests[2].messages.some(m=>m.tool_call_id==='overview'));
    assert.equal(store.one('SELECT count(*) n FROM agent_steps WHERE job=?',job.id).n,1);
    assert.equal(store.one('SELECT status FROM jobs WHERE id=?',job.id).status,'done');
  }

  const job=make('rate-limit');
  let rawCalls=0;
  await workJobs(store,accounts,anymodel,async ()=>{
    rawCalls++;
    return Response.json({}, {status:429,headers:{'Retry-After':'120'}});
  });
  assert.equal(rawCalls,1);
  const result=JSON.parse(store.one('SELECT result FROM jobs WHERE id=?',job.id).result);
  assert.equal(result.retryAt,now+120_000);
  const reply=()=>messages(store.db,user,job.thread).items.find(m=>m.role==='assistant').body;
  assert.equal(reply().canResume,false);
  assert.throws(()=>resumeJob(store.db,user,job.id),/повтор/i);
  now+=120_000;
  assert.equal(reply().canResume,true);
  resumeJob(store.db,user,job.id);
  await workJobs(store,accounts,anymodel,async()=>output());
  assert.equal(store.one('SELECT status FROM jobs WHERE id=?',job.id).status,'done');
});
