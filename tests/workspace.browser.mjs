import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, cp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createTeamApp } from '../server/team-http.mjs';
import { importDocs } from '../server/evidence.mjs';
import { saveMetricRule } from '../server/metric-rules.mjs';
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

// Model and remote Redmine responses are simulated. Jobs and local tracking use SQLite.
function transport(url, options) {
  const target = new URL(url);
  if (target.hostname === 'settings-redmine.test') {
    assert.equal(options.headers['X-Redmine-API-Key'], 'fixture-personal-redmine');
    if (target.pathname === '/users/current.json') return Response.json({ user: { id: 1 } });
    assert.equal(target.pathname, '/projects/settings.json');
    return Response.json({ project: { id: 1 } });
  }
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
  const env = {...fixtureEnv, INTEGRATION_KEY:Buffer.alloc(32, 1).toString('base64url'),
    LLM_BACKEND:'api', LLM_DATA_MODE:'analysis', PYTHON_BIN:process.env.PYTHON_BIN,
    LLM_BASE_URL:'http://localhost/v1', LLM_MODEL:'fixture'};
  const start = () => createTeamApp({base:join(dir,'releases.sqlite'), background:false, env, send:transport});
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
    await go(admin,'cases/settings');
    await visible(role(admin,'Пригласить участника'));
    assert.equal(await admin.getByRole('link',{name:'Настройки команды'}).getAttribute('aria-current'),'page');
    for (const name of ['Подключения команды','Правило уведомления','Мониторинг продуктовых метрик','Доставка уведомлений'])
      await visible(admin.getByRole('heading',{name}));
    assert.equal(await role(admin,'Сверху').count(),0);
    assert.equal(await role(admin,'Выпустить ключ MCP').count(),0);
    await submit(admin,'invite',()=>role(admin,'Пригласить участника').click());
    await visible(admin.locator('.notice').filter({hasText:/\/#join\//}));
    const teamMode = field(admin,'Режим исследований по сигналам');
    assert.equal(await teamMode.inputValue(),'roles');
    await teamMode.selectOption('review');
    await submit(admin,'save-research-settings',()=>role(admin,'Сохранить режим').click());
    await go(member,'settings');
    await visible(member.getByText('Ведущий и рецензент',{exact:true}));
    assert.equal(await role(member,'Сохранить режим').count(),0);
    await member.getByRole('link',{name:'Мои настройки'}).click();
    const personalMode = field(member,'Режим моих поручений');
    assert.equal(await personalMode.inputValue(),'inherit');
    assert.equal(await member.getByRole('link',{name:'Мои настройки'}).getAttribute('aria-current'),'page');
    assert.equal(await personalMode.locator('option[value="inherit"]').textContent(),'Как у команды · Ведущий и рецензент');
    await personalMode.selectOption('lead');
    await submit(member,'save-research-settings',()=>role(member,'Сохранить режим').click());
    await member.reload();
    assert.equal(await personalMode.inputValue(),'lead');
    await teamMode.selectOption('roles');
    await submit(admin,'save-research-settings',()=>role(admin,'Сохранить режим').click());
    await personalMode.selectOption('inherit');
    await submit(member,'save-research-settings',()=>role(member,'Сохранить режим').click());
    await admin.getByRole('link',{name:'Мои настройки'}).click();
    await visible(field(admin,'Режим моих поручений'));
    assert.equal(await role(admin,'Пригласить участника').count(),0);
    assert.equal(await admin.getByRole('heading',{name:'Правило уведомления'}).count(),0);
    await submit(admin,'mcp-key',()=>role(admin,'Выпустить ключ MCP').click());
    await visible(admin.locator('.notice').filter({hasText:/^Персональный ключ MCP/}));
    await submit(admin,'bind',()=>role(admin,'Привязать Telegram').click());
    await visible(admin.locator('.notice').filter({hasText:/^\/start /}));
    await role(admin,'Сверху').click();
    await admin.locator('[data-menu=top]').waitFor();
    await admin.reload();
    await admin.locator('[data-menu=top]').waitFor();
    await role(admin,'Слева').click();
    await visible(admin.getByRole('heading',{name:'Личные подключения'}));
    await go(admin,'sources');
    await visible(role(admin,'Загрузить и пересчитать'));
    await go(member,'sources');
    assert.equal(await role(member,'Загрузить и пересчитать').count(),0);
  });

  await journey('Redmine team configuration and personal access use their own settings routes', async () => {
    const endpoint = base+'/api/team/integration-config';
    const service = 'redmine';
    const overview = await admin.request.post(base+'/api/team/overview',{data:{}});
    const previous = (await overview.json()).integrations[service];
    try {
      await go(admin,'settings');
      await admin.getByText('Адрес и назначение команды',{exact:true}).click();
      await field(admin,'Адрес сервиса').fill('https://settings-redmine.test');
      await field(admin,'Идентификатор проекта').fill('settings');
      await submit(admin,'integration-config',()=>role(admin,'Сохранить настройки команды').click());
      await visible(admin.getByText('https://settings-redmine.test · settings',{exact:true}));
      assert.equal(await role(admin,'Подключить Redmine').count(),0);

      await go(member,caseRoute);
      const connect = member.getByRole('link',{name:'Подключить личный доступ'});
      await connect.click();
      assert.equal(new URL(member.url()).hash,'#settings/personal');
      await visible(member.getByRole('heading',{name:'Личные подключения'}));
      assert.equal(await member.getByText('Адрес и назначение команды',{exact:true}).count(),0);
      await field(member,'Персональный API-ключ').fill('fixture-personal-redmine');
      await submit(member,'integration-access',()=>role(member,'Подключить Redmine').click());
      await visible(member.getByText('settings · Личный доступ подключён',{exact:true}));

      await go(admin,'settings/personal');
      await visible(admin.getByText('settings · Требуется личный доступ',{exact:true}));
      assert.equal(await role(admin,'Проверить доступ').count(),0);
      await submit(member,'integration-access',()=>role(member,'Проверить доступ').click());
      await visible(member.getByText('Redmine · Доступ подтверждён',{exact:true}));
      await submit(member,'integration-access',()=>role(member,'Отключить личный доступ').click());
      await visible(member.getByText('settings · Требуется личный доступ',{exact:true}));
    } finally {
      const restored = await admin.request.post(endpoint,{data:{service,url:previous.url || '',
        scope:previous.scope, originFieldId:previous.originFieldId}});
      assert.ok(restored.ok());
    }
  });

  await journey('the PM finds supporting and conflicting excerpts from an uploaded Excel workbook', async () => {
    const hypothesis = 'В кабинете удобно продлевать лицензию';
    const positive = 'Продлевать лицензию в кабинете удобно благодаря напоминанию.';
    const negative = 'Продлевать лицензию в кабинете неудобно из-за повторного ввода договора.';
    const rows = [
      ['Обезличенная выдержка','Дата','Исходная книга','Ячейка источника','Проверяемая гипотеза','Связь с гипотезой'],
      [positive,'2026-10-08','Интервью о лицензиях.xlsx','Ответы!C3',hypothesis,'подтверждает'],
      [negative,'2026-10-09','Интервью о лицензиях.xlsx','Ответы!C4',hypothesis,'опровергает'],
    ];
    const bin = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3');
    const xlsx = spawnSync(bin, ['tests/research-workbooks.py', '--xlsx'], { input:JSON.stringify(rows), windowsHide:true });
    if (xlsx.error) throw xlsx.error;
    assert.equal(xlsx.status,0,xlsx.stderr.toString());
    await go(admin,'sources');
    await admin.locator('input[type=file]').setInputFiles({ name:'Выдержки.xlsx',
      mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer:xlsx.stdout });
    const [uploaded] = await submit(admin,'upload',()=>role(admin,'Загрузить и пересчитать').click());
    assert.equal((await uploaded.json()).inserted,1);

    await go(member,caseRoute);
    const panel = member.locator('.interview-search');
    async function findExcerpts() {
      await panel.locator('summary').click();
      await field(panel,'Тема или цитата').fill('продлевать лицензию в кабинете');
      const [found] = await submit(member,'search',()=>role(panel,'Найти выдержки').click());
      return found.json();
    }
    const fromUploadedBook = hits => hits.filter(hit => hit.source.startsWith('Интервью о лицензиях.xlsx · '));
    const all = fromUploadedBook(await findExcerpts());
    assert.deepEqual(new Set(all.map(hit => hit.source)),
      new Set(['Интервью о лицензиях.xlsx · Ответы!C3','Интервью о лицензиях.xlsx · Ответы!C4']));
    await visible(panel.getByText(positive,{exact:true}));
    await visible(panel.getByText(negative,{exact:true}));
    await visible(panel.getByText('Гипотеза «'+hypothesis+'» · подтверждает',{exact:true}));
    await visible(panel.getByText('Гипотеза «'+hypothesis+'» · опровергает',{exact:true}));
    assert.ok(await member.evaluate(()=>document.documentElement.scrollWidth <= innerWidth));

    await member.getByText('Период расчёта',{exact:true}).click();
    await field(member,'Срез по дату включительно').fill('2026-10-08');
    await submit(member,'view',()=>role(member,'Применить период').click());
    await panel.getByText('Интервью по 2026-10-08 включительно').waitFor({state:'attached'});
    assert.deepEqual(fromUploadedBook(await findExcerpts()).map(hit => hit.data),[positive]);
    await visible(panel.getByText(positive,{exact:true}));
    assert.equal(await panel.getByText(negative,{exact:true}).count(),0);
    await field(member,'Срез по дату включительно').fill('');
    await submit(member,'view',()=>role(member,'Применить период').click());
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

  await journey('prepare a signal task, confirm it and find it from another account', async () => {
    const route = new URL(admin.url()).hash.slice(1);
    const button = role(admin, 'Подготовить задачу по сигналу');
    const [response] = await submit(admin, 'signal-issue-draft', () => button.click());
    const request = response.request().postDataJSON();
    assert.equal(request.caseId, route.split('/')[1]);
    const draft = await response.json();
    assert.equal(draft.state, 'draft');
    const card = admin.locator('#case-draft-' + draft.id);
    await admin.waitForFunction(id => document.activeElement?.id === 'case-draft-' + id, draft.id);
    await visible(card.getByText('ai-generated', {exact:true}));
    await visible(card.getByText('Сгенерирована ИИ-помощником.', {exact:false}));
    const draftUrl = base + '/api/team/signal-issue-draft';
    const repeats = await Promise.all([request, {caseId:request.caseId}].map(data => admin.request.post(draftUrl, {data})));
    for (const repeat of repeats) {
      assert.ok(repeat.ok());
      assert.equal((await repeat.json()).id, draft.id);
    }
    const stale = await admin.request.post(draftUrl, {data:{...request, revision:(request.revision ?? 0) + 1}});
    assert.equal(stale.status(), 400);
    const [saved] = await submit(admin, 'confirm', () => role(card, 'Подтвердить запись').click());
    const receipt = await saved.json();
    await visible(card.getByRole('link', {name:/Открыть задачу/}));

    await go(member, route);
    assert.equal(await member.locator('#case-draft-' + draft.id).count(), 0);
    const panel = member.locator('.task-panel');
    await field(panel, 'Поиск задач').fill(draft.title);
    await field(panel, 'Только с меткой ai-generated').check();
    await submit(member, 'issue_search', () => role(panel, 'Найти похожие задачи').click());
    const result = role(panel, receipt.key + ' · ' + draft.title + ' · ai-generated');
    await submit(member, 'issue_read', () => result.click());
    await visible(panel.getByText('Происхождение задачи · ai-generated', {exact:true}));
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

  await journey('a historical period survives reload and reaches the filter, chat, MCP and saved calculations', async () => {
    await go(admin,caseRoute);
    const options = admin.getByText('Период расчёта',{exact:true});
    await options.click();
    const from = '2026-09-07', through = '2026-09-13';
    await field(admin,'Начало периода').fill(from);
    await field(admin,'Срез по дату включительно').fill(through);
    const historicalView = full => admin.waitForResponse(r => {
      if (!r.url().endsWith('/api/team/view') || !r.ok()) return false;
      const args = r.request().postDataJSON();
      return args?.from === from && args?.through === through && args?.full === full;
    });
    const [selected] = await Promise.all([historicalView(false),role(admin,'Применить период').click()]);
    const calculated = (await selected.json()).view;
    assert.equal(calculated.base,from);
    assert.equal(calculated.cut,through);
    assert.deepEqual(calculated.summary[0].rows.map(r=>r.week),[from]);
    const filter = field(admin,'Только полные недели');
    const [filtered] = await Promise.all([historicalView(true),filter.check()]);
    const fullView = (await filtered.json()).view;
    assert.equal(fullView.cut,through);
    assert.equal(fullView.full,true);
    await Promise.all([historicalView(true),admin.reload()]);
    await options.click();
    assert.equal(await field(admin,'Начало периода').inputValue(),from);
    assert.equal(await field(admin,'Срез по дату включительно').inputValue(),through);
    assert.equal(await filter.isChecked(),true);

    const proof = admin.locator('.card-summary');
    await role(proof,'Расчёт').click();
    await visible(proof.getByText(`База с ${from},`,{exact:false}));
    const snapshot = proof.getByRole('link',{name:'Открыть версию расчёта'});
    const href = await snapshot.getAttribute('href');
    assert.equal(href,'#snapshot/'+fullView.id);
    await field(admin,'Вопрос агенту').fill('Повтори показатели с экрана.');
    const [asked] = await submit(admin,'ask',()=>role(admin,'Отправить').click());
    const { thread } = asked.request().postDataJSON();
    await workJobs(app.space('team'),app.accounts,env,transport);
    const bubble = admin.locator('.bubble.assistant').filter({hasText:'Для расчёта изменения недостаточно сопоставимых данных.'});
    await visible(bubble);
    const transcript = await admin.request.post(base+'/api/team/messages',{data:{thread}});
    assert.ok(transcript.ok());
    const reply = (await transcript.json()).items.at(-1);
    assert.equal(reply.body.calc,fullView.id);

    const keyResponse = await admin.request.post(base+'/api/team/mcp-key',{data:{}});
    assert.ok(keyResponse.ok());
    const { key } = await keyResponse.json();
    const mcp = new Client({name:'period-acceptance',version:'1'});
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'), {
        requestInit:{headers:{Authorization:'Bearer '+key}},
      }));
      const result = await mcp.callTool({name:'analyze_case',arguments:{caseId:fixture.caseId,from,through,full:true}});
      assert.ok(!result.isError,result.content[0].text);
      assert.deepEqual(JSON.parse(result.content[0].text),fullView);
    } finally { await mcp.close(); }

    await filter.uncheck();
    await field(admin,'Начало периода').fill('');
    await field(admin,'Срез по дату включительно').fill('');
    await Promise.all([
      admin.waitForResponse(r => r.url().endsWith('/api/team/view') && r.ok() && !r.request().postDataJSON()?.through),
      role(admin,'Применить период').click(),
    ]);
    await go(admin,href.slice(1));
    await visible(admin.getByRole('heading',{name:'Сохранённый расчёт'}));
    await role(proof,'Расчёт').click();
    await visible(proof.getByText('срез по '+through,{exact:false}));
    await visible(proof.getByText('Только полные недели.',{exact:false}));
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
    await workJobs(store,app.accounts,env,transport);
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

  await journey('the same investigation shows the withdrawn signal and its source revisions', async () => {
    const store = app.space('team');
    const product = 'Команда проверки пересчёта';
    const file = 'BI · пересчёт.xlsx';
    const bin = env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3');
    async function upload(name, sheet, rows) {
      const xlsx = spawnSync(bin,['tests/research-workbooks.py','--xlsx',sheet],{
        input:JSON.stringify(rows),windowsHide:true,
      });
      if (xlsx.error) throw xlsx.error;
      assert.equal(xlsx.status,0,xlsx.stderr.toString());
      await go(admin,'sources');
      await admin.locator('input[type=file]').setInputFiles({
        name,mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:xlsx.stdout,
      });
      const [response] = await submit(admin,'upload',()=>role(admin,'Загрузить и пересчитать').click());
      return response.json();
    }
    const sales = value => [
      ['product_family','week_start','orders_index'],
      [product,'2026-11-02',value],
      [product,'2026-11-09',value],
    ];
    await upload('BI · порог.xlsx','Метрики_справочник',[
      ['metric_id','bad_signal'],['family_orders_idx','Индекс ниже 90 две недели подряд'],
    ]);
    assert.equal((await upload(file,'Продажи',sales(70))).inserted,1);
    const {id} = store.db.prepare('SELECT id FROM cases WHERE product=?').get(product);
    await go(admin,'case/'+id);
    const investigation = admin.locator('.investigation-head');
    await visible(investigation.getByRole('heading', {level:1}).filter({hasText:product}));
    await visible(investigation.getByText('Команда',{exact:true}));
    const route = admin.url();
    assert.equal((await upload(file,'Продажи',sales(100))).inserted,1);
    assert.equal((await upload(file,'Продажи',sales(100))).inserted,0);
    await go(admin,'case/'+id);
    assert.equal(admin.url(),route);
    await visible(investigation.getByRole('status').filter({hasText:'Сигнал отозван после пересчёта'}));
    const history = admin.locator('.signal-history');
    await history.getByText('История сигнала',{exact:true}).click();
    const rows = history.locator('li');
    await visible(rows.first());
    assert.equal(await rows.count(),2);
    assert.match(await rows.nth(0).textContent(),/Отозван.*BI · пересчёт\.xlsx/);
    assert.match(await rows.nth(1).textContent(),/Подтверждён.*70 п\. индекса.*BI · пересчёт\.xlsx/);
    assert.notEqual(await rows.nth(0).locator('small').getAttribute('title'),await rows.nth(1).locator('small').getAttribute('title'));
  });

  await journey('CTR signal, absolute target and saved versions work through the browser and HTTP MCP', async () => {
    const store = app.space('team');
    const metric = 'lk_reco_ctr', product = 'ЛК проверки CTR', sourceId = 'fixture-ctr';
    const week = index => new Date(Date.UTC(2026, 5, 1 + index * 7)).toISOString().slice(0, 10);
    const rollout = week(6);
    const report = (i, segment, numerator, denominator = 100) => ({
      kind: 'metrics', loc: segment + '/' + week(i), row: {
        product, segment, date: week(i), source_id: sourceId, metric_id: metric, unit: 'ratio',
        numerator, denominator, value: 0.99,
      },
    });
    const load = facts => importDocs(store, [{file:'CTR для приёмки.xlsx',facts}], {notify:false});
    const releaseId = 'Размещение рекомендаций';
    load([{kind:'releases',loc:'A1',row:{release_id:releaseId,release_date:week(4),product_family:product}}]);
    saveMetricRule(store.db, {metric, product, sourceId, segment:'desktop', releaseId});
    load(Array.from({length:6}, (_, i) => [report(i, 'desktop', i < 4 ? 10 : 3), report(i, 'mobile', 8)]).flat());
    const autoCase = store.db.prepare("SELECT id FROM cases WHERE product=?").get(product).id;
    await go(admin,'cases');
    await admin.locator('a[href="#case/' + autoCase + '"]').click();
    const panel = admin.locator('.effect-panel');
    await panel.locator(':scope > summary').click();
    await panel.getByText('Базовый период и контроль', {exact:true}).click();
    await field(panel,'Дата выкладки').fill(rollout);
    await field(panel,'Целевое значение, %').fill('5');
    await field(panel,'Контрольный продукт').fill(product);
    await field(panel,'Сегмент контроля').fill('mobile');
    const [scheduled] = await submit(admin,'watch',()=>role(panel,'Назначить проверку').click());
    const first = await scheduled.json();
    assert.equal(first.target,5);
    assert.equal(first.unit,'%');
    assert.equal(first.actual,null);
    assert.equal(first.revision,1);
    await visible(panel.getByText('Недостаточно данных',{exact:true}));
    assert.equal(await admin.locator('.card-trend').count(),0);

    const keyResponse = await admin.request.post(base+'/api/team/mcp-key',{data:{}});
    assert.ok(keyResponse.ok());
    const {key} = await keyResponse.json();
    const mcp = new Client({name:'ctr-browser-test',version:'1'});
    try {
      await mcp.connect(new StreamableHTTPClientTransport(new URL(base+'/mcp'),{
        requestInit:{headers:{Authorization:'Bearer '+key}},
      }));
      async function call(name, args) {
        const result = await mcp.callTool({name,arguments:args});
        assert.ok(!result.isError, result.content[0].text);
        return JSON.parse(result.content[0].text);
      }
      const missing = Array.from({length:4}, (_, j) =>
        [report(j+6,'desktop',5,j === 3 ? null : 100), report(j+6,'mobile',8)]).flat();
      load(missing);
      assert.match((await call('view',{caseId:autoCase})).effect.reason,/знаменател/);
      load([report(9,'desktop',5)]);
      const args = {caseId:autoCase};
      const achieved = await call('view',args);
      assert.deepEqual([achieved.effect.actual, achieved.effect.ctrl], [5, 0]);
      assert.deepEqual([achieved.effect.sample.n, achieved.effect.sample.d], [20, 400]);
      assert.equal(achieved.case.body.watch.measurement.definitionId,'office');
      const historical = await call('view',{...args, through:week(9)});
      assert.equal(historical.effect.actual,null);
      assert.equal(historical.effect.weeks,3);
      await admin.reload();
      await panel.locator(':scope > summary').click();
      await visible(panel.getByText('Цель достигнута',{exact:true}));
      await visible(panel.getByText('≥ 5 / 5',{exact:true}));

      const revised = await call('watch',{...args,deployed:rollout,measurement:{
        metric,comparison:'gte',targetMode:'absolute',targetValue:6,control:product,controlSegment:'mobile',
      }});
      assert.equal(revised.revision,2);
      assert.equal(revised.state,'Цель не достигнута');
      const updated = await call('view',args);
      const [{calc}] = updated.case.body.watchHistory;
      assert.equal((await call('calc',{id:calc})).monitoring.result.target,5);
      assert.equal((await call('calc',{id:achieved.view.id})).monitoring.result.state,'Цель достигнута');
      await admin.reload();
      await panel.locator(':scope > summary').click();
      await visible(panel.getByText('Цель не достигнута',{exact:true}));
      await panel.getByText('Прошлые проверки',{exact:true}).click();
      await panel.getByRole('link',{name:'Версия 1 · '+rollout}).click();
      await visible(admin.locator('.card-watch').getByText('Цель достигнута',{exact:true}));

      await go(admin,'cases');
      await role(admin,'Новый разбор').click();
      const editor = admin.locator('form').filter({has:role(admin,'Создать личный разбор')});
      await field(editor,'Вопрос или гипотеза').fill('Гипотеза с критерием до выкладки');
      await field(editor,'Продукт').fill(product);
      await editor.getByText('Гипотеза и критерии до разработки',{exact:true}).click();
      await field(editor,'Целевая метрика').selectOption(metric);
      await field(editor,'Сегмент ряда').fill('desktop');
      await field(editor,'Целевое значение, %').fill('5');
      const [created] = await submit(admin,'create-case',()=>role(editor,'Создать личный разбор').click());
      const {id} = await created.json();
      const personal = await call('watch',{caseId:id,deployed:rollout});
      assert.equal(personal.state,'Цель достигнута');
      assert.equal(personal.actual,5);
    } finally {
      await mcp.close();
    }
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
