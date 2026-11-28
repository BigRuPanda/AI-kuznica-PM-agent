import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createTeamApp } from '../server/team-http.mjs';
import { getCase, updateCase } from '../server/evidence.mjs';
import { fixtureEnv, seedWorkspace } from './workspace-fixture.mjs';
import { seedReleaseMetrics } from './release-metrics-fixture.mjs';

test('PM reads a progressing investigation, traces its evidence and publishes a chosen alternative', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'investigation-ui-'));
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const { caseId } = await seedWorkspace(dir);
  app = createTeamApp({ base: join(dir, 'releases.sqlite'), env: fixtureEnv, background: false });
  await new Promise((ok, fail) => app.server.once('error', fail).listen(0, '127.0.0.1', ok));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ headless: true, executablePath:
    process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  page.setDefaultTimeout(7500);
  const login = await page.request.post(base + '/api/team/login', {
    data: { login: 'fixture-admin', password: 'fixture-password' },
  });
  const { id: owner } = await login.json();
  const check = { role: 'analyst', question: 'Изменился ли контроль?', status: 'done',
    result: 'У контроля рост 3%.', impact: 'Общий спад маловероятен.',
    sources: [{ label: 'Продажи · Astra', calcId: 'test-calc', findingId: 'control' }] };
  const result = { summary: 'У продукта индекс снизился на 34%.', action: 'Сопоставить корзину с событием.',
    plan: 'Пройти покупку.', outcomes: ['Если событие потерялось, дополнить задачу.'],
    hypotheses: [{ title: 'Потеря события', for: ['В справочнике есть ограничение.'],
      against: ['Есть зарегистрированные события.'], test: 'Пройти покупку до корзины.' }] };
  const ready = { id: 'root', caseId, owner: null, mode: 'roles', revision: 2, status: 'ready', checks: [check],
    period: 'Полные недели июня – ноября', unit: 'п. индекса', calcId: 'test-calc', result };
  const history = [{ ...ready, id: 'previous', revision: 1, status: 'superseded', result: {
    ...result, summary: 'Вывод по предыдущему сигналу.',
  } }];
  let bundle = { current: { ...ready, status: 'running', result: null, summary: 'Измерен недельный индекс.' }, alternatives: [], history };
  await page.route('**/api/team/view', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), investigation: bundle } });
  });
  await page.route('**/api/team/investigation-status', route => route.fulfill({ json: bundle }));
  await page.route('**/api/team/investigation-alternative', async route => {
    const body = route.request().postDataJSON();
    assert.equal(body.parentId, ready.id);
    assert.ok(body.requestId);
    assert.equal(body.caseId, caseId);
    bundle.alternatives = [{ ...ready, id: 'private', owner, parentId: ready.id, question: body.question,
      published: false, result: { ...result, action: 'Сверить путь на телефоне.' } }];
    await route.fulfill({ json: { id: 'private' } });
  });
  await page.route('**/api/team/investigation-publish', async route => {
    assert.deepEqual(route.request().postDataJSON(), { caseId, id: 'private' });
    bundle.alternatives[0].published = true;
    await route.fulfill({ json: { id: 'private' } });
  });
  await page.route('**/api/team/calc', async route => {
    if (route.request().postDataJSON().id !== 'test-calc') return route.continue();
    await route.fulfill({ json: { kind: 'investigation-calculation', title: 'Расчёт расследования',
      period: ready.period, unit: ready.unit, summary: result.summary, findings: [
        { id: 'control', kind: 'control', label: 'Продажи · Astra', text: check.result, rows: [
          { date: '2026-10-05', value: 103, source: 'Продажи!B3', version: 'v17' },
        ] },
      ] } });
  });
  bundle.current.status = 'retry';
  bundle.current.automaticRetries = false;
  bundle.current.stages = [{role:'researcher',status:'retry',attempt:2,reason:'Модель не успела ответить вовремя.',canRetry:true}];
  let retries=0;
  await page.route('**/api/team/investigation-retry-stage',async route=>{
    assert.deepEqual(route.request().postDataJSON(),{caseId,runId:'root',role:'researcher',attempt:2});
    retries++;
    bundle.current.status = 'queued';
    bundle.current.stages=[{role:'researcher',status:'queued',attempt:2,canRetry:false}];
    await route.fulfill({json:bundle.current});
  });
  const visit = () => page.goto(base + '/#case/' + caseId);
  await visit();
  await page.getByText('Измерен недельный индекс.', { exact: true }).waitFor();
  assert.equal(await page.locator('.investigation-checks').evaluate(el=>el.open),false);
  await page.getByText('Модель не успела ответить вовремя.',{exact:true}).waitFor();
  await page.getByText('Требуется ручной повтор',{exact:true}).waitFor();
  await page.getByRole('button',{name:'Повторить ИИ-проверку',exact:true}).click();
  await page.getByRole('button',{name:'Повторить ИИ-проверку',exact:true}).waitFor({state:'detached'});
  assert.equal(retries,1);
  bundle.current = ready;
  const plan = page.getByText('Посмотреть план проверки', { exact: true });
  await plan.waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.getByText('Как проверяли', { exact: true }).click();
  await page.getByText(check.question, { exact: true }).click();
  await page.getByText(check.impact, { exact: true }).waitFor();
  await page.getByText(result.hypotheses[0].title, { exact: true }).click();
  await page.getByText(result.hypotheses[0].against[0], { exact: true }).waitFor();
  await page.getByRole('link', { name: check.sources[0].label, exact: true }).click();
  assert.ok(page.url().endsWith('#snapshot/test-calc/control'));
  await page.getByText('Продажи!B3', { exact: true }).waitFor();
  await visit();
  await page.getByRole('button', { name: 'Проверить другую версию' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Вопрос для проверки').fill('Влияет ли устройство?');
  await dialog.getByRole('button', { name: 'Начать проверку' }).click();
  await page.getByText('Сверить путь на телефоне.', { exact: true }).waitFor();
  await page.getByRole('button', { name: 'Опубликовать для команды' }).click();
  await page.getByText('Опубликовано для команды', { exact: true }).waitFor();
  await page.getByText('История исследований', { exact: true }).click();
  const archive = page.getByRole('group').filter({ has: page.getByText('История исследований', { exact: true }) }).first();
  await archive.locator('details > summary').last().click();
  await archive.getByText('Вывод по предыдущему сигналу.', { exact: true }).waitFor();
  assert.equal(await archive.getByRole('button').count(), 0);

  const db = app.space('team').db;
  const observed = getCase(db, caseId);
  observed.state = 'Наблюдаем эффект';
  updateCase(db, observed);
  await page.reload();
  const showEffect = page.getByRole('button', { name: 'Посмотреть результат проверки эффекта', exact: true });
  assert.equal(await showEffect.getAttribute('title'), null);
  seedReleaseMetrics(app.space('team'));
  observed.body.release = 'R-002';
  updateCase(db, observed);
  await page.reload();
  assert.equal(await showEffect.getAttribute('title'), 'Открыть результаты проверки эффекта.');
});
