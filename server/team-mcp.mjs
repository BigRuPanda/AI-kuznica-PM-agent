import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import { operations, workspaceOperation } from './workspace-operations.mjs';
import { dashboard, enqueue } from './workbench.mjs';
export function teamTools(server, store, user, env = process.env, send = fetch) {
  const db = store.db;
  function register(name, description, inputSchema, fn) {
    server.registerTool(name, { description, inputSchema }, async (input) => {
      try {
        return { content: [{ type: 'text', text: JSON.stringify(await fn(input)) }] };
      } catch (e) {
        return { isError: true, content: [{ type: 'text', text: e.message }] };
      }
    });
  }
  for (const [name, [description, schema]] of Object.entries(operations))
    register(name, description, schema, (b) => workspaceOperation(store, user, name, b, env, send, false, undefined, true));
  register('workspace_overview', 'Доступные разборы, источники и чаты', {}, () => dashboard(db, user));
  register('search_evidence', 'Найти источники с координатами', { query: z.string().max(400) }, (b) =>
    workspaceOperation(store, user, 'search', b),
  );
  register(
    'analyze_case',
    'Получить проверяемый расчёт разбора, при необходимости за выбранный период',
    { ...operations.view[1], caseId: operations.view[1].caseId.unwrap() },
    (b) => workspaceOperation(store, user, 'view', b).view,
  );
  register(
    'ask_workspace',
    'Записать поручение в доступный чат',
    {
      thread: z.string(),
      question: z.string().max(2400),
      caseId: z.string().optional(),
      requestId: z.string().optional(),
      rangeId: z.string().optional(),
      selection: operations.range_compare[1].selection.optional(),
    },
    (b) => ({ id: enqueue(store, user, b) }),
  );
  register(
    'job_status',
    'Статус своего поручения',
    { id: z.string() },
    (b) =>
      store.one('SELECT id,status,result FROM jobs WHERE id=? AND user=?', b.id, user.id) ?? {
        error: 'Не найдено',
      },
  );
  register(
    'draft_issue',
    'Подготовить черновик для подтверждения в вебе',
    { caseId: z.string(), title: z.string(), description: z.string() },
    (b) => workspaceOperation(store, user, 'draft', b, env, send, false, undefined, true),
  );
}
export async function remoteMcp(req, res, body, store, user, env, send) {
  const server = new McpServer({ name: 'softline-pm', version: '2.0.0' });
  teamTools(server, store, user, env, send);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  res.on('close', () => {
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
