import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, cp, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { Readable } from 'node:stream';
import { promisify } from 'node:util';
import { openStore } from '../server/store.mjs';
import { initEvidence, facts, setting } from '../server/evidence.mjs';
import { initMetrikaSync, metrikaStatus, syncMetrika } from '../server/metrika-sync.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { root } from '../server/config.mjs';
import { deliver } from '../server/workbench.mjs';
import { seedWorkspace, fixtureEnv } from './workspace-fixture.mjs';

const env = { METRIKA_COUNTER_IDS:'405', METRIKA_TOKEN:'fixture-token', METRIKA_SYNC_MINUTES:'5',
  METRIKA_REPORTS_JSON:JSON.stringify([{id:'visits',metric:'ym:s:visits',unit:'visits',date1:'yesterday',date2:'yesterday'}]) };
const time = (d) => Date.parse(d+'T08:00:00Z');
const reply = (dates) => Response.json({data:dates.map(date=>({dimensions:[{name:date}],metrics:[12]})),
  total_rows:dates.length,sampled:false,sample_share:1,data_lag:60});

test('the archived Reports API probe respects the local transport and records diagnostics without a sync run', async t => {
  const dir = await testDirectory(t, 'softline-probe-');
  const replay = 'http://127.0.0.1:9876';
  const config = {
    ...fixtureEnv, ...env, SOURCE_ARCHIVE_SHA256: 'a'.repeat(64), DATA_PROFILE: 'local',
    METRIKA_REPLAY_ORIGIN: replay, LOCAL_HTTP_ORIGINS: replay,
    METRIKA_COUNTER_IDS: '405,406',
  };
  const app = createTeamApp({base:join(dir,'app.sqlite'), env:config, background:false, send:async (url, init) => {
    const target = new URL(url);
    assert.equal(target.origin, replay);
    assert.equal(target.pathname, '/stat/v1/data');
    assert.equal(target.searchParams.get('ids'), '405');
    assert.equal(target.searchParams.get('limit'), '1');
    assert.equal(init.headers.Authorization, 'OAuth fixture-token');
    return reply(['2026-11-01']);
  }});
  try {
    await app.accounts.register({login:'fixture-admin',name:'Admin',password:'fixture-password',code:fixtureEnv.ADMIN_INVITE_KEY}, config);
    const {token} = await app.accounts.login({login:'fixture-admin',password:'fixture-password'});
    const post = op => new Promise(resolve => {
      const req = Object.assign(Readable.from([Buffer.from('{}')]), {
        method:'POST', url:'/api/team/'+op, socket:{remoteAddress:'127.0.0.1'},
        headers:{host:'127.0.0.1:8090', 'content-type':'application/json', cookie:'pm_session='+token},
      });
      let status;
      app.server.emit('request', req, {
        writeHead(code) { status = code; },
        end(data) { resolve({status, result: JSON.parse(data)}); },
      });
    });
    const {status, result} = await post('metrika-probe');
    assert.equal(status, 200, JSON.stringify(result));
    assert.equal(result.status, 'ready');
    assert.ok(result.at > 0);
    assert.deepEqual((await post('overview')).result.metrikaProbe, result);
    config.LOCAL_HTTP_ORIGINS = '';
    const blocked = await post('metrika-probe');
    assert.equal(blocked.status, 400);
    assert.match(blocked.result.error, /профил/);
    assert.equal((await post('overview')).result.metrikaProbe.status, 'error');
    const {db} = app.space('team');
    assert.equal(db.prepare('SELECT count(*) AS n FROM documents').get().n, 0);
    assert.equal(facts(db, 'metrics').length, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM metrika_sync_runs').get().n, 0);
  } finally { await app.close(); }
});

async function testDirectory(t, prefix) {
  const parent = join(root, 'var');
  await mkdir(parent, {recursive:true});
  const dir = await mkdtemp(join(parent, prefix));
  t.after(() => rm(dir, {recursive:true,force:true,maxRetries:3}));
  return dir;
}

test('failed pagination, cold restart, gap catch-up, overlapping manual sync and confirmed empty report', async t => {
  let s;
  t.after(() => s?.close());
  const path = join(await testDirectory(t,'softline-sync-'),'app.sqlite');
  s = openStore(path);
  initEvidence(s.db);
  initMetrikaSync(s.db);
  await syncMetrika(s,env,async()=>reply(['2026-11-01']),{now:time('2026-11-02')});
  let page=0;
  await assert.rejects(syncMetrika(s,env,async()=>{
    if (++page === 2) return new Response(null,{status:503});
    return Response.json({data:[{dimensions:[{name:'2026-11-02'}],metrics:[80]}],total_rows:2});
  },{now:time('2026-11-03')}),/503|пагинац|строк|страниц/i);
  let status=metrikaStatus(s.db,env,time('2026-11-03')).reports[0];
  assert.equal(status.attempts[0].state,'error');
  assert.equal(status.coveredThrough,'2026-11-01');
  assert.equal(status.lastAttempt,time('2026-11-03'));
  assert.equal(status.lastSuccess,time('2026-11-02'));
  assert.equal(facts(s.db,'metrics').length,1);
  assert.ok(status.stale);
  s.db.exec("UPDATE metrika_sync_runs SET state='running',finished=NULL,reason=NULL WHERE state='error'");
  s.close();
  s=openStore(path);
  initEvidence(s.db);
  initMetrikaSync(s.db);
  assert.equal(setting(s.db,'last_metrika_sync',null).at,0);
  assert.match(metrikaStatus(s.db,env,time('2026-11-03')).reports[0].attempts[0].reason,/прервался/);
  const dates=['2026-11-02','2026-11-03','2026-11-04'];
  let requests=0;
  const send=async (url)=>{
    const q=new URL(url).searchParams;
    assert.equal(q.get('date1'),'2026-11-02');
    assert.equal(q.get('date2'),'2026-11-04');
    requests++;
    return reply(dates);
  };
  await Promise.all([1,2].map(()=>syncMetrika(s,env,send,{now:time('2026-11-05')})));
  assert.equal(requests,1);
  assert.equal(facts(s.db,'metrics').length,4);
  const empty = await syncMetrika(s,env,async()=>reply([]),{now:time('2026-11-06')});
  assert.equal(empty.inserted,0);
  status=metrikaStatus(s.db,env,time('2026-11-06')).reports[0];
  assert.equal(status.attempts[0].state,'empty');
  assert.deepEqual({...status.attempts[0]}, {
    from:'2026-11-05',to:'2026-11-05',started:time('2026-11-06'),finished:time('2026-11-06'),state:'empty',
    rows:0,observed:null,lag:60,sampleShare:1,pages:1,reason:null,
  });
  assert.equal(status.coveredThrough,'2026-11-05');
  assert.equal(status.lastObservation,'2026-11-04');
  assert.ok(!status.stale);
  assert.ok(metrikaStatus(s.db,env,time('2026-11-08')).reports[0].stale);
});

test('weekly report advances only whole weeks and inherits the configured connection profile', async t => {
  const s=openStore(':memory:');
  t.after(()=>s.close());
  initEvidence(s.db);
  initMetrikaSync(s.db);
  const weekly={...env, get METRIKA_REPORTS_JSON(){
    return JSON.stringify([{id:'weekly',metric:'ym:s:visits',dimensions:'ym:s:startOfWeek',
      date1:'2026-10-30',date2:'2026-12-15'}]);
  }};
  const now=time('2026-12-15');
  let calls=0;
  const send=async url=>{
    const q=new URL(url).searchParams;
    assert.equal(q.get('date1'),calls===0?'2026-11-02':'2026-11-30');
    assert.equal(q.get('date2'),calls===0?'2026-11-29':'2026-12-13');
    calls++;
    return reply([q.get('date1')]);
  };
  await assert.rejects(syncMetrika(s,{...weekly,DATA_PROFILE:'local',LOCAL_HTTP_ORIGINS:''},send,{now}),/профил/);
  assert.equal(calls,0);
  await syncMetrika(s,weekly,send,{now});
  assert.equal(calls,2);
  assert.equal(metrikaStatus(s.db,weekly,now).reports[0].coveredThrough,'2026-12-13');
  assert.deepEqual(facts(s.db,'metrics').map(f=>[f.data.date,f.data.step_days,f.data.value]),[
    ['2026-11-02',7,12],['2026-11-30',7,12],
  ]);
});

test('weekly sync waits for Sunday to finish and rejects observations outside a complete week', async t => {
  const s=openStore(':memory:');
  t.after(()=>s.close());
  initEvidence(s.db);
  initMetrikaSync(s.db);
  const weekly={...env,METRIKA_REPORTS_JSON:JSON.stringify([{id:'weekly',metric:'ym:s:visits',dimensions:'ym:s:startOfWeek',
    date1:'2026-11-23',date2:'today'}])};
  // 21:00 UTC begins Monday in the counter's timezone.
  const sunday=Date.parse('2026-11-29T20:59:00Z'), monday=Date.parse('2026-11-29T21:00:00Z');
  const pending=metrikaStatus(s.db,weekly,sunday).reports[0];
  assert.equal(pending.waitingForPeriod,true);
  assert.equal(pending.expectedThrough,null);
  assert.equal(pending.stale,false);
  await syncMetrika(s,weekly,async()=>{assert.fail('Неполная неделя не запрашивается');},{now:sunday});
  await assert.rejects(syncMetrika(s,weekly,async()=>reply(['2026-11-22']),{now:monday}),/периода|недел/);
  await assert.rejects(syncMetrika(s,weekly,async()=>reply(['2026-11-24']),{now:monday}),/периода|недел/);
  assert.equal(facts(s.db,'metrics').length,0);
  await syncMetrika(s,weekly,async url=>{
    const q=new URL(url).searchParams;
    assert.equal(q.get('date1'),'2026-11-23');
    assert.equal(q.get('date2'),'2026-11-29');
    return reply(['2026-11-23']);
  },{now:monday});
  const loaded=metrikaStatus(s.db,weekly,monday).reports[0];
  assert.equal(loaded.lastObservation,'2026-11-23');
  assert.equal(loaded.coveredThrough,'2026-11-29');
  assert.equal(loaded.stale,false);
});

test('the operational backup restores source coverage and opens the previously saved PM calculation', async t => {
  const dir=await testDirectory(t,'softline-restore-');
  const source=join(dir,'source'),restore=join(dir,'restore');
  await mkdir(source);
  const fixture=await seedWorkspace(source);
  const base=join(source,'releases.sqlite');
  const original=createTeamApp({base,env:fixtureEnv,background:false});
  try {
    await syncMetrika(original.space('team'),env,async()=>reply(['2026-11-01']),{now:time('2026-11-02')});
  } finally { await original.close(); }
  const started=Date.now();
  const command = await promisify(execFile)(process.execPath,['scripts/ops.mjs','backup'],{
    cwd:root,env:{...process.env,DATABASE_URL:base},windowsHide:true,
  });
  assert.match(command.stdout,/3 баз/);
  const [name]=await readdir(join(source,'backups'));
  const backup=join(source,'backups',name);
  const files=await readdir(backup,{recursive:true});
  assert.equal(files.filter(file=>file.endsWith('.sqlite')).length,3);
  assert.ok(files.every(file=>file==='workspaces' || file.endsWith('.sqlite')));
  await cp(backup,restore,{recursive:true});
  const restored=createTeamApp({base:join(restore,'releases.sqlite'),env:{...fixtureEnv,...env},background:false});
  try {
    const origin='http://127.0.0.1:8090';
    let cookie;
    async function post(op, body={}) {
      const req=Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
        method:'POST',url:'/api/team/'+op,socket:{remoteAddress:'127.0.0.1'},
        headers:{host:new URL(origin).host,'content-type':'application/json',cookie},
      });
      const response=await new Promise(resolve=>{
        let status,headers;
        restored.server.emit('request',req,{
          writeHead(code,fields){ status=code; headers=fields; },
          end(data){ resolve({status,headers,result:JSON.parse(data)}); },
        });
      });
      assert.equal(response.status,200,JSON.stringify(response.result));
      cookie=response.headers['Set-Cookie']?.split(';')[0] || cookie;
      return response.result;
    }
    const user=await post('login',{login:'fixture-admin',password:'fixture-password'});
    assert.equal(user.space,'team');
    const snapshot=new URL('/#snapshot/'+fixture.calc+'/summary,trend',origin);
    const range=new URL('/#range/'+fixture.range,origin);
    assert.deepEqual((await post('calc',{id:snapshot.hash.split('/')[1]})).summary,fixture.summary);
    assert.deepEqual((await post('range_read',{id:range.hash.split('/')[1]})).periods,fixture.periods);
    const overview=await post('overview');
    assert.equal(overview.metrikaSync.reports[0].coveredThrough,'2026-11-01');
    assert.equal(overview.metrikaSync.reports[0].attempts[0].rows,1);
    t.diagnostic('Verified 3 restored SQLite files, old PM snapshot and interval. Backup to verified restore: '+(Date.now()-started)+' ms.');
  } finally { await restored.close(); }
});

test('SMTP-only notifications skip old queued Telegram notices and allow direct bot replies', async t => {
  const s=openStore(':memory:');
  t.after(()=>s.close());
  initEvidence(s.db);
  const insert=s.db.prepare("INSERT INTO deliveries(id,channel,state,body) VALUES(?,?,'queued',?)");
  insert.run('old-telegram','telegram',JSON.stringify({chat:'33',text:'Старый сигнал',proactive:true}));
  insert.run('direct-reply','telegram',JSON.stringify({chat:'-44',text:'Ответ в группу',telegramGroup:true}));
  insert.run('mail','smtp',JSON.stringify({text:'Новый сигнал'}));
  const channels={NOTIFICATION_CHANNELS:'smtp',NOTIFICATIONS_ENABLED:'true',TELEGRAM_BOT_TOKEN:'fixture',
    TELEGRAM_CHAT_IDS:'-44',SMTP_HOST:'localhost',SMTP_FROM:'sender@example.invalid',SMTP_TO:'observer@example.invalid'};
  const telegramChats=[],emails=[];
  for (let attempt=0;attempt<3;attempt++) {
    await deliver(s,channels,async (_url,init)=>{
      telegramChats.push(JSON.parse(init.body).chat_id);
      return Response.json({result:{message_id:1}});
    },async (text,config)=>emails.push([text,config.SMTP_TO]));
  }
  assert.deepEqual(telegramChats,['-44']);
  assert.deepEqual(emails,[['Новый сигнал','observer@example.invalid']]);
  assert.deepEqual(s.db.prepare('SELECT state FROM deliveries ORDER BY rowid').all().map(row=>row.state),[
    'queued','delivered','delivered',
  ]);
});
