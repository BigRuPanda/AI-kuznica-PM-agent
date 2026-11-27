import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs } from '../server/evidence.mjs';
import { initWorkbench, createThread, enqueue, workJobs, messages, answer } from '../server/workbench.mjs';
import { marketOffers } from '../server/market-offers.mjs';
import { checkOffer, sellerUrl } from '../server/competitor-check.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { webAnswer, webQuestion } from '../server/web-search.mjs';

const env = { YANDEX_SEARCH_API_KEY: 'fixture', YANDEX_SEARCH_FOLDER_ID: 'folder', PYTHON_BIN: process.env.PYTHON_BIN };
const user = { id: 'reviewer', name: 'Продакт' };
const url = 'https://allsoft.ru/software/vendors/test/12345/';
const offer = { product: 'Kaspersky Endpoint Security', merchant: 'allsoft.ru', sku: 'KL4863RAKFS',
  checked: '2026-10-27', storePrice: 33182.1, competitorPrice: 36870, match: 'Да',
  license: '/стандартная', terms: '1 год/от 10 до 14' };
function workspace(t) {
  const store = openStore(':memory:');
  initEvidence(store.db);
  initWorkbench(store.db);
  importDocs(store, [{ file: 'Research.xlsx', facts: [
    { kind: 'competitor', text: 'allsoft.ru · ' + url, loc: '03_Цена!A86', comparison: offer },
  ] }]);
  t.after(() => store.close());
  return store;
}
const html = body => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
const yandex = xml => Response.json({ rawData: Buffer.from(xml).toString('base64') });
const result = '<yandexsearch><response><results><grouping><group><doc><url>https://museum.example/exhibition</url><title>Выставка &amp; музей</title><passages><passage>Открыта <hlword>новая</hlword> выставка.</passage></passages></doc></group></grouping></results></response></yandexsearch>';

test('any topic in queued chat uses Yandex, then the configured model, and cites real result URLs', async t => {
  const store = workspace(t), thread = createThread(store.db, user, 'Поиск');
  const model = { ...env, LLM_BASE_URL: 'http://localhost:9123/v1', LLM_MODEL: 'qwen' };
  const calls = [];
  const send = async (target, init) => {
    calls.push(String(target));
    const data = JSON.parse(init.body);
    if (calls.length === 1) {
      assert.equal(init.headers.Authorization, 'Api-Key fixture');
      assert.equal(data.query.queryText, 'выставки в Казани');
      assert.equal(data.folderId, 'folder');
      return yandex(result);
    }
    assert.equal(data.model, 'qwen');
    assert.ok(data.max_tokens > 0 && data.max_tokens <= 160);
    assert.match(data.messages.at(-1).content, /Открыта новая выставка/);
    assert.doesNotMatch(JSON.stringify(data), /Research.xlsx|KL4863/);
    return Response.json({ choices: [{ message: { content: 'Открыта новая выставка [1].' } }] });
  };
  enqueue(store, user, { thread, question: 'выставки в Казани', webSearch: true });
  await workJobs(store, { publicUser: () => user }, model, send);
  const body = messages(store.db, user, thread).items.at(-1).body;
  assert.equal(calls.length, 2);
  assert.equal(body.outcome, 'done');
  assert.equal(body.text, 'Открыта новая выставка [1].');
  assert.deepEqual(body.readSources, [{ url: 'https://museum.example/exhibition', label: '[1] Выставка & музей' }]);
  assert.equal(body.webSearchCount, 1);
  assert.equal(webQuestion('Найди задачу в Redmine'), null);
  assert.equal(webQuestion('Не ищи в интернете'), null);
});

test('requests for a website link return the first search result without waiting for model narration', async t => {
  const store=workspace(t);
  let calls=0;
  const response=await webAnswer(store,'lookup','Официальный сайт музея',
    {...env,LLM_MODEL:'qwen',LLM_BASE_URL:'http://localhost:9123/v1'},async()=>{
      calls++;
      return yandex(result);
    });
  assert.equal(calls,1);
  assert.match(response.text,/museum\.example/u);
  assert.equal(response.readSources[0].url,'https://museum.example/exhibition');
});

test('natural language search handles no key, empty results, server error and retry without rebilling', async t => {
  const store = workspace(t), thread = createThread(store.db, user, 'Интернет');
  const b = { thread, question: 'Найди в интернете статьи о дизайне' };
  let issued = 0;
  const send = async () => { issued++; return yandex(result); };
  assert.match((await answer(store, user, b, {}, send)).text, /не подключён/);
  assert.equal(issued, 0);
  const ok = await answer(store, user, b, env, send, 'same-job');
  assert.match(ok.text, /Открыта новая выставка/);
  await answer(store, user, b, env, send, 'same-job');
  assert.equal(issued, 1);
  assert.match((await answer(store, user, b, env, async () => yandex('<root><error code="15"/></root>'))).text, /не вернул результатов/);
  assert.match((await answer(store, user, b, env, async () => new Response('', { status: 403 }))).text, /403/);
});

test('direct source link survives old imports; seller mismatch stays separate from the archive in UI and chat', async t => {
  const store = workspace(t), [row] = marketOffers(store.db, null, '2026-10-27');
  assert.equal(row.url, url);
  const args = { version: row.version, loc: row.loc };
  assert.equal(await workspaceOperation(store, user, 'competitor_check', { ...args, savedOnly: true }), null);
  const calls = [];
  const send = async target => {
    calls.push(String(target));
    return String(target) === url ? html('<title>Лицензия KL4863RPKFS</title>') : html('<title>Поиск</title>');
  };
  const [a, b] = await Promise.all([checkOffer(store.db, row, {}, send), checkOffer(store.db, row, {}, send)]);
  assert.equal(a.status, 'mismatch');
  assert.equal(a.searchRequests, 0);
  assert.deepEqual(a, b);
  const thread = createThread(store.db, user, 'Конкурент');
  const reply = await answer(store, user, { thread, question: 'Проверь предложение Allsoft по артикулу KL4863RAKFS' }, {}, send);
  assert.equal(reply.mode, 'competitor-check');
  assert.match(reply.text, /KL4863RPKFS/);
  assert.equal(reply.readSources[1].url, url);
  assert.equal(calls.length, 2);
  assert.deepEqual(marketOffers(store.db, null, '2026-10-26'), []);
  assert.equal(marketOffers(store.db, null, '2026-10-27')[0].competitorPrice, 36870);
});

test('free seller search recovers the exact card and confirms comparable terms and price per copy', async t => {
  const store = workspace(t), [row] = marketOffers(store.db, null, '2026-10-27');
  const next = 'https://allsoft.ru/software/vendors/test/98765/';
  const item = { '@type': 'Product', name: 'Стандартная лицензия, 1 год, от 10 до 14, цена за копию',
    sku: offer.sku, offers: { '@type': 'Offer', price: 3600, priceCurrency: 'RUB' } };
  const found = await checkOffer(store.db, row, env, async target => {
    if (target === url) return new Response('', { status: 404 });
    if (target.includes('/search/')) return html('<a href="' + next + '">Лицензия</a>');
    assert.equal(target, next);
    return html('<script type="application/ld+json">' + JSON.stringify(item) + '</script>');
  });
  assert.equal(found.status, 'confirmed');
  assert.equal(found.price, 3600);
  assert.equal(found.unit, 'за копию');
  assert.equal(found.searchRequests, 0);
});

test('Yandex fallback limits requests and only opens approved seller hosts', async t => {
  const store = workspace(t), [row] = marketOffers(store.db, null, '2026-10-27');
  let paid = 0;
  const checked = await checkOffer(store.db, row, env, async target => {
    if (target.includes('searchapi.api.cloud.yandex.net')) { paid++; return yandex(result); }
    assert.ok(target.startsWith('https://allsoft.ru/'));
    return new Response('', { status: 302, headers: { location: 'https://unrelated.example/path' } });
  });
  assert.equal(checked.searchRequests, 2);
  assert.equal(paid, 2);
  assert.equal(checked.status, 'unavailable');
  for (const unsafe of ['http://allsoft.ru/', 'https://allsoft.ru:9000/', 'https://allsoft.ru.invalid/', 'https://user@allsoft.ru/'])
    assert.equal(sellerUrl(unsafe, 'allsoft.ru'), null);
});

test('a URL in a tracker draft or a saved material link stays in the workspace workflow',async()=>{
  const {externalAnswer}=await import('../server/source-chat.mjs');
  for(const question of ['Создай задачу в Redmine со ссылкой https://support.example/faq', 'Открой материал https://workspace.example/#material/abcdef']) {
    assert.equal(await externalAnswer({}, {}, {question}, {}, ()=>assert.fail('unexpected network'), 'job',false),undefined);
  }
});
test('a past offer check can be read after the active workbook is replaced',async t=>{
  const store=workspace(t), [row]=marketOffers(store.db,null,'2026-10-27');
  const checked=await checkOffer(store.db,row,{},async()=>html('<title>Лицензия KL4863RPKFS</title>'));
  importDocs(store,[{file:'Research.xlsx',facts:[{kind:'competitor',loc:'03_Цена!A86',text:'новая запись'}]}]);
  const asOf=checked.checkedAt;
  const archived=await workspaceOperation(store,user,'competitor_check',{version:row.version,loc:row.loc,asOf},{DATA_PROFILE:'local'},()=>assert.fail());
  assert.equal(archived.status,'mismatch');
  assert.equal(await workspaceOperation(store,user,'competitor_check',{version:row.version,loc:row.loc,asOf:'2000-01-01T00:00:00.000Z'}),null);
});
test('natural opt-out wins over a pasted URL and the internet toggle',async()=>{
 const {externalAnswer}=await import('../server/source-chat.mjs');
 for(const question of ['Не открывай https://museum.example','Без поиска. Проверь по архиву','Не читай страницу https://museum.example']){
   assert.equal(await externalAnswer({}, {},{question,webSearch:true},{},()=>assert.fail('unexpected request'),'job',false),undefined);
 }
});
