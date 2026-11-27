import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTeamApp } from '../server/team-http.mjs';
import { digest, facts, importDocs } from '../server/evidence.mjs';
import { saveMetricRule } from '../server/metric-rules.mjs';
import { addUserMessage, enqueue, initWorkbench, openCaseThread, openReleaseThread, saveReleaseDecisionContext, workJobs } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { readMaterial, saveMaterial } from '../server/materials.mjs';
import { seedWorkspace, fixtureEnv } from './workspace-fixture.mjs';
import { saveClosure } from '../server/redmine-bridge.mjs';

const role = (p, name) => p.getByRole('button', { name, exact: true });
const field = (p, name) => p.getByLabel(name);
const visible = locator => locator.waitFor({ state: 'visible' });
const pinActions = root => root.getByRole('button', {name:/Добавить в разбор|Добавлено ·|Убрать с экрана/});
const submit = (page, operation, click) => Promise.all([
  page.waitForResponse(r => r.url().endsWith('/api/team/' + operation) && r.ok()), click()
]);
const launchBrowser = () => {
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  return chromium.launch({headless:true, executablePath:
    process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined)});
};

test('standalone demo preserves release selection, filters, themes and discussion', async t => {
  const server = spawn(process.execPath,[fileURLToPath(new URL('../prototype/serve.mjs',import.meta.url))],{
    env:{...process.env,PORT:'0'}, stdio:['ignore','pipe','inherit'], windowsHide:true
  });
  const exited = once(server,'exit');
  t.after(async () => { server.kill(); await exited; });
  const url = await Promise.race([
    once(server.stdout,'data').then(([line])=>new URL('#R-002',String(line).trim())),
    exited.then(([code])=>{ throw Error('Standalone demo server exited before listening: '+code); })
  ]);
  const browser = await launchBrowser();
  t.after(() => browser.close());
  const demo = await browser.newPage({locale:'ru-RU', colorScheme:'dark', viewport:{width:390,height:844}});
  demo.setDefaultTimeout(5000);
  let teamApiRequests = 0;
  const failedAssets = [];
  demo.on('request', request => {
    if (/^\/api\/team(?:\/|$)/.test(new URL(request.url()).pathname)) teamApiRequests++;
  });
  demo.on('response',response=>{ if(response.status()>=400)failedAssets.push(response.url()); });
  await demo.goto(url.href);
  const title = demo.locator('[data-slot=title]');
  const date = demo.locator('[data-filter=date]');
  const segment = demo.locator('[data-filter=segment]');
  const discussion = demo.locator('[data-toggle=right]');
  const releases = demo.locator('[data-toggle=left]');
  const fitScreen = () => demo.evaluate(() => document.documentElement.scrollWidth === innerWidth &&
    [...document.querySelectorAll('.dashboard,.sidebar,.thread')].every(panel=>panel.scrollWidth===panel.clientWidth));
  await visible(title);
  await visible(demo.getByText('Демонстрационные данные',{exact:true}));
  assert.equal(await demo.locator('html').getAttribute('data-theme'),'light');
  const releaseTwoTitle = await title.textContent();
  assert.match(await demo.locator('[data-slot=identity]').textContent(), /^R-002/);
  assert.ok(await fitScreen());
  await date.selectOption('7');
  await segment.selectOption('returning');
  await role(demo,'Тёмная тема').press('Space');
  assert.equal(await demo.locator('html').getAttribute('data-theme'),'dark');
  await discussion.press('Space');
  assert.equal(await discussion.getAttribute('aria-expanded'),'true');
  assert.ok(await fitScreen());
  const input = field(demo,'Вопрос агенту');
  const question = 'Что изменилось после релиза?';
  await input.fill(question);
  await input.press('Enter');
  await visible(demo.getByText(question,{exact:true}));
  await visible(role(demo,'Открыть расчёт'));

  await releases.press('Space');
  assert.ok(await fitScreen());
  await demo.locator('.release-link').filter({hasText:'R-001'}).press('Enter');
  await demo.waitForURL('**/#R-001');
  await demo.locator('.release-link[href="#R-001"][aria-current="page"]').waitFor({state:'attached'});
  assert.match(demo.url(), /#R-001$/);
  assert.notEqual(await title.textContent(),releaseTwoTitle);
  assert.equal(await date.inputValue(),'14');
  assert.equal(await segment.inputValue(),'all');
  await demo.goBack();
  assert.equal(demo.url(),url.href);
  await demo.locator('.release-link[href="#R-002"][aria-current="page"]').waitFor({state:'attached'});
  await visible(title);
  assert.equal(await title.textContent(),releaseTwoTitle);
  assert.equal(await date.inputValue(),'7');
  assert.equal(await segment.inputValue(),'returning');
  await discussion.press('Space');
  await visible(demo.getByText(question,{exact:true}));
  await role(demo,'Открыть расчёт').press('Enter');
  assert.equal(await demo.locator('details[open] > summary').first().textContent(),'Показать расчёт');
  await demo.reload();
  assert.equal(demo.url(),url.href);
  assert.equal(await demo.locator('html').getAttribute('data-theme'),'dark');
  assert.equal(await date.inputValue(),'7');
  assert.equal(await segment.inputValue(),'returning');
  assert.ok(await fitScreen());

  const rootUrl = new URL('/',url).href;
  await demo.goto(rootUrl);
  assert.equal(await title.textContent(),releaseTwoTitle);
  await releases.press('Space');
  await demo.getByRole('link',{name:/R-001/}).press('Enter');
  await demo.locator('.release-link[href="#R-001"][aria-current="page"]').waitFor({state:'attached'});
  await date.selectOption('10');
  await segment.selectOption('new');
  await demo.reload();
  assert.match(demo.url(),/#R-001$/);
  await demo.goBack();
  assert.equal(demo.url(),rootUrl);
  await demo.locator('.release-link[href="#R-002"][aria-current="page"]').waitFor({state:'attached'});
  assert.equal(await title.textContent(),releaseTwoTitle);
  assert.equal(await date.inputValue(),'7');
  assert.equal(await segment.inputValue(),'returning');
  await demo.goForward();
  assert.match(demo.url(),/#R-001$/);
  await demo.locator('.release-link[href="#R-001"][aria-current="page"]').waitFor({state:'attached'});
  assert.equal(await date.inputValue(),'10');
  assert.equal(await segment.inputValue(),'new');
  assert.equal(teamApiRequests,0);
  assert.deepEqual(failedAssets,[]);
});

test('archive settings diagnose Reports API and sources show the protected ZIP inventory', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'softline-archive-'));
  const bin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3');
  const runFixture = (input, args = []) => {
    const result = spawnSync(bin, ['tests/research-workbooks.py', ...args], {input:JSON.stringify(input), windowsHide:true});
    assert.equal(result.status, 0, result.stderr?.toString() || String(result.error));
    return result.stdout;
  };
  let app, browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      await app?.close();
      await rm(dir, {recursive:true, force:true, maxRetries:3});
    }
  });
  const sales = value => [['product_family','week_start','orders_index'], ['Контрольная семья','2026-11-02',value]];
  const archive = runFixture([
    {file:'data/orders.xlsx', title:'Продажи', rows:sales(40)},
    {file:'reference/guide.pdf'},
  ]);
  const replay = 'http://127.0.0.1:9876';
  const env = {
    ...fixtureEnv, SOURCE_ARCHIVE_SHA256:digest(archive), PYTHON_BIN:bin,
    DATA_PROFILE:'local', LOCAL_HTTP_ORIGINS:replay, METRIKA_REPLAY_ORIGIN:replay,
    METRIKA_COUNTER_IDS:'405', METRIKA_TOKEN:'fixture-token',
  };
  let probeRequests = 0;
  app = createTeamApp({base:join(dir, 'releases.sqlite'), env, background:false, send:async url => {
    assert.equal(new URL(url).origin, replay);
    if (++probeRequests === 1) return new Response(null, {status:503});
    return Response.json({data:[{dimensions:[{name:'2026-11-02'}], metrics:[100]}], total_rows:1});
  }});
  const register = (login, name, code) => app.accounts.register({login, name, password:'fixture-password', code}, env);
  await register('fixture-admin', 'Администратор архива', fixtureEnv.ADMIN_INVITE_KEY);
  await register('fixture-member', 'Участник архива', app.accounts.invite('team'));
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({headless:true, executablePath:process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined)});
  async function login(person, route) {
    const page = await browser.newPage({locale:'ru-RU'});
    page.setDefaultTimeout(5000);
    await page.goto(base + '/#' + route);
    await field(page, 'Логин').fill('fixture-' + person);
    await field(page, 'Пароль').fill('fixture-password');
    await role(page, 'Войти').click();
    await visible(page.locator('.workspace-page[data-route="' + route + '"]'));
    return page;
  }
  const admin = await login('admin', 'sources');
  const member = await login('member', 'settings');
  assert.equal(await role(member, 'Проверить Reports API').count(), 0);
  const api = (page, op, data = {}) => page.request.post(base + '/api/team/' + op, {data});
  const denied = await api(member, 'metrika-probe');
  assert.match((await denied.json()).error, /администратор/i);
  assert.equal(probeRequests, 0);
  const upload = () => submit(admin, 'upload', () => role(admin, 'Загрузить и пересчитать').click());
  const files = field(admin, 'Книга, презентация или архив');
  assert.equal(await role(admin, 'Синхронизировать Метрику').count(), 0);
  await files.setInputFiles({name:'original.zip',mimeType:'application/zip',buffer:archive});
  await upload();
  const book = admin.locator('.event-row').filter({hasText:'data/orders.xlsx'});
  await visible(book.getByText('Распознано записей: 1', {exact:false}));
  const reference = admin.locator('.event-row').filter({hasText:'reference/guide.pdf'});
  await visible(reference.getByText('Справочный файл', {exact:false}));
  assert.equal(await reference.getByRole('link').count(), 0);
  await book.getByText('История версий').click();
  await visible(book.getByText('Исходный ZIP организатора', {exact:false}));
  const originalLink = await book.locator('details a').getAttribute('href');
  assert.match(await book.locator('details a').textContent(), /\d{2}\.\d{2}\.\d{4}/);
  await upload();
  await visible(admin.getByRole('status').filter({hasText:'Файл уже был загружен'}));

  const revised = runFixture(sales(50), ['--xlsx', 'Продажи']);
  await files.setInputFiles({name:'orders.xlsx', mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer:revised});
  await field(admin, 'Версия книги').selectOption('data/orders.xlsx');
  await field(admin, 'Происхождение материала').fill('Согласованное уточнение');
  await submit(admin, 'approve-source', () => role(admin, 'Согласовать версию').click());
  await upload();
  await visible(book.getByText('Согласованное уточнение · Администратор архива', {exact:false}));
  assert.equal(await book.locator('details a').last().getAttribute('href'), originalLink);

  await admin.goto(base + '/#cases');
  await role(admin, 'Новый разбор').click();
  await field(admin, 'Вопрос или гипотеза').fill('Архивный разбор');
  await field(admin, 'Продукт').selectOption('Контрольная семья');
  const [created] = await submit(admin, 'create-case', () => role(admin, 'Создать личный разбор').click());
  const {id} = await created.json();
  await admin.waitForURL(base + '/#case/' + id);
  const invalid = await api(admin, 'create-case', {title:'Другой продукт', product:'Отсутствующая семья'});
  assert.equal(invalid.status(), 400);
  assert.match((await invalid.json()).error, /семейство/);

  const {db} = app.space('team');
  const legacy = saveMaterial(db, 'group', {kind:'report', title:'Прежний материал', product:'Отсутствующая семья'});
  const casesBefore = db.prepare('SELECT count(*) AS n FROM cases').get().n;
  const deniedPin = await api(admin, 'pin-material', {id:legacy.id, createRequest:'archive-invalid', product:'Контрольная семья'});
  assert.equal(deniedPin.status(), 400);
  assert.match((await deniedPin.json()).error, /семейство/);
  assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, casesBefore);
  assert.equal(db.prepare('SELECT count(*) AS n FROM material_case_requests').get().n, 0);
  const supported = saveMaterial(db, 'group', {kind:'report', title:'Архивный материал', product:'Контрольная семья'});
  const pin = () => api(admin, 'pin-material', {id:supported.id, createRequest:'archive-valid'});
  const accepted = await pin();
  assert.equal(accepted.status(), 200);
  const pinned = await accepted.json();
  assert.equal(pinned.pinned, true);
  assert.deepEqual(await (await pin()).json(), pinned);
  assert.equal(db.prepare('SELECT count(*) AS n FROM cases').get().n, casesBefore + 1);

  const totals = () => [
    db.prepare('SELECT count(*) AS n FROM documents').get().n,
    db.prepare("SELECT count(*) AS n FROM facts WHERE kind='metrics'").get().n,
  ];
  const before = totals();
  await admin.goto(base + '/#settings');
  const check = role(admin, 'Проверить Reports API');
  await check.click();
  const failed = admin.getByRole('status').filter({hasText:'Ошибка Reports API'});
  await visible(failed);
  assert.match(await failed.textContent(), /503/);
  const failedAt = await failed.locator('time').getAttribute('datetime');
  await submit(admin, 'metrika-probe', () => check.click());
  const success = admin.getByRole('status').filter({hasText:'Reports API ответил'});
  await visible(success);
  assert.ok(await success.locator('time').getAttribute('datetime') > failedAt);
  assert.deepEqual(totals(), before);
  assert.equal(probeRequests, 2);
});

test('release decisions preserve the historical cutoff, cited cells and manual issue write', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'release-decision-browser-'));
  await seedWorkspace(dir);
  const app = createTeamApp({ base: join(dir, 'releases.sqlite'), background: false, env: fixtureEnv, send: transport });
  let browser;
  t.after(async () => {
    await browser?.close();
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const store = app.space('team');
  const { user } = await app.accounts.login({ login: 'fixture-admin', password: 'fixture-password' });
  const release = (id, date, description, row, extra = {}) => ({ kind: 'releases', loc: 'Релизы!A' + row,
    row: { release_id: id, release_date: date, description, release_type: 'major', status: 'released', ...extra } });
  const imported = [{ file: 'Решения.xlsx', facts: [
    release('DEC-1', '2026-10-01', 'Изменение Kaspersky', 2),
    release('DEC-2', '2026-11-24', 'Поздний релиз Kaspersky', 3),
    release('DEC-3', '2026-10-02', 'Изменение Astra', 4, { related_task_ids: 'DEC-ASTRA' }),
    release('R-50', '2026-10-04', 'Карусель рекомендаций ЛК', 5, { affected_metrics: 'lk_reco_click_visits', related_task_ids: 'T-9' }),
    release('MIX-1', '2026-10-03', 'Изменения для Astra и Kaspersky', 6),
    release('OLD-1', '2026-10-01', 'Обновление Astra', 7),
    { kind: 'interview', loc: 'Интервью!L9', text: 'Темы ответа: Kaspersky · сложность выбора\nФрагмент записи: Неясно, какую лицензию выбрать' },
    { kind: 'backlog', loc: 'Задачи!A8', row: { task_id: 'DEC-T', title: 'Kaspersky: проверить сбор событий',
      created_date: '2026-09-20', status: 'New', description_short: 'Проверить передачу событий', linked_metric_ids: 'cfg_add_to_cart_rate' } },
    { kind: 'backlog', loc: 'Задачи!A9', row: { task_id: 'DEC-ASTRA', title: 'Уточнить состав поставки',
      created_date: '2026-09-20', status: 'Closed' } },
    { kind: 'backlog', loc: 'Задачи!A10', row: { task_id: 'T-9', title: 'Обновить показ блока',
      created_date: '2026-09-20', status: 'Closed' } },
    { kind: 'dictionary', loc: 'Метрики!A4', row: { metric_id: 'cfg_add_to_cart_rate', metric_name: 'Конверсия в корзину',
      comment: 'Проверить полноту исходных событий', formula_or_logic: 'Корзины / посещения' } },
  ] }];
  for (let day = 0; day < 29; day++) {
    if (day === 14) continue; // The deployment day is excluded from both windows.
    imported[0].facts.push({ kind: 'metrics', loc: 'Клики!A' + (day + 2), row: {
      product: 'ЛК', metric_id: 'lk_reco_click_visits', segment: 'all', unit: 'visits',
      date: new Date(Date.UTC(2026, 8, 20 + day)).toISOString().slice(0, 10), value: day < 14 ? 1 : 2,
    } });
  }
  importDocs(store, imported, { notify: false });
  const legacy = digest(user.id + '/release/OLD-1');
  const legacyMixed = digest(user.id + '/release/MIX-1');
  store.db.exec('DROP TABLE release_threads; CREATE TABLE release_threads(thread TEXT PRIMARY KEY, release_id TEXT NOT NULL)');
  for (const [id, releaseId] of [[legacy, 'OLD-1'], [legacyMixed, 'MIX-1']]) {
    store.db.prepare("INSERT INTO conversations VALUES(?,?,'private',?)").run(id, user.id, 'Переименованный чат');
    store.db.prepare('INSERT INTO release_threads VALUES(?,?)').run(id, releaseId);
    addUserMessage(store.db, user, id, { text: 'Сообщение исходного чата ' + releaseId });
  }
  initWorkbench(store.db);
  const call = (op, body) => workspaceOperation(store, user, op, body, fixtureEnv, transport);
  const linked = call('create-case', { title: 'Связанный разбор Kaspersky', product: 'Kaspersky', release: 'DEC-2' });
  const unrelated = call('create-case', { title: 'Обычный разбор Astra', product: 'Astra' });
  const astraMixed = call('create-case', { title: 'Разбор Astra', product: 'Astra', release: 'MIX-1' });
  const kasperskyMixed = call('create-case', { title: 'Разбор Kaspersky', product: 'Kaspersky', release: 'MIX-1' });
  const astraScope = call('release_decision', { releaseId: 'MIX-1', product: 'Astra' });
  const kasperskyScope = call('release_decision', { releaseId: 'MIX-1', product: 'Kaspersky' });
  const astraMixedChat = openReleaseThread(store, user, astraScope);
  assert.notEqual(astraMixedChat, legacyMixed);
  addUserMessage(store.db, user, astraMixedChat, { text: 'Частные выводы Astra' });
  const kasperskyMixedChat = openReleaseThread(store, user, kasperskyScope);
  assert.notEqual(kasperskyMixedChat, astraMixedChat);
  assert.notEqual(kasperskyMixedChat, legacyMixed);
  assert.equal(openCaseThread(store.db, user, astraMixed.id), astraMixedChat);
  assert.equal(openCaseThread(store.db, user, kasperskyMixed.id), kasperskyMixedChat);
  addUserMessage(store.db, user, kasperskyMixedChat, { text: 'Частные выводы Kaspersky' });
  const kasperskyContext = saveReleaseDecisionContext(store.db, user, kasperskyScope);
  assert.throws(() => enqueue(store, user, { thread: astraMixedChat, question: 'Каков эффект?', decisionContext: kasperskyContext }),
    /другой переписке/);
  assert.equal(openReleaseThread(store, user, call('release_decision', { releaseId: 'OLD-1' })), legacy);
  assert.equal(store.db.prepare('SELECT product FROM release_threads WHERE thread=?').get(legacy).product, 'Astra');
  assert.throws(() => call('release-tracker-draft', { caseId: linked.id, releaseId: 'DEC-1' }), /другому релизу/);
  assert.equal(call('release_decision', { releaseId: 'DEC-1' }).caseId, null);
  assert.equal(call('release_decision', { releaseId: 'DEC-2' }).asOf, '2026-11-24');
  assert.throws(() => call('release_decision', { releaseId: 'DEC-2', through: '2026-11-23' }), /нет такого релиза/);
  const account = call('release_decision', { releaseId: 'R-50' });
  assert.equal(account.accountEvidence.sources.filter(row => row.loc.startsWith('Клики!')).length, 28);
  const caseCount = () => store.db.prepare('SELECT count(*) AS n FROM cases').get().n;
  const countBeforeSearch = caseCount();
  const astra = await call('release-tracker', { releaseId: 'DEC-3' });
  assert.equal(astra.caseId, null);
  assert.ok(astra.items.some(item => item.key === 'DEC-ASTRA' && item.exact));
  assert.equal(caseCount(), countBeforeSearch);
  const releaseChat = openReleaseThread(store, user, call('release_decision', { releaseId: 'DEC-3' }));
  addUserMessage(store.db, user, releaseChat, { text: 'История до создания связанного разбора' });
  const association = call('release-tracker-case', { releaseId: 'DEC-3' });
  assert.deepEqual(call('release-tracker-case', { releaseId: 'DEC-3' }), association);
  assert.equal(openCaseThread(store.db, user, association.caseId), releaseChat);
  assert.equal(openReleaseThread(store, user, call('release_decision', { releaseId: 'DEC-3' })), releaseChat);
  const unrelatedChat = openCaseThread(store.db, user, unrelated.id);
  assert.notEqual(unrelatedChat, releaseChat);
  const accountContext = saveReleaseDecisionContext(store.db, user, account);
  assert.throws(() => enqueue(store, user, { thread: unrelatedChat, question: 'Каков эффект?', decisionContext: accountContext }),
    /другой переписке/);
  await assert.rejects(call('release-tracker-draft', { ...association, releaseId: 'DEC-3' }), /Найдена подходящая задача/);
  const astraDraft = await call('release-tracker-draft', { ...association, releaseId: 'DEC-3', key: 'DEC-ASTRA' });
  assert.equal(astraDraft.caseId, association.caseId);
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM local_issues').get().n, 0);
  await new Promise((ok, fail) => app.server.once('error', fail).listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ executablePath: process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined) });
  const page = await browser.newPage({ locale: 'ru-RU', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(20000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/#overview');
  await field(page, 'Логин').fill('fixture-admin');
  await field(page, 'Пароль').fill('fixture-password');
  await field(page, 'Пароль').press('Enter');
  await page.getByRole('link', { name: 'Решение по релизу', exact: true }).click();
  await visible(page.getByRole('heading', { name: 'Решение по релизу' }));
  await field(page, 'Семейство или раздел').selectOption('Kaspersky');
  await visible(page.getByText('«Неясно, какую лицензию выбрать»'));
  await page.getByRole('link', { name: /Интервью!L9/ }).click();
  await visible(page.getByText('Интервью!L9', { exact: true }));
  await page.goBack();
  await field(page, 'Семейство или раздел').selectOption('Kaspersky');
  await field(page, 'Дата среза').fill('2026-11-08');
  await role(page, 'Показать на дату').click();
  await visible(page.getByText('Исторический срез · 08.11.2026', { exact: true }));
  assert.equal(await field(page, 'Релиз').locator('option[value="DEC-2"]').count(), 0);
  assert.equal(await page.getByText('«Неясно, какую лицензию выбрать»').count(), 0);
  await page.getByText('16 недель и исходные строки').click();
  await page.getByRole('link', { name: /Kaspersky!A20/ }).click();
  await visible(page.getByText('Kaspersky!A20', { exact: true }));
  await page.goBack();
  await visible(page.getByText('Исторический срез · 08.11.2026', { exact: true }));
  await field(page, 'Семейство или раздел').selectOption('Astra');
  await visible(page.getByRole('heading', { name: 'Astra', exact: true }));
  await field(page, 'Релиз').selectOption('DEC-3');
  await visible(page.locator('.decision-hero').getByText('DEC-3 · 02.10.2026', { exact: true }));
  assert.equal(await field(page, 'Релиз').inputValue(), 'DEC-3');
  await role(page, 'Открыть чат разбора').click();
  await visible(page.getByText('История до создания связанного разбора', { exact: true }));

  await field(page, 'Релиз').selectOption('MIX-1');
  await role(page, 'Открыть чат разбора').click();
  await visible(page.getByText('Частные выводы Astra', { exact: true }));
  assert.equal(await page.getByText('Частные выводы Kaspersky', { exact: true }).count(), 0);
  await field(page, 'Семейство или раздел').selectOption('Kaspersky');
  await field(page, 'Релиз').selectOption('MIX-1');
  await role(page, 'Открыть чат разбора').click();
  await visible(page.getByText('Частные выводы Kaspersky', { exact: true }));
  assert.equal(await page.getByText('Частные выводы Astra', { exact: true }).count(), 0);

  await page.goto(base + '/#release-detail/DEC-2');
  await page.getByRole('link', { name: 'Решение по релизу', exact: true }).click();
  assert.equal(new URL(page.url()).hash, '#release-decision/DEC-2');
  await role(page, 'Открыть чат разбора').click();
  await visible(page.getByRole('heading', { name: 'Чат разбора · DEC-2' }));
  await role(page, 'Найти задачу и проверить дубли').click();
  await visible(page.getByRole('link', { name: /^DEC-T ·/ }));
  assert.equal(await role(page, 'Подготовить черновик задачи').count(), 0);
  await role(page, 'Подготовить комментарий').click();
  await visible(page.locator('.tracker-preview').getByText(/Метрики!A4/));
  assert.equal(store.db.prepare('SELECT count(*) AS n FROM local_issues').get().n, 0);
  assert.equal(store.db.prepare('SELECT state FROM draft_actions WHERE case_id=?').get(linked.id).state, 'draft');
  await role(page, 'Подтвердить запись').click();
  await visible(page.getByRole('link', { name: 'Открыть задачу · DEC-T' }));
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM local_issues WHERE key='DEC-T'").get().n, 1);

  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(base + '/#release-decision/R-50');
  await visible(page.getByRole('heading', { name: 'Личный кабинет', exact: true }));
  await visible(page.getByRole('heading', { name: 'Переходы из рекомендаций' }));
  await visible(page.getByText(/визиты с кликом 14 → 28/));
  await page.getByText('Источники расчёта').click();
  await page.getByRole('link', { name: /Клики!A2$/ }).click();
  await visible(page.getByText('Клики!A2', { exact: true }));
  await page.goBack();
  await role(page, 'Открыть чат разбора').click();
  await visible(page.getByRole('heading', { name: 'Чат разбора · R-50' }));
  const thread = store.db.prepare("SELECT id FROM conversations WHERE title='ЛК · R-50'").get().id;
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await role(page, 'Найти задачу и проверить дубли').click();
  await visible(page.getByRole('link', { name: /^T-9 ·/ }));
  assert.equal(caseCount(), countBeforeSearch + 1);
  assert.equal(await role(page, 'Подготовить черновик задачи').count(), 0);
  await role(page, 'Создать связанный разбор').click();
  await role(page, 'Подготовить комментарий').click();
  await visible(page.locator('.tracker-preview').getByText(/Клики!A2/));
  const accountCase = JSON.parse(store.db.prepare("SELECT body FROM cases WHERE product='ЛК'").get().body);
  assert.equal(accountCase.release, 'R-50');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM local_issues WHERE key='T-9'").get().n, 0);
  await role(page, 'Подтвердить запись').click();
  await visible(page.getByRole('link', { name: 'Открыть задачу · T-9' }));
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM local_issues WHERE key='T-9'").get().n, 1);
  const question = 'Что известно про карусель рекомендаций ЛК после выкладки?';
  await page.locator('textarea').fill(question);
  await submit(page, 'ask', () => role(page, 'Отправить').click());
  assert.equal(JSON.parse(store.db.prepare('SELECT body FROM jobs WHERE thread=?').get(thread).body).decisionReleaseId, 'R-50');
  await workJobs(store, app.accounts, fixtureEnv, transport);
  const conversation = page.getByRole('region', { name: 'Переписка' });
  await visible(conversation.getByText(/14 → 28/));
  await conversation.getByRole('link', { name: /Клики!A2$/ }).click();
  await visible(page.getByText('Клики!A2', { exact: true }));
  await page.goto(base + '/#overview');
  await page.goto(base + '/#release-decision/R-50');
  await role(page, 'Открыть чат разбора').click();
  await visible(page.getByText(question, { exact: true }));
  assert.deepEqual(store.db.prepare("SELECT id FROM conversations WHERE title='ЛК · R-50'").all().map(r => r.id), [thread]);
  await field(page, 'Дата среза').fill('2026-10-10');
  await role(page, 'Показать на дату').click();
  await visible(page.getByText('Исторический срез · 10.10.2026', { exact: true }));
  await role(page, 'Открыть чат разбора').click();
  await page.locator('textarea').fill(question);
  await submit(page, 'ask', () => role(page, 'Отправить').click());
  const scopedJob = JSON.parse(store.db.prepare('SELECT body FROM jobs WHERE thread=? ORDER BY rowid DESC LIMIT 1').get(thread).body);
  assert.equal(scopedJob.decisionThrough, '2026-10-10');
  assert.equal(scopedJob.releaseDecisionSnapshot.through, '2026-10-10');
  await workJobs(store, app.accounts, fixtureEnv, transport);
  await visible(conversation.getByText(/14\/14 и 6\/14/));
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM local_issues WHERE key='DEC-ASTRA'").get().n, 0);
  assert.equal((await call('confirm', { id: astraDraft.id })).key, 'DEC-ASTRA');
  assert.equal(store.db.prepare("SELECT count(*) AS n FROM local_issues WHERE key='DEC-ASTRA'").get().n, 1);
  assert.deepEqual(errors, []);
});

// Model and remote Redmine responses are simulated. Jobs and local tracking use SQLite.
function transport(url, options) {
  const target = new URL(url);
  if (target.hostname === 'settings-redmine.test') {
    assert.equal(options.headers['X-Redmine-API-Key'], 'fixture-personal-redmine');
    if (target.pathname === '/users/current.json') return Response.json({ user: { id: 1 } });
    assert.equal(target.pathname, '/projects/settings.json');
    return Response.json({ project: { id: 1 } });
  }
  assert.equal(String(url), 'http://localhost/v1/chat/completions');
  const req = JSON.parse(options.body);
  const respond = message => Response.json({choices: [{message}]});
  const tool = (name, args) => respond({tool_calls: [{id: 'fixture', type: 'function', function: {
    name, arguments: JSON.stringify(args)
  }}]});
  const inquiry = req.messages.findLast(message => message.role === 'user')?.content || '';
  if (inquiry.includes('Redmine #731')) {
    const last = req.messages.at(-1);
    if (last.role !== 'tool') return inquiry.includes('комментарий при закрытии')
      ? tool('issue_read', { key: '731' }) : tool('page_read', { issueKey: '731' });
    const value = JSON.parse(last.content);
    if (value.error) return respond({ content: value.error });
    if (value.closingNote) return tool('page_read', { issueKey: '731' });
    return respond({ content: 'Страница прочитана. Показатели взяты из исходного отчёта Метрики.' });
  }
  if (req.tools?.some(t => t.function.name === 'selection_context') && req.messages.at(-1).role !== 'tool')
    return tool('search', {query:'Kaspersky', kinds:['interview']});
  if (req.tools?.[0]?.function.name === 'record_findings')
    return tool('record_findings', {summary:'Проверка релиза.', highlights:[], intervals:[]});
  if (req.tools?.some(t => t.function.name === 'build_chart') && req.messages.at(-1).role !== 'tool')
    return tool('build_chart', {spec: {title:'Время до оплаты', field:'duration', stat:'median', start:'invoice', end:'payment'}});
  return respond({content:'Расчёт проверен по сохранённым данным.'});
}

test('Softline workspace, upgrade and browser journeys', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'softline-workspace-'));
  let app, browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      await app?.close();
      await rm(dir, {recursive:true, force:true, maxRetries:3});
    }
  });
  const original = process.env.PM_UI_BASELINE;
  let fixture;
  if (original) {
    fixture = JSON.parse(await readFile(join(original, 'baseline.json'), 'utf8'));
    for (const name of ['releases.sqlite','accounts.sqlite','workspaces'])
      await cp(join(original, name), join(dir, name), {recursive:true});
  } else fixture = await seedWorkspace(dir);
  const mail = [];
  const env = {...fixtureEnv, INTEGRATION_KEY:Buffer.alloc(32, 1).toString('base64url'),
    SMTP_HOST:'mail.invalid', SMTP_FROM:'sender@example.invalid',
    TELEGRAM_BOT_TOKEN:'fixture', TELEGRAM_BOT_USERNAME:'signal_fixture_bot',
    TELEGRAM_WEBHOOK_SECRET:'workspace-fixture-secret',
    LLM_BACKEND:'api', LLM_DATA_MODE:'analysis', PYTHON_BIN:process.env.PYTHON_BIN,
    LLM_BASE_URL:'http://localhost/v1', LLM_MODEL:'fixture'};
  const task = { key: 'Redmine #731', url: 'https://redmine.test/issues/731', title: 'Закрытие с результатом 731',
    description: 'Проверить отчёт', status: 'Закрыта', comments: [] };
  let bridgeReference = '';
  function send(url, options) {
    const target = new URL(url);
    if (target.port !== '8731') return transport(url, options);
    const data = options?.body && JSON.parse(options.body);
    if (target.pathname === '/tasks') {
      bridgeReference = data.reference;
      return Response.json({ reference: data.reference, report_id: data.report_id, redmine_id: 731, url: task.url });
    }
    if (target.pathname === '/issue-options') return Response.json({ priorities: [], trackers: [], assignees: [] });
    if (target.pathname === '/tasks/' + bridgeReference + '/details') return Response.json(task);
    if (target.pathname === '/tasks/' + bridgeReference + '/changes') {
      task.comments.push({ author: 'Автор', text: data.changes.comment + '\n' + data.marker });
      return Response.json({ key: task.key, url: task.url });
    }
    throw Error('Неожиданный запрос к Signal Bridge ' + target.pathname);
  }
  const start = () => createTeamApp({
    base:join(dir,'releases.sqlite'), background:false, env, send,
    sendMail:async (text, _env, to) => mail.push({ text, to }),
  });
  for (let n = 0; n < 2; n++) {
    const app = start();
    try {
      const store = app.space('team');
      const user = (await app.accounts.login({login:'fixture-admin',password:'fixture-password'})).user;
      assert.deepEqual(workspaceOperation(store,user,'calc',{id:fixture.calc}).summary, fixture.summary);
      assert.deepEqual(workspaceOperation(store,user,'range_read',{id:fixture.range}).periods, fixture.periods);
      assert.equal(readMaterial(store.db,user,fixture.report).children[0].id, fixture.chart);
      assert.match(store.db.prepare("SELECT sql FROM sqlite_schema WHERE name='chat_items'").get().sql,/AUTOINCREMENT/);
      assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    } finally { await app.close(); }
  }
  app = start();
  await new Promise((ok, fail) => app.server.once('error',fail).listen(0,'127.0.0.1',ok));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  assert.equal((await (await fetch(base+'/health')).json()).ok,true);
  browser = await launchBrowser();
  const errors = [];
  async function login(user, route, options={}) {
    const ctx = await browser.newContext({locale:'ru-RU', viewport:{width:1440,height:900},...options});
    const p = await ctx.newPage();
    p.setDefaultTimeout(10000);
    p.on('pageerror', err => errors.push(err.message));
    await p.goto(base + '/' + route);
    await field(p,'Логин').fill('fixture-'+user);
    await field(p,'Пароль').fill('fixture-password');
    await role(p,'Войти').click();
    await visible(p.getByRole('link',{name:'Профиль',exact:true}));
    return p;
  }
  const admin = await login('admin','#material/'+fixture.report);
  const member = await login('member','#material/'+fixture.report, {
    viewport:{width:390,height:844}, reducedMotion:'reduce',colorScheme:'dark'
  });
  const judge = await login('judge','#overview');
  const go = async (p, hash) => {
    await p.goto(base+'/#'+hash);
    await p.locator('.workspace-page[data-route="'+hash.split('/')[0]+'"]').waitFor();
  };
  const caseRoute = 'case/'+fixture.caseId;
  async function sendMaterialToCase(page, href) {
    await field(page,'Вопрос агенту').fill(base+'/'+href);
    await visible(page.locator('.chat-composer .range-attachment'));
    const [response] = await submit(page,'ask',()=>role(page,'Отправить').click());
    await workJobs(app.space('team'),app.accounts,env,transport);
    const card = page.locator('.bubble.user .material-card').filter({has:page.locator('a[href="'+href+'"]')}).last();
    await visible(card);
    return {card, thread:response.request().postDataJSON().thread};
  }
  const journey = (name, run) => t.test(name, async () => {
    try { await run(); }
    catch (error) {
      const alerts = await admin.getByRole('alert').allTextContents();
      console.error(name, admin.url(), alerts, error.message);
      throw error;
    }
  });

  await journey('an invitation opens registration in an existing signed-out tab and updates its code', async () => {
    const guest = await browser.newPage();
    guest.setDefaultTimeout(4000);
    guest.on('pageerror', err => errors.push(err.message));
    try {
      await guest.goto(base);
      await visible(guest.getByRole('heading', {name:'Вход', exact:true}));
      const codeA = app.accounts.invite('team');
      const codeB = app.accounts.invite('team');
      const codeInput = field(guest,'Код приглашения');
      await guest.goto(base + '/#join/' + codeA);
      await visible(guest.getByRole('heading', {name:'Создать аккаунт', exact:true}));
      assert.equal(await codeInput.inputValue(), codeA);
      await field(guest,'Имя').fill('Первое приглашение');
      await guest.goto(base + '/#join/' + codeB);
      await guest.waitForFunction(code => document.querySelector('input[name="code"]')?.value === code, codeB);
      assert.equal(await codeInput.inputValue(), codeB);
      assert.equal(await field(guest,'Имя').inputValue(), '');

      await field(guest,'Имя').fill('Участник по приглашению');
      await field(guest,'Логин').fill('invited-user');
      await field(guest,'Пароль').fill('fixture-password');
      await submit(guest,'register',()=>role(guest,'Создать аккаунт').click());
      await guest.waitForURL(base + '/#overview');
      await guest.getByRole('link',{name:'Профиль',exact:true}).click();
      const account = guest.getByRole('region',{name:'Учётная запись'});
      await visible(account.getByRole('heading',{name:'Участник по приглашению',exact:true}));
      await visible(account.getByText('Участник',{exact:true}));
    } finally { await guest.close(); }
  });

  await journey('a new case started from the case list does not inherit a previous release', async () => {
    try {
      await admin.getByRole('navigation').getByRole('link',{name:'Разборы',exact:true}).click();
      await admin.getByRole('link',{name:'Журнал релизов →',exact:true}).click();
      await admin.getByRole('link',{name:/DEMO-R/}).click();
      await role(admin,'Запланировать оценку').click();
      const releaseSelect = field(admin,'Связанный релиз');
      assert.equal(await releaseSelect.inputValue(), 'DEMO-R');
      await field(admin,'Вопрос или гипотеза').fill('Оценить новый релиз');
      await field(admin,'Продукт').fill('Kaspersky');
      await submit(admin,'create-case',()=>role(admin,'Создать личный разбор').click());
      await visible(admin.getByRole('heading',{name:'Оценить новый релиз',exact:true}));
      await admin.getByRole('link',{name:'← Разборы',exact:true}).click();
      await role(admin,'Новый разбор').click();
      assert.equal(await releaseSelect.inputValue(), '', 'У самостоятельного разбора релиз изначально не выбран');
      await role(admin,'Новый разбор').click();
      await releaseSelect.waitFor({state:'hidden'});
    } finally { await go(admin,'material/'+fixture.report); }
  });

  await journey('a judge can register from a direct invitation and see the role in their profile', async () => {
    const guest = await browser.newPage();
    guest.on('pageerror', err => errors.push(err.message));
    try {
      await guest.goto(base + '/#join/' + env.DEMO_INVITE_KEY);
      await field(guest,'Имя').fill('Член жюри по приглашению');
      await field(guest,'Логин').fill('invited-judge');
      await field(guest,'Пароль').fill('fixture-password');
      await submit(guest,'register',()=>role(guest,'Создать аккаунт').click());
      await guest.waitForURL(base + '/#overview');
      await guest.getByRole('link',{name:'Профиль',exact:true}).click();
      const account = guest.getByRole('region',{name:'Учётная запись'});
      await visible(account.getByRole('heading',{name:'Член жюри по приглашению',exact:true}));
      await visible(account.getByText('Демо · жюри',{exact:true}));
    } finally { await guest.close(); }
  });

  await journey('verified notification contacts are personal and independently removable', async () => {
    await go(member, 'settings/personal');
    const contacts = member.getByRole('region', {name:'Мои уведомления'});
    const address = 'fixture-member@example.invalid';
    await field(contacts, 'Адрес почты').fill(address);
    await submit(member, 'email-request', () => role(contacts, 'Получить код').click());
    const sent = mail.at(-1);
    assert.equal(sent.to, address);
    await field(contacts, 'Код из письма на ' + address).fill(sent.text.match(/\b\d{8}\b/)[0]);
    await submit(member, 'email-confirm', () => role(contacts, 'Подтвердить почту').click());
    await visible(contacts.getByText(address, {exact:true}));

    await submit(member, 'bind', () => role(contacts, 'Привязать Telegram').click());
    const link = new URL(await contacts.getByRole('link', {name:'Открыть бота в Telegram'}).getAttribute('href'));
    assert.equal(link.origin, 'https://t.me');
    const response = await member.request.post(base + '/api/telegram', {
      headers:{'x-telegram-bot-api-secret-token':env.TELEGRAM_WEBHOOK_SECRET},
      data:{update_id:801, message:{chat:{id:801,type:'private'},from:{id:801},text:'/start ' + link.searchParams.get('start')}},
    });
    assert.equal(response.status(), 200);
    await member.evaluate(() => window.dispatchEvent(new Event('focus')));
    await visible(contacts.getByText('Личный чат подключён'));
    await submit(member, 'contact-unlink', () => role(contacts, 'Отвязать почту').click());
    await visible(contacts.getByText('Личный чат подключён'));
    assert.equal(await contacts.getByText(address, {exact:true}).count(), 0);

    await go(admin, 'settings/personal');
    const adminContacts = admin.getByRole('region', {name:'Мои уведомления'});
    await visible(role(adminContacts, 'Привязать Telegram'));
    assert.equal(await adminContacts.getByText(address, {exact:true}).count(), 0);
    await go(judge, 'settings/personal');
    assert.equal(await judge.getByRole('region', {name:'Мои уведомления'}).count(), 0);
    await submit(member, 'contact-unlink', () => role(contacts, 'Отвязать Telegram').click());
    await visible(role(contacts, 'Привязать Telegram'));
  });

  await journey('settings sit above the profile and the account page keeps sign-out', async () => {
    for (const [page, name, accountRole] of [
      [admin,'fixture-admin','Администратор'], [member,'fixture-member','Участник'], [judge,'fixture-judge','Демо · жюри'],
    ]) {
      const sidebar = page.locator('#workspace-sidebar');
      assert.equal(await sidebar.getByRole('link',{name:'Настройки',exact:true}).count(),0);
      assert.equal(await role(sidebar,'Выйти').count(),0);
      const accountLinks = sidebar.locator('.side-bottom a');
      assert.deepEqual(await accountLinks.evaluateAll(links => links.map(link => link.getAttribute('aria-label'))),
        ['Мои настройки','Настройки команды','Профиль']);
      const profile = sidebar.getByRole('link',{name:'Профиль',exact:true});
      await profile.click();
      await visible(page.getByRole('heading',{name:'Профиль',exact:true}));
      assert.equal(await profile.getAttribute('aria-current'),'page');
      const account = page.getByRole('region',{name:'Учётная запись'});
      await visible(account.getByRole('heading',{name,exact:true}));
      await visible(account.getByText(accountRole,{exact:true}));
      await visible(role(page,'Выйти'));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    const sidebar = admin.locator('#workspace-sidebar');
    const personal = sidebar.getByRole('link',{name:'Мои настройки'});
    const team = sidebar.getByRole('link',{name:'Настройки команды'});
    assert.equal(await admin.locator('main').getByRole('link',{name:'Мои настройки'}).count(),0);
    await personal.click();
    await visible(admin.getByRole('heading',{name:'Мои настройки',exact:true}));
    await visible(admin.getByRole('heading',{name:'Оформление'}));
    assert.equal(await personal.getAttribute('aria-current'),'page');
    assert.equal(await admin.locator('main').getByRole('link',{name:'Настройки команды'}).count(),0);
    await admin.getByRole('link',{name:'Вернуться в профиль'}).click();
    await team.click();
    await visible(admin.getByRole('heading',{name:'Настройки команды',exact:true}));
    await visible(admin.getByRole('heading',{name:'Подключения команды'}));
    assert.equal(await role(admin,'Проверить Reports API').count(),0);
    await go(admin,'sources');
    await visible(role(admin,'Синхронизировать Метрику'));
    await visible(field(admin,'Книга, презентация или архив'));
    await go(admin,'cases');
    await role(admin,'Новый разбор').click();
    await field(admin,'Продукт').fill('Семейство, введённое вручную');
    assert.equal(await field(admin,'Продукт').inputValue(),'Семейство, введённое вручную');
    await role(admin,'Новый разбор').click();
    await go(admin,'material/'+fixture.report);
    await go(member,'material/'+fixture.report);
    await go(judge,'overview');
  });

  await journey('a member can save their name and photo, then restore initials', async () => {
    const threadResponse = await member.request.post(base+'/api/team/thread',{data:{title:'Проверка аватара'}});
    assert.ok(threadResponse.ok());
    const { id: avatarThread } = await threadResponse.json();
    const avatarMessage = 'Сообщение из старой переписки';
    app.space('team').db.prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES(?,?,'user',?,?)")
      .run(avatarThread,'fixture-member',JSON.stringify({text:avatarMessage}),Date.now());
    const posted = await member.request.post(base+'/api/team/say',{data:{thread:'group',question:'Проверка аватара в команде'}});
    assert.ok(posted.ok());
    await go(member,'profile');
    const account = member.getByRole('region',{name:'Учётная запись'});
    const sidebarAvatar = member.getByRole('link',{name:'Профиль',exact:true}).locator('.profile-avatar');
    await role(member,'Редактировать профиль').click();
    await field(member,'Имя').fill('Мария Орлова');
    const png = await member.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 8;
      const context = canvas.getContext('2d');
      context.fillStyle = '#ad1239';
      context.fillRect(0,0,8,8);
      return canvas.toDataURL().split(',')[1];
    });
    await member.getByLabel('Фото профиля',{exact:true}).setInputFiles({
      name:'portrait.png', mimeType:'image/png', buffer:Buffer.from(png,'base64'),
    });
    await visible(account.locator('.profile-avatar img'));
    assert.equal(await sidebarAvatar.locator('img').count(),0);
    await role(member,'Сохранить профиль').click();
    await visible(sidebarAvatar.locator('img'));
    await member.reload();
    await visible(account.getByRole('heading',{name:'Мария Орлова'}));
    await visible(account.getByText('fixture-member',{exact:true}));
    assert.equal(await sidebarAvatar.locator('img').evaluate(async image => {
      await image.decode();
      return image.naturalWidth;
    }),192);
    const photo = await sidebarAvatar.locator('img').getAttribute('src');
    await go(member,'chats/'+avatarThread);
    const ownBubble = member.locator('.bubble.user').filter({hasText:avatarMessage});
    const ownAvatar = ownBubble.locator('.message-author .chat-avatar img');
    await visible(ownAvatar);
    assert.equal(await ownAvatar.getAttribute('src'),photo);
    await go(member,'chats/group');
    const groupAvatar = member.locator('.bubble.user').filter({hasText:'Проверка аватара в команде'})
      .locator('.message-author .chat-avatar img');
    await visible(groupAvatar);
    assert.equal(await groupAvatar.getAttribute('src'),photo);
    assert.ok(await member.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await go(member,'profile');
    await role(member,'Редактировать профиль').click();
    await role(member,'Убрать фото').click();
    await field(member,'Имя').fill('fixture-member');
    await role(member,'Сохранить профиль').click();
    await visible(account.getByRole('heading',{name:'fixture-member'}));
    assert.equal(await sidebarAvatar.textContent(),'FM');
    await go(member,'chats/'+avatarThread);
    await visible(ownBubble);
    assert.equal(await ownAvatar.count(),0);
    await go(member,'material/'+fixture.report);
  });

  await journey('chat panels fit the workspace and preserve the current conversation', async () => {
    await admin.setViewportSize({width:1280,height:900});
    try {
      await go(admin,'chats/'+fixture.thread);
      const rows = admin.getByRole('navigation',{name:'Переписки'});
      const row = rows.locator('.thread-row').filter({has:admin.locator('[aria-current="page"]')});
      const title = row.locator('.thread-title');
      assert.equal(await title.evaluate(el => getComputedStyle(el).textOverflow),'ellipsis');
      const menu = row.locator('.thread-menu-trigger');
      assert.equal(await menu.evaluate(el => getComputedStyle(el).pointerEvents),'none');
      await row.hover();
      await menu.click();
      await visible(admin.getByRole('menuitem',{name:'Переименовать'}));
      await admin.keyboard.press('Escape');
      await menu.press('ArrowDown');
      await visible(admin.getByRole('menuitem',{name:'Переименовать'}));
      await admin.keyboard.press('Escape');

      const draft = field(admin,'Вопрос агенту');
      await draft.fill('Черновик для проверки панели');
      const width = admin.getByRole('separator',{name:'Ширина списка чатов'});
      await admin.mouse.move(10,10);
      await width.press('Home');
      assert.ok(await title.evaluate(el => el.scrollWidth > el.clientWidth && getComputedStyle(el).whiteSpace === 'nowrap'));
      assert.equal(await title.getAttribute('title'),await title.textContent());
      const before = Number(await width.getAttribute('aria-valuenow'));
      const edge = await width.boundingBox();
      const panel = await admin.locator('.threads-panel').boundingBox();
      assert.ok(Math.abs(edge.x + edge.width / 2 - panel.x - panel.width) <= 2);
      assert.ok(await width.evaluate(el => getComputedStyle(el,'::before').content === 'none'));
      await admin.mouse.move(edge.x + edge.width / 2, edge.y + edge.height / 2);
      await admin.mouse.down();
      await admin.mouse.move(edge.x + edge.width / 2 + 32, edge.y + edge.height / 2, {steps:4});
      await admin.mouse.up();
      const resized = Number(await width.getAttribute('aria-valuenow'));
      assert.ok(resized > before);
      await width.press('Home');
      const chatBounds = await admin.locator('.standalone-chat').boundingBox();
      await row.hover();
      await row.locator('.thread-title').evaluate(el => el.getBoundingClientRect());
      const expanded = await row.boundingBox();
      assert.ok(expanded.x + expanded.width > chatBounds.x);
      assert.equal(await title.evaluate(el => getComputedStyle(el).whiteSpace),'nowrap');
      assert.equal(await title.evaluate(el => getComputedStyle(el).overflowX),'clip');
      assert.equal(await title.evaluate(el => getComputedStyle(el).color),await menu.evaluate(el => getComputedStyle(el).color));
      assert.deepEqual(await admin.locator('.standalone-chat').boundingBox(),chatBounds);
      await row.getByRole('link').click();
      await admin.mouse.move(chatBounds.x + 100,chatBounds.y + 100);
      await visible(rows.locator('.thread-row[data-expanded="false"]').filter({has:admin.locator('[aria-current="page"]')}));
      assert.equal(await menu.evaluate(el => getComputedStyle(el).pointerEvents),'none');
      await row.hover();
      await menu.click();
      await visible(admin.getByRole('menuitem',{name:'Переименовать'}));
      await admin.keyboard.press('Escape');
      await admin.mouse.move(10,10);
      await admin.keyboard.press('Shift+Tab');
      assert.ok(await row.getByRole('link').evaluate(el => el === document.activeElement));
      assert.ok((await row.boundingBox()).width > before);
      await width.press('ArrowRight');
      const persisted = Number(await width.getAttribute('aria-valuenow'));
      await role(admin,'Свернуть список чатов').click();
      await rows.waitFor({state:'hidden'});
      assert.equal(await draft.inputValue(),'Черновик для проверки панели');
      await role(admin,'Развернуть список чатов').click();
      await admin.reload();
      assert.equal(Number(await width.getAttribute('aria-valuenow')),persisted);
      await draft.fill('');

      await go(admin,caseRoute);
      await admin.evaluate(() => window.scrollTo(0,0));
      const discussion = admin.getByRole('region',{name:'Переписка'});
      const chatWidth = admin.getByRole('separator',{name:'Ширина обсуждения'});
      const checkDock = async () => {
        await admin.waitForFunction(() => Math.abs(innerHeight -
          document.querySelector('#case-discussion .chat-box').getBoundingClientRect().bottom) <= 20);
        assert.ok(await admin.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      };
      await visible(discussion);
      await checkDock();
      await visible(admin.getByText('Очередь',{exact:true}).first());
      const atOpen = await discussion.boundingBox();
      const investigation = await admin.getByRole('region',{name:'Исследование'}).boundingBox();
      assert.ok(Math.abs(atOpen.y - investigation.y) <= 2);
      assert.equal(await admin.getByRole('separator',{name:'Высота обсуждения'}).count(),0);
      await admin.evaluate(() => window.scrollBy(0,370));
      await checkDock();
      assert.ok((await discussion.boundingBox()).height > atOpen.height);
      const handle = await chatWidth.boundingBox();
      const bounds = await discussion.boundingBox();
      assert.ok(Math.abs(handle.x + handle.width / 2 - bounds.x) <= 2);
      const widthBefore = Number(await chatWidth.getAttribute('aria-valuenow'));
      await chatWidth.press('ArrowLeft');
      const widthAfter = Number(await chatWidth.getAttribute('aria-valuenow'));
      assert.ok(widthAfter > widthBefore);
      await admin.reload();
      assert.equal(Number(await chatWidth.getAttribute('aria-valuenow')),widthAfter);
      await admin.setViewportSize({width:900,height:844});
      await discussion.evaluate(el => window.scrollBy(0, Math.max(120, el.getBoundingClientRect().top)));
      await checkDock();
      await go(admin,'settings/personal');
      await role(admin,'Сверху').click();
      await go(admin,caseRoute);
      await visible(discussion);
      await admin.evaluate(() => window.scrollTo(0,450));
      await checkDock();
      const topMenu = await admin.locator('#workspace-sidebar').boundingBox();
      assert.ok(Math.abs((await discussion.boundingBox()).y - topMenu.y - topMenu.height - 16) <= 2);
      await go(admin,'settings/personal');
      await role(admin,'Слева').click();
      await admin.setViewportSize({width:900,height:340});
      await go(admin,caseRoute);
      await visible(discussion);
      await admin.evaluate(() => window.scrollTo(0,0));
      await checkDock();
      const shortComposer = field(admin,'Вопрос агенту');
      await shortComposer.scrollIntoViewIfNeeded();
      const shortBounds = await shortComposer.boundingBox();
      assert.ok(shortBounds && shortBounds.y + shortBounds.height <= admin.viewportSize().height);
    } finally {
      await admin.setViewportSize({width:1440,height:900});
    }
    const touch = await login('admin','#chats/'+fixture.thread, {
      viewport:{width:390,height:844}, hasTouch:true, isMobile:true, reducedMotion:'reduce',
    });
    const { promise: threadGate, resolve: releaseThread } = Promise.withResolvers();
    try {
      await touch.setViewportSize({width:1024,height:844});
      await touch.getByRole('separator',{name:'Ширина списка чатов'}).press('Home');
      const touchMenu = touch.getByRole('button',{name:'Действия чата «Исходная переписка»'});
      await touchMenu.tap();
      await visible(touch.getByRole('menuitem',{name:'Переименовать'}));
      assert.equal(await touchMenu.evaluate(el => el.closest('.thread-row').dataset.expanded),'false');
      await touch.keyboard.press('Escape');
      await touch.setViewportSize({width:390,height:844});
      await role(touch,'Развернуть список чатов').tap();
      const rows = touch.getByRole('navigation',{name:'Переписки'});
      const active = rows.getByRole('link',{name:'Исходная переписка'});
      await touchMenu.tap();
      await visible(touch.getByRole('menuitem',{name:'Переименовать'}));
      await touch.keyboard.press('Escape');
      await active.tap();
      await rows.waitFor({state:'hidden'});
      await touch.route('**/api/team/case-thread',async route => {
        await threadGate;
        await route.continue();
      });
      await go(touch,caseRoute);
      const ask = role(touch.locator('.card-evidence'),'Спросить');
      await ask.tap();
      assert.ok(await ask.isVisible(), 'Разбор остаётся видимым, пока загружается чат');
      releaseThread();
      const composer = field(touch,'Вопрос агенту');
      await visible(composer);
      await composer.evaluate(el => new Promise(resolve => requestAnimationFrame(resolve)));
      assert.ok(await composer.evaluate(el => el === document.activeElement));
      assert.ok(await touch.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    } finally {
      releaseThread();
      await touch.context().close();
    }
  });

  await journey('active chat actions survive collapse and filtering', async () => {
    const desktop = await login('admin','#chats', {
      viewport:{width:821,height:844}, reducedMotion:'reduce',
    });
    let touch, participant;
    try {
      const actions = page => page.getByRole('region',{name:'Переписка'})
        .getByRole('button',{name:/^Действия чата/});
      const rows = page => page.getByRole('navigation',{name:'Переписки'});
      const rename = page => page.getByRole('menuitem',{name:'Переименовать'});
      const draft = field(desktop,'Вопрос агенту');
      const search = field(desktop,'Поиск чатов');
      const name = 'Ш'.repeat(120);
      await role(desktop,'Новый чат').click();
      const create = desktop.getByRole('dialog',{name:'Новый чат'});
      await field(create,'Название').fill('Проверка меню активного чата');
      await submit(desktop,'thread',()=>role(create,'Создать').click());
      const original = rows(desktop).getByRole('link',{name:'Проверка меню активного чата'});
      await visible(original);
      const hash = await original.getAttribute('href');
      await desktop.waitForURL(url => url.hash === hash);
      assert.equal(await actions(desktop).count(),0);
      await draft.fill('Черновик активного чата');
      await role(desktop,'Свернуть список чатов').click();
      await rows(desktop).waitFor({state:'hidden'});
      assert.equal(await actions(desktop).count(),1,'Collapsed chat list needs a menu in the heading');
      await actions(desktop).press('ArrowDown');
      await visible(rename(desktop));
      assert.equal(await desktop.getByRole('menuitem',{name:'Удалить чат'}).count(),1);
      assert.ok(await rename(desktop).evaluate(el => el === document.activeElement));
      await desktop.keyboard.press('Escape');
      await rename(desktop).waitFor({state:'hidden'});
      assert.ok(await actions(desktop).evaluate(el => el === document.activeElement));
      await actions(desktop).press('Enter');
      await rename(desktop).press('Enter');
      const dialog = desktop.getByRole('dialog',{name:'Переименовать чат'});
      await field(dialog,'Название').fill(name);
      await submit(desktop,'rename-thread',()=>role(dialog,'Сохранить').click());
      await dialog.waitFor({state:'hidden'});
      assert.ok(await actions(desktop).evaluate(el => el === document.activeElement));
      assert.equal(await draft.inputValue(),'Черновик активного чата');
      assert.equal(new URL(desktop.url()).hash,hash);

      await role(desktop,'Развернуть список чатов').click();
      const row = rows(desktop).getByRole('link',{name});
      await visible(row);
      assert.equal(await actions(desktop).count(),0);
      const fullyReadable = (page, locator) => page.waitForFunction(el => {
        const bounds = el.getBoundingClientRect();
        const range = document.createRange();
        range.selectNodeContents(el);
        const lines = Array.from(range.getClientRects());
        return lines.length > 1 && lines.every(line =>
          line.left >= Math.max(0,bounds.left)-1 &&
          line.right <= Math.min(innerWidth,bounds.right)+1 &&
          line.top >= bounds.top-1 && line.bottom <= bounds.bottom+1);
      }, locator);
      const label = row.locator('.thread-title');
      await row.hover();
      await fullyReadable(desktop,await label.elementHandle());
      await desktop.mouse.move(2,2);
      await search.focus();
      await desktop.keyboard.press('Tab');
      assert.ok(await row.evaluate(el => el === document.activeElement));
      await fullyReadable(desktop,await label.elementHandle());
      await search.fill('Беседы с таким названием нет');
      await row.waitFor({state:'detached'});
      await visible(actions(desktop));
      assert.equal(await draft.inputValue(),'Черновик активного чата');
      assert.equal(new URL(desktop.url()).hash,hash);
      await actions(desktop).click();
      await visible(rename(desktop));
      await desktop.keyboard.press('Escape');
      await desktop.setViewportSize({width:390,height:844});
      await role(desktop,'Развернуть список чатов').click();
      await search.fill('');
      await visible(row);
      assert.equal(await actions(desktop).count(),0);
      await row.hover();
      await fullyReadable(desktop,await label.elementHandle());
      await desktop.mouse.move(2,2);
      await search.focus();
      await desktop.keyboard.press('Tab');
      assert.ok(await row.evaluate(el => el === document.activeElement));
      await fullyReadable(desktop,await label.elementHandle());

      touch = await login('admin',hash, {
        viewport:{width:390,height:844}, hasTouch:true, isMobile:true, reducedMotion:'reduce',
      });
      const touchTitle = touch.getByRole('heading',{name});
      await visible(touchTitle);
      await fullyReadable(touch,await touchTitle.elementHandle());
      await actions(touch).tap();
      await visible(rename(touch));
      await touch.keyboard.press('Escape');
      await role(touch,'Развернуть список чатов').tap();
      await visible(rows(touch).getByRole('link',{name}));
      assert.equal(await actions(touch).count(),0);

      const matchingTitle = 'Текст совпадает с фильтром';
      await search.fill('совпадает с фильтром');
      await actions(desktop).press('ArrowDown');
      await rename(desktop).press('Enter');
      await field(dialog,'Название').fill(matchingTitle);
      await submit(desktop,'rename-thread',()=>role(dialog,'Сохранить').press('Enter'));
      await dialog.waitFor({state:'hidden'});
      const rowActions = role(rows(desktop),'Действия чата «'+matchingTitle+'»');
      await visible(rowActions);
      assert.ok(await rowActions.evaluate(el => el === document.activeElement),
        'Keyboard focus follows the chat actions from the heading to the newly visible row');

      await desktop.setViewportSize({width:821,height:844});
      await desktop.reload();
      await rowActions.press('ArrowDown');
      await rename(desktop).press('Enter');
      await desktop.setViewportSize({width:390,height:844});
      await rows(desktop).waitFor({state:'hidden'});
      await field(dialog,'Название').fill('Действия снова в заголовке');
      await submit(desktop,'rename-thread',()=>role(dialog,'Сохранить').press('Enter'));
      await dialog.waitFor({state:'hidden'});
      assert.ok(await actions(desktop).evaluate(el => el === document.activeElement),
        'Keyboard focus follows the chat actions from the now hidden row back to the heading');

      await go(desktop,'chats/group');
      await visible(desktop.getByRole('region',{name:'Переписка'}).getByText('Командный чат',{exact:true}));
      await actions(desktop).click();
      await visible(rename(desktop));
      assert.equal(await desktop.getByRole('menuitem',{name:'Удалить чат'}).count(),0);
      participant = await login('member','#chats/group',{
        viewport:{width:390,height:844}, reducedMotion:'reduce',
      });
      await visible(participant.getByRole('region',{name:'Переписка'}).getByText('Командный чат',{exact:true}));
      assert.equal(await actions(participant).count(),0);
    } finally {
      await desktop.context().close();
      await touch?.context().close();
      await participant?.context().close();
    }
  });

  await journey('source categories open readable tables in live and saved views', async () => {
    for (const route of [caseRoute,'snapshot/'+fixture.calc+'/evidence']) {
      await go(admin,route);
      const sources = admin.locator('.card-evidence');
      const metrics = sources.getByRole('button',{name:/^Метрики/});
      const dialog = admin.getByRole('dialog');
      await visible(metrics);
      assert.equal(await sources.getByText('Источники и период',{exact:true}).count(),0);
      const version = sources.getByRole('link',{name:'Открыть версию расчёта'});
      await visible(version);
      assert.match(await version.getAttribute('href'),/^#snapshot\//);
      await metrics.click();
      await visible(dialog.getByRole('columnheader',{name:'Источник'}));
      await visible(dialog.getByText(/Synthetic evaluation\.xlsx · Kaspersky!A\d+/).first());
      await admin.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});
      assert.ok(await metrics.evaluate(el => el === document.activeElement));

      await sources.getByRole('button',{name:/^Исследования/}).click();
      await visible(dialog.getByRole('cell',{name:/участнику синтетического примера непонятен выбор версии лицензии/}));
      await role(dialog,'Закрыть').click();
      await dialog.waitFor({state:'hidden'});
      await sources.getByRole('button',{name:/^Конкуренты/}).click();
      await visible(dialog.getByText('Нет материалов.',{exact:true}));
      await admin.keyboard.press('Escape');
      await dialog.waitFor({state:'hidden'});
    }
    await go(admin,'material/'+fixture.report);
  });

  await journey('a cited spreadsheet cell opens a public page in a private chat', async () => {
    const store=app.space('team');
    const doc={file:'Public.xlsx',facts:[{kind:'competitor',loc:'Цена!A2',text:'Цена 1200 рублей',
      links:[{loc:'Цена!D2',url:'https://catalog.example/item'}]}]};
    importDocs(store,[doc],{notify:false});
    await go(admin,'sources');
    await admin.getByRole('link',{name:'Public.xlsx'}).click();
    await role(admin,'Проверить ссылку из Цена!D2').click();
    await field(admin,'Что проверить по ссылке').fill('Сверь цену 1200 рублей');
    await submit(admin,'ask',()=>role(admin,'Проверить в чате').click());
    await workJobs(store,app.accounts,{...env,LLM_DATA_MODE:'selection'},transport,{
      resolveHost:async()=>[{address:'93.184.216.34',family:4}],
      request:async()=>new Response('<title>Каталог</title><p>Цена 1200 рублей.</p>',{headers:{'Content-Type':'text/html'}}),
    });
    await admin.reload();
    await visible(admin.getByRole('link',{name:'Каталог',exact:true}));
    const cell=admin.getByRole('link',{name:'Public.xlsx · Цена!D2'});
    await cell.click();
    await visible(role(admin,'Проверить ссылку из Цена!D2'));
    await go(admin,'material/'+fixture.report);
  });
  await journey('old links, personal access, navigation and themes', async () => {
    await go(admin,'material/'+fixture.report);
    await visible(admin.getByRole('heading',{name:'Исходный отчёт'}));
    await visible(member.getByText('Снимок недоступен', {exact:false}).first());
    await go(member, 'snapshot/'+fixture.calc+'/trend');
    await visible(member.locator('.card-trend'));
    assert.equal(await member.locator('.card-summary').count(),0);
    assert.equal(await member.locator('html').getAttribute('data-theme'),'light');
    assert.equal(await role(member,'Тёмная тема').count(),0);
    await go(member,'settings/personal');
    await visible(member.getByRole('heading',{name:'Оформление'}));
    await role(member,'Тёмная тема').click();
    assert.equal(await member.locator('html').getAttribute('data-theme'),'dark');
    assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
    await go(admin,'cases/settings');
    await visible(role(admin,'Пригласить участника'));
    assert.equal(await admin.getByRole('link',{name:'Настройки команды'}).getAttribute('aria-current'),'page');
    for (const name of ['Подключения команды','Правило уведомления','Мониторинг продуктовых метрик','Доставка уведомлений'])
      await visible(admin.getByRole('heading',{name}));
    const rules = admin.getByRole('region',{name:'Мониторинг продуктовых метрик'});
    const ctr = rules.locator('details').filter({ hasText:'CTR рекомендаций ЛК' });
    await visible(ctr.getByText('Недостаточно данных',{exact:true}));
    await visible(ctr.getByText('Выберите релиз для четырёхнедельной базы.',{exact:true}));
    const ruleSummary = ctr.locator('summary');
    const checkChevron = () => ruleSummary.evaluate(el => (
      Math.abs(parseFloat(getComputedStyle(el,'::before').top) - el.getBoundingClientRect().height / 2) < 1
    ));
    assert.ok(await checkChevron());
    await ruleSummary.click();
    for (const group of ['Продукт и источник','База сравнения','Условия уведомления'])
      await visible(ctr.getByRole('group',{name:group}));
    assert.ok(await checkChevron());
    await ruleSummary.click();
    for (const page of [admin, member]) {
      const backdrop = await page.locator('.team-app').evaluate(el => {
        const style = getComputedStyle(el);
        return { layers: style.backgroundImage.match(/repeating-radial-gradient/g)?.length,
          attachment: style.backgroundAttachment };
      });
      assert.deepEqual(backdrop,{layers:2,attachment:'scroll, fixed'});
      assert.equal(await page.locator('.workspace-backdrop').count(),0);
    }
    assert.equal(await role(admin,'Сверху').count(),0);
    assert.equal(await role(admin,'Выпустить ключ MCP').count(),0);
    await submit(admin,'invite',()=>role(admin,'Пригласить участника').click());
    await visible(admin.locator('.notice').filter({hasText:/\/#join\//}));
    const limit = field(admin,'Максимум одновременных ИИ-проверок');
    assert.equal(await limit.inputValue(),'10');
    await limit.fill('');
    assert.equal(await limit.evaluate(el=>el.validity.valid),false);
    await limit.fill('3');
    await submit(admin,'save-investigation-limit',()=>role(admin,'Сохранить лимит').click());
    await admin.reload();
    assert.equal(await limit.inputValue(),'3');
    const teamMode = field(admin,'Режим исследований по сигналам');
    assert.equal(await teamMode.inputValue(),'roles');
    await teamMode.selectOption('review');
    await submit(admin,'save-research-settings',()=>role(admin,'Сохранить режим').click());
    await go(member,'settings');
    await visible(member.getByText('Ведущий и рецензент',{exact:true}));
    await visible(member.getByText('Максимум одновременных ИИ-проверок · 3',{exact:true}));
    assert.equal(await role(member,'Сохранить лимит').count(),0);
    const memberRule = member.getByRole('region',{name:'Мониторинг продуктовых метрик'})
      .locator('details').filter({hasText:'CTR рекомендаций ЛК'});
    await memberRule.locator('summary').click();
    await visible(memberRule.getByText('Весь трафик',{exact:true}));
    assert.equal(await role(memberRule,'Сохранить правило').count(),0);
    assert.equal(await role(member,'Сохранить режим').count(),0);
    await member.getByRole('link',{name:'Мои настройки'}).click();
    const personalMode = field(member,'Режим моих поручений');
    assert.equal(await personalMode.inputValue(),'inherit');
    assert.equal(await member.getByRole('link',{name:'Мои настройки'}).getAttribute('aria-current'),'page');
    assert.equal(await personalMode.locator('option[value="inherit"]').textContent(),'Как у команды · Ведущий и рецензент');
    await personalMode.selectOption('lead');
    await submit(member,'save-research-settings',()=>role(member,'Сохранить режим').click());
    await member.reload();
    assert.equal(await personalMode.inputValue(),'lead');
    assert.equal(await member.locator('html').getAttribute('data-theme'),'dark');
    await teamMode.selectOption('roles');
    await submit(admin,'save-research-settings',()=>role(admin,'Сохранить режим').click());
    await personalMode.selectOption('inherit');
    await submit(member,'save-research-settings',()=>role(member,'Сохранить режим').click());
    await admin.getByRole('link',{name:'Мои настройки'}).click();
    await visible(field(admin,'Режим моих поручений'));
    assert.equal(await role(admin,'Пригласить участника').count(),0);
    assert.equal(await admin.getByRole('heading',{name:'Правило уведомления'}).count(),0);
    await submit(admin,'mcp-key',()=>role(admin,'Выпустить ключ MCP').click());
    await visible(admin.locator('.notice').filter({hasText:/^Персональный ключ MCP/}));
    const [bindingResponse] = await submit(admin,'bind',()=>role(admin,'Привязать Telegram').click());
    const bindingLink = admin.getByRole('link',{name:'Открыть бота в Telegram'});
    await visible(bindingLink);
    const {command} = await bindingResponse.json();
    assert.equal(new URL(await bindingLink.getAttribute('href')).searchParams.get('start'),command.slice(7));
    await role(admin,'Сверху').click();
    await admin.locator('[data-menu=top]').waitFor();
    await admin.reload();
    await admin.locator('[data-menu=top]').waitFor();
    await role(admin,'Слева').click();
    await visible(admin.getByRole('heading',{name:'Личные подключения'}));
    await go(admin,'sources');
    await visible(role(admin,'Загрузить и пересчитать'));
    await go(member,'sources');
    assert.equal(await role(member,'Загрузить и пересчитать').count(),0);
  });

  await journey('Redmine team configuration and personal access use their own settings routes', async () => {
    const endpoint = base+'/api/team/integration-config';
    const service = 'redmine';
    const overview = await admin.request.post(base+'/api/team/overview',{data:{}});
    const previous = (await overview.json()).integrations[service];
    try {
      await go(admin,'settings');
      await admin.getByText('Адрес и назначение команды',{exact:true}).click();
      await field(admin,'Адрес сервиса').fill('https://settings-redmine.test');
      await field(admin,'Идентификатор проекта').fill('settings');
      await submit(admin,'integration-config',()=>role(admin,'Сохранить настройки команды').click());
      await visible(admin.getByText('https://settings-redmine.test · settings',{exact:true}));
      assert.equal(await role(admin,'Подключить Redmine').count(),0);

      await go(member,caseRoute);
      const connect = member.getByRole('link',{name:'Подключить личный доступ'});
      await connect.click();
      assert.equal(new URL(member.url()).hash,'#settings/personal');
      await visible(member.getByRole('heading',{name:'Личные подключения'}));
      assert.equal(await member.getByText('Адрес и назначение команды',{exact:true}).count(),0);
      await field(member,'Персональный API-ключ').fill('fixture-personal-redmine');
      await submit(member,'integration-access',()=>role(member,'Подключить Redmine').click());
      await visible(member.getByText('settings · Личный доступ подключён',{exact:true}));

      await go(admin,'settings/personal');
      await visible(admin.getByText('settings · Требуется личный доступ',{exact:true}));
      assert.equal(await role(admin,'Проверить доступ').count(),0);
      await submit(member,'integration-access',()=>role(member,'Проверить доступ').click());
      await visible(member.getByText('Redmine · Доступ подтверждён',{exact:true}));
      await submit(member,'integration-access',()=>role(member,'Отключить личный доступ').click());
      await visible(member.getByText('settings · Требуется личный доступ',{exact:true}));
    } finally {
      const restored = await admin.request.post(endpoint,{data:{service,url:previous.url || '',
        scope:previous.scope, originFieldId:previous.originFieldId}});
      assert.ok(restored.ok());
    }
  });

  await journey('the PM finds supporting and conflicting excerpts from an uploaded Excel workbook', async () => {
    const hypothesis = 'В кабинете удобно продлевать лицензию';
    const positive = 'Продлевать лицензию в кабинете удобно благодаря напоминанию.';
    const negative = 'Продлевать лицензию в кабинете неудобно из-за повторного ввода договора.';
    const rows = [
      ['Обезличенная выдержка','Дата','Исходная книга','Ячейка источника','Проверяемая гипотеза','Связь с гипотезой'],
      [positive,'2026-10-08','Интервью о лицензиях.xlsx','Ответы!C3',hypothesis,'подтверждает'],
      [negative,'2026-10-09','Интервью о лицензиях.xlsx','Ответы!C4',hypothesis,'опровергает'],
    ];
    const bin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3');
    const xlsx = spawnSync(bin, ['tests/research-workbooks.py', '--xlsx'], { input:JSON.stringify(rows), windowsHide:true });
    if (xlsx.error) throw xlsx.error;
    assert.equal(xlsx.status,0,xlsx.stderr.toString());
    await go(admin,'sources');
    await admin.locator('input[type=file]').setInputFiles({ name:'Выдержки.xlsx',
      mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer:xlsx.stdout });
    const [uploaded] = await submit(admin,'upload',()=>role(admin,'Загрузить и пересчитать').click());
    assert.equal((await uploaded.json()).inserted,1);

    await go(member,caseRoute);
    const panel = member.locator('.interview-search');
    async function findExcerpts() {
      await panel.locator('summary').click();
      await field(panel,'Тема или цитата').fill('продлевать лицензию в кабинете');
      const [found] = await submit(member,'search',()=>role(panel,'Найти выдержки').click());
      return found.json();
    }
    const fromUploadedBook = hits => hits.filter(hit => hit.source.startsWith('Интервью о лицензиях.xlsx · '));
    const all = fromUploadedBook(await findExcerpts());
    assert.deepEqual(new Set(all.map(hit => hit.source)),
      new Set(['Интервью о лицензиях.xlsx · Ответы!C3','Интервью о лицензиях.xlsx · Ответы!C4']));
    await visible(panel.getByText(positive,{exact:true}));
    await visible(panel.getByText(negative,{exact:true}));
    await visible(panel.getByText('Гипотеза «'+hypothesis+'» · подтверждает',{exact:true}));
    await visible(panel.getByText('Гипотеза «'+hypothesis+'» · опровергает',{exact:true}));
    assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));

    await member.getByText('Период расчёта',{exact:true}).click();
    await field(member,'Срез по дату включительно').fill('2026-10-08');
    await submit(member,'view',()=>role(member,'Применить период').click());
    await panel.getByText('Интервью по 2026-10-08 включительно').waitFor({state:'attached'});
    assert.deepEqual(fromUploadedBook(await findExcerpts()).map(hit => hit.data),[positive]);
    await visible(panel.getByText(positive,{exact:true}));
    assert.equal(await panel.getByText(negative,{exact:true}).count(),0);
    await field(member,'Срез по дату включительно').fill('');
    await submit(member,'view',()=>role(member,'Применить период').click());
  });

  await journey('signal, publication to the team and effect monitoring', async () => {
    await go(admin,'overview');
    await admin.getByRole('link',{name:'Открыть разбор'}).first().click();
    await visible(admin.locator('.investigation-head .state'));
    await role(admin,'Поделиться').click();
    const dialog=admin.getByRole('dialog');
    await visible(dialog.getByText('Команда Store',{exact:false}));
    await field(dialog,'Вывод для команды').fill('Вывод для приёмки');
    await submit(admin,'publish',()=>role(dialog,'Опубликовать').click());
    await go(member,'chats/group');
    await visible(member.getByText('Вывод для приёмки',{exact:false}).first());
    await admin.locator('summary').filter({hasText:'Проверка эффекта'}).click();
    await field(admin,'Дата выкладки').fill('2026-12-07');
    await submit(admin,'watch',()=>role(admin,'Назначить проверку').click());
    await visible(admin.getByText('Полные недели, продукт / контроль'));
    await visible(admin.getByText('Ожидаем данные после исправления'));
  });

  await journey('prepare a signal task, confirm it and find it from another account', async () => {
    const route = new URL(admin.url()).hash.slice(1);
    const button = role(admin, 'Подготовить задачу по сигналу');
    const [response] = await submit(admin, 'signal-issue-draft', () => button.click());
    const request = response.request().postDataJSON();
    assert.equal(request.caseId, route.split('/')[1]);
    const draft = await response.json();
    assert.equal(draft.state, 'draft');
    const card = admin.locator('#case-draft-' + draft.id);
    await admin.waitForFunction(id => document.activeElement?.id === 'case-draft-' + id, draft.id);
    await visible(card.getByText('ai-generated', {exact:true}));
    await visible(card.getByText('Сгенерирована ИИ-помощником.', {exact:false}));
    const draftUrl = base + '/api/team/signal-issue-draft';
    const repeats = await Promise.all([request, {caseId:request.caseId}].map(data => admin.request.post(draftUrl, {data})));
    for (const repeat of repeats) {
      assert.ok(repeat.ok());
      assert.equal((await repeat.json()).id, draft.id);
    }
    const stale = await admin.request.post(draftUrl, {data:{...request, revision:(request.revision ?? 0) + 1}});
    assert.equal(stale.status(), 400);
    const [saved] = await submit(admin, 'confirm', () => role(card, 'Подтвердить запись').click());
    const receipt = await saved.json();
    await visible(card.getByRole('link', {name:/Открыть задачу/}));

    await go(member, route);
    assert.equal(await member.locator('#case-draft-' + draft.id).count(), 0);
    const panel = member.locator('.task-panel');
    await field(panel, 'Поиск задач').fill(draft.title);
    await field(panel, 'Только с меткой ai-generated').check();
    await submit(member, 'issue_search', () => role(panel, 'Найти похожие задачи').click());
    const result = role(panel, receipt.key + ' · ' + draft.title + ' · ai-generated');
    await submit(member, 'issue_read', () => result.click());
    await visible(panel.getByText('Происхождение задачи · ai-generated', {exact:true}));
  });

  await journey('Redmine works directly while saved Confluence pages stay hidden', async () => {
    for (const p of [admin,member,judge]) {
      await go(p,'settings');
      await visible(p.getByRole('heading',{name:'Redmine',exact:true}));
      assert.equal(await p.getByText(/Confluence/i).count(),0);
      assert.equal(await p.getByRole('navigation').getByRole('link', {name:'База знаний'}).count(),0);
    }
    await go(admin,caseRoute);
    const panel=admin.locator('.task-panel');
    await visible(panel.getByRole('heading',{name:'Задачи Redmine'}));
    assert.equal(await panel.getByRole('button',{name:/^(Redmine|Confluence)$/}).count(),0);
    const draft=admin.locator('.tracker-preview').filter({hasText:'Исходный черновик'});
    await submit(admin,'confirm',()=>role(draft,'Подтвердить запись').click());
    const issue=draft.getByRole('link',{name:/Открыть задачу/});
    await visible(issue);
    const issueHref=await issue.getAttribute('href');
    // Create representative existing data through the unchanged authenticated API.
    async function post(op,data) {
      const res=await admin.request.post(base+'/api/team/'+op,{data});
      assert.ok(res.ok(),op);
      return res.json();
    }
    const page=await post('page_draft',{caseId:fixture.caseId,title:'Результаты приёмки',
      content:'Проверено по двум периодам.',issueKey:issueHref.split('/').at(-1)});
    const receipt=await post('confirm',{id:page.id,revision:page.revision});
    assert.equal((await post('page_read',{key:receipt.key})).title,'Результаты приёмки');
    await admin.reload();
    await visible(issue);
    assert.equal(await panel.getByText('Результаты приёмки').count(),0);
    await issue.click();
    await visible(admin.getByRole('heading',{name:'Исходный черновик'}));
    assert.equal(await admin.getByText(/Confluence/i).count(),0);
    assert.equal(await admin.locator('a[href*="#demo-page/"]').count(),0);
    await go(member,caseRoute);
    await visible(member.locator('a[href="'+issueHref+'"]'));
    assert.equal(await member.getByText('Результаты приёмки').count(),0);
    let pageReads=0;
    admin.on('request',r=>{if(r.url().endsWith('/page_read')) pageReads++;});
    await admin.goto(base+'/'+receipt.url);
    await visible(admin.getByRole('heading',{name:'Разборы',exact:true}));
    assert.equal(pageReads,0);
    app.space('team').db.prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES(?,?,'assistant',?,?)")
      .run(fixture.thread,'Помощник',JSON.stringify({text:'Проверка завершена. [Документ]('+receipt.url+')',steps:['issue_read','page_read'],
        actions:[{op:'page_draft',id:page.id,title:'Результаты приёмки'}]}),Date.now());
    await go(admin,'chats/'+fixture.thread);
    const msg=admin.locator('.bubble').filter({hasText:'Проверка завершена.'});
    await msg.getByText('Выполненные проверки').click();
    await visible(msg.getByText('Прочитана задача'));
    assert.equal(await msg.getByRole('link',{name:'Документ'}).count(),0);
    assert.equal(await msg.getByText(/Прочитана страница|Результаты приёмки/).count(),0);
    await go(judge,issueHref.slice(1));
    await visible(judge.getByRole('alert').first());
  });

  await journey('a previously imported workbook links back to Sources without Bridge', async () => {
    const db = app.space('team').db;
    const {version} = db.prepare("SELECT version FROM documents WHERE lower(file) LIKE '%.xlsx' LIMIT 1").get();
    await go(admin, 'knowledge-source/' + version);
    await admin.locator('main').getByRole('link', {name:'Источники', exact:true}).click();
    await visible(admin.getByRole('heading', {name:'Источники', exact:true}));
  });

  await journey('Signal Bridge publishes a closed result with versioned Excel and hides it from a second account', async () => {
    env.SIGNAL_BRIDGE_URL = 'http://localhost:8731';
    env.APP_BASE_URL = base;
    const store = app.space('team');
    const owner = (await app.accounts.login({login:'fixture-admin',password:'fixture-password'})).user;
    const post = async (page, op, data = {}) => {
      const response = await page.request.post(base + '/api/team/' + op, { data });
      assert.ok(response.ok(), await response.text());
      return response.json();
    };
    const report = { start: '2026-05-11', end: '2026-05-24', status: 'Снижение', web: 'https://metrika.test/report',
      periods: [[100, 20], [90, 12]] };
    const quote = 'Сверили вручную.\nДанные подтверждены.';
    const book = text => ({ file:'Документация 731.xlsx', facts: [{kind:'competitor', loc:'Итог!A2', text}] });
    try {
      const { id } = await post(admin, 'create-case', {title:'Закрытие в командном разборе 731', product:'Kaspersky'});
      store.db.prepare("UPDATE cases SET body=json_remove(body,'$.owner') WHERE id=?").run(id);
      const draft = await post(admin, 'draft', {caseId:id, title:task.title, description:task.description});
      await post(admin, 'confirm', {id:draft.id,revision:draft.revision});
      store.tx(() => saveClosure(store.db, app.accounts, id, owner.id, {
        ...task, reference:bridgeReference, issue:731, episode:1, observed:'2026-05-25',
        closing_note:{text:quote,author:'Автор'}, report, personalOwner:owner.id,
      }, env, false));
      importDocs(store, [book('Исходная ячейка 731')], {notify:false});
      const {version} = (await post(admin,'knowledge-sources')).find(source => source.file === 'Документация 731.xlsx');
      await admin.reload();
      await admin.getByRole('navigation').getByRole('link', {name:'База знаний'}).click();
      await field(admin,'Поиск по задачам, страницам и источникам').fill('731');
      await visible(admin.getByRole('heading',{name:task.title,exact:true}));
      assert.equal(await admin.getByRole('link',{name:'Отчёт Метрики',exact:true}).getAttribute('href'), report.web);
      const pageUrl = await admin.getByRole('link',{name:'Страница по задаче'}).getAttribute('href');
      await admin.getByRole('link',{name:'Оформить документацию'}).click();
      const panel = admin.locator('.task-panel');
      await field(panel,'Текст публикации').fill('Вывод по результату 731');
      await field(panel,new RegExp('Документация 731.xlsx.*' + version.slice(0,12))).check();
      const [previewResponse] = await submit(admin,'page_draft',()=>role(panel,'Подготовить страницу базы знаний').click());
      const {id: previewId} = await previewResponse.json();
      const preview = panel.locator('#case-draft-' + previewId);
      await visible(preview.getByText('Источник Excel · Документация 731.xlsx'));
      await submit(admin,'confirm',()=>role(preview,'Подтвердить запись').click());
      await visible(preview.getByRole('link',{name:/Открыть страницу/}));
      assert.equal(task.comments.filter(note => note.text.includes(base + '/' + pageUrl)).length, 1);
      importDocs(store, [book('Более новая ячейка 731')], {notify:false});
      await preview.getByRole('link',{name:/Открыть страницу/}).click();
      await visible(admin.getByText('Вывод по результату 731',{exact:false}));
      await admin.getByRole('link',{name:'Документация 731.xlsx',exact:true}).click();
      await visible(admin.getByText('Исходная ячейка 731',{exact:true}));
      await admin.locator('main').getByRole('link',{name:'База знаний',exact:true}).click();
      await visible(admin.getByRole('heading',{name:'База знаний',exact:true}));

      await member.reload();
      await go(member,'knowledge');
      await field(member,'Поиск по задачам, страницам и источникам').fill(task.title);
      await visible(member.getByText('Совпадений нет.',{exact:true}));
      assert.equal((await post(member,'knowledge')).results.some(r => r.issue === 731),false);
      await member.goto(base + '/' + pageUrl);
      await visible(member.getByRole('alert').filter({hasText:'Страница недоступна'}));
      for (const [page, question] of [
        [admin,'Прочитай комментарий при закрытии Redmine #731 и страницу'],
        [member,'Прочитай страницу по задаче Redmine #731'],
      ]) {
        const thread = await post(page,'thread',{title:'База знаний 731'});
        await post(page,'ask',{thread:thread.id,question});
        await workJobs(store,app.accounts,env,send);
        await go(page,'chats/' + thread.id);
      }
      await visible(admin.locator('blockquote').filter({hasText:'Данные подтверждены.'}));
      assert.equal(await admin.locator('blockquote').textContent(), quote);
      await visible(admin.getByRole('link',{name:'Отчёт Метрики при создании задачи'}));
      await visible(admin.getByRole('link',{name:task.title,exact:false}));
      await visible(member.getByText('Страница по задаче недоступна.',{exact:false}).first());
      assert.equal(await member.locator('blockquote').count(),0);
      assert.equal(await member.locator('a[href="'+pageUrl+'"]').count(),0);
    } finally {
      delete env.SIGNAL_BRIDGE_URL;
      delete env.APP_BASE_URL;
      await admin.reload();
      await member.reload();
    }
  });

  await journey('a historical period survives reload and reaches the filter, chat, MCP and saved calculations', async () => {
    await go(admin,caseRoute);
    const options = admin.getByText('Период расчёта',{exact:true});
    await options.click();
    const from = '2026-09-07', through = '2026-09-13';
    await field(admin,'Начало периода').fill(from);
    await field(admin,'Срез по дату включительно').fill(through);
    const historicalView = full => admin.waitForResponse(r => {
      if (!r.url().endsWith('/api/team/view') || !r.ok()) return false;
      const args = r.request().postDataJSON();
      return args?.from === from && args?.through === through && args?.full === full;
    });
    const [selected] = await Promise.all([historicalView(false),role(admin,'Применить период').click()]);
    const calculated = (await selected.json()).view;
    assert.equal(calculated.base,from);
    assert.equal(calculated.cut,through);
    assert.deepEqual(calculated.summary[0].rows.map(r=>r.week),[from]);
    const filter = field(admin,'Только полные недели');
    const [filtered] = await Promise.all([historicalView(true),filter.check()]);
    const fullView = (await filtered.json()).view;
    assert.equal(fullView.cut,through);
    assert.equal(fullView.full,true);
    await Promise.all([historicalView(true),admin.reload()]);
    await options.click();
    assert.equal(await field(admin,'Начало периода').inputValue(),from);
    assert.equal(await field(admin,'Срез по дату включительно').inputValue(),through);
    assert.equal(await filter.isChecked(),true);

    const proof = admin.locator('.card-summary');
    assert.equal(await role(proof,'Расчёт').count(),0);
    await proof.getByText('Источники и период',{exact:true}).click();
    await visible(proof.getByText(`База с ${from},`,{exact:false}));
    const snapshot = proof.getByRole('link',{name:'Открыть версию расчёта'});
    const href = await snapshot.getAttribute('href');
    assert.equal(href,'#snapshot/'+fullView.id);
    await field(admin,'Вопрос агенту').fill('Повтори показатели с экрана.');
    const [asked] = await submit(admin,'ask',()=>role(admin,'Отправить').click());
    const { thread } = asked.request().postDataJSON();
    await workJobs(app.space('team'),app.accounts,env,transport);
    const bubble = admin.locator('.bubble.assistant').filter({hasText:'Для расчёта изменения недостаточно сопоставимых данных.'});
    await visible(bubble);
    const transcript = await admin.request.post(base+'/api/team/messages',{data:{thread}});
    assert.ok(transcript.ok());
    const reply = (await transcript.json()).items.at(-1);
    assert.equal(reply.body.calc,fullView.id);

    const keyResponse = await admin.request.post(base+'/api/team/mcp-key',{data:{}});
    assert.ok(keyResponse.ok());
    const { key } = await keyResponse.json();
    const mcp = new Client({name:'period-acceptance',version:'1'});
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'), {
        requestInit:{headers:{Authorization:'Bearer '+key}},
      }));
      const result = await mcp.callTool({name:'analyze_case',arguments:{caseId:fixture.caseId,from,through,full:true}});
      assert.ok(!result.isError,result.content[0].text);
      assert.deepEqual(JSON.parse(result.content[0].text),fullView);
    } finally { await mcp.close(); }

    await filter.uncheck();
    await field(admin,'Начало периода').fill('');
    await field(admin,'Срез по дату включительно').fill('');
    await Promise.all([
      admin.waitForResponse(r => r.url().endsWith('/api/team/view') && r.ok() && !r.request().postDataJSON()?.through),
      role(admin,'Применить период').click(),
    ]);
    await go(admin,href.slice(1));
    await visible(admin.getByRole('heading',{name:'Сохранённый расчёт'}));
    await proof.getByText('Источники и период',{exact:true}).click();
    await visible(proof.getByText('срез по '+through,{exact:false}));
    await visible(proof.getByText('Только полные недели.',{exact:false}));
  });

  await journey('chat groups keep team conversations personal and case discussions searchable', async () => {
    async function api(page, operation, data) {
      const response = await page.request.post(base+'/api/team/'+operation, {data});
      assert.ok(response.ok());
      return response.json();
    }
    const {id:caseThread} = await api(admin,'case-thread',{caseId:fixture.caseId});
    const {id:privateThread} = await api(admin,'thread',{title:'Приёмка переписок · вопрос'});
    await api(admin,'rename-thread',{thread:caseThread,title:'Приёмка переписок · обсуждение'});
    await go(admin,'chats/'+caseThread);
    const nav = admin.getByRole('navigation',{name:'Переписки'});
    const group = name => nav.getByRole('region',{name,exact:true});
    const link = (area,id) => area.locator('a[href="#chats/'+id+'"]');
    const search = field(admin,'Поиск чатов');
    await visible(link(group('Разборы'),caseThread));
    assert.deepEqual(await nav.getByRole('heading').allTextContents(),['Личные','Разборы']);
    await visible(link(group('Личные'),'group'));
    await visible(link(group('Личные'),privateThread));
    assert.equal(await link(nav,caseThread).count(),1);
    assert.equal(await link(nav,caseThread).getAttribute('aria-current'),'page');
    await search.fill('ПРИЁМКА ПЕРЕПИСОК');
    assert.equal(await nav.getByRole('link').count(),2);
    await search.fill('Приёмка переписок · вопрос');
    assert.equal(await group('Разборы').count(),0);
    await search.fill('zzz-no-match');
    await visible(nav.getByText('Чаты не найдены'));
    await search.fill('');
    assert.equal(await link(nav,caseThread).getAttribute('aria-current'),'page');

    const {id:memberThread} = await api(member,'case-thread',{caseId:fixture.caseId});
    await go(member,'chats/group');
    const toggle = member.locator('.threads-toggle');
    await toggle.click();
    const mobileNav = member.getByRole('navigation',{name:'Переписки'});
    await visible(link(mobileNav.getByRole('region',{name:'Личные'}),'group'));
    await link(mobileNav.getByRole('region',{name:'Разборы'}),memberThread).click();
    await member.waitForURL('**/#chats/'+memberThread);
    assert.equal(await toggle.getAttribute('aria-expanded'),'false');
  });

  await journey('A/B, resumable research, pin, delete, reopen and explicitly share', async () => {
    await go(admin,'snapshot/'+fixture.calc+'/trend');
    const plot = admin.locator('.range-plot svg').first();
    await plot.focus(); await plot.press('Home'); await plot.press('Space'); await plot.press('Shift+ArrowRight');
    await role(admin,'Добавить период для сравнения').click();
    await plot.focus(); await plot.press('End'); await plot.press('Space'); await plot.press('Shift+ArrowLeft');
    await role(admin,'Спросить о выделении').click();
    await visible(admin.locator('.range-attachment'));
    await field(admin,'Вопрос агенту').fill('Проверь соседний период и разбери причины изменения индекса заказов.');
    await submit(admin,'ask',()=>role(admin,'Отправить').click());
    const store=app.space('team');
    await workJobs(store,app.accounts,env,async()=>new Response('', {status:401}));
    await submit(admin,'resume-job',()=>role(admin,'Продолжить с сохранённого шага').click());
    await workJobs(store,app.accounts,env,transport);
    const reply = JSON.parse(store.db.prepare("SELECT body FROM chat_items WHERE thread=? AND role='assistant' ORDER BY seq DESC LIMIT 1").get(admin.url().split('/').at(-1)).body);
    assert.equal(reply.outcome, 'done', reply.warning || reply.text);
    await role(admin,'Продолжить с сохранённого шага').waitFor({state:'hidden'});
    const report=admin.locator('.bubble.assistant .material-card.report').first();
    await visible(report);
    const href=await report.locator('a.material-preview').getAttribute('href');
    const sourceRoute = new URL(admin.url()).hash.slice(1);
    await report.locator('a.material-preview').click();
    const dialog=admin.getByRole('dialog');
    await visible(role(dialog,'Приложить к сообщению'));
    assert.equal(await pinActions(dialog).count(),0);
    await admin.keyboard.press('Escape');
    assert.equal(await pinActions(report).count(),0);

    await go(admin,caseRoute);
    const {card, thread} = await sendMaterialToCase(admin,href);
    const pinned = admin.locator('.case-main a[href="'+href+'"]');
    const [added] = await submit(admin,'pin-material',()=>role(card,'Добавить в разбор').click());
    assert.equal(added.request().postDataJSON().caseId,fixture.caseId);
    await visible(pinned);
    await submit(admin,'pin-material',()=>role(card,'Добавлено · убрать с экрана').click());
    await pinned.waitFor({state:'detached'});
    await submit(admin,'pin-material',()=>role(card,'Добавить в разбор').click());
    await visible(pinned);
    await go(admin,'chats/'+thread);
    await card.locator('a').click();
    await visible(role(dialog,'Скопировать ссылку'));
    assert.equal(await pinActions(dialog).count(),0);
    await admin.keyboard.press('Escape');
    assert.equal(await pinActions(card).count(),0);

    await go(admin,sourceRoute);
    const activeMenu = admin.locator('.thread-row').filter({has:admin.locator('a[aria-current="page"]')});
    await activeMenu.hover();
    await activeMenu.locator('.thread-menu-trigger').click();
    await admin.getByRole('menuitem',{name:/Удалить/}).click();
    await submit(admin,'delete-thread',()=>role(admin.getByRole('dialog'),'Удалить чат').click());
    await go(admin,caseRoute);
    await pinned.click();
    await visible(admin.getByRole('dialog').locator('.material-detail'));
    await admin.keyboard.press('Escape');
    await go(admin,'chats/'+fixture.thread);
    await activeMenu.hover();
    await activeMenu.locator('.thread-menu-trigger').click();
    await admin.getByRole('menuitem',{name:/Удалить/}).click();
    await submit(admin,'delete-thread',()=>role(admin.getByRole('dialog'),'Удалить чат').click());
    await go(admin,'material/'+fixture.report);
    await admin.locator('a[href="#material/'+fixture.chart+'"]').click();
    await visible(admin.getByRole('dialog').locator('.range-plot svg'));
    assert.equal(await pinActions(admin.getByRole('dialog')).count(),0);
    await go(member,'material/'+fixture.chart);
    await visible(member.getByText('Снимок недоступен',{exact:false}).first());
    await go(admin,'chats/group');
    await field(admin,'Вопрос агенту').fill('Отчёт '+base+'/#material/'+fixture.report);
    await admin.getByRole('checkbox',{name:/Открыть участникам/}).check();
    await submit(admin,'say',()=>role(admin,'Написать команде').click());
    await admin.locator('.bubble.user .material-card a[href="#material/'+fixture.report+'"]').last().click();
    await visible(dialog.locator('.material-card.chart svg'));
    assert.equal(await pinActions(dialog).count(),0);
    await dialog.locator('a[href="#material/'+fixture.chart+'"]').click();
    await visible(dialog.locator('.range-plot svg'));
    assert.equal(await pinActions(dialog).count(),0);
    await go(member,'material/'+fixture.report);
    await member.locator('a[href="#material/'+fixture.chart+'"]').click();
    await visible(member.getByRole('dialog').locator('.range-plot svg'));
  });

  await journey('CSV import, release, saved calculation and dashboard in the same shell', async () => {
    await admin.goto(base+'/?legacy=1#releases');
    await visible(admin.locator('#workspace-sidebar'));
    await role(admin,'Импорт CSV').click();
    let dlg=admin.getByRole('dialog');
    await field(dlg,'Название набора').fill('События для приёмки');
    await field(dlg,'CSV с событиями').setInputFiles({
      name:'events.csv',mimeType:'text/csv',buffer:await readFile(new URL('../demo/events.csv',import.meta.url))
    });
    await field(dlg,'Данные полны по дату и время, МСК').fill('2026-11-23T10:00');
    await role(dlg,'Импортировать').click();
    await dlg.waitFor({state:'hidden'});
    await role(admin,'Добавить релиз').click();
    dlg=admin.getByRole('dialog');
    await field(dlg,'Набор данных').selectOption({label:'События для приёмки'});
    await field(dlg,'Название').fill('Релиз приёмки');
    await field(dlg,'Что изменилось').fill('Проверка счетов');
    await field(dlg,'Включение для пользователей, МСК').fill('2026-11-02T10:00');
    await field(dlg,'Аудитория').fill('Компании');
    await field(dlg,'Главный вопрос').fill('Сколько дней до оплаты?');
    await role(dlg,'Создать релиз').click();
    await visible(admin.getByRole('heading',{name:'Релиз приёмки',exact:true}));
    await admin.locator('summary').filter({hasText:/^Первый разбор · /}).waitFor({state:'attached'});
    await field(admin,'Спросить агента').fill('Сколько дней до оплаты? Построй график.');
    const [reply] = await Promise.all([
      admin.waitForResponse(r => r.url().endsWith('/api/chat')),
      role(admin,'Отправить вопрос').click(),
    ]);
    assert.ok(reply.ok(), await reply.text());
    assert.ok((await reply.json()).refs.some(ref => ref.op === 'build_chart'));
    await admin.getByRole('button',{name:/Раскрыть график/}).first().click();
    dlg=admin.getByRole('dialog');
    await field(dlg,'Дашборд релиза').fill('Проверенные расчёты');
    await role(dlg,'Сохранить в релиз').click();
    await visible(dlg.getByText('Сохранено',{exact:true}));
    const calc=await dlg.getByRole('link',{name:/Источник расчёта/}).getAttribute('href');
    await admin.keyboard.press('Escape');
    await dlg.waitFor({state:'hidden'});
    await field(admin,'Дашборд').selectOption('Проверенные расчёты');
    await visible(admin.getByRole('heading',{name:'Проверенные расчёты'}));
    await go(admin,calc.slice(1));
    await visible(admin.getByRole('heading',{name:'Сохранённый расчёт'}));
    await visible(admin.locator('#workspace-sidebar'));
    await member.goto(base+'/?legacy=1#release/R-001');
    await visible(member.locator('.report-head h1'));
    assert.equal(await role(member,'Импорт CSV').count(),0);
  });
  await journey('CSV release discussion shows the profile photo on confirmed own messages', async () => {
    const route = 'release/R-001';
    const profileRoute = 'profile';
    const question = 'Моя реплика в обсуждении CSV';
    const legacy = 'Старая реплика с такой же подписью';
    const store = app.space('team');
    const {context} = await (await member.request.get(base+'/api/report?releaseId=R-001')).json();
    store.addMessage('R-001', 'profile-test-legacy/q', {
      role:'user', author:'fixture-member', text:legacy, context, created:1,
    });
    const openDiscussion = async page => {
      await go(page, route);
      await role(page,'Обсуждение ›').click();
      return page.getByRole('complementary',{name:'Обсуждение релиза'});
    };
    const sidebarPhoto = page => page.getByRole('link',{name:'Профиль',exact:true}).locator('img');
    const locateMessage = (panel, text) => panel.getByRole('article').filter({hasText:text});
    const panel = await openDiscussion(member);
    await field(panel,'Спросить агента').fill(question);
    await panel.locator('button[aria-label="Отправить вопрос"]:enabled').waitFor();
    await Promise.all([
      member.waitForResponse(r => r.url().endsWith('/api/chat') && r.ok()),
      field(panel,'Спросить агента').press('Enter'),
    ]);
    await visible(locateMessage(panel, question));
    await go(member, profileRoute);
    await role(member,'Редактировать профиль').click();
    const portrait = await member.evaluate(() => {
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 8;
      const drawing = canvas.getContext('2d');
      drawing.fillStyle = '#236089';
      drawing.fillRect(0,0,8,8);
      return canvas.toDataURL().split(',')[1];
    });
    await member.getByLabel('Фото профиля',{exact:true}).setInputFiles({
      name:'csv-portrait.png', mimeType:'image/png', buffer:Buffer.from(portrait,'base64'),
    });
    await visible(member.getByRole('region',{name:'Учётная запись'}).locator('.profile-avatar img'));
    await role(member,'Сохранить профиль').click();
    await visible(sidebarPhoto(member));
    const photo = await sidebarPhoto(member).getAttribute('src');
    async function checkHistory(page, hasPhoto) {
      const discussion = await openDiscussion(page);
      await discussion.getByRole('button',{name:/Предыдущие сообщения/}).click();
      const own = locateMessage(discussion, question);
      const earlier = locateMessage(discussion, legacy);
      await visible(own.getByText('fixture-member',{exact:true}));
      await visible(earlier.getByText('fixture-member',{exact:true}));
      assert.equal(await earlier.locator('img').count(),0);
      if (hasPhoto) {
        await visible(own.locator('img'));
        assert.equal(await own.locator('img').getAttribute('src'),photo);
      } else {
        assert.equal(await own.locator('img').count(),0);
        assert.equal(await own.locator('.chat-avatar').textContent(),'FM');
      }
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await checkHistory(member, true);
    const loginMobile = () => login('member','#profile',{viewport:{width:390,height:844},colorScheme:'dark'});
    const again = await loginMobile();
    try {
      await checkHistory(again, true);
      await go(again, profileRoute);
      await role(again,'Редактировать профиль').click();
      await role(again,'Убрать фото').click();
      await submit(again,'profile',()=>role(again,'Сохранить профиль').click());
      await sidebarPhoto(again).waitFor({state:'hidden'});
      await checkHistory(again, false);
    } finally { await again.context().close(); }
    const withoutPhoto = await loginMobile();
    try { await checkHistory(withoutPhoto, false); }
    finally { await withoutPhoto.context().close(); }
    await member.reload();
    await visible(member.getByRole('link',{name:'Профиль',exact:true}));
  });
  await journey('CSV release keeps pending feedback visible while reading expanded history', async () => {
    const releaseId = 'R-001';
    const { context } = await (await admin.request.get(base+'/api/report?releaseId='+releaseId)).json();
    const store = app.space('team');
    for (let index = 0; index < 24; index++) {
      store.addMessage(releaseId, 'pending-feedback-'+index, {
        role:'user', author:'Участник', text:'Сохранённый вопрос '+index, context, created:index+1,
      });
    }
    const result = [];
    for (const width of [1440, 390]) {
      const page = await login('member','#release/'+releaseId,{viewport:{width,height:900}});
      try {
        if (width === 390) await role(page,'Обсуждение ›').click();
        const discussion = page.getByRole('complementary',{name:'Обсуждение релиза'});
        await discussion.getByRole('button',{name:/Предыдущие сообщения/}).click();
        const history = discussion.locator('.chat-history');
        assert.ok(await history.evaluate(list => list.scrollHeight > list.clientHeight * 2));
        await history.evaluate(list => { list.scrollTop = 0; });
        await field(discussion,'Спросить агента').fill('Проверка состояния отправки');

        const hold = Promise.withResolvers();
        await page.route('**/api/chat', async route => {
          await hold.promise;
          await route.continue();
        }, {times:1});
        const isReply = message => message.url().endsWith('/api/chat');
        const response = page.waitForResponse(isReply);
        const status = discussion.getByRole('status').filter({hasText:'Агент проверяет данные…'});
        try {
          await Promise.all([page.waitForRequest(isReply),role(discussion,'Отправить вопрос').click()]);
          await visible(status);
          const intersection = await status.evaluate(element => new Promise(resolve => {
            const observer = new IntersectionObserver(([entry]) => {
              observer.disconnect();
              resolve(entry.intersectionRatio);
            });
            observer.observe(element);
          }));
          result.push({width, inView:intersection >= 0.95, scrollTop:await history.evaluate(list => list.scrollTop)});
        } finally {
          hold.resolve();
          assert.ok((await response).ok());
        }
        await status.waitFor({state:'hidden'});
      } finally { await page.context().close(); }
    }
    assert.deepEqual(result, [
      {width:1440, inView:true, scrollTop:0},
      {width:390, inView:true, scrollTop:0},
    ]);
  });
  await journey('judge writes in an isolated demo and mobile attachment returns to its conversation', async () => {
    await go(judge,'overview');
    await judge.getByRole('link',{name:'Открыть разбор'}).first().click();
    await field(judge,'Заголовок').fill('Задача из пространства жюри');
    await submit(judge,'draft',()=>role(judge,'Подготовить черновик задачи').click());
    const draft = judge.locator('.tracker-preview').filter({hasText:'Задача из пространства жюри'});
    await submit(judge,'confirm',()=>role(draft,'Подтвердить запись').click());
    const link = draft.getByRole('link',{name:/Открыть задачу/});
    await visible(link);
    const href = await link.getAttribute('href');
    await link.click();
    await visible(judge.getByRole('heading',{name:'Задача из пространства жюри'}));
    await go(member,caseRoute);
    await role(member,'Обсудить').click();
    await visible(field(member,'Вопрос агенту'));
    await role(member,'К разбору').click();
    await visible(member.locator('.case-main'));
    await go(member,'material/'+fixture.chart);
    await visible(role(member,'Скопировать ссылку'));
    assert.equal(await pinActions(member).count(),0);
    await go(member,caseRoute);
    await role(member,'Обсудить').click();
    const {card} = await sendMaterialToCase(member,'#material/'+fixture.chart);
    await submit(member,'pin-material',()=>role(card,'Добавить в разбор').click());
    await role(member,'К разбору').click();
    await member.locator('.case-main a[href="#material/'+fixture.chart+'"]').click();
    const detail = member.getByRole('dialog');
    const intact = await detail.locator('td').evaluateAll(cells => cells
      .filter(cell => /^[-+]?\d+(?:[,.]\d+)?$/.test(cell.textContent.trim()))
      .every(cell => {
        const range=document.createRange();
        range.selectNodeContents(cell);
        return range.getClientRects().length <= 1;
      }));
    assert.ok(intact, 'Числа таблицы должны помещаться на одной строке');
    await role(detail,'Приложить к сообщению').click();
    await visible(member.locator('.chat-composer .range-attachment'));
    assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
    await go(admin,href.slice(1));
    // Separate demo databases can both allocate the same local issue number.
    assert.equal(await admin.getByRole('heading',{name:'Задача из пространства жюри'}).count(),0);
  });

  await journey('the same investigation shows the withdrawn signal and its source revisions', async () => {
    const store = app.space('team');
    const product = 'Команда проверки пересчёта';
    const file = 'BI · пересчёт.xlsx';
    const bin = env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3');
    async function upload(name, sheet, rows) {
      const xlsx = spawnSync(bin,['tests/research-workbooks.py','--xlsx',sheet],{
        input:JSON.stringify(rows),windowsHide:true,
      });
      if (xlsx.error) throw xlsx.error;
      assert.equal(xlsx.status,0,xlsx.stderr.toString());
      await go(admin,'sources');
      await admin.locator('input[type=file]').setInputFiles({
        name,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:xlsx.stdout,
      });
      const [response] = await submit(admin,'upload',()=>role(admin,'Загрузить и пересчитать').click());
      return response.json();
    }
    const sales = value => [
      ['product_family','week_start','orders_index'],
      [product,'2026-11-02',value],
      [product,'2026-11-09',value],
    ];
    await upload('BI · порог.xlsx','Метрики_справочник',[
      ['metric_id','bad_signal'],['family_orders_idx','Индекс ниже 90 две недели подряд'],
    ]);
    assert.equal((await upload(file,'Продажи',sales(70))).inserted,1);
    const {id} = store.db.prepare('SELECT id FROM cases WHERE product=?').get(product);
    await go(admin,'case/'+id);
    const investigation = admin.locator('.investigation-head');
    await visible(investigation.getByRole('heading', {level:1}).filter({hasText:product}));
    await visible(investigation.getByText('Команда',{exact:true}));
    const route = admin.url();
    assert.equal((await upload(file,'Продажи',sales(100))).inserted,1);
    assert.equal((await upload(file,'Продажи',sales(100))).inserted,0);
    await go(admin,'case/'+id);
    assert.equal(admin.url(),route);
    await visible(investigation.getByRole('status').filter({hasText:'Сигнал отозван после пересчёта'}));
    const history = admin.locator('.signal-history');
    await history.getByText('История сигнала',{exact:true}).click();
    const rows = history.locator('li');
    await visible(rows.first());
    assert.equal(await rows.count(),2);
    assert.match(await rows.nth(0).textContent(),/Отозван.*BI · пересчёт\.xlsx/);
    assert.match(await rows.nth(1).textContent(),/Подтверждён.*70 п\. индекса.*BI · пересчёт\.xlsx/);
    assert.notEqual(await rows.nth(0).locator('small').getAttribute('title'),await rows.nth(1).locator('small').getAttribute('title'));
  });

  await journey('ratio evidence points to the selected workbook revision', async () => {
    const store = app.space('team');
    const {user} = await app.accounts.login({login:'fixture-admin',password:'fixture-password'});
    const product = 'ЛК для проверки версий';
    const file = 'Проверка долей.xlsx', date = '2026-08-03', loc = 'Визиты и клики!B4';
    const load = (numerator, denominator) => {
      importDocs(store, [{file,facts:[
        {kind:'metrics',loc,row:{metric_id:'lk_reco_ctr',product,date,segment:'all',unit:'ratio',numerator,denominator,value:0.99}},
        {kind:'metrics',loc:'Охват!C7',row:{metric_id:'cfg_reach_rate',product,date,segment:'all',unit:'ratio',
          numerator:6,denominator:20,value:0.99}},
      ]}], {notify:false});
      return facts(store.db,'metrics').find(f => f.file === file && f.loc === loc).version;
    };
    const calculate = () => workspaceOperation(store,user,'view',{product,from:date,through:'2026-08-09',
      ratioSelections:{ctr:{product,segment:'all',sourceId:'office:'+file,definitionId:'office'}}}).view.id;
    const firstVersion = load(2,40), first = calculate();
    const route = 'snapshot/'+first+'/evidence,ctr,reach';
    const sources = admin.locator('.card-evidence').getByRole('button',{name:/^Метрики/});
    const openRatio = async (dialog, metric, value, target) => {
      const row = dialog.getByRole('row').filter({hasText:metric});
      await visible(row.getByRole('cell',{name:date,exact:true}));
      await visible(row.getByRole('cell',{name:value,exact:true}));
      const link = row.getByRole('link');
      assert.equal(await link.getAttribute('href'),target);
      return link;
    };
    const ctrSource = '#knowledge-source/'+firstVersion+'/'+encodeURIComponent(loc);
    await go(admin,route);
    await sources.click();
    const dialog = admin.getByRole('dialog');
    await openRatio(dialog,/CTR рекомендаций/,'5% (2 / 40)',ctrSource);
    await openRatio(dialog,/Охват/,'30% (6 / 20)',
      '#knowledge-source/'+firstVersion+'/'+encodeURIComponent('Охват!C7'));
    await admin.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});

    const secondVersion = load(0,0), second = calculate();
    assert.notEqual(secondVersion,firstVersion);
    await go(admin,'snapshot/'+second+'/evidence,ctr');
    await sources.click();
    await openRatio(dialog,/CTR рекомендаций/,'0 / 0','#knowledge-source/'+secondVersion+'/'+encodeURIComponent(loc));
    assert.equal(await dialog.getByRole('row').filter({hasText:/CTR рекомендаций/}).filter({hasText:'%'}).count(),0);
    await admin.keyboard.press('Escape');
    await dialog.waitFor({state:'hidden'});

    await go(admin,route);
    await admin.reload();
    await sources.click();
    const link = await openRatio(dialog,/CTR рекомендаций/,'5% (2 / 40)',ctrSource);
    await link.click();
    assert.equal(new URL(admin.url()).hash,ctrSource);
    await visible(admin.getByRole('heading',{name:file}));
    await visible(admin.getByText(new RegExp('Версия '+firstVersion.slice(0,12))));
    const cell = admin.locator('.excerpt').first();
    await visible(cell.getByText(loc,{exact:true}));
    await visible(cell.getByText(/numerator = 2 · denominator = 40/));
  });

  await journey('saved signal cites its own metric', async () => {
    const store = app.space('team');
    const {user} = await app.accounts.login({login:'fixture-admin',password:'fixture-password'});
    const product = 'ЛК для проверки сигнала', metric = 'lk_reco_ctr', releaseId = 'Релиз проверки сигнала';
    const file = 'Исходные наблюдения сигнала.xlsx';
    const week = index => new Date(Date.UTC(2026, 4, 4 + index * 7)).toISOString().slice(0,10);
    const loc = index => 'Наблюдения!A' + (index + 2);
    importDocs(store,[{file,facts:[
      {kind:'releases',loc:'Релизы!A2',row:{release_id:releaseId,release_date:week(4),product_family:product}},
      {kind:'sales',loc:'Индекс!A2',row:{week_start:week(1),product_family:product,orders_index:123}},
    ]}],{notify:false});
    saveMetricRule(store.db,{metric,product,releaseId,sourceId:'office:'+file});
    importDocs(store,[{file,facts:Array.from({length:6},(_, i) => ({
      kind:'metrics',loc:loc(i),row:{metric_id:metric,product,date:week(i),segment:'all',unit:'ratio',
        numerator:i < 4 ? 10 : 2,denominator:100,value:0.99},
    }))}],{notify:false});
    const version = facts(store.db,'metrics').find(f => f.file === file && f.loc === loc(5)).version;
    const {id:caseId} = store.db.prepare('SELECT id FROM cases WHERE product=?').get(product);
    const {view} = workspaceOperation(store,user,'view',{caseId});
    assert.equal(view.summary[0].rows[0].value,123);

    await go(admin,'snapshot/'+view.id+'/signal');
    await admin.reload();
    const proof = admin.locator('.card-signal details.proof');
    await proof.getByText('Источники и период',{exact:true}).click();
    const orderIndexRowsInSignalProof = await proof.locator('small').filter({hasText:/Индекс!A2/}).count();
    assert.equal(orderIndexRowsInSignalProof,0);
    await visible(proof.getByText('База до релиза',{exact:true}));
    await visible(proof.getByText('Неделя сигнала',{exact:true}));
    const latest = proof.locator('details').filter({hasText:'2 / 100'}).last();
    await latest.locator('summary').click();
    await visible(latest.getByText(new RegExp(week(5))));
    assert.equal(await latest.getByRole('link',{name:file+' · '+loc(5)}).getAttribute('href'),
      '#knowledge-source/'+version+'/'+encodeURIComponent(loc(5)));
  });

  await journey('CTR signal, absolute target and saved versions work through the browser and HTTP MCP', async () => {
    const store = app.space('team');
    const metric = 'lk_reco_ctr', product = 'ЛК проверки CTR', sourceId = 'fixture-ctr';
    const week = index => new Date(Date.UTC(2026, 5, 1 + index * 7)).toISOString().slice(0, 10);
    const rollout = week(6);
    const report = (i, segment, numerator, denominator = 100) => ({
      kind: 'metrics', loc: segment + '/' + week(i), row: {
        product, segment, date: week(i), source_id: sourceId, metric_id: metric, unit: 'ratio',
        numerator, denominator, value: 0.99,
      },
    });
    const load = facts => importDocs(store, [{file:'CTR для приёмки.xlsx',facts}], {notify:false});
    const releaseId = 'Размещение рекомендаций';
    load([{kind:'releases',loc:'A1',row:{release_id:releaseId,release_date:week(4),product_family:product}}]);
    saveMetricRule(store.db, {metric, product, sourceId, segment:'desktop', releaseId});
    load(Array.from({length:6}, (_, i) => [report(i, 'desktop', i < 4 ? 10 : 3), report(i, 'mobile', 8)]).flat());
    const autoCase = store.db.prepare("SELECT id FROM cases WHERE product=?").get(product).id;
    await go(admin,'settings');
    const monitored = admin.getByRole('region',{name:'Мониторинг продуктовых метрик'})
      .locator('details').filter({hasText:'CTR рекомендаций ЛК'});
    await visible(monitored.getByText('Отклонение подтверждено',{exact:true}));
    await visible(monitored.locator('summary').getByText(/Размещение рекомендаций · /));
    await visible(monitored.getByText('Последняя проверенная неделя',{exact:true}));
    await go(admin,'cases');
    await admin.locator('a[href="#case/' + autoCase + '"]').click();
    await admin.locator('.card-evidence').getByRole('button',{name:/^Метрики/}).click();
    const metricSources = admin.getByRole('dialog');
    await visible(metricSources.getByRole('cell',{name:/^CTR рекомендаций/}).first());
    await visible(metricSources.getByRole('cell',{name:'CTR для приёмки.xlsx · desktop/' + week(0),exact:true}).first());
    await admin.keyboard.press('Escape');
    await metricSources.waitFor({state:'hidden'});
    const panel = admin.locator('.effect-panel');
    await panel.locator(':scope > summary').click();
    await panel.getByText('Базовый период и контроль', {exact:true}).click();
    await field(panel,'Дата выкладки').fill(rollout);
    await field(panel,'Целевое значение, %').fill('5');
    await field(panel,'Контрольный продукт').fill(product);
    await field(panel,'Сегмент контроля').fill('mobile');
    const [scheduled] = await submit(admin,'watch',()=>role(panel,'Назначить проверку').click());
    const first = await scheduled.json();
    assert.equal(first.target,5);
    assert.equal(first.unit,'%');
    assert.equal(first.actual,null);
    assert.equal(first.revision,1);
    await visible(panel.getByText('Недостаточно данных',{exact:true}));
    assert.equal(await admin.locator('.card-trend').count(),0);

    const keyResponse = await admin.request.post(base+'/api/team/mcp-key',{data:{}});
    assert.ok(keyResponse.ok());
    const {key} = await keyResponse.json();
    const mcp = new Client({name:'ctr-browser-test',version:'1'});
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{
        requestInit:{headers:{Authorization:'Bearer '+key}},
      }));
      async function call(name, args) {
        const result = await mcp.callTool({name,arguments:args});
        assert.ok(!result.isError, result.content[0].text);
        return JSON.parse(result.content[0].text);
      }
      const missing = Array.from({length:4}, (_, j) =>
        [report(j+6,'desktop',5,j === 3 ? null : 100), report(j+6,'mobile',8)]).flat();
      load(missing);
      assert.match((await call('view',{caseId:autoCase})).effect.reason,/знаменател/);
      load([report(9,'desktop',5)]);
      const args = {caseId:autoCase};
      const achieved = await call('view',args);
      assert.deepEqual([achieved.effect.actual, achieved.effect.ctrl], [5, 0]);
      assert.deepEqual([achieved.effect.sample.n, achieved.effect.sample.d], [20, 400]);
      assert.equal(achieved.case.body.watch.measurement.definitionId,'office');
      const historical = await call('view',{...args, through:week(9)});
      assert.equal(historical.effect.actual,null);
      assert.equal(historical.effect.weeks,3);
      await admin.reload();
      await panel.locator(':scope > summary').click();
      await visible(panel.getByText('Цель достигнута',{exact:true}));
      await visible(panel.getByText('≥ 5 / 5',{exact:true}));

      const revised = await call('watch',{...args,deployed:rollout,measurement:{
        metric,comparison:'gte',targetMode:'absolute',targetValue:6,control:product,controlSegment:'mobile',
      }});
      assert.equal(revised.revision,2);
      assert.equal(revised.state,'Цель не достигнута');
      const updated = await call('view',args);
      const [{calc}] = updated.case.body.watchHistory;
      assert.equal((await call('calc',{id:calc})).monitoring.result.target,5);
      assert.equal((await call('calc',{id:achieved.view.id})).monitoring.result.state,'Цель достигнута');
      await admin.reload();
      await panel.locator(':scope > summary').click();
      await visible(panel.getByText('Цель не достигнута',{exact:true}));
      await panel.getByText('Прошлые проверки',{exact:true}).click();
      await panel.getByRole('link',{name:'Версия 1 · '+rollout}).click();
      await visible(admin.locator('.card-watch').getByText('Цель достигнута',{exact:true}));

      await go(admin,'cases');
      await role(admin,'Новый разбор').click();
      const editor = admin.locator('form').filter({has:role(admin,'Создать личный разбор')});
      await field(editor,'Вопрос или гипотеза').fill('Гипотеза с критерием до выкладки');
      await field(editor,'Продукт').fill(product);
      await editor.getByText('Гипотеза и критерии до разработки',{exact:true}).click();
      await field(editor,'Целевая метрика').selectOption(metric);
      await field(editor,'Сегмент ряда').fill('desktop');
      await field(editor,'Целевое значение, %').fill('5');
      const [created] = await submit(admin,'create-case',()=>role(editor,'Создать личный разбор').click());
      const {id} = await created.json();
      const personal = await call('watch',{caseId:id,deployed:rollout});
      assert.equal(personal.state,'Цель достигнута');
      assert.equal(personal.actual,5);
    } finally {
      await mcp.close();
    }
  });

  await journey('scenario drafts stay editable and isolated until explicitly sent', async () => {
    const labels = ['Найти упущенный спрос', 'Выбрать, что проверить сегодня', 'Найти потери в воронке',
      'Проверить гипотезу', 'Проверить эффект релиза'];
    const detail = 'Только Kaspersky, мобильные, октябрь';
    const menu = p => p.getByRole('menu', { name:'Сценарии' });
    const trigger = p => role(p, 'Сценарии');
    const input = p => field(p, 'Вопрос агенту');
    async function choose(p, index) {
      await trigger(p).click();
      await menu(p).getByRole('menuitem', {name:labels[index], exact:true}).click();
      assert.ok(await input(p).evaluate(el =>
        el === document.activeElement && el.selectionStart === el.value.length && el.selectionEnd === el.value.length));
    }
    const requests = [];
    const record = r => { if (/\/api\/team\/(ask|say)$/.test(r.url())) requests.push(r.postDataJSON()); };
    admin.on('request', record);
    member.on('request', record);
    try {
      await go(admin, 'chats/group');
      await role(admin, 'Новый чат').click();
      await field(admin, 'Название').fill('Приёмка сценариев');
      await role(admin, 'Создать').click();
      await visible(admin.getByRole('heading', {name:'Приёмка сценариев'}));
      const privateRoute = admin.url().split('#')[1];
      await input(admin).fill(detail);
      for (const index of [0, 1, 2]) await choose(admin, index);
      const draft = await input(admin).inputValue();
      assert.match(draft, /^Проверь воронку подбора/);
      assert.equal(draft.split('\n\n').at(-1), detail);
      assert.equal(draft.split(detail).length, 2);
      await go(admin, 'chats/group');
      await go(admin, privateRoute);
      assert.equal(await input(admin).inputValue(), draft);
      await choose(admin, 3);
      const rewrite = (await input(admin).inputValue()).replace('Проверь гипотезу', 'Оцени эту гипотезу');
      await input(admin).fill(rewrite);
      await choose(admin, 3);
      assert.equal(await input(admin).inputValue(), rewrite);
      await admin.reload();
      await choose(admin, 4);
      const final = await input(admin).inputValue();
      assert.ok(final.startsWith('Сравни целевую метрику') && final.endsWith('\n\n' + rewrite));
      assert.deepEqual(requests, []);
      await submit(admin, 'ask', () => input(admin).press('Enter'));
      assert.deepEqual(requests.map(r => r.question), [final]);

      await go(member, 'chats/group');
      const attached = 'Источник ' + base + '/#material/' + fixture.report;
      await input(member).fill(attached);
      await visible(member.locator('.chat-composer .range-attachment'));
      await trigger(member).focus();
      await member.keyboard.press('ArrowDown');
      const items = menu(member).getByRole('menuitem');
      assert.deepEqual(await items.allTextContents(), labels);
      assert.ok(await items.evaluateAll(els => els.every(el => {
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      })));
      await member.keyboard.press('Escape');
      assert.ok(await trigger(member).evaluate(el => el === document.activeElement));
      assert.equal(await input(member).inputValue(), attached);
      await trigger(member).press('ArrowUp');
      await member.keyboard.press('Enter');
      const groupDraft = await input(member).inputValue();
      assert.ok(groupDraft.startsWith('Сравни целевую метрику') && groupDraft.endsWith(attached));
      await visible(member.locator('.chat-composer .range-attachment'));
      // Both users must share the same tab storage for this to test account isolation.
      async function switchAccount(user) {
        await admin.getByRole('link',{name:'Профиль',exact:true}).click();
        await role(admin, 'Выйти').click();
        await field(admin, 'Логин').fill('fixture-' + user);
        await field(admin, 'Пароль').fill('fixture-password');
        await role(admin, 'Войти').click();
        await visible(admin.getByRole('link',{name:'Профиль',exact:true}));
        await go(admin, 'chats/group');
        await visible(input(admin));
      }
      await go(admin, 'chats/group');
      await input(admin).fill('Уточнение администратора');
      await choose(admin, 1);
      const adminDraft = await input(admin).inputValue();
      await switchAccount('member');
      assert.equal(await input(admin).inputValue(), '');
      await input(admin).fill('Уточнение участника');
      await switchAccount('admin');
      assert.equal(await input(admin).inputValue(), adminDraft);
      await choose(admin, 2);
      assert.deepEqual((await input(admin).inputValue()).split('\n\n').slice(1), ['Уточнение администратора']);
      await switchAccount('member');
      assert.equal(await input(admin).inputValue(), 'Уточнение участника');
      assert.equal(requests.length, 1);
      await submit(member, 'ask', () => role(member, 'Спросить помощника').click());
      assert.equal(requests.length, 2);
      assert.deepEqual(requests[1].materialIds, [fixture.report]);
      assert.equal(requests[1].question, groupDraft);
    } finally {
      admin.off('request', record);
      member.off('request', record);
    }
  });
  await journey('personal investigation cards, filters and control survive reload, navigation and account changes', async () => {
    const store = app.space('team');
    const caseId = 'personal-view-case', otherId = 'personal-view-other';
    const title = 'Проверка личного вида', otherTitle = 'Соседний разбор личного вида';
    const defaults = ['summary','trend','evidence','timeline','backlog'];
    const control = 'Zebra';
    importDocs(store, [{ file:'Personal view.xlsx', facts: [
      { kind:'sales', loc:'Продажи!A2', row:{product_family:control,week_start:'2026-09-07',orders_index:85} },
      { kind:'interview', loc:'Интервью!A2', text:'Kaspersky · синтетический источник о переносе лицензии.' },
    ] }], { notify:false });
    const insertCase = store.db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)');
    insertCase.run(caseId,'Kaspersky',title,'Исследуем','{}');
    insertCase.run(otherId,'Kaspersky',otherTitle,'Исследуем','{}');

    const page = await login('admin','#cases');
    const post = async (op, data={}) => {
      const response = await page.request.post(base+'/api/team/'+op,{data});
      assert.ok(response.ok(),op + ' ' + response.status());
      return response.json();
    };
    const user = (await post('overview')).user;
    const key = 'pm-view/'+user.id+'/'+caseId;
    const viewRequest = (id, match=()=>true) => page.waitForResponse(r =>
      r.url().endsWith('/api/team/view') && r.ok() &&
      r.request().postDataJSON()?.caseId === id && match(r.request().postDataJSON()));
    const completeAnswer = async response => {
      const {id} = await response.json();
      const status = store.db.prepare('SELECT status, result FROM jobs WHERE id=?');
      while (status.get(id)?.status === 'queued')
        await workJobs(store,app.accounts,{...fixtureEnv,DATA_PROFILE:'local'},transport);
      const job = status.get(id);
      assert.equal(job?.status,'done',job?.result);
      return JSON.parse(job.result);
    };
    const open = async (id, name) => {
      const [response] = await Promise.all([
        viewRequest(id),
        page.locator('a[href="#case/'+id+'"]').first().click(),
      ]);
      await visible(page.getByRole('heading',{name,exact:true}));
      return response;
    };
    const backToCases = () => page.getByRole('link',{name:'← Разборы',exact:true}).click();
    const card = name => page.locator('.case-main .card-'+name);
    const cardOrder = () => page.locator('.case-main .analysis-card').evaluateAll(elements =>
      elements.map(element => [...element.classList].find(name => name.startsWith('card-')).slice(5)));
    const full = field(page,'Только полные недели');
    const peer = field(page,'Контроль');
    const sourceQuestion = 'Покажи источники о переносе лицензии' + ' и соответствующие детали'.repeat(18);
    const query = sourceQuestion.slice(0,400);
    const fields = response => {
      const { control, sourceQuery, full } = response.request().postDataJSON();
      return {control,sourceQuery,full};
    };
    const expected = {control,sourceQuery:query,full:true};
    const initial = {control:undefined,sourceQuery:'',full:false};

    await open(caseId,title);
    assert.equal(await peer.locator('option').nth(1).textContent(),control);
    await Promise.all([viewRequest(caseId,v => v.control === control), peer.selectOption(control)]);
    await role(card('trend'),'Закрепить').click();
    await field(page,'Вопрос агенту').fill(sourceQuestion);
    const [sources] = await submit(page,'ask',()=>role(page,'Отправить').click());
    const filtered = page.waitForResponse(r => {
      if (!r.url().endsWith('/api/team/view')) return false;
      const args = r.request().postDataJSON();
      return args?.caseId === caseId && !!args.sourceQuery;
    });
    await completeAnswer(sources);
    const fromSources = await filtered;
    assert.ok(fromSources.ok(),await fromSources.text());
    assert.equal(fields(fromSources).sourceQuery,query);
    const storedQuery = await page.evaluate(key => JSON.parse(localStorage.getItem(key)).sourceQuery,key);
    assert.equal(storedQuery,query);
    await visible(card('evidence'));
    await role(card('evidence'),'Закрепить').click();
    await Promise.all([viewRequest(caseId,v => v.full === true),full.check()]);
    assert.deepEqual(await cardOrder(),['trend','evidence']);
    await visible(role(card('evidence'),'Открепить'));

    // Earlier versions may have already stored the unbounded chat filter.
    await page.evaluate(({key,sourceQuestion}) => {
      const saved = JSON.parse(localStorage.getItem(key));
      localStorage.setItem(key,JSON.stringify({...saved,sourceQuery:sourceQuestion}));
    },{key,sourceQuestion});
    const [reloaded] = await Promise.all([viewRequest(caseId), page.reload()]);
    assert.deepEqual(fields(reloaded),expected);
    const saved = (await reloaded.json()).view;
    const {id:calcId,...calculation} = saved;
    assert.equal(saved.summary[1].product,control);
    assert.equal(saved.full,true);
    assert.ok(saved.evidence.some(row => row.file === 'Personal view.xlsx'));
    assert.deepEqual(await post('calc',{id:calcId}),calculation);
    const {key:mcpKey} = await post('mcp-key');
    const connection = new Client({name:'personal-view-acceptance',version:'1'});
    try {
      await connection.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{
        requestInit:{headers:{Authorization:'Bearer '+mcpKey}},
      }));
      const call = async (name,args) => {
        const result = await connection.callTool({name,arguments:args});
        assert.ok(!result.isError,result.content[0].text);
        return JSON.parse(result.content[0].text);
      };
      assert.deepEqual(await call('calc',{id:calcId}),calculation);
      assert.deepEqual(await call('analyze_case',{caseId,...expected}),saved);
    } finally { await connection.close(); }

    await visible(role(card('trend'),'Открепить'));
    assert.deepEqual(await cardOrder(),['trend','evidence']);
    await backToCases();
    assert.deepEqual(fields(await open(otherId,otherTitle)),initial);
    assert.deepEqual(await cardOrder(),defaults);
    await backToCases();
    assert.deepEqual(fields(await open(caseId,title)),expected);

    async function switchAccount(user) {
      await page.getByRole('link',{name:'Профиль',exact:true}).click();
      await role(page,'Выйти').click();
      await field(page,'Логин').fill('fixture-'+user);
      await field(page,'Пароль').fill('fixture-password');
      await role(page,'Войти').click();
      await go(page,'cases');
    }
    await switchAccount('member');
    assert.deepEqual(fields(await open(caseId,title)),initial);
    assert.deepEqual(await cardOrder(),defaults);
    await switchAccount('admin');
    assert.deepEqual(fields(await open(caseId,title)),expected);
    await visible(role(card('evidence'),'Открепить'));

    // A response already in flight cannot restore an earlier calculation after a saved revision.
    const captured = Promise.withResolvers(), release = Promise.withResolvers();
    const viewUrl = '**/api/team/view';
    const isEarlier = args => args.caseId === caseId && args.control === control && !args.full;
    const delayEarlier = async route => {
      if (!isEarlier(route.request().postDataJSON())) return route.continue();
      const response = await route.fetch();
      captured.resolve();
      await release.promise;
      await route.fulfill({response});
    };
    await page.route(viewUrl,delayEarlier);
    try {
      await full.uncheck();
      await captured.promise;
      workspaceOperation(store,user,'set_view',{caseId,control:'Astra',full:true,cards:['summary'],pin:true});
      const [latest] = await Promise.all([
        viewRequest(caseId,v => v.control === 'Astra' && v.full),
        peer.selectOption('Astra'),
      ]);
      assert.deepEqual(fields(latest),{...expected,control:'Astra'});
      const {id:latestId} = (await latest.json()).view;
      const latestSnapshot = card('summary').locator('a[href="#snapshot/'+latestId+'"]').first();
      await latestSnapshot.waitFor({state:'attached'});
      const delivered = viewRequest(caseId,isEarlier);
      release.resolve();
      await (await delivered).finished();
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      assert.equal(await latestSnapshot.count(),1);
      assert.deepEqual(await cardOrder(),['trend','evidence','summary']);
      await visible(role(card('summary'),'Открепить'));
      const [confirmed] = await Promise.all([viewRequest(caseId),page.reload()]);
      assert.deepEqual(fields(confirmed),{...expected,control:'Astra'});
    } finally {
      release.resolve();
      await page.unroute(viewUrl,delayEarlier);
    }

    // The chat still answers against the submitted calculation while the personal view can change.
    await field(page,'Вопрос агенту').fill('Сравни продажи Kaspersky');
    const [sales] = await submit(page,'ask',()=>role(page,'Отправить').click());
    const [manual] = await Promise.all([viewRequest(caseId,v => !v.full),full.uncheck()]);
    const selection = {...expected,control:'Astra',full:false};
    assert.deepEqual(fields(manual),selection);
    const answer = await completeAnswer(sales);
    assert.equal(answer.full,true,JSON.stringify(answer));
    assert.deepEqual(answer.cards,['summary','trend']);
    const reply = page.locator('.bubble.assistant').filter({hasText:answer.text.split('\n')[0]});
    await visible(reply);
    assert.equal(await full.isChecked(),false);
    assert.equal(answer.sourceQuery,undefined);
    const [afterSales] = await Promise.all([viewRequest(caseId),page.reload()]);
    assert.deepEqual(fields(afterSales),selection);
    await visible(role(card('evidence'),'Открепить'));
    await visible(reply);

    // An explicitly requested full-week calculation may still update the filter.
    await field(page,'Вопрос агенту').fill('Сравни продажи только за полные недели');
    const [onlyFull] = await submit(page,'ask',()=>role(page,'Отправить').click());
    const explicitlyFiltered = viewRequest(caseId,v => v.full);
    await completeAnswer(onlyFull);
    assert.deepEqual(fields(await explicitlyFiltered),{...selection,full:true});

    await role(page,'Сбросить вид').click();
    const [reset] = await Promise.all([viewRequest(caseId),role(page.getByRole('dialog'),'Сбросить').click()]);
    assert.deepEqual(fields(reset),initial);
    assert.deepEqual(await cardOrder(),defaults);

    // Old records can omit newer fields. A later edit fills only its own field.
    await page.evaluate(key => localStorage.setItem(key,JSON.stringify({cards:['evidence','trend'],pinned:['trend']})),key);
    const [legacy] = await Promise.all([viewRequest(caseId),page.reload()]);
    assert.deepEqual(fields(legacy),initial);
    await visible(role(card('trend'),'Открепить'));
    await Promise.all([viewRequest(caseId,v => v.control === control),peer.selectOption(control)]);
    const [legacyReloaded] = await Promise.all([viewRequest(caseId),page.reload()]);
    assert.deepEqual(fields(legacyReloaded),{...initial,control});
    await visible(role(card('trend'),'Открепить'));
    assert.deepEqual(await cardOrder(),['evidence','trend']);

    await page.evaluate(key => {
      localStorage.setItem(key,'{broken');
      localStorage.setItem(key+'/period',JSON.stringify({from:'2026-02-30',through:20261001}));
      localStorage.setItem(key+'/metric-series',JSON.stringify({ctr:{product:'Kaspersky'},reach:'obsolete'}));
    },key);
    const [corrupt] = await Promise.all([
      page.waitForResponse(r => r.url().endsWith('/api/team/view') && r.request().postDataJSON()?.caseId === caseId),
      page.reload(),
    ]);
    assert.ok(corrupt.ok(),await corrupt.text());
    assert.deepEqual(fields(corrupt),initial);
    const {from,through,ratioSelections} = corrupt.request().postDataJSON();
    assert.deepEqual({from,through,ratioSelections},{from:undefined,through:undefined,ratioSelections:{}});
    await visible(card('summary'));
    assert.deepEqual(await cardOrder(),defaults);
  });
  assert.deepEqual(errors,[]);
});
