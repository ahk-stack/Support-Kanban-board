CREATE TABLE "Template" (
    "id" SERIAL NOT NULL,
    "name" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdByUserId" INTEGER,
    "lastEditedByUserId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Template_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "Template" ADD CONSTRAINT "Template_createdByUserId_fkey" FOREIGN KEY ("createdByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Template" ADD CONSTRAINT "Template_lastEditedByUserId_fkey" FOREIGN KEY ("lastEditedByUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
