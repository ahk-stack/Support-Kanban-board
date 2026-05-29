# Support Kanban Board — Quinta

A live support ticketing Kanban board built with Claude Cowork, powered by Microsoft 365.

## Features

- **Live email feed** — pulls emails in real-time from `support@quinta.im` via Microsoft 365 (polls every 60 seconds)
- **Smart spam filter** — pattern-based exclusion of automated/newsletter senders
- **Auto-classification** — priority (High / Medium / Low) and category assigned on arrival
- **Categories** — Technical failure · Bug Velma · RYA · Connectivity request · Other · Spam
- **Auto-assignment** — load-balanced distribution across agents: SGU · SHE · ZIO · AHK
- **Drag & drop** — move tickets across New → In Progress → Resolved
- **Internal comments** — @tag teammates (SGU, SHE, ZIO, AHK, CS, Client) per ticket
- **Persistent state** — column, priority, category, assignee and comments survive board close/reopen via localStorage
- **Sort toggle** — Newest first / Oldest first
- **Priority & agent filters**
- **Open email** — read full email body inline without leaving the board

## Requirements

Runs as a **Claude Cowork artifact** with the **Microsoft 365 MCP connector** authenticated to `support@quinta.im`.

## Stack

- Vanilla HTML / CSS / JavaScript — zero dependencies
- Microsoft Graph API (via Cowork MCP) for Outlook
- `localStorage` for client-side state persistence

## Agents

| Trigram | Role |
|---------|------|
| SGU | Support Agent |
| SHE | Support Agent |
| ZIO | Support Agent |
| AHK | Support Agent |

## Backup And Version Control (Mandatory)

This project now includes a mandatory operational workflow to avoid regressions.

### Local backups

- Create backup: `npm run backup:create`
- List backups: `npm run backup:list`
- Backups are stored in `backups/` (git-ignored)
- Automatic retention keeps the latest 30 backups

### Release snapshots

- Create a release snapshot:  
  `npm run release:snapshot -- -Version 1.0.0 -Message "stable prod baseline"`
- This will:
  1. Create a local backup
  2. Commit pending changes
  3. Create an annotated git tag `v<version>`

### Branch policy

- `main`: production only (stable)
- `develop`: ongoing CRM features
- `feature/*`: short-lived feature branches from `develop`

### Deploy safety rule

- Always deploy from `main`
- Merge tested changes into `main` only during scheduled release windows
- Push with tags for every release:
  - `git push origin main`
  - `git push origin --tags`
