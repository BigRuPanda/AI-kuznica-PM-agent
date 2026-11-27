import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { openStore } from '../server/store.mjs';
import { initEvidence } from '../server/evidence.mjs';
import { initWorkbench } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { configure, personalConnection } from '../server/tracker-connections.mjs';
import { createAlternative, initInvestigations, publishInvestigation, readInvestigations, syncInvestigations } from '../server/case-investigations.mjs';
import { prepareInvestigationDraft } from '../server/investigation-draft.mjs';

const user = { id: 'pm', role: 'admin', name: 'ПМ' };
const caseId = 'license-orders';
function scenario(t) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  const { db } = store;
  initEvidence(db);
  initWorkbench(db);
  initInvestigations(db);
  db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(caseId, 'Kaspersky', 'Снизился индекс заказов', 'Исследуем',
    JSON.stringify({ owner: user.id, signal: { revision: 1, status: 'confirmed', week: '2026-11-02' } }));
  syncInvestigations(db);
  const runId = readInvestigations(db, user, caseId).current.id;
  const plan = 'Проверить корзину на телефоне.';
  const outcomes = ['Товара нет — записать условия.', 'Событие потеряно — проверить разметку.'];
  db.prepare("UPDATE case_investigations SET status='ready',result=? WHERE id=?")
    .run(JSON.stringify({plan, outcomes, recommendation: plan}), runId);
  const env = {INTEGRATION_KEY: randomBytes(32).toString('base64url')};
  const draft = (input = {}, send, actor = user) => prepareInvestigationDraft(store, actor,
    {caseId, runId, plan, outcomes, ...input}, env, send);
  const confirm = (d, send) => workspaceOperation(store, user, 'confirm', {id:d.id}, env, send);
  const replace = () => {
    db.prepare("UPDATE cases SET body=json_set(body,'$.signal.revision',2) WHERE id=?").run(caseId);
  };
  const withdraw = () => {
    db.prepare("UPDATE cases SET body=json_set(body,'$.signal.revision',2,'$.signal.status','withdrawn') WHERE id=?").run(caseId);
    syncInvestigations(db);
  };
  return {store, db, runId, draft, confirm, replace, withdraw, env, plan, outcomes};
}

test('the edited plan and interpretations form one private, revision-bound preview per content', async t => {
  const {store, db, draft, confirm, runId, outcomes} = scenario(t);
  const [a, repeat] = await Promise.all([draft(), draft()]);
  assert.equal(a.id, repeat.id);
  assert.equal(a.investigationId, runId);
  assert.equal(a.state, 'draft');
  assert.equal(store.one('SELECT COUNT(*) n FROM local_issues').n, 0);
  assert.ok(a.description.includes(outcomes[1]));
  assert.ok(a.diff.some(d => d.after === 'ai-generated'));
  const edited = await draft({plan:'Пройти покупку на компьютере.'});
  assert.notEqual(edited.id, a.id);
  await assert.rejects(draft({}, undefined, {id:'another-pm', role:'member'}));
  const receipts = await Promise.allSettled([confirm(edited), confirm(edited)]);
  assert.ok(receipts.some(r => r.status === 'fulfilled' && r.value.state === 'done'));
  const receipt = await confirm(edited);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM local_issues').get().n, 1);
  assert.match(store.one('SELECT description FROM local_issues WHERE key=?', receipt.key).description, /на компьютере/);
});

test('only an actual tracker search result can receive a plan comment', async t => {
  const {store, draft, confirm} = scenario(t);
  const key = 'DEMO-START', url = '#demo-issue/DEMO-START';
  const selection = {key, url, query:'путь покупки'};
  await assert.rejects(draft({selection:{...selection, key:'T-08'}}), /поиск|выбер/i);
  await assert.rejects(draft({selection:{...selection, query:'доставка'}}), /поиск|выбер/i);
  await assert.rejects(draft({selection:{...selection, url:'https://other.test/issues/8'}}), /поиск|выбер/i);
  const d = await draft({selection});
  assert.equal(d.key, key);
  assert.deepEqual(d.diff.map(f => f.field), ['Комментарий']);
  assert.equal((await confirm(d)).key, key);
  await confirm(d);
  const issue = await workspaceOperation(store, user, 'issue_read', {key});
  assert.equal(issue.comments.length, 1);
  assert.match(issue.comments[0].text, /Событие потеряно/);
});

test('a replaced version cannot reopen a draft or confirm even before queue sync', async t => {
  const s = scenario(t);
  const preview = await s.draft();
  s.replace();
  await assert.rejects(s.draft());
  await assert.rejects(s.confirm(preview));
  assert.equal(s.store.one('SELECT state FROM draft_actions WHERE id=?', preview.id).state, 'obsolete');
  assert.equal(s.store.one('SELECT COUNT(*) n FROM local_issues').n, 0);
});

test('reopening the same case revision restores its obsolete draft without duplicating it', async t => {
  const s = scenario(t);
  const preview = await s.draft();
  const state = value => s.db.prepare('UPDATE cases SET state=? WHERE id=?').run(value, caseId);
  state('Завершено');
  await assert.rejects(s.confirm(preview));
  state('Исследуем');
  const reopened = await s.draft();
  assert.equal(reopened.id, preview.id);
  assert.equal(reopened.state, 'draft');
  assert.equal((await s.confirm(reopened)).state, 'done');
  assert.equal(s.store.one('SELECT COUNT(*) n FROM draft_actions').n, 1);
  assert.equal(s.store.one('SELECT COUNT(*) n FROM local_issues').n, 1);
});

test('the signal shortcut rejects a corrected revision at confirmation', async t => {
  const s = scenario(t);
  const preview = await workspaceOperation(s.store, user, 'signal-issue-draft', {caseId}, s.env);
  s.replace();
  await assert.rejects(s.confirm(preview), /Сигнал изменился/);
  assert.equal(s.store.one('SELECT state FROM draft_actions WHERE id=?', preview.id).state, 'obsolete');
  assert.equal(s.store.one('SELECT COUNT(*) n FROM local_issues').n, 0);
});

test('pre-upgrade signal drafts remain version-bound without affecting regular issue drafts', async t => {
  const s = scenario(t);
  const preview = await workspaceOperation(s.store, user, 'signal-issue-draft', {caseId}, s.env);
  const regular = await workspaceOperation(s.store, user, 'draft', {
    caseId, title:'Своя задача', description:preview.description,
  }, s.env);
  s.db.prepare("UPDATE draft_actions SET body=json_remove(body,'$.signalRevision') WHERE id=?").run(preview.id);
  s.withdraw();
  await assert.rejects(s.confirm(preview), /нет действующего сигнала/);
  assert.equal((await s.confirm(regular)).state, 'done');
  assert.equal(s.store.one('SELECT COUNT(*) n FROM local_issues').n, 1);
});

test('case links do not surface a selected tracker target until a private alternative is published', async t => {
  const s = scenario(t);
  const peer = {id:'peer', role:'member'};
  s.db.prepare("UPDATE cases SET body=json_remove(body,'$.owner') WHERE id=?").run(caseId);
  const parentId = readInvestigations(s.db, user, caseId).current.id;
  const {id: runId} = createAlternative(s.db, user, {caseId, parentId, requestId:'alternative', question:'Уточнить устройство'});
  s.db.prepare("UPDATE case_investigations SET status='ready',result=? WHERE id=?")
    .run(JSON.stringify({plan:s.plan, outcomes:s.outcomes, recommendation:s.plan}), runId);
  const preview = await s.draft({runId, title:'Личная проверка'});
  const links = (actor, sharedOnly = false) => workspaceOperation(s.store, actor, 'case_links', {caseId}, s.env, undefined, sharedOnly);
  assert.deepEqual((await links(user)).items, []);
  assert.throws(() => workspaceOperation(s.store, peer, 'confirm', {id:preview.id}, s.env), /Черновик недоступен/);
  const receipt = await s.confirm(preview);
  assert.equal((await links(user)).items[0].url, receipt.url);
  assert.deepEqual((await links(peer)).items, []);
  assert.deepEqual((await links(user, true)).items, []);
  publishInvestigation(s.db, user, {caseId, id:runId});
  assert.equal((await links(peer)).items[0].url, receipt.url);
});

// The workbook key T-08 is searchable text here. The Redmine issue's actual id is 73.
async function redmine(s) {
  const issue = {id:73, project:{id:7}, subject:'T-08. Передача событий', description:'', journals:[]};
  const mock = {writes:0, drop:false, beforeRead:null, beforeProject:null, ignoreOrigin:false};
  mock.send = async (url, init) => {
    const path = new URL(url).pathname;
    if (path === '/users/current.json') return Response.json({user:{id:1}});
    if (path === '/projects/store.json') {
      mock.beforeProject?.();
      return Response.json({project:{id:7}});
    }
    if (path.endsWith('/search.json')) return Response.json({results:[{type:'issue',id:73}]});
    if (path === '/issues.json') {
      if (init.method === 'GET') return Response.json({issues:[issue]});
      mock.writes++;
      const fields = JSON.parse(init.body).issue;
      issue.description = fields.description;
      issue.custom_fields = mock.ignoreOrigin ? [] : fields.custom_fields;
      if (mock.drop) throw Error('Ответ потерян после записи');
      return Response.json({issue});
    }
    assert.equal(path, '/issues/73.json');
    if (init.method === 'PUT') {
      mock.writes++;
      const fields = JSON.parse(init.body).issue;
      if (fields.notes) issue.journals.push({notes:fields.notes});
      if (fields.custom_fields && !mock.ignoreOrigin) issue.custom_fields = fields.custom_fields;
      if (mock.drop) throw Error('Ответ потерян после записи');
      return new Response('');
    }
    mock.beforeRead?.();
    return Response.json({issue});
  };
  configure(s.db, user, {service:'redmine',url:'https://tracker.test',scope:'store',originFieldId:'17'});
  await personalConnection(s.db,user,{service:'redmine',action:'connect',token:'test-token'},s.env,mock.send);
  mock.selection = {key:'73',url:'https://tracker.test/issues/73',query:'T-08'};
  return mock;
}

test('withdrawal during Redmine preflight prevents the imminent write and retires the draft', async t => {
  const s = scenario(t), remote = await redmine(s);
  const d = await s.draft({selection:remote.selection},remote.send);
  remote.beforeRead = s.withdraw;
  await assert.rejects(s.confirm(d,remote.send));
  assert.equal(remote.writes, 0);
  assert.equal(s.store.one('SELECT state FROM draft_actions WHERE id=?',d.id).state, 'obsolete');
  await assert.rejects(s.draft({selection:remote.selection},remote.send));
});

test('a version change during search or preview creation leaves no actionable draft', async t => {
  const s = scenario(t), remote = await redmine(s);
  remote.beforeRead = s.withdraw;
  await assert.rejects(s.draft({selection:remote.selection},remote.send));
  assert.equal(s.store.one('SELECT COUNT(*) n FROM draft_actions').n, 0);
});

test('withdrawal during new-issue project lookup prevents the imminent Redmine POST', async t => {
  const s = scenario(t), remote = await redmine(s);
  const preview = await s.draft({}, remote.send);
  remote.beforeProject = s.withdraw;
  await assert.rejects(s.confirm(preview, remote.send));
  assert.equal(remote.writes, 0);
  assert.equal(s.store.one('SELECT state FROM draft_actions WHERE id=?', preview.id).state, 'obsolete');
});

test('an uncertain comment can be reconciled after restart and withdrawal with no second write', async t => {
  const s = scenario(t), remote = await redmine(s);
  const d = await s.draft({selection:remote.selection},remote.send);
  remote.drop = true;
  await assert.rejects(s.confirm(d,remote.send), /потерян/);
  s.db.prepare("UPDATE draft_actions SET state='sending' WHERE id=?").run(d.id);
  initWorkbench(s.db);
  s.withdraw();
  assert.equal((await s.confirm(d,remote.send)).key, '73');
  assert.equal((await s.confirm(d,remote.send)).state, 'done');
  assert.equal(remote.writes, 1);
});

test('retrying an uncertain creation stays read-only while the issue origin is unverified', async t => {
  const s = scenario(t), remote = await redmine(s);
  const preview = await s.draft({}, remote.send);
  remote.drop = true;
  remote.ignoreOrigin = true;
  await assert.rejects(s.confirm(preview, remote.send), /потерян/);
  const first = await s.confirm(preview, remote.send);
  assert.equal(first.state, 'partial');
  assert.equal(first.key, '73');
  remote.beforeRead = s.withdraw;
  assert.equal((await s.confirm(preview, remote.send)).state, 'partial');
  remote.beforeRead = null;
  assert.equal((await s.confirm(preview, remote.send)).state, 'partial');
  assert.equal(remote.writes, 1);
});

test('the current investigation can repair the origin on a known receipt after settings are corrected', async t => {
  const s = scenario(t), remote = await redmine(s);
  const preview = await s.draft({}, remote.send);
  remote.drop = true;
  remote.ignoreOrigin = true;
  await assert.rejects(s.confirm(preview, remote.send), /потерян/);
  assert.equal((await s.confirm(preview, remote.send)).state, 'partial');
  assert.equal(remote.writes, 1);
  remote.drop = false;
  remote.ignoreOrigin = false;
  configure(s.db, user, {service:'redmine',url:'https://tracker.test',scope:'store',originFieldId:'28'});
  const receipt = await s.confirm(preview, remote.send);
  assert.equal(receipt.state, 'done');
  assert.equal(receipt.key, '73');
  assert.equal((await s.confirm(preview, remote.send)).state, 'done');
  assert.equal(remote.writes, 2);
  const links = await workspaceOperation(s.store, user, 'case_links', {caseId}, s.env, remote.send);
  assert.deepEqual(links.items.map(link => link.url), [receipt.url]);
});

test('an uncertain legacy signal shortcut recovers its existing issue after withdrawal', async t => {
  const s = scenario(t), remote = await redmine(s);
  const preview = await workspaceOperation(s.store, user, 'signal-issue-draft', {caseId}, s.env, remote.send);
  remote.drop = true;
  await assert.rejects(s.confirm(preview, remote.send), /потерян/);
  s.db.prepare("UPDATE draft_actions SET body=json_remove(body,'$.signalRevision'),state='sending' WHERE id=?").run(preview.id);
  initWorkbench(s.db);
  s.withdraw();
  const receipt = await s.confirm(preview, remote.send);
  assert.equal(receipt.state, 'done');
  assert.equal(receipt.key, '73');
  assert.equal(remote.writes, 1);
});
