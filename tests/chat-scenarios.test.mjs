import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { chatScenarios, loadScenarioDraft, selectScenario, serializeScenarioDraft } from '../web/chat-scenarios.ts';

const spec = readFileSync(new URL('../docs/superpowers/specs/2026-11-27-chat-scenarios-design.md', import.meta.url), 'utf8');
const approved = [...spec.matchAll(/^\| ([^|]+?) \| ([^|]+?) \|\s*$/gm)].slice(1)
  .map(([, label, prompt]) => ({ label, prompt }));
const empty = {text: '', scenarioId: null};
const detail = 'Только Kaspersky, мобильные, октябрь';

test('each of the five menu choices inserts its approved editable prompt', () => {
  assert.equal(approved.length, 5);
  assert.deepEqual(chatScenarios.map(({label, prompt}) => ({label, prompt})), approved);
  assert.equal(new Set(chatScenarios.map(s => s.id)).size, 5);
  for (const {id, prompt} of chatScenarios) assert.deepEqual(selectScenario(empty, id), {text: prompt, scenarioId: id});
});

test('switching scenarios keeps only the latest prompt and one copy of the personal draft', () => {
  const [first, second, third] = chatScenarios;
  let draft = selectScenario({text: detail, scenarioId: null}, first.id);
  draft = selectScenario(draft, second.id);
  draft = selectScenario(draft, third.id);
  assert.equal(draft.text, third.prompt + '\n\n' + detail);
  assert.deepEqual(selectScenario(draft, third.id), draft);
  const plain = selectScenario(empty, first.id);
  assert.equal(selectScenario(plain, second.id).text, second.prompt);
  assert.equal(selectScenario({...plain, text: plain.text + ' ' + detail}, second.id).text.trimEnd(),
    second.prompt + '\n\n ' + detail);
});

test('reselecting keeps a rewritten prompt and switching preserves the whole rewrite', () => {
  const [first, second] = chatScenarios;
  const edited = {scenarioId: first.id, text: first.prompt.replace('Store', 'Softline Store')};
  assert.deepEqual(selectScenario(edited, first.id), edited);
  assert.equal(selectScenario(edited, second.id).text, second.prompt + '\n\n' + edited.text);
  assert.equal(selectScenario({scenarioId:first.id, text:''}, first.id).text, first.prompt);
});

test('draft storage restores edited scenarios, original plain text, and interrupted sends', () => {
  const [first, second] = chatScenarios;
  const draft = selectScenario({text: detail, scenarioId: null}, first.id);
  assert.deepEqual(selectScenario(loadScenarioDraft(serializeScenarioDraft(draft), ''), second.id),
    {text: second.prompt + '\n\n' + detail, scenarioId: second.id});
  const old = JSON.stringify({text: 'собственный JSON', scenarioId:first.id});
  assert.deepEqual(loadScenarioDraft(old, 'pending'), {text:old, scenarioId:null});
  assert.deepEqual(loadScenarioDraft(null, detail), {text:detail, scenarioId:null});
});
