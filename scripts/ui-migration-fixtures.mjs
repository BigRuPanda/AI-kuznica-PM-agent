import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const password = 'fixture-password';
const localEnv = { DATA_PROFILE: 'local' };
const modelEnv = {
  DATA_PROFILE: 'configured',
  LLM_BACKEND: 'api',
  LLM_BASE_URL: 'http://127.0.0.1:1/v1',
  LLM_MODEL: 'migration-fixture',
  LLM_DATA_MODE: 'analysis',
};
const noTransport = () => assert.fail('Unexpected external request');
export const donorCommits = Object.freeze({
  'local-main': 'd90bf9f99718c3d26eb4166ba63bd7dc0074a592',
  'profile-ui': '2f7a3c0a7ea59ac1adf66b60560a11e1a403999f',
  'signal-bridge': 'e662119b6af4ada1e8a90a5ee547bfeda78c0230',
});
const donorOptions = [
  ['local', 'local-main', seedLocal],
  ['ui', 'profile-ui', seedProfile],
  ['integration', 'signal-bridge', seedIntegration],
];

function load(donor, file) {
  return import(pathToFileURL(join(donor, file)).href);
}

async function commitAt(donor, name) {
  const git = (...args) => execFileSync('git', ['-C', donor, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let commit;
  try {
    if (await realpath(git('rev-parse', '--show-toplevel')) === donor) commit = git('rev-parse', 'HEAD');
  } catch {
    // Prepared source exports record their SHA beside the exported directory.
  }
  commit ??= (await readFile(join(dirname(donor), name + '.sha'), 'utf8')).trim();
  assert.equal(commit, donorCommits[name], 'Unexpected donor commit for ' + name);
  return commit;
}

async function writeJson(dir, file, value) {
  await writeFile(join(dir, file), JSON.stringify(value, null, 2) + '\n', { flag: 'wx' });
}

async function seedDonor(donor, dir, kind, commit, seed) {
  const [{ seedWorkspace, fixtureEnv }, { createTeamApp }, { workspaceOperation }] = await Promise.all([
    load(donor, 'tests/workspace-fixture.mjs'),
    load(donor, 'server/team-http.mjs'),
    load(donor, 'server/workspace-operations.mjs'),
  ]);
  await mkdir(dir);
  const baseline = await seedWorkspace(dir);
  const app = createTeamApp({
    base: join(dir, 'releases.sqlite'), env: { ...fixtureEnv, ...localEnv },
    background: false, send: noTransport, sendMail: noTransport,
  });
  let manifest;
  try {
    const store = app.space('team');
    const { user, token } = await app.accounts.login({ login: 'fixture-admin', password });
    const variant = await seed({ donor, app, store, user, token, baseline, workspaceOperation });
    const accounts = app.accounts.db.prepare('SELECT id,login,name,space,role FROM users ORDER BY login').all();
    const publication = store.db.prepare('SELECT id,case_id,user FROM published WHERE case_id=?').get(baseline.caseId);
    assert.ok(publication);
    const judges = accounts.filter(account => account.role === 'judge');
    assert.ok(judges.length > 0, 'The donor must seed a judge workspace');
    const judgeWorkspaces = judges.map(judge => seedJudge(app, workspaceOperation, judge, baseline.calc));
    manifest = { kind, commit, accounts, judgeWorkspaces, publication, ...variant };
  } finally {
    await app.close();
  }
  await writeJson(dir, 'baseline.json', baseline);
  await writeJson(dir, 'manifest.json', manifest);
}

function seedJudge(app, workspaceOperation, judge, teamCalculation) {
  const store = app.space(judge.space);
  const op = (name, data) => workspaceOperation(store, judge, name, data, localEnv, noTransport);
  const title = 'Исторический расчёт в пространстве жюри';
  const { id: caseId } = op('create-case', { title, product: 'Kaspersky' });
  const { view } = op('view', { caseId, control: 'Astra', through: '2026-11-21' });
  assert.notEqual(view.id, teamCalculation);
  const { summary } = op('calc', { id: view.id });
  const { product, before, after, rows } = summary[0];
  assert.deepEqual([product, before, after], ['Kaspersky', 100, 70]);
  const point = rows.find(row => row.value === 70 && !row.partial);
  assert.ok(point?.version);
  return {
    accountId: judge.id,
    path: 'workspaces/' + judge.space + '.sqlite',
    case: { id: caseId, title },
    calculation: { id: view.id, product, before, after, point },
  };
}

async function donorApi(app, token) {
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  return async (op, body) => {
    const response = await fetch(origin + '/api/team/' + op, {
      method: 'POST',
      headers: { cookie: 'pm_session=' + token, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    const value = await response.json();
    assert.ok(response.ok, op + ' returned ' + response.status + ': ' + JSON.stringify(value));
    return value;
  };
}

async function seedLocal({ donor, app, store, user, token, baseline, workspaceOperation }) {
  const [{ cases, getCase, importDocs }, investigations, { saveResearchSettings }, { stageOrder }] = await Promise.all([
    load(donor, 'server/evidence.mjs'),
    load(donor, 'server/case-investigations.mjs'),
    load(donor, 'server/investigation-settings.mjs'),
    load(donor, 'server/investigation-stages.mjs'),
  ]);
  const { db } = store;
  const api = await donorApi(app, token);
  const title = 'Историческая группа Store';
  const { id: groupId } = await api('thread', { title, group: true });
  const text = 'Сохранённое решение команды по показателю';
  await api('say', { thread: groupId, question: text });
  const group = db.prepare('SELECT id,owner,scope,title FROM conversations WHERE id=?').get(groupId);
  const { seq } = db.prepare('SELECT seq FROM chat_items WHERE thread=?').get(groupId);
  const pin = await api('pin-material', { id: baseline.chart, caseId: baseline.caseId });
  assert.equal(pin.pinned, true);
  const { items } = await api('case-materials', { caseId: baseline.caseId });
  const pinned = items.find(item => item.id === baseline.chart);
  assert.ok(pinned);

  const sales = (product, values) => values.map((orders_index, index) => ({
    kind: 'sales', loc: product + '!A' + (index + 1),
    row: { product_family: product, week_start: ['2026-05-04', '2026-05-11'][index], orders_index },
  }));
  const thresholdProduct = 'Astra Linux Special Edition';
  importDocs(store, [{ file: 'Индексы мая.xlsx', facts: [
    { kind: 'dictionary', loc: 'Правило!A1', row: { metric_id: 'family_orders_idx', bad_signal: 'Индекс ниже 90 две недели подряд' } },
    ...sales(thresholdProduct, [42, 42]),
    ...sales('Контроль мая', [62, 123]),
  ] }], { notify: false });
  const thresholdCase = cases(db).find(item => item.product === thresholdProduct);
  const thresholdId = investigations.readInvestigations(db, user, thresholdCase.id).current.id;
  const prepareThreshold = investigations.listInvestigationWork(store, localEnv, Date.now(), thresholdId)[0];
  assert.ok(prepareThreshold);
  await investigations.tryStartInvestigation(store, prepareThreshold, localEnv, noTransport);
  const threshold = investigations.readInvestigations(db, user, thresholdCase.id).current;
  assert.equal(threshold.thresholdObservation.threshold, 90);
  assert.deepEqual(threshold.thresholdObservation.weeks.map(week => week.value), [42, 42]);

  const kpi = workspaceOperation(store, user, 'create-case', {
    title: 'Согласовать KPI карточек рекомендаций',
    product: 'Личный кабинет',
    measurement: { metric: 'lk_reco_ctr', comparison: 'gte', targetMode: 'absolute', targetValue: 5 },
  });
  const kpiCase = getCase(db, kpi.id);
  assert.equal(kpiCase.body.plan.measurement.targetValue, 5);

  saveResearchSettings(db, user, { scope: 'personal', mode: 'roles' });
  const partialId = investigations.readInvestigations(db, user, baseline.caseId).current.id;
  const time = Date.now();
  const clock = () => time;
  const next = () => investigations.listInvestigationWork(store, modelEnv, time, partialId)[0];
  await investigations.tryStartInvestigation(store, next(), modelEnv, noTransport, { now: clock });
  assert.equal(next()?.role, 'analyst');
  const execute = async ({ stage }) => ({ check: { role: stage, outcome: 'Исходный расчёт сохранён' } });
  await investigations.tryStartInvestigation(store, next(), modelEnv, noTransport, { now: clock, execute });
  assert.equal(next()?.role, 'researcher');
  await investigations.tryStartInvestigation(store, next(), modelEnv, noTransport, {
    now: clock, async execute() { throw Object.assign(Error('Фикстура сбоя проверки'), { status: 500 }); },
  });
  const partial = investigations.readInvestigations(db, user, baseline.caseId).current;
  const completed = db.prepare("SELECT role,output FROM case_investigation_stages WHERE run_id=? AND role='analyst'").get(partial.id);
  assert.ok(completed?.output);
  const { next: resumeAt } = db.prepare("SELECT next FROM case_investigation_role_state WHERE run_id=? AND role='researcher'").get(partial.id);
  assert.ok(resumeAt > time);
  return { local: {
    group: { ...group, seq, text },
    pinned: { id: pinned.id, title: pinned.title, caseId: pin.caseId },
    threshold: { id: threshold.id, caseId: thresholdCase.id, result: threshold.thresholdObservation },
    partial: { id: partial.id, caseId: baseline.caseId, status: partial.status, completed,
      env: modelEnv, resumeAt, remaining: stageOrder.roles.filter(role => role !== completed.role) },
    kpi: { ...kpi, owner: kpiCase.body.owner, measurement: kpiCase.body.plan.measurement },
  } };
}

// An 8 by 8 blue JPEG created for the synthetic account.
const avatar = 'data:image/jpeg;base64,' + [
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/',
  '2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAAIAAgDASIAAhEBAxEB',
  '/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2Jy',
  'ggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLD',
  'xMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3',
  'AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6',
  'goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDh6KKK/rM/Lz//2Q==',
].join('');

async function seedProfile({ app, store, user, token }) {
  const { accounts } = app;
  const profile = accounts.updateProfile(user.id, { name: 'Алексей Иванов', avatar });
  const { user: member, token: peerToken } = await accounts.login({ login: 'fixture-member', password });
  const peer = accounts.updateProfile(member.id, { name: profile.name });
  const api = await donorApi(app, token);
  const { id: thread } = await api('thread', { title: 'Общий чат с одноимёнными участниками', group: true });
  // This historical record predates authorId and has no matching job.
  const historicText = 'Старая реплика без подтверждённого автора';
  const historic = Number(store.db.prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES(?,?,'user',?,?)")
    .run(thread, profile.name, JSON.stringify({ text: historicText }), Date.now()).lastInsertRowid);
  const currentText = 'Новая реплика с подтверждённым автором';
  await api('say', { thread, question: currentText });
  const { items } = await api('messages', { thread });
  assert.deepEqual(items.map(item => item.own), [false, true]);
  return { profile: {
    user: profile, peer, token, peerToken, avatar, thread,
    historic: { seq: historic, text: historicText },
    current: { seq: items[1].seq, text: currentText },
    invite: accounts.invite('team'),
  } };
}

function redmineFixture() {
  const project = { id: 7, trackers: [{ id: 1, name: 'Задача' }] };
  const remote = { issue: null, writes: 0 };
  remote.send = async (url, options = {}) => {
    const { origin, pathname } = new URL(url);
    assert.equal(origin, 'https://redmine.migration.invalid');
    switch (pathname) {
      case '/pm/users/current.json': return Response.json({ user: { id: 5 } });
      case '/pm/projects/store.json': return Response.json({ project });
      case '/pm/enumerations/issue_priorities.json': return Response.json({ issue_priorities: [] });
      case '/pm/projects/store/memberships.json': return Response.json({ memberships: [] });
      case '/pm/issues.json': {
        assert.equal(options.method, 'POST');
        assert.equal(remote.writes++, 0, 'Redmine issue committed once before the upgrade');
        const { issue } = JSON.parse(options.body);
        remote.issue = { id: 38, project, subject: issue.subject, description: issue.description, journals: [] };
        return Response.json({ issue: remote.issue });
      }
      case '/pm/issues/38.json': return Response.json({ issue: remote.issue });
      default: throw Error('Unexpected fixture path ' + pathname);
    }
  };
  return remote;
}

async function seedIntegration({ donor, app, store, user, workspaceOperation }) {
  const [{ digest }, { importApproved, sourcePermission }, { contactAction }, tracker, watches, presentations] = await Promise.all([
    load(donor, 'server/evidence.mjs'),
    load(donor, 'server/source-policy.mjs'),
    load(donor, 'server/notification-contacts.mjs'),
    load(donor, 'server/tracker-connections.mjs'),
    load(donor, 'server/redmine-watch.mjs'),
    load(donor, 'server/presentations.mjs'),
  ]);
  const { db } = store;
  const raw = Buffer.from('Synthetic archive parsed by the migration fixture');
  const env = {
    DATA_PROFILE: 'configured',
    SOURCE_ARCHIVE_SHA256: digest(raw),
    INTEGRATION_KEY: Buffer.alloc(32, 17).toString('base64url'),
    SMTP_HOST: '127.0.0.1',
    SMTP_FROM: 'migration@example.test',
    SMTP_TLS: 'local-test',
  };
  const contact = 'fixture-owner@example.test';
  let code;
  await contactAction('email-request', { address: contact }, user, app.accounts.db, env, async (text, address) => {
    assert.equal(address, contact);
    code = text.match(/\b\d{8}\b/u)?.[0];
    assert.ok(code);
  });
  assert.equal((await contactAction('email-confirm', { code }, user, app.accounts.db, env)).email, contact);

  const product = 'Astra OS', control = 'Kaspersky Pro', releaseId = 'R-UPGRADE-1';
  const sourceFile = 'Астра · недели.xlsx', loc = 'Astra!A2';
  const sales = (family, sheet, values) => values.map((orders_index, index) => ({
    kind: 'sales', loc: sheet + '!A' + (index + 2),
    row: { product_family: family, week_start: ['2026-04-06', '2026-04-20'][index], orders_index },
  }));
  const archive = [
    ...db.prepare('SELECT body FROM documents WHERE version IN (SELECT DISTINCT version FROM facts)').all().map(row => JSON.parse(row.body)),
    { file: 'Журнал релизов.xlsx', facts: [{ kind: 'releases', loc: 'Релизы!A2', row: {
      release_id: releaseId, release_date: '2026-04-15', release_type: 'minor', status: 'выпущен',
      description: 'Обновление Astra OS', affected_metrics: 'family_orders_idx',
    } }] },
    { file: sourceFile, facts: sales(product, 'Astra', [40, 30]) },
    { file: 'Контроль релиза.xlsx', facts: sales(control, 'Контроль', [20, 40]) },
  ];
  importApproved(store, archive, sourcePermission(db, env.SOURCE_ARCHIVE_SHA256, raw, 'migration.zip'), false);
  const remote = redmineFixture();
  const op = (name, data) => workspaceOperation(store, user, name, data, env, remote.send);
  const title = 'Архивный релиз и закрытая задача';
  const { id: caseId } = await op('create-case', { product, release: releaseId, title });
  const input = { caseId, metric: 'orders_index', segment: 'all', releaseId, baselineWeeks: 1,
    observationWeeks: 1, control, asOf: '2026-04-30' };
  const observed = await op('watch', input);
  assert.deepEqual([observed.baseline.value, observed.observed.value, observed.control.relativeChange], [40, 30, 100]);
  const { version } = db.prepare('SELECT version FROM documents WHERE file=?').get(sourceFile);
  const { rows: [row] } = await op('knowledge-source', { version, loc });
  assert.equal(row.value.orders_index, 40);
  tracker.configure(db, user, { service: 'redmine', url: 'https://redmine.migration.invalid/pm', scope: 'store' }, env);
  await tracker.personalConnection(db, user, { service: 'redmine', action: 'connect', token: 'local-fixture-key' }, env, remote.send);
  const draft = await op('draft', { caseId, title: 'Проверить разметку заказов', description: 'Сверить выборку до и после выкладки' });
  const receipt = await op('confirm', { id: draft.id, revision: draft.revision });
  assert.equal(String(receipt.key), '38');
  Object.assign(remote.issue, {
    status: { id: 6, name: 'Закрыта', is_closed: true },
    closed_on: '2026-04-30T12:00:00Z',
  });
  await watches.syncWatches(store, app.accounts, env, remote.send);
  const result = db.prepare('SELECT id,body FROM redmine_results WHERE case_id=?').get(caseId);
  const closure = JSON.parse(result.body);
  assert.equal(closure.episode, 1);
  assert.equal(closure.personalOwner, user.id);
  const { page: pageKey } = db.prepare('SELECT page FROM redmine_result_pages WHERE result=?').get(result.id);
  const page = await op('page_read', { key: pageKey, local: true });
  assert.equal(page.version, 1);
  const { id: deliveryId } = db.prepare("SELECT id FROM deliveries WHERE id=? AND state='queued'").get(result.id + '/smtp');
  const { id: readyDeck } = presentations.startPresentation(store, user, caseId, 'migration-prebuilt');
  await presentations.workPresentations(store, localEnv, noTransport);
  const { deck: originalDeck, status } = presentations.readPresentation(db, user, readyDeck);
  assert.equal(status, 'ready');
  const request = 'migration-interrupted';
  const { id } = presentations.startPresentation(store, user, caseId, request);
  // The lease represents the controlled stop after the worker acquired this job.
  db.prepare("UPDATE presentations SET status='running',lease=0 WHERE id=?").run(id);
  return { env, integration: {
    contact, issue: { key: String(receipt.key), url: receipt.url, caseId, draft: draft.id, revision: draft.revision,
      externalWrites: remote.writes },
    closure: { id: result.id, episode: closure.episode },
    page: { key: page.key, title: page.title, text: page.text, version: page.version, url: page.url },
    observation: { input, plan: observed.plan, baseline: observed.baseline.value, observed: observed.observed.value,
      controlChange: observed.control.relativeChange, state: observed.state },
    source: { version, loc, row, url: '#knowledge-source/' + version + '/' + loc },
    deck: { id, request, title, prebuilt: { id: readyDeck, slides: originalDeck.slides.map(slide => slide.title) } },
    deliveries: { id: deliveryId, sends: 1 },
  } };
}

async function main() {
  const keys = [...donorOptions.map(([name]) => name), 'out'];
  const { values } = parseArgs({
    options: Object.fromEntries(keys.map(name => [name, { type: 'string' }])),
  });
  assert.ok(keys.every(name => values[name]),
    'Usage: node scripts/ui-migration-fixtures.mjs --local <checkout> --ui <checkout> --integration <checkout> --out <empty-directory>');
  const inputs = await Promise.all(donorOptions.map(async ([flag, kind, seed]) => {
    const donor = await realpath(values[flag]);
    return { donor, kind, commit: await commitAt(donor, kind), seed };
  }));
  const requested = resolve(values.out);
  await mkdir(requested, { recursive: true });
  const output = await realpath(requested);
  assert.deepEqual(await readdir(output), [], 'The fixture output directory must be empty');
  for (const { donor, kind, commit, seed } of inputs) {
    const dir = join(output, kind);
    await seedDonor(donor, dir, kind, commit, seed);
    console.log(kind + '@' + commit + ' ' + dir);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
