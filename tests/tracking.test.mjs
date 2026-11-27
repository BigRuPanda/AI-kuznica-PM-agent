import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore } from '../server/store.mjs';
import { initWorkbench } from '../server/workbench.mjs';
import { initEvidence } from '../server/evidence.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import {
  configure,
  personalConnection,
  finishOAuth,
  connectionInfo,
} from '../server/tracker-connections.mjs';
import { confluence } from '../server/tracker-clients.mjs';
import { initTracking, revisePage } from '../server/tracker-workflow.mjs';
import { teamTools } from '../server/team-mcp.mjs';
import { openAccounts } from '../server/accounts.mjs';
import { initContacts } from '../server/notification-contacts.mjs';
import { collectClosures } from '../server/redmine-bridge.mjs';
import { syncWatches } from '../server/redmine-watch.mjs';

const owner = { id: 'one', role: 'admin', name: 'Автор' },
  peer = { id: 'two', role: 'member', name: 'Коллега' };
const config = {
  redmine: { service: 'redmine', url: 'https://bugs.test/pm', scope: 'store', originFieldId: '17' },
  confluence: { service: 'confluence', url: 'https://kb.test/wiki', scope: 'TEAM', edition: 'dc' },
};
const macro =
  '<ac:structured-macro ac:name="code"><ac:plain-text-body><![CDATA[<macro>]]></ac:plain-text-body></ac:structured-macro>';
function dbAt(path = ':memory:') {
  const store = openStore(path);
  initEvidence(store.db);
  initWorkbench(store.db);
  return store;
}
function siteMock() {
  const remote = { issues: [], pages: [], calls: [], drop: '', denyLink: false };
  remote.send = async (url, init) => {
    const u = new URL(url),
      p = u.pathname,
      method = init.method || 'GET',
      b = init.body && JSON.parse(init.body);
    const auth = init.headers.Authorization || init.headers['X-Redmine-API-Key'];
    remote.calls.push({ p, q: u.searchParams, method, auth, b });
    const json = (value) => Response.json(value),
      status = (v) => new Response(null, { status: v });
    function committed(kind, value) {
      if (remote.drop === kind) {
        remote.drop = '';
        throw Error('Таймаут после записи');
      }
      return value;
    }
    if (!auth || auth.includes('revoked')) return status(401);
    if (p === '/pm/users/current.json') return json({ user: { id: 5 } });
    if (p.endsWith('/rest/api/user/current')) return json({ type: 'known', userKey: 'fixture' });
    if (p === '/pm/projects/store.json')
      return json({ project: { id: 7, trackers: [{ id: 1, name: 'Задача' }], issue_custom_fields: remote.customFields } });
    if (p === '/pm/enumerations/issue_priorities.json')
      return json({ issue_priorities: [{ id: 4, name: 'Высокий' }] });
    if (p === '/pm/projects/store/memberships.json')
      return json({ memberships: [{ user: { id: 5, name: 'Автор' } }], total_count: 1 });
    if (p.endsWith('/search.json'))
      return json({ results: remote.issues.map((i) => ({ type: 'issue', id: i.id })) });
    if (p === '/pm/issues.json' && method === 'GET') {
      const field = !remote.ignoreFilter && [...u.searchParams].find(([name]) => name.startsWith('cf_'));
      return json({ issues: remote.issues.filter(i => !field || i.custom_fields?.some(f => 'cf_' + f.id === field[0] && f.value === field[1])) });
    }
    if (p === '/pm/issues.json' && method === 'POST') {
      assert.equal(b.issue.project_id, 7);
      const issue = {
        id: remote.issues.length + 1,
        project: { id: 7 },
        subject: b.issue.subject,
        description: b.issue.description,
        custom_fields: remote.ignoreOrigin ? [] : (b.issue.custom_fields || []),
        journals: [],
        allowed_statuses: [{ id: 2, name: 'В работе' }],
        priority: { id: 4, name: 'Высокий' },
      };
      remote.issues.push(issue);
      return committed('issue', json({ issue }));
    }
    if (/\/issues\/\d+\.json/.test(p)) {
      const issue = remote.issues[Number(p.match(/(\d+)\.json/)[1]) - 1];
      if (!issue) return status(404);
      if (auth === 'peer-key') return status(403);
      if (method === 'GET') return json({ issue });
      if (remote.denyLink && b.issue.notes?.includes('Confluence')) return status(403);
      if (b.issue.subject) issue.subject = b.issue.subject;
      if (b.issue.description !== undefined) issue.description = b.issue.description;
      if (b.issue.custom_fields && !remote.ignoreOrigin) issue.custom_fields = b.issue.custom_fields;
      if (b.issue.status_id) issue.status = { id: b.issue.status_id, name: 'В работе' };
      if (b.issue.notes) issue.journals.push({ user: { name: 'Автор' }, notes: b.issue.notes });
      return committed('comment', new Response(''));
    }
    if (p.endsWith('/rest/api/space/TEAM')) return json({ id: 9, key: 'TEAM' });
    if (p.endsWith('/api/v2/spaces')) return json({ results: [{ id: '9', key: 'TEAM' }] });
    if (p.endsWith('/rest/api/content/search')) return json({ results: remote.pages });
    const cloud = p.includes('/api/v2/pages');
    if (p.includes('/rest/api/content') || cloud) {
      const id = p.match(/\/(\d+)$/)?.[1],
        old = remote.pages.find((x) => x.id === id);
      if (method === 'GET') return old ? json(old) : status(404);
      if (method === 'PUT' && old.version.number + 1 !== b.version.number) return status(409);
      if (cloud) assert.equal(b.spaceId, '9');
      else assert.equal(b.space.key, 'TEAM');
      const version = (old?.version.number || 0) + 1;
      const page = {
        id: id || String(remote.pages.length + 1),
        title: b.title,
        version: { number: version },
        space: { key: 'TEAM' },
        spaceId: '9',
        body: { storage: { value: cloud ? b.body.value : b.body.storage.value } },
      };
      if (old) Object.assign(old, page);
      else remote.pages.push(page);
      return committed('page', json(page));
    }
    throw Error('Unexpected endpoint ' + method + ' ' + p);
  };
  return remote;
}
function scenario(store, remote) {
  const env = {
    INTEGRATION_KEY: randomBytes(32).toString('base64url'),
    CONFLUENCE_CLIENT_ID: 'test',
    CONFLUENCE_CLIENT_SECRET: 'test',
  };
  const run = (op, input = {}, user = owner, shared = false) =>
    workspaceOperation(store, user, op, input, env, remote.send, shared);
  const caseId = run('create-case', { product: 'Store', title: 'Путь покупки' }).id;
  const draft = (op, b) => run(op, { caseId, ...b });
  const confirm = (d) => run('confirm', { id: d.id, revision: d.revision });
  const connect = async (service, token = 'owner-key') => {
    configure(store.db, owner, config[service]);
    await personalConnection(store.db, owner, { service, token, action: 'connect' }, env, remote.send);
  };
  return { env, run, caseId, draft, confirm, connect };
}

test('local complete workflow, participant isolation, target binding, links and restart', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'tracker-')), 'workspace.sqlite');
  let store = dbAt(path);
  try {
    const mock = siteMock(),
      s = scenario(store, mock);
    const d = await s.draft('draft', { title: 'Проверить оплату', description: 'Корзина' });
    await s.connect('redmine');
    assert.throws(() => s.run('confirm', { id: d.id }, peer), /недоступен/);
    const i = await s.confirm(d);
    assert.match(i.key, /^DEMO-/);
    assert.equal(mock.issues.length, 0);
    configure(store.db, owner, { service: 'redmine', url: '' });
    assert.equal((await s.run('issue_search', { query: 'оплату' })).items[0].key, i.key);
    assert.equal((await s.run('issue_search', { query: 'оплату' }, peer)).items.length, 0);
    const edit = await s.draft('draft', {
      key: i.key,
      statusId: 'В работе',
      assigneeId: owner.id,
      comment: 'Проверено',
    });
    await s.confirm(edit);
    const pd = await s.draft('page_draft', {
      title: 'Разбор оплаты',
      content: 'Исходный текст',
      issueKey: i.key,
    });
    const p = await s.confirm(pd);
    assert.equal((await s.confirm(pd)).key, p.key);
    const patch = await s.draft('page_draft', { key: p.key, fragment: 'Исходный', content: 'Новый' });
    await s.confirm(patch);
    store.close();
    store = dbAt(path);
    const read = (op, input, user = owner) => workspaceOperation(store, user, op, input);
    const page = await read('page_read', { key: p.key });
    assert.equal(page.version, 2);
    assert.match(page.text, /Новый текст/);
    assert.equal(page.links[0].url, i.url);
    const issue = await read('issue_read', { key: i.key });
    assert.equal(issue.status, 'В работе');
    assert.equal(issue.comments.length, 2);
    assert.ok(issue.comments.some((c) => c.text.includes(p.url)));
    assert.equal((await read('page_search', { query: 'оплаты' }, peer)).items.length, 0);
    await assert.rejects(read('page_read', { key: p.key }, peer), /недоступна/);
  } finally {
    store.close();
  }
});

test('Redmine personal identity, project checks, choices, uncertain create and journal recovery', async () => {
  const store = dbAt(),
    m = siteMock(),
    s = scenario(store, m);
  try {
    await s.connect('redmine');
    assert.ok(!store.one('SELECT secret FROM integration_tokens').secret.includes('owner-key'));
    const d = await s.draft('draft', {
      title: 'Issue',
      description: 'Body',
      priorityId: '4',
      trackerId: '1',
      assigneeId: '5',
    });
    m.drop = 'issue';
    await assert.rejects(s.confirm(d), /Таймаут/);
    // Simulate an interrupted worker after the remote write but before its local acknowledgement.
    store.db.prepare("UPDATE draft_actions SET state='sending' WHERE id=?").run(d.id);
    initWorkbench(store.db);
    const i = await s.confirm(d);
    assert.equal(m.issues.length, 1);
    assert.equal(i.url, 'https://bugs.test/pm/issues/1');
    assert.equal(m.calls.filter((c) => c.method === 'POST' && c.p.endsWith('issues.json')).length, 1);
    assert.ok(!m.calls.find((c) => c.p.endsWith('/search.json')).q.has('open_issues'));
    const update = await s.draft('draft', { key: i.key, statusId: '2', comment: 'Готово' });
    m.drop = 'comment';
    await assert.rejects(s.confirm(update), /Таймаут/);
    await s.confirm(update);
    assert.equal(m.issues[0].journals.length, 1);
    assert.equal(m.issues[0].status.id, 2);
    await assert.rejects(s.draft('draft', { key: i.key, statusId: '55' }), /недоступен/);
    await personalConnection(
      store.db,
      peer,
      { service: 'redmine', action: 'connect', token: 'peer-key' },
      s.env,
      m.send,
    );
    await assert.rejects(s.run('issue_read', { key: i.key }, peer), /403/);
    assert.throws(() => s.run('issue_search', { query: 'Issue' }, owner, true), /личный чат/);
    m.issues[0].project.id = 12;
    await assert.rejects(s.run('issue_read', { key: i.key }), /другого проекта/);
    await personalConnection(store.db, owner, { service: 'redmine', action: 'disconnect' }, s.env, m.send);
    await assert.rejects(s.run('issue_search', { query: 'Issue' }), /Подключите/);
  } finally {
    store.close();
  }
});

test('assistant-created Redmine and demo issues get a filterable origin, human edits retain authorship', async () => {
  for (const external of [false, true]) {
    const store = dbAt(), m = siteMock(), s = scenario(store, m);
    try {
      if (external) await s.connect('redmine');
      const mcp = new Map();
      teamTools({registerTool(name, _schema, fn) { mcp.set(name, fn); }}, store, owner, s.env, m.send);
      const gen = async input => {
        const r = await mcp.get('draft')({caseId:s.caseId, ...input});
        assert.ok(!r.isError, r.content[0].text);
        return JSON.parse(r.content[0].text);
      };
      const pending = await gen({title:'Проверка',description:'Сверить продажи.'});
      assert.ok(pending.diff.some(d => d.field === 'Происхождение задачи' && d.after === 'ai-generated'));
      const created = await s.confirm(pending);
      const manual = await s.confirm(await s.draft('draft', {title:'Ручная проверка',description:'Сгенерирована ИИ-помощником.'}));
      await s.confirm(await gen({key:manual.key,comment:'Комментарий помощника'}));
      await s.confirm(await s.draft('draft', {key:created.key,description:'Уточнённое описание'}));
      const result = await s.run('issue_read',{key:created.key});
      assert.equal(result.origin,'ai-generated');
      assert.match(result.description,/Уточнённое описание[\s\S]+Сгенерирована ИИ-помощником\./);
      assert.equal((await s.run('issue_read',{key:manual.key})).origin,null);
      const hits = await s.run('issue_search',{query:'',origin:'ai-generated'});
      assert.deepEqual(hits.items.map(i=>i.key),[created.key]);
      if (external) {
        assert.ok(m.calls.some(c=>c.q.get('cf_17') === 'ai-generated'));
        m.ignoreFilter = true;
        await assert.rejects(s.run('issue_search',{query:'',origin:'ai-generated'}),/использование поля/);
      }
    } finally { store.close(); }
  }
});

test('the signal draft is scoped to the participant and the current signal revision', async () => {
  const store = dbAt(), s = scenario(store, siteMock());
  try {
    const { caseId } = s;
    const op = (data = {}, user = owner) => s.run('signal-issue-draft', { caseId, ...data }, user);
    const saveSignal = (signal) => store.db.prepare("UPDATE cases SET body=json_set(body,'$.signal',json(?)) WHERE id=?")
      .run(JSON.stringify(signal), caseId);
    const signal = {
      revision: 3, status: 'confirmed', metric: 'lk_reco_ctr', releaseId: 'release-1', segment: 'desktop',
      week: '2026-11-02', n: 3, d: 100, value: 3, change: -62.5,
    };
    assert.throws(() => op(), /нет действующего сигнала/);
    saveSignal(signal);
    assert.throws(() => op({}, peer), /Разбор недоступен/);
    store.db.prepare("UPDATE cases SET body=json_remove(body,'$.owner') WHERE id=?").run(caseId);
    const [first, repeated, otherUser] = await Promise.all([op(), op({ revision: 3 }), op({}, peer)]);
    assert.equal(first.id, repeated.id);
    assert.notEqual(first.id, otherUser.id);
    assert.match(first.description, /3 \/ 100 = 3%/);
    assert.throws(() => op({ title: 'Подмена заголовка' }), /Unrecognized key/);
    saveSignal({ ...signal, revision: 4, n: 4, value: 4, change: -50 });
    assert.throws(() => op({ revision: 3 }), /Сигнал изменился/);
    const next = await op();
    assert.notEqual(next.id, first.id);
    assert.match(next.description, /4 \/ 100 = 4%/);
    saveSignal({ ...signal, revision: 5, status: 'withdrawn' });
    assert.throws(() => op(), /нет действующего сигнала/);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM draft_actions WHERE case_id=?').get(caseId).n, 3);
  } finally { store.close(); }
});

test('direct demo Redmine checks the boolean AI field, keeps the saved ID and filters the repaired issue', async () => {
  const store = dbAt(), remote = siteMock(), s = scenario(store, remote);
  try {
    s.env.REDMINE_REQUIRE_AI_FLAG = 'true';
    s.env.REDMINE_DEMO_URL = 'http://127.0.0.1:18881';
    configure(store.db, owner, { service: 'redmine', url: s.env.REDMINE_DEMO_URL, scope: 'signal-demo' }, s.env);
    configure(store.db, owner, { service: 'redmine', url: config.redmine.url, scope: config.redmine.scope }, s.env);
    await personalConnection(store.db, owner, { service: 'redmine', token: 'owner-key', action: 'connect' }, s.env, remote.send);
    await assert.rejects(s.draft('draft', { title: 'Проверить закрытие', description: 'Описание' }), /поле-флаг/);
    remote.customFields = [{ id: 48, name: 'сгенерирована ИИ-помощником' }];
    remote.ignoreOrigin = true;
    const draft = await s.draft('draft', { title: 'Проверить закрытие', description: 'Описание' });
    const partial = await s.confirm(draft);
    assert.equal(partial.state, 'partial');
    assert.equal(partial.key, '1');
    remote.ignoreOrigin = false;
    const saved = await s.confirm(draft);
    assert.equal(saved.state, 'done');
    assert.equal(saved.key, partial.key);
    assert.equal(remote.issues.length, 1);
    assert.deepEqual(remote.issues[0].custom_fields, [{ id: 48, value: '1' }]);
    const found = await s.run('issue_search', { query: '', origin: 'ai-generated' });
    assert.deepEqual(found.items.map(item => item.key), [saved.key]);
  } finally {
    store.close();
  }
});

test('a direct Redmine write rechecks the saved project after asynchronous preflight', async () => {
  const store = dbAt(), remote = siteMock(), s = scenario(store, remote);
  try {
    await s.connect('redmine');
    const draft = await s.draft('draft', { title: 'Проверить назначение', description: 'Описание' });
    const send = remote.send;
    remote.send = async (url, init) => {
      const response = await send(url, init);
      if (new URL(url).pathname === '/pm/projects/store.json')
        configure(store.db, owner, { ...config.redmine, scope: 'changed-project' });
      return response;
    };
    await assert.rejects(s.confirm(draft), /Назначение изменилось/);
    assert.equal(remote.issues.length, 0);
  } finally {
    store.close();
  }
});

test('unverified Redmine origin keeps the created ID and repairs one issue after a restart', async () => {
  const store = dbAt(), m = siteMock(), s = scenario(store, m);
  try {
    await s.connect('redmine');
    const d = await workspaceOperation(store,owner,'draft',{caseId:s.caseId,title:'Проверить'},s.env,m.send,false,undefined,true);
    m.ignoreOrigin = true;
    m.drop = 'issue';
    await assert.rejects(s.confirm(d),/Таймаут/);
    const incomplete = await s.confirm(d);
    assert.equal(incomplete.state,'partial');
    assert.equal(incomplete.key,'1');
    initWorkbench(store.db);
    m.ignoreOrigin = false;
    configure(store.db, owner, {...config.redmine, originFieldId:'28'});
    const done = await s.confirm(d);
    assert.equal(done.state,'done');
    assert.equal((await s.confirm(d)).key,incomplete.key);
    assert.equal((await s.run('issue_read',{key:done.key})).origin,'ai-generated');
    assert.equal(m.calls.filter(c=>c.method==='POST' && c.p.endsWith('/issues.json')).length,1);
    assert.equal(m.calls.filter(c=>c.method==='PUT' && c.b.issue.custom_fields).length,1);
    assert.deepEqual(m.issues[0].custom_fields,[{id:28,value:'ai-generated'}]);
  } finally { store.close(); }
});

test('Data Center page recovery, concurrent confirms, partial backlink and changed storage version', async () => {
  const store = dbAt(),
    m = siteMock(),
    s = scenario(store, m);
  try {
    await s.connect('redmine');
    await s.connect('confluence');
    const i = await s.confirm(await s.draft('draft', { title: 'Задача' }));
    const d = await s.draft('page_draft', { title: 'Отчёт', content: 'Старый текст', issueKey: i.key });
    m.drop = 'page';
    await assert.rejects(s.confirm(d), /Таймаут/);
    m.denyLink = true;
    const partial = await s.confirm(d);
    assert.equal(partial.state, 'partial');
    assert.equal(m.pages.length, 1);
    m.denyLink = false;
    const attempts = await Promise.allSettled([s.confirm(d), s.confirm(d)]);
    assert.equal(attempts.filter((a) => a.status === 'fulfilled').length, 1);
    assert.equal(m.issues[0].journals.length, 1);
    assert.equal(m.pages.length, 1);
    const p = m.pages[0];
    p.body.storage.value = macro + p.body.storage.value;
    const edit = await s.draft('page_draft', { key: p.id, fragment: 'Старый текст', content: 'Новый текст' });
    p.version.number++;
    p.body.storage.value += '<p>Правка коллеги</p>';
    const refreshed = await s.confirm(edit);
    assert.equal(refreshed.state, 'draft');
    assert.notEqual(refreshed.revision, edit.revision);
    await assert.rejects(s.confirm(edit), /актуальный/);
    await s.confirm(refreshed);
    assert.ok(p.body.storage.value.includes(macro));
    assert.match(p.body.storage.value, /Правка коллеги/);
    assert.match(p.body.storage.value, /Новый текст/);
    assert.equal(p.version.number, 3);
    assert.equal(m.calls.filter((c) => c.method === 'POST' && c.p.endsWith('/rest/api/content')).length, 1);
    assert.ok(m.calls.filter((c) => c.p.startsWith('/wiki/')).every((c) => c.auth === 'Bearer owner-key'));
  } finally {
    store.close();
  }
});

test('Cloud OAuth binds user, site and state, rotates token, and uses v1 search and v2 page API', async () => {
  const store = dbAt(),
    m = siteMock(),
    s = scenario(store, m);
  let exchanges = 0;
  const send = async (url, init) => {
    if (url === 'https://auth.atlassian.com/oauth/token') {
      const b = JSON.parse(init.body);
      exchanges++;
      if (exchanges === 1) assert.equal(b.grant_type, 'authorization_code');
      else {
        assert.equal(b.refresh_token, 'refresh-1');
        assert.equal(b.grant_type, 'refresh_token');
      }
      return Response.json({
        access_token: 'access-' + exchanges,
        refresh_token: 'refresh-' + exchanges,
        expires_in: exchanges === 1 ? 0 : 3600,
      });
    }
    if (url.endsWith('accessible-resources'))
      return Response.json([
        { id: 'cloud-test', url: 'https://tenant.test', scopes: ['read:page:confluence'] },
      ]);
    assert.ok(url.startsWith('https://api.atlassian.com/ex/confluence/cloud-test/wiki/'));
    return m.send(url, init);
  };
  try {
    configure(store.db, owner, { ...config.confluence, url: 'https://tenant.test', edition: 'cloud' });
    const { authorize } = await personalConnection(
      store.db,
      owner,
      { service: 'confluence', action: 'connect' },
      s.env,
      send,
    );
    const params = new URL(authorize).searchParams;
    params.set('code', 'fixture-code');
    await assert.rejects(finishOAuth(store.db, peer, params, s.env, send), /Повторите/);
    await finishOAuth(store.db, owner, params, s.env, send);
    await assert.rejects(finishOAuth(store.db, owner, params, s.env, send), /Повторите/);
    assert.equal(connectionInfo(store.db, owner).confluence.connected, true);
    const run = (op, b) => workspaceOperation(store, owner, op, b, s.env, send);
    const [draft] = await Promise.all([
      run('page_draft', { caseId: s.caseId, title: 'Page', content: 'Начало' }),
      run('page_search', { query: 'Page' }),
    ]);
    assert.equal(exchanges, 2);
    const result = await run('confirm', draft);
    const page = await run('page_read', { key: result.key });
    assert.equal(page.text, 'Начало');
    assert.ok(page.url.startsWith('https://tenant.test/wiki/'));
    const update = await run('page_draft', {
      caseId: s.caseId,
      key: result.key,
      title: 'Updated',
      content: 'Финал',
    });
    await run('confirm', update);
    assert.equal(m.pages[0].version.number, 2);
    assert.ok(m.calls.some((c) => c.p.endsWith('/rest/api/content/search') && c.auth === 'Bearer access-2'));
    m.pages[0].spaceId = '55';
    await assert.rejects(run('page_read', { key: result.key }), /другого пространства/);
    for (const edition of ['dc', 'cloud']) {
      const api = confluence(
        { ...config.confluence, edition },
        { token: 'revoked', cloudId: 'cloud-test' },
        m.send,
      );
      await assert.rejects(api.check(), /переподключите/);
    }
  } finally {
    store.close();
  }
});

test('shared case links respect both users’ remote permissions, and stale edits can be revised', async () => {
  const store = dbAt(),
    m = siteMock(),
    s = scenario(store, m);
  try {
    const c = store.one('SELECT body FROM cases WHERE id=?', s.caseId);
    const shared = JSON.parse(c.body);
    delete shared.owner;
    store.db.prepare('UPDATE cases SET body=? WHERE id=?').run(JSON.stringify(shared), s.caseId);
    await s.connect('redmine');
    await s.connect('confluence');
    const issue = await s.confirm(await s.draft('draft', { title: 'Team' }));
    const page = await s.confirm(
      await s.draft('page_draft', { title: 'KB', content: 'Original', issueKey: issue.key }),
    );
    const links = () => s.run('case_links', { caseId: s.caseId }, peer);
    assert.deepEqual((await links()).items, []);
    await personalConnection(
      store.db,
      peer,
      { service: 'redmine', action: 'connect', token: 'peer-key' },
      s.env,
      m.send,
    );
    assert.deepEqual((await links()).items, []);
    await personalConnection(
      store.db,
      peer,
      { service: 'confluence', action: 'connect', token: 'reader' },
      s.env,
      m.send,
    );
    assert.deepEqual(
      (await links()).items.map((l) => l.url),
      [page.url],
    );
    const patch = await s.draft('page_draft', {
      key: page.key,
      fragment: 'Original',
      content: 'Replacement',
    });
    const remote = m.pages[0];
    remote.version.number++;
    remote.title = 'Renamed by colleague';
    remote.body.storage.value = macro + '<p>Current <strong>Q&amp;A</strong> text.</p>';
    const stale = await s.confirm(patch);
    assert.equal(stale.state, 'obsolete');
    assert.match(stale.latestPage.text, /Current Q&A/);
    const row = store.one('SELECT * FROM draft_actions WHERE id=?', patch.id);
    const refreshed = await revisePage(
      store,
      owner,
      row,
      { revision: stale.revision, fragment: 'Current Q&A' },
      s.env,
      m.send,
    );
    await s.confirm(refreshed);
    assert.equal(remote.title, 'Renamed by colleague');
    assert.ok(remote.body.storage.value.includes(macro));
    assert.match(remote.body.storage.value, /<p>Replacement<strong><\/strong> text\.<\/p>/);
  } finally {
    store.close();
  }
});

test('older persisted drafts stay local after upgrading and activating a provider', async () => {
  const store = dbAt(),
    m = siteMock(),
    s = scenario(store, m);
  try {
    store.db
      .prepare("INSERT INTO draft_actions VALUES('legacy',?,?,?,'draft',NULL)")
      .run(s.caseId, owner.id, JSON.stringify({ title: 'Old', description: 'Old', key: '', priority: '' }));
    initTracking(store.db);
    await s.connect('redmine');
    assert.match((await s.confirm({ id: 'legacy' })).key, /^DEMO-/);
    assert.equal(m.issues.length, 0);
  } finally {
    store.close();
  }
});

test('Bridge keeps the draft report across confirmation, restart and two closure episodes', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'redmine-bridge-')), 'workspace.sqlite');
  let store = dbAt(path);
  const tasks = new Map();
  let loseReply = true;
  const closures = [];
  const report = { id: 'A', start: '2026-11-01', end: '2026-11-14', periods: [[40, 2], [60, 5]], status: 'Наблюдение', web: 'https://metrika.example/' };
  const remote = { send: async (url, opts) => {
    const u = new URL(url);
    if (u.pathname === '/reports/latest') return Response.json(report);
    if (u.pathname === '/closures') return Response.json(closures.filter(row => row.seq > Number(u.searchParams.get('after'))));
    if (u.pathname === '/tasks') {
      const body = JSON.parse(opts.body);
      if (!tasks.has(body.reference)) tasks.set(body.reference, { ...body, redmine_id: 17, url: 'http://localhost:18881/issues/17' });
      if (loseReply) {
        loseReply = false;
        throw Error('Таймаут после записи');
      }
      return Response.json(tasks.get(body.reference));
    }
    throw Error('Unexpected request: ' + url);
  } };
  try {
    const s = scenario(store, remote);
    Object.assign(s.env, { SIGNAL_BRIDGE_URL: 'http://localhost:18880', DATA_PROFILE: 'local', LOCAL_HTTP_ORIGINS: 'http://localhost:18880', NOTIFICATION_CHANNELS: 'telegram' });
    const draft = await s.draft('draft', { title: 'Проверить корзину', description: 'Проверить отчёт', includeReport: true });
    assert.ok(draft.diff.some(row => row.field === 'Снимок Метрики'));
    const firstReport = { ...report };
    report.id = 'B';
    await assert.rejects(s.confirm(draft), /Таймаут после записи/);
    const accounts = openAccounts(':memory:');
    initContacts(accounts.db);
    try {
      const run = (op, input, user = owner) => workspaceOperation(store, user, op, input, s.env, remote.send);
      store.close();
      store = dbAt(path);
      const confirm = () => run('confirm', { id: draft.id });
      const receipt = await confirm();
      assert.equal((await confirm()).key, receipt.key);
      assert.equal(receipt.key, 'Redmine #17');
      assert.equal(tasks.size, 1);
      const [task] = tasks.values();
      assert.equal(task.report_id, 'A');
      closures.push({
        seq: 1, episode: 1, reference: task.reference, issue: task.redmine_id, title: task.title,
        status: 'Closed', closing_note: { text: 'Первый вывод', author: 'QA' },
        url: task.url, observed: '2026-11-20T08:00:00Z', report: firstReport,
      });
      const collect = () => collectClosures(store, accounts.db, s.env, remote.send);
      await collect();
      await collect();
      const read = () => store.db.prepare('SELECT * FROM demo_pages').all();
      const [page] = read();
      assert.equal(page.version, 1);
      assert.match(page.storage, /Первый вывод/);
      store.close();
      store = dbAt(path);
      closures.push({ ...closures[0], seq: 2, episode: 2, closing_note: { text: 'Второй вывод', author: 'QA' } });
      await collect();
      await collect();
      const pages = read();
      assert.equal(pages.length, 1);
      assert.equal(pages[0].key, page.key);
      assert.equal(pages[0].version, 2);
      assert.match(pages[0].storage, /Второй вывод/);
      const deliveries = store.db.prepare("SELECT body FROM deliveries WHERE id LIKE 'web-draft-%'").all().map(r => JSON.parse(r.body));
      assert.deepEqual(deliveries.map(row => row.owner), [owner.id, owner.id]);
    } finally {
      accounts.db.close();
    }
  } finally {
    store.close();
  }
});

test('direct Redmine tracks a reopened issue and keeps closing notes and the page private', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'redmine-watch-')), 'workspace.sqlite');
  let store = dbAt(path);
  const remote = siteMock(),
    s = scenario(store, remote);
  try {
    store.db.prepare("UPDATE cases SET body=json_remove(body,'$.owner') WHERE id=?").run(s.caseId);
    await s.connect('redmine');
    const receipt = await s.confirm(await s.draft('draft', { title: 'Статус оплаты', description: 'Первоначальный отчёт' }));
    const issue = remote.issues[0];
    const close = (note) => {
      issue.status = { id: 6, name: 'Выполнена', is_closed: true };
      issue.journals.push(
        { details: [{ name: 'status_id', new_value: '6' }], notes: note + '\npm-fixture', user: { name: 'QA' } },
        { notes: 'Обсуждение после закрытия' },
      );
    };
    close('Первый итог');
    const accounts = openAccounts(':memory:');
    initContacts(accounts.db);
    accounts.publicUser = (id) => id === owner.id ? owner : null;
    try {
      const sync = async () => {
        store.db.exec('UPDATE redmine_watches SET next=0');
        await syncWatches(store, accounts, s.env, remote.send);
      };
      const results = () => store.db.prepare('SELECT body FROM redmine_results').all().map(r => JSON.parse(r.body));
      await sync();
      await sync();
      assert.deepEqual(results().map(r => r.closing_note.text), ['Первый итог']);
      const [page] = store.db.prepare('SELECT * FROM demo_pages').all();
      store.close();
      store = dbAt(path);
      issue.status = { id: 2, name: 'Открыта', is_closed: false };
      await sync();
      close('Второй итог');
      await sync();
      assert.deepEqual(results().map(r => r.closing_note.text), ['Первый итог', 'Второй итог']);
      assert.equal(results()[1].issue, receipt.key);
      const run = (user) => workspaceOperation(store, user, 'page_read', { key: page.key, local: true }, s.env, remote.send);
      const visible = await run(owner);
      assert.equal(visible.version, 2);
      assert.match(visible.text, /Второй итог/);
      await assert.rejects(run(peer), /Страница недоступна/);
    } finally {
      accounts.db.close();
    }
  } finally {
    store.close();
  }
});

test('an already closed direct task receives a baseline page on first startup', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'redmine-history-')), 'workspace.sqlite');
  let store = dbAt(path);
  const remote = siteMock(),
    s = scenario(store, remote);
  try {
    await s.connect('redmine');
    await s.confirm(await s.draft('draft', { title: 'Старая задача', description: 'Сохранённый текст' }));
    store.db.exec('DROP TABLE IF EXISTS redmine_watches');
    store.close();
    store = dbAt(path);
    remote.issues[0].status = { id: 6, name: 'Выполнена', is_closed: true };
    const accounts = openAccounts(':memory:');
    initContacts(accounts.db);
    accounts.publicUser = () => owner;
    try {
      await syncWatches(store, accounts, s.env, remote.send);
      assert.equal(store.db.prepare('SELECT count(*) AS n FROM demo_pages').get().n, 1);
      assert.equal(store.db.prepare("SELECT count(*) AS n FROM deliveries WHERE json_extract(body,'$.issueUrl') IS NOT NULL").get().n, 0);
    } finally {
      accounts.db.close();
    }
  } finally {
    store.close();
  }
});
