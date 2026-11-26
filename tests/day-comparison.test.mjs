import assert from 'node:assert/strict';
import test from 'node:test';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs } from '../server/evidence.mjs';
import { createThread, enqueue, initWorkbench, messages, workJobs } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { explicitDayWindow } from '../server/day-comparison.mjs';
import { materialForResult, readMaterial } from '../server/materials.mjs';

const u = { id: 'qa', name: 'QA', role: 'judge' },
  accounts = { publicUser: () => u };
const api = {
  LLM_BACKEND: 'api',
  LLM_MODEL: 'test',
  LLM_BASE_URL: 'http://localhost',
  LLM_DATA_MODE: 'analysis',
};
const now = Date.parse('2026-11-25T22:20:00Z'); // 26 November in Moscow.
function setup() {
  const s = openStore(':memory:');
  initEvidence(s.db);
  initWorkbench(s.db);
  const thread = createThread(s.db, u, 'Сравнение');
  const data = [
    ...['2026-11-09', '2026-11-16'].map((date, i) => ({
      kind: 'sales',
      loc: 'Sales' + i,
      row: { week_start: date, product_family: 'Kaspersky Endpoint Security', orders_index: 100 - i * 30 },
    })),
    ...[
      ['desktop', 18, 10, false],
      ['desktop', 19, 5, false],
      ['desktop', 20, 0, false],
      ['desktop', 21, 13, false],
      ['desktop', 22, 13, false],
      ['mobile', 21, 3, false],
      ['mobile', 22, 5, false],
      ['mobile', 23, 7, true],
      ['tablet', 22, 1, false],
    ].map(([segment, day, value, partial], i) => ({
      kind: 'metrics',
      loc: 'Visits!A' + i,
      row: {
        metric_id: 'cfg_family_views',
        product: 'Конфигуратор Kaspersky',
        segment,
        date: '2026-11-' + day,
        unit: 'visits',
        value,
        comment: partial ? 'неполный день' : '',
      },
    })),
  ];
  importDocs(s, [{ file: 'Synthetic.xlsx', facts: data }], { notify: false });
  const send = async (question, extra = {}) => {
    const id = enqueue(s, u, { thread, question, ...extra });
    // Freeze the date of enqueue as well as execution so this regression works year-round.
    const job = JSON.parse(s.one('SELECT body FROM jobs WHERE id=?', id).body);
    job.requestedPeriod = explicitDayWindow(question, now);
    s.db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(job), id);
    s.db.prepare('UPDATE chat_items SET created=? WHERE seq=?').run(now, job.questionSeq);
    let calls = 0;
    await workJobs(s, accounts, api, () => {
      calls++;
      throw Error('Unexpected model call');
    });
    assert.equal(calls, 0);
    return messages(s.db, u, thread).items.at(-1).body;
  };
  return { s, thread, send };
}
test('weekly metric retains the two-day constraint on correction and labels stale daily alternatives separately', async () => {
  const { s, thread, send } = setup();
  try {
    const v = workspaceOperation(s, u, 'view', { product: 'Kaspersky Endpoint Security' }).view;
    const m = materialForResult(s.db, u, thread, { calc: v.id, cards: ['trend'], title: 'Индекс заказов' });
    s.db
      .prepare("INSERT INTO chat_items(thread,role,body,created) VALUES(?,'assistant',?,?)")
      .run(
        thread,
        JSON.stringify({
          product: v.product,
          calc: v.id,
          focusMaterialId: m.id,
          materials: [m],
          text: 'До и после релиза',
        }),
        now,
      );
    for (const q of ['Какие изменения за 2 дня по касперскому?', 'Я попросил за 2 дня']) {
      const result = await send(q);
      assert.match(result.text.split('\n')[0], /^Не могу рассчитать.*2 дня.*Индекс заказов.*по неделям/);
      assert.equal(result.outcome, 'unavailable');
      assert.doesNotMatch(result.text, /165[,.]8|32[,.]7/);
      const d = result.dayComparison;
      assert.deepEqual(d.window, { count: 2, mode: 'calendar', from: '2026-11-24', to: '2026-11-25' });
      assert.equal(d.metric, 'orders_index');
      assert.deepEqual([d.from, d.to], ['2026-11-21', '2026-11-22']);
      assert.equal(d.comparisons.find((r) => r.segment === 'mobile').delta, 2);
      assert.match(result.text, /Справочно/);
    }
    const daily = await send('Тогда покажи визиты на телефонах за последние два доступных дня');
    assert.equal(daily.outcome, 'done');
    assert.equal(daily.dayComparison.metric, 'cfg_family_views');
    const vls = daily.dayComparison.comparisons[0];
    assert.deepEqual([vls.from, vls.a, vls.to, vls.b, vls.delta], ['2026-11-21', 3, '2026-11-22', 5, 2]);
    assert.ok(Math.abs(vls.relative - 200 / 3) < 1e-9);
  } finally {
    s.close();
  }
});

test('compares only exact daily endpoints, keeps zeros and missing values distinct, and saves the chart', async () => {
  const { s, send } = setup();
  try {
    const r = await send('Покажи график визитов Kaspersky на компьютерах с 20 ноября по 21 ноября');
    const c = r.dayComparison.comparisons[0];
    assert.deepEqual([c.a, c.b, c.delta, c.relative], [0, 13, 13, null]);
    assert.match(r.text.split('\n')[0], /от нуля/);
    const chart = readMaterial(s.db, u, r.materials.find((m) => m.kind === 'chart').id);
    assert.deepEqual(
      chart.plot.lines[0].points.map((p) => p.value),
      [0, 13],
    );
    const missing = await send('Сравни визиты на телефонах за 22 и 23 ноября по Kaspersky');
    assert.equal(missing.outcome, 'unavailable');
    assert.equal(missing.dayComparison.comparisons[0].b, null);
    assert.match(missing.text.split('\n')[0], /нет пары/);
    assert.equal(missing.dayComparison.comparisons[0].delta, null);
    const invalid = await send('Визиты за 2 дня с 20.11.2026 по 24.11.2026');
    assert.equal(invalid.outcome, 'clarification');
    assert.equal(invalid.materials.length, 0);
  } finally {
    s.close();
  }
});

test('an unresolved tool error is visible during the turn and is the first line even if the model claims success', async () => {
  const { s, thread } = setup();
  try {
    enqueue(s, u, { thread, question: 'Построй график неизвестной метрики' });
    let calls = 0,
      progress;
    const model = async () => {
      if (++calls === 1)
        return Response.json({
          choices: [
            {
              message: {
                tool_calls: [
                  {
                    id: 't',
                    type: 'function',
                    function: { name: 'chart', arguments: '{"metric":"no_such_metric"}' },
                  },
                ],
              },
            },
          ],
        });
      progress = messages(s.db, u, thread).jobs[0].issue;
      return Response.json({ choices: [{ message: { content: 'График построен. Готово!' } }] });
    };
    await workJobs(s, accounts, api, model);
    const reply = messages(s.db, u, thread).items.at(-1).body;
    assert.match(progress, /^Не удалось построить график/);
    assert.match(reply.text.split('\n')[0], /^Не удалось построить график/);
    assert.equal(reply.outcome, 'failed');
    assert.doesNotMatch(reply.text, /График построен/);
  } finally {
    s.close();
  }
});
