import {pathToFileURL} from 'node:url';
import '../server/config.mjs';
import {anymodelBaseUrl,apiConfigured,providerCall} from '../server/agent.mjs';
import {readModelResponse} from '../server/model-response.mjs';

const tool={type:'function',function:{name:'check_value',description:'Получить тестовое значение.',parameters:{type:'object',properties:{},required:[]}}};
const valueChoice={type:'function',function:{name:'check_value'}};

function parseJson(content){
  try { return JSON.parse(content); } catch { return null; }
}

function valueCall(reply){
  const call=reply.tool_calls?.[0];
  if(call?.type!=='function' || call.function?.name!=='check_value' || typeof call.id!=='string' || !call.id ||
     typeof call.function.arguments!=='string') throw Error('Модель не вызвала тестовый инструмент.');
  const args=parseJson(call.function.arguments);
  if(!args || typeof args!=='object' || Array.isArray(args)) throw Error('Модель вернула некорректные аргументы инструмента.');
  return call;
}

async function checkAnyModelCatalog(env,send){
  const signal=AbortSignal.timeout(10000);
  let response;
  try {
    response=await send(anymodelBaseUrl+'/models',{method:'GET',redirect:'error',signal,
      headers:{Authorization:'Bearer '+env.ANYMODEL_API_KEY}});
  } catch {
    throw Error('Не удалось загрузить каталог AnyModel. Проверьте подключение.');
  }
  if(!response.ok) throw Error('Каталог AnyModel вернул HTTP '+response.status+'.');
  const models=(await readModelResponse(response,signal))?.data;
  if(!Array.isArray(models) || !models.some(model=>model?.id===env.LLM_MODEL))
    throw Error('В каталоге AnyModel нет модели '+env.LLM_MODEL+'.');
}

export async function checkModel(env=process.env,send=fetch){
  const anymodel=env.LLM_BACKEND==='anymodel';
  const messages=[{role:'user',content:'Вызови check_value, затем верни полученное число цифрами без пояснений.'}];
  if(anymodel && apiConfigured(env)){
    await checkAnyModelCatalog(env,send);
    valueCall(await providerCall(env,messages,[tool],'required',send));
  }
  const first=await providerCall(env,messages,[tool],valueChoice,send);
  const call=valueCall(first);
  messages.push({...first,role:'assistant'},{role:'tool',tool_call_id:call.id,content:'{"value":37}'});
  const final=await providerCall(env,messages,[tool],'auto',send);
  if(typeof final.content!=='string' || final.content.trim()!=='37' || final.tool_calls?.length)
    throw Error('Модель не подтвердила результат инструмента.');

  if(anymodel){
    const short=await providerCall(env,[{role:'user',content:'Верни только JSON: {"value":37}'}],[],'auto',send,
      {maxTokens:56,temperature:0});
    const result=parseJson(short.content);
    if(result?.value!==37 || Object.keys(result).length!==1)
      throw Error('Модель не вернула проверочный JSON в пределах 56 токенов.');
  }
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href){
  try {
    await checkModel();
    console.log('Подключение подтверждено. Модель вызвала инструмент и прочитала результат.');
  } catch(error){
    console.error(error.message);
    process.exitCode=1;
  }
}
