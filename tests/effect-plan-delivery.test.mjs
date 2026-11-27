import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamApp } from '../server/team-http.mjs';
import { createThread, enqueue } from '../server/workbench.mjs';
import { digest, getCase, importDocs } from '../server/evidence.mjs';
import { observedEffect } from '../server/effect-plan.mjs';
import { approveSource, importApproved, sourceHistory, sourcePermission } from '../server/source-policy.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';

test('late approved rollout resolves a saved watch and notifies the product owner once with comparable data', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-effect-'));
  const archive = Buffer.from('Observation source fixture');
  const env = {
    SOURCE_ARCHIVE_SHA256: digest(archive), SIGNAL_OWNER_LOGIN: 'prod',
    NOTIFICATIONS_ENABLED: 'true', SMTP_HOST: 'mail.invalid', SMTP_FROM: 'sender@example.invalid', SMTP_TO: 'global@example.invalid',
    TELEGRAM_BOT_TOKEN: 'fixture', TELEGRAM_CHAT_IDS: 'global',
  };
  const sent = [];
  const app = createTeamApp({ base:join(dir,'data.sqlite'), env, background:false,
    send: () => assert.fail('Unexpected Telegram call'),
    sendMail: (text, _env, to) => sent.push({text,to}),
  });
  t.after(async () => {
    await app.close();
    await rm(dir, {recursive:true, force:true, maxRetries:3});
  });
  const clock = t.mock.timers;
  clock.enable({apis:['Date'], now:new Date('2026-05-10T09:00:00Z')});
  const store = app.space('team');
  const u = { id:'product', role:'member' };
  app.accounts.db.exec(`
    INSERT INTO users(id,login,space,role) VALUES('product','prod','team','member');
    INSERT INTO email_contacts VALUES('product','product@example.invalid');
  `);
  const metric = 'cfg_add_to_cart_rate', product = 'Kaspersky Endpoint Security';
  const fact = (kind, loc, row) => ({kind,loc,row});
  const task = (fields = {}) => fact('backlog', 'Tasks!A2', {
    task_id:'TASK-FIX', title:'Проверка события', product, created_date:'2026-05-01',
    status:'открыта', linked_metric_ids:metric, ...fields,
  });
  const release = (id, row, fields = {}) => fact('releases', 'Releases!A' + row, {
    release_id:id, release_date:'2026-05-12', release_type:'minor', description:product,
    status:'выпущен', affected_metrics:metric, related_task_ids:'TASK-FIX', ...fields,
  });
  const unrelated = release('UNRELATED', 2, {related_task_ids:'OTHER'});
  const old = release('OLD', 3, {release_date:'2026-05-08'});
  const samples = (first, actions, open = 20) => Array.from({length:7}, (_, i) => fact('metrics', 'Metrics!A' + (first+i), {
    metric_id:metric, product, segment:'desktop', unit:'ratio',
    date:'2026-05-' + String(first+i).padStart(2,'0'), value:open ? actions/open : 0,
    detail_json:JSON.stringify({add_to_cart:actions, open}),
  }));
  const backlog = facts => ({file:'Backlog.xlsx',facts});
  const journal = facts => ({file:'Journal.xlsx',facts:[unrelated,old,...facts]});
  const metrics = facts => ({file:'Metrics.xlsx',facts});
  const permission = (raw, file) => sourcePermission(store.db, env.SOURCE_ARCHIVE_SHA256, raw, file);
  importApproved(store, [
    backlog([task()]), journal([]), metrics(samples(5,2)), {file:'Dictionary.xlsx', facts:[
      fact('dictionary','Dictionary!A2',{metric_id:metric, metric_name:'Добавление в корзину'}),
    ]},
  ], permission(archive,'original.zip'), false);
  const revise = doc => {
    const raw = Buffer.from(JSON.stringify(doc));
    approveSource(store, {sha:digest(raw), file:doc.file,
      previous:sourceHistory(store.db,doc.file)[0].version, origin:'Approved test fixture',
    }, 'fixture-admin', env.SOURCE_ARCHIVE_SHA256);
    importApproved(store,[doc],permission(raw,doc.file),false);
    return sourceHistory(store.db,doc.file)[0].version;
  };
  store.db.prepare("INSERT INTO cases VALUES(?,?,?,'Исследуем',?)")
    .run('watch-fix',product,'Проверка',JSON.stringify({ owner: u.id }));
  const call = (op, body = {}) => workspaceOperation(store,u,op,{caseId:'watch-fix',...body},env);
  const original = call('watch', {taskId:'TASK-FIX', metric, segment:'desktop',
    baselineWeeks:1, observationWeeks:1, target:20, condition:'Сверить тестовое событие и знаменатель',
  });
  assert.equal(original.plan.deployed, null);
  assert.equal(original.rollout, undefined);
  const tick = async () => {
    await app.tick();
    await new Promise(setImmediate);
  };
  const read = () => call('view').effect;
  const checkState = () => getCase(store.db,'watch-fix').state;
  assert.equal(checkState(), 'Наблюдаем эффект');

  clock.setTime(Date.parse('2026-05-13T09:00:00Z'));
  const taskVersion = revise(backlog([task({release_id:'FIX', status:'закрыта'})]));
  revise(journal([release('FIX',4,{release_date:'2026-05-25'})]));
  assert.equal(read().rollout, undefined);
  revise(journal([release('FIX',4,{release_date:'2026-04-31'})]));
  assert.match(read().state, /дата.*требует проверки/i);
  const wrong = release('FIX',4,{description:'Astra Linux'});
  const wrongVersion = revise(journal([wrong]));
  const conflict = read();
  assert.match(conflict.state, /семейств/i);
  assert.ok(conflict.rolloutSources.some(s => s.version === wrongVersion));
  assert.equal(conflict.actual, undefined);

  const fixed = release('FIX',4);
  const competing = release('OTHER-FIX',5);
  revise(journal([fixed,competing]));
  assert.match(read().state, /расходят|несколько/);
  const withdrawn = release('OTHER-FIX',5,{status:'отменён'});
  const releaseVersion = revise(journal([fixed,withdrawn]));
  const view = read();
  assert.deepEqual(view.plan, original.plan);
  assert.equal(view.rollout.id, 'FIX');
  assert.equal(view.rollout.date, '2026-05-12');
  assert.deepEqual(view.rollout.sources.map(s => [s.version,s.loc]), [
    [taskVersion,'Tasks!A2'],[releaseVersion,'Releases!A4'],
  ]);
  assert.equal(call('knowledge-source',{version:releaseVersion,loc:'Releases!A4'}).rows[0].loc,'Releases!A4');
  assert.equal(observedEffect(store.db,getCase(store.db,'watch-fix'),'2026-05-11').rollout, undefined);
  assert.match(view.state, /окончание окна/);
  await tick();
  assert.deepEqual(sent, []);

  clock.setTime(Date.parse('2026-05-20T09:00:00Z'));
  await tick();
  assert.match(read().state, /Недостаточно сопоставимых/);
  revise(metrics([...samples(5,2), ...samples(13,0,0)]));
  await tick();
  assert.match(read().state, /Недостаточно сопоставимых/);
  const invalid = samples(13,5);
  invalid.at(-1).row.detail_json = '{"add_to_cart":5,"open":-1}';
  revise(metrics([...samples(5,2), ...invalid]));
  await tick();
  assert.match(read().state, /Недостаточно сопоставимых/);
  assert.equal(checkState(), 'Наблюдаем эффект');
  assert.deepEqual(sent, []);
  const metricsVersion = revise(metrics([...samples(5,2), ...samples(13,5)]));

  await Promise.all([tick(),tick(),tick()]);
  await tick();
  await tick();
  assert.equal(checkState(), 'Нужно решение');
  const outcome = read();
  assert.equal(outcome.state, 'Цель достигнута');
  assert.equal(outcome.actual, 25);
  assert.equal(outcome.change, 15);
  assert.deepEqual(outcome.plan, original.plan);
  assert.deepEqual(outcome.rollout, view.rollout);
  assert.ok(outcome.observed.sources.every(s => s.version === metricsVersion));
  assert.deepEqual(sent,[{text:'Цель достигнута\nhttp://127.0.0.1:8090/#case/watch-fix',to:'product@example.invalid'}]);
  assert.equal(store.one("SELECT count(*) n FROM deliveries WHERE state='delivered'").n,1);
});

test('background tick delivers a due observation while a chat job waits for the model', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'signal-effect-queue-'));
  const env = {
    LLM_BASE_URL:'https://model.invalid/v1', LLM_MODEL:'fixture', LLM_DATA_MODE:'analysis',
    SIGNAL_OWNER_LOGIN:'prod', NOTIFICATIONS_ENABLED:'true', SMTP_HOST:'mail.invalid', SMTP_FROM:'sender@example.invalid',
  };
  const started = Promise.withResolvers(), modelReply = Promise.withResolvers();
  let calls = 0;
  let closing;
  const sent = [];
  const app = createTeamApp({base:join(dir,'data.sqlite'), env, background:false,
    send: url => {
      assert.equal(new URL(url).hostname, 'model.invalid');
      calls++;
      started.resolve();
      return modelReply.promise;
    },
    sendMail: (text, _env, to) => sent.push({text,to}),
  });
  const reply = () => modelReply.resolve(Response.json({
    choices:[{message:{role:'assistant',content:'Для оценки соберите данные по заказам.'}}],
  }));
  t.after(async () => {
    reply();
    await (closing || app.close());
    await rm(dir,{recursive:true,force:true,maxRetries:3});
  });
  const store = app.space('team');
  const user = {id:'product',name:'Продакт',role:'member'};
  app.accounts.db.exec(`
    INSERT INTO users(id,login,name,space,role) VALUES('product','prod','Продакт','team','member');
    INSERT INTO email_contacts VALUES('product','product@example.invalid');
  `);
  const thread = createThread(store.db,user,'Чат');
  const job = enqueue(store,user,{thread,question:'Помоги составить план продуктового исследования.'});
  const queued = enqueue(store,user,{thread,question:'Сформулируй вопросы для интервью.'});
  const jobState = id => store.one('SELECT status FROM jobs WHERE id=?',id).status;
  await app.tick();
  const modelStarted = await Promise.race([started.promise.then(() => true), new Promise(resolve => {
    const timeout = setTimeout(() => resolve(false),1000);
    timeout.unref();
  })]);
  assert.equal(modelStarted,true);
  assert.equal(jobState(job),'running');

  const product = 'Astra Linux';
  store.db.prepare("INSERT INTO cases VALUES(?,?,?,'Исследуем',?)")
    .run('ready',product,'Наблюдение',JSON.stringify({ owner: user.id }));
  const metric = 'cfg_family_views';
  const samples = (start,value) => Array.from({length:7},(_,i) => {
    const n = start+i;
    return {kind:'metrics',loc:'Metrics!A'+n,row:{metric_id:metric,product,segment:'desktop',
      date:'2026-05-'+String(n).padStart(2,'0'),unit:'visits',value}};
  });
  importDocs(store,[{file:'Observation.xlsx',facts:[
    {kind:'dictionary',loc:'Dictionary!A2',row:{metric_id:metric,metric_name:'Визиты'}},
    ...samples(5,10),...samples(13,15),
  ]}],{notify:false});
  workspaceOperation(store,user,'watch',{caseId:'ready',metric,segment:'desktop',deployed:'2026-05-12',
    baselineWeeks:1,observationWeeks:1,target:11},env);
  for (let i=0; i<4; i++) {
    await app.tick();
    await new Promise(setImmediate);
  }
  assert.equal(calls,1);
  assert.equal(jobState(job),'running');
  assert.equal(jobState(queued),'queued');
  assert.equal(getCase(store.db,'ready').state,'Нужно решение');
  assert.deepEqual(sent,[{text:'Цель достигнута\nhttp://127.0.0.1:8090/#case/ready',to:'product@example.invalid'}]);
  closing = app.close();
  const closed = await Promise.race([closing.then(() => true),new Promise(setImmediate).then(() => false)]);
  assert.equal(closed,false);
  reply();
  await closing;
});
