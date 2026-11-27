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
import { openAccounts } from '../server/accounts.mjs';
import { initContacts } from '../server/notification-contacts.mjs';
import { syncWatches } from '../server/redmine-watch.mjs';
import { knowledge } from '../server/redmine-bridge.mjs';
import { importDocs } from '../server/evidence.mjs';

const owner = { id: 'one', role: 'admin', name: 'Автор' },
  peer = { id: 'two', role: 'member', name: 'Коллега' };
const config = {
  redmine: { service: 'redmine', url: 'https://bugs.test/pm', scope: 'store' },
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
      return json({ project: { id: 7, trackers: [{ id: 1, name: 'Задача' }] } });
    if (p === '/pm/enumerations/issue_priorities.json')
      return json({ issue_priorities: [{ id: 4, name: 'Высокий' }] });
    if (p === '/pm/projects/store/memberships.json')
      return json({ memberships: [{ user: { id: 5, name: 'Автор' } }], total_count: 1 });
    if (p.endsWith('/search.json'))
      return json({ results: remote.issues.map((i) => ({ type: 'issue', id: i.id })) });
    if (p === '/pm/issues.json' && method === 'GET') return json({ issues: remote.issues });
    if (p === '/pm/issues.json' && method === 'POST') {
      assert.equal(b.issue.project_id, 7);
      const issue = {
        id: remote.issues.length + 1,
        project: { id: 7 },
        subject: b.issue.subject,
        description: b.issue.description,
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
      if (remote.denyLink && b.issue.notes.includes('Confluence')) return status(403);
      if (b.issue.subject) issue.subject = b.issue.subject;
      if (b.issue.status_id) issue.status = { id: b.issue.status_id, name: 'В работе' };
      issue.journals.push({ user: { name: 'Автор' }, notes: b.issue.notes });
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
    assert.equal((await read('page_read', { issueKey: i.key })).key, p.key);
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
    assert.equal((await s.run('issue_read', { key: '№' + i.key })).key, i.key);
    assert.throws(() => s.run('issue_search', { query: 'Issue' }, owner, true), /личный чат/);
    m.issues[0].project.id = 12;
    await assert.rejects(s.run('issue_read', { key: i.key }), /другого проекта/);
    await personalConnection(store.db, owner, { service: 'redmine', action: 'disconnect' }, s.env, m.send);
    await assert.rejects(s.run('issue_search', { query: 'Issue' }), /Подключите/);
  } finally {
    store.close();
  }
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

test('personal Redmine closes into a private wiki page, preserves the Excel version and can publish to Data Center', async () => {
  const store = dbAt(),
    mock = siteMock(),
    s = scenario(store, mock),
    accounts = openAccounts(':memory:');
  s.env.APP_BASE_URL = 'https://pm.test';
  try {
    initContacts(accounts.db);
    accounts.publicUser = (id) => (id === owner.id ? owner : peer);
    store.db.prepare("UPDATE cases SET body=json_remove(body,'$.owner') WHERE id=?").run(s.caseId);
    await s.connect('redmine');
    const issue = await s.confirm(
      await s.draft('draft', { title: 'Статус оплаты', description: 'Сверить отчёт' }),
    );
    mock.issues[0].status = { id: 6, name: 'Выполнена', is_closed: true };
    await syncWatches(store, accounts, s.env, mock.send);
    const kb = knowledge(store.db, owner),
      page = kb.results[0].pageKey;
    assert.equal(kb.results[0].report, null);
    assert.equal(kb.pages.length, 1);
    assert.equal(knowledge(store.db, peer).pages.length, 0);
    assert.equal(knowledge(store.db, peer).results.length, 0);
    await assert.rejects(s.run('page_read', { key: page, local: true }, peer));
    await assert.rejects(s.run('page_read', { key: page, local: true }, owner, true));
    const book = { file: 'Индексы.xlsx', facts: [{ kind: 'competitor', loc: 'Обзор!C4', text: 'Проверка' }] };
    importDocs(store, [book], { notify: false });
    const [{ version }] = knowledge(store.db, owner).sources;
    const linked = await s.confirm(
      await s.draft('page_draft', { key: page, issueKey: issue.key, sourceVersions: [version] }),
    );
    assert.ok(mock.issues[0].journals[0].notes.includes('https://pm.test/' + linked.url));
    await s.connect('confluence');
    const publication = await s.draft('page_draft', {
      title: 'Итог по оплате',
      content: 'Проверено',
      resultPage: page,
      issueKey: issue.key,
    });
    await s.confirm(publication);
    await s.confirm(publication);
    assert.equal(mock.pages.length, 1);
    assert.match(mock.pages[0].body.storage.value, /bugs\.test\/pm\/issues\/1/);
    assert.ok(mock.pages[0].body.storage.value.includes('https://pm.test/#knowledge-source/' + version));
    assert.equal(mock.issues[0].journals.length, 2);
  } finally {
    accounts.db.close();
    store.close();
  }
});

test('a source lookup preserves zero, missing dates and the exact row of the imported version', () => {
  const store = openStore(':memory:', { seedDemo: false });
  try {
    initEvidence(store.db);
    assert.deepEqual(store.datasets(), []);
    assert.deepEqual(store.releases(), []);
    const doc = { file: 'source.xlsx', facts: [
      { kind: 'sales', loc: 'Sales!A7', row: { product_family:'Product', week_start:'2026-01-05', orders_index:0 } },
    ] };
    importDocs(store, [doc], {notify:false});
    const query = {product:'Product', metric:'orders_index', date:'2026-01-05'};
    const op = (name, data) => workspaceOperation(store, owner, name, data);
    const [hit] = op('source_value', query);
    assert.equal(hit.value, 0);
    assert.deepEqual(op('source_value', {...query, date:'2026-01-12'}), []);
    assert.deepEqual(op('source_value', {...query, segment:'mobile'}), []);
    const version = hit.version;
    importDocs(store, [{...doc, facts:[{...doc.facts[0], row:{...doc.facts[0].row, orders_index:5}}]}], {notify:false});
    const original = op('knowledge-source', {version, loc:hit.loc});
    assert.equal(original.rows[0].value.orders_index, 0);
    assert.throws(() => op('knowledge-source', {version, loc:'Sales!A99'}), /отсутствует/);
  } finally {
    store.close();
  }
});
