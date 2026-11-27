import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const dir = join(root, 'var', 'pilot');
await mkdir(dir, { recursive: true, mode: 0o700 });
const file = join(dir, 'access.json');
let previous = {};
try { previous = JSON.parse(await readFile(file, 'utf8')); }
catch (e) { if (e.code !== 'ENOENT') throw e; }
const token = () => randomBytes(32).toString('base64url');
const writerPassword = previous.writerPassword || token();
const readerPassword = previous.readerPassword || token();

function compose(args, input) {
  const result = spawnSync('docker', ['compose', '-f', 'pilot/compose.yaml', ...args], {
    cwd: root, windowsHide: true, input, encoding: 'utf8', timeout: 120000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw Error(result.stderr.trim() || 'Не удалось подготовить контейнер');
  return result.stdout;
}
compose(['cp', 'https:/data/caddy/pki/authorities/local/root.crt', join(dir, 'redmine-ca.pem')]);
const lines = compose(['exec','-T', 'redmine','bundle','exec','rails','runner','/tmp/softline-pilot-seed.rb'],
  JSON.stringify({writer: writerPassword, reader: readerPassword})).trim().split(/\r?\n/);
const access = JSON.parse(lines.at(-1));
if (!access.writerKey || !access.readerKey || access.url !== 'https://localhost:18443') throw Error('Не удалось получить параметры локального Redmine');
const saved = { ...access, writerPassword, readerPassword, integrationKey: previous.integrationKey || token() };
const tmp = file + '.new';
await writeFile(tmp, JSON.stringify(saved, null, 2) + '\n', {mode: 0o600});
await rename(tmp, file);
console.log('Локальный проект Redmine и две роли готовы. Доступы сохранены в var/pilot/access.json.');
