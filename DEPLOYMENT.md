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
| `local` | free | nowhere — stays in this process | nothing; `TRANSLATE_LOCAL=off` disables it, and see **Keeping the local engine small** below |
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

### Keeping the local engine small

Translating locally costs memory while it runs, and the shape of that cost was
measured on this repo's model cache with a mail-sized body, three tickets in a
row:

| | after ticket 1 | 2 | 3 | peak |
| --- | --- | --- | --- | --- |
| ONNX arena on (the runtime's default) | 414MB | 571MB | 682MB | 675MB |
| arena off (what ships) | 414MB | 416MB | 409MB | 571MB |

The climb is the thing to avoid: ONNX Runtime keeps freed blocks in a per-session
arena for reuse, and since every ticket is a different shape it kept adding new
ones, so the footprint only ever went up until the worker was torn down. With the
arena off each batch hands its memory back and the engine sits flat at around
410MB, for roughly two thirds more wall clock.

The rest is the model: about 300MB per resident language pair once its ONNX
sessions are built. So one translation needs ~500–600MB peak, and that is the
floor unless the model changes. What it does *not* need is to hold that between
tickets — the worker is torn down once nobody has translated anything for
`TRANSLATE_LOCAL_IDLE_MS` (45s by default), which measured RSS going from 424MB
back to 54MB.

| Variable | Default | Effect |
| --- | --- | --- |
| `TRANSLATE_LOCAL_IDLE_MS` | `45000` | How long a loaded model is kept for the next ticket. `0` keeps it resident forever. Lower it to give memory back sooner, at a couple of seconds' reload on the next translation. |
| `TRANSLATE_LOCAL_MAX_MODELS` | `1` | Resident language pairs (~300MB each). `2` keeps a language and its reverse warm on a bigger box. |
| `TRANSLATE_LOCAL_ARENA` | off | `on` restores the runtime's own allocator: faster, and the climb above comes back. |
| `TRANSLATE_LOCAL_HEAP_MB` | unset | V8 heap ceiling for the worker thread. Bounds the JS side only — the weights and tensors are native — but on a small box a worker that dies with an error the app reports beats the kernel choosing a process to kill. |
| `TRANSLATE_LOCAL_BATCH_ROWS` / `_BATCH_COST` | `8` / `3200` | Rows per model call and rows × longest-row-chars. Lower them for a smaller working set per batch; below about 4 rows it stopped buying memory and only cost time. |
| `TRANSLATE_LOCAL_THREADS` | `0` (runtime decides) | Not a memory lever — measured within noise at 0 and 2. Set it to stop translation taking CPU from the web server. |
| `TRANSLATE_LOCAL_BATCH_RATIO` | `8` | How far apart in length two rows may be before they are batched separately. A correctness guard, not a tuning knob — see below. |
| `TRANSLATE_LOCAL_BEAMS` | `4` (the model's own) | A recorded dead end: greedy decoding measured within noise on peak RSS (539MB against 568MB) and was slower (7.3s against 6.1s over 24 rows), because it keeps generating where a beam search has settled. Lowering it buys nothing. |

**One thing to leave alone.** `TRANSLATE_LOCAL_BATCH_RATIO` exists because
batching a long paragraph beside a very short line makes
`@huggingface/transformers` 4.2.0 corrupt *every* row in that batch: it keeps
generating for rows that have already finished, and since Marian's pad token is
in the model's own `bad_words_ids` it emits periods instead — a run exactly as
long as the token budget that was left. Rows of similar length, or rows sent one
at a time, come back clean, so batches are capped by length spread. There is a
second guard after the fact that trims a trailing run of repeated punctuation the
source did not have, and logs when it does.

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
# Optional. Extra addresses the board's Reply composer may send as, on top of
# SUPPORT_MAILBOX which is always offered. Each one also needs Send As granted
# to the connected Outlook identity in Exchange, or Graph refuses the send.
REPLY_FROM_ADDRESSES=
# Optional, and the alternative to the Mail.Send consent: a Power Automate
# "When an HTTP request is received" URL. Set it and the board sends replies and
# Feedback mail by POSTing to that flow instead of through Graph, so this
# deployment holds no credential that can send mail. See the section on it below.
MAIL_WEBHOOK_URL=
# Optional. The mailbox the board sends its OWN mail from - password resets and
# feedback reports, never client replies. Unset, those send as whichever
# identity last connected Outlook. See the section on it below.
KANBAN_MAILBOX=
# Who the header's Feedback button mails reports to. Comma separated; every
# address listed gets the same mail. Defaults to the three below when unset.
FEEDBACK_EMAIL=sfa@quinta.im,sgu@quinta.im,ahk@quinta.im
# Optional. A Teams incoming webhook, or a Power Automate "When an HTTP request
# is received" URL, to also post each report into Teams. Empty means email only.
FEEDBACK_WEBHOOK_URL=

HUBSPOT_CLIENT_ID=
HUBSPOT_CLIENT_SECRET=
HUBSPOT_REDIRECT_URI=https://YOUR_DOMAIN/auth/hubspot/callback
```

After production deploy, run `node seed-admin.js` once if your hosting platform does not run it automatically.

## Sending mail without giving the board a credential that can send mail

`MAIL_WEBHOOK_URL` is the alternative to the `Mail.Send` consent below. Set it to
a Power Automate **"When an HTTP request is received"** trigger URL and the board
stops asking Graph to send anything - replies and Feedback mail are POSTed to
that flow, and the flow sends them on its own Outlook connection. Unset, nothing
changes and the Graph path described further down is used.

**Why this is the safer shape.** A delegated `Mail.Send` token in this process
can send as the connected identity and as every mailbox Exchange grants it Send
As on, so anything that leaks it can send mail as us until the consent is pulled.
The flow URL leaks as "post one JSON body into one flow": it cannot read a
mailbox, cannot change the From address the flow was built with, and is revoked
by regenerating the trigger. It is still a secret - the signature is in the URL -
so it belongs in the platform's env store, not in a committed file.

**What it costs.** The flow owns the From address, so `REPLY_FROM_ADDRESSES` and
the per-agent From are only honoured as far as the flow chooses to honour them;
and a failed send comes back as an HTTP status rather than a Graph error, so the
flow's run history becomes the place failures are diagnosed.

**The body the board POSTs.** One shape for every mail, with `kind` to switch on:

```json
{
  "kind": "support_kanban_reply",
  "from": "helpdesk@quinta.im",
  "mailbox": "helpdesk@quinta.im",
  "messageId": "AAMkAD...",
  "ticketId": "",
  "subject": "Re: Booking not syncing",
  "bodyHtml": "<div>the agent's reply, above the quoted original</div>",
  "to": ["client@example.com"],
  "cc": [],
  "replyTo": [],
  "toLine": "client@example.com",
  "ccLine": "",
  "reporter": "",
  "sentBy": ""
}
```

`kind` is `support_kanban_reply` for a ticket reply and `support_kanban_feedback`
for a Feedback report. `toLine`/`ccLine` are the same recipients semicolon-
separated, because that is the shape the Outlook actions take.

**The flow, in three actions.**

1. **When an HTTP request is received** - paste the JSON above as the sample
   payload so the designer generates the fields.
2. **Condition** on `messageId` being non-empty.
   - **true** > Outlook **"Reply to email (V3)"**, Message Id = `messageId`,
     Body = `bodyHtml`, Is HTML on, Reply All off, To = `toLine`, Cc = `ccLine`.
     This is the branch that keeps the thread's real headers - the same
     `In-Reply-To`/`References` the Graph path gets from `createReply`.
   - **false** > Outlook **"Send an email (V2)"**, To = `toLine`, Cc = `ccLine`,
     Subject = `subject`, Body = `bodyHtml`, Is HTML on.
3. **Response** with status 200. Without it the trigger answers 202 and the board
   only learns that the flow accepted the request, not that the mail went.

Build the flow with the connection you want mail sent from - the helpdesk
mailbox. The board sends `messageId` only when the From is `SUPPORT_MAILBOX`,
because a reply from any other mailbox cannot claim that conversation anyway.

**What the board still needs Graph for.** Reading: ticket bodies, attachments,
and the quoted original that goes underneath a reply. That is `Mail.Read` /
`Mail.Read.Shared`, which is already consented. If that read fails the reply is
still sent, without the quote, rather than failing.

## Giving the board a mailbox of its own

`KANBAN_MAILBOX` is the address the board sends *its own* mail from - password
resets and feedback reports. It does not affect replies to clients.

That split is the point. A reply must come from `SUPPORT_MAILBOX`: it is the
address the client has been corresponding with, and the only one whose reply
keeps the thread's real headers. A password reset is the opposite kind of mail -
the board talking to its own team - and it does not belong in a client-facing
mailbox's Sent Items. Unset, that mail sends as whichever identity last
connected Outlook, which means the From address on a password reset changes
depending on who signed in last week.

```
KANBAN_MAILBOX=kanban@quinta.im
```

**Which kind of mailbox to create.** It depends on which send path you use:

- **With `MAIL_WEBHOOK_URL` (the flow):** a **shared mailbox** is enough, and
  shared mailboxes need no licence. Build the flow with a licensed account that
  has Send As on it, and set the "From (Send as)" field in "Send an email (V2)"
  to the shared mailbox. Nothing signs in as the board.
- **On the Graph path:** the mailbox must either have Send As granted to the
  connected identity, or the board must be connected to Outlook *as* that
  mailbox - which needs a licensed account, because a shared mailbox cannot sign
  in interactively.

Connecting the board as its own account is also what fixes the "last person to
connect owns the sending identity" problem described below: nobody's personal
sign-in overwrites it, because it is not a person.

**What it does not do.** It does not remove the need for a permission. A mailbox
is an address, not an authorisation - it still needs either the `Mail.Send`
consent or the flow. And do not grant this mailbox Send As on the helpdesk
mailbox: that hands back exactly the blast radius that keeping them separate was
meant to remove.

## Which address a reply is sent from, and why one is refused

The composer offers three kinds of From address:

- **the signed-in agent's own mailbox** - `sfa@quinta.im` for SFA. Taken from
  their Kanban account's email when it has one, otherwise derived from the
  trigram. Full-name and `admin`/`owner` logins get nothing derived, since those
  are not mailbox names; give those accounts an email in Users to offer one.
- **the helpdesk mailbox** (`SUPPORT_MAILBOX`), which is the default. It is the
  sender the client has been corresponding with, and the only one whose reply
  keeps the thread's real headers - see below.
- **anything in `REPLY_FROM_ADDRESSES`**, for shared aliases no account is named
  after.

Threading differs between them, and the composer says which applies before
anything is typed. A reply **from the helpdesk mailbox** is drafted with Graph's
`createReply` on the actual message, so it carries the conversation id,
`In-Reply-To` and `References` and the client's mail app files it under the
thread they started. A reply **from any other mailbox** cannot reproduce those -
Graph will not let a draft in one mailbox claim another's conversation - so it
goes out as a new `Re:` mail with the quoted original, which clients group by
subject. That is exactly what replying from a personal mailbox in Outlook would
do.

**None of this applies when `MAIL_WEBHOOK_URL` is set** - the flow owns the From
address and the Send As question goes away with it. The rest of this section is
about the Graph path.

**Why a send is refused.** There is one Outlook connection for the whole board:
every send is made by whichever identity last signed in to Microsoft here. That
identity can send as its own mailbox and as any mailbox Exchange grants it
Send As on - nothing else. So a refusal means one of:

1. the connection predates the `Mail.Send` / `Mail.Send.Shared` scopes and holds
   a token without them. Both are in the default `M365_SCOPES` now; reconnect
   Outlook so consent is granted again, and grant tenant admin consent first if
   the tenant requires it.
2. the chosen From is a mailbox the connected identity has no Send As right on.
   Either grant it in Exchange, or have that agent connect Outlook themselves -
   the session's own tokens are preferred over the shared ones, so their own
   mailbox then needs no grant at all.

The composer marks the one address that is certain to work (the connected
account) and names the connected identity in the error, so which of the two it
is should be visible without reading logs.

**One caveat worth knowing.** Signing in to Microsoft stores the tokens in that
agent's session *and* overwrites the board's shared connection, so the last
person to connect becomes the identity used by every session that has none of
its own. That is long-standing behaviour, not new here, but it is what decides
whose mailbox an unauthenticated-to-Graph session sends as.

## Turning the Feedback button's notifications on

Two settings and one consent, and a button that proves whether they worked.

**0. Or skip the consent entirely.** If `MAIL_WEBHOOK_URL` is set (see the
section above), the report's email leg goes through that flow and none of the
Outlook consent below applies - the Feedback button works on a deployment whose
Outlook connection is broken, which is the deployment most likely to need it.
Everything below is for the Graph path.

**1. Outlook (email).** Nothing to set unless the address changes -
`FEEDBACK_EMAIL` defaults to `sfa@quinta.im,sgu@quinta.im,ahk@quinta.im`, and
takes any comma-separated list. What it needs is the `Mail.Send`
consent: the report is sent through `/me/sendMail`, so the identity the board is
connected to Outlook as must hold a token carrying that scope. A connection made
before the reply composer shipped does not. **Sign in to Microsoft again on the
board** (the same reconnect the reply composer needs - one covers both), and if
the tenant requires admin consent for the app, grant that first.

Check the boot log before anything else. If it says

```
[m365] M365_CLIENT_SECRET is a GUID, which means it is the client secret ID
```

then no token can be issued at all on that environment and nothing Graph-backed
works - ticket bodies included. Renew the secret in Azure (App registrations >
Certificates & secrets > New client secret > copy the **Value** column, not the
ID) before reconnecting.

**2. Teams.** Set `FEEDBACK_WEBHOOK_URL`. The supported way to get one:

- In Teams, open the channel you want the reports in.
- **... > Workflows > "Post to a channel when a webhook request is received"**.
- Complete the template; it hands you an HTTP POST URL.
- Put that URL in `FEEDBACK_WEBHOOK_URL` and restart.

To notify SFA, SGU and AHK specifically rather than just the channel, add an
**@mention** action for each of the three in that same flow before the post
step, and put the mention tokens in the message - the webhook payload carries
their report, but who gets pinged is the flow's decision, not the board's.

Use Workflows rather than the old **Connectors > Incoming Webhook**: Microsoft
has retired Office 365 connectors in Teams. The payload still carries the
MessageCard shape an old connector consumed, so an existing one keeps working
until it is switched off, but new ones cannot be created.

Nothing else needs configuring for either kind of endpoint. One request body
carries an Adaptive Card in `attachments` (which the Workflows template posts),
a MessageCard at the top level (which a connector renders), and the same fields
flat - `category`, `message`, `reporter`, `reporterEmail`, `context` - for a flow
of your own to read.

**3. Prove it.** Open the Feedback modal as an admin and press **Test delivery**.
It sends one canned report and reports each leg separately, for example:

```
email to sfa@quinta.im sent - Teams webhook posted
email failed (graph_error_403:...) - no Teams webhook configured
```

The full Graph or webhook error also goes to the browser console, which is the
part worth pasting into a ticket. Nothing is stored for a test and no report is
invented - it is a real send of an obviously-labelled test message.

If a leg fails: a 403 on the email means the consent above is missing or the
chosen mailbox is refused; a webhook error means the URL is wrong, the flow is
off, or the flow rejected the body.

## Where feedback from the Feedback button goes

Three things happen to one report, independently, so that no single failure
loses it:

1. **It is recorded first**, before any delivery is attempted, in the `SyncLog`
   table with `provider = 'feedback'`. List them with
   `SELECT "createdAt", "syncType", status, message FROM "SyncLog" WHERE provider = 'feedback' ORDER BY "createdAt" DESC;`
   or in `npm run db:studio`. The row's `status` ends up `delivered` or
   `stored_only`, and its metadata records which channel worked - so a report
   nobody ever received is findable rather than indistinguishable from one that
   was read and ignored.
2. **It is emailed** to every address in `FEEDBACK_EMAIL` (default
   `sfa@quinta.im,sgu@quinta.im,ahk@quinta.im`) - one mail with all of them on
   it, so a reply is visible to the others - from the
   mailbox the board is connected to Outlook as, via `/me/sendMail` - so it
   needs no Send As grant anywhere, only the `Mail.Send` scope the reply
   composer already needs. Reply-To is the reporter, so answering the mail
   answers them.
3. **It is posted to `FEEDBACK_WEBHOOK_URL`** if one is set, which is how it
   reaches Teams. The payload is both a MessageCard (a Teams incoming webhook
   renders it with no flow in between) and the same fields flat at the top level
   (a Power Automate flow can read `category`, `message`, `reporter`,
   `context`), so either kind of URL works. Empty by default: no webhook, no
   Teams, and no error.

The reporter is told which of the three happened. A report that was recorded but
not emailed says so ("recorded, but it could not be emailed yet") rather than
showing a success it did not earn.

Each report carries the view, build, browser, screen size, theme and the open
ticket, collected in the browser and clamped server-side. That context is shown
in the modal before sending, so nobody has to take on trust what is attached.

Feedback is deliberately not a Prisma model of its own: a new table is a
migration, and a migration is a deploy step that can leave the button returning
500 on an environment that has not run it. If a feedback inbox in the UI is
wanted later, that is the point to add the table.

## A ticket has no email in Outlook

Tickets raised on the board by hand have no Outlook message, and occasionally
Graph returns no `webLink` for one that does. "Open in Outlook" used to
disappear for those; it now reads **Create in Outlook** and offers to create the
missing mail as a **draft** - subject, client and description filled in, nothing
sent - then opens it. The draft is created in the connected account's mailbox
(falling back to the agent's own address, then the helpdesk), because that is
the mailbox the board can certainly write to and the agent can certainly open.

The link is remembered on the ticket afterwards, so the button goes straight to
that draft for everyone from then on rather than offering to create a second
one.

## Tickets open with no formatting and no images

Symptom: opening a ticket shows one run-together paragraph of plain text, no
inline pictures, and the board otherwise works normally.

That is the Microsoft 365 connection failing, not a rendering bug. The board
itself (tickets, notes, assignment, SLA, KPIs) is served from our own database
and keeps working, so only the message body - which is fetched live from Graph -
disappears. Since the last change the modal says which failure it hit and offers
the action that fixes that particular one; before that it silently fell back to
the flattened `bodyPreview`.

Check the credential first:

```bash
npm run check:m365
```

* **`invalid_client` / AADSTS7000215 / AADSTS7000222** - the app's own client
  secret is wrong or expired. Reconnecting Outlook in the app cannot fix this.
  Azure portal -> App registrations -> this app -> Certificates & secrets ->
  New client secret -> copy the **Value** column into `M365_CLIENT_SECRET` and
  restart.

  `M365_CLIENT_SECRET` must be the secret **Value**, never the **Secret ID**.
  Azure shows both next to each other and only the Value is a credential. The ID
  is a GUID, so a 36-character hex-and-dashes value is always wrong - the server
  now says so at boot, and `npm run check:m365` refuses it outright. Client
  secrets also expire (6, 12 or 24 months), which is the usual way this breaks
  on a system that had been working.

* **`invalid_grant` / AADSTS70008x** - the secret is fine and the stored refresh
  token has expired or been revoked. Sign in again at `/auth/microsoft/start`.

* **HTTP 429/503/504** - Graph throttling. The server already retries these with
  backoff, and the pictures are fetched separately so a throttled attachment
  call no longer discards the whole message.

## Important security note

The uploaded ZIP contained a `.env` file. Rotate the Neon password and any Microsoft/HubSpot secrets before production deployment.
