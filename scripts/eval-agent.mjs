import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs } from '../server/evidence.mjs';
import { initWorkbench, createThread, enqueue, workJobs, messages } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { apiConfigured } from '../server/agent.mjs';
export function evaluationCase(s, user) {
  const facts = [],
    week = 604800000,
    start = Date.UTC(2026, 5, 29);
  for (let i = 0; i < 22; i++)
    for (const product of ['Kaspersky', 'Astra']) {
      const date = new Date(start + i * week).toISOString().slice(0, 10);
      facts.push({
        kind: 'sales',
        loc: product + '!A' + (i + 2),
        row: {
          product_family: product,
          week_start: date,
          orders_index: product === 'Kaspersky' && i >= 14 ? 70 : 100,
          comment: i === 21 ? 'неполная неделя' : null,
        },
      });
    }
  facts.push(
    {
      kind: 'releases',
      loc: 'Релизы!A2',
      row: {
        release_id: 'DEMO-R',
        release_type: 'major',
        release_date: '2026-10-01',
        description: 'Тестовый конфигуратор Kaspersky',
      },
    },
    {
      kind: 'backlog',
      loc: 'Бэклог!A2',
      row: {
        task_id: 'DEMO-T',
        title: 'Проверка разметки Kaspersky',
        type: 'Ошибка',
        status: 'New',
        description_short: 'Проверить полноту событий корзины.',
      },
    },
    {
      kind: 'interview',
      loc: 'Тест!A2',
      text: 'Kaspersky · участнику синтетического примера непонятен выбор версии лицензии.',
    },
  );
  importDocs(s, [{ file: 'Synthetic evaluation.xlsx', facts }], { notify: false });
  const c = workspaceOperation(s, user, 'create-case', {
    title: 'Проверка синтетического кейса',
    product: 'Kaspersky',
  });
  const v = workspaceOperation(s, user, 'view', { caseId: c.id, control: 'Astra' }).view;
  return {
    caseId: c.id,
    selection: {
      source: 'weekly',
      calcId: v.id,
      version: v.id,
      metric: 'orders_index',
      series: ['Kaspersky', 'Astra'],
      ranges: [
        { from: Date.UTC(2026, 8, 7), to: Date.UTC(2026, 8, 28) },
        { from: Date.UTC(2026, 9, 5), to: Date.UTC(2026, 10, 2) },
      ],
    },
  };
}
async function main() {
  const opts = Object.fromEntries(process.argv.slice(2).map((s) => s.replace(/^--/, '').split('=')));
  const env = {
    ...process.env,
    LLM_MODEL: opts.model || process.env.LLM_MODEL,
    LLM_DATA_MODE: 'analysis',
    JIRA_BASE_URL: '',
    NOTIFICATIONS_ENABLED: 'false',
  };
  if (!apiConfigured(env)) throw Error('Заполните настройки LLM в .env');
  const s = openStore(':memory:'),
    u = { id: 'test', name: 'Испытатель', role: 'judge' },
    result = [];
  try {
    initEvidence(s.db);
    initWorkbench(s.db);
    const { caseId, selection } = evaluationCase(s, u),
      thread = createThread(s.db, u, 'Синтетическая приёмка');
    const questions = [
      'Привет!',
      'Почему в B у Kaspersky снизился индекс относительно A сильнее, чем у Astra? Проверь соседние периоды, релизы и свидетельства.',
      'Что могло бы опровергнуть эту гипотезу?',
      'Подготовь по этому выводу ровно один черновик задачи для QA. Никуда не отправляй.',
    ];
    let saved;
    for (const [i, question] of questions.entries()) {
      const job = enqueue(s, u, { thread, caseId, question, ...(i === 1 ? { selection } : {}) }),
        start = performance.now();
      await workJobs(s, { publicUser: () => u }, env, fetch);
      const answer = messages(s.db, u, thread).items.at(-1).body,
        usage = s.one(
          'SELECT count(*) calls, sum(input) input, sum(output) output FROM costs WHERE job=?',
          job,
        );
      if (i === 1) saved = answer.rangeId;
      const check = [
        () => !!answer.text && !answer.steps?.length,
        () =>
          !!answer.rangeId &&
          answer.steps?.some((n) => ['view', 'search', 'selection_context'].includes(n)) &&
          /30|70/.test(answer.text),
        () => !!saved && answer.rangeId === saved,
        () =>
          answer.actions?.some((a) => a.op === 'draft') &&
          s.one('SELECT count(*) n FROM draft_actions').n === 1 &&
          s.one('SELECT count(*) n FROM local_issues').n === 0,
      ][i]();
      const pin =
          opts['input-price'] ?? (env.LLM_MODEL === process.env.LLM_MODEL ? env.PRICE_INPUT_MILLION : null),
        pout =
          opts['output-price'] ?? (env.LLM_MODEL === process.env.LLM_MODEL ? env.PRICE_OUTPUT_MILLION : null);
      const modelCost =
        pin != null && pin !== '' && pout != null && pout !== '' && usage.input != null
          ? (Number(pin) * usage.input + Number(pout) * usage.output) / 1e6
          : null;
      result.push({
        question,
        answer: answer.text,
        passed: !!check && !answer.warning,
        steps: answer.steps,
        wallMs: Math.round(performance.now() - start),
        ...usage,
        modelCost,
      });
    }
    console.log(JSON.stringify({ model: env.LLM_MODEL, synthetic: true, results: result }, null, 2));
    if (result.some((r) => !r.passed)) process.exitCode = 1;
  } finally {
    s.close();
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((e) => {
    console.error(e.message);
    process.exitCode = 1;
  });
