import { z } from 'zod';
import { digest, getCase } from './evidence.mjs';
import { requireActionableRun } from './case-investigations.mjs';
import { targetFor } from './tracker-connections.mjs';
import { prepareTracker } from './tracker-workflow.mjs';

const id = z.string().min(1).max(200);
const draftInput = z.object({
  caseId: id,
  runId: id,
  plan: z.string().trim().min(1).max(8000),
  outcomes: z.array(z.string().trim().min(1).max(12000)).max(100)
    .refine(items => items.join('\n').length <= 12000, 'Сократите описание результатов проверки'),
  title: z.string().trim().min(1).max(240).optional(),
  selection: z.object({
    key: id, query: z.string().trim().max(400), url: z.string().min(1).max(2048),
  }).strict().optional(),
}).strict();

export async function prepareInvestigationDraft(store, user, input, env = process.env, send = fetch) {
  const {caseId, runId, plan, outcomes, title, selection} = draftInput.parse(input);
  const {db} = store;
  requireActionableRun(db, user, caseId, runId);
  const target = targetFor(db, user, 'redmine', env);
  const description = ['План проверки', plan,
    ...(outcomes.length ? ['', 'Как интерпретировать результат', ...outcomes.map(line => '• ' + line)] : []),
  ].join('\n');
  const issue = selection
    ? {caseId, key:selection.key, comment:description}
    : {caseId, title:title || ('Проверка · ' + getCase(db, caseId).title).slice(0, 240), description};
  const requestId = digest(JSON.stringify(['investigation-draft', user.id, caseId, runId, target, issue]));
  return prepareTracker(store, user, 'issue', issue, env, send, requestId, false, true, {
    runId, target, selection,
  });
}
