import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createTeamApp } from '../server/team-http.mjs';
import { cases, importDocs } from '../server/evidence.mjs';
import { workInvestigation } from '../server/case-investigations.mjs';

test('May threshold card shows the observed weeks and opens their saved source rows', async t => {
  const dir = await mkdtemp(join(tmpdir(),'threshold-observation-'));
  const env = {DATA_PROFILE:'local',ADMIN_INVITE_KEY:'threshold-test'};
  const app = createTeamApp({base:join(dir,'test.sqlite'),env,background:false});
  let browser;
  t.after(async () => { await browser?.close(); await app.close(); await rm(dir,{recursive:true,force:true,maxRetries:3}); });
  await new Promise(resolve => app.server.listen(0,'127.0.0.1',resolve));
  const origin = 'http://127.0.0.1:' + app.server.address().port;
  const store = app.space('team');
  const sales = (product, values) => values.map((value,i) => ({
    kind:'sales',loc:product+'!A'+(i+1),row:{product_family:product,week_start:['2026-05-04','2026-05-11'][i],orders_index:value}
  }));
  importDocs(store,[{file:'Май.xlsx',facts:[
    {kind:'dictionary',loc:'Правило!A1',row:{metric_id:'family_orders_idx',bad_signal:'Индекс ниже 90 две недели подряд'}},
    ...sales('Astra Linux Special Edition',[42,42]),...sales('Контроль',[62,123])
  ]}],{notify:false});
  const c = cases(store.db).find(item=>item.product==='Astra Linux Special Edition');
  await workInvestigation(store,env);
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({executablePath:process.env.PM_BROWSER_PATH || (existsSync(edge)?edge:undefined)});
  const page = await browser.newPage({locale:'ru-RU',viewport:{width:390,height:844}});
  page.setDefaultTimeout(6500);
  const login = await page.request.post(origin+'/api/team/register',{data:{
    login:'threshold-pm',name:'ПМ',password:'threshold-fixture-password',code:env.ADMIN_INVITE_KEY
  }});
  assert.ok(login.ok());
  await page.goto(origin+'/#case/'+c.id);
  const section = page.getByRole('region',{name:'Исследование',exact:true});
  await section.getByRole('heading',{name:'Две недели ниже порога',exact:true}).waitFor();
  const text = await section.innerText();
  assert.match(text,/42 за 4\s*[–—-]\s*10 мая/);
  assert.match(text,/42 за 11\s*[–—-]\s*17 мая/);
  assert.match(text,/Порог — 90/);
  assert.ok(!text.includes('..'),'the localized date and sentence share one final period');
  assert.match(text,/остался на том же уровне/);
  assert.match(text,/нет полных недель/);
  assert.match(text,/пересчитается автоматически/);
  assert.ok(!text.includes('Исследование приостановлено'));
  assert.ok(!text.includes('123'));
  assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth));
  await section.getByRole('link',{name:'Посмотреть обе недели и источники'}).click();
  const source = page.locator('.investigation-finding:focus');
  await source.getByRole('cell',{name:'Май.xlsx · Astra Linux Special Edition!A1',exact:true}).waitFor();
  await source.getByRole('cell',{name:'Май.xlsx · Astra Linux Special Edition!A2',exact:true}).waitFor();
});
