import test from 'node:test';
import assert from 'node:assert/strict';
import { chatScenarios, loadScenarioDraft, selectScenario, serializeScenarioDraft } from '../web/chat-scenarios.ts';

const approved = [
  {label: 'Найти упущенный спрос',
    prompt: 'Найди по конкурентному исследованию возможность для Store: товар есть в ассортименте, покупатели его ищут, а конкуренты заметнее в поиске. Покажи конкретные запросы, частоту и позиции со ссылками на источник. Сверь с бэклогом и предложи одну задачу или дополнение к существующей.'},
  {label: 'Выбрать, что проверить сегодня',
    prompt: 'Посмотри открытые сигналы и выбери один, с которого стоит начать сегодня. Покажи, что изменилось, как долго это продолжается и насколько полны данные. Объясни, почему этот сигнал важнее остальных, и предложи первый шаг проверки.'},
  {label: 'Найти потери в воронке',
    prompt: 'Проверь воронку подбора для продукта, который мы обсуждаем. Покажи объём на каждом измеренном шаге и единицу измерения, где потеря самая большая и отличается ли она на телефонах и компьютерах. Отметь шаги, для которых не хватает событий. Если продукт ещё не назван, уточни его.'},
  {label: 'Проверить гипотезу',
    prompt: 'Проверь гипотезу из нашей переписки по метрикам, интервью и релизам. Если гипотеза ещё не сформулирована, попроси меня её назвать. Приведи самое сильное свидетельство в её пользу и самое сильное возражение со ссылками на источники. Какую одну проверку стоит провести, чтобы решить, брать ли задачу в работу?'},
  {label: 'Проверить эффект релиза',
    prompt: 'Сравни целевую метрику до и после релиза, проверь контроль и полноту периода. Если из переписки неясно, о каком релизе идёт речь, уточни его. Сопоставь результат с согласованным критерием успеха, если он задан. Порекомендуй завершить наблюдение, продолжить его или пересмотреть гипотезу. Если данных пока мало, укажи, чего ждём.'},
];
const empty = {text: '', scenarioId: null};
const detail = 'Только Kaspersky, мобильные, октябрь';

test('each of the five menu choices inserts its approved editable prompt', () => {
  assert.equal(approved.length, 5);
  assert.deepEqual(chatScenarios.map(({label, prompt}) => ({label, prompt})), approved);
  assert.equal(new Set(chatScenarios.map(s => s.id)).size, 5);
  for (const {id, prompt} of chatScenarios) assert.deepEqual(selectScenario(empty, id), {text: prompt, scenarioId: id});
});

test('switching scenarios keeps only the latest prompt and one copy of the personal draft', () => {
  const [first, second, third] = chatScenarios;
  let draft = selectScenario({text: detail, scenarioId: null}, first.id);
  draft = selectScenario(draft, second.id);
  draft = selectScenario(draft, third.id);
  assert.equal(draft.text, third.prompt + '\n\n' + detail);
  assert.deepEqual(selectScenario(draft, third.id), draft);
  const plain = selectScenario(empty, first.id);
  assert.equal(selectScenario(plain, second.id).text, second.prompt);
  assert.equal(selectScenario({...plain, text: plain.text + ' ' + detail}, second.id).text,
    second.prompt + '\n\n ' + detail);
});

test('reselecting keeps a rewritten prompt and switching preserves the whole rewrite', () => {
  const [first, second] = chatScenarios;
  const edited = {scenarioId: first.id, text: first.prompt.replace('Store', 'Softline Store')};
  assert.deepEqual(selectScenario(edited, first.id), edited);
  assert.equal(selectScenario(edited, second.id).text, second.prompt + '\n\n' + edited.text);
  assert.equal(selectScenario({scenarioId:first.id, text:''}, first.id).text, first.prompt);
});

test('draft storage restores edited scenarios, original plain text, and interrupted sends', () => {
  const [first, second] = chatScenarios;
  const draft = selectScenario({text: detail, scenarioId: null}, first.id);
  assert.deepEqual(selectScenario(loadScenarioDraft(serializeScenarioDraft(draft), ''), second.id),
    {text: second.prompt + '\n\n' + detail, scenarioId: second.id});
  const old = JSON.stringify({text: 'собственный JSON', scenarioId:first.id});
  assert.deepEqual(loadScenarioDraft(old, 'pending'), {text:old, scenarioId:null});
  assert.deepEqual(loadScenarioDraft(null, detail), {text:detail, scenarioId:null});
});
