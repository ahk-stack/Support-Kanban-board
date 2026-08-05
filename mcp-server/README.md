# Support Kanban MCP server

Remote MCP server that lets Claude read and update tickets on the Support Kanban board.
It has no identity or database of its own - every call forwards the caller's own
Bearer token straight to the main app's `/api/mcp/*` routes, so a tool can never do
more than that person could already do in the Kanban UI.

## Run it (ops)

```
cd mcp-server
npm install
KANBAN_API_BASE=https://support-preprod.gotogo.im PORT=3100 npm start
```

Deploy behind the same ingress as the main app, e.g. as `mcp.support-preprod.gotogo.im`,
proxying to this service's `/mcp` endpoint over HTTPS.

## Connect (every team member, one-time)

1. Open the Support Kanban app -> **Profile** -> **Claude connector** -> **Generate token**.
   Copy the token now; it is shown only once.
2. In Claude, add a custom connector:
   - Claude.ai / Claude Desktop: Settings -> Connectors -> Add custom connector -> URL
     `https://mcp.support-preprod.gotogo.im/mcp`, Authorization header
     `Bearer <your token>`.
   - Claude Code: `claude mcp add --transport http support-kanban https://mcp.support-preprod.gotogo.im/mcp --header "Authorization: Bearer <your token>"`

No local install, no shared secret - revoking your token in the Profile page
immediately disconnects it everywhere.

## Tools

- `list_tickets` - search/filter tickets by status, assignee, free text
- `get_ticket` - full ticket detail + comments
- `add_comment` - add an internal comment
- `update_ticket` - change status/assignee/CS owner/priority
