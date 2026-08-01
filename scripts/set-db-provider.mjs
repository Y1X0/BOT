#!/usr/bin/env node
/**
 * Rewrites the datasource `provider` in prisma/schema.prisma to match the
 * DATABASE_PROVIDER env var (sqlite | postgresql). Prisma does not allow
 * env() for the provider, so we patch it before generate/migrate/deploy.
 * This is what makes the data layer portable across SQLite and PostgreSQL.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const provider = (process.env.DATABASE_PROVIDER || 'sqlite').trim();
const allowed = ['sqlite', 'postgresql'];

if (!allowed.includes(provider)) {
  console.error(`❌ DATABASE_PROVIDER must be one of ${allowed.join(', ')} (got "${provider}")`);
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaPath = join(__dirname, '..', 'prisma', 'schema.prisma');

const original = readFileSync(schemaPath, 'utf8');
const updated = original.replace(
  /(datasource\s+db\s*\{[\s\S]*?provider\s*=\s*)"(sqlite|postgresql)"/,
  `$1"${provider}"`,
);

if (updated !== original) {
  writeFileSync(schemaPath, updated);
  console.log(`✔ Prisma datasource provider set to "${provider}"`);
} else {
  console.log(`✔ Prisma datasource provider already "${provider}"`);
}
