-- Cached machine translations of ticket text, one row per
-- (ticket, target language, exact source text).
--
-- The board is a shared inbox that receives mail in whatever language the
-- client writes in. Agents were pasting bodies into an external translator,
-- which took the ticket content out of the tool and off the audit trail. This
-- table backs an in-app per-ticket language switch.
--
-- "sourceHash" is a hash of the exact segments that were translated, which
-- makes the cache self-invalidating: when a new reply is merged into a thread
-- the body changes, the hash changes, and the next request re-translates
-- rather than serving a translation that predates the newest message. The
-- cache is shared across agents on purpose - the second person to open the
-- same French ticket pays nothing.
--
-- Deliberately no foreign key to "Ticket": the board can hold a manual or
-- not-yet-synced ticket with no row there, and a translation is disposable
-- cache rather than ticket data - losing one costs a re-translation, nothing
-- more.
CREATE TABLE "TicketTranslation" (
    "id" SERIAL NOT NULL,
    "ticketExternalId" TEXT NOT NULL,
    "targetLang" TEXT NOT NULL,
    "sourceHash" TEXT NOT NULL,
    "sourceLang" TEXT,
    "sourceLangName" TEXT,
    "segments" JSONB NOT NULL,
    "model" TEXT,
    "usage" JSONB,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TicketTranslation_pkey" PRIMARY KEY ("id")
);

-- The cache lookup key.
CREATE UNIQUE INDEX "TicketTranslation_ticketExternalId_targetLang_sourceHash_key"
    ON "TicketTranslation"("ticketExternalId", "targetLang", "sourceHash");

-- Fetching every cached language for one ticket when a card renders.
CREATE INDEX "TicketTranslation_ticketExternalId_idx" ON "TicketTranslation"("ticketExternalId");

-- Age-based pruning of stale cache rows.
CREATE INDEX "TicketTranslation_createdAt_idx" ON "TicketTranslation"("createdAt");
