import assert from 'node:assert/strict';
import test from 'node:test';
import { readPublicPage } from '../server/public-page.mjs';

const resolveHost = async () => [{address:'93.184.216.34',family:4}];
const html = text => new Response('<title>Фонд</title><p>'+text+'</p>',{headers:{'content-type':'text/html'}});
test('public reader pins resolution and extracts actual visible evidence', async () => {
  for (const fact of ['Экспозиция открыта по пятницам.','Экспозиция закрыта по пятницам.']) {
    const page = await readPublicPage('https://museum.example/',{}, {resolveHost,request:async (url,address)=>{
      assert.equal(address.address,'93.184.216.34'); return html(fact);
    }});
    assert.equal(page.title,'Фонд'); assert.ok(page.text.includes(fact)); assert.ok(page.checkedAt);
  }
});
test('public reader checks a redirect destination and local mode before sending',async ()=>{
  let calls=0;
  const options={resolveHost,request:async()=>{calls++;return new Response(null,{status:301,headers:{location:'http://127.0.0.1/private'}})}};
  await assert.rejects(readPublicPage('https://museum.example/',{},options),/публичн/i);
  assert.equal(calls,1);
  await assert.rejects(readPublicPage('https://museum.example/',{DATA_PROFILE:'local'},options),/локальн/i);
  assert.equal(calls,1);
  const redirected=await readPublicPage('https://museum.example/',{}, {resolveHost,request:async url=>url.pathname==='/'
    ?new Response(null,{status:302,headers:{location:'/today'}}):html('Сегодня открыто.')});
  assert.equal(redirected.url,'https://museum.example/today');
  for(const [response,reason] of [[new Response('',{status:403}),/403/],[new Response('x',{headers:{'content-type':'application/pdf'}}),/HTML/]])
    await assert.rejects(readPublicPage('https://museum.example/',{}, {resolveHost,request:async()=>response}),reason);
});