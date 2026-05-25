# Support Kanban Board - Full Project Handoff (Updated May 25, 2026)

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

Behavior:
- OAuth + token refresh persistence
- Read-focused scope validation
- Owner resolver includes multiple lookup attempts and fallback list scan

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

## Notes
- `.env` remains git-ignored.
- `data/*.json` and `versions/*.json` remain git-ignored.
- Rotate secrets if exposed.
