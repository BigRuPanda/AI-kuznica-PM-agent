import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { readInvestigations } from '../server/case-investigations.mjs';
import { cases } from '../server/evidence.mjs';
import { captureInvestigation } from '../server/investigation-engine.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { fixtureEnv, seedWorkspace } from './workspace-fixture.mjs';

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
