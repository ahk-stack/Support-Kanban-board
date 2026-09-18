require('dotenv/config');

// Creates (or rotates the token for) the service account the anti-churn n8n
// workflow authenticates as against POST /api/churn-signals/bulk. Run this
// once per environment - the token is a row in that environment's own
// database, so a token seeded against preprod will NOT work against prod
// and vice versa (see server.js's requireScopedApiToken).
//
// Usage:
//   DATABASE_URL=<preprod-or-prod-connection-string> node seed-churn-service-account.js
//
// The printed token is shown ONCE, in plaintext - only its SHA-256 hash is
// stored (same as every other ApiToken in this app). Save it immediately
// (e.g. into the n8n credential store) - re-running this script revokes the
// previous token and issues a new one, it does not print the old one again.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter });

const SERVICE_USERNAME = process.env.CHURN_SERVICE_USERNAME || 'CHURN-ENGINE';
const TOKEN_SCOPE = 'churn_signals';

function hashApiToken(rawToken) {
  return crypto.createHash('sha256').update(String(rawToken || '')).digest('hex');
}

async function main() {
  // The account never logs in via the UI - the password just needs to exist
  // and be unguessable, since passwordHash is a required column. Login is
  // gated by real auth anyway; this account is only ever reached via its
  // scoped API token.
  const randomPassword = crypto.randomBytes(24).toString('base64url');
  const passwordHash = await bcrypt.hash(randomPassword, 10);

  const user = await prisma.user.upsert({
    where: { username: SERVICE_USERNAME },
    update: { isActive: true },
    create: {
      username: SERVICE_USERNAME,
      passwordHash,
      // Role is irrelevant to what this token can do - requireScopedApiToken
      // gates purely on ApiToken.scope, not on the user's role. 'support' is
      // just an existing, already-handled role value, chosen so this row
      // doesn't hit an unfamiliar branch anywhere else in the app.
      role: 'support',
      displayName: 'Churn Engine (service account)',
      isActive: true
    }
  });

  await prisma.apiToken.updateMany({
    where: { userId: user.id, scope: TOKEN_SCOPE, revokedAt: null },
    data: { revokedAt: new Date() }
  });

  const rawToken = `kb_${crypto.randomBytes(32).toString('base64url')}`;
  await prisma.apiToken.create({
    data: {
      userId: user.id,
      tokenHash: hashApiToken(rawToken),
      label: 'Anti-churn n8n workflow',
      scope: TOKEN_SCOPE
    }
  });

  console.log(`Service account ready: ${user.username} (userId ${user.id})`);
  console.log(`Token scope: ${TOKEN_SCOPE}`);
  console.log('');
  console.log('Bearer token (save this now - it will not be shown again):');
  console.log(rawToken);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
