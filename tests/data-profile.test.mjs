import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { smtpConfigured, telegramConfigured } from '../server/connectors.mjs';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { apiConfigured, makeAgent, providerCall } from '../server/agent.mjs';
import { checkSmtp, integrationTransport } from '../server/data-profile.mjs';
import { mail } from '../server/connectors.mjs';
import { importDocs, initEvidence } from '../server/evidence.mjs';
import { geminiCall } from '../server/gemini.mjs';
import { openStore } from '../server/store.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { createThread, enqueue, initWorkbench, messages, workJobs } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { seedReleaseMetrics } from './release-metrics-fixture.mjs';

const gemini = {
  LLM_BACKEND: 'gemini', LLM_MODEL: 'gemini-3.5-flash-lite', LLM_API_KEY: 'fixture', LLM_DATA_MODE: 'analysis',
};
const local = { ...gemini, DATA_PROFILE: 'local' };
const product = 'Вымышленный кабинет';
const metric = 'lk_reco_ctr';
const question = 'Сравни CTR рекомендаций в выбранных периодах и укажи изменение в процентных пунктах.';
const dates = ['2026-03-02', '2026-03-09', '2026-03-16'];

function ctrFixture(store, user) {
  importDocs(store, [{ file: 'Вымышленная Метрика', facts: [6, 1].map((n, index) => ({
    kind: 'metrics', loc: 'A' + (index + 2), row: { date: dates[index], product, metric_id: metric, segment: 'all',
      value: n / 100, unit: 'ratio', sample_size: 100, detail_json: JSON.stringify({ click_visits: n, viewed_visits: 100 }) },
  })) }], { notify: false });
  const chart = workspaceOperation(store, user, 'chart', { metric, product, segment: 'all' });
  return workspaceOperation(store, user, 'range_compare', { selection: {
    source: 'metric', calcId: chart.id, version: chart.id, metric, series: ['all'], ranges: [0, 1].map(index => ({
      from: Date.parse(dates[index]), to: Date.parse(dates[index + 1]),
    })),
  } });
}

test('the local profile blocks model payloads before transport or ADC even with configured credentials', async () => {
  let calls = 0;
  const countCall = () => { calls++; };
  const env = { ...local, LOCAL_HTTP_ORIGINS: 'https://generativelanguage.googleapis.com' };
  assert.equal(apiConfigured(gemini), true);
  assert.equal(apiConfigured(env), false);
  await assert.rejects(providerCall(env, [], [], 'auto', countCall), /локальная/);
  await assert.rejects(providerCall({ ...env, LLM_BACKEND: 'api', LLM_BASE_URL: 'https://example.invalid' },
    [], [], 'auto', countCall), /локальная/);
  await assert.rejects(geminiCall({ ...env, LLM_BACKEND: 'vertex', GOOGLE_CLOUD_PROJECT: 'fixture' }, [], [], 'auto',
    countCall, { getRequestHeaders: countCall }), /локальная/);
  const store = openStore(':memory:');
  try {
    seedReleaseMetrics(store);
    const agent = makeAgent(store, { env: { ...env, LLM_BACKEND: 'codex' }, send: countCall, alternate: countCall });
    const context = { releaseId: 'R-001', day: 14, metric: 0, author: 'Анна' };
    await agent.initial(context);
    const answer = await agent.ask({ ...context, question: 'Сравни конверсию' });
    assert.equal(answer.refs[0].op, 'compare_metric');
    assert.equal(calls, 0);
  } finally {
    store.close();
  }
});

test('local integrations use the configured HTTP origin and restrict cleartext SMTP to its passwordless loopback target', async () => {
  const requests = [];
  const send = integrationTransport({ ...local, LOCAL_HTTP_ORIGINS: ' https://localhost:1443, http://127.0.0.1:8081 ' },
    (url, opts) => requests.push({ url, opts }));
  send('https://localhost:1443/endpoint', { redirect: 'follow' });
  assert.deepEqual(requests, [{ url: 'https://localhost:1443/endpoint', opts: { redirect: 'error' } }]);
  for (const target of ['http://localhost:1443', 'https://localhost:1444', 'https://localhost.example.invalid:1443'])
    assert.throws(() => send(target), /не разрешён локальным профилем/);
  assert.equal(requests.length, 1);

  const smtp = { ...local, SMTP_HOST: '127.0.0.1', SMTP_PORT: '11025', SMTP_TLS: 'plain', LOCAL_SMTP_TARGET: '127.0.0.1:11025' };
  assert.doesNotThrow(() => checkSmtp(smtp));
  assert.doesNotThrow(() => checkSmtp({ ...smtp, SMTP_HOST: '::1', LOCAL_SMTP_TARGET: '::1:11025' }));
  for (const overrides of [
    { SMTP_PASSWORD: 'fixture' }, { SMTP_USER: 'fixture' }, { DATA_PROFILE: 'configured' },
    { SMTP_HOST: 'mail.example.invalid', LOCAL_SMTP_TARGET: 'mail.example.invalid:11025' },
    { SMTP_HOST: 'localhost', LOCAL_SMTP_TARGET: 'localhost:11025' }, { LOCAL_SMTP_TARGET: '127.0.0.1:11026' },
  ]) await assert.rejects(mail('Вымышленное письмо', { ...smtp, ...overrides }), /SMTP.*(?:локальн|loopback)/);
});

test('contact readiness requires approved transports under the local data profile', () => {
  const env = { DATA_PROFILE: 'local', TELEGRAM_BOT_TOKEN: 'fixture',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: '11025', SMTP_TLS: 'plain', SMTP_FROM: 'sender@example.invalid' };
  assert.equal(telegramConfigured(env), false);
  assert.equal(smtpConfigured(env), false);
  assert.equal(telegramConfigured({ ...env, LOCAL_HTTP_ORIGINS: 'https://api.telegram.org' }), true);
  const allowed = { ...env, LOCAL_SMTP_TARGET: '127.0.0.1:11025' };
  assert.equal(smtpConfigured(allowed), true);
  assert.equal(smtpConfigured({ ...allowed, SMTP_USER: 'fixture' }), false);
  assert.equal(smtpConfigured({ ...allowed, SMTP_FROM: '' }), false);
});

test('HTTP chat, HTTP MCP and the release journal use saved calculations with zero model requests in local mode', async () => {
  const base = join(await mkdtemp(join(tmpdir(), 'softline-profile-')), 'releases.sqlite');
  const env = { ...local, ADMIN_INVITE_KEY: 'fixture-invite' };
  const outgoing = [];
  const send = async url => { outgoing.push(String(url)); throw Error('Внешний транспорт недоступен'); };
  const app = createTeamApp({ base, env, send, background: false });
  const client = new Client({ name: 'local-profile-test', version: '1' });
  let cookie;
  try {
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    const url = 'http://127.0.0.1:' + app.server.address().port;
    async function request(path, body) {
      const res = await fetch(url + '/api/' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', ...(cookie && { Cookie: cookie }) },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const json = await res.json();
      assert.equal(res.status, 200, JSON.stringify(json));
      return { json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
    }
    const call = async (path, body) => (await request(path, body)).json;
    const registration = await request('team/register', { code: env.ADMIN_INVITE_KEY, login: 'fixture-analyst',
      name: 'Испытатель', password: 'inert-password' });
    cookie = registration.cookie;
    const user = registration.json;
    const store = app.space('team');
    seedReleaseMetrics(store);
    const range = ctrFixture(store, user);
    const { id: thread } = await call('team/thread', { title: 'Пример CTR' });
    const input = { thread, question, rangeId: range.id };
    await call('team/ask', input);
    await workJobs(store, app.accounts, env, send);
    const http = (await call('team/messages', { thread })).items.at(-1).body;
    assert.equal(http.outcome, 'done');
    assert.equal(http.rangeId, range.id);
    assert.match(http.text, /6\s*%[\s\S]*1\s*%[\s\S]*-5\s*п\.п\./u);

    const { key } = await call('team/mcp-key', {});
    await client.connect(new StreamableHTTPClientTransport(new URL(url + '/mcp'), {
      requestInit: { headers: { Authorization: 'Bearer ' + key } },
    }));
    const tool = async (name, args) => {
      const result = await client.callTool({ name, arguments: args });
      assert.ok(!result.isError, result.content[0].text);
      return JSON.parse(result.content[0].text);
    };
    const { id: job } = await tool('ask_workspace', input);
    await workJobs(store, app.accounts, env, send);
    const status = await tool('job_status', { id: job });
    assert.equal(status.status, 'done');
    assert.equal(JSON.parse(status.result).text, http.text);

    assert.equal((await call('journal')).mode, 'local');
    const context = { releaseId: 'R-001', day: 14, metric: 0 };
    await call('initial', context);
    const legacy = await call('chat', { ...context, question: 'Сравни конверсию', requestId: 'legacy-test' });
    const calc = await call('calculations/' + legacy.refs[0].id);
    assert.equal(calc.op, 'compare_metric');
    assert.deepEqual([calc.result.series.all.before.n, calc.result.series.all.after.n], [5, 4]);
    assert.deepEqual(outgoing, []);
    assert.equal(store.one('SELECT count(*) n FROM costs').n, 0);
  } finally {
    await client.close();
    await app.close();
  }
});

test('an unavailable configured Gemini returns the saved CTR range with the delta and a resumable status', async () => {
  const store = openStore(':memory:');
  const user = { id: 'fixture', name: 'Испытатель' };
  const env = { ...gemini, DATA_PROFILE: 'configured' };
  try {
    initEvidence(store.db);
    initWorkbench(store.db);
    const thread = createThread(store.db, user, 'Вымышленный CTR');
    const range = ctrFixture(store, user);
    enqueue(store, user, { thread, question, rangeId: range.id });
    let calls = 0;
    await workJobs(store, { publicUser: () => user }, env, async () => new Response(null, { status: ++calls === 1 ? 503 : 401 }));
    const reply = messages(store.db, user, thread).items.at(-1).body;
    assert.equal(calls, 2);
    assert.equal(reply.outcome, 'partial');
    assert.equal(reply.rangeId, range.id);
    assert.match(reply.warning, /HTTP 401/u);
    assert.match(reply.text, /Локальный расчёт[\s\S]*6\s*%[\s\S]*1\s*%[\s\S]*-5\s*п\.п\./u);
  } finally {
    store.close();
  }
});

test('the model receives the original comparison question again when the evidence check is missing', async () => {
  const store = openStore(':memory:');
  const user = { id: 'fixture', name: 'Испытатель' };
  const prompt = question + ' Можно ли установить причину?';
  try {
    initEvidence(store.db);
    initWorkbench(store.db);
    const thread = createThread(store.db, user, 'Вымышленный CTR');
    const range = ctrFixture(store, user);
    enqueue(store, user, { thread, question: prompt, rangeId: range.id });
    const requests = [];
    const parts = [
      { text: 'CTR изменился с 6% до 1%. Это снижение на 5 п.п.' },
      { functionCall: { name: 'selection_context', args: { id: range.id } } },
      { text: 'CTR изменился с 6% до 1%. Это снижение на 5 п.п.\n\nПо двум периодам причину установить нельзя.' },
    ];
    await workJobs(store, { publicUser: () => user }, gemini, async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return Response.json({ candidates: [{ content: { parts: [parts[requests.length - 1]] } }] });
    });
    assert.equal(requests.length, 3);
    assert.equal(JSON.parse(requests[1].contents.at(-1).parts[0].text).question, prompt);
    const reply = messages(store.db, user, thread).items.at(-1).body;
    assert.equal(reply.outcome, 'done');
    assert.equal(reply.text, parts.at(-1).text);
    assert.ok(reply.materials.some(m => m.kind === 'report'));
  } finally {
    store.close();
  }
});
