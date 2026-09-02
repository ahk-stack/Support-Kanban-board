require('dotenv/config');

// bcryptjs, not the native bcrypt: server.js verifies every login with
// bcryptjs, so using it here too means one bcrypt implementation instead of
// two (the native one needs a compiler at install time). The formats are
// interchangeable - bcryptjs reads the $2b$ hashes this script wrote before.
const bcrypt = require('bcryptjs');
const { PrismaClient } = require('@prisma/client');
const { PrismaPg } = require('@prisma/adapter-pg');

const adapter = new PrismaPg({
  connectionString: process.env.DATABASE_URL,
});

const prisma = new PrismaClient({ adapter });

async function main() {
  const username = process.env.KANBAN_USER || 'admin';
  const plainPassword = process.env.KANBAN_PASS || 'change-me-now';

  const passwordHash = await bcrypt.hash(plainPassword, 10);

  const user = await prisma.user.upsert({
    where: { username },
    update: {
      passwordHash,
      role: 'admin',
      displayName: 'Admin',
      isActive: true,
    },
    create: {
      username,
      passwordHash,
      role: 'admin',
      displayName: 'Admin',
      isActive: true,
    },
  });

  console.log('Admin user ready:', user.username);
}

main()
  .catch((error) => {
    console.error(error);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });