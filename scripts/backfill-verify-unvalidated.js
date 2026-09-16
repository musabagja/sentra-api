/**
 * One-off: bring already-uploaded UNVERIFIED cards into stock, matching the
 * behaviour uploadExcel now has (cards arrive VERIFIED, no separate validation).
 *
 *   node scripts/backfill-verify-unvalidated.js --user=<userCode>            # dry run, dev
 *   node scripts/backfill-verify-unvalidated.js --user=<userCode> --apply
 *   node scripts/backfill-verify-unvalidated.js --user=<userCode> --prod --apply
 *
 * Writes the same four things validateCard would have, per card:
 *   status VERIFIED + validatedAt, an INITIAL CardMovement, one aggregated
 *   CardStock snapshot per checkpoint, and an UploadBatchProgress row per batch.
 * Batches are then marked COMPLETED directly - NOT via completeBatch, which
 * would convert any leftover UNVERIFIED card to LOST.
 */
require('tsx/cjs');

const DEV_HOST = '10.145.25.233:14300';
const PROD = process.argv.includes('--prod');
require('dotenv').config({ path: PROD ? '.env' : '.env.test', override: true });

const url = process.env.DATABASE_URL || '';
if (!PROD && !url.includes(DEV_HOST)) {
  console.error(`Refusing to run: DATABASE_URL is not the development database (${DEV_HOST}).`);
  process.exit(1);
}
if (PROD && url.includes(DEV_HOST)) {
  console.error('--prod was given but DATABASE_URL points at development. Aborting.');
  process.exit(1);
}

const prisma = require('../lib/prisma').default;

const APPLY = process.argv.includes('--apply');
const userArg = process.argv.find(a => a.startsWith('--user='));
if (!userArg) { console.error('Usage: --user=<userCode> [--prod] [--apply]'); process.exit(1); }
const userCode = userArg.slice('--user='.length);

const CHUNK = 500;
const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const n = v => v.toLocaleString('en-US');
const TX = { timeout: 180000, maxWait: 30000 };

(async () => {
  const target = `${(url.match(/:\/\/([^;]+)/) || [])[1]} / ${(url.match(/database=([^;]+)/) || [])[1]}`;
  console.log(`${APPLY ? '== APPLY ==' : '== DRY RUN (pass --apply to write) =='}  target: ${target}${PROD ? '  *** PRODUCTION ***' : ''}`);

  const user = await prisma.user.findUnique({ where: { code: userCode } });
  if (!user) { console.error(`User ${userCode} not found.`); process.exit(1); }
  console.log('attributing to:', user.code, '-', user.name);

  const byCp = await prisma.card.groupBy({ by: ['checkpointCode'], where: { status: 'UNVERIFIED' }, _count: { _all: true } });
  const byBatch = await prisma.card.groupBy({ by: ['batchCode'], where: { status: 'UNVERIFIED' }, _count: { _all: true } });
  const total = byCp.reduce((s, c) => s + c._count._all, 0);
  console.log(`cards to verify: ${n(total)} across ${byCp.length} checkpoints and ${byBatch.length} batches`);
  byCp.sort((a, b) => b._count._all - a._count._all)
      .forEach(c => console.log(`   ${c.checkpointCode.padEnd(12)} ${n(c._count._all)}`));
  if (!APPLY || total === 0) { await prisma.$disconnect(); return; }

  const validatedAt = new Date();
  let verified = 0, moves = 0;

  for (const { checkpointCode } of byCp) {
    // Re-read keys per checkpoint so a re-run only picks up what is still UNVERIFIED.
    const pending = await prisma.card.findMany({
      where: { status: 'UNVERIFIED', checkpointCode },
      select: { id: true, key: true }
    });
    if (pending.length === 0) { console.log(`   ${checkpointCode}: nothing left`); continue; }

    for (const part of chunk(pending, CHUNK)) {
      await prisma.$transaction(async (tx) => {
        const res = await tx.card.updateMany({
          where: { key: { in: part.map(c => c.key) }, status: 'UNVERIFIED' },
          data: { status: 'VERIFIED', validatedAt }
        });
        if (res.count !== part.length) {
          throw new Error(`${checkpointCode}: expected ${part.length} updates, got ${res.count}`);
        }
        await tx.cardMovement.createMany({
          data: part.map(c => ({
            cardID: c.id, type: 'INITIAL', userCode,
            sourceCode: null, targetCode: checkpointCode, createdAt: validatedAt
          }))
        });
        verified += res.count;
        moves += part.length;
      }, TX);
    }

    // One aggregated snapshot per checkpoint, after all its chunks land.
    const latest = await prisma.cardStock.findFirst({ where: { checkpointCode }, orderBy: { id: 'desc' } });
    await prisma.cardStock.create({
      data: { checkpointCode, amount: Number(latest?.amount ?? 0) + pending.length, createdAt: validatedAt }
    });
    console.log(`   ${checkpointCode}: verified ${n(pending.length)}, stock ${n(Number(latest?.amount ?? 0))} -> ${n(Number(latest?.amount ?? 0) + pending.length)}`);
  }

  for (const b of byBatch) {
    const last = await prisma.uploadBatchProgress.findFirst({ where: { batchCode: b.batchCode }, orderBy: { id: 'desc' } });
    await prisma.uploadBatchProgress.create({
      data: { batchCode: b.batchCode, progress: Number(last?.progress ?? 0) + b._count._all, createdAt: validatedAt }
    });
    await prisma.uploadBatch.update({ where: { code: b.batchCode }, data: { status: 'COMPLETED' } });
  }
  console.log(`batches closed: ${byBatch.map(b => b.batchCode).join(', ')}`);

  console.log(`done: ${n(verified)} cards verified, ${n(moves)} INITIAL movements, ${byCp.length} stock snapshots`);
  await prisma.$disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
