import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Readable } from 'node:stream';
import { localData } from './data-profile.mjs';
import { boundedBody, parseWeb } from './web-search.mjs';

const reserved = new BlockList();
for (const [address, prefix] of [
  ['0.0.0.0',8],['10.0.0.0',8],['100.64.0.0',10],['127.0.0.0',8],['169.254.0.0',16],
  ['172.16.0.0',12],['192.0.0.0',24],['192.0.2.0',24],['192.88.99.0',24],['192.168.0.0',16],
  ['198.18.0.0',15],['198.51.100.0',24],['203.0.113.0',24],['224.0.0.0',3],
  ['2001::',23],['2001:db8::',32],['2002::',16],['3fff::',20],
]) reserved.addSubnet(address,prefix,isIP(address)===6?'ipv6':'ipv4');

function publicAddress({address}) {
  const type=isIP(address);
  return type === 4 ? !reserved.check(address,'ipv4')
    : type === 6 && /^[23]/i.test(address) && !reserved.check(address,'ipv6');
}

export function responseFromMessage(message) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (value !== undefined) headers.set(name, String(value));
  }
  const init = { status: message.statusCode, headers };
  if ([204, 205, 304].includes(message.statusCode)) {
    message.resume();
    return new Response(null, init);
  }
  return new Response(Readable.toWeb(message), init);
}

// Keep HTTP Host and TLS server name tied to the URL, while connecting only to the validated address.
function pinnedRequest(url, address, signal) {
  const client=url.protocol==='https:'?https:http;
  return new Promise((resolve,reject)=>{
    const req=client.get(url,{signal,agent:false,autoSelectFamily:false,family:address.family,
      headers:{Accept:'text/html,application/xhtml+xml', 'Accept-Encoding':'identity'},
      lookup:(_host,options,done)=>options.all?done(null,[address]):done(null,address.address,address.family),
    },res=>{
      try { resolve(responseFromMessage(res)); }
      catch (error) { res.destroy(); reject(error); }
    });
    req.on('upgrade',(_response,socket)=>{socket.destroy();reject(Error('Протокол страницы не поддерживается.'));});
    req.on('error',reject);
  });
}

export async function fetchPublicHtml(url,signal,{resolveHost=lookup,request=pinnedRequest}={}) {
    if (!['http:','https:'].includes(url.protocol) || url.username || url.password || url.port || url.href.length>2048)
      throw Error('Укажите публичный HTTP(S)-адрес без учётных данных и нестандартного порта.');
    const host=url.hostname.replace(/^\[|\]$/g,'');
    if (/^(localhost|.*\.localhost)\.?$/i.test(host) || (!isIP(host) && !host.includes('.')))
      throw Error('Разрешены только публичные адреса.');
    const addresses=isIP(host) ? [{address:host,family:isIP(host)}] : await Promise.race([
      resolveHost(host,{all:true,verbatim:true}), new Promise((_,reject)=>signal.addEventListener('abort',()=>reject(signal.reason),{once:true})),
    ]);
    if (!addresses.length || !addresses.every(publicAddress)) throw Error('Разрешены только публичные адреса.');
    return request(url,addresses[0],signal);
}

export async function readPublicPage(value,env=process.env,{resolveHost=lookup,request=pinnedRequest}={}) {
  if (localData(env)) throw Error('В локальном профиле чтение публичных страниц отключено.');
  const signal=AbortSignal.timeout(12000);
  const original=new URL(value);
  let url=original;
  for (let hop=0;hop<=4;hop++) {
    const response=await fetchPublicHtml(url,signal,{resolveHost,request});
    if (response.status>=300 && response.status<400) {
      await response.body?.cancel();
      const target=response.headers.get('location');
      if (!target || hop===4) throw Error('Не удалось перейти по перенаправлению страницы.');
      url=new URL(target,url); continue;
    }
    const type=response.headers.get('content-type')||'';
    if (!response.ok || !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(type)) {
      await response.body?.cancel();
      throw Error(!response.ok?'Страница вернула HTTP '+response.status+'.':'Поддерживаются публичные HTML-страницы.');
    }
    const bytes=await boundedBody(response,1_000_000);
    const charset=/charset\s*=\s*["']?([\w-]+)/i.exec(type+' '+bytes.subarray(0,2500).toString('ascii'))?.[1];
    const {title,text}=await parseWeb('page',Buffer.from(new TextDecoder(charset||'utf-8').decode(bytes)),env);
    if (!text) throw Error('На странице нет доступного текста для проверки.');
    return {originalUrl:original.href,url:url.href,title:title||url.hostname,text,checkedAt:new Date().toISOString()};
  }
}
