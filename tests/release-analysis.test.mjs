import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamApp } from '../server/team-http.mjs';
import { digest, importDocs } from '../server/evidence.mjs';
import { answer, openCaseThread, workJobs } from '../server/workbench.mjs';
import { prepareTracker } from '../server/tracker-workflow.mjs';
import { targetFor } from '../server/tracker-connections.mjs';
import { readPresentation, workPresentations } from '../server/presentations.mjs';

const releases = [
  ['R-09', 'Kaspersky', 80, 'Покупатели останавливаются при выборе лицензии', 'Проследить выбор лицензии'],
  ['R-02', 'Astra', 120, 'Покупатели не замечают условия продления', 'Проверить видимость условий продления'],
  ['R-10', 'Gamma', 100, null, null],
];

const draftReply = (text, sources, recommendation) => ({
  observations: [{ text, sources }],
  hypotheses: recommendation ? [{ text: recommendation, test: 'Наблюдать за прохождением сценария.', sources }] : [],
  recommendations: [],
  missing: recommendation ? [] : ['Не хватает интервью по этому продукту.'],
  title: 'Проверка релиза',
});

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'release-analysis-'));
  const env = {
    ADMIN_INVITE_KEY: 'release-test', LLM_BACKEND: 'api', LLM_BASE_URL: 'http://127.0.0.1:8199/v1',
    LLM_MODEL: 'fixture', LLM_DATA_MODE: 'analysis',
  };
  const requests = [];
  let otherCaseSource;
  let foreignCell;
  let mode = 'normal';
  const send = async (_url, options) => {
    const last = JSON.parse(options.body).messages.at(-1);
    const input = JSON.parse(last.content);
    requests.push(input);
    if (mode === 'foreign-tool' || mode === 'historical-view') {
      return Response.json({choices:[{message:last.role === 'tool' ? {content:'Проверка завершена.'} : {
        tool_calls:[{id:'read',type:'function',function:mode === 'historical-view' ?
          {name:'view',arguments:'{}'} : {name:'knowledge_source',arguments:JSON.stringify(foreignCell)}}],
      }}]});
    }
    if (mode === 'offline') return new Response('', { status: 503 });
    const row = releases.find(r => r[1] === input.scope.product);
    const metric = input.evidence.find(item => item.kind === 'orders-index');
    const interview = input.evidence.find(item => item.kind === 'interview');
    if (input.scope.product === 'Astra') otherCaseSource = interview.id;
    const sources = mode === 'foreign' ? [otherCaseSource] : [metric.id, interview?.id].filter(Boolean);
    const result = draftReply('Индекс изменился со 100 до ' + (mode === 'invented-number' ? 9999 : metric.data.current.mean) + '.',
      sources, interview && row[4]);
    return Response.json({ choices: [{ message: { content: JSON.stringify(result) } }] });
  };
  const app = createTeamApp({ base: join(dir, 'team.sqlite'), env, send, background: false });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true, force: true, maxRetries: 3 }); });
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const registration = await fetch(origin + '/api/team/register', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ login: 'admin-fixture', name: 'PM', password: 'fixture-password', code: env.ADMIN_INVITE_KEY }),
  });
  assert.equal(registration.status, 200);
  const user = await registration.json();
  const cookie = registration.headers.get('set-cookie').split(';')[0];
  const store = app.space(user.space);
  const docs = [];
  for (const [release, product, current, interview] of releases) {
    const task = release === 'R-09' ? 'T-07' : release.replace('R', 'T');
    const entries = [
      { kind: 'releases', loc: 'Релизы!A2', row: { release_id:release, release_date:'2026-11-01', description:'Новая версия ' + product,
        release_type:'major', status:'выпущен', related_task_ids:task } },
      { kind: 'backlog', loc: 'Задачи!A2', row: { task_id:task, title:product + ' · выпуск',
        created_date:'2026-10-01', status:'New' } },
      ...Array.from({ length: 16 }, (_, i) => ({
        kind: 'sales', loc: 'Индекс!A' + (i + 2),
        row: { product_family: product, week_start: new Date(Date.UTC(2026, 7, 3 + i * 7)).toISOString().slice(0, 10),
          orders_index: i < 12 ? 100 : current },
      })),
    ];
    if (interview) entries.push({ kind:'interview', loc:'Интервью!B2', row:{ product, date:'2026-11-02', excerpt:interview } });
    if (product === 'Kaspersky') entries.push(
      { kind:'interview', loc:'Интервью!B3', row:{ product, date:'2026-11-23', excerpt:'Позднее интервью вне среза' } },
      { kind:'backlog', loc:'Задачи!A3', row:{ task_id:'T-08', title:'Kaspersky: проверить сбор событий',
        description_short:'Проверить передачу событий', created_date:'2026-10-02', status:'New' } },
    );
    docs.push({ file:product + '.xlsx', facts:entries });
  }
  importDocs(store, docs, { notify:false });
  foreignCell = {version:store.db.prepare("SELECT version FROM documents WHERE file='Astra.xlsx'").get().version,loc:'Интервью!B2'};
  const original = store.db.prepare("SELECT version FROM documents WHERE file='Kaspersky.xlsx'").get().version;
  store.db.prepare('UPDATE documents SET created=? WHERE version=?').run(Date.parse('2026-11-20'), original);
  const latest = structuredClone(docs[0]);
  latest.facts.find(row => row.loc === 'Интервью!B2').row.excerpt += ' — уточнение новой версии';
  importDocs(store, [latest], { notify:false });
  store.db.prepare("UPDATE documents SET created=? WHERE file='Kaspersky.xlsx' AND version<>?").run(Date.parse('2026-11-27'), original);
  async function post(op, body) {
    const response = await fetch(origin + '/api/team/' + op, { method:'POST',
      headers:{ cookie, 'content-type':'application/json' }, body:JSON.stringify(body) });
    return { status:response.status, body:await response.json() };
  }
  async function call(op, input) {
    const response = await post(op, input);
    assert.equal(response.status, 200, response.body.error);
    return response.body;
  }
  return { app, store, user, env, send, requests, call, post, original, setMode(value) { mode = value; } };
}

test('release decisions use different sources and conclusions, and make the research gap explicit', async t => {
  const { call, requests, original } = await fixture(t);
  for (const [releaseId, product, mean, interview, hypothesis] of releases) {
    const decision = await call('release_decision', { product, releaseId });
    const report = await call('release-analysis', { decisionContext:decision.decisionContext });
    assert.equal(requests.at(-1).evidence.find(r => r.kind === 'orders-index').data.current.mean, mean);
    assert.ok(requests.at(-1).evidence.every(r => r.kind !== 'interview' || r.data.excerpt.includes(interview)));
    if (interview) {
      assert.equal(report.hypotheses[0].text, hypothesis);
      const citation = report.hypotheses[0].sources.find(row => row.loc === 'Интервью!B2');
      assert.ok(citation);
      const source = await call('knowledge-source', { version:citation.version, loc:citation.loc });
      assert.equal(source.rows[0].loc, 'Интервью!B2');
    } else {
      assert.deepEqual(report.hypotheses, []);
      assert.match(report.missing[0], /Не хватает интервью/);
    }
  }
  const past = await call('release_decision', { releaseId:'R-09', through:'2026-11-22' });
  const report = await call('release-analysis', { decisionContext:past.decisionContext });
  assert.doesNotMatch(JSON.stringify(requests.at(-1)), /Позднее интервью|уточнение новой версии|Astra/);
  assert.equal(report.hypotheses[0].sources.find(row => row.loc === 'Интервью!B2').version, original);
});

test('draft preparation preserves the selected task and rejects foreign citations before any write', async t => {
  const { store, call, post, setMode } = await fixture(t);
  const scope = { product:'Kaspersky', releaseId:'R-09' };
  const {caseId} = await call('release-tracker-case', scope);
  const current = await call('release_decision', scope);
  const selection = {...scope, caseId, key:'T-07', decisionContext:current.decisionContext};
  const count = table => store.db.prepare('SELECT count(*) n FROM ' + table).get().n;
  const before = count('local_issues');
  const astra = await call('release_decision', {releaseId:'R-02'});
  await call('release-analysis', {decisionContext:astra.decisionContext});
  setMode('foreign');
  assert.match((await post('release-tracker-draft', selection)).body.error, /источник|ссылк/i);
  assert.equal(count('draft_actions'), 0);
  setMode('invented-number');
  assert.match((await post('release-tracker-draft', selection)).body.error, /числ/i);
  assert.equal(count('draft_actions'), 0);
  setMode('offline');
  assert.match((await post('release-tracker-draft', selection)).body.error, /модел/i);
  assert.equal(count('draft_actions'), 0);
  assert.equal((await call('release_decision', scope)).trend.current.mean, 80);
  setMode('normal');
  const draft = await call('release-tracker-draft', selection);
  assert.equal(draft.key, 'T-07');
  assert.match(draft.diff[0].after, /100.*80/);
  assert.ok(draft.sources.some(row => row.loc === 'Интервью!B2'));
  assert.equal(count('local_issues'), before);
  assert.match((await post('confirm', {id:draft.id, revision:'другая-версия'})).body.error, /предпросмотр/);
  assert.equal(count('local_issues'), before);
  const confirmed = await call('confirm', {id:draft.id, revision:draft.revision});
  assert.equal(confirmed.key, 'T-07');
  assert.equal(count('local_issues'), before + 1);
});

test('historical release chat reads the saved interview, excluding late and foreign evidence', async t => {
  const { app, store, env, call, original } = await fixture(t);
  const past = await call('release_decision', { releaseId:'R-09', through:'2026-11-22' });
  const context = {releaseId:'R-09', decisionContext:past.decisionContext};
  const {id:thread} = await call('release-thread', context);
  const {id:job} = await call('ask', {thread, ...context, question:'Что сказали в интервью про Kaspersky?'});
  await workJobs(store, app.accounts, {}, () => assert.fail('A direct quotation needs no model'));
  const turn = JSON.parse(store.db.prepare('SELECT result FROM jobs WHERE id=?').get(job).result);
  assert.match(turn.text, /Покупатели останавливаются при выборе лицензии/);
  assert.doesNotMatch(turn.text, /Позднее интервью|уточнение новой версии|условия продления/);
  assert.ok(turn.readSources.some(source => source.url.includes(original)));
});

test('historical chat tools cannot open a workbook cell from another release', async t => {
  const {app,store,env,send,call,requests,setMode} = await fixture(t);
  const past = await call('release_decision', {releaseId:'R-09', through:'2026-11-22'});
  const context = {releaseId:'R-09', decisionContext:past.decisionContext};
  const {id:thread} = await call('release-thread', context);
  setMode('foreign-tool');
  await call('ask', {thread, ...context, question:'Открой исходную запись.'});
  await workJobs(store, app.accounts, env, send);
  assert.ok(requests.length >= 2);
  assert.ok(requests.some(payload=>/срез|источник/i.test(payload.error || '')));
  assert.doesNotMatch(JSON.stringify(requests), /Покупатели не замечают условия продления/);
});

test('recalculating in a historical chat omits corrections made after the cutoff', async t => {
  const {app,store,env,send,call,requests,setMode} = await fixture(t);
  const past = await call('release_decision', {releaseId:'R-09', through:'2026-11-27'});
  const context = {releaseId:'R-09', decisionContext:past.decisionContext};
  const {id:thread} = await call('release-thread', context);
  const later = 'Поправка, внесённая после среза';
  store.db.prepare('INSERT INTO feedback(source,product,author,comment,created) VALUES(?,?,?,?,?)')
    .run('Kaspersky.xlsx · Интервью!B2','Kaspersky','PM',later,Date.parse('2026-11-28'));
  setMode('historical-view');
  await call('ask', {thread,...context,question:'Открой расчёт.'});
  await workJobs(store,app.accounts,env,send);
  assert.ok(requests.some(payload => payload.period?.at(-1) === '2026-11-27'));
  const encoded = JSON.stringify(requests);
  assert.ok(!encoded.includes(later) && !encoded.includes('Новая версия Astra') && !encoded.includes('Новая версия Gamma'));
});

test('a presentation requested from the historical release chat uses that saved slice', async t => {
  const {app,store,user,call} = await fixture(t);
  await call('release-tracker-case', {releaseId:'R-09'});
  const current = await call('release_decision', {releaseId:'R-09'});
  await call('release-thread', {releaseId:'R-09',decisionContext:current.decisionContext});
  const past = await call('release_decision', {releaseId:'R-09', through:'2026-11-22'});
  const context = {releaseId:'R-09', decisionContext:past.decisionContext};
  const {id:thread} = await call('release-thread', context);
  const future = 'Новая заметка за пределами исторического среза';
  const releaseCase = store.db.prepare("SELECT id,body FROM cases WHERE json_extract(body,'$.release')='R-09'").get();
  store.db.prepare('UPDATE cases SET body=? WHERE id=?').run(JSON.stringify({...JSON.parse(releaseCase.body),
    notes:[{created:Date.parse('2026-11-27'),text:future}],
  }), releaseCase.id);
  const {id:job} = await call('ask', {thread,...context,question:'Собери презентацию'});
  await workJobs(store, app.accounts, {}, () => assert.fail('The presentation was queued'));
  await workPresentations(store, {}, () => assert.fail('The factual report needs no model'));
  const {presentationId} = JSON.parse(store.db.prepare('SELECT result FROM jobs WHERE id=?').get(job).result);
  assert.ok(presentationId);
  const {deck} = readPresentation(store.db,user,presentationId);
  assert.match(JSON.stringify(deck), /2026-11-22/);
  assert.doesNotMatch(JSON.stringify(deck), /Новая заметка|Позднее интервью|условия продления/);
});

test('a saved pre-upgrade release comment stays visible and cannot be confirmed', async t => {
  const {store, user, env, send, call, post} = await fixture(t);
  const {caseId} = await call('release-tracker-case', {releaseId:'R-09'});
  const target = targetFor(store.db, user, 'redmine', env);
  const comment = 'Текст старого черновика по релизу';
  const id = digest(JSON.stringify(['release-decision', user.id, caseId, 'R-09', 'T-07', target, comment]));
  await prepareTracker(store, user, 'issue', {caseId, key:'T-07', comment}, env, send, id);
  assert.match((await post('confirm', {id})).body.error, /новый черновик/);
  assert.match((await post('confirm', {id})).body.error, /новый черновик/);
  const preview = await call('tracker-preview', {id});
  assert.equal(preview.state, 'obsolete');
  assert.ok(preview.diff.some(row => row.after === comment));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM local_issues').get().n, 0);
});

test('the short case question uses the model and still exposes facts during an outage', async t => {
  const { store, user, env, send, requests, setMode, call } = await fixture(t);
  const {caseId} = await call('release-tracker-case', {releaseId:'R-09'});
  const thread = openCaseThread(store.db, user, caseId);
  const request = {caseId, thread, question:'Что стоит проверить?'};
  const response = await answer(store, user, request, env, send);
  assert.equal(requests.at(-1).scope.product, 'Kaspersky');
  assert.match(response.text, /выбор лицензии/);
  setMode('offline');
  const unavailable = await answer(store, user, request, env, send);
  assert.match(unavailable.warning, /модел/i);
  assert.ok(unavailable.calc || unavailable.readSources?.length);
  assert.doesNotMatch(unavailable.text, /Сопоставьте начало изменения/);
});

test('a computed signal adds no synthetic task to the backlog', async t => {
  const {store, call} = await fixture(t);
  const {caseId} = await call('release-tracker-case', {releaseId:'R-09'});
  const row = store.db.prepare('SELECT body FROM cases WHERE id=?').get(caseId);
  store.db.prepare('UPDATE cases SET body=? WHERE id=?').run(
    JSON.stringify({...JSON.parse(row.body),signal:{rule:'relative',week:'2026-11-16',value:80}}), caseId);
  const {backlog} = await call('view', {caseId});
  assert.ok(backlog.length && backlog.every(row => row.key.startsWith('T-')));
});
