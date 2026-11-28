import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { openStore } from '../../server/store.mjs';
import { initEvidence, importDocs } from '../../server/evidence.mjs';
import { initWorkbench, enqueue, workJobs, createThread, messages } from '../../server/workbench.mjs';
import { workspaceOperation } from '../../server/workspace-operations.mjs';
import { readMaterial, materialForResult } from '../../server/materials.mjs';
import { configure, personalConnection } from '../../server/tracker-connections.mjs';
import { evaluationCase } from '../eval-agent.mjs';

const ctrFile = 'Синтетическое наблюдение.xlsx';
export const causalLimit = /(?:не (?:доказ|подтвержд|установ|позвол|следует|означает|гарантиру|обязательно)|нельзя|недостаточ|требует провер|гипотез|нужн.{0,16}провер|может быть|совпадени)/iu;
export function openWorkspace(env, send, role='judge') {
  const store = openStore(':memory:');
  try {
    const {db} = store;
    const user={id:randomUUID(),name:'Марина',role,space:'acceptance'};
    initEvidence(db);
    initWorkbench(db,env);
    const {caseId,selection}=evaluationCase(store,user,env);
    const thread=createThread(db,user,'Синтетическая приёмка');
    const op=(name,args)=>workspaceOperation(store,user,name,args,env,send);
    const ctrDates=['2026-09-07','2026-09-14','2026-09-21','2026-09-28','2026-10-05','2026-10-12','2026-10-19','2026-10-26'];
    const facts=ctrDates.map((date,i)=>{
      const clicks=i<4?6:1;
      return {kind:'metrics',loc:'CTR!A'+(i+2),row:{metric_id:'lk_reco_ctr',product:'ЛК',
        segment:'desktop',date,step_days:7,unit:'ratio',value:clicks/100,
        detail_json:JSON.stringify({click_visits:clicks,viewed_visits:100})}};
    });
    facts.push({kind:'dictionary',loc:'Определения!A2',row:{metric_id:'lk_reco_ctr',metric_name:'CTR рекомендаций',
      comment:'Доля визитов с кликом среди визитов с просмотром блока.'}},
      {kind:'releases',loc:'Журнал!A2',row:{release_id:'R-71',release_type:'major',status:'выпущен',release_date:'2026-10-01',
        description:'Kaspersky: изменили выбор лицензии в конфигураторе.',affected_metrics:'family_orders_idx',related_task_ids:'QA-17'}},
      {kind:'backlog',loc:'Задачи!A2',row:{task_id:'QA-17',title:'Поисковая карточка Kaspersky Standard',
        description_short:'Проверить описание карточки и попадание в поисковую выдачу.',status:'В работе',release_id:'R-71'}});
    importDocs(store,[{file:ctrFile,facts},{file:'Спрос.xlsx',facts:[{kind:'competitor',loc:'Спрос!B8',
      text:'Kaspersky Standard есть в ассортименте Store. Запрос «купить Kaspersky Standard» — 420 поисков в месяц, Store на 18 месте, конкурент на 3 месте.'},
      {kind:'interview',loc:'Интервью!B3',text:'Kaspersky: покупатель сравнивал версии и не понял, чем отличаются лицензии.'},
      {kind:'interview',loc:'Интервью!B4',text:'Kaspersky: другой покупатель сразу выбрал лицензию, но отложил оплату из-за бюджета.'}]}],{notify:false});
    db.prepare('INSERT INTO demo_issue_details(key,data) VALUES(?,?)').run('QA-17',JSON.stringify({
      status:'В работе',statusId:'В работе',assignee:'Марина',comments:[{author:'QA',text:'Проверяем сниппет карточки.'}]}));
    db.prepare('INSERT INTO demo_pages VALUES(?,?,?,?,?)').run('DOC-7',caseId,'Регламент подсчёта CTR',
      '<p>Контрольная выборка составляет 240 визитов.</p>',4);
    const all=(sql,...params)=>db.prepare(sql).all(...params);
    const one=(sql,...params)=>db.prepare(sql).get(...params);
    const inspectCase=id=>{const row=one('SELECT * FROM cases WHERE id=?',id||caseId);return {...row,body:JSON.parse(row.body)};};
    const turns=[];
    const ctx={store,db,user,thread,caseId,selection,calc:selection.calcId,env,op,all,one,inspectCase,turns,
      material:id=>readMaterial(db,user,id),chartRef:(calc,title)=>materialForResult(db,user,thread,{calc,cards:['trend'],title}),
      screen:{calc:selection.calcId,cards:['summary','trend']},ctrFile, close:()=>store.close()};
    ctx.ask=async(question,body={},turnEnv=env)=>{
      const target={thread,caseId,question,...body};
      const job=enqueue(store,user,target);
      await workJobs(store,{publicUser:()=>user},turnEnv,send);
      const answer=messages(db,user,target.thread).items.findLast(m=>m.body.jobId===job)?.body;
      assert.ok(answer,'Missing saved assistant response');
      const state=JSON.parse(one('SELECT body FROM agent_turns WHERE job=?',job)?.body||'null');
      const values={}, inputs={};
      const operations=new Map();
      for(const msg of state?.messages||[]){
        for(const c of msg.tool_calls||[]) {
          operations.set(c.id,c.function.name);
          (inputs[c.function.name]??=[]).push(JSON.parse(c.function.arguments));
        }
        if(msg.role==='tool'){
          const name=operations.get(msg.tool_call_id);
          (values[name]??=[]).push(JSON.parse(msg.content));
        }
      }
      const entry={question,job,answer,values,inputs,receipts:all('SELECT signature FROM agent_steps WHERE job=?',job).map(r=>r.signature)};
      turns.push(entry);
      assert.ok(!answer.warning && ['done','clarification'].includes(answer.outcome),answer.text);
      assert.ok(answer.text?.trim(),'Missing answer text');
      assert.ok(!state?.reminder && !state?.providerRetried && !state?.greetingRetried && !Object.keys(state?.failures||{}).length,
        'Application retried or corrected a failed step');
      return entry;
    };
    return ctx;
  } catch(e) {store.close();throw e;}
}

export async function openCorporateWikiWorkspace(env,send) {
  const origin='https://wiki.acceptance.invalid';
  const wikiRequests=[];
  const page={id:'7',title:'Регламент подсчёта CTR',type:'page',space:{key:'STORE'},
    version:{number:4},body:{storage:{value:'<p>Контрольная выборка составляет 240 визитов.</p>'}}};
  const route=async(url,init={})=>{
    const target=new URL(url);
    if(target.origin!==origin) return send(url,init);
    const method=init.method??'GET';
    wikiRequests.push({method,path:target.pathname});
    assert.equal(method,'GET','Unexpected Confluence mutation');
    if(target.pathname==='/rest/api/user/current') return Response.json({type:'known',userKey:'synthetic-team-user'});
    if(target.pathname==='/rest/api/space/STORE') return Response.json({id:'42',key:'STORE'});
    if(target.pathname==='/rest/api/content/search') {
      const cql=target.searchParams.get('cql')||'';
      const query=cql.match(/(?:text~|title=)"([^"]*)"/u)?.[1]??'';
      return Response.json({results:page.title.toLowerCase().includes(query.toLowerCase())?[{id:page.id,title:page.title}]:[]});
    }
    if(target.pathname==='/rest/api/content/7') return Response.json(page);
    return new Response(null,{status:404});
  };
  const isolated={...env,INTEGRATION_KEY:randomBytes(32).toString('base64url')};
  const x=openWorkspace(isolated,route,'member');
  try {
    configure(x.db,{...x.user,role:'admin'},{service:'confluence',url:origin,scope:'STORE',edition:'dc'},isolated);
    await personalConnection(x.db,x.user,{service:'confluence',action:'connect',token:'synthetic-wiki-access'},isolated,route);
    return {...x,wikiRequests};
  } catch(e) {x.close();throw e;}
}

export function workspaceCase(id,tools,prompts,verify,{local=false,prepare,body,custom,allowedWrites=[],fixture=openWorkspace}={}) {
  return {id:'workspace-'+id,family:'workspace',tools,prompts,local,fixture,
    run:async({question,env,send})=>{
      const x=await fixture(env,send);
      const evidence=()=>({turns:x.turns.map(({job,answer,values,receipts})=>({job,outcome:answer.outcome,mode:answer.mode,
        text:answer.text?.slice(0,2400),steps:answer.steps,actions:answer.actions?.map(a=>({op:a.op,id:a.id})),
        materials:answer.materials?.map(m=>({id:m.id,kind:m.kind})),sources:answer.readSources?.map(s=>s.url),
        executed:Object.keys(values),receipts}))});
      try {
        await prepare?.(x);
        const turn=custom ? await custom(x,question) : await x.ask(question,body?.(x));
        for(const name of tools) {
          const outputs=turn.values[name];
          assert.ok(outputs?.length && outputs.every(v=>v!=null && !v.error),'Missing successful application receipt for '+name);
        }
        const writes=x.turns.flatMap(t=>t.answer.actions||[]).map(a=>a.op);
        assert.ok(writes.every(op=>allowedWrites.includes(op)),'Unexpected write: '+writes.filter(op=>!allowedWrites.includes(op)));
        assert.equal(x.one('SELECT count(*) n FROM published').n,0,'Unexpected team publication');
        await verify(x,turn);
        return evidence();
      } catch(e) {e.receipt=evidence();throw e;}
      finally {x.close();}
    }};
}
