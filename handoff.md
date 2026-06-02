# Support Kanban Board - Full Project Handoff (Updated May 29, 2026)

## Latest Incident + Lessons Learned (May 29, 2026)

### What happened
- HubSpot ticket sync appeared stuck (`Syncing` / `Queued`) and did not consistently switch to `See on HubSpot`.
- Root causes were:
  1. UI state not reflecting blocked/failed sync paths clearly.
  2. HubSpot user-level OAuth token denied tickets pipeline discovery endpoint (`403`).
  3. Re-auth flow hit unauthorized when started outside an authenticated Kanban session.

### Fixes implemented
- Frontend sync state hardening:
  - timeout + stale in-flight cleanup
  - explicit blocked/failed state (`Retry HubSpot`)
  - clearer queued vs in-flight status
- Backend HubSpot sync hardening:
  - pipeline/stage resolution now prefers env IDs first
  - fallback behavior when pipeline endpoint is blocked
- OAuth flow guidance:
  - re-auth must start from logged-in app session

## Latest Functional Upgrade (May 29, 2026 - Evening)

Implemented:
1. Two new Kanban stages:
   - `Waiting On Us`
   - `Waiting On Contact`
2. KPI dashboard upgraded to include all 5 statuses:
   - New, In Progress, Waiting On Us, Waiting On Contact, Resolved
3. HubSpot status sync on stage change:
   - Drag/drop in Kanban now triggers backend HubSpot ticket status update
   - `Resolved` in Kanban maps to HubSpot closed/resolved stage via env mapping
4. Status persistence hardening:
   - Stage values are normalized on load/render
   - Save reason for stage moves is explicit (`ticket_stage_move`)
   - Helps prevent tickets reverting to older stage after updates/polls

New env mapping keys:
- `HUBSPOT_TICKET_STAGE_NEW`
- `HUBSPOT_TICKET_STAGE_IN_PROGRESS`
- `HUBSPOT_TICKET_STAGE_WAITING_ON_US`
- `HUBSPOT_TICKET_STAGE_WAITING_ON_CONTACT`
- `HUBSPOT_TICKET_STAGE_RESOLVED`

### New mandatory operating procedure
1. Every significant change must update:
   - codebase
   - `README.md`
   - `handoff.md`
2. Every release candidate must create:
   - local backup snapshot
   - git commit
   - version tag
3. Production deploys only from `main`, development continues on `develop`.

## Project Location
- Local working directory: `C:\Users\AkramHKIRI\Desktop\outlook-support-kanban`
- Runtime URL: `http://localhost:3000`
- Git remote: `https://github.com/ahk-stack/Support-Kanban-board.git`

## Current State Summary
This app is now a secure support operations platform with CRM foundation components:
1. Kanban ticket management
2. Microsoft 365 delegated OAuth ingestion
3. HubSpot enrichment and company workspace
4. Local persistence + version snapshots
5. Data Hygiene dashboard (HubSpot-backed reporting)
6. Assignment orchestration (CS + support)
7. Left CRM navigation shell for future modules
8. KPI dashboard (ticket/status/agent analytics with time filters)

## Architecture
- Frontend: single-page app in `index.html` (vanilla JS/CSS)
- Backend: Node/Express in `server.js`
- Session auth: `express-session`
- Security middleware: `helmet`, `express-rate-limit`
- Board persistence: `data/board-state.json`
- OAuth token persistence: `data/oauth-tokens.json`
- State snapshots: `versions/board-state-*.json`

## Key Files
- `index.html`: board UI, CRM sidebar, companies workspace, co-owner mapping, data hygiene view
  - Includes new KPI page under the CRM sidebar
- `server.js`: auth, OAuth flows, token refresh, state APIs, HubSpot APIs, data hygiene API
- `public/login.html`: local login form
- `.env.example`: env template
- `start-kanban.cmd` / `start-kanban.ps1`: local startup helpers
- `handoff.md`: this handoff

## Security Model
- Local login:
  - `GET /login`
  - `POST /auth/login`
  - `POST /auth/logout`
- Protected routes require session auth.
- OAuth connectors currently require authenticated session to start.

## Integrations
### Microsoft 365
Routes:
- `GET /auth/microsoft/start`
- `GET /auth/microsoft/callback`
- `GET /auth/microsoft/status`

Behavior:
- Delegated OAuth auth-code flow with refresh token
- Shared mailbox reads via Microsoft Graph
- Tokens persisted locally

### Debug Expert Agent
Routes:
- `POST /api/debug-expert`

Behavior:
- Pulls full Outlook message content for a ticket (body + attachment metadata/text when parseable)
- Builds issue query terms and searches HubSpot knowledge base (site search API)
- Returns proposed troubleshooting steps + relevant KB links
- Frontend posts the proposal as an internal ticket comment and tags the current assignee

### HubSpot
Routes:
- `GET /auth/hubspot/start`
- `GET /auth/hubspot/callback`
- `GET /auth/hubspot/status`
- `POST /api/mcp-proxy` (search CRM objects)
- `POST /api/hubspot/companies/:companyId/custom-property`
- `GET /api/hubspot/companies/:companyId/network`
- `GET /api/hubspot/data-hygiene`
- `GET /api/hubspot/owners/resolve`
- `POST /api/hubspot/tickets/sync`

Behavior:
- OAuth + token refresh persistence
- Read-focused scope validation
- Owner resolver includes multiple lookup attempts and fallback list scan
- Kanban ticket sync can create HubSpot tickets and associate them with the related company record

## Data Hygiene Dashboard (New)
Available from CRM sidebar (`Data Hygiene`) and Companies report mode.

Checks implemented:
1. Duplicate companies (domain/name grouping)
2. AM/CS owner mismatch
3. Missing contract signature date
4. Parent/monohotel with no associated deal

Filters/constraints:
- Client-linked only (with fallback criteria)
- Server caching + retry/backoff + timeout limits
- Forced refresh with `?force=1`
- Partial snapshot indicator for timeout-limited runs

## CRM Sidebar (New)
Left-side navigation added:
- Support Board
- Spam Inbox
- Companies
- Data Hygiene
- KPIs

## KPI Dashboard (New)
Available from CRM sidebar (`KPIs`).

Metrics:
1. Number of tickets by status (`New`, `In Progress`, `Resolved`)
2. Number of tickets by agent with status breakdown

Time filters:
- Today
- Last week
- Last 30 days
- This quarter
- Last quarter
- This year

## Assignment Logic Status
Implemented:
- CS auto-assignment from resolved co-owner signal
- Manual support handoff preserved (`Assign to support`)
- Manual support ownership is not overridden by CS automation
- Co-owner mapping UI with persistent mapping save/reapply
- Name and ID heuristics for resolving CS trigram

Known limitation:
- Some HubSpot co-owner field values are opaque numeric IDs that do not reliably resolve to human owners in this portal/API context.
- The most reliable path is explicit mapping table maintenance (ID/name -> trigram), or adding a dedicated authoritative company property (e.g. `cs_trigram`).

## Persistence and Backup
Implemented:
- Serialized save queue
- Client save metadata
- Server stale write rejection
- `sendBeacon` flush on hide/close
- Rotating snapshots under `versions/`
- `actionHistory` persistence

## Environment Variables
### App/session
- `PORT`
- `KANBAN_USER`
- `KANBAN_PASS` or `KANBAN_PASS_HASH`
- `SESSION_SECRET`

### Microsoft OAuth
- `M365_TENANT_ID`
- `M365_CLIENT_ID`
- `M365_CLIENT_SECRET`
- `M365_REDIRECT_URI`

### HubSpot OAuth
- `HUBSPOT_CLIENT_ID`
- `HUBSPOT_CLIENT_SECRET`
- `HUBSPOT_REDIRECT_URI`
- `HUBSPOT_SCOPES`
  - Must include `cms.site_search.read` for Debug Expert KB search
  - Must include `tickets` (HubSpot legacy write scope) for Kanban→HubSpot ticket creation sync
- `HUBSPOT_ALLOWED_WRITE_SCOPES`
  - Defaults to `tickets crm.objects.tickets.write`
- `HUBSPOT_PKCE_CODE_VERIFIER`
- `HUBSPOT_PKCE_CODE_CHALLENGE`
- `HUBSPOT_AUTHORIZE_BASE`

### Optional HubSpot fallback
- `HUBSPOT_PRIVATE_APP_TOKEN`

### Backup tuning
- `STATE_BACKUP_KEEP`
- `STATE_BACKUP_MIN_INTERVAL_MS`

### Data hygiene tuning
- `DATA_HYGIENE_CACHE_TTL_MS`
- `DATA_HYGIENE_PAGE_DELAY_MS`
- `DATA_HYGIENE_MAX_PAGES`
- `DATA_HYGIENE_MAX_DURATION_MS`
- `DATA_HYGIENE_MAX_ROWS`

## Runbook
1. `npm install`
2. `npm start`
3. Open `http://localhost:3000/login`
4. Login via local credentials
5. Connect Microsoft (`/auth/microsoft/start`)
6. Connect HubSpot (`/auth/hubspot/start`)

## Validation Checklist
1. `/login` returns 200
2. Board poll loads and card movement persists
3. Companies view loads and filters work
4. Data Hygiene report loads and can refresh
5. Co-owner mapping can be saved/applied and assignments update

## Deployment Readiness Notes
- For team-wide access, app must run on centralized host (not localhost).
- Recommend production branch freeze before rollout.
- Strongly recommend migrating local JSON state to shared DB before multi-user production.

## Git Version Control Strategy (Recommended)
Use two long-lived branches:
- `main`: production-stable only
- `develop`: ongoing CRM feature work

Flow:
1. Deploy from `main` only
2. Build new features in `develop` (or `feature/*` branches off `develop`)
3. Merge tested changes from `develop` to `main` only during planned releases
4. Tag releases on `main` (`v1.0.0`, `v1.1.0`, ...)

This protects colleagues from disruptions while CRM development continues.

## Backup + Release Automation (Implemented)

Scripts added:
- `npm run backup:create`
- `npm run backup:list`
- `npm run release:snapshot -- -Version <x.y.z> -Message \"...\"`

Behavior:
- Backup snapshots are created in `backups/` (git-ignored) with retention of latest 30.
- Release snapshot script creates backup, commits pending changes, and tags release (`vX.Y.Z`).

## Notes
- `.env` remains git-ignored.
- `data/*.json` and `versions/*.json` remain git-ignored.
- Rotate secrets if exposed.

## Update - 2026-06-01

### Kanban cleanup
- Reset persisted board state file (`data/board-state.json`) to a clean baseline.
- This removes legacy/historical tickets so the board starts fresh from current mailbox polling.

### Ticket stage persistence hardening
- Added `ticketStageTouchedAt` (per-ticket stage change timestamp) in frontend state.
- On drag/drop stage move, we now update `ticketStageTouchedAt[ticketId] = Date.now()` before saving.
- Server-side `safeWriteState()` now merges `ticketState` using `ticketStageTouchedAt`:
  - newest stage change wins per ticket
  - older snapshots can no longer overwrite a newer moved stage.

### Operational
- Restarted Node server after patch so changes are live.

## Update - 2026-06-02

### Spam inbox behavior fix
- `Clear spam` now truly clears the spam inbox UI by hiding spam tickets once they are archived to `Resolved`.
- Restoring a cleared spam ticket now moves it back to `New` so it visibly returns to the active board instead of staying hidden in `Resolved`.
- Spam clear/restore actions now also update `ticketStageTouchedAt`, so server-side stale-write protection preserves those stage changes correctly.

### Mailbox ingestion + reply dedupe fix
- Outlook message proxy now returns `conversationId` and `internetMessageId` so the frontend can thread emails more reliably.
- Polling now checks the latest 50 mailbox messages each cycle instead of only a narrow 5-minute / 20-message slice, which reduces missed-ticket cases when several emails arrive close together.
- Ticket creation now merges replies back into the existing card by conversation first, with a client-email + normalized-subject fallback for older messages that did not yet carry conversation metadata.
- Internal-recipient detection now treats both `quinta.im` and `quicktext.im` as internal domains and excludes support mailbox aliases like `helpdesk@quicktext.im` when identifying the client on reply loops.

### Test sender unblock
- Removed `hkiriakrem1984@gmail.com` from the hardcoded blocked sender list after confirming it was preventing manual mailbox tests from creating tickets.
