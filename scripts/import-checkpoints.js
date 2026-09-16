/**
 * Import new store checkpoints from the master-data spreadsheet.
 *
 *   node scripts/import-checkpoints.js "<master.xlsx>" [--prod] [--apply]
 *
 * Columns: code | type (holds the store NAME) | circle | sub circle | dealer code.
 * Every checkpoint is created as type STORE and linked to its regional circle plus HQ,
 * matching how every existing store is wired.
 */
require('tsx/cjs');
const DEV_HOST = '10.145.25.233:14300';
const PROD = process.argv.includes('--prod');
require('dotenv').config({ path: PROD ? '.env' : '.env.test', override: true });
const url = process.env.DATABASE_URL || '';
if (!PROD && !url.includes(DEV_HOST)) { console.error('Not the development database.'); process.exit(1); }
if (PROD && url.includes(DEV_HOST)) { console.error('--prod given but URL is dev.'); process.exit(1); }

const fs = require('fs');
const xlsx = require('xlsx');
const prisma = require('../lib/prisma').default;
const APPLY = process.argv.includes('--apply');
const FILE = process.argv.slice(2).find(a => !a.startsWith('--'));

// "sub circle" in the sheet is finer-grained than the Circle table, so it is folded
// onto the circle codes that actually exist.
const CIRCLE = {
  'EAST JAVA': 'EAST JAVA',
  'CENTRAL JAVA': 'CENTRAL JAVA',
  'WEST JAVA': 'WEST JAVA',
  'BALI NUSRA': 'BALINUSRA',
  'INNER JAKARTA': 'JAKARTA',
  'OUTER JAKARTA': 'JAKARTA',
  'KALIMANTAN': 'KALIMANTAN',
  'SULAWESI': 'SUMAPA',
  'CENTRAL SUMATERA': 'SUMATERA',
  'NORTH SUMATERA': 'SUMATERA',
  'SOUTH SUMATERA': 'SUMATERA'
};

(async () => {
  console.log(`${APPLY ? '== APPLY ==' : '== DRY RUN =='}  db: ${(url.match(/database=([^;]+)/) || [])[1]}` +
              `${PROD ? '  *** PRODUCTION ***' : ''}`);

  const rows = xlsx.utils.sheet_to_json(xlsx.read(fs.readFileSync(FILE)).Sheets['Sheet1'], { raw: false, defval: '' });
  // SQL Server collation is case-insensitive, so "Apollo21" and "APOLLO21" are the same
  // row as far as the unique index is concerned. Compare the same way.
  const existing = new Set(
    (await prisma.checkpoint.findMany({ select: { code: true } })).map(c => c.code.toUpperCase())
  );
  const circles = new Set((await prisma.circle.findMany({ select: { code: true } })).map(c => c.code));

  const toCreate = [], skipped = [], unmapped = [];
  for (const r of rows) {
    const code = String(r.code).trim();
    const name = String(r.type).trim();
    const sub  = String(r['sub circle']).trim().toUpperCase();
    if (!code) continue;
    if (existing.has(code.toUpperCase())) { skipped.push(code); continue; }
    const circle = CIRCLE[sub];
    if (!circle || !circles.has(circle)) { unmapped.push(`${code} (sub circle "${sub}")`); continue; }
    toCreate.push({ code, name, circle });
  }

  const perCircle = {};
  toCreate.forEach(c => { perCircle[c.circle] = (perCircle[c.circle] ?? 0) + 1; });
  console.log(`  akan dibuat: ${toCreate.length} | sudah ada: ${skipped.length} | circle tidak dikenal: ${unmapped.length}`);
  console.log('  per circle:', JSON.stringify(perCircle));
  if (unmapped.length) console.log('  belum terpetakan:', unmapped.join(', '));
  if (!APPLY || toCreate.length === 0) { await prisma.$disconnect(); return; }

  await prisma.checkpoint.createMany({ data: toCreate.map(c => ({ code: c.code, type: 'STORE', name: c.name })) });
  // Regional circle plus HQ, the same pairing every existing store has.
  await prisma.checkpointCircle.createMany({
    data: toCreate.flatMap(c => [
      { checkpointCode: c.code, circleCode: c.circle },
      { checkpointCode: c.code, circleCode: 'HQ' }
    ])
  });

  console.log(`selesai: ${toCreate.length} checkpoint dibuat, ${toCreate.length * 2} relasi circle`);
  await prisma.$disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
