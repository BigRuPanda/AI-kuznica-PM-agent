import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createTeamApp } from '../server/team-http.mjs';
import { readInvestigations } from '../server/case-investigations.mjs';
import { fixtureEnv, seedWorkspace } from './workspace-fixture.mjs';

test('PM edits the plan, chooses the actual Redmine issue, and confirms the preview', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'investigation-plan-ui-'));
  let app, browser;
  t.after(async () => {
    await browser?.close();
    await app?.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 3 });
  });
  const { caseId } = await seedWorkspace(dir);
  const host = 'https://tracker.test';
  const issue = { id: 73, project: { id: 7 }, subject: 'События корзины', description: '', journals: [] };
  const writes = [];
  const searched = [];
  async function send(value, init) {
    const url = new URL(value);
    assert.equal(url.origin, host);
    if (init.method === 'PUT') {
      assert.equal(url.pathname, '/issues/73.json');
      const notes = JSON.parse(init.body).issue.notes;
      writes.push(notes);
      issue.journals.push({ notes });
      return new Response('');
    }
    assert.equal(init.method, 'GET');
    switch (url.pathname) {
      case '/users/current.json': return Response.json({ user: { id: 1 } });
      case '/projects/store.json': return Response.json({ project: { id: 7 } });
      case '/projects/store/search.json':
        searched.push(url.searchParams.get('q'));
        return Response.json({ results: [{ type: 'issue', id: 73 }] });
      case '/issues.json': return Response.json({ issues: [issue] });
      case '/issues/73.json': return Response.json({ issue });
      default: throw Error('Unexpected Redmine path ' + url.pathname);
    }
  }

  const env = { ...fixtureEnv, INTEGRATION_KEY: randomBytes(32).toString('base64url') };
  app = createTeamApp({ base: join(dir, 'releases.sqlite'), env, send, background: false });
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ headless: true, executablePath:
    process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined) });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: 'ru-RU' });
  page.setDefaultTimeout(7500);
  const post = async (op, data) => {
    const response = await page.request.post(base + '/api/team/' + op, { data });
    assert.ok(response.ok(), await response.text());
    return response.json();
  };
  const user = await post('login', { login: 'fixture-admin', password: 'fixture-password' });
  await post('integration-config', { service: 'redmine', url: host, scope: 'store' });
  await post('integration-access', { service: 'redmine', action: 'connect', token: 'test-token' });
  const { db } = app.space('team');
  const runId = readInvestigations(db, user, caseId).current.id;
  db.prepare("UPDATE case_investigations SET status='ready',result=? WHERE id=?").run(JSON.stringify({
    summary: 'Событие корзины учитывается частично.', action: 'Сопоставить корзину с событием.',
    plan: 'Пройти покупку.', outcomes: ['Зафиксировать событие.'], hypotheses: [],
    issueSourceKey: 'T-08', issueQuery: 'События корзины',
  }), runId);

  await page.goto(base + '/#case/' + caseId);
  await page.getByText('Посмотреть план проверки', { exact: true }).click();
  const plan = page.locator('.investigation-plan');
  await plan.getByText('Ключ в конкурсной книге · T-08', { exact: true }).waitFor();
  const search = plan.getByLabel('Поиск задач по ключу или названию');
  assert.equal(await search.inputValue(), 'События корзины');
  await plan.getByRole('button', { name: 'Найти задачи' }).click();
  const prepare = plan.getByRole('button', { name: 'Подготовить предпросмотр' });
  assert.equal(await prepare.isEnabled(), false);
  await plan.getByLabel('Задача Redmine').selectOption('73');
  assert.equal(await plan.getByRole('link', { name: 'Открыть задачу · 73' }).getAttribute('href'), host + '/issues/73');
  const edited = 'Проверить корзину на телефоне.';
  const outcome = 'Если события нет, описать условия воспроизведения.';
  await plan.getByRole('textbox', { name: 'План проверки', exact: true }).fill(edited);
  await plan.getByRole('textbox', { name: 'Как интерпретировать результат', exact: true }).fill(outcome);
  await prepare.click();

  const preview = page.locator('.tracker-preview').filter({ hasText: edited });
  await preview.getByText('Задача 73', { exact: false }).waitFor();
  assert.ok((await preview.textContent()).includes(outcome));
  assert.deepEqual(writes, []);
  assert.deepEqual(searched, ['События корзины', 'События корзины']);
  await preview.getByRole('button', { name: 'Подтвердить запись' }).click();
  await page.locator('.tracker-preview').getByRole('link', { name: 'Открыть задачу · 73' }).waitFor();
  assert.equal(writes.length, 1);
  assert.ok(writes[0].includes(edited));
  assert.ok(writes[0].includes(outcome));
});
