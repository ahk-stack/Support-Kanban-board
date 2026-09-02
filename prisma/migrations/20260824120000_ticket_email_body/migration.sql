-- The message body as Outlook returned it, kept on the ticket.
--
-- Opening a ticket used to call Graph every single time, so the same message
-- was re-fetched on every open by every agent, and what the ticket could show
-- was only ever as good as Graph's mood at that moment. The body is now stored
-- the first time it is successfully loaded, and every later open renders from
-- here without touching Graph at all.
--
-- "emailBodyImages" holds only what the cid: lookup needs - attachment id,
-- contentId, name, content type. Deliberately not the image bytes: those are
-- megabytes of base64 per message and were moved out to an on-demand endpoint
-- on purpose, which this must not undo. Caching the metadata is what lets a
-- cached open still resolve its inline pictures.
--
-- All nullable, so every existing row is already valid: a NULL "emailBody"
-- simply means "not captured yet", which is exactly the pre-existing
-- behaviour - fetch it live, then store it.
ALTER TABLE "Ticket" ADD COLUMN "emailBody" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "emailBodyType" TEXT;
ALTER TABLE "Ticket" ADD COLUMN "emailBodyImages" JSONB;
ALTER TABLE "Ticket" ADD COLUMN "emailBodyAt" TIMESTAMP(3);
