import '../server/config.mjs';
import {providerCall} from '../server/agent.mjs';
const tool={type:'function',function:{name:'check_value',description:'Получить тестовое значение.',parameters:{type:'object',properties:{},required:[]}}};
try{
  const messages=[{role:'user',content:'Вызови check_value, затем верни полученное число.'}];
  const first=await providerCall(process.env,messages,[tool],{type:'function',function:{name:'check_value'}});
  const call=first.tool_calls?.[0];
  if(call?.function.name!=='check_value')throw Error('Модель не вызвала тестовый инструмент.');
  messages.push({...first,role:'assistant'},{role:'tool',tool_call_id:call.id,content:'{"value":37}'});
  const final=await providerCall(process.env,messages,[tool],'auto');
  if(!final.content?.includes('37'))throw Error('Модель не подтвердила результат инструмента.');
  console.log('Подключение подтверждено. Модель вызвала инструмент и прочитала результат.');
}catch(e){console.error(e.message);process.exitCode=1;}
