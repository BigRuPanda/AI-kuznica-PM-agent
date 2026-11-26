import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import {StdioServerTransport} from '@modelcontextprotocol/sdk/server/stdio.js';
import {openStore} from './store.mjs';
import {runTool} from './analytics.mjs';
import {operations} from './tools.mjs';
const store=openStore(),server=new McpServer({name:'release-analytics',version:'1.0.0'});
const scope=process.env.RELEASE_MCP_CONTEXT?JSON.parse(process.env.RELEASE_MCP_CONTEXT):null;
for(const [key,[description,inputSchema]] of Object.entries(operations)){
  server.registerTool(key,{description,inputSchema},async input=>{
    try{
      const calc=runTool(store,key,scope?{...input,...scope,metric:input.metric??scope.metric,segment:input.segment??scope.segment}:input);
      if(scope&&calc.context&&(calc.context.releaseId!==scope.releaseId||calc.context.day>scope.day))throw Error('Расчёт вне выбранного среза.');
      return {content:[{type:'text',text:JSON.stringify(calc,scope&&calc.op!=='build_chart'?(k,v)=>k==='daily'||k==='days'?undefined:k==='both'&&Array.isArray(v)?v.length:v:undefined)}]};
    }
    catch(e){return {isError:true,content:[{type:'text',text:e.message}]};}
  });
}
if(!scope)server.registerTool('list_releases',{description:'Журнал релизов и их идентификаторы.'},async()=>({content:[{type:'text',text:JSON.stringify(store.releases())}]}));
await server.connect(new StdioServerTransport());
