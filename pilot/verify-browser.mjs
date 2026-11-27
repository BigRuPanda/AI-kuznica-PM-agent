import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright';

async function signalMail(to, caseUrl) {
  const api = 'http://127.0.0.1:18025/api/v1';
  for (let attempt = 0; attempt < 30; attempt++) {
    const response = await fetch(api + '/search?' + new URLSearchParams({query:'to:'+to}));
    assert.equal(response.status,200);
    const {messages} = await response.json();
    if (messages.length) {
      assert.equal(messages.length,1);
      const message = await (await fetch(api+'/message/'+encodeURIComponent(messages[0].ID))).json();
      assert.ok(message.Text.includes(caseUrl), 'Письмо должно содержать ссылку на этот разбор');
      return;
    }
    await new Promise(resolve => setTimeout(resolve,500));
  }
  throw Error('Приёмник не получил письмо о сигнале');
}

export async function verifyBrowser(caseUrl, to, access, product, loadRecovery) {
  await signalMail(to, caseUrl);
  const edge = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';
  const browser = await chromium.launch({headless:true, executablePath:process.env.PM_BROWSER_PATH || (existsSync(edge) ? edge : undefined)});
  const errors = [];
  async function login(role) {
    const context = await browser.newContext({locale:'ru-RU'});
    const page = await context.newPage();
    page.setDefaultTimeout(12000);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(caseUrl);
    await page.getByLabel('Логин').fill('pilot-'+role);
    await page.getByLabel('Пароль').fill(access[role+'Password']);
    await page.getByRole('button',{name:'Войти',exact:true}).click();
    await page.locator('.workspace-page[data-route="case"]').waitFor();
    return page;
  }
  async function requestByClick(page, op, button) {
    const [res] = await Promise.all([page.waitForResponse(r=>r.url().endsWith('/api/team/'+op)),button.click()]);
    const data = await res.json();
    assert.ok(res.ok(), data.error || 'Ошибка команды '+op);
    return data;
  }
  try {
    const opened = performance.now();
    const author = await login('writer');
    const create = author.getByRole('button',{name:'Подготовить задачу по сигналу'});
    const draft = await requestByClick(author,'signal-issue-draft',create);
    assert.ok(draft.diff.some(row => row.after === 'ai-generated'));
    const saved = await requestByClick(author,'confirm',author.getByRole('button',{name:'Подтвердить запись'}));
    assert.equal(saved.state,'done');
    const browserReviewMs = Math.round(performance.now() - opened);
    const peer = await login('reader');
    await peer.getByLabel('Только с меткой ai-generated').check();
    const hits = await requestByClick(peer,'issue_search',peer.getByRole('button',{name:'Найти похожие задачи'}));
    assert.ok(hits.items.some(i=>i.key===saved.key && i.origin==='ai-generated'));
    await peer.getByRole('button',{name:new RegExp('^'+saved.key+' ·')}).click();
    await peer.getByText('Происхождение задачи · ai-generated',{exact:true}).waitFor();

    const panel = author.locator('details.effect-panel');
    if (!await panel.evaluate(el => el.open)) await panel.locator('summary').first().click();
    await panel.getByLabel('Дата выкладки').fill('2026-08-17');
    assert.equal(await panel.locator('[name="kpi.metric"]').inputValue(), 'lk_reco_ctr');
    await panel.locator('[name="kpi.targetValue"]').fill('5');
    await panel.getByText('Базовый период и контроль',{exact:true}).click();
    await panel.getByLabel('Начало базы').fill('2026-07-06');
    await panel.getByLabel('Конец базы').fill('2026-08-02');
    await panel.getByLabel('Контрольный продукт').fill(product);
    await panel.getByLabel('Сегмент контроля').fill('mobile');
    await panel.getByLabel('Источник контроля').fill('metrika:78101:lk_reco_ctr');
    const pending = await requestByClick(author,'watch',panel.getByRole('button',{name:'Назначить проверку'}));
    assert.equal(pending.actual ?? null, null);
    await loadRecovery();
    await author.reload();
    await panel.waitFor({state:'attached'});
    if (!await panel.evaluate(el => el.open)) await panel.locator('summary').first().click();
    await panel.getByText('Цель достигнута',{exact:true}).first().waitFor();
    assert.match(await panel.innerText(), /5\s*\/\s*6|168\s*\/\s*2[\s\u00a0\u202f]?800/);
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({realBrowser:true,delivery:'Mailpit',roles:2,redmineIssue:saved.key,foundByFilter:true,
      browserReviewMs, recoveryPercent:6, pageErrors:errors.length}));
  } finally { await browser.close(); }
}
