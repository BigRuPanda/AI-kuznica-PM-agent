import test from 'node:test';
import assert from 'node:assert/strict';
import { providerCall } from '../server/agent.mjs';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs } from '../server/evidence.mjs';
import { captureInvestigation, runInvestigationStage } from '../server/investigation-engine.mjs';
import { failureReason } from '../server/investigation-stages.mjs';

const env = { LLM_DATA_MODE:'analysis', LLM_BASE_URL:'https://model.example', LLM_MODEL:'fixture' };
const day = n => new Date(Date.UTC(2026,5,29+n)).toISOString().slice(0,10);
function setup(t, body = {}) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const {db} = store;
  initEvidence(db);
  const sales = [];
  for (let i = 0; i < 21; i++)
    for (const [product,before,after] of [['Alpha',160,90],['Beta',100,105]])
      sales.push({kind:'sales',loc:product+'!A'+(i+2),row:{product_family:product,week_start:day(7*i),
        orders_index:i===13 || i===20 ? 499 : i<13 ? before : after,comment:i===20 ? 'неполная неделя' : ''}});
  const facts = [...sales,
    {kind:'releases',loc:'Релизы!A1',row:{release_date:'2026-10-01',release_type:'major',release_id:'REL',description:'Конфигуратор Alpha',affected_metrics:'cart'}},
    {kind:'dictionary',loc:'Справочник!A8',row:{metric_id:'cart',metric_name:'Событие корзины',comment:'Alpha: событие корзины не фиксируется'}},
    {kind:'backlog',loc:'Задачи!A7',row:{task_id:'Z-12',title:'Разметка Alpha',linked_metric_ids:'cart',created_date:day(100),status:'New'}},
    {kind:'interview',loc:'Интервью!B7',row:{excerpt:'Участник прошёл оплату.',product:'Alpha',hypothesis:'ошибка оплаты',relation:'опровергает'}},
    {kind:'interview',loc:'Интервью!B8',row:{excerpt:'Участник столкнулся со сбоем оплаты.',product:'Alpha',hypothesis:'ошибка оплаты',relation:'подтверждает',date:day(155)}},
  ];
  importDocs(store,[{file:'Workbook.xlsx',facts}],{notify:false});
  db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run('c','Alpha','Проверить Alpha','Исследуем',JSON.stringify(body));
  const run = {caseId:'c',question:'Проверить оплату Alpha'};
  return {store,db,run};
}

test('absolute sales signal without a linked release uses signal dates', t=>{
  const signal = {rule:'absolute', start:'2026-10-05', week:'2026-10-12', threshold:100};
  const {db,run} = setup(t, {signal});
  const capture = captureInvestigation(db,run);
  assert.equal(capture.measurable,true);
  assert.equal(capture.context.calculation.latest.from,signal.start);
  assert.equal(capture.context.calculation.release,undefined);
  const linked = captureInvestigation(db,{...run,signal:{...signal,releaseId:'REL'}});
  assert.equal(linked.context.calculation.release.data.release_date,'2026-10-01');
  const empty = captureInvestigation(db,{...run,signal:{...signal,start:day(0),week:day(7)}});
  assert.equal(empty.measurable,false);
  assert.ok(empty.reason);
});

test('sales capture compares the same complete weeks, pins workbook cells, counterevidence and full values', t=>{
  const {db,run} = setup(t);
  const c = captureInvestigation(db,run);
  assert.equal(c.measurable,true);
  assert.match(c.period,/2026-06-29.*2026-09-27.*2026-10-05.*2026-11-15/);
  assert.match(c.summary,/43,75%/);
  assert.match(c.summary,/Beta.*\+5%/);
  const snap = JSON.parse(db.prepare('SELECT body FROM evidence_calcs WHERE id=?').get(c.calcId).body);
  assert.equal(snap.kind,'investigation-calculation');
  const sales = snap.findings.find(f=>f.kind==='calculation');
  assert.equal(sales.rows.length,19);
  assert.ok(sales.rows.every(r=>r.version && r.source && r.value!==499));
  assert.ok(snap.findings.some(f=>f.kind==='dictionary' && f.text.includes('не фиксируется')));
  assert.ok(snap.findings.some(f=>f.relation==='опровергает' && f.text.includes('прошёл')));
  assert.ok(!snap.findings.some(f=>f.source?.endsWith('Интервью!B8')));
  assert.equal(c.calcId,captureInvestigation(db,run).calcId);
  assert.ok(c.checks.every(check=>check.role==='calculation'));
});

test('KPI signal uses its frozen weighted counts and units, even if the same product has sales', t=>{
  const signal={metric:'lk_reco_ctr',title:'CTR',segment:'all',baselineFrom:day(0),baselineThrough:day(27),
    week:day(35),baseN:40,baseD:400,baseValue:10,n:3,d:100,value:3,change:-70,changeUnit:'%',source:'CTR!A9'};
  const {db,run}=setup(t,{signal});
  const c=captureInvestigation(db,run);
  assert.equal(c.unit,'%'); assert.match(c.summary,/40\s*\/\s*400/); assert.match(c.summary,/3\s*\/\s*100/);
  assert.doesNotMatch(c.summary,/индекс/); assert.match(c.period,/2026-06-29.*2026-08-09/);
});

test('a manual KPI without observations stays unavailable and never falls back to sales',t=>{
  const {db,run}=setup(t,{owner:'pm',plan:{measurement:{metric:'cfg_completion_rate',product:'Alpha',segment:'mobile'}}});
  const c=captureInvestigation(db,{...run,owner:'pm'});
  assert.equal(c.measurable,false); assert.equal(c.unit,'%'); assert.doesNotMatch(c.summary,/43,75/);
});

test('weighted KPI comparison keeps matching control dates and device mix evidence', t=>{
  const measurement={metric:'cfg_completion_rate',product:'Alpha',segment:'all',control:'Beta'};
  const {db,run,store}=setup(t,{release:'REL',plan:{measurement,from:day(84),through:day(104)}});
  const metrics=[];
  for (const after of [false,true]) {
    for (let i=0;i<7;i++) {
      for (const [product,segment,n,d] of [
        ['Alpha','mobile',after?5:20,after?20:80], ['Alpha','desktop',after?40:10,after?80:20], ['Beta','all',40,100],
      ]) {
        metrics.push({kind:'metrics',loc:'KPI!A'+(metrics.length+2),row:{metric_id:measurement.metric,product,segment,
          date:day((after?98:84)+i),unit:'ratio',numerator:n,denominator:d,value:n/d}});
      }
    }
  }
  importDocs(store,[{file:'Metric.xlsx',facts:metrics}],{notify:false});
  const c=captureInvestigation(db,run);
  assert.equal(c.measurable,true);
  assert.match(c.summary,/30% \(210 \/ 700\) → 45% \(315 \/ 700\) \(\+15 п.п.\)/);
  assert.match(c.summary,/Контроль · Beta.*40% .*→ 40%/);
  const mobile=c.context.findings.find(f=>f.label==='Телефоны');
  assert.equal(mobile.change,0);
  assert.equal(mobile.baseD,560);
  assert.equal(mobile.d,140);
  assert.ok(mobile.rows.every(r=>r.unit==='ratio' && r.source && r.version));
});

test('an alternative inherits frozen periods and operational sources and records lookup for a new question', t=>{
  const {db,run,store}=setup(t);
  const parentCapture=captureInvestigation(db,{...run,id:'parent'});
  importDocs(store,[{file:'Sheet.xlsx',facts:[
    {kind:'sales',loc:'Other!A1',row:{product_family:'Alpha',week_start:day(7*19),orders_index:999}},
    {kind:'dictionary',loc:'Other!A2',row:{metric_id:'cart',metric_name:'Позднее определение',comment:'Поздняя правка.'}},
  ]}],{notify:false});
  const c=captureInvestigation(db,{...run,id:'child',question:'Замедлилась загрузка страницы Alpha?',parentCapture});
  assert.notEqual(c.calcId,parentCapture.calcId);
  assert.equal(c.summary,parentCapture.summary);
  assert.ok(c.context.findings.some(f=>f.kind==='dictionary' && f.source.endsWith('Справочник!A8')));
  assert.ok(c.context.findings.some(f=>f.kind==='lookup' && f.topicKind==='interview' && f.status==='empty'));
});

const call = (name,args) => ({id:'call',type:'function',function:{name,arguments:JSON.stringify(args)}});
const response = calls => ({ok:true,json:async()=>({choices:[{message:{role:'assistant',tool_calls:calls}}],
  usage:{prompt_tokens:4,completion_tokens:2}})});

test('each investigation role sends concise field limits with its initial model request', async t => {
  const capture = {calcId:'test-calc',context:{findings:[{id:'observations',kind:'calculation',text:'Снимок'}]}};
  const check = {question:'Почему?',result:'Расчёт',impact:'Вывод',findingIds:['observations']};
  const decision = {summary:'Объяснение',action:'Проверить',plan:'Проверить процесс',
    outcomes:['Продолжить проверку'],hypotheses:[{title:'Гипотеза',for:[],against:[],test:'Сверить'}]};
  for (const [stage, submit] of [
    ['analyst','submit_check'], ['researcher','submit_check'], ['lead','submit_decision'], ['reviewer','submit_review'],
  ]) await t.test(stage, async () => {
    const requests = [];
    const send = async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return requests.length === 1 ? response([call('read_findings',{ids:['observations']})])
        : response([call(submit, submit === 'submit_check' ? check : {...check,decision})]);
    };
    await runInvestigationStage({env, stage, send, run:{question:'Почему?'}, capture});
    assert.equal(requests.length, 2);
    const {messages,tools} = requests[0];
    assert.equal(messages[0].role, 'system');
    assert.match(messages[0].content, /пиши кратко/iu);
    const {properties} = tools.find(tool => tool.function.name === submit).function.parameters;
    for (const [field, maxLength] of [['question',300], ['result',1200], ['impact',700]]) {
      assert.equal(properties[field].maxLength, maxLength);
      assert.ok(messages[0].content.includes(`${field} — не более ${maxLength} символов`));
    }
  });
});

test('lead corrects an invalid decision in the same attempt, using only evidence already returned', async () => {
  const findings = ['observations','control'].map(id => ({id,kind:'calculation',label:id,text:'Снимок'}));
  const capture = {context:{findings}, calcId:'test-calc', checks:[]};
  const decision = {summary:'Объяснение',action:'Проверить',plan:'Проверить процесс',
    outcomes:['Продолжить проверку'],hypotheses:[{title:'Гипотеза',for:[],against:[],test:'Сверить'}]};
  const payload = {question:'Почему?',result:'Расчёт',impact:'Вывод',findingIds:['control'],decision};
  const requests = [];
  const send = async (_url,init) => {
    const body = JSON.parse(init.body);
    requests.push(body);
    switch (requests.length) {
      case 1: return response([call('read_findings',{ids:['observations']})]);
      case 2: return response([call('submit_decision',{...payload,decision:{...decision,summary:'я'.repeat(1001)}})]);
      case 3: {
        const feedback=body.messages.at(-1);
        assert.equal(feedback.role,'tool');
        assert.match(feedback.content,/decision\.summary/);
        assert.match(feedback.content,/1000/);
        // Both calls were generated before the model saw the requested control finding.
        return response([{...call('read_findings',{ids:['control']}),id:'read-control'},
          {...call('submit_decision',payload),id:'too-early'}]);
      }
      case 4: {
        const replies=body.messages.slice(-2);
        assert.deepEqual(replies.map(m=>[m.role,m.tool_call_id]),[['tool','read-control'],['tool','too-early']]);
        assert.equal(JSON.parse(replies[0].content)[0].id,'control');
        assert.match(replies[1].content,/источник|свидетельств/i);
        return response([call('submit_decision',payload)]);
      }
      default: assert.fail('unexpected extra model call');
    }
  };
  const out=await runInvestigationStage({env,stage:'lead',send,run:{question:'Почему?'},capture});
  assert.equal(requests.length,4);
  assert.deepEqual(out.check.sources.map(s=>s.findingId),['control']);
  assert.equal(out.usage.calls,4);
});

test('exhausted corrections preserve a safe field-level failure and the original call limit',async t=>{
  const {db,run}=setup(t),capture=captureInvestigation(db,run);
  let calls=0;
  const secret='PRIVATE-MODEL-TEXT ';
  const send=async()=> ++calls===1 ? response([call('read_findings',{ids:[capture.context.findings[0].id]})])
    : response([call('submit_check',{question:'Что?',impact:'Вывод',result:secret.repeat(100),findingIds:[capture.context.findings[0].id]})]);
  await assert.rejects(runInvestigationStage({env,stage:'analyst',send,run,capture}),error=>{
    const reason=failureReason(error);
    assert.match(reason,/result/);
    assert.match(reason,/1200/);
    assert.ok(!reason.includes(secret));
    assert.equal(error.usage.calls,5);
    return error.invalidModelResponse===true;
  });
  assert.equal(calls,5);
});

test('model must read the scoped tools, then cite inspected findings; reviewer has the draft and can change it',async t=>{
  const {db,run}=setup(t),capture=captureInvestigation(db,run);
  const f=capture.context.findings.find(f=>f.kind==='dictionary'),m=capture.context.findings.find(f=>f.kind==='calculation');
  const task=capture.context.findings.find(f=>f.kind==='backlog');
  assert.equal(f.measurementGap,true);
  const prior=[{check:{role:'lead',result:'Проект решения',sources:[]},result:{action:'Исправить оплату'}}];
  const requests=[];
  let rawTelemetry=true;
  const send=async(url,request)=>{
    const body=JSON.parse(request.body); requests.push(body);
    return requests.length===1 ? response([call('read_findings',{ids:[f.id,m.id,task.id]})]) : response([call('submit_review',{
      question:'Можно ли рекомендовать исправление?',result:'Доступно измерение, причина пока не установлена.',
      impact:'Сначала сопоставить действие и событие.',findingIds:[f.id,m.id],
      decision:{summary:'Изменился индекс Alpha.',action:'Исправить разметку.',plan:'Пройти оплату и сверить запись.',
        outcomes:['Отсутствие события при успешной оплате укажет на ошибку учёта.'],
        hypotheses:[{title:'Потеря события',for:[{id:f.id,text:'Справочник фиксирует ограничение.'}],
          against:[{id:m.id,text:'Одного изменения индекса недостаточно для вывода о причине.'}],test:'Сопоставить оплату и событие.'}],
        issueSourceKey:'Z-12',issueQuery:'Разметка Alpha',verification:{findingId:f.id,
          scenario:'Пройти оплату Alpha на телефоне',behavior:'наличие заказа после оплаты',
          telemetry:rawTelemetry ? 'регистрацию события оплаты в аналитике' : 'событие cfg_add_to_cart_rate в Метрике',
          eventMissing:'Восстановить регистрацию успешных оплат.',
          behaviorFailed:'Записать условия сбоя оплаты.',bothPassed:'Расширить проверку на компьютер.'}},
    })]);
  };
  const out=await runInvestigationStage({stage:'reviewer',env,send,run,capture,prior});
  assert.equal(requests.length,2); assert.match(JSON.stringify(requests[0].messages),/Исправить оплату/);
  assert.equal(out.check.role,'reviewer'); assert.equal(out.check.sources[0].findingId,f.id);
  assert.match(out.result.action,/оплату Alpha.*одном прогоне.*наличие заказа.*события оплаты/);
  assert.equal(out.result.outcomes.length,3);
  assert.equal(out.result.issueSourceKey,'Z-12');
  assert.equal(out.result.issueQuery,'Разметка Alpha');
  assert.equal(out.result.hypotheses[0].for[0],'Справочник фиксирует ограничение.');
  assert.equal(out.result.hypotheses[0].sourceRefs.against[0].findingId,m.id);
  assert.deepEqual(out.usage,{input:8,output:4,calls:2});
  assert.ok(requests.every(r=>r.tools.every(t=>!/(draft|publish|shell|fetch)/.test(t.function.name))));
  requests.length=0;
  rawTelemetry=false;
  await assert.rejects(runInvestigationStage({stage:'reviewer',env,send,run,capture,prior}),/исходное событие/);
});

test('unread evidence and out-of-scope transport are rejected',async t=>{
  const {db,run}=setup(t),capture=captureInvestigation(db,run);
  let sent=0;
  const send=async()=>++sent===1 ? response([call('read_findings',{ids:[capture.context.findings[0].id]})])
    : response([call('submit_check',{question:'Какие есть данные?',result:'Проверено.',impact:'Уточнить.',findingIds:['fabricated']})]);
  for(const overrides of [{DATA_PROFILE:'local'},{LLM_DATA_MODE:'selection'}])
    await assert.rejects(runInvestigationStage({stage:'analyst',env:{...env,...overrides},send,run,capture,prior:[]}));
  assert.equal(sent,0);
  await assert.rejects(runInvestigationStage({stage:'analyst',env,send,run,capture,prior:[]}),/источник|свидетельств|основан/i);
});

test('model streaming body failures keep transport and invalid JSON categories',async ()=>{
  const adapters=[env,{...env,LLM_BACKEND:'gemini',LLM_API_KEY:'fixture'}];
  for(const model of adapters) {
    const dropped=async()=>new Response(new ReadableStream({start(c){c.error(new TypeError('connection reset'));}}));
    await assert.rejects(providerCall(model,[],[],'auto',dropped),error=>error.retryable===true && !error.timedOut);
    await assert.rejects(providerCall(model,[],[],'auto',async()=>new Response('{')),error=>error.invalidModelResponse===true);
    const slow=async(_url,{signal})=>new Response(new ReadableStream({start(c){
      signal.addEventListener('abort',()=>c.error(signal.reason),{once:true});
    }}));
    const pin=setTimeout(()=>{},1000);
    try {
      await assert.rejects(providerCall(model,[],[],'auto',slow,{timeout:5}),error=>error.timedOut===true);
    } finally { clearTimeout(pin); }
  }
});

test('malformed provider tool calls are reported as an invalid model response',async t=>{
  const {db,run}=setup(t), capture=captureInvestigation(db,run);
  const read = call('read_findings',{ids:[capture.context.findings[0].id]});
  for(const calls of [[null],[{}],{length:1},[{function:read.function}],[read,read]]) {
    let requests=0;
    await assert.rejects(runInvestigationStage({env,stage:'analyst',run,capture,send:async()=>{requests++;return response(calls);}}),
      error=>error.invalidModelResponse===true);
    assert.equal(requests,1,'malformed calls cannot be paired with correction messages');
  }
});
