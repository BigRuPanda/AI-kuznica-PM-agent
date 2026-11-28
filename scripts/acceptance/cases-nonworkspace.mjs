import assert from 'node:assert/strict';
import { makeAgent } from '../../server/agent.mjs';
import { page, runTool } from '../../server/analytics.mjs';
import { archiveAnswer } from '../../server/archive-search.mjs';
import { createAlternative, initInvestigations, listInvestigationWork, readInvestigations,
  tryStartInvestigation } from '../../server/case-investigations.mjs';
import { briefConversation } from '../../server/chat-brief.mjs';
import { importDocs, initEvidence, setSetting } from '../../server/evidence.mjs';
import { saveResearchSettings } from '../../server/investigation-settings.mjs';
import { stageOrder } from '../../server/investigation-stages.mjs';
import { publicAnswer } from '../../server/source-chat.mjs';
import { openStore } from '../../server/store.mjs';
import { webAnswer } from '../../server/web-search.mjs';
import { answer, createThread, initWorkbench } from '../../server/workbench.mjs';
import { workspaceOperation } from '../../server/workspace-operations.mjs';
import { seedReleaseMetrics } from '../../tests/release-metrics-fixture.mjs';

const actor = { id: 'acceptance-pm', name: 'Анна', role: 'admin', space: 'team' };
const day = offset => new Date(Date.UTC(2026, 5, 29 + offset)).toISOString().slice(0, 10);

async function withStore(run, workspace = true) {
  const store = openStore(':memory:');
  try {
    if (workspace) {
      initEvidence(store.db);
      initWorkbench(store.db);
    }
    return await run(store);
  } finally {
    store.close();
  }
}

function releaseCase(id, tools, prompts, verify, { releaseId = 'R-001', metric = 0, saved = false } = {}) {
  return {
    id, family: 'release', tools, prompts, forcedTools: ['record_findings'],
    run: ({ question, env, send }) => withStore(async store => {
      seedReleaseMetrics(store);
      const { context } = page(store, { releaseId, day: 14, metric, segment: 'all' });
      const prior = saved ? runTool(store, 'compare_metric', context) : null;
      if (prior) {
        store.addMessage(releaseId, 'fixture-reference', { role: 'assistant', author: 'Агент',
          text: 'Сохранил расчёт доли оплат.', context, created: 1,
          refs: [{ id: prior.id, title: 'Доля оплат', op: prior.op }] });
      }
      const agent = makeAgent(store, { env, send });
      const reply = await agent.ask({ ...context, question,
        author: actor.name, requestId: 'acceptance' }, actor.name, actor.id);
      await agent.waitForReviews();
      assert.ok(reply.text.trim());
      const calculations = reply.refs.map(({ id: calcId }) => store.getCalc(calcId));
      for (const calculation of calculations) {
        assert.equal(calculation.context.releaseId, releaseId);
        assert.equal(calculation.context.day, 14);
        assert.equal(calculation.context.version, context.version);
      }
      const stored = { reply, prior, calculations };
      verify(stored);
      const report = page(store, context).report;
      assert.ok(report?.answer?.trim(), 'Ожидался сохранённый итог record_findings');
      assert.equal(report.calc, store.getCalc(report.calc).id);
      return { receiptOps: calculations.map(calculation => calculation.op), report: true };
    }, false),
  };
}

function calculation({ calculations }, op) {
  const result = calculations.find(item => item.op === op)?.result;
  assert.ok(result, 'Отсутствует подтверждённый расчёт ' + op);
  return result;
}

const periodLabels = /(?<![\p{L}\p{N}])(до|после)(?:\s+(?:релиза|выкладки|обновления)|(?=\s*[:|—–]))/giu;
const cohortLabels = /(?<!\p{L})(новые|постоянные|возвращающиеся)(?:\s+(?:компании|клиенты))?(?=\s*[:|—–])/giu;

function labelledSections(text, pattern) {
  const normalized = text.replace(/[*_`]/gu, '');
  const markers = [...normalized.matchAll(pattern)];
  return markers.map((marker, i) => ({
    label: marker[1].toLocaleLowerCase('ru'),
    value: normalized.slice(marker.index + marker[0].length, markers[i + 1]?.index),
  }));
}

function pairs(text) {
  return [...text.matchAll(/\b(\d+)\s*(?:[/⁄∕]|\s*(?:\p{L}+\s+){0,3}из|\s*\|\s*)\s*(\d+)\b/giu)]
    .map(match => match.slice(1).map(Number));
}

function verifyFractions(text, expectations) {
  const sections = labelledSections(text, periodLabels);
  for (const [label, [n, d]] of Object.entries(expectations)) {
    const observed = sections.filter(section => section.label === label).flatMap(section => pairs(section.value));
    assert.ok(observed.length && observed.every(([actualN, actualD]) => actualN === n && actualD === d),
      'Ожидалось ' + n + ' из ' + d + ' в разделе «' + label + ' релиза». Ответ: ' + text);
  }
}

function verifyFunnelVolumes(text) {
  const sections = labelledSections(text, periodLabels);
  for (const [label, expected] of [['до', [6, 6, 5]], ['после', [6, 6, 4]]]) {
    assert.ok(sections.filter(section => section.label === label).some(section => {
      const counts = [...section.value.matchAll(/\b\d+\b/gu)].map(match => Number(match[0]));
      return counts.some((_count, i) => expected.every((value, j) => counts[i + j] === value));
    }), 'Ожидалось ' + expected.join(', ') + ' в разделе «' + label + ' релиза». Ответ: ' + text);
  }
}

const labelPeriods = prompts => prompts.map(prompt => prompt + ' Дай отдельные строки «До релиза» и «После релиза».');
const releaseCases = [
  releaseCase('release-compare', ['compare_metric'], labelPeriods([
    'Сравни долю оформлений, закончившихся оплатой, за семь дней до и после релиза. Назови числитель и знаменатель для обоих периодов.',
    'Сколько из всех начавших оформление компаний оплатили заказ в обеих неделях по сторонам релиза? Укажи обе дроби.',
    'Проверь конверсию из оформления в оплату до и после выкладки. Дай по каждому периоду количество оплат и общее количество.',
  ]), state => {
    const result = calculation(state, 'compare_metric').series.all;
    assert.deepEqual([result.before.n, result.before.d, result.after.n, result.after.d], [5, 6, 4, 6]);
    verifyFractions(state.reply.text, { до: [5, 6], после: [4, 6] });
  }),
  releaseCase('release-description', ['get_release'], labelPeriods([
    'Уточни по карточке релиза, что изменили в оформлении заказа и для каких компаний. Затем сопоставь числители и знаменатели доли оплат за неделю до и после.',
    'Открой описание текущей выкладки, назови её изменение и аудиторию, потом укажи, сколько компаний из всех начавших оформление оплатили до и после.',
    'Проверь в карточке, какие поля изменили и кто попадал в аудиторию. Сверь конверсию оформления в оплату и приведи обе дроби.',
  ]), ({ reply }) => {
    assert.match(reply.text, /(?:поряд|располож|последовательност).{0,55}пол(?:я|ей)|пол(?:я|ей).{0,55}(?:поряд|располож)/iu);
    assert.match(reply.text, /(?:компан|клиент).{0,90}(?:оформлен|оформля)/iu);
    verifyFractions(reply.text, { до: [5, 6], после: [4, 6] });
  }),
  releaseCase('release-cohorts', ['breakdown'], [
    'Разбери оплату отдельно по новым и постоянным компаниям. Сверь числители и знаменатели до и после и объясни роль состава. Дай строки «Новые» и «Постоянные».',
    'Проверь конверсию оформления в оплату в двух группах: новые компании и те, кто уже покупал. Укажи обе дроби в каждой строке «Новые» и «Постоянные», сначала до выкладки, затем после.',
    'Сделай разбивку по новым и возвращающимся клиентам, чтобы проверить, почему изменилась общая доля. Дай по две дроби в строках «Новые» и «Возвращающиеся», до и после.',
  ], state => {
    const result = calculation(state, 'breakdown');
    const newcomers = result.new.series.all;
    const returning = result.returning.series.all;
    assert.deepEqual([newcomers.before.n, newcomers.before.d, newcomers.after.n, newcomers.after.d],
      [1, 2, 2, 4]);
    assert.deepEqual([returning.before.n, returning.before.d, returning.after.n, returning.after.d],
      [4, 4, 2, 2]);
    const sections = labelledSections(state.reply.text, cohortLabels);
    assert.deepEqual(sections.filter(section => section.label === 'новые').flatMap(section => pairs(section.value)),
      [[1, 2], [2, 4]], 'Неверные числа для новых компаний. Ответ: ' + state.reply.text);
    assert.deepEqual(sections.filter(section => section.label !== 'новые').flatMap(section => pairs(section.value)),
      [[4, 4], [2, 2]], 'Неверные числа для постоянных компаний. Ответ: ' + state.reply.text);
  }),
  releaseCase('release-funnel', ['funnel'], labelPeriods([
    'Рассчитай последовательную воронку оформления, выставления счёта и оплаты до и после релиза. Назови объём каждого шага.',
    'Сколько заказов до и после выкладки было на этапах «оформили → выставили счёт → оплатили»? Проверь связанный путь заказа.',
    'Покажи воронку по обе стороны релиза с тремя шагами: начало оформления, счёт, оплата. Нужны количества.',
  ]), state => {
    assert.deepEqual(calculation(state, 'funnel').steps.map(step => [step.checkout, step.invoiced, step.paid]),
      [[6, 6, 5], [6, 6, 4]]);
    assert.match(state.reply.text, /оформлен/iu);
    assert.match(state.reply.text, /сч[её]т/iu);
    assert.match(state.reply.text, /оплат/iu);
    verifyFunnelVolumes(state.reply.text);
  }),
  releaseCase('release-saved-calculation', ['get_calculation'], [
    'Открой тот сохранённый расчёт доли оплат из предыдущей реплики. Какие числа в нём записаны для периода после релиза?',
    'Вернись к приложенному ранее расчёту. Сверь по нему оплату после выкладки и приложи тот же результат.',
    'Посмотри ранее сохранённый расчёт, который только что приложили к чату. Ответь по его числителю и знаменателю после релиза.',
  ], ({ reply, prior }) => {
    assert.ok(reply.refs.some(ref => ref.id === prior.id), 'Ожидался исходный сохранённый расчёт');
    assert.ok(pairs(reply.text.replace(/[*_]/gu, '')).some(([n, d]) => n === 4 && d === 6),
      'Ожидалось 4 из 6. Ответ: ' + reply.text);
  }, { saved: true }),
  releaseCase('release-custom-chart', ['build_chart'], [
    'Построй новую дневную метрику: медиана дней от выставления счёта до его оплаты. Сколько дней после релиза?',
    'Нужен график типичного времени от счёта до оплаты в днях. Возьми медиану и назови значение за период после выкладки.',
    'Рассчитай собственный показатель скорости оплаты: медианное число дней между выставлением и получением оплаты. Сохрани график.',
  ], state => {
    const result = calculation(state, 'build_chart');
    assert.deepEqual([result.spec.field, result.spec.stat, result.spec.start, result.spec.end],
      ['duration', 'median', 'invoice', 'payment']);
    assert.deepEqual(result.after, { value: 3, n: 4 });
    assert.match(state.reply.text, /(?:\b3(?:[,.]0+)?\s*(?:дн|сут)|три\s*(?:дн|сут))/iu);
  }, { releaseId: 'R-002', metric: 1 }),
];

function seedSales(store, gap = false) {
  const facts = [];
  for (let i = 0; i < 20; i++) {
    for (const [product, before, after] of [['Альфа', 160, 90], ['Бета', 100, 105]]) {
      facts.push({ kind: 'sales', loc: product + '!A' + (i + 2),
        row: { product_family: product, week_start: day(7 * i), orders_index: i < 14 ? before : after } });
    }
  }
  facts.push(
    { kind: 'releases', loc: 'Релизы!A2', row: { release_id: 'R-ALPHA', release_date: '2026-10-01',
      release_type: 'major', description: 'Обновление подбора Альфа', affected_metrics: 'cart' } },
    { kind: 'backlog', loc: 'Задачи!A2', row: { task_id: 'QA-12', title: 'Проверка пути оплаты Альфа',
      status: 'New', linked_metric_ids: 'cart', created_date: '2026-10-06' } },
    { kind: 'interview', loc: 'Интервью!B2', row: { product: 'Альфа', excerpt: 'Участник столкнулся со сбоем оплаты.',
      date: '2026-10-13', hypothesis: 'сбой оплаты', relation: 'подтверждает' } },
    { kind: 'interview', loc: 'Интервью!B3', row: { product: 'Альфа', excerpt: 'Другой участник оплатил заказ.',
      date: '2026-10-14', hypothesis: 'сбой оплаты', relation: 'опровергает' } },
  );
  if (gap) facts.push({ kind: 'dictionary', loc: 'Справочник!A8', row: { metric_id: 'cart',
    metric_name: 'Событие корзины', comment: 'Альфа: событие корзины не фиксируется' } });
  importDocs(store, [{ file: 'Синтетические продажи.xlsx', facts }], { notify: false });
}

const selectionCase = {
  id: 'selection-investigate', family: 'selection', tools: ['investigate'],
  prompts: [
    'Сравни индекс самостоятельных заказов Альфа до и после релиза за полные недели.',
    'Проверь, как сдвинулся индекс заказов для продукта Альфа после выкладки. Возьми только завершённые недели.',
    'Нужен расчёт динамики индекса заказов Альфа вокруг релиза с исключением неполных недель.',
  ],
  run: ({ question, env, send }) => withStore(async store => {
    seedSales(store);
    const { id: caseId } = workspaceOperation(store, actor, 'create-case', { title: 'Индекс Альфа', product: 'Альфа' });
    const thread = createThread(store.db, actor, 'Выбор расчёта');
    const result = await answer(store, actor, { thread, caseId, question }, { ...env, LLM_DATA_MODE: 'selection' }, send);
    assert.equal(result.mode, 'llm', 'Ожидался расчёт, выбранный моделью');
    assert.ok(!result.warning);
    assert.equal(result.product, 'Альфа');
    assert.equal(result.full, true);
    assert.ok(result.calc && result.cards?.some(card => ['summary', 'trend'].includes(card)));
    return { product: result.product, cards: result.cards, fullWeeks: result.full };
  }),
};

async function finishRun(store, caseId, runId, mode, env, send, options) {
  for (let i = 0; i <= stageOrder[mode].length; i++) {
    const work = listInvestigationWork(store, env, Date.now(), runId)[0];
    if (!work) {
      const { current, alternatives } = readInvestigations(store.db, actor, caseId);
      const idle = [current, ...alternatives].find(candidate => candidate?.id === runId);
      assert.fail(idle?.reason || 'Этап расследования недоступен');
    }
    const run = await tryStartInvestigation(store, work, env, send, options);
    assert.ok(run, 'Этап расследования не запустился');
    assert.ok(['queued', 'ready'].includes(run.status), run.reason || 'Статус расследования: ' + run.status);
    if (run.status === 'ready') return run;
  }
  assert.fail('Расследование не завершилось после однократного запуска каждого этапа');
}

const investigationPrompts = [
  'Почему после релиза снизился индекс заказов Альфа? Сверь контроль и укажи проверяемую гипотезу.',
  'Проверь падение индекса Альфа вокруг выкладки. Сопоставь с Бета и предложи следующее действие.',
  'Разбери, связано ли снижение заказов Альфа с релизом. Сверь показатели контрольного продукта.',
];
const alternativePrompts = [
  'В сохранённом снимке найди интервью про сбой оплаты Альфа и запись, которая ставит эту версию под сомнение.',
  'Поищи по сохранённым свидетельствам «сбой оплаты», сопоставь свидетельства за и против и предложи проверку.',
  'Найди в материалах сохранённого разбора упоминания сбоя оплаты. Сверь их с возражениями и уточни вывод.',
];

function investigationCase(mode, { alternate = false, gap = false } = {}) {
  const tools = alternate ? ['search_findings'] : [];
  const forcedTools = ['read_findings', 'submit_assessment', 'submit_plan', ...(gap ? ['submit_verification'] : [])];
  return {
    id: 'investigation-' + (alternate ? 'alternative-' : gap ? 'measurement-' : '') + mode,
    family: 'investigation', tools, forcedTools, requiredTools:['submit_check'],
    prompts: alternate ? alternativePrompts : gap ? [
      'Проверь гипотезу о регистрации добавления в корзину Альфа. Предложи один прогон проверки действия и события.',
      'Сверь замечание про учёт корзины. Опиши, что проверить в интерфейсе и какое событие сверить в аналитике.',
      'Разбери, влияет ли ограничение учёта корзины на вывод. Укажи парную проверку поведения и регистрации события.',
    ] : investigationPrompts,
    run: ({ question, env, send }) => withStore(async store => {
      const { db } = store;
      initInvestigations(db);
      seedSales(store, gap);
      setSetting(db, 'investigation_auto_retry', false);
      saveResearchSettings(db, actor, { scope: 'personal', mode });
      const { id: caseId } = workspaceOperation(store, actor, 'create-case', {
        title: alternate ? 'Падение индекса после релиза' : question, product: 'Альфа',
      });
      const parent = readInvestigations(db, actor, caseId).current;
      assert.ok(parent?.id, 'Не создано исходное расследование');
      let runId = parent.id;
      if (alternate) {
        // Seed an already reviewed parent, so only the alternative consumes live attempts.
        const parentReady = await finishRun(store, caseId, parent.id, mode, env,
          () => assert.fail('В fixture исходного расследования ожидалось ноль внешних запросов'), {
            execute: async ({ stage }) => ({ check: { role: stage, result: 'Исходный тестовый вывод' },
              result: { summary: 'Падение индекса требует проверки.' } }),
          });
        assert.equal(parentReady.status, 'ready');
        const alternative = createAlternative(db, actor, { caseId, parentId: parent.id,
          question, requestId: 'acceptance-alternative' });
        runId = alternative.id;
      }
      const ready = await finishRun(store, caseId, runId, mode, env, send);
      assert.equal(ready.status, 'ready');
      assert.equal(ready.mode, mode);
      assert.ok(ready.calcId && ready.result?.plan?.trim());
      assert.ok(ready.result.hypotheses.length > 0 && ready.result.outcomes.length > 0);
      if (alternate) {
        assert.equal(ready.parentId, parent.id);
        const { capture } = store.one('SELECT capture FROM case_investigations WHERE id=?', runId);
        const interviews = JSON.parse(capture).context.findings.filter(finding => finding.kind === 'interview');
        const supporting = interviews.find(finding => finding.relation === 'подтверждает')?.id;
        const opposing = interviews.find(finding => finding.relation === 'опровергает')?.id;
        assert.ok(supporting && opposing && ready.result.hypotheses.some(hypothesis =>
          hypothesis.sourceRefs.for.some(source => source.findingId === supporting) &&
          hypothesis.sourceRefs.against.some(source => source.findingId === opposing)),
        'Ожидались конкретные свидетельства за и против гипотезы сбоя оплаты');
      }
      if (gap) assert.match(ready.result.action, /корзин/iu);
      const attempts = db.prepare('SELECT role,attempt,status FROM case_investigation_role_state WHERE run_id=? ORDER BY ordinal').all(runId);
      assert.deepEqual(attempts.map(row => [row.role, row.attempt, row.status]),
        stageOrder[mode].map(role => [role, 1, 'done']));
      for (const role of stageOrder[mode]) {
        const check = ready.checks.find(item => item.role === role);
        assert.equal(check?.status, 'done', 'Ожидалась успешная проверка у роли ' + role);
        assert.ok(check.sources?.length, 'Нет прочитанных свидетельств у роли ' + role);
        assert.ok(check.sources.every(source => source.calcId === ready.calcId && source.findingId),
          'Ссылка роли ' + role + ' должна вести к сохранённому свидетельству');
      }
      return { mode, stages: attempts.map(row => row.role), hasPlan: true };
    }),
  };
}

const publicUrl = 'https://museum.example/visit';
const publicQuote = 'Экспозиция закрыта по пятницам.';
const sourceCases = [
  {
    id: 'source-brief', family: 'source', tools: [],
    prompts: ['Что такое когортный анализ?', 'Объясни понятие когортный анализ.',
      'Расскажи простыми словами, как работает когортный анализ.'],
    run: ({ question, env, send }) => withStore(async store => {
      const response = await briefConversation(store, 'brief', question, null, env, send, []);
      assert.equal(response?.mode, 'conversation');
      assert.ok(!response.briefUnavailable);
      assert.match(response.text, /когорт|групп/iu);
      assert.match(response.text, /сравн|поведен|времен|период/iu);
    }),
  },
  {
    id: 'source-archive', family: 'source', tools: [],
    prompts: ['Какое изменение записали для релиза Q-317 и что теперь экспортируется?',
      'Сформулируй по архиву назначение панели релиза Q-317. Что можно выгружать?',
      'По архивному описанию Q-317 сообщи, какая панель появилась и какие данные она выгружает.'],
    run: ({ question, env, send }) => withStore(async store => {
      const file = 'Синтетический архив.xlsx', loc = 'Релизы!A2';
      const text = 'Q-317 · 2026-10-01 · Добавлена панель экспорта таблицы отчёта в CSV.';
      importDocs(store, [{ file, facts: [{ kind: 'releases', loc, row: {
        release_id: 'Q-317', release_date: '2026-10-01', description: text,
      } }] }], { notify: false });
      const { version } = store.one('SELECT version FROM documents WHERE file=?', file);
      const result = await archiveAnswer(store, question, [{ kind: 'releases', text,
        refs: [{ file, loc, version }] }], env, send, 'archive');
      assert.equal(result.outcome, 'done');
      assert.match(result.text, /панел/iu);
      assert.match(result.text, /\bCSV\b/iu);
      assert.match(result.text, /таблиц|отч[её]т/iu);
      assert.equal(result.readSources[0].url, '#knowledge-source/' + version + '/' + encodeURIComponent(loc));
    }),
  },
  {
    id: 'source-web-search', family: 'source', tools: [],
    prompts: ['В какие дни открыта экспозиция тестового музея по результату поиска?',
      'Проверь по выданной странице, когда можно посетить экспозицию тестового музея.',
      'Обобщи фрагмент выдачи о днях работы экспозиции тестового музея.'],
    run: ({ question, env, send }) => withStore(async store => {
      const xml = '<yandexsearch><response><results><grouping><group><doc><url>' + publicUrl +
        '</url><title>Выставка</title><passages><passage>Экспозиция открыта по субботам.</passage>' +
        '</passages></doc></group></grouping></results></response></yandexsearch>';
      const result = await webAnswer(store, 'web', question, { ...env, YANDEX_SEARCH_API_KEY: 'fixture',
        YANDEX_SEARCH_FOLDER_ID: 'fixture' }, async (url, init) => {
        if (String(url) === 'https://searchapi.api.cloud.yandex.net/v2/web/search')
          return Response.json({ rawData: Buffer.from(xml).toString('base64') });
        return send(url, init);
      });
      assert.equal(result.mode, 'web');
      assert.equal(result.webSearchCount, 1);
      assert.match(result.text, /суббот/iu);
      assert.doesNotMatch(result.text, /(?:закрыт\p{L}*|не\s+(?:работает|открыта|доступна))\s+(?:по\s+|в\s+)?суббот/iu);
      assert.match(result.text, /\[1\]/u);
      assert.doesNotMatch(result.text, /Фрагменты из выдачи Яндекса|https?:\/\//iu);
      assert.equal(result.readSources[0].url, publicUrl);
    }),
  },
  {
    id: 'source-public-page', family: 'source', tools: [],
    prompts: [
      'Проверь, верно ли, что экспозиция открыта по пятницам, по странице ' + publicUrl,
      'На ' + publicUrl + ' подтверди или опровергни утверждение: экспозиция открыта в пятницу.',
      'Сверь утверждение «экспозиция работает по пятницам» с расписанием на ' + publicUrl,
    ],
    run: ({ question, env, send }) => withStore(async store => {
      const result = await publicAnswer(store, { question }, env, send, 'page', {
        resolveHost: async () => [{ address: '93.184.216.34', family: 4 }],
        request: async url => {
          assert.equal(url.href, publicUrl);
          return new Response('<title>Тестовый музей</title><p>' + publicQuote + '</p>',
            { headers: { 'content-type': 'text/html' } });
        },
      });
      assert.equal(result.mode, 'public-page');
      assert.match(result.text, /^опровергнуто\./iu);
      const quote = result.text.match(/\n«([^»]+)»/u)?.[1];
      assert.ok(quote && publicQuote.includes(quote) && /закрыта по пятницам/iu.test(quote),
        'Ожидалась дословная цитата о расписании');
      assert.equal(result.readSources.at(-1).url, publicUrl);
    }),
  },
];

export const nonWorkspaceCases = [...['lead', 'review', 'roles'].map(mode => investigationCase(mode)),
  investigationCase('roles', { alternate: true }), investigationCase('lead', { gap: true }),
  ...sourceCases, selectionCase, ...releaseCases];
