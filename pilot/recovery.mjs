import { access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { openStore } from '../server/store.mjs';
import { initEvidence, setting, setSetting, getCase, effect } from '../server/evidence.mjs';
import { loadPilotRecovery } from '../scripts/pilot-acceptance.mjs';

const path = fileURLToPath(new URL('../var/pilot/workspace/releases.sqlite', import.meta.url));
await access(path);
const store = openStore(path);
try {
  initEvidence(store.db);
  const caseId = setting(store.db, 'pilot_seed_v1', null);
  if (!caseId) throw Error('Сначала запустите pilot:start.');
  const incident = getCase(store.db, caseId);
  if (!incident.body.watch) throw Error('Сначала назначьте проверку эффекта релиза в разборе.');
  const update = await loadPilotRecovery(store);
  setSetting(store.db, 'pilot_replay_through', '2026-09-13');
  const result = effect(store.db, getCase(store.db, caseId));
  console.log(JSON.stringify({added: update.inserted, caseId, state:result.state, actual:result.actual, unit:result.unit}, null, 2));
} finally {
  store.close();
}
