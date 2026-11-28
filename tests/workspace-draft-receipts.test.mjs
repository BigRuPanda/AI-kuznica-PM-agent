import test from 'node:test';
import assert from 'node:assert/strict';
import { openCorporateWikiWorkspace } from '../scripts/acceptance/workspace-fixture.mjs';
import { enqueue, messages, workJobs } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { digest } from '../server/evidence.mjs';

const page = 'Подготовь черновик новой страницы Confluence «Сверка CTR». Запиши в неё: контрольная выборка 240 визитов. Сначала покажи предпросмотр.';
const issue = 'Подготовь черновик задачи Redmine «Проверка CTR» для QA. В описании попроси сверить 240 визитов.';
const both = 'Подготовь два черновика: новую страницу Confluence «Сверка CTR» и отдельную задачу Redmine «Проверка CTR» для QA. Для обоих укажи 240 визитов.';

async function turn(question, selected, finalText) {
  const env={LLM_BACKEND:'anymodel',LLM_MODEL:'offline',ANYMODEL_API_KEY:'offline',LLM_DATA_MODE:'analysis'};
  let rounds=0;
  const corrections=[];
  const send=async(url,init)=>{
    assert.equal(String(url),'https://anymodel.org/v1/chat/completions');
    const request=JSON.parse(init.body);
    const inputs=request.messages.filter(m=>m.role==='user').map(m=>JSON.parse(m.content));
    if(inputs.at(-1).correction) corrections.push(inputs.at(-1).correction);
    const caseId=inputs[0].context.caseId;
    const args={
      page_draft:{caseId,pageTarget:'external',title:'Сверка CTR',content:'Контрольная выборка 240 визитов.'},
      draft:{caseId,title:'Проверка CTR',description:'QA: сверить контрольную выборку из 240 визитов.'},
    };
    const toolCalls=rounds++===0 ? selected.map((item,i)=>{
      const name=typeof item==='string'?item:item.name;
      const input=typeof item==='string'?args[name]:{...args[name],title:item.title};
      return {id:'call_'+i,type:'function',function:{name,arguments:JSON.stringify(input)}};
    }) : [];
    const message=toolCalls.length ? {role:'assistant',content:null,tool_calls:toolCalls} : {role:'assistant',content:finalText};
    return Response.json({choices:[{message,finish_reason:toolCalls.length?'tool_calls':'stop'}]});
  };
  const x=await openCorporateWikiWorkspace(env,send);
  try {
    const job=enqueue(x.store,x.user,{thread:x.thread,caseId:x.caseId,question});
    await workJobs(x.store,{publicUser:()=>x.user},x.env,send);
    const answer=messages(x.db,x.user,x.thread).items.find(m=>m.body.jobId===job)?.body;
    const drafts=x.all('SELECT id,user,state,external,body FROM draft_actions').map(row=>({...row,...JSON.parse(row.body)}));
    assert.ok(answer);
    for(const d of drafts) {
      assert.equal(d.state,'draft');
      assert.equal(d.user,x.user.id);
      assert.equal(d.external,null);
      assert.ok(answer.actions?.some(action=>action.id===d.id),'Reply must reference its saved preview');
    }
    assert.equal(x.one('SELECT count(*) n FROM local_issues').n,0);
    assert.equal(x.one('SELECT count(*) n FROM demo_pages').n,1);
    assert.ok(x.wikiRequests.every(r=>r.method==='GET'));
    return {answer,drafts,corrections};
  } finally {x.close();}
}

test('the exact Confluence draft request completes with one page preview and no correction',async()=>{
  const {answer,drafts,corrections}=await turn(page,['page_draft'],'Подготовил черновик страницы «Сверка CTR». Проверьте предпросмотр.');
  assert.deepEqual(drafts.map(d=>d.kind),['page']);
  assert.equal(drafts[0].target.url,'https://wiki.acceptance.invalid');
  assert.match(drafts[0].storage,/240 визитов/u);
  assert.equal(answer.outcome,'done',answer.text);
  assert.deepEqual(corrections,[]);
});

test('a false Confluence preview claim cannot complete without a page receipt',async()=>{
  const {answer,drafts}=await turn('Создай предпросмотр новой страницы «Сверка CTR» в Confluence.',[],'Предпросмотр страницы готов к подтверждению.');
  assert.equal(drafts.length,0);
  assert.ok(['partial','failed'].includes(answer.outcome),answer.text);
});

test('explicit Redmine task completes with an issue preview alone',async()=>{
  const {answer,drafts,corrections}=await turn(issue,['draft'],'Черновик задачи сохранён.');
  assert.deepEqual(drafts.map(d=>d.kind),['issue']);
  assert.equal(answer.outcome,'done',answer.text);
  assert.deepEqual(corrections,[]);
});

for(const [operations,expectedKinds,expectedOutcome] of [
  [['draft','page_draft'],['issue','page'],'done'],
  [['page_draft'],['page'],'partial'],
  [['draft'],['issue'],'partial'],
]) {
  test('mixed request with '+expectedKinds.join(' and ')+' preview receives '+expectedOutcome,async()=>{
    const {answer,drafts,corrections}=await turn(both,operations,'Предпросмотры страницы и задачи готовы к подтверждению.');
    assert.deepEqual(drafts.map(d=>d.kind).sort(),expectedKinds);
    assert.equal(answer.outcome,expectedOutcome,answer.text);
    if(expectedOutcome==='done') assert.deepEqual(corrections,[]);
  });
}

test('two distinct issue drafts keep distinct receipts', async () => {
  const one={name:'draft', title:'Первый черновик CTR'};
  const two={name:'draft', title:'Второй черновик CTR'};
  const {answer,drafts}=await turn('Подготовь два черновика задач Redmine для QA.', [one,two,one], 'Два предпросмотра готовы.');
  assert.deepEqual(drafts.map(d=>d.title).sort(), [two.title,one.title].sort());
  assert.equal(new Set(answer.actions.filter(a=>a.op==='draft').map(a=>a.id)).size,2);
});

test('legacy draft receipt is reused for the same saved content', async t => {
  for(const withReceipt of [true,false]) await t.test(withReceipt?'saved receipt':'interrupted before receipt',async()=>{
    const env={LLM_BACKEND:'anymodel',LLM_MODEL:'offline',ANYMODEL_API_KEY:'offline',LLM_DATA_MODE:'analysis'};
    const requestInput={title:'Проверка CTR',description:'QA: сверить контрольную выборку.'};
    let round=0, reported;
    const send=async (_url, init)=>{
      const request=JSON.parse(init.body);
      if (++round===1) return Response.json({choices:[{message:{role:'assistant', tool_calls:[{
        id:'legacy-call',type:'function',function:{name:'draft',arguments:JSON.stringify(requestInput)},
      }]}}]});
      reported=JSON.parse(request.messages.findLast(m=>m.role==='tool').content).id;
      return Response.json({choices:[{message:{role:'assistant',content:'Открой сохранённый черновик.'}}]});
    };
    const x=await openCorporateWikiWorkspace(env,send);
    try {
      const job=enqueue(x.store,x.user,{thread:x.thread,caseId:x.caseId,question:issue});
      const signature=digest(JSON.stringify(['draft',[x.caseId,'','']]));
      const draft=await workspaceOperation(x.store,x.user,'draft',{...requestInput,caseId:x.caseId},
        x.env,send,false,digest(job+'/'+signature),true);
      if(withReceipt) x.db.prepare('INSERT INTO agent_steps VALUES(?,?,?)').run(job,signature,JSON.stringify(draft));
      await workJobs(x.store,{publicUser:()=>x.user},x.env,send);
      assert.equal(reported,draft.id);
      assert.equal(x.one('SELECT count(*) n FROM draft_actions').n,1);
      const activeSignature=digest(JSON.stringify(['draft',Object.entries({...requestInput,caseId:x.caseId}).sort()]));
      assert.equal(JSON.parse(x.one('SELECT body FROM agent_steps WHERE job=? AND signature=?',job,activeSignature).body).id,draft.id);
    } finally {
      x.close();
    }
  });
});

test('chat status counts requested artifacts and ignores unsupported claims', async () => {
  for (const [question,text] of [
    ['Назначь наблюдение за эффектом с 2026-10-05.', 'План наблюдения сохранён.'],
    ['Добавь заметку в текущий разбор.', 'Заметка сохранена.'],
  ]) {
    const {answer}=await turn(question,[],text);
    assert.ok(['partial','failed'].includes(answer.outcome),answer.text);
    assert.equal(answer.actions?.length||0,0);
  }
  const {answer,drafts}=await turn(page,['page_draft'],'Страница опубликована.');
  assert.equal(answer.outcome,'done',answer.text);
  assert.deepEqual(drafts.map(d=>d.state),['draft']);
  assert.doesNotMatch(answer.text,/страница опубликована/iu);
  assert.match(answer.text,/предпросмотр/iu);
});
