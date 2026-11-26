import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,readFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {createHash,randomUUID} from 'node:crypto';
import {parse} from 'csv-parse/sync';
import {databasePath,root} from './config.mjs';
import {DAY,instant,parseEvents,kinds} from './import.mjs';
export const hash=value=>createHash('sha256').update(value).digest('hex');
export function name(value,max=180){if(typeof value!=='string'||!value.trim()||value.trim().length>max)throw Error('Проверьте длину текстового поля (1–'+max+').');return value.trim();}
export function openStore(path=databasePath()){
  if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
  const db=new DatabaseSync(path);
  db.exec(`PRAGMA busy_timeout=10000; PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS datasets(id TEXT PRIMARY KEY,name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS versions(id TEXT PRIMARY KEY,dataset TEXT REFERENCES datasets(id),digest TEXT NOT NULL,completed REAL,payload TEXT NOT NULL,created INTEGER NOT NULL,UNIQUE(dataset,digest));
    CREATE TABLE IF NOT EXISTS releases(id TEXT PRIMARY KEY,body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS calculations(id TEXT PRIMARY KEY,release TEXT REFERENCES releases(id),body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reports(release TEXT PRIMARY KEY REFERENCES releases(id),body TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS messages(seq INTEGER PRIMARY KEY,release TEXT REFERENCES releases(id),request TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(release,request));
    CREATE TABLE IF NOT EXISTS boards(release TEXT REFERENCES releases(id),name TEXT NOT NULL,calc TEXT REFERENCES calculations(id),PRIMARY KEY(release,name,calc));
    CREATE TABLE IF NOT EXISTS notes(id TEXT PRIMARY KEY,release TEXT REFERENCES releases(id),body TEXT NOT NULL);`);
  db.exec("CREATE TABLE IF NOT EXISTS report_versions(release TEXT,version TEXT,body TEXT,PRIMARY KEY(release,version)); INSERT OR IGNORE INTO report_versions SELECT release,json_extract(body,'$.version'),body FROM reports WHERE json_extract(body,'$.version') IS NOT NULL;");
  const one=(sql,...args)=>db.prepare(sql).get(...args);
  function tx(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(e){db.exec('ROLLBACK');throw e;}}
  function importCSV(input){
    const payload=parseEvents(input.csv),title=name(input.name||'Набор событий');
    const complete=input.completeThrough?instant(input.completeThrough):null;
    const recorded=input.recordedTypes??[...new Set(payload.events.map(e=>e.event_type))];
    if(!Array.isArray(recorded)||recorded.some(t=>!kinds.includes(t)))throw Error('Неизвестный тип регистрируемого события.');
    payload.recorded=[...new Set([...recorded,...payload.events.map(e=>e.event_type)])].sort();
    const dataset=input.dataset||hash(title).slice(0,20);
    if(input.dataset&&!one('SELECT id FROM datasets WHERE id=?',dataset))throw Error('Неизвестный набор данных.');
    const digest=hash(JSON.stringify([payload,complete]));
    const id=hash(dataset+digest);
    db.prepare('INSERT OR IGNORE INTO datasets VALUES(?,?)').run(dataset,title);
    db.prepare('INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?,?)').run(id,dataset,digest,complete,JSON.stringify(payload),Date.now());
    return {dataset,version:id,count:payload.events.length};
  }
  function create(input,forcedId){
    if(!one('SELECT id FROM datasets WHERE id=?',input.dataset))throw Error('Выберите набор данных.');
    const target=Number(input.target??0);
    if(!Number.isInteger(target)||target<0||target>4)throw Error('Неизвестная целевая метрика.');
    const r={id:forcedId||'R-'+randomUUID().slice(0,8),title:name(input.title),description:name(input.description,1500),launch:instant(input.activatedAt),
      audience:name(input.audience,500),question:name(input.question,500),dataset:input.dataset,target,sourceKey:input.sourceKey?.trim()||'',
      exposure:input.exposure||'checkout_started'};
    if(!kinds.includes(r.exposure))throw Error('Неизвестное событие показа.');
    db.prepare('INSERT INTO releases VALUES(?,?)').run(r.id,JSON.stringify(r));return r;
  }
  if(!one('SELECT id FROM releases LIMIT 1'))tx(()=>{
    if(one('SELECT id FROM releases LIMIT 1'))return;
    const seed=importCSV({name:'Демонстрационные события',csv:readFileSync(join(root,'demo/events.csv'),'utf8'),completeThrough:'2026-11-16T07:00:00Z'});
    const rows=parse(readFileSync(join(root,'demo/releases.csv'),'utf8'),{columns:true,trim:true});
    for(const row of rows){const invoice=row.release_id==='R-002';create({title:row.title,description:invoice?'Добавили скачивание счёта на странице заказа.':'Обновили форму оформления заказа.',
      audience:invoice?'Компании с оплатой по счёту':'Все компании, начавшие оформление',question:invoice?'Стали ли чаще оплачивать счета за семь суток?':'Почему изменилась конверсия в оплату?',
      activatedAt:row.activated_at,sourceKey:row.release_id,exposure:row.exposure_event,target:invoice?1:0,dataset:seed.dataset},row.release_id);}
  });
  function release(id){const r=one('SELECT body FROM releases WHERE id=?',id);if(!r)throw Error('Релиз не найден.');return JSON.parse(r.body);}
  const cache=new Map();
  function version(dataset,id){
    const v=id?one('SELECT id,completed FROM versions WHERE dataset=? AND id=?',dataset,id):one('SELECT id,completed FROM versions WHERE dataset=? ORDER BY rowid DESC LIMIT 1',dataset);
    if(!v)throw Error('Версия данных не найдена.');
    if(!cache.has(v.id)){if(cache.size>=8)cache.delete(cache.keys().next().value);cache.set(v.id,JSON.parse(one('SELECT payload FROM versions WHERE id=?',v.id).payload));}
    return {...v,...cache.get(v.id)};
  }
  function calculation(id,body){
    if(body.op!=='build_chart')return {id,...body};
    const completed=one('SELECT completed FROM versions WHERE id=?',body.context.version)?.completed;
    const endDay=body.periods?.to??7;
    const ready=body.context.day>=endDay&&completed!=null&&completed>=body.launch+endDay*DAY;
    return {id,...body,result:{...body.result,status:ready?'ready':'preliminary'}};
  }
  function saveCalc(rel,body){const raw=JSON.stringify(body),id=hash(rel+raw);db.prepare('INSERT OR IGNORE INTO calculations VALUES(?,?,?)').run(id,rel,raw);return calculation(id,body);}
  function getCalc(id){const row=one('SELECT body FROM calculations WHERE id=?',id);if(!row)throw Error('Расчёт не найден.');return calculation(id,JSON.parse(row.body));}
  return {db,one,tx,release,version,create:input=>tx(()=>create(input)),importCSV:input=>tx(()=>importCSV(input)),saveCalc,getCalc,
    releases:()=>db.prepare('SELECT body FROM releases').all().map(r=>JSON.parse(r.body)).sort((a,b)=>b.launch-a.launch),
    datasets:()=>db.prepare('SELECT id,name FROM datasets ORDER BY name').all(),
    messages:id=>db.prepare('SELECT body FROM messages WHERE release=? ORDER BY seq').all(id).map(r=>JSON.parse(r.body)),
    addMessage:(id,request,body)=>db.prepare('INSERT INTO messages(release,request,body) VALUES(?,?,?)').run(id,request,JSON.stringify(body)),
    boards:id=>db.prepare('SELECT name,calc FROM boards WHERE release=? ORDER BY rowid').all(id),close:()=>db.close()};
}
