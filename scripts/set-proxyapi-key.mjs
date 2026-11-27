import { randomUUID } from 'node:crypto';
import { readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { Writable } from 'node:stream';

async function setKey() {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw Error('Откройте терминал в папке проекта и выполните pnpm model:key.');
  const file = new URL('../.env', import.meta.url);
  const temp = new URL('../.env.' + randomUUID(), import.meta.url);
  const silent = new Writable({ write(_chunk, _encoding, done) { done(); } });
  const prompt = createInterface({ input: process.stdin, output: silent, terminal: true, historySize: 0 });
  const cancel = new AbortController();
  prompt.on('SIGINT', () => cancel.abort());
  let key;
  try {
    process.stdout.write('Ключ ProxyAPI для проекта (ввод скрыт). Вставьте токен и нажмите Enter: ');
    key = (await prompt.question('', { signal: cancel.signal })).trim();
  } finally {
    prompt.close();
    process.stdout.write('\n');
  }
  if (!/^[A-Za-z0-9._~+/-]+=*$/.test(key)) throw Error('Введите действительный токен ProxyAPI.');
  const original = await readFile(file, 'utf8');
  const line = /^([ \t]*(?:export[ \t]+)?PROXYAPI_API_KEY[ \t]*=)[^\r\n]*/gm;
  const entry = 'PROXYAPI_API_KEY=' + key;
  const eol = original.includes('\r\n') ? '\r\n' : '\n';
  const content = original.match(line)
    ? original.replace(line, () => entry)
    : original + (original.endsWith('\n') ? '' : eol) + entry + eol;
  try {
    await writeFile(temp, content, { flag: 'wx', mode: 0o600 });
    await rename(temp, file);
  } finally {
    await unlink(temp).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  console.log('Ключ сохранён в локальном .env.');
}

try {
  await setKey();
} catch (e) {
  console.error(e.name === 'AbortError' ? 'Ввод отменён.' : e.code === 'ENOENT' ? 'Сначала выполните pnpm run setup.' : e.message);
  process.exitCode = 1;
}
