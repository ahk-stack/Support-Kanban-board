import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const KANBAN_API_BASE = (process.env.KANBAN_API_BASE || 'https://support-preprod.gotogo.im').replace(/\/+$/, '');
const TOKEN = process.env.SUPPORT_KANBAN_TOKEN;

async function kanbanFetch(path, options = {}) {
  if (!TOKEN) throw new Error('SUPPORT_KANBAN_TOKEN is not set - generate one from Profile -> Claude connector and set it as an environment variable for this server.');
  const res = await fetch(`${KANBAN_API_BASE}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}`, ...(options.headers || {}) }
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body?.error || `kanban_api_error_${res.status}`);
  return body;
}

function textResult(value) {
  return { content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 2) }] };
}

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
    const data = await kanbanFetch(`/api/mcp/tickets?${params.toString()}`);
    return textResult(data.tickets);
  }
);

server.registerTool(
  'get_ticket',
  { title: 'Get ticket detail', description: 'Get full detail for one ticket, including its comments.', inputSchema: { ticketId: z.number().int().positive() } },
  async ({ ticketId }) => {
    const data = await kanbanFetch(`/api/mcp/tickets/${ticketId}`);
    return textResult(data.ticket);
  }
);

server.registerTool(
  'add_comment',
  { title: 'Add a comment to a ticket', description: 'Add an internal comment to a ticket.', inputSchema: { ticketId: z.number().int().positive(), text: z.string().min(1) } },
  async ({ ticketId, text }) => {
    const data = await kanbanFetch(`/api/mcp/tickets/${ticketId}/comments`, { method: 'POST', body: JSON.stringify({ text }) });
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
    const data = await kanbanFetch(`/api/mcp/tickets/${ticketId}`, { method: 'PATCH', body: JSON.stringify(fields) });
    return textResult(data.ticket);
  }
);

const transport = new StdioServerTransport();
await server.connect(transport);
