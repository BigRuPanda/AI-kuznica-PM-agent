import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { createTeamApp } from '../server/team-http.mjs';
import { workJobs } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { readMaterial } from '../server/materials.mjs';
import { seedWorkspace, fixtureEnv } from './workspace-fixture.mjs';

const role = (p, name) => p.getByRole('button', { name, exact: true });
const field = (p, name) => p.getByLabel(name);
const visible = locator => locator.waitFor({ state: 'visible' });
const submit = (page, operation, click) => Promise.all([
  page.waitForResponse(r => r.url().endsWith('/api/team/' + operation) && r.ok()), click()
]);

// Only the model is simulated. Both web APIs, jobs, persistence and local tracking use SQLite.
function model(url, options) {
  assert.equal(String(url), 'http://localhost/v1/chat/completions');
  const req = JSON.parse(options.body);
  const respond = message => Response.json({choices: [{message}]});
  const tool = (name, args) => respond({tool_calls: [{id: 'fixture', type: 'function', function: {
    name, arguments: JSON.stringify(args)
  }}]});
  if (req.tools?.some(t => t.function.name === 'selection_context') && req.messages.at(-1).role !== 'tool')
    return tool('search', {query:'Kaspersky', kinds:['interview']});
  if (req.tools?.[0]?.function.name === 'record_findings')
    return tool('record_findings', {summary:'Проверка релиза.', highlights:[], intervals:[]});
  if (req.tools?.some(t => t.function.name === 'build_chart') && req.messages.at(-1).role !== 'tool')
    return tool('build_chart', {spec: {title:'Время до оплаты', field:'duration', stat:'median', start:'invoice', end:'payment'}});
  return respond({content:'Расчёт проверен по сохранённым данным.'});
}

test('Softline workspace, upgrade and browser journeys', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'softline-workspace-'));
  let app, browser;
  t.after(async () => {
    try { await browser?.close(); }
    finally {
      await app?.close();
      await rm(dir, {recursive:true, force:true, maxRetries:3});
    }
  });
  const original = process.env.PM_UI_BASELINE;
  let fixture;
  if (original) {
    fixture = JSON.parse(await readFile(join(original, 'baseline.json'), 'utf8'));
    for (const name of ['releases.sqlite','accounts.sqlite','workspaces'])
      await cp(join(original, name), join(dir, name), {recursive:true});
  } else fixture = await seedWorkspace(dir);
  const env = {...fixtureEnv, LLM_BACKEND:'api', LLM_DATA_MODE:'analysis',
    LLM_BASE_URL:'http://localhost/v1', LLM_MODEL:'fixture'};
  const start = () => createTeamApp({base:join(dir,'releases.sqlite'), background:false, env, send:model});
  for (let n = 0; n < 2; n++) {
    const app = start();
    try {
      const store = app.space('team');
      const user = (await app.accounts.login({login:'fixture-admin',password:'fixture-password'})).user;
      assert.deepEqual(workspaceOperation(store,user,'calc',{id:fixture.calc}).summary, fixture.summary);
      assert.deepEqual(workspaceOperation(store,user,'range_read',{id:fixture.range}).periods, fixture.periods);
      assert.equal(readMaterial(store.db,user,fixture.report).children[0].id, fixture.chart);
      assert.match(store.db.prepare("SELECT sql FROM sqlite_schema WHERE name='chat_items'").get().sql,/AUTOINCREMENT/);
      assert.equal(store.db.prepare('PRAGMA integrity_check').get().integrity_check,'ok');
    } finally { await app.close(); }
  }
  app = start();
  await new Promise((ok, fail) => app.server.once('error',fail).listen(0,'127.0.0.1',ok));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  assert.equal((await (await fetch(base+'/health')).json()).ok,true);
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  browser = await chromium.launch({headless:true, executablePath:
    process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined)});
  const errors = [];
  async function login(user, route, options={}) {
    const ctx = await browser.newContext({locale:'ru-RU', viewport:{width:1440,height:900},...options});
    const p = await ctx.newPage();
    p.setDefaultTimeout(10000);
    p.on('pageerror', err => errors.push(err.message));
    await p.goto(base + '/' + route);
    await field(p,'Логин').fill('fixture-'+user);
    await field(p,'Пароль').fill('fixture-password');
    await role(p,'Войти').click();
    await visible(p.locator('.session-role'));
    return p;
  }
  const admin = await login('admin','#material/'+fixture.report);
  const member = await login('member','#material/'+fixture.report, {
    viewport:{width:390,height:844}, reducedMotion:'reduce',colorScheme:'dark'
  });
  const judge = await login('judge','#overview');
  const go = async (p, hash) => {
    await p.goto(base+'/#'+hash);
    await p.locator('.workspace-page[data-route="'+hash.split('/')[0]+'"]').waitFor();
  };
  const caseRoute = 'case/'+fixture.caseId;
  const journey = (name, run) => t.test(name, async () => {
    try { await run(); }
    catch (error) {
      const alerts = await admin.getByRole('alert').allTextContents();
      console.error(name, admin.url(), alerts, error.message);
      throw error;
    }
  });

  await journey('old links, personal access, navigation and themes', async () => {
    await visible(admin.getByRole('heading',{name:'Исходный отчёт'}));
    await visible(member.getByText('Снимок недоступен', {exact:false}).first());
    await go(member, 'snapshot/'+fixture.calc+'/trend');
    await visible(member.locator('.card-trend'));
    assert.equal(await member.locator('.card-summary').count(),0);
    assert.equal(await member.locator('html').getAttribute('data-theme'),'dark');
    await role(member,'Тёмная тема').click();
    assert.equal(await member.locator('html').getAttribute('data-theme'),'light');
    assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
    await visible(judge.getByText('Демо · жюри',{exact:true}));
    await go(admin,'settings');
    await role(admin,'Сверху').click();
    await admin.locator('[data-menu=top]').waitFor();
    await role(admin,'Слева').click();
    await visible(admin.getByRole('heading',{name:'Подключения'}));
    await go(admin,'sources');
    await visible(role(admin,'Загрузить и пересчитать'));
    await go(member,'sources');
    assert.equal(await role(member,'Загрузить и пересчитать').count(),0);
  });

  await journey('signal, publication to the team and effect monitoring', async () => {
    await go(admin,'overview');
    await admin.getByRole('link',{name:'Открыть разбор'}).first().click();
    await visible(admin.locator('.investigation-head .state'));
    await role(admin,'Поделиться').click();
    const dialog=admin.getByRole('dialog');
    await visible(dialog.getByText('Команда Store',{exact:false}));
    await field(dialog,'Вывод для команды').fill('Вывод для приёмки');
    await submit(admin,'publish',()=>role(dialog,'Опубликовать').click());
    await go(member,'chats/group');
    await visible(member.getByText('Вывод для приёмки',{exact:false}).first());
    await admin.locator('summary').filter({hasText:'Проверка эффекта'}).click();
    await field(admin,'Дата выкладки').fill('2026-12-07');
    await submit(admin,'watch',()=>role(admin,'Назначить проверку').click());
    await visible(admin.getByText('Полные недели, продукт / контроль'));
    await visible(admin.getByText('Ожидаем данные после исправления'));
  });

  await journey('Redmine works directly while saved Confluence pages stay hidden', async () => {
    for (const p of [admin,member,judge]) {
      await go(p,'settings');
      await visible(p.getByRole('heading',{name:'Redmine',exact:true}));
      assert.equal(await p.getByText(/Confluence/i).count(),0);
    }
    await go(admin,caseRoute);
    const panel=admin.locator('.task-panel');
    await visible(panel.getByRole('heading',{name:'Задачи Redmine'}));
    assert.equal(await panel.getByRole('button',{name:/^(Redmine|Confluence)$/}).count(),0);
    const draft=admin.locator('.tracker-preview').filter({hasText:'Исходный черновик'});
    await submit(admin,'confirm',()=>role(draft,'Подтвердить запись').click());
    const issue=draft.getByRole('link',{name:/Открыть задачу/});
    await visible(issue);
    const issueHref=await issue.getAttribute('href');
    // Create representative existing data through the unchanged authenticated API.
    async function post(op,data) {
      const res=await admin.request.post(base+'/api/team/'+op,{data});
      assert.ok(res.ok(),op);
      return res.json();
    }
    const page=await post('page_draft',{caseId:fixture.caseId,title:'Результаты приёмки',
      content:'Проверено по двум периодам.',issueKey:issueHref.split('/').at(-1)});
    const receipt=await post('confirm',{id:page.id,revision:page.revision});
    assert.equal((await post('page_read',{key:receipt.key})).title,'Результаты приёмки');
    await admin.reload();
    await visible(issue);
    assert.equal(await panel.getByText('Результаты приёмки').count(),0);
    await issue.click();
    await visible(admin.getByRole('heading',{name:'Исходный черновик'}));
    assert.equal(await admin.getByText(/Confluence/i).count(),0);
    assert.equal(await admin.locator('a[href*="#demo-page/"]').count(),0);
    await go(member,caseRoute);
    await visible(member.locator('a[href="'+issueHref+'"]'));
    assert.equal(await member.getByText('Результаты приёмки').count(),0);
    let pageReads=0;
    admin.on('request',r=>{if(r.url().endsWith('/page_read')) pageReads++;});
    await admin.goto(base+'/'+receipt.url);
    await visible(admin.getByRole('heading',{name:'Разборы',exact:true}));
    assert.equal(pageReads,0);
    app.space('team').db.prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES(?,?,'assistant',?,?)")
      .run(fixture.thread,'Помощник',JSON.stringify({text:'Проверка завершена. [Документ]('+receipt.url+')',steps:['issue_read','page_read'],
        actions:[{op:'page_draft',id:page.id,title:'Результаты приёмки'}]}),Date.now());
    await go(admin,'chats/'+fixture.thread);
    const msg=admin.locator('.bubble').filter({hasText:'Проверка завершена.'});
    await msg.getByText('Выполненные проверки').click();
    await visible(msg.getByText('Прочитана задача'));
    assert.equal(await msg.getByRole('link',{name:'Документ'}).count(),0);
    assert.equal(await msg.getByText(/Прочитана страница|Результаты приёмки/).count(),0);
    await go(judge,issueHref.slice(1));
    await visible(judge.getByRole('alert').first());
  });

  await journey('A/B, resumable research, pin, delete, reopen and explicitly share', async () => {
    await go(admin,'snapshot/'+fixture.calc+'/trend');
    const plot = admin.locator('.range-plot svg').first();
    await plot.focus(); await plot.press('Home'); await plot.press('Space'); await plot.press('Shift+ArrowRight');
    await role(admin,'Добавить период для сравнения').click();
    await plot.focus(); await plot.press('End'); await plot.press('Space'); await plot.press('Shift+ArrowLeft');
    await role(admin,'Спросить о выделении').click();
    await visible(admin.locator('.range-attachment'));
    await field(admin,'Вопрос агенту').fill('Проверь соседний период и разбери причины изменения индекса заказов.');
    await submit(admin,'ask',()=>role(admin,'Отправить').click());
    const store=app.space('team');
    await workJobs(store,app.accounts,env,async()=>new Response('', {status:401}));
    await submit(admin,'resume-job',()=>role(admin,'Продолжить с сохранённого шага').click());
    await workJobs(store,app.accounts,env,model);
    const reply = JSON.parse(store.db.prepare("SELECT body FROM chat_items WHERE thread=? AND role='assistant' ORDER BY seq DESC LIMIT 1").get(admin.url().split('/').at(-1)).body);
    assert.equal(reply.outcome, 'done', reply.warning || reply.text);
    await role(admin,'Продолжить с сохранённого шага').waitFor({state:'hidden'});
    const report=admin.locator('.bubble.assistant .material-card.report').first();
    await visible(report);
    const href=await report.locator('a.material-preview').getAttribute('href');
    await role(report,'Добавить в разбор').click();
    const dialog=admin.getByRole('dialog');
    await dialog.locator('select').selectOption(fixture.caseId);
    await submit(admin,'pin-material',()=>role(dialog,'Добавить в разбор').click());
    await dialog.waitFor({state:'hidden'});
    await admin.locator('.conversation-heading .thread-menu-trigger').click();
    await admin.getByRole('menuitem',{name:/Удалить/}).click();
    await submit(admin,'delete-thread',()=>role(admin.getByRole('dialog'),'Удалить чат').click());
    await go(admin,caseRoute);
    await admin.locator('a[href="'+href+'"]').first().click();
    await visible(admin.getByRole('dialog').locator('.material-detail'));
    await admin.keyboard.press('Escape');
    await go(admin,'chats/'+fixture.thread);
    await admin.locator('.conversation-heading .thread-menu-trigger').click();
    await admin.getByRole('menuitem',{name:/Удалить/}).click();
    await submit(admin,'delete-thread',()=>role(admin.getByRole('dialog'),'Удалить чат').click());
    await go(admin,'material/'+fixture.report);
    await admin.locator('a[href="#material/'+fixture.chart+'"]').click();
    await visible(admin.getByRole('dialog').locator('.range-plot svg'));
    await go(member,'material/'+fixture.chart);
    await visible(member.getByText('Снимок недоступен',{exact:false}).first());
    await go(admin,'chats/group');
    await field(admin,'Вопрос агенту').fill('Отчёт '+base+'/#material/'+fixture.report);
    await admin.getByRole('checkbox',{name:/Открыть участникам/}).check();
    await submit(admin,'say',()=>role(admin,'Написать команде').click());
    await go(member,'material/'+fixture.report);
    await member.locator('a[href="#material/'+fixture.chart+'"]').click();
    await visible(member.getByRole('dialog').locator('.range-plot svg'));
  });

  await journey('CSV import, release, saved calculation and dashboard in the same shell', async () => {
    await admin.goto(base+'/?legacy=1#releases');
    await visible(admin.locator('#workspace-sidebar'));
    await role(admin,'Импорт CSV').click();
    let dlg=admin.getByRole('dialog');
    await field(dlg,'Название набора').fill('События для приёмки');
    await field(dlg,'CSV с событиями').setInputFiles({
      name:'events.csv',mimeType:'text/csv',buffer:await readFile(new URL('../demo/events.csv',import.meta.url))
    });
    await field(dlg,'Данные полны по дату и время, МСК').fill('2026-11-23T10:00');
    await role(dlg,'Импортировать').click();
    await dlg.waitFor({state:'hidden'});
    await role(admin,'Добавить релиз').click();
    dlg=admin.getByRole('dialog');
    await field(dlg,'Набор данных').selectOption({label:'События для приёмки'});
    await field(dlg,'Название').fill('Релиз приёмки');
    await field(dlg,'Что изменилось').fill('Проверка счетов');
    await field(dlg,'Включение для пользователей, МСК').fill('2026-11-02T10:00');
    await field(dlg,'Аудитория').fill('Компании');
    await field(dlg,'Главный вопрос').fill('Сколько дней до оплаты?');
    await role(dlg,'Создать релиз').click();
    await visible(admin.getByRole('heading',{name:'Релиз приёмки',exact:true}));
    await field(admin,'Спросить агента').fill('Сколько дней до оплаты? Построй график.');
    await role(admin,'Отправить вопрос').click();
    await admin.getByRole('button',{name:/Раскрыть график/}).first().click();
    dlg=admin.getByRole('dialog');
    await field(dlg,'Дашборд релиза').fill('Проверенные расчёты');
    await role(dlg,'Сохранить в релиз').click();
    await visible(dlg.getByText('Сохранено',{exact:true}));
    const calc=await dlg.getByRole('link',{name:/Источник расчёта/}).getAttribute('href');
    await admin.keyboard.press('Escape');
    await dlg.waitFor({state:'hidden'});
    await field(admin,'Дашборд').selectOption('Проверенные расчёты');
    await visible(admin.getByRole('heading',{name:'Проверенные расчёты'}));
    await go(admin,calc.slice(1));
    await visible(admin.getByRole('heading',{name:'Сохранённый расчёт'}));
    await visible(admin.locator('#workspace-sidebar'));
    await member.goto(base+'/?legacy=1#release/R-001');
    await visible(member.locator('.report-head h1'));
    assert.equal(await role(member,'Импорт CSV').count(),0);
  });
  await journey('judge writes in an isolated demo and mobile attachment returns to its conversation', async () => {
    await go(judge,'overview');
    await judge.getByRole('link',{name:'Открыть разбор'}).first().click();
    await field(judge,'Заголовок').fill('Задача из пространства жюри');
    await submit(judge,'draft',()=>role(judge,'Подготовить черновик задачи').click());
    const draft = judge.locator('.tracker-preview').filter({hasText:'Задача из пространства жюри'});
    await submit(judge,'confirm',()=>role(draft,'Подтвердить запись').click());
    const link = draft.getByRole('link',{name:/Открыть задачу/});
    await visible(link);
    const href = await link.getAttribute('href');
    await link.click();
    await visible(judge.getByRole('heading',{name:'Задача из пространства жюри'}));
    await go(member,caseRoute);
    await role(member,'Обсудить').click();
    await visible(field(member,'Вопрос агенту'));
    await role(member,'К разбору').click();
    await visible(member.locator('.case-main'));
    await go(member,'material/'+fixture.chart);
    await role(member,'Добавить в разбор').click();
    const dlg = member.getByRole('dialog');
    await dlg.locator('select').selectOption(fixture.caseId);
    await submit(member,'pin-material',()=>role(dlg,'Добавить в разбор').click());
    await go(member,caseRoute);
    await member.locator('a[href="#material/'+fixture.chart+'"]').click();
    const detail = member.getByRole('dialog');
    const intact = await detail.locator('td').evaluateAll(cells => cells
      .filter(cell => /^[-+]?\d+(?:[,.]\d+)?$/.test(cell.textContent.trim()))
      .every(cell => {
        const range=document.createRange();
        range.selectNodeContents(cell);
        return range.getClientRects().length <= 1;
      }));
    assert.ok(intact, 'Числа таблицы должны помещаться на одной строке');
    await role(detail,'Приложить к сообщению').click();
    await visible(member.locator('.chat-composer .range-attachment'));
    assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));
    await go(admin,href.slice(1));
    // Separate demo databases can both allocate the same local issue number.
    assert.equal(await admin.getByRole('heading',{name:'Задача из пространства жюри'}).count(),0);
  });

  await journey('standalone demo preserves release selection, filters, themes and discussion', async () => {
    const demo = await browser.newPage();
    try {
      const file = new URL('../prototype/index.html',import.meta.url);
      file.hash='R-001';
      await demo.goto(file.href);
      await visible(demo.locator('[data-slot=title]'));
      const title = await demo.locator('[data-slot=title]').textContent();
      await demo.locator('[data-filter=segment]').selectOption('returning');
      await demo.locator('[data-filter=date]').selectOption('7');
      await role(demo,'Тёмная тема').click();
      assert.equal(await demo.locator('html').getAttribute('data-theme'),'dark');
      await demo.locator('.composer input').fill('Что изменилось?');
      await role(demo,'Спросить').click();
      await visible(demo.locator('.chat-log .message').last());
      await demo.locator('.release-link').filter({hasText:'R-002'}).click();
      assert.notEqual(await demo.locator('[data-slot=title]').textContent(),title);
      await demo.reload();
      assert.ok(demo.url().endsWith('#R-002'));
    } finally { await demo.close(); }
  });
  assert.deepEqual(errors,[]);
});
