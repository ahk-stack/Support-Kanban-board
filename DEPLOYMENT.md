# Support Kanban Deployment

## What this version includes

- Existing Outlook/HubSpot board behavior is kept intact.
- Users are stored in Neon/Postgres through Prisma.
- Admin user management is available at `/admin/users` after logging in as an admin.
- Tickets from the Outlook-powered board state are mirrored into the `Ticket`, `TicketComment`, `TicketEvent`, and `SyncLog` tables whenever `/api/state` is saved.
- Original email data for each ticket is stored in `Ticket.emailRaw` for audit/debug reference.

## Local setup

1. Create `.env` from `.env.example`.
2. Set `DATABASE_URL` to your Neon connection string.
3. Set a strong `SESSION_SECRET`.
4. Install dependencies and prepare Prisma:

```bash
npm install
npm run db:generate
npm run db:migrate
node seed-admin.js
npm start
```

Open:

- App: `http://localhost:3000`
- Health check: `http://localhost:3000/healthz`
- Admin users: `http://localhost:3000/admin/users`
- Ticket database API: `http://localhost:3000/api/tickets`

## Ticket translation

**It works with no configuration at all**, and it translates the *whole* ticket
— subject, card preview, internal notes, and the message body when the modal
opens. One action; the choice is remembered per ticket, so the body is
translated when it arrives from Outlook rather than by a second click.

By default this runs on **local models**, in-process: no key, no account, no
quota, and the text never leaves the server. That is what makes whole-ticket
translation affordable — a full thread is thousands of characters, which would
spend a hosted free tier on one ticket.

The models come from the optional `@huggingface/transformers` package that
`npm install` fetches (~380MB, and the install still succeeds without it — the
engine simply reports itself unavailable and the chain moves on). Individual
language packages are ~40–80MB each, downloaded the first time someone asks for
that language and then cached in `data/mt-models/`, which is gitignored. Delete
that directory to reclaim the space; the next translation re-fetches only what
it needs.

Expect roughly half a second per text run once a language is loaded, so a long
thread takes some tens of seconds the first time and is instant afterwards for
everyone — translations are cached server-side and shared. Inference runs in a
worker thread, so the board stays responsive while it works.

The engine runs behind a provider layer. Set `TRANSLATE_PROVIDER` to pin one, or
leave it at `auto` — which tries each configured engine in order and falls
through to the next when one is down, out of quota, or cannot handle the
language. Four separate services have four separate ways of being unavailable,
and an agent looking at a French ticket does not care which one answers.

| Provider | Cost | Where ticket text goes | Configure with |
| --- | --- | --- | --- |
| `local` | free | nowhere — stays in this process | nothing; `TRANSLATE_LOCAL=off` disables it, `TRANSLATE_LOCAL_MAX_MODELS` caps resident models (default 2, ~1.5GB) |
| `libretranslate` | free | your own server | `LIBRETRANSLATE_URL`, optional `LIBRETRANSLATE_API_KEY` |
| `anthropic` | per call | Anthropic | `ANTHROPIC_API_KEY`, optional `TRANSLATE_MODEL` |
| `mymemory` | free | MyMemory, a public service | nothing; `MYMEMORY_EMAIL` raises the daily allowance, `MYMEMORY_URL=off` disables it |
| `libretranslate-public` | free | a volunteer-run public instance | nothing; `TRANSLATE_PUBLIC_FALLBACK=off` disables it, or set it to your preferred instance |

That is also the auto order: local first, then anything self-hosted or already
paid for, and the two public engines last, reached only when nothing better is
set up. They complement each other — MyMemory cannot be asked to detect a
language, so a bare subject like "Annulation" goes to the public LibreTranslate,
which can.

The local models are pairwise, so they need to know the source language and
cannot serve every pair: where there is no direct model it pivots through
English, and where even that is unavailable (Greek and Hebrew, currently) the
request falls through to the next engine rather than failing.

To keep ticket text off public services entirely, set `MYMEMORY_URL=off` and
`TRANSLATE_PUBLIC_FALLBACK=off`. The local engine alone then handles everything
it has a model for, with nothing leaving the server at all.

Translations are cached per ticket, target language and exact source text, and
the cache is shared across agents, so the second person to open the same French
ticket costs nothing on any provider. Switching provider invalidates the cache
rather than serving one engine's output under another's name.

**Recommended: self-hosted LibreTranslate.** It is free and it is the only
option where client mail stays on infrastructure you control — which is the
reason this feature exists, since agents were otherwise pasting ticket bodies
into public translators. Bring it up with:

```bash
docker compose -f docker/libretranslate.compose.yml up -d
```

Then set `TRANSLATE_PROVIDER=libretranslate` and
`LIBRETRANSLATE_URL=http://localhost:5000`. Language packages are downloaded on
first boot and chosen by `LT_LOAD_ONLY` in that compose file; add languages
there as the inbox starts receiving them. A target with no installed package
fails with a message saying so, rather than quietly returning the original text.

**MyMemory** needs no setup at all and exists so the button works on a fresh
checkout. It is last in the auto order on purpose: it is a third party, and its
free tier contributes translations to a public translation memory, so it should
be a deliberate choice for a support inbox rather than a default. The picker
names whichever engine is in force and warns when text leaves the server. To
rule it out entirely — so no misconfiguration elsewhere can fall through to a
public service — set `MYMEMORY_URL=off`. Its free allowance is 5,000 characters
a day anonymously, or 50,000 with `MYMEMORY_EMAIL` set.

**Anthropic** costs money per uncached ticket and is clearly the best of the
three at the things that matter on a support board: keeping a client's register,
translating support vocabulary the way the industry does, handling threads that
mix languages, and leaving product names like Jira and HubSpot alone. A server
that already has `ANTHROPIC_API_KEY` set keeps using it under `auto`.

## Production deployment

Recommended start command:

```bash
npm start
```

Recommended build command:

```bash
npm install && npm run db:generate && npm run db:migrate
```

Required production environment variables:

```env
NODE_ENV=production
TRUST_PROXY=true
DATABASE_URL="your_neon_connection_string"
SESSION_SECRET="long-random-secret"
KANBAN_USER=admin
KANBAN_PASS="temporary-first-admin-password"

M365_TENANT_ID=
M365_CLIENT_ID=
M365_CLIENT_SECRET=
M365_REDIRECT_URI=https://YOUR_DOMAIN/auth/microsoft/callback
SUPPORT_MAILBOX=helpdesk@quinta.im

HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_REDIRECT_URI=https://YOUR_DOMAIN/auth/hubspot/callback
```

After production deploy, run `node seed-admin.js` once if your hosting platform does not run it automatically.

## Important security note

The uploaded ZIP contained a `.env` file. Rotate the Neon password and any Microsoft/HubSpot secrets before production deployment.
