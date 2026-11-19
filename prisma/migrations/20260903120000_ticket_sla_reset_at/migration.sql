-- Every new message in a ticket's thread restarts its SLA clock.
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "slaResetAt" TIMESTAMP(3);
