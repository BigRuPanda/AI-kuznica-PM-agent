import assert from 'node:assert/strict';
import { cp, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createTeamApp } from '../server/team-http.mjs';
import { fixtureEnv } from './workspace-fixture.mjs';

const fixtures = process.env.PM_MIGRATION_FIXTURES;
const password = 'fixture-password';
const noTransport = () => assert.fail('Unexpected external request');
const sqliteOptions = { readOnly: true };

async function scratch(t) {
  const dir = await mkdtemp(join(tmpdir(), 'pm-upgrade-'));
  t.after(() => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return dir;
}

async function openTwice(dir, check, options = {}) {
  const base = join(dir, 'releases.sqlite');
  for (let boot = 1; boot <= 2; boot++) {
    const outgoing = [];
    const blocked = (kind) => () => {
      outgoing.push(kind);
      return noTransport();
    };
    const app = createTeamApp({
      base, background: false, send: blocked('HTTP'), sendMail: blocked('SMTP'),
      env: { ...fixtureEnv, DATA_PROFILE: 'local', ...options.env },
    });
    try {
      await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
      const origin = 'http://127.0.0.1:' + app.server.address().port;
      const health = await fetch(origin + '/health');
      assert.equal(health.status, 200);
      assert.equal((await health.json()).ok, true);
      await check(app, origin, boot);
      assert.deepEqual(outgoing, [], 'startup and historical reads do not send external requests');
    } finally {
      await app.close();
    }
    await checkIntegrity(dir);
  }
}

async function checkIntegrity(dir) {
  const names = await readdir(dir);
  const paths = ['accounts.sqlite', 'releases.sqlite'];
  if (names.includes('workspaces')) {
    for (const file of await readdir(join(dir, 'workspaces'))) {
      if (file.endsWith('.sqlite')) paths.push(join('workspaces', file));
    }
  }
  for (const path of paths) {
    const db = new DatabaseSync(join(dir, path), sqliteOptions);
    try {
      assert.deepEqual(db.prepare('PRAGMA integrity_check').all().map(row => row.integrity_check), ['ok'], path);
      assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], path);
    } finally {
      db.close();
    }
  }
}

async function api(origin, op, token, data) {
  const headers = {};
  if (token) headers.cookie = 'pm_session=' + token;
  if (data !== undefined) headers['content-type'] = 'application/json';
  const response = await fetch(origin + '/api/team/' + op, {
    method: data === undefined ? 'GET' : 'POST', headers, body: JSON.stringify(data),
  });
  const body = await response.json();
  assert.ok(response.ok, op + ' returned ' + response.status + ': ' + JSON.stringify(body));
  return body;
}

test('a fresh installation preserves a newly created account and conversation across startup', async t => {
  const dir = await scratch(t);
  let session, thread;
  await openTwice(dir, async (app, origin, boot) => {
    if (boot === 1) {
      assert.equal(app.accounts.db.prepare('SELECT count(*) AS n FROM users').get().n, 0);
      session = await app.accounts.register({
        login: 'fresh-upgrade-test', name: 'Новый администратор', password, code: fixtureEnv.ADMIN_INVITE_KEY,
      }, fixtureEnv, space => app.space(space));
      thread = await api(origin, 'thread', session.token, { title: 'Проверка нового пространства' });
    }
    assert.equal((await api(origin, 'session', session.token)).user.id, session.user.id);
    const row = app.space('team').db.prepare('SELECT owner,title FROM conversations WHERE id=?').get(thread.id);
    assert.deepEqual({ ...row }, { owner: session.user.id, title: 'Проверка нового пространства' });
  });
});

for (const [name, check] of [
  ['local-main', localMain],
  ['profile-ui', profileUi],
  ['signal-bridge', signalBridge],
]) {
  test(name + ' retains historical links, records and owners across two startups', {
    skip: fixtures ? false : 'PM_MIGRATION_FIXTURES is required for historical fixture runs',
  }, async t => {
    const source = join(fixtures, name);
    const expected = await readFile(join(source, 'manifest.json'), 'utf8').then(JSON.parse).catch(error => {
      throw Error('Missing or invalid migration fixture for ' + name + ' at ' + source, { cause: error });
    });
    assert.equal(expected.kind, name);
    assert.match(expected.commit, /^[a-f0-9]{40}$/u);
    const dir = await scratch(t);
    for (const entry of ['accounts.sqlite', 'releases.sqlite', 'workspaces']) {
      await cp(join(source, entry), join(dir, entry), { recursive: true });
    }
    const baseline = JSON.parse(await readFile(join(source, 'baseline.json'), 'utf8'));
    const state = {};
    await openTwice(dir, async (app, origin, boot) => {
      const store = app.space('team');
      const { user, token } = await app.accounts.login({ login: 'fixture-admin', password });
      await checkBaseline(app, origin, store, token, baseline, expected);
      await check({ app, origin, store, user, token, expected, state, boot });
    }, { env: expected.env });
  });
}

async function checkBaseline(app, origin, store, token, baseline, expected) {
  for (const account of expected.accounts) {
    assert.deepEqual({ ...app.accounts.publicUser(account.id) }, account);
    if (account.role === 'judge') app.space(account.space);
  }
  const calculation = await api(origin, 'calc', token, { id: baseline.calc });
  assert.deepEqual(calculation.summary, baseline.summary);
  const range = await api(origin, 'range_read', token, { id: baseline.range });
  assert.equal(range.id, baseline.range);
  assert.deepEqual(range.periods, baseline.periods);
  const report = await api(origin, 'material', token, { id: baseline.report });
  assert.equal(report.children[0].id, baseline.chart);
  const page = await api(origin, 'messages', token, { thread: baseline.thread });
  assert.equal(page.items[0].body.text, 'Сохранённый ответ');
  assert.ok(store.db.prepare('SELECT id FROM draft_actions WHERE id=?').get(baseline.draft), baseline.draft);
  const publication = store.db.prepare('SELECT case_id,user FROM published WHERE id=?').get(expected.publication.id);
  assert.deepEqual({ ...publication }, { case_id: expected.publication.case_id, user: expected.publication.user });
}

async function localMain({ origin, store, token, expected, state, boot }) {
  const { group, pinned, threshold, partial, kpi } = expected.local;
  const row = store.db.prepare('SELECT id,owner,scope,title FROM conversations WHERE id=?').get(group.id);
  const { seq, text, ...conversation } = group;
  assert.deepEqual({ ...row }, conversation);
  const transcript = await api(origin, 'messages', token, { thread: group.id });
  assert.ok(transcript.items.some(item => item.seq === seq && item.body.text === text));
  const pins = await api(origin, 'case-materials', token, { caseId: pinned.caseId });
  assert.ok(pins.items.some(item => item.id === pinned.id && item.title === pinned.title), pinned.id);
  const thresholdRun = (await api(origin, 'investigation-status', token, { caseId: threshold.caseId })).current;
  assert.equal(thresholdRun.id, threshold.id);
  assert.deepEqual(thresholdRun.thresholdObservation, threshold.result);
  const kpiRow = store.db.prepare('SELECT id,title,body FROM cases WHERE id=?').get(kpi.id);
  assert.equal(kpiRow.title, kpi.title);
  const kpiBody = JSON.parse(kpiRow.body);
  assert.equal(kpiBody.owner, kpi.owner);
  assert.deepEqual(kpiBody.plan.measurement, kpi.measurement);

  const investigation = async () => (await api(origin, 'investigation-status', token, { caseId: partial.caseId })).current;
  const before = await investigation();
  assert.equal(before.id, partial.id);
  const evidence = () => store.db.prepare('SELECT role,output FROM case_investigation_stages WHERE run_id=? AND role=?')
    .get(partial.id, partial.completed.role);
  assert.deepEqual({ ...evidence() }, partial.completed);
  if (boot === 1) assert.equal(before.status, partial.status);
  const { listInvestigationWork, tryStartInvestigation } = await import('../server/case-investigations.mjs');
  state.roleCalls ??= [];
  const clock = () => partial.resumeAt;
  for (let stage = 0; stage < partial.remaining.length + 1; stage++) {
    const work = listInvestigationWork(store, partial.env, clock(), partial.id)[0];
    if (!work) break;
    await tryStartInvestigation(store, work, partial.env, noTransport, {
      now: clock,
      async execute({ stage: role, run }) {
        assert.equal(run.id, partial.id);
        state.roleCalls.push(role);
        return { check: { role, outcome: 'Готово' }, result: { conclusion: role } };
      },
    });
  }
  assert.deepEqual(state.roleCalls, partial.remaining);
  assert.deepEqual({ ...evidence() }, partial.completed);
  assert.equal((await investigation()).status, 'ready');
}

async function profileUi({ app, origin, expected, boot }) {
  const { user, peer, token, peerToken, avatar, thread, historic, current, invite } = expected.profile;
  assert.deepEqual((await api(origin, 'session', token)).user, { ...user, avatar });
  assert.equal((await api(origin, 'session', peerToken)).user.id, peer.id);
  for (const [session, ownsCurrent] of [[token, true], [peerToken, false]]) {
    const { items } = await api(origin, 'messages', session, { thread });
    const previous = items.find(item => item.seq === historic.seq);
    assert.equal(previous?.body.text, historic.text);
    assert.equal(previous.own, false);
    const newItem = items.find(item => item.seq === current.seq);
    assert.equal(newItem?.body.text, current.text);
    assert.equal(newItem.own, ownsCurrent);
  }
  if (boot === 1) {
    const joined = await api(origin, 'register', undefined, {
      login: 'fixture-invited', name: 'Приглашённый участник', password, code: invite,
    });
    assert.equal(joined.role, 'member');
    assert.equal(joined.space, 'team');
  } else {
    assert.ok(app.accounts.db.prepare("SELECT id FROM users WHERE login='fixture-invited'").get());
    const second = await fetch(origin + '/api/team/register', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ login: 'fixture-reused', name: 'Вторая попытка', password, code: invite }),
    });
    assert.ok(second.status >= 400, 'the historical invitation is single-use across restarts');
  }
}

async function signalBridge({ app, origin, store, user, token, expected, state, boot }) {
  const { contact, issue, closure, page, observation, source, deck, deliveries } = expected.integration;
  const { db } = store;
  assert.equal((await api(origin, 'contacts', token, {})).email, contact);
  const confirmed = await api(origin, 'confirm', token, { id: issue.draft, revision: issue.revision });
  assert.equal(String(confirmed.key), issue.key);
  assert.equal(confirmed.url, issue.url);
  assert.equal(issue.externalWrites, 1);
  const closureRow = db.prepare('SELECT case_id,body FROM redmine_results WHERE id=?').get(closure.id);
  assert.equal(closureRow.case_id, issue.caseId);
  const closureBody = JSON.parse(closureRow.body);
  assert.equal(closureBody.episode, closure.episode);
  assert.equal(closureBody.personalOwner, user.id);
  assert.equal(String(closureBody.issue), issue.key);
  assert.equal(closureBody.url, issue.url);
  const pageRead = await api(origin, 'page_read', token, { key: page.key, local: true });
  assert.equal(pageRead.key, page.key);
  assert.equal(pageRead.url, page.url);
  assert.equal(pageRead.version, page.version);
  assert.equal(pageRead.title, page.title);
  assert.equal(pageRead.text, page.text);
  const storedCase = db.prepare('SELECT body FROM cases WHERE id=?').get(observation.input.caseId);
  const caseBody = JSON.parse(storedCase.body);
  assert.equal(caseBody.owner, user.id);
  assert.deepEqual(caseBody.watch, observation.plan);
  const evaluated = await api(origin, 'effect-preview', token, observation.input);
  assert.equal(evaluated.baseline.value, observation.baseline);
  assert.equal(evaluated.observed.value, observation.observed);
  assert.equal(evaluated.control?.relativeChange, observation.controlChange);
  assert.equal(evaluated.state, observation.state);
  assert.deepEqual((await api(origin, 'knowledge-source', token, { version: source.version, loc: source.loc })).rows[0], source.row);

  const { workPresentations } = await import('../server/presentations.mjs');
  const status = () => api(origin, 'presentation-status', token, { id: deck.id });
  const prebuilt = await api(origin, 'presentation-status', token, { id: deck.prebuilt.id });
  assert.equal(prebuilt.status, 'ready');
  assert.deepEqual(prebuilt.slides, deck.prebuilt.slides);
  assert.ok((boot === 1 ? ['running', 'queued'] : ['ready']).includes((await status()).status));
  if (boot === 1) await workPresentations(store, { DATA_PROFILE: 'local' }, noTransport);
  assert.equal((await status()).status, 'ready');
  assert.equal((await api(origin, 'presentation-create', token, { caseId: issue.caseId, request: deck.request })).id, deck.id);
  assert.equal(db.prepare('SELECT count(*) AS n FROM presentations WHERE author=? AND request=?').get(user.id, deck.request).n, 1);
  assert.equal(db.prepare('SELECT author FROM presentations WHERE id=?').get(deck.id).author, user.id);
  const html = await fetch(origin + '/api/presentations/' + deck.id + '/preview', { headers: { cookie: 'pm_session=' + token } });
  assert.equal(html.status, 200);
  assert.ok((await html.text()).includes(deck.title));

  state.sends ??= [];
  const { deliver } = await import('../server/workbench.mjs');
  for (let attempt = 0; attempt < 2; attempt++) {
    await deliver(store, expected.env, noTransport, async (_text, _env, to) => state.sends.push(to), app.accounts.db);
  }
  const deliveryRows = db.prepare('SELECT id,state,attempts FROM deliveries WHERE id=?').all(deliveries.id);
  assert.deepEqual(deliveryRows.map(row => ({ ...row })), [{ id: deliveries.id, state: 'delivered', attempts: 1 }]);
  assert.deepEqual(state.sends, Array(deliveries.sends).fill(contact));
  assert.equal(db.prepare('SELECT count(*) AS n FROM redmine_results WHERE case_id=?').get(issue.caseId).n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM draft_actions WHERE id=? AND state='done'").get(issue.draft).n, 1);
}
