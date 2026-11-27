import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { readInvestigations } from '../server/case-investigations.mjs';
import { cases, importDocs } from '../server/evidence.mjs';
import { captureInvestigation } from '../server/investigation-engine.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { fixtureEnv, seedWorkspace } from './workspace-fixture.mjs';
import { seedWatchFormats } from './watch-fixture.mjs';

test('the PM agrees an automatic signal criterion before scheduling a rollout watch', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'investigation-measurement-ui-'));
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await seedWorkspace(dir);
  app = createTeamApp({ base: join(dir, 'releases.sqlite'), env: fixtureEnv, background: false });
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const { db } = app.space('team');
  const c = cases(db).find(c => c.product === 'Kaspersky' && c.body.signal?.rule === 'relative' &&
    c.body.signal.source?.startsWith('Synthetic evaluation'));
  assert.ok(c);
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ headless: true, executablePath:
    process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined) });
  const page = await browser.newPage({ locale: 'ru-RU', viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(10000);
  const login = await page.request.post(base + '/api/team/login', {
    data: { login: 'fixture-admin', password: 'fixture-password' },
  });
  assert.ok(login.ok());
  const pm = await login.json();
  const run = readInvestigations(db, pm, c.id).current;
  const capture = captureInvestigation(db, run);
  db.prepare("UPDATE case_investigations SET status='ready',capture=?,result=? WHERE id=?")
    .run(JSON.stringify(capture), JSON.stringify({
      summary: 'Индекс заказов снизился.', action: 'Проверить оформление заказа.',
      plan: 'Пройти оформление заказа и подтвердить исправление.', outcomes: ['Заказ оформлен.'], hypotheses: [],
    }), run.id);

  await page.goto(base + '/#case/' + c.id);
  await page.getByText('Посмотреть план проверки', { exact: true }).click();
  const editor = page.locator('.investigation-measurement');
  assert.equal(await editor.getByLabel('Контрольный продукт').inputValue(), 'Astra');
  assert.equal(await editor.getByLabel('Начало базы').inputValue(), '2026-06-29');
  assert.equal(await editor.getByLabel('Конец базы').inputValue(), '2026-09-27');
  await editor.getByLabel('Целевое значение, %').fill('98');
  const approved = page.waitForResponse(response => response.url().endsWith('/api/team/investigation-measurement'));
  await editor.getByRole('button', { name: 'Согласовать критерий' }).click();
  const agreement = await approved;
  assert.ok(agreement.ok(), await agreement.text());
  await editor.getByText(/≥ 98 % от базы/).waitFor();
  assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  const effect = page.locator('.effect-panel');
  await effect.locator(':scope > summary').click();
  await effect.getByLabel('Дата выкладки').fill('2026-12-07');
  const watched = page.waitForResponse(response => response.url().endsWith('/api/team/watch'));
  await effect.getByRole('button', { name: 'Назначить проверку' }).click();
  const watch = await watched;
  assert.ok(watch.ok(), await watch.text());
  assert.equal(watch.request().postDataJSON().agreementId, (await agreement.json()).agreement.id);
  await effect.getByText('Ожидаем данные после исправления', { exact: true }).waitFor();
  await effect.getByText('Полные недели, продукт / контроль', { exact: true }).waitFor();
  assert.equal(await page.getByRole('button', { name: 'Изменить критерий' }).count(), 0);
});

test('saved percentage, KPI and archive watches reopen their own screens after a server restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'saved-watch-ui-'));
  const env = { ...fixtureEnv, SOURCE_ARCHIVE_SHA256: 'fixture' };
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  await seedWorkspace(dir);
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ headless: true, executablePath:
    process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined) });
  const page = await browser.newPage({ locale: 'ru-RU', viewport: { width: 390, height: 844 } });
  page.setDefaultTimeout(10000);
  async function start() {
    app = createTeamApp({ base: join(dir, 'releases.sqlite'), env, background: false });
    await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const login = await page.request.post(base + '/api/team/login', {
      data: { login: 'fixture-admin', password: 'fixture-password' },
    });
    assert.ok(login.ok(), await login.text());
    return base;
  }
  const effect = page.locator('.effect-panel');
  async function inspect(base, id) {
    const archive = id === 'saved-observation';
    await page.goto(base + '/#case/' + id + (archive ? '/effect' : ''));
    if (archive) {
      await effect.getByText('Изменился контроль — требуется проверка', { exact: true }).waitFor();
      assert.equal(await effect.locator(':scope > summary').evaluate(el => el === document.activeElement), true);
      await effect.getByText('Уточнить причину изменения контроля', { exact: true }).waitFor();
      await effect.getByRole('button', { name: 'Рассчитать без сохранения' }).waitFor();
      assert.equal(await effect.getByRole('button', { name: 'Назначить проверку' }).count(), 0);
      await effect.getByText('Исходные строки', { exact: true }).last().click();
      await effect.getByRole('link', { name: 'SavedWatches.xlsx · Control!A6' }).waitFor();
    } else {
      await effect.locator(':scope > summary').click();
      await effect.getByText('Цель достигнута', { exact: true }).waitFor();
      await effect.getByRole('button', { name: 'Назначить проверку' }).waitFor();
      assert.equal(await effect.getByRole('button', { name: 'Рассчитать без сохранения' }).count(), 0);
      if (id === 'saved-measurement') assert.match(await effect.innerText(), /168\s*\/\s*2\s*800/);
      else await effect.getByText('Полные недели, продукт / контроль', { exact: true }).waitFor();
    }
  }
  let base = await start();
  seedWatchFormats(app.space('team'));
  for (const id of ['saved-percent', 'saved-measurement', 'saved-observation']) await inspect(base, id);
  await app.close();
  app = undefined;
  base = await start();
  for (const id of ['saved-percent', 'saved-measurement', 'saved-observation']) await inspect(base, id);

  const store = app.space('team'), product = 'Astra Linux';
  const { cursor } = store.one('SELECT max(rowid) cursor FROM documents');
  store.db.prepare("INSERT INTO cases VALUES('late-observation',?,?,'Наблюдаем эффект',?)")
    .run(product, 'Поздняя выкладка', JSON.stringify({ watch: {
      version: 2, kind: 'archive-observation', metric: 'orders_index', title: 'Индекс заказов',
      taskId: 'T-LATE', releaseId: null, deployed: null, segment: 'all', target: 100, direction: 'at-least',
      baselineWeeks: 1, observationWeeks: 1, scheduledOn: '2026-05-10', sourceCursor: cursor,
    } }));
  importDocs(store, [{ file: 'LateRollout.xlsx', facts: [
    { kind: 'backlog', loc: 'Tasks!A2', row: { task_id: 'T-LATE', title: product, release_id: 'R-LATE' } },
    { kind: 'releases', loc: 'Releases!A2', row: { release_id: 'R-LATE', release_date: '2026-05-12',
      related_task_ids: 'T-LATE', description: product, status: 'выпущен', release_type: 'minor' } },
  ] }], { notify: false });
  await page.goto(base + '/#case/late-observation/effect');
  await effect.getByText('2026-05-12', { exact: true }).waitFor();
  await effect.getByLabel('Значение цели, если согласовано').fill('105');
  const saved = page.waitForResponse(response => response.url().endsWith('/api/team/watch'));
  await effect.getByRole('button', { name: 'Сохранить наблюдение' }).click();
  const response = await saved;
  assert.ok(response.ok(), await response.text());
  const edited = await response.json();
  assert.equal(edited.plan.target, 105);
  assert.equal(edited.plan.scheduledOn, '2026-05-10');
  assert.equal(edited.plan.sourceCursor, cursor);
  assert.equal(edited.rollout.date, '2026-05-12');
  await effect.getByText('2026-05-12', { exact: true }).waitFor();
});
