import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod/v4';
import { analysisView, search } from './evidence.mjs';
import { dashboard, visibleCase, enqueue, draft } from './workbench.mjs';
export function teamTools(server, store, user) {
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
  register('workspace_overview', 'Доступные разборы, источники и чаты', {}, () => dashboard(db, user));
  register('search_evidence', 'Найти источники с координатами', { query: z.string().max(400) }, (b) =>
    search(db, b.query),
  );
  register(
    'analyze_case',
    'Получить проверяемый расчёт на той же версии, что в вебе',
    { caseId: z.string(), full: z.boolean().optional() },
    (b) => {
      visibleCase(db, user, b.caseId);
      return analysisView(db, b);
    },
  );
  register(
    'ask_workspace',
    'Записать поручение в доступный чат',
    {
      thread: z.string(),
      question: z.string().max(2400),
      caseId: z.string().optional(),
      requestId: z.string().optional(),
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
    (b) => draft(store, user, b),
  );
}
export async function remoteMcp(req, res, body, store, user) {
  const server = new McpServer({ name: 'softline-pm', version: '2.0.0' });
  teamTools(server, store, user);
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
