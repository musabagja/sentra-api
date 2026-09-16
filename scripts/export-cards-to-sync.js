/**
 * From a sold-sales file, emit the cards that fail because they sit at the wrong
 * checkpoint, shaped like the delivered-ICCID report so they can be fed straight into
 * scripts/backfill-distribution.js. Syncing them to the selling store is what unblocks
 * merge activation.
 *
 *   node scripts/export-cards-to-sync.js "<sales.xlsx>" [out.xlsx] [--prod]
 */
require('tsx/cjs');
const DEV_HOST = '10.145.25.233:14300';
const PROD = process.argv.includes('--prod');
require('dotenv').config({ path: PROD ? '.env' : '.env.test', override: true });
const url = process.env.DATABASE_URL || '';
if (!PROD && !url.includes(DEV_HOST)) { console.error('Not the development database.'); process.exit(1); }

const fs = require('fs');
const xlsx = require('xlsx');
const prisma = require('../lib/prisma').default;
const chunk = (a, n = 500) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

const args = process.argv.slice(2).filter(a => !a.startsWith('--'));
const IN = args[0];
const OUT = args[1] || IN.replace(/\.xlsx$/i, '') + ' - TO SYNC.xlsx';

(async () => {
  console.log('source db:', (url.match(/database=([^;]+)/) || [])[1]);
  const wb = xlsx.read(fs.readFileSync(IN));
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' });

  const seen = new Set(); const parsed = [];
  rows.forEach((r, i) => {
    const iccid = String(r.ICCID ?? '').trim();
    if (!iccid || seen.has(iccid)) return;
    seen.add(iccid);
    parsed.push({ row: i + 2, iccid, msisdn: String(r.MSISDN ?? '').trim(), store: String(r.STORE_CODE ?? '').trim() });
  });

  const cards = [];
  for (const c of chunk(parsed.map(r => r.iccid)))
    cards.push(...await prisma.card.findMany({ where: { key: { in: c } },
      select: { key: true, status: true, checkpointCode: true } }));
  const cardMap = new Map(cards.map(c => [c.key, c]));
  const cpMap = new Map((await prisma.checkpoint.findMany({ select: { code: true, name: true, type: true } }))
    .map(c => [c.code, c]));

  const toSync = [], cannot = [];
  for (const r of parsed) {
    const card = cardMap.get(r.iccid);
    if (!card) continue;
    const target = cpMap.get(r.store);
    if (!target) {
      cannot.push({ ROW: r.row, ICCID: r.iccid, MSISDN: r.msisdn, STORE_CODE_IN_SALES_FILE: r.store,
        CARD_IS_AT: card.checkpointCode,
        REASON: 'Store code in the sales file is not a checkpoint',
        WHAT_TO_DO: 'Correct the store code in the sales file, then re-export this sync list' });
      continue;
    }
    if (card.checkpointCode === r.store) continue;   // already in the right place
    if (card.status !== 'VERIFIED') {
      cannot.push({ ROW: r.row, ICCID: r.iccid, MSISDN: r.msisdn, STORE_CODE_IN_SALES_FILE: r.store,
        CARD_IS_AT: card.checkpointCode, REASON: `Card status is ${card.status}`,
        WHAT_TO_DO: 'Validate the card into stock first' });
      continue;
    }
    toSync.push({
      NO: toSync.length + 1,
      ICCID: r.iccid,
      'STORE CODE DISTRIBUSI': r.store,
      'STORE NAME DISTRIBUSI': target.name,
      CURRENT_LOCATION: card.checkpointCode,
      CURRENT_LOCATION_TYPE: cpMap.get(card.checkpointCode)?.type ?? '',
      SALES_FILE_ROW: r.row
    });
  }

  const out = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(out, xlsx.utils.json_to_sheet(toSync), 'TO SYNC');
  if (cannot.length) xlsx.utils.book_append_sheet(out, xlsx.utils.json_to_sheet(cannot), 'CANNOT SYNC');
  xlsx.writeFile(out, OUT);

  const byType = {};
  toSync.forEach(r => { byType[r.CURRENT_LOCATION_TYPE || '?'] = (byType[r.CURRENT_LOCATION_TYPE || '?'] || 0) + 1; });
  console.log('written:', OUT);
  console.log('TO SYNC:', toSync.length, '| CANNOT SYNC:', cannot.length);
  console.log('cards currently held at, by checkpoint type:', JSON.stringify(byType));
  await prisma.$disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
