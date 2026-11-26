import { readFile, writeFile, appendFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { parseEnv } from 'node:util';
const file = new URL('../.env', import.meta.url),
  example = new URL('../.env.example', import.meta.url);
let original = '';
try {
  original = await readFile(file, 'utf8');
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  await writeFile(file, '', { flag: 'wx', mode: 0o600 });
}
const current = parseEnv(original),
  template = parseEnv(await readFile(example, 'utf8'));
const add = [];
for (const [key, defaultValue] of Object.entries(template)) {
  if (Object.hasOwn(current, key) && (!['ADMIN_INVITE_KEY', 'DEMO_INVITE_KEY'].includes(key) || current[key]))
    continue;
  const value = ['ADMIN_INVITE_KEY', 'DEMO_INVITE_KEY'].includes(key)
    ? randomBytes(24).toString('base64url')
    : defaultValue;
  add.push(key + '=' + JSON.stringify(value));
}
if (add.length) await appendFile(file, '\n' + add.join('\n') + '\n');
console.log(
  'Единый .env готов. Ссылки регистрации: /#join/<ADMIN_INVITE_KEY> и /#join/<DEMO_INVITE_KEY>. Значения доступны в вашем .env.',
);
