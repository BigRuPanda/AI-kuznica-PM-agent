import assert from 'node:assert/strict';
import { cp, lstat, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { donorCommits } from '../scripts/ui-migration-fixtures.mjs';
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
  const response = await teamRequest(origin, op, token, data);
  const body = await response.json();
  assert.ok(response.ok, op + ' returned ' + response.status + ': ' + JSON.stringify(body));
  return body;
}

function teamRequest(origin, op, token, data) {
  const headers = {};
  if (token) headers.cookie = 'pm_session=' + token;
  if (data !== undefined) headers['content-type'] = 'application/json';
  return fetch(origin + '/api/team/' + op, {
    method: data === undefined ? 'GET' : 'POST', headers, body: JSON.stringify(data),
  });
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
    assert.equal(expected.commit, donorCommits[name], 'Unexpected donor commit for ' + name);
    const judges = expected.accounts.filter(account => account.role === 'judge');
    assert.ok(judges.length > 0, name + ' has no judge account in its manifest');
    assert.ok(Array.isArray(expected.judgeWorkspaces), name + ' manifest is missing judge workspaces');
    assert.deepEqual(expected.judgeWorkspaces.map(judge => judge.accountId).sort(), judges.map(judge => judge.id).sort());
    for (const judge of expected.judgeWorkspaces) {
      const { space } = judges.find(account => account.id === judge.accountId);
      assert.match(space, /^[a-f0-9-]{36}$/u);
      assert.equal(judge.path, 'workspaces/' + space + '.sqlite');
      const path = join(source, judge.path);
      const file = await lstat(path).catch(error => {
        throw Error('Missing judge workspace database for ' + name + ' at ' + path, { cause: error });
      });
      assert.ok(file.isFile() && file.size > 0, 'Expected a populated judge workspace database at ' + path);
    }
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
  }
  for (const judge of expected.judgeWorkspaces) {
    const account = expected.accounts.find(account => account.id === judge.accountId);
    await checkJudgeWorkspace(app, origin, token, baseline, account, judge);
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

async function checkJudgeWorkspace(app, origin, teamToken, baseline, account, expected) {
  const { user, token } = await app.accounts.login({ login: account.login, password });
  assert.deepEqual({ ...user }, account);
  const db = app.space(user.space).db;
  const oldCase = db.prepare("SELECT title,json_extract(body,'$.owner') AS owner FROM cases WHERE id=?")
    .get(expected.case.id);
  assert.deepEqual({ ...oldCase }, { title: expected.case.title, owner: account.id });
  const calculation = expected.calculation;
  const { summary } = await api(origin, 'calc', token, { id: calculation.id });
  const actual = summary.find(row => row.product === calculation.product);
  assert.equal(actual?.before, calculation.before);
  assert.equal(actual?.after, calculation.after);
  assert.deepEqual(actual.rows.find(row => row.week === calculation.point.week), calculation.point);
  for (const [operation, session, id] of [['material', token, baseline.report], ['calc', teamToken, calculation.id]]) {
    const denied = await teamRequest(origin, operation, session, { id });
    assert.ok([400, 403, 404].includes(denied.status),
      'Access to ' + operation + ' in another workspace must be denied, got ' + denied.status);
    assert.ok((await denied.json()).error);
  }
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
  const savedSource = await api(origin, 'knowledge-source', token, { version: source.version, loc: source.loc });
  assert.equal(savedSource.version, source.version);
  // The historical sales row has no linked URLs or comparison offer.
  assert.deepEqual(savedSource.rows[0], { ...source.row, links: [], offer: false });

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
  const pending = () => db.prepare('SELECT id,state,attempts FROM deliveries WHERE id=?')
    .all(deliveries.id).map(row => ({ ...row }));
  const recordMail = async (_text, _env, to) => state.sends.push(to);
  const smtp = { ...expected.env, NOTIFICATION_CHANNELS: 'smtp' };
  if (boot === 1) {
    await deliver(store, { ...smtp, NOTIFICATIONS_ENABLED: 'false' }, noTransport, recordMail, app.accounts.db);
    assert.deepEqual(pending(), [{ id: deliveries.id, state: 'queued', attempts: 0 }]);
    assert.deepEqual(state.sends, []);
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    await deliver(store, { ...smtp, NOTIFICATIONS_ENABLED: 'true' }, noTransport, recordMail, app.accounts.db);
  }
  assert.deepEqual(pending(), [{ id: deliveries.id, state: 'delivered', attempts: 1 }]);
  assert.deepEqual(state.sends, Array(deliveries.sends).fill(contact));
  assert.equal(db.prepare('SELECT count(*) AS n FROM redmine_results WHERE case_id=?').get(issue.caseId).n, 1);
  assert.equal(db.prepare("SELECT count(*) AS n FROM draft_actions WHERE id=? AND state='done'").get(issue.draft).n, 1);
}
