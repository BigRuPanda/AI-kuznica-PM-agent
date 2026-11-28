import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv';

const endpoint = 'https://anymodel.org/v1/chat/completions';
const sorted = values => [...new Set(values)].sort();
const expectedTools = scenario => [...scenario.tools,...(scenario.requiredTools || [])];
const validators = new Map();
const ajv = new AjvJsonSchemaValidator();
function validate(schema, input) {
  const key = JSON.stringify(schema);
  if (!validators.has(key)) validators.set(key, ajv.getValidator(schema));
  return validators.get(key)(input);
}
function parse(value) {
  try { return JSON.parse(value); } catch { return undefined; }
}
function scrub(value, env) {
  let s = String(value);
  for (const [k,v] of Object.entries(env)) if (/key|token|password|secret/i.test(k) && v) s=s.replaceAll(v,'[redacted]');
  return s.replace(/Bearer\s+[^\s"']+/gi,'[redacted]').slice(0,1200);
}
function evidenceValue(value,env) {
  if (Array.isArray(value)) return value.slice(0,40).map(v=>evidenceValue(v,env));
  if (value && typeof value==='object') return Object.fromEntries(Object.entries(value).slice(0,60)
    .map(([k,v])=>[k,/password|secret|authorization|api.?key|token|cookie/i.test(k)?'[redacted]':evidenceValue(v,env)]));
  return typeof value==='string'?scrub(value,env):value;
}
export async function runAttempt(scenario, attempt, env, transport) {
  const question = scenario.prompts[attempt-1];
  const start = performance.now();
  const calls = [], mismatches = [], selected = new Set(), exposed = new Set(), signatures = new Set();
  const denied = [];
  const problem = message => {
    const safe = scrub(message,env);
    if (!mismatches.includes(safe)) mismatches.push(safe);
  };
  const send = async (url, options) => {
    if (String(url) !== endpoint || options?.method !== 'POST') {
      denied.push('outbound request');
      problem('Unexpected destination or method');
      throw Error('Outbound request blocked');
    }
    const since = performance.now(), req = JSON.parse(options.body);
    const tools = new Map((req.tools||[]).map(t=>[t.function.name,t.function.parameters]));
    const choice = req.tool_choice || 'auto';
    const forced = typeof choice === 'object' || choice === 'required' && tools.size === 1;
    const call = {round:calls.length+1,advertised:[...tools.keys()],choice,maxOutputTokens:req.max_tokens??null,tools:[],usage:{}};
    calls.push(call);
    for (const name of tools.keys()) exposed.add(name);
    if (scenario.local) problem('Expected local execution with zero model calls');
    const signature = createHash('sha256').update(options.body).digest('hex');
    if (signatures.has(signature)) problem('Provider request retry');
    signatures.add(signature);
    const pending=new Set();
    for (const msg of req.messages || []) {
      if (msg.role==='assistant') for(const tool of msg.tool_calls||[]) pending.add(tool.id);
      if (msg.role==='tool' && !pending.delete(msg.tool_call_id)) problem('Unmatched tool result ID');
      const payload = parse(msg.content);
      if (msg.role === 'tool' && payload?.error) problem('Tool result error: '+payload.error);
      if (msg.role === 'user' && (payload?.correction || payload?.validationError) ||
          msg.role === 'system' && msg.content?.includes('Дай содержательный ответ на текущий вопрос'))
        problem('Internal correction');
    }
    if (pending.size) problem('Unanswered tool calls in provider request');
    try {
      const response = await transport(url,{...options,redirect:'error'});
      call.http = response.status;
      if (!response.ok) problem('Provider HTTP '+response.status);
      else {
        const data = await response.clone().json().catch(e=>{
          if (options.signal?.aborted || ['TimeoutError','AbortError'].includes(e.name)) throw e;
          return null;
        });
        const reply = data?.choices?.[0], message = reply?.message;
        call.responseText = typeof message?.content==='string' ? scrub(message.content,env) : null;
        call.finish = reply?.finish_reason;
        call.usage = {input:data?.usage?.prompt_tokens??null,output:data?.usage?.completion_tokens??null,
          reasoning:data?.usage?.completion_tokens_details?.reasoning_tokens??null};
        if (!message || !Array.isArray(message.tool_calls ?? []) ||
            (!message.tool_calls?.length && !message.content?.trim?.()))
          problem('Malformed or empty model response');
        if (call.finish === 'length' || call.finish === 'content_filter') problem('Incomplete response: '+call.finish);
        const ids = new Set();
        for (const item of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
          const name = item?.function?.name;
          const args = parse(item?.function?.arguments);
          const schema = tools.get(name);
          const valid = schema && args !== undefined && validate(schema,args).valid;
          const id = item?.id;
          if (!id || typeof id !== 'string' || ids.has(id)) problem('Missing or duplicate tool call ID');
          ids.add(id);
          if (!schema || item?.type !== 'function') problem('Unknown or malformed tool call: '+name);
          if (!valid) problem('Invalid arguments for '+name);
          call.tools.push({name,id,valid:!!valid,forced,arguments:evidenceValue(args,env),argumentKeys:Object.keys(args||{}),
            argumentHash:createHash('sha256').update(JSON.stringify(args??null)).digest('hex')});
          if (!forced && name) selected.add(name);
          if (forced && ![...(scenario.forcedTools || []),...(scenario.requiredTools || [])].includes(name))
            problem('Unexpected forced selection: '+name);
        }
      }
      return response;
    } catch (e) {
      call.timeout = options.signal?.aborted || e.name === 'TimeoutError' || e.name === 'AbortError';
      problem(call.timeout ? 'Provider timeout' : 'Provider transport error: '+e.message);
      throw e;
    } finally { call.wallMs=Math.round(performance.now()-since); }
  };
  let receipt;
  try { receipt = await scenario.run({question,attempt,env,send}); }
  catch (e) { if(e.receipt) receipt=e.receipt; problem(e.message || e); }
  if (!scenario.local && !calls.length) problem('Expected model execution, no model call');
  for (const name of scenario.tools) if (!selected.has(name)) problem('Missing natural tool selection: '+name);
  for (const name of scenario.requiredTools || []) if (!calls.some(c=>c.tools.some(t=>t.name===name && t.valid)))
    problem('Missing required submission: '+name);
  for (const name of scenario.forcedTools || []) if (!calls.some(c=>c.tools.some(t=>t.name===name && t.forced && t.valid)))
    problem('Missing required application-forced tool: '+name);
  return {id:scenario.id,family:scenario.family,attempt,question,status:mismatches.length?'failed':'passed',
    expected:expectedTools(scenario),expectedLocal:!!scenario.local,wallMs:Math.round(performance.now()-start),
    exposed:sorted(exposed),selected:sorted(selected),calls,denied,receipt:evidenceValue(receipt,env),
    firstMismatch:mismatches[0]??null,mismatches};
}

export function coverage(scenarios,results) {
  const families={};
  for (const family of sorted(scenarios.map(s=>s.family))) {
    const cases=scenarios.filter(s=>s.family===family), rows=results.filter(r=>r.family===family);
    const expected=sorted(cases.flatMap(expectedTools)), bookkeeping=sorted(cases.flatMap(s=>s.forcedTools||[]));
    const exposed=sorted(rows.flatMap(r=>r.exposed)), selected=sorted(rows.flatMap(r=>r.selected));
    const verified=sorted(cases.filter(s=>[1,2,3].every(attempt=>
      rows.some(r=>r.id===s.id && r.attempt===attempt && r.status==='passed'))).flatMap(expectedTools));
    families[family]={expected,bookkeeping,exposed,selected,verified,
      unexpected:exposed.filter(n=>!expected.includes(n)&&!bookkeeping.includes(n)),
      missing:expected.filter(n=>!verified.includes(n))};
  }
  return {families};
}

function statistics(rows) {
  const calls=rows.flatMap(r=>r.calls), durations=rows.map(r=>r.wallMs).sort((a,b)=>a-b);
  const percentile=p=>durations[Math.ceil(p*durations.length)-1]??null;
  return {attempted:rows.length,passed:rows.filter(r=>r.status==='passed').length,
    failed:rows.filter(r=>r.status==='failed').length,modelCalls:calls.length,
    toolCalls:calls.reduce((n,c)=>n+c.tools.length,0),timeouts:calls.filter(c=>c.timeout).length,
    p50AttemptMs:percentile(.5),p95AttemptMs:percentile(.95),
    inputTokens:calls.reduce((n,c)=>n+(c.usage.input??0),0),outputTokens:calls.reduce((n,c)=>n+(c.usage.output??0),0),
    callsWithoutUsage:calls.filter(c=>c.usage.input==null||c.usage.output==null).length};
}

export function combineReports(scenarios, reports) {
  if (!reports.length) throw Error('No model reports supplied');
  const first=reports[0];
  for (const report of reports) {
    if (report.status==='running' || report.total!==report.results.length) throw Error('Incomplete component report: '+report.runId);
    for (const key of ['head','runtimeDiffSha256','productionFingerprint','model']) {
      if (!first[key] || report[key]!==first[key]) throw Error('Mismatched fingerprint: '+key);
    }
  }
  const cases=new Map(scenarios.map(s=>[s.id,s])), seen=new Set(), results=[];
  for (const report of reports) for (const row of report.results) {
    const scenario=cases.get(row.id), key=row.id+'#'+row.attempt;
    if (!scenario || ![1,2,3].includes(row.attempt) || scenario.prompts[row.attempt-1]!==row.question ||
      JSON.stringify(expectedTools(scenario))!==JSON.stringify(row.expected) || scenario.family!==row.family)
      throw Error('Scenario does not match the catalog: '+key);
    if (seen.has(key)) throw Error('Duplicate attempt: '+key);
    seen.add(key);
    results.push(row);
  }
  if (seen.size!==scenarios.length*3) throw Error('Missing attempts: '+(scenarios.length*3-seen.size));
  const {families}=coverage(scenarios,results);
  const blocked=Object.entries(families).flatMap(([f,v])=>[...v.unexpected.map(n=>f+': unplanned '+n),...v.missing.map(n=>f+': unverified '+n)]);
  const failed=results.find(r=>r.status!=='passed');
  return {synthetic:true,scope:'full',status:failed || blocked.length?'failed':'passed',
    model:first.model,head:first.head,runtimeDiffSha256:first.runtimeDiffSha256,productionFingerprint:first.productionFingerprint,
    components:reports.map(r=>r.runId),total:results.length,statistics:statistics(results),families,blocked,firstMismatch:failed?.firstMismatch||blocked[0]||null,results};
}

export async function firstPass(opts) {
  if (opts.lane && !['workspace','nonworkspace'].includes(opts.lane)) throw Error('Unknown acceptance lane');
  const { workspaceCases } = opts.lane==='nonworkspace' || opts.family && opts.family!=='workspace' ? {workspaceCases:[]} : await import('./cases-workspace.mjs');
  const { nonWorkspaceCases } = opts.lane==='workspace' || opts.family==='workspace' ? {nonWorkspaceCases:[]} : await import('./cases-nonworkspace.mjs');
  const cases=[...nonWorkspaceCases,...workspaceCases];
  if (new Set(cases.map(c=>c.id)).size !== cases.length || cases.some(c=>c.prompts?.length!==3 || new Set(c.prompts).size!==3))
    throw Error('Each case needs a unique ID and three distinct prompts');
  const model='qwen/qwen3.8-27b';
  if (opts.model && opts.model!==model) throw Error('First-pass acceptance requires '+model);
  const env={LLM_BACKEND:'anymodel',LLM_MODEL:model,...(process.env.PYTHON_BIN && {PYTHON_BIN:process.env.PYTHON_BIN}),
    ANYMODEL_API_KEY:process.env.ANYMODEL_API_KEY,LLM_DATA_MODE:'analysis',DATA_PROFILE:'configured',
    NOTIFICATIONS_ENABLED:'false',NOTIFICATION_CHANNELS:''};
  const chosen=cases.filter(s=>(!opts.family || s.family===opts.family) && (!opts.case || s.id===opts.case));
  if (!chosen.length) throw Error('Unknown acceptance case');
  if (Object.hasOwn(opts,'list')) {console.log(chosen.map(s=>s.id+' '+s.family+' '+s.tools.join(',')).join('\n'));return;}
  const attempts=opts.attempt ? [Number(opts.attempt)] : [1,2,3];
  if (attempts.some(a=>![1,2,3].includes(a))) throw Error('Attempt must be 1, 2, or 3');
  const dir=resolve(opts.out || 'var/acceptance/2026-11-28-anymodel');
  await mkdir(dir,{recursive:true});
  const runId = new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8);
  const file=join(dir,'model-'+runId+'.json');
  if (opts.combine) {
    if(opts.lane||opts.family||opts.case||opts.attempt) throw Error('Use the complete catalog when combining reports');
    const reports=await Promise.all(opts.combine.split(',').map(async p=>JSON.parse(await readFile(resolve(p),'utf8'))));
    const summary={runId,...combineReports(cases,reports)};
    await writeFile(file,JSON.stringify(summary,null,2)+'\n',{flag:'wx'});
    console.log('Combined '+summary.total+' attempts: '+summary.status+'\n'+file);
    if(summary.status!=='passed') process.exitCode=1;
    return;
  }
  if (!env.LLM_MODEL || !env.ANYMODEL_API_KEY) throw Error('Missing AnyModel configuration');
  const results=[], full=!opts.case&&!opts.attempt&&!opts.family, total=chosen.length*attempts.length;
  const runtimeHash=createHash('sha256');
  for (const path of (await readdir('server',{recursive:true})).filter(p=>/\.mjs$/.test(p)).sort()) {
    runtimeHash.update(path).update(await readFile(join('server',path)));
  }
  const productionFingerprint=runtimeHash.digest('hex');
  const head=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  const runtimeDiffSha256=createHash('sha256').update(execFileSync('git',['diff','--binary','--no-ext-diff','HEAD','--',
    'server','web','integrations','package.json','pnpm-lock.yaml','telegram.mjs'],{maxBuffer:80*1024*1024})).digest('hex');
  const transport = globalThis.fetch;
  globalThis.fetch = () => {throw Error('Use the isolated acceptance transport');};
  const checkpoint=async()=>{
    const {families}=coverage(cases,results), completed=results.length===total;
    const blocked=Object.entries(families).flatMap(([f,x])=>[...x.unexpected.map(t=>f+': unplanned '+t),...x.missing.map(t=>f+': unverified '+t)]);
    const passed=completed && results.every(r=>r.status==='passed') && (!full||!blocked.length);
    const report={runId,synthetic:true,model:env.LLM_MODEL,scope:full?(opts.lane||'full'):'filtered',total,productionFingerprint,head,runtimeDiffSha256,
      status:completed?(passed?'passed':'failed'):'running',statistics:statistics(results),families,blocked,
      firstMismatch:results.find(r=>r.firstMismatch)?.firstMismatch || (full && completed ? blocked[0]:null) || null,results};
    await writeFile(file+'.tmp',JSON.stringify(report,null,2)+'\n');
    await rename(file+'.tmp',file);
    return passed;
  };
  console.log('Acceptance report '+file);
  try {
    await checkpoint();
    for (const scenario of chosen) for (const attempt of attempts) {
      const r=await runAttempt(scenario,attempt,env,transport);
      results.push(r);
      console.log('['+results.length+'/'+total+'] '+r.id+' #'+attempt+' '+r.status+(r.firstMismatch?' — '+r.firstMismatch:''));
      await checkpoint();
    }
    if (!await checkpoint()) process.exitCode=1;
  } finally { globalThis.fetch=transport; }
}
