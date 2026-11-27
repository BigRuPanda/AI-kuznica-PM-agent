import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTeamApp } from '../server/team-http.mjs';
import { initEvidence } from '../server/evidence.mjs';
import { effectiveResearchMode, researchSettings, saveResearchSettings } from '../server/investigation-settings.mjs';

const admin = { id: 'team-admin', role: 'admin' };
const member = { id: 'product-manager', role: 'member' };

test('signal research uses team settings and personal assignments inherit until overridden', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'research-settings-'));
  const path = join(dir, 'workspace.sqlite');
  let db = new DatabaseSync(path);
  t.after(async () => { db.close(); await rm(dir, { recursive: true }); });
  initEvidence(db);
  assert.deepEqual(researchSettings(db, member), { team: 'roles', personal: 'inherit', effective: 'roles' });
  saveResearchSettings(db, admin, { scope: 'team', mode: 'review' });
  assert.equal(effectiveResearchMode(db, null), 'review');
  assert.equal(effectiveResearchMode(db, member.id), 'review');
  assert.deepEqual(saveResearchSettings(db, member, { scope: 'personal', mode: 'lead' }),
    { team: 'review', personal: 'lead', effective: 'lead' });
  saveResearchSettings(db, admin, { scope: 'team', mode: 'roles' });
  db.close();
  db = new DatabaseSync(path);
  assert.equal(effectiveResearchMode(db, member.id), 'lead');
  assert.equal(effectiveResearchMode(db, admin.id), 'roles');
  assert.equal(effectiveResearchMode(db, null), 'roles');
  assert.equal(saveResearchSettings(db, member, { scope: 'personal', mode: 'inherit' }).effective, 'roles');
});

test('members can save only their own preference and invalid modes do not change settings', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  initEvidence(db);
  assert.throws(() => saveResearchSettings(db, member, { scope: 'team', mode: 'lead' }), /администратора/);
  for (const input of [{scope:'team',mode:'inherit'}, {scope:'other',mode:'lead'}, {scope:'personal',mode:'other'}])
    assert.throws(() => saveResearchSettings(db, admin, input));
  saveResearchSettings(db, member, { scope: 'personal', mode: 'lead', ownerId: admin.id });
  assert.deepEqual(researchSettings(db, admin), { team: 'roles', personal: 'inherit', effective: 'roles' });
  assert.equal(effectiveResearchMode(db, member.id), 'lead');
});

test('settings use the signed-in account and OAuth returns to personal connections', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'settings-http-'));
  const env = {
    ADMIN_INVITE_KEY: 'fixture-admin', INTEGRATION_KEY: Buffer.alloc(32, 1).toString('base64url'),
    CONFLUENCE_CLIENT_ID: 'fixture-client', CONFLUENCE_CLIENT_SECRET: 'fixture-secret',
  };
  const send = async (url, init) => {
    const target = new URL(url);
    if (target.href === 'https://auth.atlassian.com/oauth/token') {
      assert.equal(JSON.parse(init.body).code, 'fixture-code');
      return Response.json({ access_token: 'access', refresh_token: 'refresh', expires_in: 3600 });
    }
    assert.equal(init.headers.Authorization, 'Bearer access');
    if (target.pathname === '/oauth/token/accessible-resources') {
      return Response.json([{ id: 'fixture-cloud', url: 'https://tenant.test', scopes: ['read:page:confluence'] }]);
    }
    assert.equal(target.pathname, '/ex/confluence/fixture-cloud/wiki/api/v2/spaces');
    return Response.json({ results: [{ id: '9', key: 'TEAM' }] });
  };
  const app = createTeamApp({ base: join(dir, 'workspace.sqlite'), background: false, env, send });
  t.after(async () => { await app.close(); await rm(dir, { recursive: true }); });
  await new Promise((resolve, reject) => app.server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + app.server.address().port;
  const register = (login, code) => app.accounts.register({
    login, name: login, password: 'fixture-password', code,
  }, env, () => {});
  const owner = await register('settings-admin', env.ADMIN_INVITE_KEY);
  const peer = await register('settings-pm', app.accounts.invite('team'));
  const headers = account => ({ cookie: 'pm_session=' + account.token });
  const post = (operation, data = {}, account) => fetch(base + '/api/team/' + operation, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(account && headers(account)) },
    body: JSON.stringify(data),
  });

  assert.equal((await post('research-settings')).status, 401);
  const denied = await post('save-research-settings', { scope: 'team', mode: 'lead', role: 'admin' }, peer);
  assert.equal(denied.status, 400);
  assert.match((await denied.json()).error, /администратора/);
  const save = await post('save-research-settings', { scope: 'personal', mode: 'review', ownerId: owner.user.id }, peer);
  assert.deepEqual(await save.json(), { team: 'roles', personal: 'review', effective: 'review' });
  const ownerSettings = await post('research-settings', { ownerId: peer.user.id }, owner);
  assert.deepEqual(await ownerSettings.json(), { team: 'roles', personal: 'inherit', effective: 'roles' });

  const config = { service: 'confluence', url: 'https://tenant.test', scope: 'TEAM', edition: 'cloud' };
  assert.equal((await post('integration-config', config, peer)).status, 400);
  assert.equal((await post('integration-config', config, owner)).status, 200);
  const connect = await post('integration-access', { service: 'confluence', action: 'connect' }, peer);
  assert.equal(connect.status, 200);
  const authorization = new URL((await connect.json()).authorize);
  const callback = new URL(new URL(authorization.searchParams.get('redirect_uri')).pathname, base);
  callback.searchParams.set('state', authorization.searchParams.get('state'));
  callback.searchParams.set('code', 'fixture-code');
  const finish = account => fetch(callback, { headers: headers(account), redirect: 'manual' });
  assert.equal((await finish(owner)).status, 400);
  const completed = await finish(peer);
  assert.equal(completed.status, 303);
  assert.equal(completed.headers.get('location'), '/#settings/personal');
  assert.equal((await finish(peer)).status, 400);

  for (const [account, connected] of [[owner, false], [peer, true]]) {
    const overview = await post('overview', {}, account);
    assert.deepEqual((await overview.json()).integrations.confluence, { ...config, connected });
  }
});
