import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { analysisView, digest, initEvidence } from '../server/evidence.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { releaseDecision } from '../server/release-decision.mjs';

const archive = process.env.SIGNAL_RELEASE_ARCHIVE ||
  join(homedir(), 'Downloads', 'drive-download-20261127T092715Z-1-001.zip');
const hasArchive = existsSync(archive);
const adminPassword = 'release-test-password';

test('release decision validates dates and rejects private cases before loading source facts', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initEvidence(db);
    db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)')
      .run('private-case', 'private-product', 'Личный разбор', 'Исследуем', '{"owner":"account"}');
    assert.throws(() => releaseDecision(db, { id: 'account' }, { through: '2026-02-30' }), /дату среза/);
    assert.throws(() => releaseDecision(db, { id: 'guest' }, { caseId: 'private-case' }), /Разбор недоступен/);
    assert.throws(() => releaseDecision(db, { id: 'account' }, { caseId: 'private-case' }, true), /Разбор недоступен/);
    assert.throws(() => releaseDecision(db, { id: 'account' }, {}), /нет недельных продаж/);
  } finally {
    db.close();
  }
});

test('historical calculation derives its pivot from available weeks and clips dated evidence', () => {
  const db = new DatabaseSync(':memory:');
  try {
    initEvidence(db);
    const add = (kind, key, data) => db.prepare('INSERT INTO facts VALUES(?,?,?,?,?,?)')
      .run(kind, key, 'v1', 'source.xlsx', 'Sheet!' + key, JSON.stringify(data));
    for (const week of ['2026-03-30', '2026-04-06', '2026-04-13'])
      add('sales', week, { product_family:'Product', week_start:week, orders_index:100 });
    add('releases','R-01',{ release_id:'R-01',release_date:'2026-04-07',description:'Previous Product change',
      release_type:'analytics',status:'выпущен' });
    add('releases','R-02',{ release_id:'R-02',release_date:'2026-04-10',description:'New Product release',
      release_type:'major',status:'выпущен' });
    for (const [date, n, d] of [['2026-04-08',4,13],['2026-04-09',7,17]])
      add('metrics', date, { metric_id:'cfg_reach_rate',product:'Product',date,
        detail_json:JSON.stringify({configurator_visits:n,family_visits:d}) });
    const result = analysisView(db,{ product:'Product', through:'2026-04-08' });
    assert.equal(result.pivot,'2026-03-30');
    assert.deepEqual(result.timeline.map(row=>row.data.release_id),['R-01']);
    assert.deepEqual(result.summary[0].rows.map(row=>row.week),['2026-03-30']);
    assert.deepEqual([result.reach.n,result.reach.d],[4,13]);

    add('releases','Z',{release_id:'R-00',release_date:'2026-03-20',description:'Earlier Product release',
      release_type:'major',status:'выпущен'});
    for (let i=0;i<13;i++)
      add('releases','A'+i,{release_id:'Future-'+i,release_date:'2026-04-11',description:'Future Product release',
        release_type:'major',status:'выпущен'});
    assert.equal(analysisView(db,{product:'Product',through:'2026-04-08'}).pivot,'2026-03-16');
  } finally {
    db.close();
  }
});

async function workspace(t) {
  const bytes = await readFile(archive);
  const directory = await mkdtemp(join(tmpdir(), 'signal-release-'));
  const env = {
    SOURCE_ARCHIVE_SHA256: digest(bytes),
    ADMIN_INVITE_KEY: 'release-test-invite',
    PYTHON_BIN: process.env.PYTHON_BIN || (process.platform === 'win32' ? 'python' : 'python3'),
  };
  const app = createTeamApp({ base: join(directory, 'data.sqlite'), env, background: false });
  t.after(async () => {
    await app.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  async function account(login, code) {
    const response = await fetch(base + '/api/team/register', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ login, name: login, password: adminPassword, code }),
    });
    assert.equal(response.status, 200);
    return { user: await response.json(), cookie: response.headers.get('set-cookie').split(';')[0] };
  }
  const owner = await account('release-admin', env.ADMIN_INVITE_KEY);
  const upload = await fetch(base + '/api/team/upload', {
    method: 'POST',
    headers: { cookie: owner.cookie, 'x-file-name': encodeURIComponent(basename(archive)) },
    body: bytes,
  });
  assert.equal(upload.status, 200, await upload.text());
  const post = async (op, data = {}, cookie = owner.cookie) => {
    const response = await fetch(base + '/api/team/' + op, {
      method: 'POST', headers: { 'Content-Type': 'application/json', cookie },
      body: JSON.stringify(data),
    });
    return { status: response.status, body: await response.json() };
  };
  const call = async (op, data, cookie) => {
    const result = await post(op, data, cookie);
    assert.equal(result.status, 200, result.body.error);
    return result.body;
  };
  return { app, env, base, owner, post, call, account };
}

test('organizer archive supplies both families, verifiable evidence, and historical boundaries', {
  skip: !hasArchive && 'Organizer ZIP is unavailable',
}, async t => {
  const { app, env, owner, call, post, account } = await workspace(t);
  const current = await call('release_decision');
  const { product, asOf, release, competitor, backlog, customer, measurement, trend } = current;
  assert.equal(product, 'Kaspersky Endpoint Security');
  assert.equal(asOf, '2026-11-15');
  assert.equal(release.id, 'R-09');
  assert.deepEqual(current.delivered.map(row => row.id), ['T-07']);
  assert.equal(trend.baseline.mean, 1889 / 12);
  assert.equal(trend.current.mean, 108);
  assert.equal(trend.change.toFixed(2), '-31.39');
  assert.equal(trend.baseline.rows.length + trend.current.rows.length, 16);
  assert.equal(trend.current.end, asOf);
  assert.equal(backlog.id, 'T-08');
  assert.equal(measurement.metric, 'cfg_add_to_cart_rate');
  assert.equal(customer.excerpt, 'Сдерживает онлайн: запутанная политика версий ПО');
  assert.equal(customer.loc, 'Активные!L9');
  assert.deepEqual([competitor.merchant, competitor.sku, competitor.match, competitor.checked,
    competitor.competitorPrice, competitor.storePrice], ['allsoft.ru', 'KL4863RAKFS', 'Да', '2026-10-27', 36870, 33182.1]);
  for (const evidence of [release, competitor, backlog, customer, measurement, ...trend.current.rows]) {
    const source = await call('knowledge-source', { version: evidence.version, loc: evidence.loc });
    assert.equal(source.file, evidence.file);
    assert.equal(source.rows[0].loc, evidence.loc);
  }
  const astra = await call('release_decision', { product: 'Astra' });
  const carousel = await call('release_decision', { releaseId: 'R-05' });
  assert.equal(carousel.product, 'ЛК');
  assert.equal(carousel.release.loc, 'Релизы!A6');
  assert.deepEqual(carousel.delivered.map(row => row.id), ['T-05']);
  assert.ok(carousel.accountEvidence.lines.some(line => line.includes('3 → 3')));
  assert.ok(carousel.accountEvidence.lines.some(line => line.includes('2 → 2')));
  assert.ok(carousel.accountEvidence.sources.some(row => row.loc === 'Релизы!A12'));
  const archived = await call('release_decision', { releaseId: 'R-05', through: '2026-08-23' });
  assert.ok(archived.accountEvidence.lines.some(line => line.includes('3/14')));
  assert.doesNotMatch(JSON.stringify(archived), /R-11|2026-10-21/);
  const linkedThread = await call('release-thread', { releaseId: 'R-05' });
  assert.deepEqual(await call('release-thread', { releaseId: 'R-05' }), linkedThread);
  assert.equal(astra.product, 'Astra Linux Special Edition');
  assert.equal(astra.release.id, 'R-02');
  assert.equal(astra.trend.baseline.mean, 112);
  assert.equal(astra.trend.current.mean, 89.25);
  assert.equal(astra.competitor.match, 'Частично');
  assert.equal(astra.measurementIssue, false);
  assert.equal(current.caseId, null);
  assert.equal(astra.caseId, null);
  const { cases } = await call('overview');
  const salesSignal = (family, rule) => cases.find(c => c.product === family &&
    c.body.signal?.rule === rule && c.body.signal.status === 'confirmed');
  const kasperskySignal = salesSignal(product, 'relative');
  assert.ok(kasperskySignal?.id, 'The archive creates a confirmed Kaspersky sales signal');
  assert.ok(salesSignal(astra.product, 'absolute')?.id, 'The archive creates a confirmed Astra sales signal');
  const early = await call('release_decision', { caseId: kasperskySignal.id, through: '2026-09-20' });
  assert.equal(early.caseId, null);
  assert.equal(early.release, null);
  assert.equal(early.customer, null);
  assert.equal(early.competitor, null);
  assert.equal(early.backlog.id, 'T-07');
  assert.doesNotMatch(early.backlog.status, /Done|Закрыта/);
  assert.equal(early.backlog.description, null);
  assert.equal(early.delivered.length, 0);
  assert.equal((await call('release_decision', { product, through: '2026-10-05' })).backlog, null);
  assert.equal((await post('release_decision', { product, through: '2026-02-30' })).status, 400);
  const privateCase = await call('create-case', { title: 'Личный разбор', product });
  const other = await account('release-member', app.accounts.invite('team'));
  const store = app.space('team');
  assert.equal((await call('release_decision', { caseId: privateCase.id })).caseId, privateCase.id);
  assert.equal((await post('release_decision', { caseId: privateCase.id }, other.cookie)).status, 400);
  assert.throws(() => workspaceOperation(store, owner.user, 'release_decision', { caseId: privateCase.id },
    env, fetch, true), /Разбор недоступен/);
  assert.equal((await post('ask', { thread: 'group', caseId: privateCase.id, question: 'Что в разборе?' })).status, 400);

  await t.test('historical views use only closed weeks and exact sales lookups accept the dictionary ID', async () => {
    const input = { product, control: astra.product, from: '2026-06-29', releaseWeek: '2026-09-28', full: true };
    const midweek = (await call('view', { ...input, through: '2026-10-21' })).view;
    assert.equal(midweek.summary[0].rows.at(-1).week, '2026-10-12');
    assert.equal(midweek.summary[0].after, (123 + 103) / 2);
    const onSunday = (await call('view', { ...input, through: '2026-10-25' })).view;
    assert.equal(onSunday.summary[0].rows.at(-1).week, '2026-10-19');
    const beforePivot = (await call('view', { ...input, through: '2026-07-09' })).view;
    assert.deepEqual(beforePivot.summary[0].rows.map(row => row.week), ['2026-06-29']);
    const ctrCut = (await call('view', { ...input, through: '2026-10-29' })).view;
    assert.equal(ctrCut.ctr.sources.length, 0);
    assert.equal((await post('view', { ...input, through: '2026-02-30' })).status, 400);
    const query = { product, date: '2026-06-01', segment: 'all' };
    assert.deepEqual(
      (await call('source_value', { ...query, metric: 'family_orders_idx' })).map(row => [row.value, row.loc]),
      [[144, 'Продажи!A6']],
    );
  });

  await t.test('the organizer historical snapshot excludes future releases and future signal weeks', async () => {
    const before = (await call('view', { caseId:kasperskySignal.id, through:'2026-09-30', full:true })).view;
    assert.equal(before.pivot,'2026-09-21');
    assert.deepEqual(before.timeline.map(row=>row.data.release_id),['R-07','R-08']);
    assert.equal(before.signal,null);
    const first = (await call('view', { caseId:kasperskySignal.id, through:'2026-11-04', full:true })).view;
    assert.deepEqual([first.signal.week,first.signal.count],['2026-10-26',1]);
    assert.deepEqual(first.signal.history.map(row=>row.week),['2026-10-26']);
    assert.match(first.signal.source,/Продажи!A27$/);
  });

  await t.test('missing ratio observation has no counts, and measured zero retains its denominator', async () => {
    const product = 'Конфигуратор Астра', metric = 'cfg_add_to_cart_rate';
    const compare = async (segment, from, to) => {
      const chart = await call('chart', { metric, product, segment });
      const r = await call('range_compare', { selection: { source:'metric', calcId:chart.id, metric,
        series:[segment], ranges:[{ from:Date.parse(from), to:Date.parse(to) }] } });
      return r.periods[0].series[0];
    };
    const absent = await compare('tablet', '2026-09-02', '2026-09-03');
    assert.deepEqual([absent.available, absent.value, absent.n, absent.d], [0, null, null, null]);
    const zero = await compare('mobile', '2026-10-05', '2026-10-12');
    assert.deepEqual([zero.available, zero.value, zero.n, zero.d], [7, 0, 0, 26]);
  });

  await t.test('sales effect applies the chosen control to the same complete windows', async () => {
    const input = { caseId: kasperskySignal.id, releaseId: 'R-09', metric: 'orders_index', segment: 'all',
      asOf: '2026-11-22', control: astra.product, target: 110 };
    const evaluated = await call('effect-preview', input);
    assert.equal(evaluated.plan.control, astra.product);
    assert.deepEqual([evaluated.baseline.value, evaluated.observed.value], [169.5, 113]);
    assert.deepEqual([evaluated.control.baseline.value, evaluated.control.observed.value], [115.5, 115.5]);
    assert.equal(evaluated.control.relativeChange, 0);
    assert.deepEqual(evaluated.control.observed.sources.map(row => row.loc),
      ['Продажи!A53', 'Продажи!A54', 'Продажи!A55', 'Продажи!A56']);
    assert.equal(evaluated.state, 'Цель достигнута');
    const early = await call('effect-preview', { ...input, asOf: '2026-10-30' });
    assert.equal(early.control.observed.count, 3);
    assert.equal(early.control.observed.value, null);
    assert.equal(early.actual, undefined);
    const oneWeek = { ...input, baselineWeeks: 1, observationWeeks: 1 };
    const shifted = await call('effect-preview', oneWeek);
    assert.equal(shifted.control.relativeChange, -12.5);
    assert.equal(shifted.state, 'Изменился контроль — требуется проверка');
    const withoutControl = await call('effect-preview', { ...oneWeek, control: '' });
    assert.equal(withoutControl.control, undefined);
    assert.equal(withoutControl.state, 'Цель достигнута');
    assert.equal((await post('effect-preview', { ...input, control: product })).status, 400);
  });
});

test('release chat requires a linked case before manual confirmation with the organizer workbook', {
  skip: !hasArchive ? 'Organizer ZIP is unavailable' : process.env.SIGNAL_RELEASE_BROWSER !== '1',
}, async t => {
  const { chromium } = await import('playwright');
  const { app, base, call } = await workspace(t);
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({ executablePath: process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined) });
  t.after(() => browser.close());
  const page = await browser.newPage({ locale: 'ru-RU', viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(15000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/#overview');
  await page.getByLabel('Логин').fill('release-admin');
  await page.getByLabel('Пароль').fill(adminPassword);
  await page.getByRole('button', { name: 'Войти', exact: true }).click();
  await page.getByRole('navigation', { name: 'Основные разделы' }).getByRole('link', { name: 'Релизы', exact: true }).click();
  await page.getByRole('link', { name: /^R-09 ·/ }).click();
  await page.getByRole('heading', { name: 'Kaspersky Endpoint Security', exact: true }).waitFor();
  await page.getByText('−31,39%', { exact: true }).waitFor();
  await page.getByRole('link', { name: /03_Цена!A86/ }).waitFor();
  await page.getByText('«Сдерживает онлайн: запутанная политика версий ПО»', { exact: true }).waitFor();
  const quote = page.getByRole('link', { name: /Активные!L9/ });
  await quote.click();
  await page.getByText('Активные!L9', { exact: true }).waitFor();
  await page.goBack();
  await page.getByRole('button', { name: 'Открыть чат разбора' }).click();
  await page.getByRole('heading', { name: 'Чат разбора · R-09' }).waitFor();
  await page.getByRole('button', { name: 'Найти задачу и проверить дубли' }).click();
  await page.getByRole('link', { name: /^T-08 · Недочеты/ }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Подготовить черновик задачи' }).count(), 0);
  const comment = page.locator('.decision-issues li').filter({ hasText: /^T-08/ })
    .getByRole('button', { name: 'Подготовить комментарий' });
  assert.equal(await comment.count(), 0);
  await page.getByRole('button', { name: 'Создать связанный разбор' }).click();
  await comment.click();
  await page.locator('.tracker-preview').getByText(/Метрики_справочник!/).waitFor();
  const db = app.space('team').db;
  const caseId = (await call('release_decision')).caseId;
  assert.ok(caseId);
  const releaseThread = await call('release-thread', { releaseId: 'R-09' });
  assert.equal((await call('case-thread', { caseId })).id, releaseThread.id);
  const draft = db.prepare('SELECT case_id,state FROM draft_actions').get();
  assert.deepEqual({ ...draft }, { case_id: caseId, state: 'draft' });
  assert.equal(db.prepare('SELECT count(*) n FROM local_issues').get().n, 0);
  await page.getByRole('button', { name: 'Подтвердить запись' }).click();
  await page.getByRole('link', { name: 'Открыть задачу · T-08' }).waitFor();
  assert.equal(db.prepare('SELECT state FROM draft_actions').get().state, 'done');
  assert.equal(db.prepare('SELECT count(*) n FROM local_issues WHERE key=?').get('T-08').n, 1);
  await page.reload();
  await page.getByRole('link', { name: 'Настроить проверку эффекта' }).click();
  assert.equal(new URL(page.url()).hash, '#case/' + caseId + '/effect');
  await page.locator('.effect-panel[open]').waitFor();
  await page.goto(base + '/#release-decision');
  await page.getByLabel('Семейство или раздел').selectOption('Astra Linux Special Edition');
  await page.getByText('89,25', { exact: true }).waitFor();
  await page.getByLabel('Дата среза').fill('2026-05-05');
  await page.getByRole('button', { name: 'Показать на дату' }).click();
  await page.getByText('Исторический срез · 05.05.2026', { exact: true }).waitFor();
  await page.getByText('В архиве нет датированного интервью для этого среза.').waitFor();
  assert.equal(await page.getByRole('combobox', { name: /^Релиз/ }).inputValue(), 'R-01');
  await page.getByRole('button', { name: 'Открыть чат разбора' }).click();
  await page.getByRole('heading', { name: 'Чат разбора · R-01' }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Найти задачу и проверить дубли' }).count(), 0);
  assert.equal(await page.getByRole('link', { name: 'Настроить проверку эффекта' }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
