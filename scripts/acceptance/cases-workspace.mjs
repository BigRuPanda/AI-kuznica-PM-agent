import assert from 'node:assert/strict';
import { chatScenarios } from '../../web/chat-scenarios.ts';
import { enqueue } from '../../server/workbench.mjs';
import { materialForResult } from '../../server/materials.mjs';
import { workspaceCase as scenario, causalLimit, openCorporateWikiWorkspace } from './workspace-fixture.mjs';

const menu=id=>chatScenarios.find(s=>s.id===id).prompt;
const onScreen={body:x=>({screen:x.screen})};
const texts=(answer,...patterns)=>{for(const pattern of patterns) assert.match(answer.text,pattern);};
const refs=(answer,pattern)=>assert.ok(answer.readSources?.some(r=>pattern.test(decodeURIComponent(r.url))), 'Expected source '+pattern);
const value=(turn,name)=>turn.values[name].at(-1);
const draftRow=(x,kind)=>{
  const rows=x.all('SELECT * FROM draft_actions');
  assert.equal(rows.length,1,'Expected exactly one saved draft');
  assert.equal(rows[0].state,'draft');
  assert.equal(rows[0].external,null);
  assert.equal(rows[0].user,x.user.id);
  const b=JSON.parse(rows[0].body);
  assert.equal(b.kind,kind);
  return b;
};
const bookCases=[
  scenario('workbook-cell',['knowledge_sources','knowledge_source'],[
    'В списке загруженных Excel найди «Синтетическое наблюдение.xlsx» и открой ячейку Определения!A2. Как там определён CTR?',
    'Сверь список версий книг и дословную формулировку Определения!A2 в книге «Синтетическое наблюдение.xlsx».',
    'Найди текущую версию файла «Синтетическое наблюдение.xlsx», прочитай Определения!A2 и приложи ссылку на строку.',
  ],(x,t)=>{assert.equal(value(t,'knowledge_source').file,x.ctrFile);refs(t.answer,/Определения!A2/);texts(t.answer,/клик/iu,/визит/iu);},onScreen),
  scenario('metric-source',['source_value'],[
    'Нужна исходная строка CTR у рекомендаций ЛК на компьютерах за 5 октября 2026 года. Приведи значение и ссылку на ячейку.',
    'Сверь в первичных данных значение lk_reco_ctr для ЛК, desktop, 2026-10-05. Где оно записано?',
    'По какой ячейке можно проверить CTR рекомендаций ЛК для компьютеров за неделю с 5 октября? Укажи величину.',
  ],(x,t)=>{const vals=value(t,'source_value');assert.ok(vals.some(r=>r.loc==='CTR!A6'&&r.value===0.01));refs(t.answer,/CTR!A6/);texts(t.answer,/(?:1\s*%|0[.,]01)/u);},onScreen),
  scenario('metric-catalog-chart',['metrics','chart'],[
    'Проверь в каталоге доступные разрезы CTR рекомендаций личного кабинета и построй именно ряд по компьютерам. Покажи график.',
    'Выбери в каталоге данных CTR рекомендаций ЛК с разрезом desktop. Добавь график этой серии к ответу.',
    'Посмотри, какие ряды доступны для CTR в ЛК, и нарисуй диаграмму по настольным устройствам.',
  ],(x,t)=>{const chart=t.answer.materials?.filter(m=>m.kind==='chart').map(m=>x.material(m.id));
    assert.ok(chart?.some(m=>m.plot?.base?.metric==='lk_reco_ctr'&&JSON.stringify(m.plot).includes('desktop')));}),
  scenario('case-view',['view'],[
    'Пересчитай недельный индекс заказов Kaspersky вместе с контрольной серией Astra. Как различаются их изменения?',
    'Сопоставь недельные продажи разбора с Astra в качестве контроля и приложи свежий расчёт с обеими сериями.',
    'Рассчитай заново индекс заказов текущего разбора и контроль Astra. Какая серия снизилась?',
  ],(x,t)=>{const v=value(t,'view');assert.equal(v.product,'Kaspersky');assert.ok(v.summary.some(r=>r.product==='Astra'));
    assert.ok(x.op('calc',{id:v.calc}));texts(t.answer,/Kaspersky/iu,/Astra/iu,/сниз|пад|упал|снижен|уменьш/iu);}),
  scenario('saved-calc',['calc'],[
    'Открой сохранённую версию расчёта из моего предыдущего сообщения. Какие значения у Kaspersky до и после?',
    'Проверь именно тот сохранённый расчёт, который я приложил раньше. Сверь два средних индекса Kaspersky.',
    'Вернись к сохранённой версии из предыдущей реплики, прочитай её и назови исходный и конечный индекс Kaspersky.',
  ],(x,t)=>{assert.equal(t.inputs.calc.at(-1).id,x.calc);texts(t.answer,/100/u,/70/u);},{
    prepare:async x=>{const t=await x.ask('Повтори показатели с экрана',{screen:x.screen});assert.equal(t.answer.calc,x.calc);}}),
  scenario('selection-read',['range_read'],[
    'Открой закреплённое выделение и прочитай точные значения A и B у Kaspersky. Сколько наблюдений есть в каждом интервале?',
    'Сверь значения сохранённых интервалов в приложенном выделении. Нужны оба индекса Kaspersky и число недель.',
    'Проверь именно сохранённый участок. Какие значения Kaspersky записаны в A и B и по скольким точкам?',
  ],(x,t)=>{const v=value(t,'range_read');assert.equal(v.id,t.answer.rangeId);
    assert.deepEqual(v.periods.map(p=>p.series.find(r=>r.key==='Kaspersky').value),[100,70]);texts(t.answer,/100/u,/70/u);},{body:x=>({selection:x.selection})}),
  scenario('selection-neighbors',['selection_context'],[
    'Сверь соседний период и контроль за пределами выделения. Можно ли объяснить падение Kaspersky одним релизом?',
    'Как выглядели продажи Kaspersky за соседний период рядом с выделением? Проверь контроль и оговори ограничения вывода.',
    'Проверь окружение этого выделения: соседние недели, Astra и календарь. Достаточно ли этого для причинного вывода?',
  ],(x,t)=>{assert.ok(value(t,'selection_context').comparison || value(t,'selection_context').sourceCalc);
    texts(t.answer,/Kaspersky/iu,/Astra|контрол/iu,causalLimit);},{body:x=>({selection:x.selection})}),
  scenario('range-recompute',['range_compare'],[
    'На закреплённом графике пересчитай A и B только по Kaspersky, исключив Astra. Сравни те же периоды с исходным выделением.',
    'Сохрани новое сравнение для тех же двух выделенных интервалов, но оставь единственную серию Kaspersky. На сколько изменился индекс?',
    'Нужно новое двухпериодное выделение только Kaspersky на этом графике, с прежними границами. Пересчитай оба значения.',
  ],(x,t)=>{const v=value(t,'range_compare');const saved=x.op('range_read',{id:v.id});
    assert.deepEqual(saved.periods.map(p=>p.series.map(s=>[s.key,s.value])),[[['Kaspersky',100]],[['Kaspersky',70]]]);
    assert.deepEqual(saved.periods.map(p=>[p.from,p.to]),x.selection.ranges.map(r=>[r.from,r.to]));texts(t.answer,/100/u,/70/u);},{
    body:x=>({selection:x.selection,screen:x.screen,materialIds:[x.chartRef(x.calc,'Недельный индекс').id]})}),
];

const trackerCases=[
  scenario('tracker-issue',['issue_search','issue_read'],[
    'Найди в Redmine задачу по поисковой карточке Kaspersky Standard. Прочитай, какой у неё статус и что проверяют в последнем комментарии.',
    'В Redmine отыщи задачу про поисковую карточку, открой её и назови номер, статус и содержание комментария QA.',
    'У нас есть задача Redmine про поисковую карточку Kaspersky. Посмотри последний комментарий в самой задаче и её статус.',
  ],(x,t)=>{assert.equal(value(t,'issue_read').key,'QA-17');refs(t.answer,/demo-issue\/QA-17/);
    texts(t.answer,/в работе/iu,/сниппет/iu);}),
  scenario('tracker-options',['issue_options'],[
    'Какие приоритеты и исполнители можно выбрать для задачи в этом проекте Redmine?',
    'Покажи доступные в Redmine уровни приоритета и имя одного возможного исполнителя.',
    'Перед заведением задачи сверь справочники Redmine. Какие есть приоритеты и кого можно назначить?',
  ],(x,t)=>{assert.ok(value(t,'issue_options').assignees.some(a=>a.name===x.user.name));
    texts(t.answer,/Марин/iu,/Urgent|срочн/iu);}),
  scenario('page-read',['page_search','page_read'],[
    'Найди в Confluence регламент подсчёта CTR и прочитай точный объём контрольной выборки. Какая версия страницы?',
    'Проверь в Confluence страницу про подсчёт CTR. Приведи размер контрольной выборки и номер прочитанной версии.',
    'Открой найденный в Confluence регламент о CTR и сверь контрольную выборку и версию документа.',
  ],(x,t)=>{const page=value(t,'page_read');assert.equal(page.key,'DOC-7');assert.equal(page.version,4);
    refs(t.answer,/demo-page\/DOC-7/);texts(t.answer,/240/u,/4/u);}),
  scenario('page-draft',['page_draft'],[
    'Подготовь черновик новой страницы Confluence «Сверка CTR». Запиши в неё: контрольная выборка 240 визитов. Сначала покажи предпросмотр.',
    'Создай предпросмотр новой страницы «Сверка CTR» в Confluence, с выводом про 240 визитов контрольной выборки.',
    'Для Confluence подготовь новую страницу «Сверка CTR» с размером контрольной выборки 240 визитов. Остановись на предпросмотре.',
  ],(x,t)=>{const d=draftRow(x,'page');assert.equal(d.title,'Сверка CTR');assert.match(JSON.stringify(d),/240/);
    assert.equal(d.target.url,'https://wiki.acceptance.invalid');
    assert.ok(x.wikiRequests.every(r=>r.method==='GET'),'Unexpected corporate Confluence write');
    assert.equal(x.one('SELECT count(*) n FROM demo_pages').n,1);texts(t.answer,/предпросмотр|черновик|подтверд/iu);
  },{allowedWrites:['page_draft'],fixture:openCorporateWikiWorkspace}),
  scenario('case-links',['case_links'],[
    'Покажи ссылки на уже связанные с этим разбором задачи и страницы. Как называется связанная задача?',
    'Какие задачи Redmine и страницы Confluence привязаны именно к этой карточке разбора? Нужна ссылка на задачу.',
    'Проверь список связей текущего разбора. Дай название связанной задачи и где её открыть.',
  ],(x,t)=>{assert.ok(value(t,'case_links').items.some(r=>r.key===x.link.key));texts(t.answer,/Сверка связи/iu);},{
    prepare:async x=>{const d=await x.op('draft',{caseId:x.caseId,title:'Сверка связи',description:'Синтетическая задача связи'});
      await x.op('confirm',{id:d.id,revision:d.revision});x.link=(await x.op('case_links',{caseId:x.caseId})).items[0];assert.ok(x.link);}}),
];

const writeCases=[
  scenario('new-case',['create_case'],[
    'Создай личный разбор «Порог CTR» для продукта ЛК. Задай критерий успеха: CTR рекомендаций на компьютерах не ниже 5%.',
    'Заведи для меня личный разбор ЛК «Порог CTR» с целевым CTR рекомендаций desktop не меньше пяти процентов.',
    'Сохрани отдельный личный разбор «Порог CTR» для ЛК. Цель для компьютерного CTR рекомендаций — как минимум 5%.',
  ],(x,t)=>{const c=x.inspectCase(value(t,'create_case').id);assert.equal(c.title,'Порог CTR');assert.equal(c.body.owner,x.user.id);
    assert.deepEqual([c.body.plan.measurement.metric,c.body.plan.measurement.comparison,c.body.plan.measurement.targetValue],['lk_reco_ctr','gte',5]);
  },{body:()=>({caseId:undefined}),allowedWrites:['create-case']}),
  scenario('note',['append_case'],[
    'Добавь в заметки этого разбора вывод: нужна проверка разметки корзины.',
    'Запиши в текущий разбор, что команде нужна проверка разметки корзины.',
    'Сохрани в заметках разбора договорённость проверить разметку корзины.',
  ],(x,t)=>{const notes=x.inspectCase().body.notes;assert.equal(notes.length,1);assert.match(notes[0].text,/разметк.{0,40}корзин/iu);},{allowedWrites:['append_case']}),
  scenario('personal-view',['set_view'],[
    'Оставь в моём личном виде только сводку и динамику, закрепи этот набор карточек.',
    'Измени мой личный экран: закрепи только две карточки, сводку и тренд.',
    'Закрепи в моём личном виде сводку и график динамики индекса, остальные карточки убери.',
  ],x=>{const v=JSON.parse(x.one('SELECT body FROM personal_views WHERE case_id=? AND user=?',x.caseId,x.user.id).body);
    assert.deepEqual(v.cards.sort(),['summary','trend']);assert.equal(v.pin,true);},{allowedWrites:['set_view']}),
  scenario('publish-preview',['prepare_publish'],[
    'Подготовь для команды предпросмотр публикации текущей сводки и динамики Kaspersky. Дай мне его на подтверждение.',
    'Хочу поделиться с командой сводкой и трендом на этом экране. Подготовь публикацию для подтверждения.',
    'Собери предпросмотр публикации в команду с текущей сводкой и динамикой индекса заказов.',
  ],(x,t)=>{const p=x.one('SELECT * FROM agent_previews WHERE id=?',value(t,'prepare_publish').id);
    assert.equal(p.state,'pending');assert.equal(p.owner,x.user.id);assert.equal(JSON.parse(p.body).calc,x.calc);},{...onScreen,allowedWrites:['prepare_publish']}),
  scenario('correction',['feedback'],[
    'Запомни поправку к источнику «Тест!A2»: интервью описывало только пробную лицензию.',
    'Сохрани для этого разбора поправку к Тест!A2. Респондент говорил только о пробной лицензии.',
    'Учти в источнике Тест!A2 уточнение: речь шла о пробной лицензии. Сохрани поправку.',
  ],x=>{const rows=x.all('SELECT source,comment FROM feedback WHERE product=?','Kaspersky');
    assert.equal(rows.length,1);assert.match(rows[0].source,/Тест!A2/);assert.match(rows[0].comment,/пробн/iu);},{allowedWrites:['feedback']}),
  scenario('decision',['decide'],[
    'Закрой этот разбор. Мы закончили проверку.',
    'Заверши текущий разбор и поставь ему статус «Завершено».',
    'Поменяй статус этого разбора на «Завершено».',
  ],x=>assert.equal(x.inspectCase().state,'Завершено'),{allowedWrites:['decide']}),
  scenario('watch-options',['watch_options'],[
    'Какие показатели и контрольные семейства доступны при настройке наблюдения в этом разборе Kaspersky?',
    'Проверь доступные варианты плана наблюдения для этого продукта: метрики, задачи и контрольные семейства.',
    'Перечисли доступные параметры наблюдения за эффектом Kaspersky. Какой контроль и какие метрики можно назначить?',
  ],(x,t)=>{const v=value(t,'watch_options');assert.ok(JSON.stringify(v).includes('orders_index'));texts(t.answer,/Astra/iu,/индекс/iu);}),
  scenario('schedule-watch',['watch'],[
    'Назначь наблюдение с 5 октября 2026 за индексом заказов Kaspersky. Цель — 90% от базы, контроль Astra.',
    'Отслеживай индекс заказов Kaspersky с даты выкладки 2026-10-05. Порог восстановления 90 процентов от базы, контрольный ряд Astra.',
    'Сохрани наблюдение за эффектом с 2026-10-05: индекс Kaspersky должен вернуться к 90% базы, контроль Astra.',
  ],x=>{const c=x.inspectCase();assert.equal(c.state,'Наблюдаем эффект');assert.equal(c.body.watch.deployed,'2026-10-05');
    assert.equal(c.body.watch.control,'Astra');assert.equal(c.body.watch.target,90);},{allowedWrites:['watch']}),
  scenario('watch-preview',['effect_preview'],[
    'Прочитай результат уже назначенного наблюдения по состоянию на 2 ноября 2026. Достигнут ли согласованный порог 90?',
    'Каков результат нашего наблюдения на дату 2026-11-02? Сверь с установленной целью 90 без изменения плана.',
    'Нужен предпросмотр эффекта сохранённого плана на 02.11.2026. Сверь фактический индекс и цель 90.',
  ],(x,t)=>{assert.equal(x.inspectCase().body.watch.target,90);assert.equal(value(t,'effect_preview').caseId,x.caseId);
    texts(t.answer,/90/u,/70/u);},{prepare:x=>x.op('watch',{caseId:x.caseId,deployed:'2026-10-05',percent:90,control:'Astra'})}),
];

const menuCases=[
  scenario('menu-demand',['search'],[menu('demand'),
    'По конкурентному исследованию найди запрос, по которому наш товар есть в продаже, но магазин заметно ниже конкурента. Приведи частоту, позиции, ссылку и сверку с бэклогом.',
    'Где Store упускает поисковый спрос при наличии товара? Сверь исследование с бэклогом, назови запрос и позиции конкурента и магазина и предложи одно улучшение.',
  ],(x,t)=>{texts(t.answer,/Kaspersky Standard/iu,/420/u,/18/u,/\b3\b/u,/QA-17/iu);refs(t.answer,/Спрос!B8/);},onScreen),
  scenario('menu-triage',['overview'],[menu('triage'),
    'Выбери один текущий сигнал, на котором команде стоит сосредоточиться сегодня. Как долго он держится и что нужно проверить в первую очередь?',
    'Какой открытый сигнал сейчас приоритетнее? Сверь доступные разборы, фактическую динамику и полные недели и предложи одну проверку.',
  ],(x,t)=>{const signal=x.op('overview',{}).cases.find(c=>c.body.signal?.status==='confirmed');
    assert.ok(signal);texts(t.answer,/Kaspersky/iu,/индекс/iu,/недел/iu,/провери|провер|свер/iu,/\d/u);},{body:()=>({caseId:undefined})}),
  scenario('menu-funnel',['funnel'],[menu('funnel'),
    'Разбери измеренные этапы подбора в нашем продукте. Нужны объёмы и единицы по компьютерам и телефонам, а также шаги, о которых нет данных.',
    'Где чаще теряются пользователи в рассматриваемой воронке подбора? Сопоставь сегменты и фактические счётчики. Назови пробелы в данных.',
  ],(x,t)=>{const r=x.material(value(t,'funnel').material.id);
    const rows=r.sections.find(s=>s.title==='Завершение подбора').rows;
    assert.ok(rows.some(row=>row[0]==='Телефоны'&&/\d+\/\d+/.test(row[1])));texts(t.answer,/телефон|мобил/iu,/компьютер|десктоп/iu,/нет|отсутств|не измер|не хватает|не фиксир/iu,/\d/u);
  },{prepare:x=>{x.funnelCase=x.op('create-case',{product:'Astra',title:'Подбор Astra'}).id;},body:x=>({caseId:x.funnelCase})}),
  scenario('menu-hypothesis',[],[menu('hypothesis'),
    'Проверь нашу гипотезу. Приведи по одному свидетельству за и против со ссылками и предложи проверку.',
    'Как гипотеза из обсуждения выдерживает сравнение метрик и интервью? Нужен контраргумент, подтверждение и следующий шаг.',
  ],(x,t)=>{texts(t.answer,/лиценз|верси/iu,/бюджет|отлож|оплат/iu,causalLimit);assert.ok(t.answer.readSources?.length||t.answer.materials?.some(m=>x.material(m.id).sections?.some(s=>s.sources?.length)));},{
    prepare:async x=>{await x.ask('Моя гипотеза: покупателям сложно выбрать версию лицензии Kaspersky, поэтому реже заказывают.',{}, {...x.env,DATA_PROFILE:'local'});
      x.op('append_case',{caseId:x.caseId,note:'Гипотеза: покупатели не понимают, какую версию лицензии Kaspersky выбирать.'});},
    body:x=>({screen:x.screen})}),
  scenario('menu-release',['release_decision'],[menu('release'),
    'Сверь эффект обсуждаемой выкладки с динамикой Kaspersky и контроля. Что изменилось и какое решение принять по наблюдению?',
    'Проверь результат текущего релиза по данным. Есть ли основание закрыть наблюдение или надо продолжить проверку? Учти контроль.',
  ],(x,t)=>{const r=value(t,'release_decision');assert.equal(r.release.id,'R-71');texts(t.answer,/Kaspersky/iu,/контрол|Astra/iu,causalLimit);
    refs(t.answer,/Журнал!A2/);},{prepare:x=>{x.releaseCase=x.op('create-case',{product:'Kaspersky',release:'R-71',title:'Эффект R-71: изменение выбора лицензии'}).id;},
    body:x=>({caseId:x.releaseCase,screen:x.screen})}),
];

function ctrSelection(x) {
  const chart=x.op('chart',{metric:'lk_reco_ctr',product:'ЛК',segment:'desktop'});
  const material=materialForResult(x.db,x.user,x.thread,{calc:chart.id,source:'metric',title:'CTR рекомендаций'});
  const plot=x.material(material.id).plot;
  const selection={...plot.base,series:['desktop'],ranges:[
    {from:Date.parse('2026-09-07'),to:Date.parse('2026-10-05')},
    {from:Date.parse('2026-10-05'),to:Date.parse('2026-11-02')}]};
  const range=x.op('range_compare',{selection});
  assert.deepEqual(range.periods.map(p=>p.series[0].value),[6,1]);
  assert.equal(range.differences[0].absolute,-5);
  const caseId=x.op('create-case',{product:'ЛК',title:'CTR рекомендаций на компьютерах'}).id;
  return {caseId,selection,materialIds:[material.id]};
}
const compareCTR=['Как изменился CTR рекомендаций на компьютерах между выделенными периодами? Укажи оба процента, разницу в процентных пунктах и что можно сказать о причине.',
  'Сопоставь CTR до и после в моём выделении. Сколько было, сколько стало, на сколько процентных пунктов снизилось и можно ли доказать причину?',
  'Прочитай обе части выбранного графика CTR и вырази падение в процентных пунктах. Объясни, позволяет ли динамика установить причинную связь.'];
function verifyCTR(answer) {
  const text=answer.text.replace(/[*_`]/g,'').replaceAll('−','-');
  const six=/\b6(?:[.,]0+)?\s*%/u, one=/\b1(?:[.,]0+)?\s*%/u;
  assert.match(text,six);assert.match(text,one);
  if (text.search(one)<text.search(six)) {
    assert.match(text,/(?:после|втор[а-яё]*\s+период|период[а-яё]*\s+[BБ]|\bB)\D{0,35}1(?:[.,]0+)?\s*%|1(?:[.,]0+)?\s*%\D{0,24}(?:после|в периоде [BБ])/iu);
    assert.match(text,/(?:до|перв[а-яё]*\s+период|период[а-яё]*\s+[AА]|\bA)\D{0,35}6(?:[.,]0+)?\s*%|6(?:[.,]0+)?\s*%\D{0,24}(?:до|в периоде [AА])/iu);
  }
  assert.match(text,/(?:[-–−]\s*5|(?:сни[зж]|пад|уменьш|упал|ниже|сократ|минус).{0,55}?5)(?:[.,]0+)?\s*(?:п[.\s]*п|процентн.{0,10}\s+пункт)/isu);
  assert.match(text,causalLimit);
  assert.doesNotMatch(text,/(?:однозначно|точно|доказанно)\s+(?:вызван|обусловлен)|(?:данные|падение|совпадение)\s+(?:доказыва[ею]т|устанавлива[ею]т)\s+причин/iu);
}
const conversationCases=[
  scenario('ctr-causality',[],compareCTR,(x,t)=>verifyCTR(t.answer),{body:ctrSelection}),
  scenario('ctr-draft-followup',['draft'],[
    'Подготовь по этому выводу один черновик задачи для QA с планом проверки причин. Оставь его на моё подтверждение.',
    'Создай один черновик задачи для проверки этого падения. Зафиксируй обе величины CTR и поручение QA выяснить причину.',
    'Оформи по обсуждённому изменению одну задачу для QA в виде черновика. Включи значения CTR и шаг проверки.',
  ],(x,t)=>{const d=draftRow(x,'issue');assert.ok(x.one('SELECT count(*) n FROM local_issues').n===0);
    const content=(d.title+' '+d.description).replace(/[*_`]/g,'');assert.match(content,/CTR|кликабел/iu);
    assert.match(content,/провер|свер|сопостав|гипотез/iu);assert.match(content,/6\s*%/u);assert.match(content,/1\s*%/u);
    assert.ok(t.answer.actions?.some(a=>a.op==='draft'&&a.id));},{
    allowedWrites:['draft'],custom:async (x,q)=>{const b=ctrSelection(x);const first=await x.ask(compareCTR[0],b);
      verifyCTR(first.answer);return x.ask(q,{caseId:b.caseId});}}),
  scenario('read-only-advice',[],[
    'Стоит ли завести задачу QA в Redmine на проверку разметки Kaspersky? Объясни, какие данные собрать, пока ничего не создавай.',
    'Как понять, нужна ли здесь задача на QA? Дай совет без создания задачи или черновика.',
    'Нужно ли сейчас создавать задачу QA в Redmine для Kaspersky? Пока нужен только совет и обоснование.',
  ],(x,t)=>{assert.equal(x.one('SELECT count(*) n FROM draft_actions').n,0);assert.equal(x.one('SELECT count(*) n FROM local_issues').n,0);
    texts(t.answer,/размет|данны|событи|провер/iu);}),
  scenario('screen-local',[],['Повтори показатели с экрана.','Что сейчас на экране?','Покажи открытый расчёт.'],
    (x,t)=>{assert.equal(t.answer.mode,'calculation');assert.equal(t.answer.calc,x.calc);texts(t.answer,/100/u,/70/u);},{local:true,...onScreen}),
  scenario('private-group-guard',[],['Покажи команде этот личный разбор.','Расскажи в общем чате про прикреплённый личный разбор.',
    'Как изменились показатели этого личного разбора?'],x=>{assert.equal(x.one('SELECT count(*) n FROM jobs').n,0);
      assert.equal(x.one("SELECT count(*) n FROM chat_items WHERE thread='group'").n,0);},{local:true,custom:(x,q)=>{
        assert.throws(()=>enqueue(x.store,x.user,{thread:'group',question:q,caseId:x.caseId}),/опубликуйте личный разбор/iu);return {values:{}};}}),
  scenario('ambiguous-charts',[],['Почему здесь такой график?','Почему этот график так выглядит?','С чем связано изменение на этом графике?'],
    (x,t)=>{assert.equal(t.answer.mode,'clarification');assert.equal(t.answer.chartChoices.length,2);texts(t.answer,/какой график/iu);},{local:true,
      body:x=>{const a=x.chartRef(x.calc,'Недельный индекс');const ctr=x.op('chart',{metric:'lk_reco_ctr',product:'ЛК',segment:'desktop'});
        const b=materialForResult(x.db,x.user,x.thread,{calc:ctr.id,source:'metric',title:'CTR'});
        return {materialIds:[a.id,b.id]};}}),
];
export const workspaceCases=[...bookCases,...trackerCases,...writeCases,...menuCases,...conversationCases];
