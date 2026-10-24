// Persist the Cloudflare WARP (wireproxy) WireGuard profile in the DB so we
// register with Cloudflare only ONCE ever. The free tier has no persistent
// disk, so without this every deploy would re-register and quickly hit
// Cloudflare's rate limit (HTTP 429), leaving WARP — and thus YouTube
// downloads — down. Used by scripts/start.sh.
//
//   node scripts/warp-profile.mjs get            → prints the saved profile (if any)
//   node scripts/warp-profile.mjs save <file>    → stores <file> as the profile
import { PrismaClient } from '@prisma/client';
import { readFileSync } from 'node:fs';

const KEY = 'warpProfile';
const prisma = new PrismaClient();
const [cmd, arg] = process.argv.slice(2);

try {
  if (cmd === 'get') {
    const row = await prisma.globalConfig.findUnique({ where: { key: KEY } });
    if (row?.value) process.stdout.write(row.value);
  } else if (cmd === 'save' && arg) {
    const value = readFileSync(arg, 'utf8');
    if (value.trim()) {
      await prisma.globalConfig.upsert({
        where: { key: KEY },
        create: { key: KEY, value },
        update: { value },
      });
    }
  } else if (cmd === 'clear') {
    // Drop the saved profile so the next boot registers a fresh WARP account —
    // used to rotate away from an exit IP that YouTube has started blocking.
    await prisma.globalConfig.deleteMany({ where: { key: KEY } });
  }
} catch {
  // Best-effort: on a `get` failure we print nothing, so start.sh registers.
  process.exitCode = 0;
} finally {
  await prisma.$disconnect();
}
