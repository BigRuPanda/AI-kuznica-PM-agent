import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisView, initEvidence, importDocs } from '../server/evidence.mjs';
import { grant } from '../server/chart-ranges.mjs';
import { createThread, enqueue, initWorkbench, messages, workJobs } from '../server/workbench.mjs';
import { releaseObservationAnswer } from '../server/release-observation-chat.mjs';
import { openStore } from '../server/store.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';

const user = { id:'reader', name:'Reader', role:'member' };
const request = 'Сравни orders_index all по 1 неделе до и после релиза R-01, по состоянию на 2026-04-30.';
const before = '2026-04-06', after = '2026-04-20';
const caseId = 'astra-case';

function workspace(t, { extra = false, incomplete = false, empty = false, watch } = {}) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  initEvidence(store.db);
  const sales = (product, kind, values) => values.map((value, i) => ({kind:'sales', loc:kind + '!A' + (i+2),
    row:{product_family:product, week_start:[before,after][i], orders_index:value}}));
  const sources = [
    {file:'release.xlsx', facts:[{kind:'releases', loc:'Релизы!A2', row:{release_id:'R-01',
      release_date:'2026-04-15', release_type:'minor', status:'выпущен', description:'Обновление Astra OS',
      affected_metrics:'family_orders_idx'}}]},
    {file:'astra.xlsx', facts:sales('Astra OS','Astra',[40,30])},
    ...(!empty ? [{file:'kaspersky.xlsx', facts:sales('Kaspersky Pro','Kaspersky',incomplete ? [20] : [20,40])}] : []),
    ...(extra ? [{file:'orion.xlsx', facts:sales('Orion','Orion',[90,80])}] : []),
  ];
  importDocs(store, sources, { notify:false });
  store.db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)').run(caseId,'Astra OS','Релиз Astra','Исследуем',
    JSON.stringify({release:'R-01',watch}));
  return {
    store,
    ask: (question, body = {}, history = []) => releaseObservationAnswer(store,user,{question,...body},{},false,history),
    preview: () => workspaceOperation(store,user,'effect-preview',{caseId,metric:'orders_index',segment:'all',
      releaseId:'R-01',baselineWeeks:1,observationWeeks:1,asOf:'2026-04-30'}),
  };
}

function cites(reply, file) {
  return reply.readSources.filter(row => row.label.startsWith(file + ' · '));
}

test('release chat gives both control periods, relative change and their citations', t => {
  const {ask,preview} = workspace(t);
  const expected = preview();
  assert.equal(expected.control.relativeChange,100);
  assert.equal(expected.state,'Изменился контроль — требуется проверка');
  const reply = ask(request + ' Покажи контроль.');
  assert.equal(reply.product,'Astra OS');
  assert.match(reply.text,/До релиза 2026-04-06 – 2026-04-12.*40 п\. индекса/u);
  assert.match(reply.text,/После релиза 2026-04-20 – 2026-04-26.*30 п\. индекса/u);
  assert.match(reply.text,/Наблюдаемое изменение · -10 п\. индекса/u);
  assert.match(reply.text,/Контроль · Kaspersky Pro/u);
  assert.match(reply.text,/Контроль до релиза 2026-04-06 – 2026-04-12.*20 п\. индекса/u);
  assert.match(reply.text,/Контроль после релиза 2026-04-20 – 2026-04-26.*40 п\. индекса/u);
  assert.match(reply.text,/Изменение контроля · \+100\s*%/u);
  assert.match(reply.text,/Изменился контроль — требуется проверка/u);
  assert.deepEqual(cites(reply,'kaspersky.xlsx').map(x => x.label),
    ['kaspersky.xlsx · Kaspersky!A2','kaspersky.xlsx · Kaspersky!A3']);
  assert.ok(cites(reply,'kaspersky.xlsx').every(x => /^#knowledge-source\/.+\/Kaspersky!A[23]$/u.test(x.url)));
  assert.equal(cites(reply,'astra.xlsx').length,2);
});

test('named control stays separate from the named product and overrides saved control', t => {
  const {ask} = workspace(t,{extra:true, watch:{control:'Orion'}});
  const reply = ask(request.replace('orders_index','orders_index у Astra OS') + ' Включи контроль Kaspersky Pro.',{caseId});
  assert.equal(reply.product,'Astra OS');
  assert.match(reply.text,/Контроль · Kaspersky Pro/u);
  assert.doesNotMatch(reply.text,/Для какого семейства|Контроль · Orion/u);
  assert.equal(cites(reply,'kaspersky.xlsx').length,2);
  assert.equal(cites(reply,'orion.xlsx').length,0);
});

test('unnamed control follows the saved case selection when more than one control exists', t => {
  const {ask} = workspace(t,{extra:true,watch:{control:'Orion'}});
  const reply = ask(request + ' Покажи контроль.',{caseId});
  assert.match(reply.text,/Контроль · Orion/u);
  assert.equal(cites(reply,'orion.xlsx').length,2);
  assert.equal(cites(reply,'kaspersky.xlsx').length,0);
});

test('a reply naming one of several controls completes the pending choice', t => {
  const {ask} = workspace(t,{extra:true});
  const first = ask(request + ' Покажи контроль.',{caseId});
  assert.match(first.text,/Укажите контрольное семейство.*Kaspersky Pro.*Orion/u);
  const selected = ask('Kaspersky Pro',{caseId},[{body:first}]);
  assert.ok(selected, 'Чат принимает ответ на уточнение о контрольном семействе');
  assert.equal(selected.product,'Astra OS');
  assert.match(selected.text,/Контроль · Kaspersky Pro/u);
  assert.equal(cites(selected,'kaspersky.xlsx').length,2);
});

test('a standalone follow-up can turn off the selected control', t => {
  const {ask} = workspace(t,{watch:{control:'Kaspersky Pro'}});
  const first = ask(request + ' Покажи контроль.',{caseId});
  const disabled = ask('Не используй контроль.',{caseId},[{body:first}]);
  assert.ok(disabled, 'Предыдущие параметры оценки применены к просьбе отключить контроль');
  assert.match(disabled.text,/Контроль отключён/u);
  assert.match(disabled.text,/Наблюдаемое изменение · -10/u);
  assert.doesNotMatch(disabled.text,/Kaspersky Pro|Изменился контроль/u);
  assert.equal(cites(disabled,'kaspersky.xlsx').length,0);
});

test('explicitly asking for an unavailable control gives the actual options without substituting one', t => {
  const {ask} = workspace(t);
  const reply = ask(request + ' Используй контроль Orion.', {caseId});
  assert.match(reply.text,/Orion.{0,45}нет|нет.{0,45}Orion/u);
  assert.match(reply.text,/Доступн.{0,40}Kaspersky Pro/u);
  assert.doesNotMatch(reply.text,/Контроль · Kaspersky Pro/u);
  assert.equal(cites(reply,'kaspersky.xlsx').length,0);
  assert.equal(cites(reply,'astra.xlsx').length,2);
});

test('a calendar gap in the control is named and no second source row is invented', t => {
  const {ask} = workspace(t,{incomplete:true});
  const reply = ask(request + ' С контролем Kaspersky Pro.', {caseId});
  assert.match(reply.text,/Контроль после релиза 2026-04-20 – 2026-04-26 · 0\/1 недель/u);
  assert.match(reply.text,/Недостаточно сопоставимых наблюдений по контролю/u);
  assert.doesNotMatch(reply.text,/Изменение контроля ·/u);
  assert.deepEqual(cites(reply,'kaspersky.xlsx').map(x => x.label),['kaspersky.xlsx · Kaspersky!A2']);
});

test('an explicit request gets an honest answer when the archive has no control at all', t => {
  const {ask} = workspace(t,{empty:true});
  const reply = ask(request + ' Покажи контроль.', {caseId});
  assert.match(reply.text,/В загруженных данных нет другого семейства для контроля/u);
  assert.match(reply.text,/Наблюдаемое изменение · -10/u);
});

test('release chat keeps the selected screen period and its disabled control', async t => {
  const {store}=workspace(t);
  initWorkbench(store.db);
  const thread=createThread(store.db,user,'Выбранный срез');
  const ask=async from=>{
    const view=analysisView(store.db,{caseId,from,through:'2026-04-22',control:false});
    grant(store.db,view.id,'thread',thread);
    enqueue(store,user,{thread,caseId,screen:{calc:view.id},question:request});
    await workJobs(store,{publicUser:()=>user},{},()=>assert.fail('Expected a local archive answer'));
    return messages(store.db,user,thread).items.at(-1).body;
  };
  const startsTooLate=await ask('2026-04-13');
  assert.match(startsTooLate.text,/Период до релиза начинается раньше выбранного среза/u);
  assert.deepEqual(startsTooLate.readSources.map(s=>s.label),['release.xlsx · Релизы!A2']);
  const clipped=await ask('2026-04-06');
  assert.match(clipped.text,/Срез на 2026-04-22/u);
  assert.match(clipped.text,/Контроль отключён/u);
  assert.doesNotMatch(clipped.text,/2026-04-30|Наблюдаемое изменение|Kaspersky Pro/u);
  assert.deepEqual(cites(clipped,'astra.xlsx').map(r=>r.label),['astra.xlsx · Astra!A2']);
});
