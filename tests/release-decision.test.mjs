import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { digest, initEvidence } from '../server/evidence.mjs';
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
  assert.equal(astra.product, 'Astra Linux Special Edition');
  assert.equal(astra.release.id, 'R-02');
  assert.equal(astra.trend.baseline.mean, 112);
  assert.equal(astra.trend.current.mean, 89.25);
  assert.equal(astra.competitor.match, 'Частично');
  assert.equal(astra.measurementIssue, false);
  assert.notEqual(astra.caseId, current.caseId);
  const early = await call('release_decision', { caseId: current.caseId, through: '2026-09-20' });
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
});

test('decision chat leads to manual confirmation, using the same case and actual workbook', {
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
  await page.getByRole('link', { name: 'Решение по релизу', exact: true }).click();
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
  await page.getByRole('button', { name: 'Подготовить комментарий' }).click();
  await page.locator('.tracker-preview').getByText(/Метрики_справочник!/).waitFor();
  const db = app.space('team').db;
  const caseId = (await call('release_decision')).caseId;
  const draft = db.prepare('SELECT case_id,state FROM draft_actions').get();
  assert.deepEqual({ ...draft }, { case_id: caseId, state: 'draft' });
  assert.equal(db.prepare('SELECT count(*) n FROM local_issues').get().n, 0);
  await page.getByRole('button', { name: 'Подтвердить запись' }).click();
  await page.getByRole('link', { name: 'Открыть задачу · T-08' }).waitFor();
  assert.equal(db.prepare('SELECT state FROM draft_actions').get().state, 'done');
  assert.equal(db.prepare('SELECT count(*) n FROM local_issues WHERE key=?').get('T-08').n, 1);
  await page.getByRole('link', { name: 'Настроить проверку эффекта' }).click();
  assert.equal(new URL(page.url()).hash, '#case/' + caseId + '/effect');
  await page.locator('.effect-panel[open]').waitFor();
  await page.goto(base + '/#release-decision');
  await page.getByLabel('Семейство').selectOption('Astra Linux Special Edition');
  await page.getByText('89,25', { exact: true }).waitFor();
  await page.getByLabel('Дата среза').fill('2026-05-05');
  await page.getByRole('button', { name: 'Показать на дату' }).click();
  await page.getByText('Исторический срез · 05.05.2026', { exact: true }).waitFor();
  await page.getByText('В архиве нет датированного интервью для этого среза.').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Открыть чат разбора' }).count(), 0);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  assert.deepEqual(errors, []);
});
