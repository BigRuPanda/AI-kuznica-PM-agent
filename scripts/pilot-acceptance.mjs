import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { backup } from 'node:sqlite';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { cases, facts, importDocs } from '../server/evidence.mjs';
import { mail, python } from '../server/connectors.mjs';
import { normalizeObservation } from '../server/metric-observations.mjs';
import { metrikaStatus, syncMetrika } from '../server/metrika-sync.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { teamTools } from '../server/team-mcp.mjs';
import { deliver } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { pilotMetrikaEnv, pilotMetrikaTransport } from '../pilot/metrika-replay.mjs';

const pilotProduct = 'Пилотный ЛК';
const metric = 'lk_reco_ctr';
const sourceId = 'metrika:78101:lk_reco_ctr';
const releaseId = 'R-PILOT-CTR';
const registerEnv = { ADMIN_INVITE_KEY: randomBytes(24).toString('base64url') };
const redmineOrigin = 'https://localhost:18443';
const mailpitApi = 'http://127.0.0.1:18025/api/v1';
const noNetwork = async () => { throw Error('Приёмочный сценарий попытался обратиться во внешнюю сеть'); };
const percent = n => Number(n.toFixed(2));
const pythonBin = () => process.env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3');

// Only these volunteered, de-identified excerpts are written to the synthetic workbook.
const interviewFixture = [
  ['Вопрос', 'Обезличенная выдержка', 'Продукт', 'Дата'],
  ['Как вы выбирали рекомендацию?', 'Мне удобно выбирать рекомендации в кабинете.', '2026-07-08'],
  ['Как вы выбирали рекомендацию?', 'Мне неудобно выбирать рекомендации в кабинете.', '2026-07-09'],
  ['Что случилось при оформлении?', 'При смене плательщика сбрасывается корзина.', '2026-07-10'],
];

async function interviewDocs(bin, product) {
  const makeWorkbook = [
    'import io, json, sys, zipfile',
    'from xml.sax.saxutils import escape',
    'rows = json.loads(sys.stdin.buffer.read())',
    'sheet = []',
    'for n, row in enumerate(rows, 1):',
    '    cells = [f\'<c r="{chr(65+k)}{n}" t="inlineStr"><is><t>{escape(v)}</t></is></c>\' for k,v in enumerate(row)]',
    '    sheet.append(f\'<row r="{n}">\' + "".join(cells) + "</row>")',
    'buf = io.BytesIO()',
    'with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as z:',
    '    z.writestr("xl/workbook.xml", \'<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Интервью" sheetId="1" r:id="rId1"/></sheets></workbook>\')',
    '    z.writestr("xl/_rels/workbook.xml.rels", \'<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>\')',
    '    z.writestr("xl/worksheets/sheet1.xml", "<worksheet><sheetData>" + "".join(sheet) + "</sheetData></worksheet>")',
    'sys.stdout.buffer.write(buf.getvalue())',
  ].join('\n');
  const [header, ...excerpts] = interviewFixture;
  const rows = [header, ...excerpts.map(([question, excerpt, date]) => [question, excerpt, product, date])];
  const built = spawnSync(bin, ['-X', 'utf8', '-c', makeWorkbook], {
    input: JSON.stringify(rows), windowsHide: true,
  });
  if (built.error) throw built.error;
  assert.equal(built.status, 0, built.stderr?.toString());
  return JSON.parse(await python('office_import.py', ['Интервью пилот.xlsx'], built.stdout, { PYTHON_BIN: bin }));
}

function syncPilotWindow(store, product, from, through) {
  return syncMetrika(store, pilotMetrikaEnv({}, { product, from, through }), pilotMetrikaTransport(noNetwork));
}

export async function seedPilotSignal(store, { pythonBin: bin = pythonBin(), product = pilotProduct } = {}) {
  const pilotCase = () => cases(store.db).find(c => c.product === product && c.body.signal?.metric === metric);
  const alreadyConfirmed = pilotCase()?.body.signal.status === 'confirmed';
  const rule = {
    metric, product, segment: 'desktop', sourceId, releaseId, enabled: true,
    threshold: 30, minDenominator: 100, minBaselineNumerator: 10, confirmations: 2,
  };
  importDocs(store, [{
    file: 'Календарь пилота.xlsx', facts: [{
      kind: 'releases', loc: 'Релизы!A2',
      row: { release_id: releaseId, release_date: '2026-08-03', release_type: 'major', description: product + ' · рекомендации' },
    }],
  }, ...await interviewDocs(bin, product)]);
  await syncPilotWindow(store, product, '2026-07-06', '2026-08-02');
  const { saveMetricRule } = await import('../server/metric-rules.mjs');
  saveMetricRule(store.db, rule);
  await syncPilotWindow(store, product, '2026-08-03', '2026-08-09');
  if (!alreadyConfirmed)
    assert.equal(pilotCase()?.body.signal.status, 'provisional', 'Одна неделя даёт предварительное отклонение');
  await syncPilotWindow(store, product, '2026-08-10', '2026-08-16');
  const confirmed = pilotCase();
  const signal = confirmed?.body.signal;
  assert.equal(signal?.status, 'confirmed', 'Две полные недели устойчивого падения CTR должны подтвердить сигнал');
  assert.equal(signal.sourceId, sourceId);
  assert.deepEqual([signal.baseN, signal.baseD, signal.baseValue], [224, 2800, 8]);
  assert.deepEqual(signal.history.map(s => [s.week, s.n, s.d, s.value]), [
    ['2026-08-03', 28, 700, 4], ['2026-08-10', 21, 700, 3],
  ]);
  return {
    caseId: confirmed.id, sourceId, rule,
    report: { baselinePercent: signal.baseValue, observedPercent: signal.history.map(s => s.value) },
  };
}

export async function loadPilotRecovery(store, { product = pilotProduct } = {}) {
  return syncPilotWindow(store, product, '2026-08-17', '2026-09-13');
}

async function withWorkspace(env, action, { send = noNetwork, http = false, source = null } = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'softline-pilot-'));
  const base = join(directory, 'team.sqlite');
  const open = () => createTeamApp({ base, env, send, background: false });
  let app;
  const sessions = new Map();
  async function listen() {
    if (!http) return;
    app.server.listen(0, '127.0.0.1');
    await once(app.server, 'listening');
    env.APP_BASE_URL = 'http://127.0.0.1:' + app.server.address().port;
  }
  async function request(op, body, user, status) {
    const headers = { 'Content-Type': 'application/json', Origin: env.APP_BASE_URL };
    if (user) headers.Cookie = sessions.get(user.id);
    const res = await fetch(env.APP_BASE_URL + '/api/team/' + op, {
      method: 'POST', headers, body: JSON.stringify(body), redirect: 'error',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.status !== status) {
      await res.body?.cancel();
      throw Error('POST /api/team/' + op + ' · HTTP ' + res.status + ', ожидался ' + status);
    }
    return res;
  }
  const post = async (op, body, user, status = 200) => (await request(op, body, user, status)).json();
  try {
    if (source) await backup(source, base);
    app = open();
    await listen();
    async function register(login, code) {
      const input = { login, name: login, code, password: randomBytes(24).toString('base64url') };
      if (!http) return (await app.accounts.register(input, env, id => app.space(id))).user;
      const res = await request('register', input, null, 200);
      const user = await res.json();
      const cookie = res.headers.get('set-cookie')?.split(';', 1)[0];
      assert.ok(cookie?.startsWith('pm_session='), 'HTTP-сессия пилота');
      sessions.set(user.id, cookie);
      return user;
    }
    const pm = await register('pilot-pm', registerEnv.ADMIN_INVITE_KEY);
    const invite = http ? (await post('invite', {}, pm)).code : app.accounts.invite('team');
    const reader = await register('pilot-reader', invite);
    assert.equal(pm.role, 'admin');
    assert.equal(reader.role, 'member');
    await action({
      pm, reader, post, get store() { return app.space('team'); },
      restart: async () => { await app.close(); app = open(); await listen(); },
    });
  } finally {
    await app?.close();
    assert.equal(dirname(resolve(directory)), resolve(tmpdir()));
    await rm(directory, { recursive: true, force: true, maxRetries: 3 });
  }
}

async function mcpCall(store, user, name, args, env, send = noNetwork) {
  const client = new Client({ name: 'pilot-acceptance', version: '1' });
  const server = new McpServer({ name: 'pilot-team', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  teamTools(server, store, user, env, send);
  await server.connect(b);
  try {
    await client.connect(a);
    const res = await client.callTool({ name, arguments: args });
    assert.ok(!res.isError, name + ': ' + res.content[0].text);
    return JSON.parse(res.content[0].text);
  } finally {
    await client.close();
    await server.close();
  }
}

function v17Batches(docs, cutoffs) {
  const dateFields = { sales: 'week_start', metrics: 'date', releases: 'release_date', backlog: 'created_date' };
  const definitions = [];
  const weeks = new Set();
  const batches = new Map(cutoffs.map(cut => [cut, []]));
  for (const doc of docs) {
    const byCutoff = new Map();
    const dictionary = doc.facts.filter(f => f.kind === 'dictionary');
    if (dictionary.length) definitions.push({ ...doc, facts: dictionary });
    for (const fact of doc.facts) {
      const date = fact.row?.[dateFields[fact.kind]];
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date ?? '')) continue;
      const end = new Date(date + 'T00:00:00Z');
      end.setUTCDate(end.getUTCDate() + (7 - end.getUTCDay()) % 7);
      const week = end.toISOString().slice(0, 10);
      weeks.add(week);
      const cut = cutoffs.find(c => date <= c && c < week) || week;
      if (!byCutoff.has(cut)) byCutoff.set(cut, []);
      byCutoff.get(cut).push(fact);
    }
    for (const [cut, facts] of byCutoff) {
      if (!batches.has(cut)) batches.set(cut, []);
      batches.get(cut).push({ ...doc, facts });
    }
  }
  return { definitions, weeks: weeks.size, batches: [...batches].sort(([a], [b]) => a.localeCompare(b)) };
}

function v17CtrCorrection(docs, from) {
  for (const doc of docs) {
    const observation = doc.facts.find(f => f.kind === 'metrics' && f.row.metric_id === metric &&
      f.row.date === from && f.row.segment === 'all');
    if (!observation) continue;
    const row = normalizeObservation(observation.row, doc.file);
    assert.deepEqual([row.numerator, row.denominator], [0, 117]);
    const correction = 9;
    const detail = JSON.parse(row.detail_json);
    return {
      file: 'Синтетическая поправка CTR для приёмки v17',
      facts: [{ kind: 'metrics', loc: 'Поправка!A2', row: {
        ...row, numerator: correction, value: correction / row.denominator,
        detail_json: JSON.stringify({ ...detail, click_visits: correction }),
        comment: 'Синтетическая поправка показаний за 2–8 ноября',
      } }],
    };
  }
  throw Error('Для синтетической поправки не найден общий CTR за 2–8 ноября');
}

async function official(archive) {
  const env = { ...registerEnv };
  let docs;
  try {
    docs = JSON.parse(await python('office_import.py', [basename(archive)], await readFile(archive),
      { PYTHON_BIN: pythonBin() }));
  } catch {
    throw Error('Не удалось импортировать архив v17');
  }
  const family = 'Kaspersky Endpoint Security';
  const control = 'Astra Linux Special Edition';
  const deliveryJournal = store => store.db.prepare('SELECT id,channel,state,attempts FROM deliveries ORDER BY id').all();
  await withWorkspace(env, async ctx => {
    const op = (name, args) => workspaceOperation(ctx.store, ctx.pm, name, args, env, noNetwork);
    const cutoffs = ['2026-09-30', '2026-10-26', '2026-11-08'];
    const { definitions, weeks, batches } = v17Batches(docs, cutoffs);
    assert.ok(weeks > cutoffs.length, 'В архиве есть недельные порции наблюдений');
    importDocs(ctx.store, definitions);
    for (const [cut, batch] of batches) {
      importDocs(ctx.store, batch);
      if (!cutoffs.includes(cut)) continue;
      assert.ok(facts(ctx.store.db, 'releases').every(f => f.data.release_date <= cut), 'В загрузку попал будущий релиз');
      const v = (await op('view', { product: family, control, from: '2026-06-29', releaseWeek: '2026-09-28', through: cut })).view;
      assert.ok(v.timeline.every(e => e.data.release_date <= cut), 'Будущий релиз при загрузке по ' + cut);
    }
    // Retain the full document versions for the original upload and include the undated research.
    importDocs(ctx.store, docs);
    const signal = cases(ctx.store.db).find(c => c.product === family && c.body.signal?.rule === 'relative');
    assert.ok(signal, 'Эталонный сигнал Kaspersky');
    const old = (await op('view', { caseId: signal.id, control, from: '2026-06-29', releaseWeek: '2026-09-28', through: cutoffs[0] })).view;
    assert.ok(old.timeline.every(e => e.data.release_date <= old.cut), 'Исторический отчёт увидел октябрьский релиз');
    const ctrQuery = { caseId: signal.id, control, from: '2026-11-02', releaseWeek: '2026-11-02', through: '2026-11-08' };
    const ctr = (await op('view', ctrQuery)).view;
    assert.deepEqual([ctr.ctr.n, ctr.ctr.d], [0, 117], 'CTR 2–8 ноября');
    const mcpCtr = (await mcpCall(ctx.store, ctx.reader, 'view', ctrQuery, env)).view;
    assert.deepEqual([mcpCtr.ctr.n, mcpCtr.ctr.d], [0, 117]);
    const expected = [[false, -32.73, -2.58], [true, -33.87, 3.01]];
    for (const [full, kes, astra] of expected) {
      const { view, backlog } = await op('view', { caseId: signal.id, control, full });
      assert.deepEqual(view.summary.map(r => percent(r.change)), [kes, astra], 'Полные недели: ' + full);
      assert.ok(backlog.some(t => t.key === 'T-08' && t.category === 'Проверить сейчас'), 'T-08 как диагностика');
    }
    const originalDeliveries = deliveryJournal(ctx.store);
    assert.ok(originalDeliveries.length > 0, 'Сигналы создали записи доставки в очереди');
    await ctx.restart();
    assert.equal(importDocs(ctx.store, docs).inserted, 0, 'Повтор v17 после перезапуска');
    assert.deepEqual(deliveryJournal(ctx.store), originalDeliveries, 'Повтор v17 не создал новых доставок');
    const reopened = await op('calc', { id: ctr.id });
    assert.deepEqual([reopened.ctr.n, reopened.ctr.d], [0, 117]);

    const syntheticCorrection = v17CtrCorrection(docs, ctrQuery.from);
    await withWorkspace(env, async clone => {
      const run = (name, args) => workspaceOperation(clone.store, clone.pm, name, args, env, noNetwork);
      const before = (await run('view', ctrQuery)).view;
      assert.deepEqual([before.ctr.n, before.ctr.d], [0, 117]);
      assert.equal(importDocs(clone.store, [syntheticCorrection]).inserted, 1);
      const after = (await run('view', ctrQuery)).view;
      assert.deepEqual([after.ctr.n, after.ctr.d], [9, 117]);
      assert.equal(percent(100 * after.ctr.n / after.ctr.d), 7.69);
      assert.ok(after.ctr.sources.some(s => s.startsWith(syntheticCorrection.file)));
      assert.notEqual(after.id, before.id, 'Поправка создаёт новый снимок');
      const beforeRepeat = deliveryJournal(clone.store);
      await clone.restart();
      assert.equal(importDocs(clone.store, [syntheticCorrection]).inserted, 0, 'Повтор поправки после перезапуска');
      assert.equal(importDocs(clone.store, docs).inserted, 0, 'Повтор архива после поправки');
      assert.deepEqual(deliveryJournal(clone.store), beforeRepeat, 'Повтор поправки и архива не создаёт доставок');
      const saved = await run('calc', { id: before.id });
      assert.deepEqual([saved.ctr.n, saved.ctr.d], [0, 117], 'Старый снимок после поправки');
      const revised = await run('calc', { id: after.id });
      assert.deepEqual([revised.ctr.n, revised.ctr.d], [9, 117], 'Исправленный снимок после перезапуска');
      const current = (await run('view', ctrQuery)).view;
      assert.deepEqual([current.ctr.n, current.ctr.d], [9, 117], 'Дубликат архива не отменяет поправку');
    }, { source: ctx.store.db });
    const original = (await op('view', ctrQuery)).view;
    assert.deepEqual([original.ctr.n, original.ctr.d], [0, 117], 'Поправка осталась в клоне');
    console.log('PASS v17', JSON.stringify({
      weeks, cutoffs, ctr: [0, 117], syntheticCorrection: [9, 117], correctedPercent: 7.69,
      changes: expected, roles: 2, reopened: true, newDeliveriesOnRepeat: 0,
    }));
  });
}

async function readStand(filename) {
  if (!filename) return null;
  let stand;
  try {
    stand = JSON.parse(await readFile(filename, 'utf8'));
  } catch {
    throw Error('Файл доступов локального стенда недоступен или содержит некорректный JSON');
  }
  assert.ok(stand?.url === redmineOrigin && stand.scope === 'softline-pilot', 'Запись разрешена только в выделенный Redmine пилота');
  assert.ok(/^\d+$/.test(stand.originFieldId ?? ''), 'Нужно числовое поле происхождения задачи');
  assert.ok(typeof stand.writerKey === 'string' && typeof stand.readerKey === 'string' &&
    stand.writerKey && stand.readerKey && stand.writerKey !== stand.readerKey, 'Нужны два личных доступа к Redmine');
  const ca = await readFile(join(dirname(filename), 'redmine-ca.pem'), 'utf8');
  setDefaultCACertificates([...getCACertificates('default'), ca]);
  return stand;
}

async function verifyMailpit(to, caseUrl) {
  const request = path => fetch(mailpitApi + path, { redirect: 'error', signal: AbortSignal.timeout(5000) });
  let matches = [];
  for (let i = 0; i < 12; i++) {
    const res = await request('/search?' + new URLSearchParams({ query: 'to:' + to }));
    assert.equal(res.status, 200, 'Mailpit search');
    matches = ((await res.json()).messages ?? []).filter(m => m.To.some(a => a.Address === to));
    if (matches.length) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(matches.length, 1, 'Количество писем в Mailpit этому PM после повторной синхронизации');
  const res = await request('/message/' + encodeURIComponent(matches[0].ID));
  assert.equal(res.status, 200, 'Mailpit message');
  assert.ok((await res.json()).Text.includes(caseUrl), 'Ссылка из доставленного письма');
}

async function synthetic(stand) {
  const runId = randomUUID();
  const product = stand ? pilotProduct + ' ' + runId.slice(0, 8) : pilotProduct;
  const env = pilotMetrikaEnv({
    ...registerEnv, PYTHON_BIN: pythonBin(), INTEGRATION_KEY: randomBytes(32).toString('base64url'),
    NOTIFICATIONS_ENABLED: 'true', APP_BASE_URL: 'http://127.0.0.1:8090',
    SMTP_HOST: '127.0.0.1', SMTP_PORT: '11025', SMTP_TLS: 'plain',
    SMTP_FROM: 'pilot@example.invalid', SMTP_TO: 'pm-' + runId + '@example.invalid',
    DATA_PROFILE: 'local', LOCAL_SMTP_TARGET: '127.0.0.1:11025',
    LOCAL_HTTP_ORIGINS: stand ? redmineOrigin : '',
  }, { product });
  let redmineCreates = 0;
  let redmineFailure = '';
  const integrationSend = stand ? async (url, opts) => {
    const destination = new URL(url);
    assert.ok(destination.origin === redmineOrigin, 'Локальный Redmine');
    if (opts.method === 'POST' && destination.pathname === '/issues.json') redmineCreates++;
    try {
      const res = await fetch(url, { ...opts, redirect: 'error', signal: AbortSignal.timeout(10_000) });
      if (!res.ok) redmineFailure = 'Redmine ' + opts.method + ' HTTP ' + res.status;
      return res;
    } catch (error) {
      const code = error.cause?.code;
      redmineFailure = 'Redmine ' + (/^[A-Z0-9_]+$/.test(code ?? '') ? code : error.name);
      throw error;
    }
  } : noNetwork;
  const send = pilotMetrikaTransport(integrationSend);
  await withWorkspace(env, async ctx => {
    const { caseId, report } = await seedPilotSignal(ctx.store, { pythonBin: env.PYTHON_BIN, product });
    async function run(op, body = {}, user = ctx.pm) {
      if (!stand) return workspaceOperation(ctx.store, user, op, body, env, send);
      redmineFailure = '';
      try {
        return await ctx.post(op, body, user);
      } catch (error) {
        if (!redmineFailure) throw error;
        throw Error(error.message + ' · ' + redmineFailure);
      }
    }
    const journal = async () => {
      const status = stand ? (await run('status')).metrikaSync : metrikaStatus(ctx.store.db, env);
      const entry = status.reports.find(r => r.report === metric && r.counter === '78101');
      assert.ok(entry?.lastSuccess && !entry.stale, 'Загрузка Метрики видна в статусе источника');
      return entry;
    };
    const initialJournal = await journal();
    assert.equal(initialJournal.lastObservation, '2026-08-16');
    assert.deepEqual([initialJournal.coveredFrom, initialJournal.coveredThrough], ['2026-07-06', '2026-08-16']);
    assert.ok(initialJournal.attempts.some(attempt => attempt.state === 'ready' && attempt.rows > 0));
    const syncAgain = () => stand ? run('metrika') : syncMetrika(ctx.store, env, send);
    assert.ok((await syncAgain()).samples.length, 'Ручная синхронизация получает страницы Метрики');
    assert.equal((await syncAgain()).inserted, 0, 'Повтор страницы Метрики');
    const found = await run('search', { query: 'выбирать рекомендации в кабинете', kinds: ['interview'] });
    const text = item => typeof item.data === 'string' ? item.data : item.data?.text;
    for (const wanted of interviewFixture.slice(1, 3)) {
      const hit = found.find(f => text(f)?.includes(wanted[1]));
      assert.ok(hit?.source && hit.version, 'Цитата с источником: ' + wanted[1]);
    }
    const novel = await run('search', { query: 'смене плательщика сбрасывается корзина', kinds: ['interview'] });
    assert.ok(novel.some(x => text(x)?.includes(interviewFixture[3][1]) && x.source && x.version),
      'Новая тема из интервью найдена с источником');

    let draft;
    if (stand) {
      await run('integration-config', { service: 'redmine', url: stand.url, scope: stand.scope, originFieldId: stand.originFieldId });
      for (const [user, token] of [[ctx.pm, stand.writerKey], [ctx.reader, stand.readerKey]])
        await run('integration-access', { service: 'redmine', action: 'connect', token }, user);
      const signalRevision = (await run('view', { caseId })).case.body.signal.revision;
      const input = { caseId, revision: signalRevision };
      await ctx.post('signal-issue-draft', { ...input, revision: signalRevision + 1 }, ctx.pm, 400);
      draft = await run('signal-issue-draft', input);
      assert.equal(draft.state, 'draft', 'Сигнал создаёт черновик');
      assert.ok(draft.id && draft.title && draft.caseId === caseId, 'Черновик связан с сигналом');
      assert.match(draft.description, /Сгенерирована ИИ-помощником\./);
      assert.ok(draft.diff.some(field => field.after === 'ai-generated'), 'Метка есть в предпросмотре');
      assert.equal((await run('signal-issue-draft', input)).id, draft.id, 'Повторное создание черновика');
      assert.equal(redmineCreates, 0, 'Redmine не получил запись до подтверждения');
    } else {
      draft = await mcpCall(ctx.store, ctx.pm, 'draft_issue', {
        caseId, title: 'Проверить рекомендации · пилот ' + runId,
        description: 'CTR 8% → 4% → 3%. Мнения участников расходятся. Проверить путь рекомендации.',
      }, env, send);
    }
    const confirmation = { id: draft.id, revision: draft.revision };
    if (stand) await ctx.post('confirm', confirmation, ctx.reader, 400);
    const saved = await run('confirm', confirmation);
    assert.ok(saved.key, 'Задача записана после подтверждения');
    assert.equal(saved.local, !stand);
    assert.equal((await run('confirm', confirmation)).key, saved.key);
    if (stand) assert.equal(redmineCreates, 1, 'Redmine получил одну запись после повтора подтверждения');
    const matches = (await run('issue_search', { query: draft.title, origin: 'ai-generated' }, ctx.reader)).items;
    assert.deepEqual(matches.filter(i => i.title === draft.title).map(i => String(i.key)), [String(saved.key)],
      'Второй пользователь находит единственную задачу по метке');
    const issue = await run('issue_read', { key: String(saved.key) }, ctx.reader);
    assert.equal(issue.origin, 'ai-generated');
    assert.match(issue.description, /Сгенерирована ИИ-помощником\./);

    const caseUrl = env.APP_BASE_URL + '/#case/' + caseId;
    const out = [];
    for (let i = 0; i < 5; i++)
      await deliver(ctx.store, env, noNetwork, stand ? mail : async (message, config) => {
        assert.ok(config.SMTP_TO === env.SMTP_TO, 'Письмо назначено PM');
        out.push(message);
      });
    if (stand) await verifyMailpit(env.SMTP_TO, caseUrl);
    else {
      assert.equal(out.length, 1, 'Одно письмо PM');
      assert.ok(out[0].includes(caseUrl), 'Письмо открывает найденный разбор');
    }

    const measurement = {
      metric, product, sourceId, segment: 'desktop', control: product, controlSegment: 'mobile',
      baselineFrom: '2026-07-06', baselineThrough: '2026-08-02',
      comparison: 'gte', targetMode: 'absolute', targetValue: 5,
    };
    const pending = await run('watch', { caseId, deployed: '2026-08-17', measurement });
    assert.equal(pending.actual, null, 'Без наблюдений выбранного CTR успех невозможен');
    await loadPilotRecovery(ctx.store, { product });
    assert.equal((await journal()).lastObservation, '2026-09-13', 'Данные эффекта видны в том же журнале');
    const after = (await run('view', { caseId })).effect;
    assert.equal(after.state, 'Цель достигнута');
    assert.equal(after.actual, 6, '168 кликов на 2800 визитов');
    assert.deepEqual([after.sample.n, after.sample.d, after.peer.value, after.ctrl, after.target], [168, 2800, 8, 0, 5]);
    await ctx.restart();
    const finalJournal = await journal();
    assert.equal(finalJournal.lastObservation, '2026-09-13', 'Журнал источника сохраняется после перезапуска');
    const last = (await run('view', { caseId }, ctx.reader)).effect;
    assert.equal(last.actual, 6);
    assert.equal((await run('issue_read', { key: String(saved.key) }, ctx.reader)).origin, 'ai-generated');
    const links = (await run('case_links', { caseId }, ctx.reader)).items;
    assert.ok(links.some(item => item.service === 'redmine' && item.url === saved.url && String(item.key) === String(saved.key)),
      'Коллега видит связь задачи с разбором после перезапуска');
    console.log('PASS synthetic', JSON.stringify({
      mode: stand ? 'local Redmine + Mailpit' : 'offline adapters',
      ...report, caseId, roles: 2, recipientCount: 1, interviewExcerpts: 3,
      redmineIssue: saved.key, origin: issue.origin, createdIssues: 1,
      effectNumerator: after.sample.n, effectDenominator: after.sample.d, actualPercent: last.actual,
      targetPercent: after.target, controlPercent: after.peer.value, reopened: true,
      metrikaLatest: finalJournal.lastObservation,
    }));
  }, { send, http: !!stand });
}

async function main() {
  const argv = process.argv.slice(2);
  let archive, standFile, syntheticOnly = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--stand' && argv[i + 1]) standFile = argv[++i];
    else if (argv[i] === '--synthetic') syntheticOnly = true;
    else if (!archive && !argv[i].startsWith('-')) archive = argv[i];
    else throw Error('Неизвестный аргумент: ' + argv[i]);
  }
  if ((!archive && !syntheticOnly) || (archive && syntheticOnly))
    throw Error('Использование: node scripts/pilot-acceptance.mjs (<v17.zip> | --synthetic) [--stand <access.json>]');
  if (archive) await official(archive);
  await synthetic(await readStand(standFile));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => { console.error('FAIL', error.message); process.exitCode = 1; });
