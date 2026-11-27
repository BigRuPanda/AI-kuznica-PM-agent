import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const paths = ['.env.example','Caddyfile','compose.yaml','Dockerfile','package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','telegram.mjs'];
async function collect(dir) {
  for (const entry of await readdir(join(root,dir), {withFileTypes:true})) {
    if (entry.name === '__pycache__') continue;
    const name = dir + '/' + entry.name;
    if (entry.isDirectory()) await collect(name);
    else if (entry.isFile()) paths.push(name);
  }
}
for (const dir of ['server','web','scripts','pilot','tests','demo','prototype']) await collect(dir);
const digest = createHash('sha256');
for (const name of paths.sort()) {
  const raw = await readFile(join(root,name));
  const content = /\.(png|jpg|woff2?|ico)$/i.test(name) ? raw : raw.toString('utf8').replace(/\r\n/g,'\n');
  digest.update(name + '\0' + createHash('sha256').update(content).digest('hex') + '\n');
}
console.log(digest.digest('hex'));
