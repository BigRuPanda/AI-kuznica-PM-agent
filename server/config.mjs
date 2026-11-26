import {loadEnvFile} from 'node:process';
import {fileURLToPath} from 'node:url';
import {resolve} from 'node:path';
import {readFileSync,statSync} from 'node:fs';
import {parseEnv} from 'node:util';
export const root=fileURLToPath(new URL('../',import.meta.url));
const startupEnv={...process.env};
try {loadEnvFile(resolve(root,'.env'));} catch(e){if(e.code!=='ENOENT')throw e;}
let lastCheck=0,lastStamp='',settings={...process.env};
// Pick up a newly entered local key without restarting or disclosing it to the browser.
export const liveModelEnv=new Proxy({}, {get(_target,key){
  if(Date.now()-lastCheck>500){
    lastCheck=Date.now();const path=resolve(root,'.env');
    try{
      const f=statSync(path),stamp=f.mtimeMs+'/'+f.size;
      if(stamp!==lastStamp){settings={...parseEnv(readFileSync(path,'utf8')),...startupEnv};lastStamp=stamp;}
    }catch(e){if(e.code!=='ENOENT')throw e;settings=startupEnv;lastStamp='';}
  }
  return settings[key];
}});
export const profiles=['Анна','Дмитрий'];
export function databasePath(){
  const url=process.env.DATABASE_URL||'var/releases.sqlite';
  if(url===':memory:')return url;
  if(url.startsWith('file://'))return fileURLToPath(url);
  if(/^\w+:\/\//.test(url))throw Error('DATABASE_URL должен указывать на локальный SQLite-файл.');
  return resolve(root,url.replace(/^sqlite:/,''));
}
