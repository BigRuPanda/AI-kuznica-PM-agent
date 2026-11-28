import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs } from '../server/evidence.mjs';
import { initWorkbench, createThread, enqueue, workJobs, messages } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { apiConfigured } from '../server/agent.mjs';
import { readMaterial } from '../server/materials.mjs';
export function evaluationCase(s, user, env = process.env) {
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
  for (let i = 0; i < 22; i++) {
    const date = new Date(start + i * week).toISOString().slice(0, 10);
    for (const [segment, open, complete] of [
      ['desktop', 100, i < 14 ? 80 : 75],
      ['mobile', 50, i < 14 ? 30 : 25],
    ]) {
      facts.push({
        kind: 'metrics',
        loc: segment + '!A' + (i + 2),
        row: {
          product: 'Конфигуратор Астра',
          metric_id: 'cfg_completion_rate',
          date,
          segment,
          unit: 'ratio',
          value: complete / open,
          detail_json: JSON.stringify({ open, complete }),
        },
      });
    }
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
  }, env);
  const v = workspaceOperation(s, user, 'view', { caseId: c.id, control: 'Astra' }, env).view;
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
  if (opts.suite === 'first-pass') {
    const { firstPass } = await import('./acceptance/runner.mjs');
    return firstPass(opts);
  }
  const env = {
    ...process.env,
    LLM_MODEL: opts.model || process.env.LLM_MODEL,
    LLM_DATA_MODE: 'analysis',
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
      'Покажи график завершения подбора Astra и разбери причины изменения в выбранных периодах.',
    ];
    let saved;
    for (const [i, question] of questions.entries()) {
      const extra =
        i === 4
          ? (() => {
              const c = workspaceOperation(s, u, 'create-case', {
                title: 'Синтетическая воронка',
                product: 'Astra',
              });
              const view = workspaceOperation(s, u, 'view', {
                caseId: c.id,
                control: 'Kaspersky',
                from: '2026-06-29',
              }).view;
              return {
                caseId: c.id,
                thread: createThread(s.db, u, 'Воронка Astra'),
                selection: { ...selection, calcId: view.id, version: view.id },
              };
            })()
          : {};
      const job = enqueue(s, u, { thread, caseId, question, ...(i === 1 ? { selection } : {}), ...extra }),
        start = performance.now();
      await workJobs(s, { publicUser: () => u }, env, fetch);
      const answer = messages(s.db, u, extra.thread || thread).items.at(-1).body,
        usage = s.one(
          'SELECT count(*) calls, sum(input) input, sum(output) output FROM costs WHERE job=?',
          job,
        );
      if (i === 1) saved = answer.rangeId;
      const check = [
        () => !!answer.text && !answer.steps?.length,
        () => {
          const ref = answer.materials?.find((m) => m.kind === 'report');
          if (!answer.rangeId || !ref || answer.text.length <= 35 || answer.text.trim().endsWith(':'))
            return false;
          const m = readMaterial(s.db, u, ref.id);
          return (
            m.findings.some((f) => /Kaspersky.*100 → 70/.test(f)) &&
            m.sections
              .find((s) => s.title === 'Значения в соседнем периоде')
              ?.rows.some((row) => row[2] === 'Kaspersky' && row[3] === '100') &&
            m.sections
              .find((s) => s.title === 'Свидетельства')
              ?.rows.some((row) => row[0].includes('Synthetic evaluation.xlsx'))
          );
        },
        () => !!saved && answer.rangeId === saved,
        () =>
          answer.actions?.some((a) => a.op === 'draft') &&
          s.one('SELECT count(*) n FROM draft_actions').n === 1 &&
          s.one('SELECT count(*) n FROM local_issues').n === 0,
        () => {
          const report = answer.materials?.find((m) => m.kind === 'report');
          if (!report || !answer.materials.some((m) => m.kind === 'chart')) return false;
          const m = readMaterial(s.db, u, report.id);
          const mobile = m.sections
            .find((s) => s.title === 'Завершение подбора')
            ?.rows.find((row) => row[0] === 'Телефоны');
          return (
            JSON.stringify(m.ranges) === JSON.stringify(selection.ranges) &&
            mobile?.[1].includes('90/150') &&
            mobile?.[2].includes('100/200')
          );
        },
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
        passed: !!check && !answer.warning && answer.outcome === 'done',
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
