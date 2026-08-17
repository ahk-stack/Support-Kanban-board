-- A ticket marked as a duplicate of another one. NULL means "not a duplicate";
-- a non-null value holds the externalId of the ticket it duplicates.
--
-- The KPI dashboard treats duplicates as inbox noise rather than work: they are
-- excluded from resolved counts, throughput and SLA compliance, and reported
-- under their own heading. Before this existed, resolving a duplicate was
-- indistinguishable from resolving a genuine ticket and inflated every
-- resolved-ticket figure on the board.
ALTER TABLE "Ticket" ADD COLUMN "duplicateOfExternalId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "duplicateMarkedAt" TIMESTAMP(3);
ALTER TABLE "Ticket" ADD COLUMN "duplicateMarkedBy" TEXT;

CREATE INDEX "Ticket_duplicateOfExternalId_idx" ON "Ticket"("duplicateOfExternalId");
