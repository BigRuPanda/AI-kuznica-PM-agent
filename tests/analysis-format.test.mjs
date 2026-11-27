import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisEvidence, composeAnalysis } from '../server/analysis-composer.mjs';
import { providerCall } from '../server/agent.mjs';

const env = {LLM_BACKEND:'proxyapi',LLM_MODEL:'qwen/qwen3.7-flash',PROXYAPI_API_KEY:'fixture',LLM_DATA_MODE:'analysis'};
const source = {version:'a'.repeat(64),file:'synthetic.xlsx',loc:'Индекс!A2'};
const context = {scope:{product:'Synthetic'},request:'Проверить индекс',
  evidence:[{id:'index',kind:'orders-index',data:{mean:80},sources:[source]}]};
const valid = {title:null,observations:[{text:'Индекс составил 80.',sources:['index']}],
  hypotheses:[],recommendations:[],missing:[]};
const reply = (content, finish_reason = 'stop') => Response.json({choices:[{message:{content},finish_reason}]});

test('release analysis requests a strict JSON schema and resolves a valid observation', async () => {
  let request;
  const result = await composeAnalysis(context,env,async (_url,{body})=>{
    request = JSON.parse(body);
    return reply(JSON.stringify(valid));
  });
  const format = request.response_format;
  assert.equal(request.reasoning_effort,'low');
  assert.equal(request.max_tokens,100_000);
  assert.equal(format.type,'json_schema');
  assert.equal(format.json_schema.strict,true);
  const schema = format.json_schema.schema;
  assert.equal(schema.additionalProperties,false);
  assert.ok(schema.required.includes('title') && schema.required.includes('missing'));
  assert.deepEqual(schema.properties.hypotheses.items.required,['text','test','sources']);
  assert.deepEqual(schema.$defs.sourceId.enum,['index']);
  assert.equal(schema.properties.observations.items.properties.sources.items.$ref,'#/$defs/sourceId');
  assert.deepEqual(JSON.parse(request.messages[1].content).evidence,[{id:'index',kind:'orders-index',data:{mean:80}}]);
  assert.deepEqual(result.observations[0].sources,[source]);
});

test('short evidence labels are stable and differ between snapshots', () => {
  const items = [{kind:'metric',data:{percent:59.7},sources:[source]}];
  const scope = {releaseId:'R-09',through:'2026-11-09'};
  const first = analysisEvidence(scope,items);
  assert.match(first[0].id,/^1-[a-f0-9]{12}$/u);
  assert.deepEqual(analysisEvidence(scope,items),first);
  assert.notEqual(analysisEvidence({...scope,through:'2026-11-10'},items)[0].id,first[0].id);
  assert.notEqual(analysisEvidence(scope,[{...items[0],sources:[{...source,loc:'Индекс!A3'}]}])[0].id,first[0].id);
});

test('an interrupted structured answer is retried once with the same evidence and a shared deadline', async t => {
  const timeouts = [], requests = [];
  t.mock.method(AbortSignal,'timeout',ms=>{timeouts.push(ms);return new AbortController().signal;});
  t.mock.method(console,'warn',()=>{});
  const result = await composeAnalysis(context,env,async (_url,{body})=>{
    requests.push(JSON.parse(body));
    return requests.length === 1 ? reply(null,'length') : reply(JSON.stringify(valid));
  });
  assert.equal(requests.length,2);
  assert.deepEqual(requests[0].response_format,requests[1].response_format);
  assert.match(JSON.stringify(requests[1].messages),/index/);
  assert.ok(timeouts[0] <= 600000 && timeouts[0] > 590000);
  assert.ok(timeouts[1] <= timeouts[0]);
  assert.deepEqual(result.observations[0].sources,[source]);
});

test('two malformed replies produce a format failure and do not disclose their content in logs', async t => {
  const logs = [];
  t.mock.method(console,'warn',(...args)=>logs.push(args));
  let calls = 0;
  await assert.rejects(composeAnalysis(context,env,async ()=>{
    calls++;
    return reply(JSON.stringify({...valid,observations:[{text:'private example',citations:['index']}]}));
  }), /структур/);
  assert.equal(calls,2);
  assert.match(JSON.stringify(logs),/observations/);
  assert.doesNotMatch(JSON.stringify(logs),/private example/);
});

test('a reply with a foreign source is rejected and corrected using the same catalog', async t => {
  const requests = [];
  t.mock.method(console,'warn',()=>{});
  const result = await composeAnalysis(context,env,async (_url,{body})=>{
    requests.push(JSON.parse(body));
    const report = requests.length === 1 ? {...valid,observations:[{...valid.observations[0],sources:['foreign']}]} : valid;
    return reply(JSON.stringify(report));
  });
  assert.equal(requests.length,2);
  assert.deepEqual(requests[1].messages[1],requests[0].messages[1]);
  assert.match(requests[1].messages[0].content,/Используй id из массива evidence/u);
  assert.doesNotMatch(JSON.stringify(requests[1]),/foreign/u);
  assert.deepEqual(result.observations[0].sources,[source]);
});

test('a reply with an unsupported quantity is retried with qualitative observations', async t => {
  const requests = [];
  t.mock.method(console,'warn',()=>{});
  const qualitative = 'Значение индекса рассчитано по сохранённой строке.';
  const result = await composeAnalysis(context,env,async (_url,{body})=>{
    requests.push(JSON.parse(body));
    const text = requests.length === 1 ? 'Индекс составил 200.' : qualitative;
    return reply(JSON.stringify({...valid,observations:[{...valid.observations[0],text}]}));
  });
  assert.equal(requests.length,2);
  assert.deepEqual(requests[1].response_format,requests[0].response_format);
  assert.match(requests[1].messages[0].content,/наблюдения словами без цифр/u);
  assert.deepEqual(requests[1].messages[1],requests[0].messages[1]);
  assert.deepEqual(result.observations,[{text:qualitative,sources:[source]}]);
});

test('a repair uses the observations that passed validation and synthesizes the other sections again', async t => {
  const requests = [];
  t.mock.method(console,'warn',()=>{});
  const hypothesis = {text:'Возможны различия между сегментами.',test:'Сравнить одинаковые периоды по сегментам.',sources:['index']};
  const result = await composeAnalysis(context,env,async (_url,{body})=>{
    requests.push(JSON.parse(body));
    if (requests.length === 1) return reply(JSON.stringify({...valid,observations:[...valid.observations,
      {text:'Индекс составил 200.',sources:['index']}]}));
    const second = JSON.parse(requests[1].messages[1].content);
    assert.deepEqual(second.verifiedObservations,valid.observations);
    assert.doesNotMatch(JSON.stringify(second),/200/u);
    assert.equal(requests[1].response_format.json_schema.schema.properties.observations,undefined);
    return reply(JSON.stringify({title:null,hypotheses:[hypothesis],recommendations:[],missing:[]}));
  });
  assert.equal(requests.length,2);
  assert.deepEqual(result.observations,[{...valid.observations[0],sources:[source]}]);
  assert.deepEqual(result.hypotheses,[{...hypothesis,sources:[source]}]);
  assert.equal(result.omittedObservations,1);
});

test('provider default and maximum response time are ten minutes', async t => {
  const timeouts = [];
  t.mock.method(AbortSignal,'timeout',ms=>{timeouts.push(ms);return new AbortController().signal;});
  const send = async ()=>reply('ok');
  await providerCall(env,[],[],'auto',send);
  await providerCall(env,[],[],'auto',send,{timeout:900000});
  await providerCall(env,[],[],'auto',send,{timeout:32000});
  assert.deepEqual(timeouts,[600000,600000,32000]);
});
