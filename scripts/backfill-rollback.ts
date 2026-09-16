/**
 * Undo scripts/backfill-distributed-iccid.ts.
 *
 * Reads scratchpad/backfill-snapshot.json (written by every run of the
 * backfill script, dry or committed) and:
 *   1. Restores every touched Card to its pre-backfill state
 *      (status: 'UNVERIFIED', checkpointCode: its original DC, validatedAt: null).
 *   2. Deletes every row the backfill created in CardMovement, CardStock,
 *      Distribution (+ items + submittance), and UploadBatchProgress.
 *
 * Safety property: the backfill writes every row on a synthetic backdated
 * timeline (2026-07-25 .. 2026-07-26, recorded in the snapshot) that never
 * overlaps real wall-clock activity from the live app. Every delete below is
 * scoped to `userCode = <backfill user>` AND `createdAt` inside that window,
 * so concurrent real usage elsewhere in the system (today's actual date) is
 * never touched, even though these tables had 0 rows before the backfill ran.
 *
 * Usage:
 *   npx tsx scripts/backfill-rollback.ts [--commit]
 * Defaults to --dry-run (report only) unless --commit is passed.
 */

import prisma from '../lib/prisma';
import * as fs from 'fs';
import * as path from 'path';

function loadSnapshot() {
  const file = path.join(process.cwd(), 'scratchpad', 'backfill-snapshot.json');
  if (!fs.existsSync(file)) {
    throw new Error(`No snapshot found at ${file} — nothing to roll back, or backfill-distributed-iccid.ts was never run`);
  }
  return JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    user: string;
    timeline: { verifyAt: string; distributionCreateAt: string; deliveryWindowStart: string; deliveryWindowEnd: string };
    cards: { key: string; sourceCode: string; targetCode: string }[];
  };
}

const CHUNK_SIZE = 500;
function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

async function main() {
  const commit = process.argv.includes('--commit');
  console.log(commit ? '*** ROLLBACK COMMIT MODE ***' : 'DRY RUN (pass --commit to write)');

  const snapshot = loadSnapshot();
  const { user, timeline, cards } = snapshot;
  const windowStart = new Date(timeline.verifyAt);
  const windowEnd = new Date(timeline.deliveryWindowEnd);
  console.log(`Snapshot: ${cards.length} cards, user ${user}, window ${windowStart.toISOString()} .. ${windowEnd.toISOString()}`);

  const createdAtInWindow = { gte: windowStart, lte: windowEnd };
  const keys = cards.map(c => c.key);

  // Count what exists to roll back before touching anything. keys can be up
  // to ~11,000 long, so the "not yet reverted" count must chunk — SQL
  // Server caps query parameters at ~2100 (same limit commit e545bb0 fixed
  // for the upload path).
  let currentlyVerified = 0;
  for (const keyChunk of chunk(keys, CHUNK_SIZE)) {
    currentlyVerified += await prisma.card.count({ where: { key: { in: keyChunk }, status: { not: 'UNVERIFIED' } } });
  }
  const [movementCount, stockCount, distCount, submittanceCount, progressCount] = await Promise.all([
    prisma.cardMovement.count({ where: { userCode: user, createdAt: createdAtInWindow } }),
    prisma.cardStock.count({ where: { createdAt: createdAtInWindow } }),
    prisma.distribution.count({ where: { userCode: user, createdAt: createdAtInWindow } }),
    prisma.distributionSubmittance.count({ where: { userCode: user, createdAt: createdAtInWindow } }),
    prisma.uploadBatchProgress.count({ where: { createdAt: createdAtInWindow } })
  ]);
  console.log({ movementCount, stockCount, distCount, submittanceCount, progressCount, cardsNotYetReverted: currentlyVerified });

  if (!commit) {
    console.log('\nDry run — nothing written. Re-run with --commit to apply.');
    await prisma.$disconnect();
    return;
  }

  // Distributions in-window created by this backfill, with their items.
  const dists = await prisma.distribution.findMany({
    where: { userCode: user, createdAt: createdAtInWindow },
    include: { items: true }
  });
  const distIds = dists.map(d => d.id);

  await prisma.$transaction(async (tx) => {
    if (distIds.length > 0) {
      await tx.distributionSubmittance.deleteMany({ where: { distributionID: { in: distIds } } });
      await tx.distributionItem.deleteMany({ where: { distributionID: { in: distIds } } });
      await tx.distribution.deleteMany({ where: { id: { in: distIds } } });
    }
    await tx.cardMovement.deleteMany({ where: { userCode: user, createdAt: createdAtInWindow } });
    await tx.cardStock.deleteMany({ where: { createdAt: createdAtInWindow } });
    await tx.uploadBatchProgress.deleteMany({ where: { createdAt: createdAtInWindow } });
  }, { timeout: Number(process.env.BACKFILL_TX_TIMEOUT_MS) || 120000, maxWait: Number(process.env.BACKFILL_TX_MAXWAIT_MS) || 10000 });
  console.log(`Deleted ${distIds.length} distributions (+ items/submittances), movements, stock snapshots, and batch progress rows in window.`);

  // Restore every card to its pre-backfill state, chunked.
  let restored = 0;
  for (const group of chunk(cards, CHUNK_SIZE)) {
    // Cards can have different sourceCode values, so restore per distinct source.
    const bySource = new Map<string, string[]>();
    for (const c of group) {
      const arr = bySource.get(c.sourceCode);
      if (arr) arr.push(c.key); else bySource.set(c.sourceCode, [c.key]);
    }
    for (const [sourceCode, keysForSource] of bySource) {
      const result = await prisma.card.updateMany({
        where: { key: { in: keysForSource } },
        data: { status: 'UNVERIFIED', checkpointCode: sourceCode, validatedAt: null }
      });
      restored += result.count;
    }
  }
  console.log(`Restored ${restored} cards to UNVERIFIED at their original checkpoint.`);

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
