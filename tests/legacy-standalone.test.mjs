import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { openStore } from '../server/store.mjs';

const archiveSha = 'a'.repeat(64);
const entrypoint = fileURLToPath(new URL('../server/http.mjs', import.meta.url));
const tableCounts = db => Object.fromEntries(['releases', 'datasets', 'versions'].map(table =>
  [table, db.prepare('SELECT count(*) AS count FROM ' + table).get().count],
));

for (const [name, sha] of [
  ['archived', archiveSha],
  ['standard', ''],
]) {
  test('standalone HTTP opens ' + name + ' installations with an empty release journal', { timeout: 15000 }, async t => {
    const directory = await mkdtemp(join(tmpdir(), 'pm-legacy-http-'));
    const file = join(directory, 'case.sqlite');
    const child = spawn(process.execPath, [entrypoint], {
      env: { ...process.env, DATABASE_URL: file, PORT: '0', DATA_PROFILE: 'local', SOURCE_ARCHIVE_SHA256: sha },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const closed = once(child, 'close');
    t.after(async () => {
      try {
        child.kill();
        await closed;
      } finally {
        await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    });
    let stderr = '';
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });
    const listen = new Promise((resolve, reject) => {
      let stdout = '';
      child.stdout.setEncoding('utf8').on('data', chunk => {
        stdout += chunk;
        if (stdout.includes('http://127.0.0.1:')) resolve();
      });
      child.once('error', reject);
      child.once('close', code => reject(Error('Standalone HTTP stopped with ' + code + ': ' + stderr)));
    });
    await listen;
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      assert.deepEqual(tableCounts(db), { releases: 0, datasets: 0, versions: 0 });
    } finally {
      db.close();
    }
  });
}

test('opening the release store preserves imported data', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'pm-release-import-'));
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const file = join(directory, 'releases.sqlite');
  const first = openStore(file);
  const title = 'Импортированный релиз';
  try {
    const { dataset } = first.importCSV({ name: 'События заказа', csv: [
      'company_id,order_id,customer_segment,purchase_type,event_at,event_type',
      'C1,O1,new,purchase,2026-10-05T07:00:00Z,checkout_started',
    ].join('\n') });
    first.create({ title, dataset, activatedAt: '2026-10-05T07:00:00Z',
      description: 'Изменение оформления', audience: 'Новые клиенты', question: 'Как меняется оформление?' });
  } finally {
    first.close();
  }
  const reopened = openStore(file);
  try {
    assert.deepEqual(reopened.releases().map(release => release.title), [title]);
    assert.deepEqual(tableCounts(reopened.db), { releases: 1, datasets: 1, versions: 1 });
  } finally {
    reopened.close();
  }
});
