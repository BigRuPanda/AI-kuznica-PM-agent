import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { createTeamApp } from '../server/team-http.mjs';
import { fixtureEnv, seedWorkspace } from './workspace-fixture.mjs';

test('profile photo, renamed case chat and ordinary chart attachments work together', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'ui-migration-core-'));
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const { caseId, chart } = await seedWorkspace(dir);
  app = createTeamApp({ base: join(dir, 'releases.sqlite'), env: fixtureEnv, background: false });
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ executablePath: process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined) });
  const page = await browser.newPage({ locale: 'ru-RU', viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(8000);
  const button = (area, name) => area.getByRole('button', { name, exact: true });
  const api = async (operation, data = {}) => {
    const response = await page.request.post(origin + '/api/team/' + operation, { data });
    assert.ok(response.ok(), operation + ': ' + await response.text());
    return response.json();
  };
  await api('login', { login: 'fixture-admin', password: 'fixture-password' });
  await page.goto(origin + '/#profile');
  await page.locator('.workspace-page').waitFor();
  const profileLink = page.getByRole('link', { name: 'Профиль', exact: true });
  assert.equal(await profileLink.count(), 1, 'the signed-in workspace exposes the profile');
  await button(page, 'Редактировать профиль').click();
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 8;
    const context = canvas.getContext('2d');
    context.fillStyle = '#ad1239';
    context.fillRect(0, 0, 8, 8);
    return canvas.toDataURL().split(',')[1];
  });
  await page.getByLabel('Фото профиля', { exact: true }).setInputFiles({
    name: 'portrait.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64'),
  });
  await page.getByRole('region', { name: 'Учётная запись' }).locator('.profile-avatar img').waitFor();
  await button(page, 'Сохранить профиль').click();
  const savedPhoto = await profileLink.locator('.profile-avatar img').getAttribute('src');
  assert.ok(savedPhoto);

  const { id: caseThread } = await api('case-thread', { caseId });
  for (const menu of ['left', 'top']) {
    await page.evaluate(menu => localStorage.setItem('pm-menu-layout', menu), menu);
    await page.reload();
    for (const width of [390, 900, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(origin + '/#case/' + caseId);
      await page.locator('.team-app[data-menu="' + menu + '"]').waitFor();
      const discussion = page.locator('.case-discussion');
      if (width <= 820) await button(page, 'Обсудить').click();
      const send = button(discussion, 'Отправить');
      await send.waitFor();
      const geometry = await send.evaluate(control => {
        const button = control.getBoundingClientRect();
        const panel = control.closest('.chat-box');
        const box = panel.getBoundingClientRect();
        const row = control.closest('.composer-row').getBoundingClientRect();
        return { left: button.left, right: button.right, panelLeft: box.left, panelRight: box.right,
          rowRight: row.right, scrollWidth: panel.scrollWidth, clientWidth: panel.clientWidth };
      });
      assert.ok(geometry.left >= geometry.panelLeft && geometry.right <= geometry.panelRight &&
        geometry.scrollWidth <= geometry.clientWidth + 1, `${menu} at ${width}px ${JSON.stringify(geometry)}`);
    }
  }
  const title = 'Переименованная переписка о результатах';
  await api('rename-thread', { thread: caseThread, title });
  const { threads } = await api('overview');
  const groupedCaseId = threads.find(thread => thread.id === caseThread)?.caseId;
  assert.equal(groupedCaseId, caseId);
  await page.goto(origin + '/#chats/group');
  const nav = page.getByRole('navigation', { name: 'Переписки' });
  await page.getByLabel('Поиск чатов').fill(title.toLocaleUpperCase('ru'));
  const result = nav.getByRole('region', { name: 'Разборы' }).getByRole('link', { name: title });
  await result.click();
  await page.waitForURL('**/#chats/' + caseThread);

  const question = 'Проверка графика ' + origin + '/#material/' + chart;
  const sendChart = async () => {
    await page.getByLabel('Вопрос агенту').fill(question);
    await page.locator('.chat-composer .range-attachment').waitFor();
    await button(page, 'Отправить').click();
    const bubble = page.locator('.bubble.user').filter({ hasText: 'Проверка графика' }).last();
    await bubble.waitFor();
    return bubble;
  };
  const caseMessage = await sendChart();
  const ownAvatarSrc = await caseMessage.locator('.message-author .chat-avatar img').getAttribute('src');
  assert.equal(ownAvatarSrc, savedPhoto);
  await caseMessage.locator('a[href="#material/' + chart + '"]').click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('.range-plot svg').waitFor();
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });

  const { id: ordinaryThread } = await api('thread', { title: 'Отдельный вопрос о графике' });
  await page.goto(origin + '/#chats/' + ordinaryThread);
  const ordinaryMessage = await sendChart();
  await ordinaryMessage.locator('a[href="#material/' + chart + '"]').click();
  await dialog.locator('.range-plot svg').waitFor();
  const pinButtons = area => area.getByRole('button', { name: /Добавить в разбор|Добавлено ·|Убрать с экрана/ });
  const pinButtonsInOrdinaryChat = await pinButtons(ordinaryMessage).count() + await pinButtons(dialog).count();
  assert.equal(pinButtonsInOrdinaryChat, 0);
});
