/**
 * Bulk-verify UNVERIFIED cards in the named upload batches, on DEVELOPMENT only.
 *
 *   node scripts/verify-batch-cards.js UP1 UP4 UP5            # dry run
 *   node scripts/verify-batch-cards.js UP1 UP4 UP5 --apply
 *
 * Mirrors StockController.validateCard's UNVERIFIED -> VERIFIED path: sets validatedAt,
 * records an INITIAL CardMovement, raises CardStock, and appends UploadBatchProgress.
 * Stock is raised once per checkpoint (+N) rather than once per card, which reaches the
 * same end state without writing tens of thousands of snapshot rows.
 * Cards already VERIFIED are left untouched.
 */
require('tsx/cjs');
require('dotenv').config({ path: '.env.test', override: true });

const DEV_HOST = '10.145.25.233:14300';
if (!(process.env.DATABASE_URL || '').includes(DEV_HOST)) {
  console.error(`Refusing to run: DATABASE_URL is not the development database (${DEV_HOST}).`);
  process.exit(1);
}

const prisma = require('../lib/prisma').default;
const APPLY = process.argv.includes('--apply');
const CODES = process.argv.slice(2).filter(a => !a.startsWith('--'));
if (CODES.length === 0) { console.error('Usage: verify-batch-cards.js <BATCH_CODE...> [--apply]'); process.exit(1); }

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

(async () => {
  const batches = await prisma.uploadBatch.findMany({ where: { code: { in: CODES } } });
  const found = batches.map(b => b.code);
  const missing = CODES.filter(c => !found.includes(c));
  if (missing.length) { console.error('Unknown batch code(s):', missing.join(', ')); process.exit(1); }

  const cards = await prisma.card.findMany({
    where: { batchCode: { in: CODES }, status: 'UNVERIFIED' },
    select: { id: true, checkpointCode: true, batchCode: true }
  });

  const perCheckpoint = new Map();
  const perBatch = new Map();
  for (const c of cards) {
    perCheckpoint.set(c.checkpointCode, (perCheckpoint.get(c.checkpointCode) ?? 0) + 1);
    perBatch.set(c.batchCode, (perBatch.get(c.batchCode) ?? 0) + 1);
  }

  console.log(APPLY ? '== APPLY ==' : '== DRY RUN (pass --apply to write) ==');
  for (const b of batches) {
    console.log(`  ${b.code}: ${perBatch.get(b.code) ?? 0} unverified of ${b.total} (owner ${b.userCode})`);
  }
  console.log(`  total to verify: ${cards.length} across ${perCheckpoint.size} checkpoint(s)`);
  if (!APPLY || cards.length === 0) { await prisma.$disconnect(); return; }

  const validatedAt = new Date();
  const ownerByBatch = Object.fromEntries(batches.map(b => [b.code, b.userCode]));

  // 1. INITIAL movements — the card entering stock for the first time.
  let done = 0;
  for (const part of chunk(cards, 300)) {
    await prisma.cardMovement.createMany({
      data: part.map(c => ({
        cardID: c.id, type: 'INITIAL', userCode: ownerByBatch[c.batchCode],
        sourceCode: null, targetCode: c.checkpointCode
      }))
    });
    done += part.length;
    process.stdout.write(`\r  movements: ${done}/${cards.length}   `);
  }
  process.stdout.write('\n');

  // 2. Status + validatedAt.
  done = 0;
  for (const part of chunk(cards.map(c => c.id), 1000)) {
    await prisma.card.updateMany({ where: { id: { in: part } }, data: { status: 'VERIFIED', validatedAt } });
    done += part.length;
    process.stdout.write(`\r  cards verified: ${done}/${cards.length}   `);
  }
  process.stdout.write('\n');

  // 3. One stock snapshot per checkpoint at its previous amount + N.
  for (const [code, n] of perCheckpoint) {
    const latest = await prisma.cardStock.findFirst({ where: { checkpointCode: code }, orderBy: { createdAt: 'desc' } });
    await prisma.cardStock.create({ data: { checkpointCode: code, amount: Number(latest?.amount ?? 0) + n } });
  }

  // 4. Batch progress.
  for (const [code, n] of perBatch) {
    const last = await prisma.uploadBatchProgress.findFirst({ where: { batchCode: code }, orderBy: { id: 'desc' } });
    await prisma.uploadBatchProgress.create({ data: { batchCode: code, progress: (last?.progress ?? 0) + n } });
  }

  console.log(`done: ${cards.length} cards verified at ${validatedAt.toISOString()}, ` +
              `${perCheckpoint.size} stock snapshots, ${perBatch.size} progress rows`);
  await prisma.$disconnect();
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
