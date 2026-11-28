import { checkModelTransport } from './data-profile.mjs';
import {invalidResponse,modelAbortFailure,modelHttpFailure,normalizeModelReply,readModelResponse} from './model-response.mjs';
import {GoogleAuth} from 'google-auth-library';
import {randomUUID} from 'node:crypto';

const auth=new GoogleAuth({scopes:['https://www.googleapis.com/auth/cloud-platform']});
const object=value=>value!==null && typeof value==='object' && !Array.isArray(value);
export function geminiRequest(messages,tools,choice){
  const contents=[],systems=[],calls=new Map();
  for(const m of messages){
    if(m.role==='system'){systems.push({text:m.content});continue;}
    if(m.role==='assistant'){
      const parts=m.googleParts||[{text:m.content||''}];
      const original=parts.filter(p=>p.functionCall);
      (m.tool_calls||[]).forEach((c,i)=>calls.set(c.id,original[i]?.functionCall||{name:c.function.name}));
      contents.push({role:'model',parts});continue;
    }
    if(m.role==='tool'){
      const call=calls.get(m.tool_call_id);
      if(!call)throw Error('Не удалось связать ответ инструмента с запросом Gemini.');
      const response={functionResponse:{name:call.name,...(call.id?{id:call.id}:{}),response:{result:JSON.parse(m.content)}}};
      const last=contents.at(-1);
      if(last?.role==='user'&&last.parts[0].functionResponse)last.parts.push(response);
      else contents.push({role:'user',parts:[response]});
      continue;
    }
    contents.push({role:'user',parts:[{text:m.content}]});
  }
  return {contents,...(systems.length?{systemInstruction:{parts:systems}}:{}),
    ...(tools.length ? {tools:[{functionDeclarations:tools.map(({function:f})=>({name:f.name,description:f.description,parametersJsonSchema:f.parameters}))}],
      toolConfig:{functionCallingConfig:{mode:choice==='auto'?'AUTO':'ANY',...(typeof choice==='object'?{allowedFunctionNames:[choice.function.name]}:{})}}} : {})};
}
export async function geminiCall(env,messages,tools,choice,send,credentials=auth,limits={}){
  checkModelTransport(env);
  const developer=env.LLM_BACKEND==='gemini';
  const model=env.LLM_MODEL||(developer?'gemini-3.5-flash':'gemini-3.5-flash-lite'),location=env.GOOGLE_CLOUD_LOCATION||'global';
  if(!/^[\w.-]+$/.test(model)||!/^[a-z0-9-]+$/.test(location))throw Error('Проверьте модель и регион Google Cloud.');
  const express=env.LLM_BACKEND==='vertex-express',project=env.GOOGLE_CLOUD_PROJECT;
  const host=express||location==='global'?'aiplatform.googleapis.com':location+'-aiplatform.googleapis.com';
  const headers={'Content-Type':'application/json'};
  let prefix='';
  if(express||developer){
    if(!env.LLM_API_KEY)throw Error('Введите ключ '+(developer?'Gemini API':'Google Cloud Express')+' в LLM_API_KEY в корневом .env.');
    headers['x-goog-api-key']=env.LLM_API_KEY;
  }else{
    if(!project||!/^[a-zA-Z0-9.:-]+$/.test(project))throw Error('Укажите GOOGLE_CLOUD_PROJECT в .env.');
    prefix='projects/'+encodeURIComponent(project)+'/locations/'+location+'/';
    try{const tokenHeaders=await credentials.getRequestHeaders();
      Object.assign(headers,Object.fromEntries(tokenHeaders));
    }catch{throw Error('Google ADC недоступны. Выполните gcloud auth application-default login или задайте GOOGLE_APPLICATION_CREDENTIALS в .env.');}
  }
  const url=developer?'https://generativelanguage.googleapis.com/v1beta/models/'+model+':generateContent':
    'https://'+host+'/v1/'+prefix+'publishers/google/models/'+model+':generateContent';
  const request=geminiRequest(messages,tools,choice);
  if(limits.maxTokens)request.generationConfig={maxOutputTokens:limits.maxTokens};
  const body=JSON.stringify(request);
  let res;
  const timeoutSignal = AbortSignal.timeout(limits.timeout ?? 60000);
  const signal = limits.signal ? AbortSignal.any([timeoutSignal, limits.signal]) : timeoutSignal;
  try {
    signal.throwIfAborted();
    res = await send(url, {method:'POST', headers, redirect:'error', signal, body});
  } catch (error) {
    throw modelAbortFailure(error, signal, limits.signal) ||
      Object.assign(Error('Не удалось связаться с Google Cloud.'), {retryable:true});
  }
  if (!res.ok) {
    const hint = {400:'Проверьте параметры модели и тип ключа.',401:'Проверьте аутентификацию.',
      403:developer?'Проверьте доступ ключа к Gemini API и модели.':'Проверьте биллинг, включение API и право aiplatform.endpoints.predict.',
      404:'Проверьте доступность ID модели.',429:'Исчерпана квота запросов.'}[res.status] || 'Повторите запрос позже.';
    throw await modelHttpFailure(res, signal, limits.signal, 'Google вернул HTTP '+res.status+'. '+hint);
  }
  const response = await readModelResponse(res, signal, limits.signal);
  const candidate = response?.candidates?.[0];
  const nativeFinish = candidate?.finishReason;
  const blocked = response?.promptFeedback?.blockReason ||
    ['SAFETY','RECITATION','BLOCKLIST','PROHIBITED_CONTENT','SPII','IMAGE_SAFETY','IMAGE_PROHIBITED_CONTENT'].includes(nativeFinish);
  const finishReason = blocked ? 'content_filter' : nativeFinish === 'STOP' ? 'stop' : nativeFinish === 'MAX_TOKENS' ? 'length' : null;
  if (!finishReason && nativeFinish != null && nativeFinish !== 'FINISH_REASON_UNSPECIFIED')
    throw invalidResponse('Gemini не завершил текст или вызов инструмента.');
  const parts = candidate?.content?.parts ?? [];
  if (!Array.isArray(parts) || parts.some(part=>!object(part) ||
      (part.text != null && typeof part.text!=='string') ||
      (part.functionCall != null && (!object(part.functionCall) ||
        part.functionCall.args != null && !object(part.functionCall.args)))))
    throw invalidResponse('Gemini вернул часть ответа в неизвестном формате.',finishReason);
  const input = response?.usageMetadata?.promptTokenCount;
  const total = response?.usageMetadata?.totalTokenCount;
  // Gemini may split a word across adjacent parts. Whitespace belongs to the text itself.
  return normalizeModelReply({
    role:'assistant',
    content:parts.filter(p=>p.text&&!p.thought).map(p=>p.text).join(''),
    tool_calls:parts.filter(p=>p.functionCall).map(p=>({
      id:p.functionCall.id??randomUUID(), type:'function',
      function:{name:p.functionCall.name,arguments:JSON.stringify(p.functionCall.args||{})},
    })),
  }, {finishReason, usage:{input,output:total!=null?total-(input||0):undefined}, googleParts:parts});
}
