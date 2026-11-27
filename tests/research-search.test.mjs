import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { root } from '../server/config.mjs';
import { caseEvidenceSearch, initEvidence, importDocs, search } from '../server/evidence.mjs';

const headings = ['Вопрос','Обезличенная выдержка','Продукт','Дата','Исходная книга','Ячейка источника'];
function material(file, excerpt, row) {
  return {file, rows:[headings, ['Как прошла покупка?', excerpt, 'Магазин', '2026-10-08', 'Оригинал.xlsx', 'Опрос!C' + row]]};
}
function python(script, args, input) {
  const name = process.env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3');
  const run = spawnSync(name, [join(root, script), ...args], {input, windowsHide:true, maxBuffer:20 * 1024 * 1024});
  if (run.error) throw run.error;
  if (run.status !== 0) throw Error(run.stderr.toString('utf8'));
  return run.stdout;
}
function office(items) {
  const zip = python('tests/research-workbooks.py', [], JSON.stringify(items));
  return JSON.parse(python('scripts/office_import.py', ['pack.zip'], zip));
}
const find = (db,q,asOf) => search(db,q,['interview'],5,{asOf});

// Excerpts and expected original cell addresses are specified before indexing.
const evidence = [
  'Лицензии продлевать удобно. Письмо продления приходит заранее.',
  'Лицензии продлевать неудобно. Приходится повторно вводить договор.',
  'При смене плательщика сбрасывается корзина.',
  'Предложенная скидка исчезла после перехода в корзину.',
  'Условие постоплаты видно лишь в конце оформления.',
  'При ручном подборе ошиблись в количестве ядер процессора.',
  'Акт выполненных работ пришёл без подписи.',
  'На телефоне кнопка оплаты перекрыта нижней панелью.',
  'Покупателю сложно отличить серверную редакцию от настольной.',
  'В сертификате пропущена дата окончания поддержки.',
  'Цена по рамочному договору в кабинете отличается от счёта.',
  'В фильтре отсутствует нужная архитектура ARM.',
  'При копировании ключа добавляется лишний пробел.',
  'В истории заказов поиск по номеру накладной работает.',
  'Коллега не может согласовать заявку в отпуске руководителя.',
  'Реквизиты филиала подставляются из прошлой заявки.',
  'Статус лицензионного ключа обновился после перезагрузки страницы.',
  'Сравнение редакций в таблице помогло выбрать версию.',
  'Ссылку на дистрибутив трудно найти в электронном письме.',
  'В уведомлении менеджеру нет названия получателя.',
];
const cases = [
  ['Удобно ли продлевать лицензии заранее?', 2],
  ['Неудобно продлевать лицензии и повторно вводить договор?', 3],
  ['Что происходит с корзиной при смене плательщика?', 4],
  ['В корзине исчезла скидка', 5],
  ['Когда видны условия постоплаты?', 6],
  ['Ошибки количества ядер процессора при подборе', 7],
  ['Почему акт не подписан — без подписи?', 8],
  ['Чем перекрыта кнопка оплаты на телефоне?', 9],
  ['Разница серверной и настольной редакций', 10],
  ['Дата окончания поддержки в сертификате', 11],
  ['Расхождение договорной цены по рамочному договору', 12],
  ['Архитектура ARM в фильтре', 13],
  ['Откуда пробел при копировании ключа?', 14],
  ['Поиск по номеру накладной в истории заказов', 15],
  ['Согласование заявки в отпуске руководителя', 16],
  ['Реквизиты филиала из прошлой заявки', 17],
  ['Обновление статуса ключа перезагрузкой страницы', 18],
  ['Помогает ли таблица сравнения редакций?', 19],
  ['Ссылка на дистрибутив в письме', 20],
  ['Название получателя в уведомлении менеджеру', 21],
];

test('1000 synthetic interview materials through ZIP/XLSX import, 20 labelled retrieval questions', () => {
  const items = evidence.map((s,i) => material('research/' + i + '.xlsx',s,i+2));
  const products=['антивирус','поиск','подписка','контракт','согласование','подбор','оплата','ключ','редакция','корзина'];
  const actions=['заказ','сравнение','возврат','настройка','рассрочка','поставка','продление','заявка','покупка','обновление'];
  const channels=['на сайте','по телефону','через менеджера','по почте','в кабинете','в приложении','в отделе','через партнёра','через филиал','по договору'];
  for (let i=0;i<980;i++) {
    const summary = [products[i%10],actions[Math.floor(i/10)%10],channels[Math.floor(i/100)]].join(', ');
    items.push(material('corpus/' + i + '.xlsx','Краткая запись: '+summary+'. Обсудили стоимость и срок.',100+i));
  }
  const store=openStore(':memory:');
  try {
    initEvidence(store.db);
    const sources=office(items);
    assert.equal(importDocs(store,sources,{notify:false}).inserted,1000);
    assert.equal(store.db.prepare('SELECT count(*) n FROM research_fts').get().n,1000);
    const elapsed=[], missed=[];
    for (const [query,row] of cases) {
      const start=performance.now(), refs=find(store.db,query);
      elapsed.push(performance.now()-start);
      if (!refs.some(r => r.source==='Оригинал.xlsx · Опрос!C'+row && r.data===evidence[row-2])) missed.push(query);
    }
    const p95=elapsed.sort((a,b)=>a-b)[Math.ceil(0.95*elapsed.length)-1];
    console.log('Synthetic interview retrieval: '+(cases.length-missed.length)+'/20 hit@5, documents=1000, p95_ms='+p95.toFixed(2));
    assert.ok(missed.length<=2, 'Missing evidence: '+missed.join('; '));
    assert.equal(find(store.db,'криолитозона пурпурный').length,0);
    assert.equal(find(store.db,'Лицензии продлевать неудобно договор')[0].data,evidence[1]);
    assert.equal(find(store.db,'Лицензии продлевать удобно заранее')[0].data,evidence[0]);
    assert.equal(find(store.db,'смене плательщика')[0].data,evidence[2]);
    assert.equal(find(store.db,'сбрасывается корзина','2026-10-07').length,0);
    assert.equal(find(store.db,'смене плательщика','2026-10-08')[0].metadata.date,'2026-10-08');
  } finally { store.close(); }
});

test('same worksheet names across folders, active excerpt update, provenance and privacy', () => {
  const store=openStore(':memory:');
  try {
    initEvidence(store.db);
    const items=[material('a/Исследование.xlsx','Автоматизация платежа',3),material('b/Исследование.xlsx','Синхронизация остатков',7)];
    items[0].rows[0]=[...headings,'Проверяемая гипотеза','Связь с гипотезой'];
    items[0].rows[1].push('Действия по оплате выполняются вручную','опровергает');
    const first=office(items);
    importDocs(store,first,{notify:false});
    assert.equal(importDocs(store,first,{notify:false}).inserted,0);
    const saved=find(store.db,'автоматизация')[0];
    assert.equal(saved.source,'Оригинал.xlsx · Опрос!C3');
    assert.equal(saved.metadata.relation,'опровергает');
    const query = 'автоматизация платежа';
    store.db.prepare('INSERT INTO feedback(source,product,author,comment,created) VALUES(?,?,?,?,?)')
      .run(saved.source, 'Магазин', 'Продакт', '[Исключить связь] Другой сегмент.', 1);
    assert.equal(caseEvidenceSearch(store.db, 'Магазин', query, ['interview']).length, 0);
    assert.equal(caseEvidenceSearch(store.db, 'Лицензии', query, ['interview']).length, 1);
    assert.throws(() => find(store.db,query,'2026-02-30'), /календарную дату/);
    importDocs(store,office([material(items[0].file,'Новая схема оплаты',3)]),{notify:false});
    assert.equal(find(store.db,'автоматизация').length,0);
    assert.equal(find(store.db,'синхронизация').length,1);
    assert.ok(store.db.prepare('SELECT 1 FROM documents WHERE version=?').get(saved.version));
    assert.equal(importDocs(store,[first[0]],{notify:false}).inserted,1);
    assert.equal(find(store.db,'автоматизация')[0].version,saved.version);
    assert.throws(()=>office([material('pii.xlsx','Адрес test@example.invalid',5)]),/Обезличьте/);
    const legacy=[{file:'old.xlsx',facts:[{kind:'interview',loc:'Ответы!D2',text:'Темы ответа: поддержка'}]}];
    importDocs(store,legacy,{notify:false});
    assert.ok(find(store.db,'поддержка').length);
    assert.equal(find(store.db,'поддержка','2026-11-12').length,0);
    // Simulate upgrading an older SQLite DB with facts and no full-text index.
    store.db.exec('DROP TABLE research_fts');
    initEvidence(store.db);
    assert.equal(find(store.db,'синхронизация').length,1);
  } finally {store.close();}
});

test('external Excel hyperlink retains its target and its cell next to the archived row', () => {
  const headers=['Сопоставимый продукт у конкурента','Продукт','Конкурент','Карточка'];
  const rows=[headers,['Да','Книга','allsoft.ru','Открыть']];
  const xlsx=python('tests/research-workbooks.py',['--linked','Цена','D2','https://allsoft.ru/card'],JSON.stringify(rows));
  const [doc]=JSON.parse(python('scripts/office_import.py',['Конкуренты.xlsx'],xlsx));
  assert.deepEqual(doc.facts.at(-1).links,[{loc:'Цена!D2',url:'https://allsoft.ru/card'}]);
});
test('general sources workbook preserves a labeled link but interview recordings stay private', () => {
  const make=(name,title,rows,cell)=>{
    const b=python('tests/research-workbooks.py',['--linked',title,cell,'https://museum.example/doc'],JSON.stringify(rows));
    return JSON.parse(python('scripts/office_import.py',[name],b))[0];
  };
  const source=make('Ссылки.xlsx','Источники',[['Описание','Источник'],['Расписание','Открыть']],'B2');
  assert.deepEqual(source.facts[0]?.links,[{loc:'Источники!B2',url:'https://museum.example/doc'}]);
  const interview=make('Интервью.xlsx','Опрос',[['Роль','Кто?','Как?','Ссылка на запись интервью'],['ПМ','Тест','Тест','Открыть']],'D2');
  assert.ok(!JSON.stringify(interview).includes('https://museum.example/doc'));
});
test('survey contact variants stay outside stored evidence even in ordinary string columns',()=>{
 const rows=[['Роль','Ф. И. О.','Telegram','Мобильный','Name','Причина покупки'],
   ['Покупатель','Кодовоеимя','bareusername','Контактноеимя','PrivateName','Нужна гарантия']];
 const book=python('tests/research-workbooks.py',['--xlsx','Опрос'],JSON.stringify(rows));
 const [doc]=JSON.parse(python('scripts/office_import.py',['Опрос.xlsx'],book));
 assert.ok(doc.facts.some(f=>f.detail?.answer==='Нужна гарантия'));
 assert.doesNotMatch(JSON.stringify(doc),/Кодовоеимя|bareusername|Контактноеимя|PrivateName/);
});