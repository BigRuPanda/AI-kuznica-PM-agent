import assert from 'node:assert/strict';
import test from 'node:test';
import { nonWorkspaceCases } from '../scripts/acceptance/cases-nonworkspace.mjs';

const env = { DATA_PROFILE: 'configured', LLM_BACKEND: 'anymodel', LLM_MODEL: 'qwen/qwen3.8-27b',
  LLM_DATA_MODE: 'analysis', ANYMODEL_API_KEY: 'fixture' };

function modelReply(message) {
  return Response.json({ choices: [{ message: { role: 'assistant', ...message } }],
    usage: { prompt_tokens: 8, completion_tokens: 3 } });
}

function toolReply(name, args) {
  return modelReply({ content: null, tool_calls: [{ id: 'check-call', type: 'function',
    function: { name, arguments: JSON.stringify(args) } }] });
}

function scenario(id) {
  const item = nonWorkspaceCases.find(entry => entry.id === id);
  assert.ok(item, id);
  return item;
}

test('acceptance matrix covers release and investigation wire tools across independent prompts', () => {
  const declared = family => new Set(nonWorkspaceCases.filter(item => item.family === family)
    .flatMap(item => [...item.tools, ...(item.forcedTools || [])]));
  assert.deepEqual(declared('release'), new Set(['get_release', 'compare_metric', 'breakdown', 'funnel',
    'get_calculation', 'build_chart', 'record_findings']));
  assert.deepEqual(declared('investigation'), new Set(['read_findings', 'search_findings', 'submit_check',
    'submit_decision', 'submit_review']));
  assert.deepEqual(declared('selection'), new Set(['investigate']));
  assert.equal(new Set(nonWorkspaceCases.map(item => item.id)).size, nonWorkspaceCases.length);
  for (const item of nonWorkspaceCases) assert.equal(new Set(item.prompts).size, 3, item.id);
});

test('release golden case checks a saved calculation and the actual final answer', async () => {
  const item = scenario('release-compare');
  const run = answer => item.run({ question: item.prompts[0], attempt: 1, env, send: async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.tool_choice?.function?.name === 'record_findings')
      return toolReply('record_findings', { summary: 'Измерение подтверждено.', highlights: [], intervals: [] });
    if (request.messages.at(-1).role === 'tool') return modelReply({ content: answer });
    return toolReply('compare_metric', { metric: 0 });
  } });
  await run('До релиза оплатили 5 из 6 компаний, после релиза — 4 из 6.');
  await assert.rejects(run('До релиза оплатили 1 из 6, после — 3 из 6.'), /5.*6/);
  await assert.rejects(run('До релиза оплатили 4 из 6 компаний, после релиза — 5 из 6.'), /5.*6/);
  await run('**До релиза**: **5** из **6**. **После релиза**: **4** из **6**.');
});

test('release funnel rejects invented volumes despite correctly stored tool result', async () => {
  const item = scenario('release-funnel');
  const run = answer => item.run({ question: item.prompts[0], attempt: 1, env, send: async (_url, init) => {
    const request = JSON.parse(init.body);
    if (request.tool_choice?.function?.name === 'record_findings')
      return toolReply('record_findings', { highlights: [], intervals: [] });
    if (request.messages.at(-1).role === 'tool') return modelReply({ content: answer });
    return toolReply('funnel', {});
  } });
  await assert.rejects(run('До релиза: оформления 0, счета 0, оплаты 0. После релиза: оформления 0, счета 0, оплаты 0.'),
    /6.*6.*5/u);
  await run('До релиза: оформления 6, счета 6, оплаты 5. После релиза: оформления 6, счета 6, оплаты 4.');
});

test('public-page case rejects a successful HTTP reply followed by a fallback', async () => {
  const item = scenario('source-public-page');
  const run = content => item.run({ question: item.prompts[0], attempt: 1, env,
    send: async () => modelReply({ content }) });
  await run(JSON.stringify({ verdict: 'опровергнуто', answer: 'Пятница является выходным днём.',
    quote: 'Экспозиция закрыта по пятницам.' }));
  await run(JSON.stringify({ verdict: 'опровергнуто', answer: 'Пятница является выходным днём.',
    quote: 'закрыта по пятницам' }));
  await assert.rejects(run('{incorrect'), /опровергнуто/iu);
});

test('AnyModel has the same maximum budget for all direct synthesis routes', async t => {
  const elapsed = new Map();
  const makeTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => {
    const signal = makeTimeout(ms);
    elapsed.set(signal, ms);
    return signal;
  });
  const answers = {
    'source-brief': 'Когортный анализ делит пользователей на группы и сравнивает их поведение.',
    'source-archive': 'Добавили панель экспорта таблицы отчёта в CSV.',
    'source-web-search': 'Экспозиция открыта по субботам [1].',
    'source-public-page': JSON.stringify({ verdict: 'опровергнуто', answer: 'Пятница является выходным днём.',
      quote: 'закрыта по пятницам' }),
  };
  for (const [id, content] of Object.entries(answers)) {
    const item = scenario(id);
    const signals = [];
    await item.run({ question: item.prompts[0], attempt: 1, env: { ...env, PYTHON_BIN: process.env.PYTHON_BIN },
      send: async (_url, init) => {
        signals.push(elapsed.get(init.signal));
        return modelReply({ content });
      } });
    assert.deepEqual(signals, [600_000], id);
  }
});

async function runInvestigationFixture(item, includeInterviews) {
  let reads = 0;
  const result = await item.run({ question: item.prompts[0], attempt: 1, env, send: async (_url, init) => {
      const request = JSON.parse(init.body);
      const last = request.messages.at(-1);
      const submit = request.tools.find(tool => tool.function.name.startsWith('submit_')).function;
      if (request.tool_choice?.function?.name === 'read_findings') {
        reads++;
        const { catalog } = JSON.parse(last.content);
        return toolReply('read_findings', {
          ids: catalog.filter(finding => finding.kind === 'calculation' || finding.measurementGap ||
            (includeInterviews && finding.kind === 'interview'))
            .map(finding => finding.id),
        });
      }
      const findings = JSON.parse(last.content);
      const followUp = { question: 'Почему снизился индекс?', result: 'Падение наблюдалось в расчёте.',
        impact: 'Причину нужно проверить.', findingIds: [findings[0].id] };
      if (submit.parameters.properties.decision) {
        followUp.decision = { summary: 'Причина пока требует проверки.', action: 'Пройти путь оплаты.',
          plan: 'Сопоставить действие покупателя с записью об оплате.', outcomes: ['Проверить учёт события.'],
          hypotheses: [{ title: 'Сбой оплаты', for: [], against: [], test: 'Проверить покупку.' }] };
        for (const [relation, side] of [['подтверждает', 'for'], ['опровергает', 'against']]) {
          const evidence = findings.find(finding => finding.kind === 'interview' && finding.relation === relation);
          if (evidence) followUp.decision.hypotheses[0][side].push({ id: evidence.id, text: evidence.text });
        }
        const gap = findings.find(finding => finding.measurementGap);
        if (gap) followUp.decision.verification = { findingId: gap.id, scenario: 'Выполнить тестовое добавление.',
          behavior: 'появление товара в корзине', telemetry: 'регистрацию добавления в корзину',
          eventMissing: 'Исправить учёт события.', behaviorFailed: 'Проверить интерфейс.',
          bothPassed: 'Оценить следующий этап пути.' };
      }
      return toolReply(submit.name, followUp);
    } });
  assert.equal(reads, result.stages.length, item.id);
  assert.ok(result.hasPlan, item.id);
}

test('investigation cases reach the scheduler and require one accepted submission per role', async () => {
  for (const item of nonWorkspaceCases.filter(entry => entry.family === 'investigation')) {
    await runInvestigationFixture(item, item.id.includes('alternative'));
  }
  await assert.rejects(runInvestigationFixture(scenario('investigation-alternative-roles'), false),
    /свидетельств.*за и против/iu);
});
