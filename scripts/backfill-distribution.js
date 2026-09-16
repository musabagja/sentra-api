/**
 * Backfill completed distributions from a spreadsheet of already-delivered ICCIDs.
 *
 *   node scripts/backfill-distribution.js "<file.xlsx>"                  # dry run, dev
 *   node scripts/backfill-distribution.js "<file.xlsx>" --apply
 *   node scripts/backfill-distribution.js "<file.xlsx>" --prod --apply
 *
 * Reproduces the end state of DistributionController.submitDistribution for cards that
 * were physically delivered but never recorded: a DELIVERED Distribution per
 * source->target pair with its items and submittance, cards moved to the target, TRANSFER
 * movements, and adjusted stock.
 *
 * Deviation from the live flow: stock is written as ONE aggregated snapshot per
 * checkpoint rather than one per distribution. A DC feeding hundreds of targets would
 * otherwise produce hundreds of snapshots whose intermediate arithmetic is wrong.
 *
 * Expected columns: ICCID, "STORE CODE DISTRIBUSI".
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

const fs = require('fs');
const xlsx = require('xlsx');
const prisma = require('../lib/prisma').default;

const APPLY = process.argv.includes('--apply');
const FILE = process.argv.slice(2).find(a => !a.startsWith('--'));
if (!FILE) { console.error('Usage: backfill-distribution.js <file.xlsx> [--prod] [--apply]'); process.exit(1); }

const chunk = (a, n) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };
const n = v => v.toLocaleString('en-US');

(async () => {
  const target = `${(url.match(/:\/\/([^;]+)/) || [])[1]} / ${(url.match(/database=([^;]+)/) || [])[1]}`;
  console.log(`${APPLY ? '== APPLY ==' : '== DRY RUN (pass --apply to write) =='}  target: ${target}` +
              `${PROD ? '  *** PRODUCTION ***' : ''}`);

  const wb = xlsx.read(fs.readFileSync(FILE));
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' });

  const seen = new Set(); const parsed = [];
  const skipped = { duplicateInFile: 0, noIccid: 0 };
  for (const r of rows) {
    const iccid = String(r.ICCID ?? r.iccid ?? '').trim();
    const to    = String(r['STORE CODE DISTRIBUSI'] ?? r.TARGET ?? '').trim();
    if (!iccid) { skipped.noIccid++; continue; }
    if (seen.has(iccid)) { skipped.duplicateInFile++; continue; }
    seen.add(iccid);
    parsed.push({ iccid, to });
  }

  const cards = [];
  for (const c of chunk(parsed.map(r => r.iccid), 500))
    cards.push(...await prisma.card.findMany({
      where: { key: { in: c } }, select: { id: true, key: true, status: true, checkpointCode: true }
    }));
  const cardMap = new Map(cards.map(c => [c.key, c]));
  // SQL Server collation is case-insensitive, so "Apollo28" and "APOLLO28" are the same
  // checkpoint. Compare the same way or valid stores look missing.
  const cps = new Set((await prisma.checkpoint.findMany({ select: { code: true } })).map(c => c.code.toUpperCase()));

  // Group the movable cards by source -> target; each pair becomes one Distribution.
  const pairs = new Map();
  const report = { total: parsed.length, notFound: 0, targetUnknown: 0, alreadyAtTarget: 0, notVerified: 0, movable: 0 };
  for (const r of parsed) {
    const card = cardMap.get(r.iccid);
    if (!card) { report.notFound++; continue; }
    if (!cps.has(r.to.toUpperCase())) { report.targetUnknown++; continue; }
    if (card.checkpointCode.toUpperCase() === r.to.toUpperCase()) { report.alreadyAtTarget++; continue; }
    if (card.status !== 'VERIFIED') { report.notVerified++; continue; }
    const key = `${card.checkpointCode} ${r.to}`;
    if (!pairs.has(key)) pairs.set(key, { from: card.checkpointCode, to: r.to, cards: [] });
    pairs.get(key).cards.push(card);
    report.movable++;
  }

  // Net stock movement per checkpoint across every pair.
  const delta = new Map();
  for (const p of pairs.values()) {
    delta.set(p.from, (delta.get(p.from) ?? 0) - p.cards.length);
    delta.set(p.to,   (delta.get(p.to)   ?? 0) + p.cards.length);
  }

  console.log(`  rows=${n(report.total)} movable=${n(report.movable)} ` +
              `alreadyAtTarget=${n(report.alreadyAtTarget)} targetUnknown=${n(report.targetUnknown)} ` +
              `notVerified=${n(report.notVerified)} notFound=${n(report.notFound)}`);
  console.log(`  distributions to create: ${n(pairs.size)} | checkpoints touched: ${n(delta.size)}`);
  if (!APPLY || report.movable === 0) { await prisma.$disconnect(); return; }

  const owner = (await prisma.uploadBatch.findFirst({ orderBy: { id: 'desc' } }))?.userCode
             || (await prisma.user.findFirst({ where: { status: 'ACTIVE' } })).code;
  const now = new Date();
  const stamp = now.toISOString().slice(0, 10).replace(/-/g, '');
  let made = 0;

  for (const p of pairs.values()) {
    const keys = p.cards.map(c => c.key);
    const ids  = p.cards.map(c => c.id);

    await prisma.$transaction(async (tx) => {
      const dist = await tx.distribution.create({
        data: {
          sourceCode: p.from, targetCode: p.to, batch: `BACKFILL-${stamp}`,
          amount: keys.length, status: 'DELIVERED', userCode: owner,
          scheduledAt: now, completedAt: now
        }
      });
      await tx.distributionSubmittance.create({
        data: { distributionID: dist.id, userCode: owner,
                note: 'Backfilled from delivered-ICCID report; goods already received at store' }
      });
      for (const part of chunk(keys, 400))
        await tx.distributionItem.createMany({ data: part.map(k => ({ itemKey: k, distributionID: dist.id })) });
      for (const part of chunk(ids, 300))
        await tx.cardMovement.createMany({
          data: part.map(id => ({ cardID: id, type: 'TRANSFER', userCode: owner,
                                  sourceCode: p.from, targetCode: p.to }))
        });
      for (const part of chunk(keys, 1000))
        await tx.card.updateMany({ where: { key: { in: part } },
                                   data: { checkpointCode: p.to, status: 'VERIFIED' } });
    }, { timeout: 180000, maxWait: 30000 });

    made++;
    if (made % 250 === 0) console.log(`  distributions: ${made}/${pairs.size}`);
  }

  // One aggregated stock snapshot per affected checkpoint.
  for (const [code, d] of delta) {
    const latest = await prisma.cardStock.findFirst({ where: { checkpointCode: code }, orderBy: { createdAt: 'desc' } });
    await prisma.cardStock.create({
      data: { checkpointCode: code, amount: Math.max(0, Number(latest?.amount ?? 0) + d) }
    });
  }

  console.log(`done: ${n(report.movable)} cards moved via ${n(pairs.size)} distributions, ` +
              `${n(delta.size)} stock snapshots`);
  await prisma.$disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
