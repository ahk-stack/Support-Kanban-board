# Support Kanban Board - Full Project Handoff

## Project Location
- Local working directory: `C:\Users\AkramHKIRI\Desktop\outlook-support-kanban`
- Runtime URL: `http://localhost:3000`

## Goal and Current Scope
This project was transformed from a single-file MCP artifact into a secure web app foundation for:
1. Support Kanban operations
2. Outlook inbox ingestion (delegated Microsoft OAuth)
3. HubSpot CRM enrichment
4. Future extension into Quinta CRM

## Architecture
- Frontend: Single-page app in `index.html`
- Backend: Node/Express server in `server.js`
- Auth/session: `express-session`
- Security middleware: `helmet`, `express-rate-limit`
- Persistence: `data/board-state.json` via `/api/state`
- Local config: `.env`

## Key Files
- `index.html`: full board UI and client-side logic (drag/drop, filters, SLA badges, comments, mentions, Jira link, spam view)
- `server.js`: auth, API proxying, OAuth flows, state endpoints
- `public/login.html`: local app login form
- `.env.example`: baseline env template
- `.env`: live local credentials (excluded from git)
- `.gitignore`: excludes `.env`, `node_modules`, runtime data

## Security Model
- App login route: `/login`
- Session cookie: `kanban.sid`
- Protected APIs require login (`requireAuth`):
  - `GET/POST /api/state`
  - `POST /api/mcp-proxy`
  - OAuth start/callback/status routes are session-scoped

## Microsoft 365 Integration (Delegated OAuth)
Implemented routes:
- `GET /auth/microsoft/start`
- `GET /auth/microsoft/callback`
- `GET /auth/microsoft/status`

Behavior:
- Uses auth code flow + refresh token
- Reads shared mailbox through Graph using signed-in user delegated rights
- Required app registration redirect URI:
  - `http://localhost:3000/auth/microsoft/callback`

Known requirement:
- Tenant consent policy must allow consent OR admin pre-consent must be granted

## HubSpot Integration
Implemented routes:
- `GET /auth/hubspot/start`
- `GET /auth/hubspot/callback`
- `GET /auth/hubspot/status`

Proxy behavior:
- `POST /api/mcp-proxy` handles pseudo-MCP calls
- `search_crm_objects` mapped to HubSpot APIs
- Contact->company association handled with HubSpot association endpoints

PKCE support added:
- `HUBSPOT_PKCE_CODE_VERIFIER`
- `HUBSPOT_PKCE_CODE_CHALLENGE`
- `HUBSPOT_AUTHORIZE_BASE` (currently set to `https://mcp-eu1.hubspot.com/oauth/authorize/user`)

## Frontend/Board Features Already In Place
- Kanban columns: New / In Progress / Resolved
- Drag & drop state persistence
- Priority filters, assignee filters, company filters
- Spam sender marking and separate spam view
- Mentions and comment thread per ticket
- Jira key linking
- Outlook mail preview modal

## Requested Enhancements Implemented
### 1) Company association efficiency by email domain
- Added domain-level cache:
  - `domainCompanyCache`
- `findCompanyByDomain(...)` now checks cache first and saves result
- Cache persisted through `/api/state`

### 2) Newsletter and Microsoft meeting suppression
- Extended exclusion signals in `isAutomatic(...)`
- Added newsletter and meeting invitation patterns
- These emails are blocked from ticket creation path

### 3) Sub-categories and SLA from taxonomy Excel
Source file used:
- `C:\Users\AkramHKIRI\Downloads\quinta_sla_taxonomy.xlsx`

Implemented:
- Added 31 subtype model in `TICKET_SUBTYPES`
- Added mapping `SUBTYPE_BY_ID`
- Added `ticketSubtype` state persistence
- Added subtype dropdown on cards
- Category and priority auto-derive from subtype
- SLA badge now uses subtype response targets and paused handling for subtype `1.7`

## Important Fixes Applied During Session
- Fixed multiple OAuth integration blockers:
  - redirect URI mismatch
  - scope mismatch strategy
  - session/callback unauthorized behavior insights
- Fixed JavaScript freeze caused by invalid regex in subtype classifier
  - regex syntax now valid and verified

## Current Known Risks / Follow-ups
1. HubSpot OAuth scope parity can still fail if HubSpot app required scopes diverge from requested scopes.
2. Taxonomy classifier currently keyword-based heuristics and should be refined with production examples.
3. UX debt:
   - "Awaiting Hotel" dedicated column for subtype `1.7` not yet added
   - SLA breach protocol automation not yet added
4. `_check.js` and `_read_taxonomy.py` are temporary helper files and should not be part of product code.

## Env Variables (expected)
- App/session:
  - `PORT`
  - `KANBAN_USER`
  - `KANBAN_PASS` or `KANBAN_PASS_HASH`
  - `SESSION_SECRET`
- Microsoft OAuth:
  - `M365_TENANT_ID`
  - `M365_CLIENT_ID`
  - `M365_CLIENT_SECRET`
  - `M365_REDIRECT_URI`
- HubSpot OAuth:
  - `HUBSPOT_CLIENT_ID`
  - `HUBSPOT_CLIENT_SECRET`
  - `HUBSPOT_REDIRECT_URI`
  - `HUBSPOT_SCOPES`
  - `HUBSPOT_PKCE_CODE_VERIFIER`
  - `HUBSPOT_PKCE_CODE_CHALLENGE`
  - `HUBSPOT_AUTHORIZE_BASE`
- Optional static token fallback (disabled unless starts with `pat-`):
  - `HUBSPOT_PRIVATE_APP_TOKEN`

## Runbook
1. Install deps: `npm install`
2. Start: `npm start` or `node server.js`
3. Open: `http://localhost:3000/login`
4. Connect Microsoft: `/auth/microsoft/start`
5. Connect HubSpot: `/auth/hubspot/start`

## Recommended Next Steps
1. Add explicit `Awaiting Hotel` column and paused SLA clock state transitions.
2. Replace keyword subtype classifier with deterministic rules table + confidence score.
3. Add backend logs + UI diagnostics panel for OAuth and enrichment errors.
4. Add test coverage for:
   - `isAutomatic`
   - subtype classification
   - SLA status calculations
   - domain cache behavior

## Git Push Notes
- `.env` is intentionally excluded.
- Ensure GitHub repo branch protection/settings allow direct push to `main`.

