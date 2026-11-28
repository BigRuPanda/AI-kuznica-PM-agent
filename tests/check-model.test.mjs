import test from 'node:test';
import assert from 'node:assert/strict';
import { checkModel } from '../scripts/check-model.mjs';

const env = { DATA_PROFILE: 'configured', LLM_BACKEND: 'anymodel', LLM_MODEL: 'qwen/qwen3.8-27b',
  ANYMODEL_API_KEY: 'fixture-anymodel-key' };

function anymodelFixture(toolResult='37') {
  const requests = [];
  const call = { id: 'check-1', type: 'function', function: { name: 'check_value', arguments: '{}' } };
  const send = async (url, init) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    requests.push({ url: String(url), init, body });
    if (!body) return Response.json({ object: 'list', data: [{ id: 'qwen/qwen3.8-27b', object: 'model' }] });
    if (!body.tools) return Response.json({ choices: [{ message: { role: 'assistant', content: '{"value":37}' } }] });
    if (body.tool_choice === 'auto') return Response.json({ choices: [{ message: { role: 'assistant', content: toolResult } }] });
    return Response.json({ choices: [{ message: { role: 'assistant', content: null, tool_calls: [call] } }] });
  };
  return { call, requests, send };
}

test('the AnyModel check verifies the catalog, tool choices, and short JSON output at current limits', async t => {
  const { call, requests, send } = anymodelFixture();
  const timeouts = [];
  const makeTimeout = AbortSignal.timeout;
  t.mock.method(AbortSignal, 'timeout', ms => {
    timeouts.push(ms);
    return makeTimeout(ms);
  });
  await checkModel(env, send);
  assert.deepEqual(timeouts, Array(5).fill(600_000));
  const [catalog, ...completions] = requests;
  assert.equal(catalog.url, 'https://anymodel.org/v1/models');
  assert.equal(catalog.init.method, 'GET');
  assert.equal(catalog.init.headers.Authorization, 'Bearer fixture-anymodel-key');
  assert.equal(catalog.init.redirect, 'error');
  assert.deepEqual(completions.map(({ body }) => body.tool_choice), [
    'required', { type: 'function', function: { name: 'check_value' } }, 'auto', undefined,
  ]);
  assert.deepEqual(completions[2].body.messages.slice(-2), [
    { role: 'assistant', content: null, tool_calls: [call] },
    { role: 'tool', tool_call_id: 'check-1', content: '{"value":37}' },
  ]);
  assert.equal(completions[3].body.max_tokens, 65_536);
  assert.equal(completions[3].body.temperature, 0);
  assert.equal(completions[3].body.tools, undefined);
});

test('the AnyModel check rejects a different number containing the expected digits', async () => {
  const { send } = anymodelFixture('137');
  await assert.rejects(checkModel(env, send), /не подтвердила результат инструмента/);
});

test('the AnyModel check stops before a completion if the selected model is absent', async () => {
  let requests = 0;
  await assert.rejects(checkModel(env, async () => {
    requests++;
    return Response.json({ object: 'list', data: [{ id: 'qwen/another-model', object: 'model' }] });
  }), /qwen\/qwen3\.8-27b/);
  assert.equal(requests, 1);
});

test('the AnyModel check makes zero requests in the local profile', async () => {
  await assert.rejects(checkModel({ ...env, DATA_PROFILE: 'local' }, () => assert.fail('Unexpected model request')), /локальная/);
});
