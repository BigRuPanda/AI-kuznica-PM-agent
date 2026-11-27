import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { createTeamApp } from '../server/team-http.mjs';
import { configure, personalConnection } from '../server/tracker-connections.mjs';
import { setting, setSetting } from '../server/evidence.mjs';
import { loadPilotRecovery, seedPilotSignal } from '../scripts/pilot-acceptance.mjs';
import { pilotMetrikaEnv, pilotMetrikaTransport } from './metrika-replay.mjs';

const dir = fileURLToPath(new URL('../var/pilot/', import.meta.url));
const access = JSON.parse(await readFile(join(dir, 'access.json'), 'utf8'));
setDefaultCACertificates([...getCACertificates('default'), await readFile(join(dir, 'redmine-ca.pem'), 'utf8')]);
const browserCheck = process.argv[2] === '--browser-check';
if (process.argv.length > (browserCheck ? 3 : 2)) throw Error('Поддерживается только --browser-check.');
const run = randomUUID();
const port = browserCheck ? 18091 : 18090;
const base = browserCheck ? await mkdtemp(join(tmpdir(),'softline-pilot-browser-')) : join(dir,'workspace');
const product = browserCheck ? 'Пилотный ЛК ' + run.slice(0,8) : 'Пилотный ЛК';
const baseEnv = {
  APP_BASE_URL: 'http://127.0.0.1:' + port, DATA_PROFILE: 'local',
  LOCAL_HTTP_ORIGINS: 'https://localhost:18443', LOCAL_SMTP_TARGET: '127.0.0.1:11025',
  INTEGRATION_KEY: access.integrationKey, ADMIN_INVITE_KEY: randomBytes(32).toString('hex'),
  PYTHON_BIN: process.env.PYTHON_BIN || (process.platform === 'win32' ? 'py' : 'python3'),
  SMTP_HOST: '127.0.0.1', SMTP_PORT: '11025', SMTP_TLS: 'plain', SMTP_FROM: 'agent@pilot.invalid',
  SMTP_TO: browserCheck ? 'pm-'+run+'@pilot.invalid' : 'product@pilot.invalid', NOTIFICATIONS_ENABLED: 'true',
  NOTIFICATION_CHANNELS: 'smtp',
};
const env = pilotMetrikaEnv(baseEnv, {product});
const send = pilotMetrikaTransport(fetch);
const app = createTeamApp({base: join(base,'releases.sqlite'), env, send});
try {
  const store = app.space('team');
  Object.defineProperty(env, 'METRIKA_REPORTS_JSON', {enumerable:true, get() {
    const through = setting(store.db, 'pilot_replay_through', '2026-08-16');
    return pilotMetrikaEnv(baseEnv, {product, through}).METRIKA_REPORTS_JSON;
  }});
  for (const role of ['writer','reader']) {
    const login = 'pilot-' + role;
    const password = access[role + 'Password'];
    const exists = app.accounts.db.prepare('SELECT id FROM users WHERE login=?').get(login);
    const user = exists ? app.accounts.publicUser(exists.id) : (await app.accounts.register({
      login, password, name: role === 'writer' ? 'Продакт пилота' : 'Коллега пилота',
      code: role === 'writer' ? env.ADMIN_INVITE_KEY : app.accounts.invite('team'),
    }, env)).user;
    if (role === 'writer') configure(store.db, user, {service:'redmine', url:access.url, scope:access.scope, originFieldId:access.originFieldId});
    await personalConnection(store.db, user, {service:'redmine', action:'connect', token:access[role+'Key']}, env, send);
  }
  if (!setting(store.db, 'pilot_seed_with_journal', false)) {
    const {caseId} = await seedPilotSignal(store, {pythonBin:env.PYTHON_BIN, product});
    setSetting(store.db, 'pilot_seed_v1', caseId);
    setSetting(store.db, 'pilot_seed_with_journal', true);
  }
  await new Promise((ok,fail) => app.server.once('error',fail).listen(port,'127.0.0.1',ok));
  const caseUrl = env.APP_BASE_URL + '/#case/' + setting(store.db,'pilot_seed_v1');
  if (browserCheck) {
    const { verifyBrowser } = await import('./verify-browser.mjs');
    await verifyBrowser(caseUrl, env.SMTP_TO, access, product, async () => {
      await loadPilotRecovery(store, {product});
      setSetting(store.db, 'pilot_replay_through', '2026-09-13');
    });
  } else {
    console.log('Softline PM · ' + caseUrl);
    console.log('Почта пилота · http://127.0.0.1:18025');
  }
} catch (e) {
  if (!browserCheck) await app.close();
  throw e;
} finally {
  if (browserCheck) {
    await app.close();
    await rm(base, {recursive:true, force:true, maxRetries:3});
  }
}
if (!browserCheck) for (const signal of ['SIGTERM','SIGINT']) process.once(signal, () => app.close().then(() => process.exit(0)));
