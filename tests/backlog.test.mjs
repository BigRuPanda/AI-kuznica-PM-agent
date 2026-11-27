import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../server/store.mjs';
import { initEvidence, importDocs } from '../server/evidence.mjs';
import { initWorkbench } from '../server/workbench.mjs';
import { workspaceOperation } from '../server/workspace-operations.mjs';
import { teamTools } from '../server/team-mcp.mjs';

test('backlog recommendations use product, measurement limits and the selected cutoff across tools and saved views', async () => {
  const store = openStore(':memory:');
  const user = { id: 'pm', name: 'PM', role: 'admin' };
  const product = 'Kaspersky Endpoint Security';
  const task = (key, title, extra = {}) => ({
    kind: 'backlog', loc: key,
    row: { task_id: key, title, status: 'New', created_date: '2026-10-01', ...extra },
  });
  const facts = [
    { kind: 'dictionary', loc: 'definitions!A9', row: {
      metric_id: 'cfg_add_to_cart_rate', comment: 'Астра: доступно. Kaspersky: событие почти не фиксируется.',
    } },
    { kind: 'releases', loc: 'releases!A9', row: { release_id: 'R-09', release_type: 'major',
      release_date: '2026-10-01', description: 'Конфигуратор Kaspersky', related_task_ids: 'T-03',
      affected_metrics: 'cfg_option_share, family_orders_idx' } },
    task('HR', 'Ошибка экспорта кадрового отчёта', { type: 'Ошибка' }),
    task('T-02', 'Расширить ассортимент Kaspersky'),
    task('T-03', 'Проверить параметры', { linked_metric_ids: 'cfg_option_share' }),
    task('T-08', 'Недочёты передачи событий', { linked_metric_ids: 'cfg_add_to_cart_rate',
      created_date: '2026-10-22', description_short: 'Сбой передачи событий в конфигураторе Kaspersky.' }),
    task('T-22', 'Обновить дизайн корзины Kaspersky', { linked_metric_ids: 'cfg_add_to_cart_rate' }),
    task('T-30', 'Изучить условия продления Kaspersky', { created_date: '2026-10-01', closed_date: '2026-10-24', status: 'Done' }),
  ];
  try {
    initEvidence(store.db);
    initWorkbench(store.db);
    importDocs(store, [{ file: 'test.xlsx', facts }], { notify: false });
    const caseId = workspaceOperation(store, user, 'create-case', {
      title: 'Падение самостоятельных заказов', product, release: 'R-09', metric: 'family_orders_idx',
    }).id;
    const read = (through) => workspaceOperation(store, user, 'view', { caseId, through });
    const before = read('2026-10-21').view;
    const result = read('2026-10-23');
    assert.deepEqual(result.backlog, result.view.backlog);
    assert.deepEqual(result.backlog.map((r) => r.key), ['T-08', 'T-03', 'T-02', 'T-22', 'T-30']);
    assert.equal(result.backlog[0].category, 'Проверить сейчас');
    assert.match(result.backlog[0].reason, /cfg_add_to_cart_rate.*не фиксируется/s);
    assert.match(result.backlog[0].source, /definitions!A9/);
    assert.equal(result.backlog[1].linkedRelease, 'R-09');
    assert.ok(result.backlog.slice(1).every((r) => r.category === 'Требует проверки'));
    assert.ok(!before.backlog.some((r) => r.key === 'T-08'));
    assert.ok(!read('2026-10-25').backlog.some((r) => r.key === 'T-30'));
    const tools = new Map();
    teamTools({ registerTool: (name, _, fn) => tools.set(name, fn) }, store, user);
    const toolResult = await tools.get('view')({ caseId, through: '2026-10-23' });
    assert.deepEqual(JSON.parse(toolResult.content[0].text).backlog, result.backlog);
    importDocs(store, [{ file: 'update.xlsx', facts: [task('T-08', 'Отозвано', { status: 'Closed' })] }]);
    assert.ok(!read('2026-10-23').backlog.some((r) => r.key === 'T-08'));
    assert.deepEqual(workspaceOperation(store, user, 'calc', { id: result.view.id }).backlog, result.backlog);
  } finally {
    store.close();
  }
});
