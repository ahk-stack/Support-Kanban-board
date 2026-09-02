-- Add production-ready user and ticket database fields
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "isActive" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "emailRaw" JSONB;
CREATE INDEX IF NOT EXISTS "Ticket_senderEmail_idx" ON "Ticket"("senderEmail");
CREATE INDEX IF NOT EXISTS "Ticket_status_idx" ON "Ticket"("status");
CREATE INDEX IF NOT EXISTS "Ticket_createdAt_idx" ON "Ticket"("createdAt");
