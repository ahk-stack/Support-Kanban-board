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
