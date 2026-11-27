import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs } from '../server/evidence.mjs';
import { initWorkbench, createThread, enqueue, workJobs, messages } from '../server/workbench.mjs';
import { webQuestion } from '../server/web-search.mjs';
import { competitorQuestion } from '../server/competitor-chat.mjs';

const user = {id:'tester', name:'Продакт', role:'admin'};
function context(t) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  initEvidence(store.db);
  initWorkbench(store.db);
  const row = (kind, loc, data) => ({kind, loc, row:data});
  importDocs(store, [{file:'sample.xlsx', facts:[
    row('sales','Sales!A2',{product_family:'Astra OS', week_start:'2026-04-06', orders_index:33}),
    row('sales','Sales!A3',{product_family:'Kaspersky Pro', week_start:'2026-04-06', orders_index:21}),
    row('sales','Sales!A4',{product_family:'Astra OS', week_start:'2026-03-30', orders_index:40}),
    row('releases','Calendar!A2',{release_id:'R-38',release_date:'2026-04-06',description:'Доставка через архив',related_task_ids:'T-871'}),
    row('dictionary','Dictionary!A2',{metric_id:'impressions',metric_name:'Видимые показы витрины',what_it_means:'Видимый показ требует 72% площади за 3 секунды',formula_or_logic:'Число событий видимого показа'}),
    {kind:'interview',loc:'Interview!C8',text:'Недостающую лицензию доставили, устанавливал отдел инженеров.',detail:{field:'Опыт клиента',answer:'Недостающую лицензию доставили, устанавливал отдел инженеров.'}},
    {kind:'competitor',loc:'Prices!A4',prices:{'Продукт':'Лицензия для доставки'},row:{}},
    {kind:'interview',loc:'Research!D2',text:'Организовали выставку.',detail:{field:'Проект',answer:'Организовали выставку.'}},
    {kind:'interview',loc:'Research!D3',text:'Акция продлилась три недели.',detail:{field:'Проект',answer:'Акция продлилась три недели.'}},
  ]}], {notify:false});
  const thread = createThread(store.db,user,'Аудит');
  return async (question,options={}) => {
    enqueue(store,user,{thread,question,...options});
    await workJobs(store,{publicUser:()=>user},{});
    return messages(store.db,user,thread).items.at(-1).body;
  };
}
test('weekly comparisons and subsequent questions resolve the named products and the same week', async t => {
  const ask=context(t);
  const both=await ask('Сравни индекс заказов Астры и Касперского за неделю с 6 апреля 2026. Какова разница в пунктах?');
  assert.match(both.text,/33/);
  assert.match(both.text,/21/);
  assert.match(both.text,/12 п/);
  assert.equal(both.readSources.length,2);
  const follow=await ask('А у Kaspersky за ту же неделю?');
  assert.equal(follow.readSources.length,1);
  assert.match(follow.text,/2026-04-06.*21/);
  assert.doesNotMatch(follow.text,/Astra/);
});
test('weekly changes respect the preceding week and the requested order of subtraction', async t => {
  const ask=context(t);
  const change=await ask('Сравни индекс заказов Астры за неделю с 6 апреля 2026 с предыдущей неделей. На сколько пунктов он изменился?');
  assert.match(change.text,/2026-03-30.*40/);
  assert.match(change.text,/[−-]7 п/);
  const difference=await ask('Сравни индекс заказов Касперского и Астры за неделю с 6 апреля 2026. Вычти индекс Астры из индекса Касперского.');
  assert.match(difference.text,/Kaspersky Pro минус Astra OS.*[−-]12 п/);
  const invalid=await ask('Какой индекс заказов Астры за неделю с 31 февраля 2026?');
  assert.equal(invalid.outcome,'clarification');
  assert.equal(invalid.weeklyContext,undefined);
});
test('unavailable revenue and absent archive IDs do not produce unrelated records', async t => {
  const ask=context(t);
  const missing=await ask('Что известно в архиве о релизе R-284?');
  assert.match(missing.text,/R-284/);
  assert.equal(missing.readSources.length,0);
  const money=await ask('Сколько составила выручка Астры в рублях за неделю с 6 апреля 2026 года?');
  assert.match(money.text,/выручк/iu);
  assert.match(money.text,/нет|отсутств|недоступ/iu);
  assert.doesNotMatch(money.text,/33|доставк/);
});
test('a linked task without a backlog row and a mix of known and unknown IDs retain their evidence', async t => {
  const ask=context(t);
  const linked=await ask('Указана ли задача T-871 в релизе R-38?');
  assert.match(linked.text,/T-871/);
  assert.ok(linked.readSources.some(s=>s.label.includes('Calendar!A2')));
  const other=await ask('А кто устанавливал лицензию по словам респондента?');
  assert.match(other.text,/отдел инженеров/);
  assert.ok(other.readSources.every(s=>s.label.includes('Interview!')));
  const result=await ask('Что известно в архиве о релизах R-38 и R-999?');
  assert.match(result.text,/Доставка через архив/);
  assert.match(result.text,/R-999/);
  assert.ok(result.readSources.some(s=>s.label.includes('Calendar!A2')));
});
test('source requests use the meaning field and respondents’ own accounts', async t => {
  const ask=context(t);
  const term=await ask('Как в справочнике определяют видимые показы витрины?');
  assert.match(term.text,/72%.*3 секунды/);
  const interview=await ask('Кто устанавливал лицензию по словам респондента?');
  assert.match(interview.text,/отдел инженеров/);
  assert.ok(interview.readSources.every(r=>r.label.includes('Interview!')));
  const project=await ask('Что сказали про акцию в интервью?');
  assert.match(project.text,/три недели/iu);
  assert.deepEqual(project.readSources?.map(s=>s.label),['sample.xlsx · Research!D3']);
});
test('an explicit request to stay offline overrides the internet checkbox', () => {
  assert.equal(webQuestion('Объясни без интернета',true),null);
  assert.equal(webQuestion('Не ищи в интернете, посмотри в архиве',true),null);
  assert.ok(webQuestion('Не ищи в архиве, найди в интернете отзывы',true));
  assert.equal(competitorQuestion('Не ищи в интернете, проверь цену конкурента allsoft.ru по архиву'),false);
});
