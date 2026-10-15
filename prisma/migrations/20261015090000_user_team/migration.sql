-- Which agent roster a user is on: 'cs', 'support' or NULL (on neither). This
-- is what fills the CS and Support dropdowns, and admins change it in Manage
-- Users. It is separate from the role because an admin can also be an agent
-- (SGU on Support, VGU on CS) and several CS accounts still carry the legacy
-- 'agent' role.
ALTER TABLE "User" ADD COLUMN IF NOT EXISTS "team" TEXT;

-- Seed it from the rosters that used to be hard-coded in index.html and
-- server.js, so the dropdowns are unchanged on the first deploy.
UPDATE "User" SET "team" = 'support'
WHERE "team" IS NULL
  AND UPPER("username") IN ('SGU','ZIO','SFA','MEZ','SHE','JBA','RMD');
UPDATE "User" SET "team" = 'cs'
WHERE "team" IS NULL
  AND UPPER("username") IN ('VGU','NAO','MBH','TBR','IBE','SKE','BKH','JAT','VPO','RKH','AZA','GGO','WPH','JFC','TNY','LGI');
