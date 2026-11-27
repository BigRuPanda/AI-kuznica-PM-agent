// Exercise the normal write/reconcile path against the isolated, real Redmine instance.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { openStore } from '../server/store.mjs';
import { initEvidence } from '../server/evidence.mjs';
import { initWorkbench } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { configure, personalConnection } from '../server/tracker-connections.mjs';

const dir = new URL('../var/pilot/', import.meta.url);
const access = JSON.parse(await readFile(new URL('access.json', dir), 'utf8'));
assert.equal(access.url, 'https://localhost:18443');
setDefaultCACertificates([...getCACertificates('default'), await readFile(new URL('redmine-ca.pem', dir), 'utf8')]);
const store = openStore(':memory:');
const env = { INTEGRATION_KEY: access.integrationKey, DATA_PROFILE: 'local', LOCAL_HTTP_ORIGINS: access.url };
const author = { id:'verification-writer', name:'Pilot writer', role:'admin' };
const colleague = { id:'verification-reader', name:'Pilot reader', role:'member' };
let dropReply = true;
let creates = 0;
async function transport(url, options) {
  assert.equal(new URL(url).origin, access.url);
  const res = await fetch(url, options);
  if (options?.method === 'POST' && new URL(url).pathname === '/issues.json' && res.ok) {
    creates++;
    if (dropReply) {
      dropReply = false;
      await res.arrayBuffer();
      throw Error('Пилот: ответ потерян после подтверждённой сервером записи');
    }
  }
  return res;
}
const op = (user, operation, input, authored = false) =>
  workspaceOperation(store, user, operation, input, env, transport, false, undefined, authored);
try {
  initEvidence(store.db);
  initWorkbench(store.db);
  configure(store.db, author, {service:'redmine', url:access.url, scope:access.scope, originFieldId:access.originFieldId});
  for (const [user,token] of [[author,access.writerKey],[colleague,access.readerKey]]) {
    await personalConnection(store.db,user,{service:'redmine',action:'connect',token},env,transport);
  }
  const {id:caseId} = await op(author,'create-case',{title:'Сверка результата Redmine', product:'Пилотный ЛК'});
  const title = 'Проверка ' + randomUUID();
  const draft = await op(author,'draft',{caseId,title,description:'Проверить путь от рекомендации до клика.'},true);
  assert.ok(draft.diff.some(row=>row.after==='ai-generated'));
  await assert.rejects(op(author,'confirm',{id:draft.id}),/ответ потерян/);
  initWorkbench(store.db);
  const receipt = await op(author,'confirm',{id:draft.id});
  assert.equal(receipt.state,'done');
  assert.equal(creates,1);
  assert.equal((await op(author,'confirm',{id:draft.id})).key,receipt.key);
  const manual = await op(author,'draft',{caseId,title:title+' вручную',description:'Сгенерирована ИИ-помощником.'});
  const manualReceipt = await op(author,'confirm',{id:manual.id});
  const issue = await op(colleague,'issue_read',{key:receipt.key});
  assert.equal(issue.origin,'ai-generated');
  assert.match(issue.description,/Сгенерирована ИИ-помощником\./);
  assert.equal((await op(colleague,'issue_read',{key:manualReceipt.key})).origin,null);
  const matches = await op(colleague,'issue_search',{query:'',origin:'ai-generated'});
  assert.ok(matches.items.some(i=>i.key===receipt.key));
  assert.ok(!matches.items.some(i=>i.key===manualReceipt.key));
  console.log(JSON.stringify({verified:true, redmineIssue:receipt.key, manualIssue:manualReceipt.key,
    taggedIssueCreates:creates-1, readBySecondUser:true, recovered:true},null,2));
} finally {
  store.close();
}
