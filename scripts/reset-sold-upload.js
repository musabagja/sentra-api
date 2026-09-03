/**
 * Undo sold-xlsx uploads on the DEVELOPMENT database, so an upload can be retried
 * from a clean state. Refuses to run against anything but the dev host.
 *
 *   node scripts/reset-sold-upload.js            # report what it would undo
 *   node scripts/reset-sold-upload.js --apply    # undo it
 *
 * Reverses, in FK-safe order: merges created by the endpoint, the SALE movements and
 * stock snapshots they wrote, the cards' SOLD status, and any auto-created numbers
 * together with their AUTOSOLD batch.
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
const chunk = (a, n = 500) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

(async () => {
  const batches = await prisma.uploadBatch.findMany({ where: { code: { startsWith: 'AUTOSOLD-' } } });
  const autoNumbers = await prisma.number.findMany({
    where: { remark: 'AUTO_CREATED_FROM_SOLD_UPLOAD' }, select: { key: true }
  });
  // Every merge this endpoint writes is stamped verified at creation.
  const merges = await prisma.merge.findMany({
    where: { verifiedAt: { not: null } }, select: { cardKey: true, numberKey: true, checkpointCode: true }
  });

  console.log(APPLY ? '== APPLY ==' : '== DRY RUN (pass --apply to undo) ==');
  console.log(`merges: ${merges.length} | auto-created numbers: ${autoNumbers.length} | AUTOSOLD batches: ${batches.length}`);
  if (merges.length === 0 && autoNumbers.length === 0 && batches.length === 0) {
    console.log('nothing to undo'); await prisma.$disconnect(); return;
  }
  if (!APPLY) { await prisma.$disconnect(); return; }

  const cardKeys = merges.map(m => m.cardKey);
  const numberKeys = autoNumbers.map(n => n.key);
  const checkpoints = [...new Set(merges.map(m => m.checkpointCode).filter(Boolean))];

  const cards = [];
  for (const c of chunk(cardKeys)) cards.push(...await prisma.card.findMany({ where: { key: { in: c } }, select: { id: true } }));
  const cardIDs = cards.map(c => c.id);

  for (const c of chunk(cardKeys)) await prisma.merge.deleteMany({ where: { cardKey: { in: c } } });
  for (const c of chunk(cardIDs))  await prisma.cardMovement.deleteMany({ where: { cardID: { in: c }, type: 'SALE' } });
  for (const c of chunk(cardKeys)) await prisma.card.updateMany({ where: { key: { in: c } }, data: { status: 'VERIFIED' } });

  // Drop the decremented snapshot so each checkpoint's latest row is its pre-sale value.
  for (const code of checkpoints) {
    const latest = await prisma.cardStock.findFirst({ where: { checkpointCode: code }, orderBy: { createdAt: 'desc' } });
    if (latest) await prisma.cardStock.delete({ where: { id: latest.id } });
  }

  for (const c of chunk(numberKeys)) await prisma.number.deleteMany({ where: { key: { in: c } } });
  await prisma.uploadBatch.deleteMany({ where: { code: { startsWith: 'AUTOSOLD-' } } });

  console.log(`undone: ${merges.length} merges, ${cardIDs.length} cards reverted, ` +
              `${numberKeys.length} numbers, ${checkpoints.length} stock snapshots, ${batches.length} batches`);
  await prisma.$disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
