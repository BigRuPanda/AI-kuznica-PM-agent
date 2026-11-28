import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { importDocs } from '../server/evidence.mjs';
import { createTeamApp } from '../server/team-http.mjs';
import { seedReleaseMetrics } from './release-metrics-fixture.mjs';

const entrypoint = fileURLToPath(new URL('../server/mcp.mjs', import.meta.url));

function transport(base, key, stderr = 'inherit') {
  return new StdioClientTransport({
    command: process.execPath,
    args: [entrypoint],
    env: { DATABASE_URL: base, DATA_PROFILE: 'local', MCP_ACCESS_TOKEN: key, RELEASE_MCP_CONTEXT: '', SIGNAL_BRIDGE_URL: '' },
    stderr,
  });
}

test('a personal stdio MCP key scopes case access and its replacement revokes the old key', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'pm-stdio-mcp-'));
  const base = join(dir, 'team.sqlite');
  const env = { ADMIN_INVITE_KEY: 'fixture-admin', DATA_PROFILE: 'local' };
  const app = createTeamApp({ base, env, background: false });
  t.after(async () => {
    await app.close();
    await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  function account(login, code) {
    return app.accounts.register({ login, name: login, password: 'fixture-password', code }, env);
  }
  const { user: owner } = await account('owner', env.ADMIN_INVITE_KEY);
  const { user: peer } = await account('peer', app.accounts.invite('team'));
  const store = app.space('team');
  seedReleaseMetrics(store);
  const addCase = store.db.prepare('INSERT INTO cases VALUES(?,?,?,?,?)');
  addCase.run('shared-case', 'Product', 'Shared case', 'Новый', '{}');
  addCase.run('owner-case', 'Product', 'Owner case', 'Новый', JSON.stringify({ owner: owner.id }));
  addCase.run('peer-case', 'Product', 'Peer case', 'Новый', JSON.stringify({ owner: peer.id }));
  const oldKey = app.accounts.issueKey(owner.id);
  const oldClient = new Client({ name: 'connected-old-key-fixture', version: '1' });
  let newKey;
  try {
    await oldClient.connect(transport(base, oldKey));
    const overview = await oldClient.callTool({ name: 'workspace_overview', arguments: {} });
    assert.equal(Boolean(overview.isError), false, overview.content[0]?.text);
    newKey = app.accounts.issueKey(owner.id);
    for (const [name, args] of [
      ['workspace_overview', {}],
      ['release_funnel', { releaseId: 'R-001', day: 14 }],
      ['list_releases', {}],
    ]) {
      await t.test(`the connected session loses ${name} after key rotation`, async () => {
        const denied = await oldClient.callTool({ name, arguments: args });
        assert.equal(Boolean(denied.isError), true);
        assert.equal(denied.content[0].text, 'Недействительный персональный ключ MCP');
      });
    }
  } finally {
    await oldClient.close();
  }
  const client = new Client({ name: 'personal-stdio-fixture', version: '1' });
  try {
    await client.connect(transport(base, newKey));
    const { tools } = await client.listTools();
    const catalog = new Map(tools.map(tool => [tool.name, tool.inputSchema]));
    assert.ok(catalog.get('funnel').properties.caseId);
    assert.deepEqual(catalog.get('release_funnel').required, ['releaseId']);
    const overview = await client.callTool({ name: 'workspace_overview', arguments: {} });
    assert.equal(Boolean(overview.isError), false, overview.content[0]?.text);
    const data = JSON.parse(overview.content[0].text);
    assert.equal(data.user.id, owner.id);
    assert.deepEqual(data.cases.map(item => item.id).sort(), ['owner-case', 'shared-case']);
    const funnel = await client.callTool({ name: 'release_funnel', arguments: { releaseId: 'R-001', day: 14 } });
    assert.equal(Boolean(funnel.isError), false, funnel.content[0]?.text);
    const calculation = JSON.parse(funnel.content[0].text);
    assert.equal(calculation.op, 'funnel');
    assert.deepEqual(calculation.result.steps.map(step => step.paid), [5, 4]);

    await t.test('search_evidence returns the imported workbook version and cell', async () => {
      const file = 'Roadmap.xlsx';
      const loc = 'Tasks!C12';
      importDocs(store, [{ file, facts: [{ kind: 'backlog', loc, row: {
        task_id: 'T-12', title: 'Проверить телеметрию доставки', status: 'New', created_date: '2026-10-01',
      } }] }], { notify: false });
      const { version } = store.one('SELECT version FROM documents WHERE file=?', file);
      const found = await client.callTool({ name: 'search_evidence', arguments: { query: 'телеметрию доставки' } });
      assert.equal(Boolean(found.isError), false, found.content[0]?.text);
      const hits = JSON.parse(found.content[0].text);
      assert.deepEqual(hits.map(hit => [hit.key, hit.file, hit.loc, hit.version]), [['T-12', file, loc, version]]);
    });

    await t.test('draft_issue prepares a private preview without creating an issue', async () => {
      const issue = { title: 'Проверка телеметрии', description: 'Сравнить сведения из таблицы' };
      const draft = caseId => client.callTool({ name: 'draft_issue', arguments: { caseId, ...issue } });
      const result = await draft('owner-case');
      assert.equal(Boolean(result.isError), false, result.content[0]?.text);
      const preview = JSON.parse(result.content[0].text);
      assert.equal(preview.caseId, 'owner-case');
      assert.equal(preview.title, issue.title);
      assert.ok(preview.description.includes(issue.description));
      assert.equal(preview.state, 'draft');
      assert.equal(preview.external, null);
      assert.equal((await draft('peer-case')).isError, true);
      const rows = store.db.prepare('SELECT id, user FROM draft_actions').all();
      assert.deepEqual(rows.map(row => [row.id, row.user]), [[preview.id, owner.id]]);
      assert.equal(store.one('SELECT count(*) n FROM local_issues').n, 0);
    });
  } finally {
    await client.close();
  }
  const revokedClient = new Client({ name: 'revoked-stdio-fixture', version: '1' });
  try {
    await assert.rejects(revokedClient.connect(transport(base, oldKey, 'ignore')), /connection closed/i);
  } finally {
    await revokedClient.close();
  }
});

test('standalone stdio MCP retains funnel as the release analytics tool', async () => {
  const client = new Client({ name: 'standalone-stdio-fixture', version: '1' });
  try {
    await client.connect(transport(':memory:', ''));
    const { tools } = await client.listTools();
    const catalog = new Map(tools.map(tool => [tool.name, tool.inputSchema]));
    assert.deepEqual(catalog.get('funnel').required, ['releaseId']);
    assert.equal(catalog.has('release_funnel'), false);
    assert.equal(catalog.has('workspace_overview'), false);
  } finally {
    await client.close();
  }
});
