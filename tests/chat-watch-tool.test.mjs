import assert from 'node:assert/strict';
import test from 'node:test';
import { evaluationCase } from '../scripts/eval-agent.mjs';
import { initEvidence } from '../server/evidence.mjs';
import { openStore } from '../server/store.mjs';
import { createThread, enqueue, initWorkbench, messages, workJobs } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';

const env = { LLM_BACKEND: 'anymodel', ANYMODEL_API_KEY: 'synthetic-only', LLM_MODEL: 'fixture', LLM_DATA_MODE: 'analysis' };
const user = { id: 'watch-owner', name: 'Марина', role: 'judge' };

function fixture(t) {
  const store = openStore(':memory:');
  t.after(() => store.close());
  initEvidence(store.db);
  initWorkbench(store.db, env);
  const { caseId } = evaluationCase(store, user, env);
  const args = { caseId, deployed: '2026-10-05', percent: 90, control: 'Astra' };
  const inspect = () => {
    const row = store.one('SELECT state,body FROM cases WHERE id=?', caseId);
    return { ...row, body: JSON.parse(row.body) };
  };
  const thread = createThread(store.db, user, 'Наблюдение');

  async function ask(question, repeat = false) {
    const id = enqueue(store, user, { thread, caseId, question });
    let called = false;
    const send = async () => {
      if (called) return Response.json({ choices: [{ message: { content: 'План сохранён.' } }] });
      called = true;
      const tool_calls = (repeat ? ['watch-1', 'watch-2'] : ['watch-1']).map(id => ({
        id, type: 'function', function: { name: 'watch', arguments: JSON.stringify(args) },
      }));
      return Response.json({ choices: [{ message: { tool_calls } }] });
    };
    await workJobs(store, { publicUser: () => user }, env, send);
    assert.equal(called, true);
    const reply = messages(store.db, user, thread).items.findLast(item => item.body.jobId === id)?.body;
    assert.ok(reply, 'The chat reply was saved');
    const receipts = store.db.prepare('SELECT body FROM agent_steps WHERE job=?').all(id).map(row => JSON.parse(row.body));
    return { reply, receipts };
  }

  return { store, caseId, args, inspect, ask };
}

function assertWatch({ state, body }) {
  assert.equal(state, 'Наблюдаем эффект');
  assert.deepEqual([body.watch.deployed, body.watch.target, body.watch.control, body.watch.revision],
    ['2026-10-05', 90, 'Astra', 1]);
  assert.deepEqual(body.watchHistory ?? [], []);
}

test('chat schedules one durable watch when the model repeats a tool call', async t => {
  const variants = [
    ['assign', 'Назначь наблюдение с 5 октября 2026 за индексом заказов Kaspersky. Цель — 90% от базы, контроль Astra.'],
    ['track', 'Отслеживай индекс заказов Kaspersky с даты выкладки 2026-10-05. Порог восстановления 90 процентов от базы, контрольный ряд Astra.'],
    ['save', 'Сохрани наблюдение за эффектом с 2026-10-05: индекс Kaspersky должен вернуться к 90% базы, контроль Astra.'],
  ];
  for (const [name, question] of variants) await t.test(name, async t => {
    const { caseId, inspect, ask } = fixture(t);
    const { reply, receipts } = await ask(question, true);
    assert.equal(reply.outcome, 'done', reply.text);
    assert.deepEqual(reply.steps, ['watch']);
    assert.deepEqual(reply.actions.map(action => [action.op, action.caseId]), [['watch', caseId]]);
    assert.deepEqual(receipts.map(receipt => receipt.caseId), [caseId]);
    assertWatch(inspect());
  });
});

test('chat cannot schedule a watch without an affirmative request', async t => {
  const variants = [
    ['advice', 'Как назначить наблюдение за эффектом с 2026-10-05?'],
    ['read only', 'Покажи текущее наблюдение за эффектом.'],
    ['negative', 'Не назначай наблюдение за эффектом. Только прочитай текущий план.'],
  ];
  for (const [name, question] of variants) await t.test(name, async t => {
    const { inspect, ask } = fixture(t);
    const { reply, receipts } = await ask(question);
    assert.equal(reply.outcome, 'failed', reply.text);
    assert.match(reply.text, /нужно явное поручение пользователя/u);
    assert.deepEqual(reply.actions, []);
    assert.deepEqual(receipts, []);
    assert.equal(inspect().body.watch, undefined);
  });
});

test('the direct watch operation persists the same plan outside the chat transaction', t => {
  const { store, caseId, args, inspect } = fixture(t);
  assert.equal(workspaceOperation(store, user, 'watch', args, env).caseId, caseId);
  assertWatch(inspect());
});
