import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { liveModelEnv } from '../server/config.mjs';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs } from '../server/evidence.mjs';
import { createThread, initWorkbench, messages, workJobs } from '../server/workbench.mjs';
import { teamTools } from '../server/team-mcp.mjs';

// The fixture has no input paths, sessions, user accounts or application database.
// Only this fixed synthetic dataset can be submitted by the live check.
export async function checkSyntheticCtr(live = false, transport = fetch) {
  const model = 'qwen/qwen3.8-27b';
  const env = {
    DATA_PROFILE: live ? 'configured' : 'local',
    LLM_DATA_MODE: 'analysis',
    LLM_MODEL: model,
    LLM_BACKEND: 'anymodel',
    ANYMODEL_API_KEY: live ? liveModelEnv.ANYMODEL_API_KEY : '',
  };
  if (live && !env.ANYMODEL_API_KEY) throw Error('Для синтетической проверки задайте ANYMODEL_API_KEY.');
  const store = openStore(':memory:');
  const api = new McpServer({name:'synthetic-ctr', version:'1'});
  const client = new Client({name:'synthetic-ctr-reviewer', version:'1'});
  const usage = [], answers = [];
  async function send(url, options) {
    assert.ok(live, 'Локальная проверка попыталась вызвать внешнюю модель');
    assert.equal(String(url), 'https://anymodel.org/v1/chat/completions');
    assert.equal(JSON.parse(options.body).model, model);
    return transport(url, options);
  }
  async function tool(name, args) {
    const reply = await client.callTool({name,arguments:args});
    if (reply.isError) throw Error(name + ': ' + reply.content[0].text);
    return JSON.parse(reply.content[0].text);
  }
  try {
    initEvidence(store.db);
    initWorkbench(store.db);
    const user = {id:'synthetic-reviewer', name:'Испытатель', role:'judge', space:'synthetic'};
    const product = 'Лунная лавка Орион';
    const metric = 'lk_reco_ctr';
    const dates = ['2026-03-02','2026-03-09','2026-03-16','2026-03-23'];
    importDocs(store,[{file:'Вымышленный источник',facts:dates.map((date,i) => {
      const n = i < 2 ? 12 : 2;
      return {kind:'metrics',loc:'W'+i,row:{date,product,metric_id:metric,segment:'all',value:n/200,
        unit:'ratio',sample_size:200,detail_json:JSON.stringify({click_visits:n,viewed_visits:200})}};
    })}],{notify:false});
    teamTools(api,store,user,env,send);
    const [clientSide,serverSide] = InMemoryTransport.createLinkedPair();
    await api.connect(serverSide);
    await client.connect(clientSide);
    const thread = createThread(store.db,user,'Вымышленный CTR');
    const c = await tool('create-case',{title:'Проверка CTR в вымышленном магазине',product});
    const chart = await tool('chart',{metric,product,segment:'all'});
    const range = await tool('range_compare',{selection:{source:'metric',calcId:chart.id,version:chart.id,
      metric,series:['all'],ranges:[
        {from:Date.parse(dates[0]),to:Date.parse(dates[2])},
        {from:Date.parse(dates[2]),to:Date.parse('2026-03-30')},
      ]}});
    const measured = range.periods.map(p=>p.series[0].value);
    assert.deepEqual(measured,[6,1]);
    assert.equal(range.differences[0].absolute, -5);
    assert.ok(range.periods.every(p => p.series[0].sources.length === 2 &&
      p.series[0].sources.every(s => s.version && s.location.startsWith('Вымышленный источник'))));
    const questions = [
      'Сравни CTR рекомендаций в выделенных периодах A и B. Укажи значения в процентах и изменение в процентных пунктах. Отдельным предложением ответь, можно ли установить причину изменения только по данным этих двух периодов.',
      'Подготовь по этому выводу один черновик новой задачи в текущем разборе. Добавь заголовок и план проверки причины снижения CTR рекомендаций. Сохрани черновик для подтверждения.',
    ];
    for(const question of questions.slice(0,live?2:1)) {
      const job = await tool('ask_workspace',{thread,caseId:c.id,question,rangeId:range.id});
      await workJobs(store,{publicUser:()=>user},env,send);
      const status = await tool('job_status',{id:job.id});
      const answer = messages(store.db,user,thread).items.at(-1).body;
      assert.equal(status.status,'done',`Шаг ${answers.length + 1}: ${answer.text}\n${(answer.steps || []).join(', ')}`);
      assert.ok(!answer.warning, answer.warning);
      usage.push(store.one('SELECT count(*) calls,coalesce(sum(input),0) inputTokens,coalesce(sum(output),0) outputTokens FROM costs WHERE job=?',job.id));
      answers.push(answer);
    }
    assert.match(answers[0].text,/6(?:[,.]0+)?\s*%/);
    assert.match(answers[0].text,/1(?:[,.]0+)?\s*%/);
    assert.match(answers[0].text,/(?:[-−]\s*5|(?:снизи\p{L}*|упал\p{L}*|падение)\s+на\s+5)(?:[,.]0+)?\s*(?:п\.?\s*п\.?|процентн\p{L}* пункт\p{L}*)/iu);
    const citesUncertainty = /гипотез|причин[^.\n]*(?:не |нельзя|провер|недостат|нужн|свер)|(?:недостат|нельзя|невозмож|нужн)[^.\n]*причин/i.test(answers[0].text);
    assert.ok(citesUncertainty,'Ответ должен обозначить предел причинного вывода. ' + answers[0].text);
    assert.equal(answers[0].rangeId, range.id);
    const draftRows = store.db.prepare('SELECT id,case_id,state,external FROM draft_actions').all();
    const drafts = draftRows.length;
    const issues = store.one('SELECT count(*) n FROM local_issues').n;
    assert.equal(drafts, live ? 1 : 0);
    assert.equal(issues,0);
    if (live) {
      assert.ok(usage.every(x=>x.calls>0 && x.inputTokens>0),'Нет подтверждённого вызова модели.');
      assert.deepEqual({...draftRows[0]}, {id:draftRows[0].id,case_id:c.id,state:'draft',external:null});
      assert.ok(answers[1].actions?.some(a => a.op === 'draft' && a.id === draftRows[0].id));
    }
    return {synthetic:true, transport:'MCP',model:live?model:'local',measuredPercent:measured,
      differencePp:range.differences[0].absolute,sourceLinked:!!range.id,citesUncertainty,drafts,issues,usage};
  } finally {
    await client.close();
    await api.close();
    store.close();
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  try {
    if(process.argv.slice(2).some(a=>a!=='--live')) throw Error('Поддерживается только --live.');
    console.log(JSON.stringify(await checkSyntheticCtr(process.argv.includes('--live')), null, 2));
  } catch(error) {
    console.error(error.message);
    process.exitCode=1;
  }
}
