import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createTeamApp } from '../server/team-http.mjs';
import { importDocs } from '../server/evidence.mjs';
import { createThread, enqueue, workJobs } from '../server/workbench.mjs';
import { fixtureEnv, seedWorkspace } from './workspace-fixture.mjs';

test('archive chat opens the cited workbook version after the active source changes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'archive-chat-'));
  let app, browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      await app?.close();
      await rm(dir, { recursive:true, force:true, maxRetries:3 });
    }
  });
  await seedWorkspace(dir);
  app = createTeamApp({ base:join(dir, 'releases.sqlite'), background:false, env:fixtureEnv });
  await new Promise((resolve, reject) => app.server.once('error',reject).listen(0,'127.0.0.1',resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const store = app.space('team');
  const { user } = await app.accounts.login({ login:'fixture-admin', password:'fixture-password' });
  const load = value => importDocs(store, [{ file:'Archive-week.xlsx', facts:[{
    kind:'sales', loc:'Sales!A2',
    row:{ product_family:'ArchiveProduct', week_start:'2026-04-06', orders_index:value },
  }] }], { notify:false });
  load(33);
  const old = store.db.prepare("SELECT version FROM facts WHERE file='Archive-week.xlsx'").get().version;
  const thread = createThread(store.db,user,'Архив');
  enqueue(store,user,{ thread, question:'Какой индекс заказов ArchiveProduct за неделю с 6 апреля 2026?' });
  await workJobs(store,app.accounts,fixtureEnv,()=>assert.fail('Archive lookup should be local'));
  load(99);

  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({ headless:true, executablePath:process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined) });
  const page = await browser.newPage();
  await page.goto(base + '/#chats/' + thread);
  await page.getByLabel('Логин').fill('fixture-admin');
  await page.getByLabel('Пароль').fill('fixture-password');
  await page.getByRole('button',{ name:'Войти', exact:true }).click();
  const reply = page.locator('.bubble.assistant').filter({ hasText:'2026-04-06 — 33' });
  const source = reply.getByRole('link',{ name:'Archive-week.xlsx · Sales!A2', exact:true });
  assert.equal(await source.getAttribute('href'),'#knowledge-source/'+old+'/Sales!A2');
  await source.click();
  await page.waitForURL('**/#knowledge-source/'+old+'/Sales!A2');
  await page.getByRole('heading',{ name:'Archive-week.xlsx' }).waitFor();
  await page.getByText('Sales!A2',{ exact:true }).waitFor();
  const value = page.getByText(/orders_index = 33\b/u);
  await value.waitFor();
  assert.equal(await page.getByText(/orders_index = 99\b/u).count(),0);
});
