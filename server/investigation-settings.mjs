import { setting, setSetting } from './evidence.mjs';

const teamKey = 'research_mode/team';
const personalKey = ownerId => 'research_mode/user/' + ownerId;
const teamModes = ['lead', 'review', 'roles'];

export function readInvestigationLimit(teamDb) {
  return setting(teamDb, 'investigation_concurrency', 10);
}

export function saveInvestigationLimit(teamDb, user, limit) {
  if (user.space !== 'team' || user.role !== 'admin') throw Error('Требуются права администратора команды.');
  if (!Number.isSafeInteger(limit) || limit <= 0) throw Error('Введите целое положительное число.');
  setSetting(teamDb,'investigation_concurrency',limit);
  return limit;
}

function readModes(db, ownerId) {
  const team = setting(db, teamKey, 'roles');
  const personal = ownerId == null ? 'inherit' : setting(db, personalKey(ownerId), 'inherit');
  return { team, personal, effective: personal === 'inherit' ? team : personal };
}

export function effectiveResearchMode(db, ownerId = null) {
  return readModes(db, ownerId).effective;
}

export function researchSettings(db, user) {
  return readModes(db, user.id);
}

export function saveResearchSettings(db, user, { scope, mode }) {
  if (scope !== 'personal' && scope !== 'team') throw Error('Выберите командные или личные настройки');
  if (scope === 'team' && user.role !== 'admin') throw Error('Требуются права администратора');
  if (!teamModes.includes(mode) && !(scope === 'personal' && mode === 'inherit'))
    throw Error('Выберите режим исследования');
  setSetting(db, scope === 'team' ? teamKey : personalKey(user.id), mode);
  return researchSettings(db, user);
}
