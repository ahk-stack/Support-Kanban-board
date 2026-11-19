-- A ticket can be linked to a row of the Velma bug spreadsheet. The id is what
-- the agent typed; the row is the sheet row as it read when the link was made.
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "velmaBugId" TEXT;
ALTER TABLE "Ticket" ADD COLUMN IF NOT EXISTS "velmaBugRow" JSONB;
