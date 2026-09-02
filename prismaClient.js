require('dotenv/config');

const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

// emailBody/emailBodyImages are omitted everywhere by default, and opted back
// in explicitly by the one route that serves them. They are the only columns
// on Ticket big enough to matter, and the board lists tickets with include:
// {...}, which returns every scalar - so without this a cached body on each
// row would be added to a list response that is already megabytes before
// compression. Opting in is a visible choice at the call site; opting out
// would be a silent omission nobody would notice until the payload grew.
const prisma = new PrismaClient({
  adapter,
  omit: { ticket: { emailBody: true, emailBodyImages: true } }
});

module.exports = prisma;