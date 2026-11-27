import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createTeamApp } from '../server/team-http.mjs';
import { fixtureEnv, seedWorkspace } from './workspace-fixture.mjs';

let dir, fixture, app, browser, base;
before(async () => {
  dir = await mkdtemp(join(tmpdir(), 'pm-ui-hints-'));
  fixture = await seedWorkspace(dir);
  app = createTeamApp({ base: join(dir, 'releases.sqlite'), env: fixtureEnv, background: false });
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  base = 'http://127.0.0.1:' + app.server.address().port;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ headless: true, executablePath: process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined) });
});

after(async () => {
  await browser?.close();
  await app?.close();
  if (dir) await rm(dir, { recursive: true, force: true, maxRetries: 3 });
});

async function pageFor(t, login = 'admin', options = {}) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, locale: 'ru-RU', ...options });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(4500);
  if (login) await signIn(page, login);
  return page;
}

async function signIn(page, login) {
  const response = await page.request.post(base + '/api/team/login', {
    data: { login: 'fixture-' + login, password: 'fixture-password' },
  });
  assert.ok(response.ok(), await response.text());
}

async function visit(page, route = 'overview') {
  await page.goto(base + '/#' + route);
  await page.locator('.workspace-page').waitFor();
}

const tooltip = page => page.locator('.ui-hint-tooltip[role="tooltip"]');
const navLink = (page, name) => page.getByRole('navigation', { name: 'Основные разделы' }).getByRole('link', { name, exact: true });
const button = (page, name) => page.getByRole('button', { name, exact: true });
const marker = (page, name) => button(page, name);
const toggle = page => page.getByRole('switch', { name: 'Показывать подсказки' });

async function showHint(page, target, text) {
  await target.hover();
  const hint = tooltip(page);
  await hint.filter({ hasText: text }).waitFor({ state: 'visible', timeout: 2500 });
  assert.equal(await hint.count(), 1);
  assert.equal(await hint.textContent(), text);
  return hint;
}

async function waitForEntrance(hint) {
  await hint.evaluate(node => Promise.all(node.getAnimations().map(animation => animation.finished)));
}

test('UI hints: menu', async t => {
  const page = await pageFor(t);
  await visit(page);
  await page.clock.install();
  const cases = navLink(page, 'Разборы');
  await cases.hover();
  await page.mouse.move(5, 5);
  await page.clock.runFor(400);
  assert.equal(await tooltip(page).count(), 0);

  const hints = [
    ['Обзор', 'Сигналы и проверки эффекта.'],
    ['Чаты', 'Диалоги с помощником и командой.'],
    ['Разборы', 'Исследования, расчёты и планы действий.'],
    ['Источники', 'Файлы и данные для расчётов.'],
  ];
  for (const [label, text] of hints) await showHint(page, navLink(page, label), text);
  const sidebar = page.locator('#workspace-sidebar');
  await showHint(page, sidebar.getByRole('link', { name: 'Мои настройки', exact: true }), 'Настройки вашего интерфейса.');
  await showHint(page, sidebar.getByRole('link', { name: 'Настройки команды', exact: true }), 'Правила и подключения для всей команды.');
  const hint = await showHint(page, cases, hints[2][1]);
  assert.equal(await cases.getAttribute('title'), null);
  assert.equal(await cases.getAttribute('aria-describedby'), await hint.getAttribute('id'));
  await cases.locator('.ui-icon').hover();
  await cases.locator('.menu-label').hover();
  assert.equal(await hint.count(), 1);
  await hint.hover();
  await page.clock.runFor(160);
  assert.equal(await hint.count(), 1);
  await page.keyboard.press('Escape');
  await hint.waitFor({ state: 'detached' });
  assert.equal(await cases.getAttribute('aria-describedby'), null);

  await page.evaluate(() => {
    localStorage.setItem('pm-sidebar-width', '56');
    localStorage.setItem('pm-menu-layout', 'left');
  });
  await page.reload();
  await waitForEntrance(await showHint(page, cases, hints[2][1]));
  const leftTip = await hint.boundingBox(), leftTarget = await cases.boundingBox();
  const clientWidth = await page.evaluate(() => document.documentElement.clientWidth);
  assert.ok(leftTip.width > 56 && leftTip.x >= 8 && leftTip.x + leftTip.width <= clientWidth - 8);
  assert.ok(Math.abs(leftTarget.y - leftTip.y - leftTip.height - 8) < 1);
  const motion = await hint.evaluate(node => {
    const style = getComputedStyle(node);
    return { duration: style.animationDuration, background: style.backgroundColor, opacity: style.opacity };
  });
  assert.equal(motion.duration, '0.15s');
  assert.match(motion.background, /0\.92/);
  assert.equal(motion.opacity, '1');

  await page.evaluate(() => localStorage.setItem('pm-menu-layout', 'top'));
  await page.reload();
  const overview = navLink(page, 'Обзор');
  await waitForEntrance(await showHint(page, overview, hints[0][1]));
  const topTip = await hint.boundingBox(), topTarget = await overview.boundingBox();
  assert.ok(Math.abs(topTip.y - topTarget.y - topTarget.height - 8) < 1);

  const keyboard = await pageFor(t, 'admin', { reducedMotion: 'reduce', colorScheme: 'dark' });
  await visit(keyboard);
  await keyboard.locator('#workspace-sidebar .brand').focus();
  await keyboard.keyboard.press('Tab');
  const keyboardTip = tooltip(keyboard);
  await keyboardTip.waitFor();
  const reduced = await keyboardTip.evaluate(node => {
    const style = getComputedStyle(node);
    return { animation: style.animationName, background: style.backgroundColor };
  });
  assert.equal(reduced.animation, 'none');
  assert.match(reduced.background, /0\.92/);

  const touch = await pageFor(t, 'admin', { hasTouch: true, viewport: { width: 390, height: 844 } });
  await visit(touch);
  await navLink(touch, 'Источники').tap();
  await touch.waitForURL('**/#sources');
  await touch.clock.install();
  await touch.clock.runFor(400);
  assert.equal(await tooltip(touch).count(), 0);
});

test('UI hints: entry and preference', async t => {
  const guest = await pageFor(t, null);
  await guest.goto(base);
  const invitation = button(guest, 'У меня есть приглашение');
  await showHint(guest, invitation, 'Откроет форму регистрации по коду.');
  await invitation.click();
  await showHint(guest, marker(guest, 'О поле «Код приглашения»'), 'Код из ссылки или письма с приглашением.');
  await guest.goto(base + '/#join/fixture-judge');
  await guest.reload();
  assert.equal(await guest.getByLabel('Код приглашения', { exact: true }).inputValue(), 'fixture-judge');
  await showHint(guest, marker(guest, 'О поле «Код приглашения»'), 'Код из ссылки или письма с приглашением.');

  const page = await pageFor(t);
  await visit(page);
  await showHint(page, button(page, 'Спросить помощника'), 'Откроет чат с помощником.');
  await showHint(page, page.locator('.signal-panel').getByRole('link', { name: 'Открыть разбор' }), 'Откроет данные и выводы проверки.');
  await page.route('**/api/team/overview', async route => {
    const response = await route.fetch();
    await route.fulfill({ json: { ...await response.json(), cases: [] } });
  });
  await page.reload();
  await showHint(page, marker(page, 'О разделе «Требует внимания»'), 'Что изменилось и требует проверки.');
  await showHint(page, marker(page, 'О разделе «Проверка эффекта»'), 'Как изменилась метрика после релиза.');
  assert.equal(await page.locator('.signal-panel').count(), 0);
  await visit(page, 'sources');
  await showHint(page, button(page, 'Загрузить и пересчитать'), 'Читает файл и обновляет расчёты.');
  await showHint(page, button(page, 'Синхронизировать Метрику'), 'Загружает свежие данные из Метрики.');
  await visit(page, 'cases/settings');
  await showHint(page, marker(page, 'О настройках команды'), 'Правила и подключения для всей команды.');
  await visit(page, 'settings/personal');
  await showHint(page, marker(page, 'О разделе «Личный доступ»'), 'Ключ MCP нужен для доступа из внешнего клиента.');
  assert.equal(await toggle(page).isChecked(), true);
  await toggle(page).uncheck();
  await visit(page, 'overview');
  await page.reload();
  await button(page, 'Спросить помощника').waitFor();
  assert.equal(await page.locator('.ui-help-marker').count(), 0);
  await visit(page, 'sources');
  await page.getByRole('heading', { name: 'Загруженные материалы' }).waitFor();
  assert.equal(await page.locator('.ui-help-marker').count(), 0);
  await page.clock.install();
  await navLink(page, 'Разборы').hover();
  await page.clock.runFor(400);
  assert.equal(await tooltip(page).count(), 0);

  for (const [login, enabled] of [['member', true], ['admin', false]]) {
    await visit(page, 'profile');
    await button(page, 'Выйти').click();
    await button(page, 'Войти').waitFor();
    await signIn(page, login);
    await page.reload();
    await visit(page, 'settings/personal');
    assert.equal(await toggle(page).isChecked(), enabled);
  }
  await toggle(page).check();
  await visit(page, 'sources');
  await showHint(page, marker(page, 'О разделе «Загруженные материалы»'), 'Файлы, на которых основаны расчёты.');

  const judge = await pageFor(t, 'judge', { viewport: { width: 390, height: 844 } });
  await visit(judge, 'sources');
  await showHint(judge, marker(judge, 'О разделе «Загруженные материалы»'), 'Файлы, на которых основаны расчёты.');
  assert.equal(await button(judge, 'Загрузить и пересчитать').count(), 0);
  await visit(judge, 'settings/personal');
  await toggle(judge).waitFor({ state: 'visible' });

  const touch = await pageFor(t, 'member', { hasTouch: true, viewport: { width: 390, height: 844 } });
  await visit(touch);
  await touch.clock.install();
  await marker(touch, 'О разделе «Требует внимания»').tap();
  await touch.clock.runFor(400);
  assert.equal(await tooltip(touch).count(), 0);
  assert.ok(touch.url().endsWith('#overview'));

  const keyboard = await pageFor(t, 'admin', { viewport: { width: 1280, height: 400 } });
  await visit(keyboard, 'settings/personal');
  await toggle(keyboard).focus();
  await keyboard.evaluate(() => window.scrollTo(0, 0));
  await keyboard.keyboard.press('Tab');
  const access = marker(keyboard, 'О разделе «Личный доступ»');
  assert.equal(await access.evaluate(node => node === document.activeElement), true);
  await keyboard.waitForFunction(() => scrollY > 0);
  await keyboard.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await tooltip(keyboard).filter({ hasText: 'Ключ MCP нужен для доступа из внешнего клиента.' }).waitFor();
});

test('UI hints: chats', async t => {
  const page = await pageFor(t);
  await visit(page, 'chats');
  const create = button(page, 'Новый чат');
  await showHint(page, create, 'Выберите личный или командный чат.');
  const requests = [];
  page.on('request', request => {
    if (/\/api\/team\/(thread|rename-thread|delete-thread)$/.test(request.url())) requests.push(request.url());
  });
  await create.click();
  const dialog = page.getByRole('dialog', { name: 'Новый чат' });
  await dialog.waitFor();
  const hint = await showHint(page, dialog.getByLabel('Участники'), 'Определяет, кто увидит переписку.');
  assert.ok(await hint.evaluate(node => node.matches(':popover-open') && node.closest('dialog')?.matches(':modal')));
  await page.keyboard.press('Escape');
  await hint.waitFor({ state: 'detached' });
  assert.equal(await dialog.isVisible(), true);
  await page.keyboard.press('Escape');
  await dialog.waitFor({ state: 'hidden' });
  await page.waitForFunction(() => document.activeElement?.textContent?.trim() === 'Новый чат');

  for (const id of [fixture.thread, 'group']) {
    await visit(page, 'chats/' + id);
    await showHint(page, button(page, 'Сценарии'), 'Вставит редактируемый запрос в поле сообщения.');
  }
  await visit(page, 'chats/' + fixture.thread);
  const menuName = 'Действия чата «Исходная переписка»';
  const row = page.locator('.thread-row').filter({ has: button(page, menuName) });
  for (const [action, title, target, text] of [
    ['Переименовать', 'Переименовать чат', pane => pane.getByLabel('Название'), 'Новое название появится в списке чатов.'],
    ['Удалить чат', 'Удалить чат?', pane => button(pane, 'Удалить чат'), 'Удаляет чат вместе со всей перепиской.'],
  ]) {
    await row.hover();
    await button(row, menuName).click();
    await page.getByRole('menuitem', { name: action, exact: true }).click();
    const pane = page.getByRole('dialog', { name: title, exact: true });
    if (action === 'Переименовать') {
      const name = pane.getByLabel('Название');
      await name.click();
      await page.mouse.move(5, 5);
      await page.clock.install();
      await name.hover();
      await page.keyboard.press('Tab');
      await page.clock.runFor(400);
      assert.equal(await tooltip(page).count(), 0, 'blurring a field cancels its pending hint');
      await page.mouse.move(5, 5);
    }
    await showHint(page, target(pane), text);
    await button(pane, 'Отмена').click();
    await pane.waitFor({ state: 'hidden' });
  }
  assert.deepEqual(requests, []);
  await visit(page, 'case/' + fixture.caseId);
  await showHint(page, marker(page, 'О разделе «Обсудить разбор»'), 'Здесь можно задать вопрос о данных и выводах разбора.');
});

test('UI hints: cases', async t => {
  const page = await pageFor(t);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await visit(page, 'cases');
  await showHint(page, button(page, 'Новый разбор'), 'Откроет форму личного исследования.');
  await page.mouse.move(5, 5);
  await tooltip(page).waitFor({ state: 'detached' });
  await showHint(page, navLink(page, 'Релизы'), 'Откроет календарь из загруженных материалов.');
  await button(page, 'Новый разбор').click();
  await page.mouse.move(5, 5);
  await showHint(page, button(page, 'Новый разбор'), 'Свернёт форму нового разбора.');
  await page.keyboard.press('Escape');
  await showHint(page, page.getByText('Гипотеза и критерии до разработки', { exact: true }), 'Укажите, что проверяем и какой результат считаем успехом.');
  await visit(page);
  await page.locator('.signal-panel').getByRole('link', { name: 'Открыть разбор' }).click();
  await showHint(page, marker(page, 'О разборе'), 'Выводы, расчёты и дальнейшие действия по одному вопросу.');
  const requests = [];
  page.on('request', request => {
    if (/\/api\/team\/(confirm|publish)$/.test(request.url())) requests.push(request.url());
  });
  await showHint(page, button(page, 'Поделиться'), 'Откроет предпросмотр материалов для команды.');
  await button(page, 'Поделиться').click();
  const dialog = page.getByRole('dialog', { name: 'Поделиться с командой' });
  await showHint(page, button(dialog, 'Опубликовать'), 'Отправит выбранные материалы и вывод в командный чат.');
  await button(dialog, 'Отмена').click();
  await dialog.waitFor({ state: 'hidden' });
  const period = button(page, 'Период расчёта');
  await showHint(page, period, 'Меняет даты, которые попадают в расчёт.');
  await page.keyboard.press('Escape');
  await period.click();
  const periodForm = page.getByRole('form', { name: 'Период расчёта', exact: true });
  await periodForm.waitFor();
  await page.keyboard.press('Escape');
  await periodForm.waitFor({ state: 'hidden' });
  assert.deepEqual(errors, []);
  const interview = page.locator('.interview-search > summary');
  await showHint(page, interview, 'Ищет обезличенные выдержки по теме или цитате.');
  await page.keyboard.press('Escape');
  await button(page, 'Сбросить вид').click();
  const reset = page.getByRole('dialog', { name: 'Сбросить вид?' });
  await showHint(page, button(reset, 'Сбросить'), 'Вернёт начальные фильтры и карточки.');
  await button(reset, 'Отмена').click();
  await reset.waitFor({ state: 'hidden' });
  const watch = page.locator('summary').filter({ hasText: /^Проверка эффекта$/ });
  await showHint(page, watch, 'Здесь задают период и критерий успеха после релиза.');
  await watch.click();
  await button(page, 'Завершить разбор').click();
  const finish = page.getByRole('dialog', { name: 'Завершить разбор?' });
  await showHint(page, button(finish, 'Завершить'), 'Уберёт разбор из активных проверок.');
  await button(finish, 'Отмена').click();
  await finish.waitFor({ state: 'hidden' });
  assert.deepEqual(requests, []);
});

test('UI hints: saved routes', async t => {
  const page = await pageFor(t);
  for (const [route, label, text] of [
    ['snapshot/' + fixture.calc + '/trend', 'О сохранённом расчёте', 'Здесь сохранено, по каким данным получен результат.'],
    ['range/' + fixture.range, 'О расчёте по выделению', 'Показывает расчёт и покрытие по выбранным периодам.'],
    ['material/' + fixture.report, 'О материале', 'Сохранённый материал из чата или разбора.'],
  ]) {
    await visit(page, route);
    await showHint(page, marker(page, label), text);
  }
  const snapshots = {
    'hint-evidence': { kind: 'evidence-search', title: 'Источники расчёта', evidence: [] },
    'hint-metric': { kind: 'metric-chart', title: 'График метрики', metric: 'orders_index', unit: 'п. индекса',
      segment: 'all', points: [{ date: '2026-10-05', value: 100 }, { date: '2026-10-12', value: 85 }] },
  };
  await page.route('**/api/team/calc', route => {
    const id = route.request().postDataJSON().id;
    return snapshots[id] ? route.fulfill({ json: snapshots[id] }) : route.continue();
  });
  for (const id of Object.keys(snapshots)) {
    await visit(page, 'snapshot/' + id);
    await showHint(page, marker(page, 'О сохранённом расчёте'), 'Здесь сохранено, по каким данным получен результат.');
  }
  await visit(page, 'chats/' + fixture.thread);
  await page.getByRole('link', { name: /Исходный отчёт/ }).click();
  const modal = page.getByRole('dialog', { name: 'Материал из переписки' });
  await showHint(page, marker(modal, 'О материале'), 'Сохранённый материал из чата или разбора.');
  await button(modal, 'Закрыть').click();
  await modal.waitFor({ state: 'hidden' });
  await visit(page, 'settings/personal');
  await toggle(page).uncheck();
  await visit(page, 'material/' + fixture.report);
  await page.getByRole('heading', { name: 'Исходный отчёт' }).waitFor();
  assert.equal(await page.locator('.ui-help-marker').count(), 0);
  await visit(page, 'demo-page/hidden');
  await page.locator('.workspace-page[data-route="cases"]').waitFor();
});

test('UI hints: releases', async t => {
  const page = await pageFor(t);
  await visit(page, 'releases-list');
  const analytics = page.getByRole('link', { name: 'Аналитика по событиям CSV' });
  await showHint(page, analytics, 'Откроет показатели релизов по загруженным событиям.');
  await visit(page, 'release-detail/DEMO-R');
  await showHint(page, button(page, 'Запланировать оценку'), 'Откроет форму разбора для этого релиза.');
  await button(page, 'Запланировать оценку').click();
  await page.getByLabel('Вопрос или гипотеза').waitFor();
  await page.goto(base + '/?legacy=1#release/R-001');
  await showHint(page, page.locator('.release-workspace .crumb'), 'Вернёт в календарь из загруженных материалов.');
  await showHint(page, page.getByLabel('Данные на', { exact: true }), 'Ограничивает расчёт событиями по выбранную дату.');
  await showHint(page, page.getByLabel('Клиенты', { exact: true }), 'Выбирает группу клиентов для расчёта.');
  for (const [action, title, label, text] of [
    ['Добавить релиз', 'Добавить релиз', 'Набор данных', 'Выберите события, по которым считать метрики релиза.'],
    ['Импорт CSV', 'Загрузить события', 'Данные полны по дату и время, МСК', 'До какого момента выгрузка содержит все события.'],
  ]) {
    await button(page, action).click();
    const dialog = page.getByRole('dialog', { name: title, exact: true });
    await showHint(page, dialog.getByLabel(label), text);
    await button(dialog, 'Закрыть').click();
    await dialog.waitFor({ state: 'hidden' });
  }
});
