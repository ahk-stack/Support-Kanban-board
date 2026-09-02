ALTER TABLE "Ticket" ADD COLUMN "csAgent" TEXT;

CREATE INDEX "Ticket_assignedAgent_idx" ON "Ticket"("assignedAgent");
CREATE INDEX "Ticket_csAgent_idx" ON "Ticket"("csAgent");
