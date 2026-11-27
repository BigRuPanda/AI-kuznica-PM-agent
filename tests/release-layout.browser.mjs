import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createTeamApp } from '../server/team-http.mjs';
import { importDocs } from '../server/evidence.mjs';
import { fixtureEnv, seedWorkspace } from './workspace-fixture.mjs';

test('the release journal sorts both sources and keeps their routes distinct', async t => {
  const { app, page, origin } = await openWorkspace(t);
  importDocs(app.space('team'), [{
    file: 'Дополнение к календарю.xlsx',
    facts: [
      { kind: 'releases', loc: 'Релизы!A2', row: {
        release_id: 'R-001', release_date: '2026-11-08', description: 'Календарная запись R-001',
        related_task_ids: 'DOC-1; DOC-3',
      } },
      { kind: 'releases', loc: 'Релизы!A3', row: {
        release_id: 'R-NODATE', release_date: null, description: 'Релиз без даты',
      } },
      { kind: 'backlog', loc: 'Бэклог!A2', row: { task_id: 'DOC-1', title: 'Обновить документацию', status: 'Done' } },
      { kind: 'backlog', loc: 'Бэклог!A3', row: { task_id: 'DOC-2', title: 'Проверить публикацию', status: 'New', release_id: 'R-001' } },
    ],
  }], { notify: false });
  await page.route('**/api/journal', route => route.fulfill({
    status: 503, json: { error: 'Журнал временно недоступен' },
  }), { times: 1 });
  await page.goto(origin + '/#releases-list');
  const table = page.getByRole('table', { name: 'Журнал релизов' });
  await table.waitFor();
  await table.getByRole('link', { name: 'Календарная запись R-001' }).waitFor();
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await table.getByRole('link', { name: 'Кнопка «Скачать счёт»' }).waitFor();
  const rows = table.locator('tbody tr');
  assert.deepEqual(await rows.getByRole('link').allTextContents(), [
    'Календарная запись R-001', 'Кнопка «Скачать счёт»', 'Новая форма заказа', 'Тестовый конфигуратор Kaspersky',
    'Релиз без даты',
  ]);
  await rows.last().getByRole('cell', { name: 'Не указана' }).waitFor();
  assert.equal(await rows.nth(0).getByRole('link').getAttribute('href'), '#release-detail/R-001');
  assert.equal(await rows.nth(2).getByRole('link').getAttribute('href'), '#release/R-001');
  await page.getByRole('button', { name: 'Из календаря', exact: true }).click();
  assert.equal(await rows.count(), 3);
  await rows.first().getByRole('link').click();
  const tasks = page.getByRole('table', { name: 'Связанные задачи' });
  await tasks.getByRole('cell', { name: 'Обновить документацию' }).waitFor();
  await tasks.getByRole('cell', { name: 'Проверить публикацию' }).waitFor();
  await page.getByRole('listitem').filter({ hasText: 'DOC-3' }).waitFor();
  await page.goto(origin + '/#releases');
  await page.getByRole('button', { name: 'С метриками', exact: true, pressed: true }).waitFor();
  await table.getByRole('link', { name: 'Кнопка «Скачать счёт»' }).waitFor();
  assert.equal(await rows.count(), 2);
  await rows.first().getByRole('link').click();
  await page.getByRole('columnheader', { name: 'После выпуска' }).waitFor();
  assert.equal(await page.getByRole('tab', { name: 'Сохранённые графики' }).count(), 0);
  await page.getByText('Другие метрики', { exact: true }).click();
  await page.getByRole('button', { name: 'График: Конверсия из оформления в оплату' }).click();
  await page.getByRole('heading', { name: 'Конверсия из оформления в оплату', exact: true }).waitFor();
  await page.getByRole('tab', { name: 'Метрики' }).press('ArrowRight');
  await page.getByRole('textbox', { name: 'Спросить агента' }).waitFor();
});

test('finishing a case has its own row below archive observation at every width', async t => {
  const { page, origin, caseId } = await openWorkspace(t);
  await page.goto(origin + '/#case/' + caseId);
  const effect = page.locator('.effect-panel');
  await effect.locator(':scope > summary').click();
  const archive = effect.getByText('Наблюдение по архивным источникам', { exact: true });
  const finish = effect.getByRole('button', { name: 'Завершить разбор' });
  for (const width of [390, 900, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    for (const expanded of [false, true]) {
      const section = archive.locator('..');
      assert.equal(await section.evaluate(element => element.open), expanded);
      const archiveBounds = await section.boundingBox();
      const finishBounds = await finish.boundingBox();
      assert.ok(finishBounds.y - archiveBounds.y - archiveBounds.height >= 15.5,
        `finish button needs 16 px separation at ${width}px, archive open=${expanded}`);
      await archive.click();
    }
  }
  await finish.click();
  await page.getByRole('dialog', { name: 'Завершить разбор?' }).waitFor();
});

async function openWorkspace(t) {
  const directory = await mkdtemp(join(tmpdir(), 'release-layout-'));
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  });
  const { caseId } = await seedWorkspace(directory);
  app = createTeamApp({ base: join(directory, 'releases.sqlite'), env: fixtureEnv, background: false });
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ executablePath: process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined) });
  const page = await browser.newPage({ locale: 'ru-RU', viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
  page.setDefaultTimeout(3500);
  const login = await page.request.post(origin + '/api/team/login', {
    data: { login: 'fixture-admin', password: 'fixture-password' },
  });
  assert.ok(login.ok());
  return { app, page, origin, caseId };
}
