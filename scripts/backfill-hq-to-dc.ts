/**
 * One-off backfill: document an HQ01 -> DC leg for cards that were actually
 * uploaded directly at their DC (see scripts/backfill-distributed-iccid.ts).
 *
 * Why: dashboardSync's distributedToDC figure and getDCDistributionChart
 * (src/controllers/stock.controller.ts:51-54, :219-269) are derived *only*
 * from Distribution rows whose target is a DC. Since these cards never went
 * through a real HQ->DC shipment, that figure sits at 0. The user has
 * explicitly asked for — and confirmed she understands — a backfilled
 * Distribution record stating HQ01 shipped these cards to each DC, purely so
 * the dashboard chart shows a spread. This is documented as a backfill, not
 * a real logged shipment (see the DistributionSubmittance.note below).
 *
 * This script deliberately does NOT touch:
 *   - CardMovement (the existing INITIAL row already correctly documents
 *     each card entering the system at its DC; adding a fictional TRANSFER
 *     here would contradict that and break the movement-count invariants
 *     the original backfill already verified)
 *   - Card.checkpointCode / status / validatedAt (already correct — these
 *     cards are already VERIFIED at their final store)
 *   - CardStock (nothing about current stock changes)
 *
 * It only inserts Distribution + DistributionItem + DistributionSubmittance
 * rows, dated before the existing DC-verify timestamp so the three legs
 * (HQ->DC, DC verify, DC->store) read in a sane chronological order.
 *
 * Per-DC card counts are derived LIVE from CardMovement (type: 'INITIAL',
 * userCode: <backfill user>) rather than hardcoded, so this stays correct if
 * more backfill batches are added later.
 *
 * Usage:
 *   npx tsx scripts/backfill-hq-to-dc.ts --user=<userCode> [--commit]
 * Defaults to --dry-run (no writes) unless --commit is passed.
 */

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';

// Same dedicated-client rationale as backfill-distributed-iccid.ts: this
// remote SQL Server needs a longer request timeout than Prisma's default.
function createBackfillPrismaClient(): PrismaClient {
  const provider = (process.env.DATABASE_PROVIDER || 'sqlserver').toLowerCase();
  const url = process.env.DATABASE_URL!;
  if (provider === 'sqlserver') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaMssql } = require('@prisma/adapter-mssql') as typeof import('@prisma/adapter-mssql');
    const withoutScheme = url.replace(/^sqlserver:\/\//, '');
    const segments = withoutScheme.split(';');
    const hostPort = segments[0] ?? '';
    const parts = segments.slice(1);
    const colonIdx = hostPort.lastIndexOf(':');
    const server = colonIdx > 0 ? hostPort.slice(0, colonIdx) : hostPort;
    const port = colonIdx > 0 ? parseInt(hostPort.slice(colonIdx + 1)) : 1433;
    const params: Record<string, string> = {};
    for (const part of parts) {
      const eqIdx = part.indexOf('=');
      if (eqIdx > 0) params[part.slice(0, eqIdx).toLowerCase()] = part.slice(eqIdx + 1);
    }
    const adapter = new PrismaMssql({
      server: server || '',
      port,
      database: params['database'] ?? params['initial catalog'] ?? '',
      user: params['user'] ?? params['user id'] ?? '',
      password: params['password'] ?? '',
      options: {
        encrypt: params['encrypt'] !== 'false',
        trustServerCertificate: params['trustservercertificate'] === 'true'
      },
      requestTimeout: Number(process.env.BACKFILL_REQUEST_TIMEOUT_MS) || 90000,
      connectionTimeout: Number(process.env.BACKFILL_CONNECTION_TIMEOUT_MS) || 30000
    });
    return new PrismaClient({ adapter });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaPg } = require('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

const prisma = createBackfillPrismaClient();

const CHUNK_SIZE = 200;
const TX_OPTS = {
  timeout: Number(process.env.BACKFILL_TX_TIMEOUT_MS) || 120000,
  maxWait: Number(process.env.BACKFILL_TX_MAXWAIT_MS) || 10000
};

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

const HQ_CODE = 'HQ01';
// Before the DC-verify timestamp (2026-07-25T03:00:00Z onward) used by
// backfill-distributed-iccid.ts, so the narrative reads: HQ ships -> DC
// receives/verifies -> DC ships to store. Same calendar day as the real
// card uploads (2026-07-24).
const HQ_LEG_BASE_AT = new Date('2026-07-24T20:00:00.000Z');
const hqLegTimestampFor = (index: number) => new Date(HQ_LEG_BASE_AT.getTime() + index * 1000);

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const p = argv.find(a => a.startsWith(`--${name}=`));
    return p ? p.slice(name.length + 3) : undefined;
  };
  const user = get('user');
  if (!user) throw new Error('--user=<userCode> is required');
  return { user, commit: argv.includes('--commit') };
}

async function main() {
  const { user, commit } = parseArgs();
  console.log(commit ? '*** COMMIT MODE ***' : 'DRY RUN (pass --commit to write)');

  const hq = await prisma.checkpoint.findUnique({ where: { code: HQ_CODE } });
  if (!hq) throw new Error(`Checkpoint ${HQ_CODE} not found`);

  // Per-DC card keys, derived live from the original backfill's own audit
  // trail: the INITIAL movement's targetCode is the DC a card was verified
  // at, and its userCode scopes this to exactly the backfilled cohort (not
  // any real usage elsewhere in the live system).
  const initials = await prisma.cardMovement.findMany({
    where: { type: 'INITIAL', userCode: user },
    select: { cardID: true, targetCode: true }
  });
  if (initials.length === 0) {
    console.log('No INITIAL movements found for this user — nothing to do.');
    await prisma.$disconnect();
    return;
  }

  const cardIds = [...new Set(initials.map(m => m.cardID))];
  const idToKey = new Map<number, string>();
  for (const idChunk of chunk(cardIds, CHUNK_SIZE)) {
    const cards = await prisma.card.findMany({ where: { id: { in: idChunk } }, select: { id: true, key: true } });
    for (const c of cards) idToKey.set(c.id, c.key);
  }

  const byDC = new Map<string, string[]>();
  for (const m of initials) {
    const key = idToKey.get(m.cardID);
    if (!key || !m.targetCode) continue;
    const arr = byDC.get(m.targetCode);
    if (arr) arr.push(key); else byDC.set(m.targetCode, [key]);
  }

  const dcCodes = [...byDC.keys()].sort();
  console.log(`Found ${cardIds.length} backfilled cards across ${dcCodes.length} DCs:`);
  for (const dc of dcCodes) console.log(`  ${dc}: ${byDC.get(dc)!.length}`);
  console.log(`Total: ${[...byDC.values()].reduce((s, a) => s + a.length, 0)}`);

  const lastDistribution = await prisma.distribution.findFirst({ orderBy: { id: 'desc' } });
  let nextId = lastDistribution?.batch ? parseInt(lastDistribution.batch.replace('DV-', '')) + 1 : 1;

  console.log(`\n=== Creating HQ01 -> DC distributions ===`);
  let index = 0;
  for (const dc of dcCodes) {
    const keys = byDC.get(dc)!;

    const existing = await prisma.distribution.findFirst({
      where: { sourceCode: HQ_CODE, targetCode: dc, status: { not: 'CANCELLED' } }
    });
    if (existing) {
      console.log(`  ${HQ_CODE}->${dc}: already exists (id ${existing.id}), skipping`);
      continue;
    }

    const at = hqLegTimestampFor(index);
    index++;
    const batch = `DV-${nextId}`;
    console.log(`  ${HQ_CODE}->${dc}: ${keys.length} cards -> ${batch} @ ${at.toISOString()}`);
    if (!commit) { nextId++; continue; }
    nextId++;

    await prisma.$transaction(async (tx) => {
      const distribution = await tx.distribution.create({
        data: {
          sourceCode: HQ_CODE,
          targetCode: dc,
          batch,
          amount: keys.length,
          status: 'DELIVERED',
          userCode: user,
          createdAt: at,
          scheduledAt: at,
          completedAt: at
        }
      });

      for (const keyChunk of chunk(keys, CHUNK_SIZE)) {
        await tx.distributionItem.createMany({
          data: keyChunk.map(itemKey => ({ itemKey, distributionID: distribution.id, createdAt: at }))
        });
      }

      await tx.distributionSubmittance.create({
        data: {
          distributionID: distribution.id,
          userCode: user,
          note: 'Backfill: documents cards already present at this DC at upload time; no physical HQ->DC shipment occurred',
          createdAt: at
        }
      });
    }, TX_OPTS);
  }

  if (commit) {
    console.log('\n=== Verification ===');
    const dcDists = await prisma.distribution.findMany({
      where: { sourceCode: HQ_CODE, target: { type: 'DC' } },
      select: { targetCode: true, amount: true, status: true }
    });
    const byTarget: Record<string, number> = {};
    for (const d of dcDists) byTarget[d.targetCode] = (byTarget[d.targetCode] ?? 0) + d.amount;
    console.log('HQ01->DC distributions by target:', byTarget);
    console.log('Total:', Object.values(byTarget).reduce((a, b) => a + b, 0));
    const notDelivered = dcDists.filter(d => d.status !== 'DELIVERED');
    if (notDelivered.length > 0) throw new Error(`${notDelivered.length} HQ01->DC distributions are not DELIVERED`);

    for (const dc of dcCodes) {
      const expected = byDC.get(dc)!.length;
      const actual = byTarget[dc] ?? 0;
      if (actual !== expected) throw new Error(`Mismatch for ${dc}: expected ${expected}, got ${actual}`);
    }
    console.log('All per-DC totals match the live CardMovement-derived counts.');
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
