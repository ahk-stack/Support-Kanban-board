-- An admin can freeze a ticket's SLA clock. Set while frozen, cleared on release.
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "slaHoldAt" TIMESTAMP(3);
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "slaHoldBy" TEXT;
