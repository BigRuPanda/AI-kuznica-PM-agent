import { join } from 'node:path';
import { createTeamApp } from '../server/team-http.mjs';
import { evaluationCase } from '../scripts/eval-agent.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { createThread } from '../server/workbench.mjs';
import { materialForResult, saveMaterial } from '../server/materials.mjs';
import { setSetting } from '../server/evidence.mjs';

export const fixtureEnv = { ADMIN_INVITE_KEY: 'fixture-admin', DEMO_INVITE_KEY: 'fixture-judge' };
export async function seedWorkspace(dir) {
  const app = createTeamApp({ base: join(dir, 'releases.sqlite'), env: fixtureEnv, background: false });
  try {
    const register = async (login, code) => (await app.accounts.register(
      { login, name: login, password: 'fixture-password', code }, fixtureEnv, (space) => app.space(space)
    )).user;
    const admin = await register('fixture-admin', fixtureEnv.ADMIN_INVITE_KEY);
    await register('fixture-member', app.accounts.invite('team'));
    const judge = await register('fixture-judge', fixtureEnv.DEMO_INVITE_KEY);
    evaluationCase(app.space(judge.space), judge);
    const store = app.space('team');
    const { caseId, selection } = evaluationCase(store, admin);
    const op = (name, body) => workspaceOperation(store, admin, name, body);
    const calc = selection.calcId;
    const range = op('range_compare', { selection });
    const thread = createThread(store.db, admin, 'Исходная переписка');
    const chart = materialForResult(store.db, admin, thread, { calc, cards: ['trend'], title: 'Исходный график' });
    const report = saveMaterial(store.db, thread, { kind: 'report', title: 'Исходный отчёт', product: 'Kaspersky', children: [chart] });
    store.db.prepare('INSERT INTO case_materials VALUES(?,?,?)').run(admin.id, caseId, report.id);
    store.db.prepare("INSERT INTO chat_items(thread,author,role,body,created) VALUES(?,?,'assistant',?,?)")
      .run(thread, 'Помощник', JSON.stringify({ text: 'Сохранённый ответ', materials: [report] }), 1);
    const draft = await op('draft', { caseId, title: 'Исходный черновик', description: 'Проверить данные' });
    op('publish', { caseId, calc, cards: ['summary','trend'], conclusion: 'Проверка перехода' });
    setSetting(store.db, 'demo_versions', store.db.prepare('SELECT version FROM documents').all().map(v => v.version));
    // Reproduce the pre-migration database for a fresh acceptance run.
    store.db.prepare("DELETE FROM settings WHERE key='personal_material_access_v1'").run();
    return { caseId, thread, calc, range: range.id, report: report.id, chart: chart.id, draft: draft.id,
      summary: op('calc', {id:calc}).summary, periods: range.periods };
  } finally {
    await app.close();
  }
}
