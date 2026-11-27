import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs, cases, updateCase, scan } from '../server/evidence.mjs';
import { initWorkbench, deliver } from '../server/workbench.mjs';
import { signalHistory } from '../server/signal-history.mjs';

function salesDoc(values) {
  const dates = ['2026-11-02','2026-11-09','2026-11-16','2026-11-23'];
  const facts = [{kind:'dictionary',loc:'A2',row:{metric_id:'family_orders_idx',bad_signal:'Индекс ниже 90 две недели подряд'}}];
  for (const [index, value] of values.entries()) if (value != null)
    facts.push({kind:'sales',loc:'B'+index,row:{product_family:'Store',week_start:dates[index],orders_index:value}});
  return {file:'BI',facts};
}

function fixture(t) {
  const s = openStore(':memory:');
  t.after(() => s.close());
  initEvidence(s.db);
  initWorkbench(s.db);
  const upload = values => importDocs(s,[salesDoc(values)]);
  const env = {NOTIFICATIONS_ENABLED:'true',TELEGRAM_BOT_TOKEN:'fixture',TELEGRAM_CHAT_IDS:'first,second',SMTP_HOST:'smtp.invalid',SMTP_TO:'pm@example.invalid'};
  const sent = [];
  const tg = async (url, options) => {
    const {chat_id:dest, text} = JSON.parse(options.body);
    sent.push({dest,text});
    return Response.json({result:{message_id:1}});
  };
  const mail = async (text, conf) => { sent.push({dest:conf.SMTP_TO,text}); };
  const tick = () => deliver(s,env,tg,mail);
  const get = () => cases(s.db);
  const queued = () => s.db.prepare("SELECT count(*) n FROM deliveries WHERE state='queued'").get().n;
  const revisions = () => s.db.prepare("SELECT json_extract(body,'$.status') s FROM signal_revisions ORDER BY revision").all().map(r=>r.s);
  return {s,upload,env,sent,tg,mail,tick,get,queued,revisions};
}

test('BI correction retracts the episode, cancels queued notices, preserves the case and can reactivate once', t => {
  const {s,upload,get,queued,revisions} = fixture(t);
  upload([70,70]);
  const [first] = get();
  assert.equal(queued(),2);
  first.body.notes = [{note:'Заметка PM'}];
  first.state = 'Завершено';
  updateCase(s.db,first);
  upload([100,100]);
  const [retracted] = get();
  assert.equal(retracted.id,first.id);
  assert.equal(retracted.body.signal.status,'withdrawn');
  assert.equal(retracted.state,'Завершено');
  assert.deepEqual(retracted.body.notes,first.body.notes);
  assert.equal(queued(),0);
  const [change] = signalHistory(s.db, first.id);
  assert.equal(change.event,'withdrawn');
  assert.equal(change.imported[0].file, 'BI');
  assert.equal(s.db.prepare('SELECT file FROM documents WHERE version=?').get(change.imported[0].version).file, 'BI');
  assert.equal(upload([100,100]).inserted,0);
  assert.equal(upload([70,70]).inserted,0);
  assert.deepEqual(revisions(),['confirmed','withdrawn']);
  upload([69,70]);
  scan(s.db);
  assert.equal(queued(),2);
  assert.equal(get()[0].id,first.id);
  assert.deepEqual(revisions(),['confirmed','withdrawn','confirmed']);
});

test('a confirmed episode restored before a retraction leaves the queue supersedes that retraction', async t => {
  const {upload,env,sent,tick} = fixture(t);
  env.TELEGRAM_CHAT_IDS = 'first';
  upload([70,70]);
  await tick();
  await tick();
  upload([100,100]);
  upload([71,71]);
  for (let i=0;i<5;i++) await tick();
  assert.equal(sent.length,4);
  assert.ok(sent.every(r=>!r.text.includes('отозван')));
});

test('an amendment to a restored episode reaches old and new recipients once each', async t => {
  const {upload,env,sent,tick} = fixture(t);
  upload([70,70]);
  for (let i=0;i<4;i++) await tick();
  upload([100,100]);
  for (let i=0;i<3;i++) await tick();
  const before = sent.length;
  env.TELEGRAM_CHAT_IDS = 'first,new-chat';
  upload([71,71]);
  upload([72,72]);
  for (let i=0;i<9;i++) await tick();
  const amended = sent.slice(before);
  assert.deepEqual(amended.map(r=>r.dest).sort(),['first','new-chat','pm@example.invalid','second']);
  assert.ok(amended.every(r=>r.text.includes('уточнены')));
});

test('a rate-limited amendment still allows withdrawal of an already delivered signal', async t => {
  const {s,upload,env,sent,mail,tick} = fixture(t);
  env.TELEGRAM_CHAT_IDS = 'first';
  upload([70,70]);
  await tick();
  await tick();
  upload([72,72]);
  let rejectAmendment;
  const sending = deliver(s,env,() => new Promise(resolve=>{rejectAmendment=resolve;}),mail);
  upload([100,100]);
  rejectAmendment(new Response(null,{status:429}));
  await sending;
  for (let i=0;i<4;i++) await tick();
  const withdrawals = sent.slice(2);
  assert.deepEqual(withdrawals.map(r=>r.dest).sort(),['first','pm@example.invalid']);
  assert.ok(withdrawals.every(r=>r.text.includes('отозван')));
});

test('a rate-limited first notice cannot retry after withdrawal and re-confirmation', async t => {
  const {s,upload,env,sent,mail,tick,queued} = fixture(t);
  env.TELEGRAM_CHAT_IDS = 'first';
  upload([70,70]);
  let rateLimit;
  const sending = deliver(s,env,() => new Promise(resolve=>{rateLimit=resolve;}),mail);
  upload([100,100]);
  upload([71,71]);
  rateLimit(new Response(null,{status:429}));
  await sending;
  assert.equal(queued(),2);
  for (let i=0;i<4;i++) await tick();
  assert.deepEqual(sent.map(r=>r.dest).sort(),['first','pm@example.invalid']);
  assert.equal(queued(),0);
});

test('legacy delivery without an archived SMTP recipient requires reconciliation after a revision', async t => {
  const directory = mkdtempSync(join(tmpdir(),'softline-legacy-signal-'));
  const path = join(directory,'workspace.sqlite');
  let s;
  t.after(() => { s?.close(); rmSync(directory,{recursive:true,force:true}); });
  const legacy = openStore(path);
  let id;
  try {
    initEvidence(legacy.db);
    importDocs(legacy,[salesDoc([70,70])]);
    id = cases(legacy.db)[0].id;
    legacy.db.exec(`DROP TABLE signal_revisions; DROP INDEX deliveries_signal;
      UPDATE cases SET body=json_remove(body,'$.signal.revision','$.signal.status','$.signal.confirmedWeek');
      DELETE FROM deliveries;`);
    legacy.db.prepare("INSERT INTO deliveries(id,channel,state,body) VALUES(?,'smtp','delivered',?)")
      .run(id+'smtp',JSON.stringify({caseId:id,text:'Старое сообщение'}));
  } finally { legacy.close(); }
  s = openStore(path);
  initEvidence(s.db);
  initWorkbench(s.db);
  assert.deepEqual(signalHistory(s.db,id).map(({revision,status})=>[revision,status]),[[0,'confirmed']]);
  importDocs(s,[salesDoc([100,100])]);
  const sent = [];
  await deliver(s,{NOTIFICATIONS_ENABLED:'true',SMTP_HOST:'smtp.invalid',SMTP_TO:'new@example.invalid'},
    undefined,async text=>sent.push(text));
  const review = s.db.prepare("SELECT body FROM deliveries WHERE state='review'").get();
  assert.equal(JSON.parse(review.body).caseId,id);
  assert.deepEqual(signalHistory(s.db,id).map(({revision,status})=>[revision,status]),[[1,'withdrawn'],[0,'confirmed']]);
  assert.equal(sent.length,0);
});

test('late week extends the same episode with its existing investigation link', t => {
  const {upload,get,queued} = fixture(t);
  upload([null,70,70]);
  const [before] = get();
  upload([69]);
  const [after] = get();
  assert.equal(get().length,1);
  assert.equal(after.id,before.id);
  assert.equal(after.body.signal.start,'2026-11-02');
  assert.equal(after.body.signal.confirmedWeek,'2026-11-09');
  assert.equal(queued(),2);
});

test('overlapping late weeks can restore a withdrawn episode under its original link', t => {
  const {upload,get,queued} = fixture(t);
  upload([null,70,70]);
  const [before] = get();
  upload([100,100,100]);
  assert.equal(get()[0].body.signal.status,'withdrawn');
  upload([69,69,69]);
  assert.equal(get().length,1);
  assert.equal(get()[0].id,before.id);
  assert.equal(get()[0].body.signal.start,'2026-11-02');
  assert.equal(queued(),2);
});

test('withdrawal targets original SMTP recipient and only Telegram chats that received the first notice', async t => {
  const {upload,env,sent,tick,queued} = fixture(t);
  upload([70,70]);
  await tick(); // fan out
  await tick(); // SMTP
  await tick(); // first Telegram chat
  assert.deepEqual(sent.map(r=>r.dest),['pm@example.invalid','first']);
  env.SMTP_TO = 'new@example.invalid';
  env.TELEGRAM_CHAT_IDS = 'new-chat';
  upload([100,100]);
  for(let i=0;i<6;i++) await tick();
  assert.equal(queued(),0);
  assert.deepEqual(sent.slice(2).map(r=>r.dest).sort(),['first','pm@example.invalid']);
  assert.ok(sent.slice(2).every(r=>r.text.includes('отозван')));
});

test('correction during a request is delivered after confirmation, or held for review after restart', async t => {
  const {s,upload,env,sent,mail,tick,queued} = fixture(t);
  env.TELEGRAM_CHAT_IDS='first';
  upload([70,70]);
  let resolveRequest;
  const sending = deliver(s,env,() => new Promise(resolve=>{resolveRequest=resolve;}),mail);
  upload([100,100]);
  await tick();
  assert.equal(sent.length,0);
  resolveRequest(Response.json({result:{message_id:1}}));
  await sending;
  await tick();
  assert.equal(sent.length,1);
  assert.match(sent[0].text,/отозван/);
  upload([66,68]);
  const original = s.db.prepare("SELECT id,body FROM deliveries WHERE state='queued' AND channel='telegram'").get();
  s.db.prepare("UPDATE deliveries SET state='sending',body=? WHERE id=?").run(JSON.stringify({...JSON.parse(original.body),chat:'first'}),original.id);
  upload([100,101]);
  initWorkbench(s.db);
  assert.equal(queued(),0);
  assert.equal(s.db.prepare("SELECT count(*) n FROM deliveries WHERE state='review'").get().n,1);
});
