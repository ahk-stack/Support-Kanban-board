ALTER TABLE "Ticket" ADD COLUMN "displayNumber" INTEGER;

CREATE SEQUENCE "Ticket_displayNumber_seq";
ALTER SEQUENCE "Ticket_displayNumber_seq" OWNED BY "Ticket"."displayNumber";

-- Backfill existing tickets in creation order (oldest = 1), since the old
-- display number only ever lived in an ephemeral, non-durable file and
-- can't be recovered.
WITH ordered AS (
  SELECT "id", ROW_NUMBER() OVER (ORDER BY "createdAt" ASC, "id" ASC) AS rn
  FROM "Ticket"
)
UPDATE "Ticket" t SET "displayNumber" = ordered.rn
FROM ordered WHERE t.id = ordered.id;

-- Advance the sequence past whatever was just backfilled so new tickets
-- continue numbering from there, not collide with it.
SELECT setval('"Ticket_displayNumber_seq"', COALESCE((SELECT MAX("displayNumber") FROM "Ticket"), 0) + 1, false);

ALTER TABLE "Ticket" ALTER COLUMN "displayNumber" SET DEFAULT nextval('"Ticket_displayNumber_seq"');

CREATE UNIQUE INDEX "Ticket_displayNumber_key" ON "Ticket"("displayNumber");
