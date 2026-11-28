import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {root,profiles,liveModelEnv} from './config.mjs';
import {name,openStore} from './store.mjs';
import {page,runTool} from './analytics.mjs';
import {makeAgent,apiConfigured} from './agent.mjs';
import {codexTurn} from './codex-model.mjs';
import {localData} from './data-profile.mjs';

export function application(store,{env=liveModelEnv,send=fetch}={}){
  const mode=()=>localData(env)?'local':apiConfigured(env)?(env.LLM_BACKEND||'api'):env.LLM_BACKEND==='codex'?'codex':'offline';
  const agent=makeAgent(store,{env,send,alternate:codexTurn});
  const app=createServer(async(req,res)=>{
    const json=(status,body)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(body));};
    try{
      const url=new URL(req.url,'http://localhost'),p=url.pathname;
      if(!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host||''))return json(403,{error:'Локальный сервер.'});
      if(p.startsWith('/api/')){
        const q=Object.fromEntries(url.searchParams);if(q.day!==undefined)q.day=Number(q.day);if(q.metric!==undefined)q.metric=Number(q.metric);
        if(req.method==='GET'){
          if(p==='/api/journal')return json(200,{releases:store.releases(),datasets:store.datasets(),profiles:req.pmActor?[req.pmActor]:profiles,mode:mode(),model:env.LLM_MODEL||''});
          if(p==='/api/report')return json(200,page(store,q));
          if(p==='/api/activity'){
            store.release(q.releaseId);
            const messages=store.messages(q.releaseId).map(({authorId,...message})=>({
              ...message,own:Boolean(req.pmActorId&&message.role==='user'&&authorId===req.pmActorId),
            }));
            return json(200,{messages,boards:store.boards(q.releaseId)});
          }
          if(p.startsWith('/api/calculations/'))return json(200,store.getCalc(p.split('/').at(-1)));
          return json(404,{error:'Маршрут не найден.'});
        }
        if(req.method!=='POST')return json(405,{error:'Метод не поддерживается.'});
        if(req.headers.origin&&req.headers.origin!=='http://'+req.headers.host)return json(403,{error:'Чужой источник запроса.'});
        if(!req.headers['content-type']?.startsWith('application/json'))return json(415,{error:'Требуется JSON.'});
        let bytes=0;const chunks=[];
        for await(const c of req){bytes+=c.length;if(bytes>14_000_000)return json(413,{error:'Файл слишком велик.'});chunks.push(c);}
        const b=JSON.parse(Buffer.concat(chunks).toString('utf8'));
        if(req.pmActor)b.author=req.pmActor;
        if(p==='/api/import')return json(200,store.importCSV(b));
        if(p==='/api/releases')return json(201,store.create(b));
        if(p==='/api/compare')return json(200,runTool(store,'compare_metric',b));
        if(p==='/api/chat')return json(200,await agent.ask(b,req.pmActor,req.pmActorId));
        if(p==='/api/initial'){if(mode()!=='offline')await agent.initial(b);return json(200,{ok:true});}
        if(p==='/api/boards'){
          const calc=store.getCalc(b.calc),title=name(b.name,100);
          if((!req.pmActor&&!profiles.includes(b.author))||calc.op!=='build_chart'||calc.context.releaseId!==b.releaseId)throw Error('График должен принадлежать этому релизу.');
          store.db.prepare('INSERT OR IGNORE INTO boards VALUES(?,?,?)').run(b.releaseId,title,b.calc);
          return json(200,store.boards(b.releaseId));
        }
        return json(404,{error:'Маршрут не найден.'});
      }
      if(req.method!=='GET')return json(405,{error:'Метод не поддерживается.'});
      const assets={'/':['index.html','text/html'],'/app.js':['app.js','text/javascript'],'/app.css':['app.css','text/css']};
      if(!Object.hasOwn(assets,p))return json(404,{error:'Страница не найдена.'});
      const [file,mime]=assets[p];const content=await readFile(join(root,'dist',file));
      res.writeHead(200,{'Content-Type':mime+'; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(content);
    }catch(e){json(e.code==='ENOENT'?503:400,{error:e.code==='ENOENT'?'Сначала выполните pnpm build.':String(e.message).slice(0,1000)});}
  });
  app.closeReviews=agent.closeReviews;
  app.once('close',()=>{void app.closeReviews();});
  return app;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const store=openStore(),port=Number(process.env.PORT||8090);
  const app=application(store);app.listen(port,'127.0.0.1',()=>console.log('Помощник продакта · http://127.0.0.1:'+port));
}
