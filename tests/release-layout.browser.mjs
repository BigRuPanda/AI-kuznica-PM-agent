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

test('release cards sort both sources and keep their routes and actions distinct', async t => {
  const { app, page, origin } = await openWorkspace(t);
  const store = app.space('team');
  const calendarTitle = 'Календарная запись R-001 для Kaspersky';
  importDocs(store, [{
    file: 'Дополнение к календарю.xlsx',
    facts: [
      { kind: 'releases', loc: 'Релизы!A2', row: {
        release_id: 'R-001', release_date: '2026-11-08', description: calendarTitle,
        release_type: 'major', status: 'выпущен',
        related_task_ids: 'DOC-1; DOC-3',
      } },
      { kind: 'releases', loc: 'Релизы!A3', row: {
        release_id: 'R-NODATE', release_date: null, description: 'Релиз без даты',
      } },
      { kind: 'backlog', loc: 'Бэклог!A2', row: { task_id: 'DOC-1', title: 'Обновить документацию', status: 'Done' } },
      { kind: 'backlog', loc: 'Бэклог!A3', row: { task_id: 'DOC-2', title: 'Проверить публикацию', status: 'New', release_id: 'R-001' } },
    ],
  }], { notify: false });
  store.db.prepare('INSERT INTO cases VALUES (?,?,?,?,?)').run('related-case', 'Kaspersky',
    'Проверка календарного релиза', 'Исследуем', JSON.stringify({ release: 'R-001' }));
  await page.route('**/api/journal', route => route.fulfill({
    status: 503, json: { error: 'Журнал временно недоступен' },
  }), { times: 1 });
  await page.goto(origin + '/#releases-list');
  const journal = page.getByRole('list', { name: 'Журнал релизов' });
  const source = page.getByRole('combobox', { name: 'Источник', exact: true });
  await journal.waitFor();
  assert.equal(await source.inputValue(), 'all');
  await journal.getByRole('link', { name: calendarTitle, exact: true }).waitFor();
  await page.getByRole('button', { name: 'Повторить', exact: true }).click();
  await journal.getByRole('link', { name: 'Кнопка «Скачать счёт»' }).waitFor();
  const cards = journal.locator(':scope > li');
  assert.deepEqual(await cards.locator('.release-id').allTextContents(), ['R-001', 'R-002', 'R-001', 'DEMO-R', 'R-NODATE']);
  assert.equal(await journal.getByRole('table').count(), 0);
  await cards.last().getByText('Дата не указана', { exact: true }).waitFor();
  assert.equal(await cards.first().locator('time').getAttribute('datetime'), '2026-11-08');
  assert.equal(await cards.nth(0).getByRole('link').getAttribute('href'), '#release-decision/R-001');
  assert.equal(await cards.nth(2).getByRole('link').getAttribute('href'), '#release/R-001');
  assert.equal(await cards.last().getByRole('link').count(), 0);
  await page.mouse.move(0, 0);
  await assertOutlined(source);
  await assertOutlined(cards.first());
  await assertOutlined(cards.first().getByRole('link', { name: calendarTitle, exact: true }).locator('.release-open-icon'));
  await assertOutlined(cards.first().getByRole('button', { name: 'Запланировать разбор R-001' }));
  await assertOutlined(cards.first().getByRole('button', { name: 'Связанные задачи и разборы R-001' }));
  const management = page.getByText('Управление', { exact: true });
  await assertOutlined(management);
  await management.click();
  await assertOutlined(page.getByRole('button', { name: 'Добавить релиз', exact: true }));
  await assertOutlined(page.getByRole('button', { name: 'Импорт CSV', exact: true }));
  await management.click();
  await source.selectOption('calendar');
  assert.equal(await cards.count(), 3);
  await page.setViewportSize({ width: 390, height: 844 });
  const fit = await cards.first().evaluate(card => {
    const bounds = card.getBoundingClientRect();
    const title = card.querySelector('h2').getBoundingClientRect();
    const date = card.querySelector('time').getBoundingClientRect();
    const action = card.querySelector('.release-plan').getBoundingClientRect();
    const related = card.querySelector('button[aria-expanded]').getBoundingClientRect();
    return {
      dateAboveTitle: date.bottom <= title.top,
      dateOnLeft: Math.abs(date.left - title.left) <= 1,
      actionsBelowTitle: action.top >= title.bottom,
      actionAtRightEdge: Math.abs(action.right - title.right) <= 1,
      equalButtons: Math.abs(action.width - related.width) <= 1 && Math.abs(action.height - related.height) <= 1,
      separateCards: card.nextElementSibling.getBoundingClientRect().top - bounds.bottom >= 8,
      horizontalScroll: document.documentElement.scrollWidth > innerWidth,
    };
  });
  assert.deepEqual(fit, {
    dateAboveTitle: true, dateOnLeft: true, actionsBelowTitle: true, actionAtRightEdge: true, equalButtons: true,
    separateCards: true, horizontalScroll: false,
  });
  await cards.first().getByRole('button', { name: 'Связанные задачи и разборы R-001' }).press('Enter');
  const tasks = cards.first().getByRole('table', { name: 'Связанные задачи' });
  await tasks.getByRole('cell', { name: 'Обновить документацию' }).waitFor();
  await tasks.getByRole('cell', { name: 'Проверить публикацию' }).waitFor();
  await cards.first().getByRole('listitem').filter({ hasText: 'DOC-3' }).waitFor();
  await cards.first().getByRole('link', { name: /Проверка календарного релиза/ }).waitFor();
  await page.setViewportSize({ width: 1440, height: 900 });
  const alignment = await journal.evaluate(list => {
    const primary = list.querySelector('.release-plan').getBoundingClientRect();
    const edges = [...list.querySelectorAll('.release-plan')].map(button => button.getBoundingClientRect().right);
    const actions = [...list.querySelectorAll('.release-card-actions button')].map(button => button.getBoundingClientRect());
    const arrow = list.querySelector('.release-open-icon').getBoundingClientRect();
    const middle = rect => rect.top + rect.height / 2;
    return {
      actionsInOneColumn: edges.every(edge => Math.abs(edge - primary.right) <= 1),
      arrowOnActionLine: Math.abs(middle(arrow) - middle(primary)) <= 1,
      equalButtons: actions.every(action => Math.abs(action.width - primary.width) <= 1 && Math.abs(action.height - arrow.height) <= 1),
    };
  });
  assert.deepEqual(alignment, { actionsInOneColumn: true, arrowOnActionLine: true, equalButtons: true });
  await cards.first().getByRole('link', { name: calendarTitle, exact: true }).click();
  await page.getByRole('heading', { name: 'Разбор релиза', exact: true }).waitFor();
  await page.waitForURL('**/#release-decision/R-001');
  await page.goto(origin + '/#releases');
  assert.equal(await source.inputValue(), 'metrics');
  await journal.getByRole('link', { name: 'Кнопка «Скачать счёт»' }).waitFor();
  assert.equal(await cards.count(), 2);
  await cards.first().getByRole('link').click();
  await page.getByRole('columnheader', { name: 'После выпуска' }).waitFor();
});

test('metric charts and calculations open over the release and restore focus when closed', async t => {
  const { app, page, origin } = await openWorkspace(t);
  const release = origin + '/#release/R-002';
  const metric = 'Конверсия из оформления в оплату';
  const marker = 'Сохранённая проверка периода';
  const report = await page.request.get(origin + '/api/report?releaseId=R-002&segment=new');
  assert.ok(report.ok());
  const { context } = await report.json();
  const comparison = await page.request.post(origin + '/api/compare', { data: { ...context, metric: 0 } });
  assert.ok(comparison.ok());
  const saved = await comparison.json();
  const store = app.space('team');
  store.db.prepare('INSERT INTO notes (id, release, body) VALUES (?, ?, ?)').run('popup-fixture', 'R-002', JSON.stringify({
    version: context.version, observedDay: context.day, metric: 0, segment: 'new',
    start: 0, end: 2, reason: marker, calc: saved.id,
  }));
  await page.goto(release);
  const segment = page.getByRole('combobox', { name: /Сегмент/u });
  await segment.selectOption('new');
  await page.getByText('Другие метрики', { exact: true }).click();
  const graphButton = page.getByRole('button', { name: 'График: ' + metric, exact: true });
  await graphButton.click();
  const graph = page.getByRole('dialog', { name: 'График: ' + metric });
  await graph.locator('.range-plot').waitFor();
  assert.equal(await page.locator('.release-metrics .range-plot').count(), 1);
  assert.equal(page.url(), release);
  const point = graph.getByRole('link', { name: marker, exact: true });
  await point.press('Enter');
  const source = page.getByRole('dialog', { name: 'Расчёт', exact: true });
  await source.getByRole('heading', { name: metric, exact: true }).waitFor();
  assert.equal(page.url(), release);
  await source.getByRole('button', { name: '← К графику' }).click();
  await point.waitFor();
  await page.waitForFunction(label => document.activeElement?.getAttribute('aria-label') === label, marker);
  await page.keyboard.press('Escape');
  await graph.waitFor({ state: 'hidden' });
  assert.ok(await graphButton.evaluate(button => button === document.activeElement));

  const proofButton = page.getByRole('button', { name: 'Расчёт: ' + metric, exact: true });
  const [response] = await Promise.all([
    page.waitForResponse(reply => reply.url().endsWith('/api/compare') && reply.ok()),
    proofButton.click(),
  ]);
  const { id } = await response.json();
  const proof = page.getByRole('dialog', { name: 'Расчёт: ' + metric });
  await proof.getByText('Новые клиенты', { exact: true }).waitFor();
  assert.equal(page.context().pages().length, 1);
  assert.equal(page.url(), release);
  await page.keyboard.press('Escape');
  await proof.waitFor({ state: 'hidden' });
  assert.ok(await proofButton.evaluate(button => button === document.activeElement));
  assert.equal(await segment.inputValue(), 'new');

  await page.getByRole('button', { name: 'Показать расчёт', exact: true }).click();
  await page.getByRole('dialog', { name: /^Расчёт:/u }).waitFor();
  await page.keyboard.press('Escape');
  await page.goto(origin + '/#calc/' + id);
  await page.getByRole('heading', { name: metric, exact: true }).waitFor();
});

test('release discussion is visible beside metrics and stacks on a narrow screen', async t => {
  const { page, origin } = await openWorkspace(t);
  await page.goto(origin + '/#release/R-002');
  const chat = page.getByRole('complementary', { name: 'Обсуждение релиза' });
  const metrics = page.locator('.release-metrics');
  await metrics.getByRole('columnheader', { name: 'После выпуска' }).waitFor();
  await chat.getByRole('textbox', { name: 'Спросить агента' }).waitFor();
  assert.equal(await page.getByRole('tablist', { name: 'Релиз' }).count(), 0);
  for (const width of [1440, 900, 800, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForFunction(viewport => {
      if (innerWidth !== viewport) return false;
      const main = document.querySelector('.release-metrics').getBoundingClientRect();
      const discussion = document.querySelector('.release-discussion').getBoundingClientRect();
      return viewport === 390 ? discussion.top >= main.bottom : discussion.left >= main.right;
    }, width);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.setViewportSize({ width: 900, height: 450 });
  const textarea = chat.getByRole('textbox', { name: 'Спросить агента' });
  await textarea.scrollIntoViewIfNeeded();
  const field = await textarea.boundingBox();
  assert.ok(field.y >= 0 && field.y + field.height <= 450, 'composer can fully scroll into view in a short window');
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

async function assertOutlined(control) {
  await control.waitFor({ state: 'visible' });
  const frame = await control.evaluate(element => {
    const style = getComputedStyle(element);
    return { color: style.borderTopColor, width: parseFloat(style.borderTopWidth), style: style.borderTopStyle };
  });
  assert.ok(
    frame.width >= 1 && frame.style === 'solid' && frame.color !== 'transparent' && frame.color !== 'rgba(0, 0, 0, 0)',
    `Expected visible border on ${control}: ${JSON.stringify(frame)}`,
  );
}

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
