import express from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const PORT = process.env.PORT || 3100;
const KANBAN_API_BASE = (process.env.KANBAN_API_BASE || 'http://localhost:3000').replace(/\/+$/, '');

async function kanbanFetch(bearerToken, path, options = {}) {
  const res = await fetch(`${KANBAN_API_BASE}${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${bearerToken}`,
      ...(options.headers || {})
    }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(body?.error || `kanban_api_error_${res.status}`);
  }
  return body;
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

// Each request builds its own McpServer bound to the caller's own Bearer
// token (forwarded straight through to the Kanban app's /api/mcp/* routes) -
// every tool call is scoped to exactly what that Kanban user can already do,
// there is no separate identity or permission model in this service.
function buildServer(bearerToken) {
  const server = new McpServer({ name: 'support-kanban', version: '1.0.0' });

  server.registerTool(
    'list_tickets',
    {
      title: 'List support tickets',
      description: 'List/search tickets on the Support Kanban board. Filter by status, assignee, or a free-text search term.',
      inputSchema: {
        status: z.enum(['New', 'In Progress', 'Waiting on Us', 'Due for Test', 'Waiting on Contact', 'Resolved']).optional(),
        assignee: z.string().optional().describe('Agent trigram, e.g. MBH'),
        q: z.string().optional().describe('Free-text search over subject, company name, and sender email'),
        limit: z.number().int().min(1).max(200).optional()
      }
    },
    async ({ status, assignee, q, limit }) => {
      const params = new URLSearchParams();
      if (status) params.set('status', status);
      if (assignee) params.set('assignee', assignee);
      if (q) params.set('q', q);
      if (limit) params.set('limit', String(limit));
      const data = await kanbanFetch(bearerToken, `/api/mcp/tickets?${params.toString()}`);
      return textResult(data.tickets);
    }
  );

  server.registerTool(
    'get_ticket',
    {
      title: 'Get ticket detail',
      description: 'Get full detail for one ticket, including its comments.',
      inputSchema: { ticketId: z.number().int().positive() }
    },
    async ({ ticketId }) => {
      const data = await kanbanFetch(bearerToken, `/api/mcp/tickets/${ticketId}`);
      return textResult(data.ticket);
    }
  );

  server.registerTool(
    'add_comment',
    {
      title: 'Add a comment to a ticket',
      description: 'Add an internal comment to a ticket.',
      inputSchema: { ticketId: z.number().int().positive(), text: z.string().min(1) }
    },
    async ({ ticketId, text }) => {
      const data = await kanbanFetch(bearerToken, `/api/mcp/tickets/${ticketId}/comments`, {
        method: 'POST',
        body: JSON.stringify({ text })
      });
      return textResult(data.comment);
    }
  );

  server.registerTool(
    'update_ticket',
    {
      title: 'Update a ticket',
      description: 'Move a ticket to a new stage, (re)assign it, or change its priority. Only send the fields you want to change.',
      inputSchema: {
        ticketId: z.number().int().positive(),
        status: z.enum(['New', 'In Progress', 'Waiting on Us', 'Due for Test', 'Waiting on Contact', 'Resolved']).optional(),
        assignedAgent: z.string().optional().describe('Agent trigram to assign, or empty string to unassign'),
        csAgent: z.string().optional().describe('CS owner trigram, or empty string to clear'),
        priority: z.enum(['Low', 'Normal', 'High', 'Urgent']).optional()
      }
    },
    async ({ ticketId, ...fields }) => {
      const data = await kanbanFetch(bearerToken, `/api/mcp/tickets/${ticketId}`, {
        method: 'PATCH',
        body: JSON.stringify(fields)
      });
      return textResult(data.ticket);
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.post('/mcp', async (req, res) => {
  const authHeader = String(req.headers.authorization || '');
  const match = authHeader.match(/^Bearer\s+(.+)$/i);
  if (!match) {
    return res.status(401).json({ jsonrpc: '2.0', error: { code: -32001, message: 'Missing Bearer token' }, id: null });
  }
  const bearerToken = match[1].trim();

  try {
    const server = buildServer(bearerToken);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (error) {
    console.error('MCP request failed:', error);
    if (!res.headersSent) {
      res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: 'Internal server error' }, id: null });
    }
  }
});

app.get('/healthz', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Support Kanban MCP server listening on :${PORT}, proxying to ${KANBAN_API_BASE}`);
});
