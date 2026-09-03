/**
 * Turn a rejected sold-xlsx upload into a workbook the business team can act on.
 *
 *   node scripts/report-sold-upload-issues.js "<input.xlsx>" ["<output.xlsx>"]
 *
 * Read-only. Classifies every row using the same rules as StockController.uploadSoldExcel
 * and writes one sheet per issue, plus the rows that are ready to upload as-is.
 */
require('tsx/cjs');
require('dotenv').config({ path: '.env.test', override: true });

const fs = require('fs');
const xlsx = require('xlsx');
const prisma = require('../lib/prisma').default;

const IN = process.argv[2];
const OUT = process.argv[3] || IN.replace(/\.xlsx$/i, '') + ' - ISSUES.xlsx';
if (!IN) { console.error('Usage: report-sold-upload-issues.js <input.xlsx> [output.xlsx]'); process.exit(1); }

const chunk = (a, n = 500) => { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; };

(async () => {
  const wb = xlsx.read(fs.readFileSync(IN));
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' });

  // Row number as seen in Excel, so the team can find it in the original file.
  const parsed = rows.map((r, i) => ({
    row: i + 2,
    iccid: String(r.ICCID ?? '').trim(),
    msisdn: String(r.MSISDN ?? '').trim(),
    store: String(r.STORE_CODE ?? '').trim()
  }));

  const cards = [];
  for (const c of chunk(parsed.map(r => r.iccid).filter(Boolean)))
    cards.push(...await prisma.card.findMany({
      where: { key: { in: c } },
      select: { key: true, status: true, checkpointCode: true, validatedAt: true, batchCode: true }
    }));
  const cardMap = new Map(cards.map(c => [c.key, c]));

  const cps = await prisma.checkpoint.findMany({ select: { code: true, type: true, name: true } });
  const cpMap = new Map(cps.map(c => [c.code, c]));

  const mismatch = [], unknownStore = [], notVerified = [], notFound = [], duplicate = [], valid = [];
  const seen = new Map();

  for (const r of parsed) {
    const card = cardMap.get(r.iccid);
    const here = card ? cpMap.get(card.checkpointCode) : null;
    const base = { ROW: r.row, ICCID: r.iccid, MSISDN: r.msisdn, STORE_CODE_IN_FILE: r.store };

    if (!r.iccid) continue;
    if (seen.has(r.iccid)) {
      duplicate.push({ ...base, FIRST_SEEN_ON_ROW: seen.get(r.iccid),
        ACTION: 'Remove the duplicate row — only the first occurrence is processed' });
      continue;
    }
    seen.set(r.iccid, r.row);

    if (!card) {
      notFound.push({ ...base, ACTION: 'ICCID is not in the system — check the number, or upload the stock first' });
      continue;
    }
    if (!cpMap.has(r.store)) {
      unknownStore.push({ ...base, CARD_IS_AT: card.checkpointCode,
        ACTION: 'STORE_CODE does not exist as a checkpoint — correct the store code' });
      continue;
    }
    if (card.status !== 'VERIFIED') {
      notVerified.push({ ...base, CARD_STATUS: card.status, CARD_IS_AT: card.checkpointCode,
        UPLOAD_BATCH: card.batchCode,
        ACTION: 'Card has not been validated into stock yet — validate it before recording a sale' });
      continue;
    }
    if (card.checkpointCode !== r.store) {
      mismatch.push({ ...base,
        CARD_IS_AT: card.checkpointCode,
        CARD_LOCATION_TYPE: here?.type ?? 'UNKNOWN',
        CARD_LOCATION_NAME: here?.name ?? '',
        UPLOAD_BATCH: card.batchCode,
        ACTION: here?.type === 'DC'
          ? `Card is still in ${card.checkpointCode} — distribute it to ${r.store} before recording the sale`
          : `Card is held at ${card.checkpointCode} — transfer it to ${r.store}, or correct STORE_CODE`
      });
      continue;
    }
    valid.push({ ROW: r.row, ICCID: r.iccid, MSISDN: r.msisdn, STORE_CODE: r.store });
  }

  const summary = [
    { ISSUE: 'Card still at another location', SHEET: 'CHECKPOINT MISMATCH', ROWS: mismatch.length,
      WHAT_TO_DO: 'Distribute/transfer the card to the selling store, or fix STORE_CODE' },
    { ISSUE: 'Store code does not exist',      SHEET: 'UNKNOWN STORE',       ROWS: unknownStore.length,
      WHAT_TO_DO: 'Correct the STORE_CODE to a real checkpoint' },
    { ISSUE: 'Card not validated into stock',  SHEET: 'NOT VERIFIED',        ROWS: notVerified.length,
      WHAT_TO_DO: 'Validate the card at its checkpoint first' },
    { ISSUE: 'ICCID unknown to the system',    SHEET: 'ICCID NOT FOUND',     ROWS: notFound.length,
      WHAT_TO_DO: 'Check the ICCID, or upload the stock batch first' },
    { ISSUE: 'Duplicate ICCID in this file',   SHEET: 'DUPLICATES',          ROWS: duplicate.length,
      WHAT_TO_DO: 'Remove duplicate rows' },
    { ISSUE: 'Ready to upload',                SHEET: 'READY TO UPLOAD',     ROWS: valid.length,
      WHAT_TO_DO: 'These rows pass every check' }
  ];

  const out = xlsx.utils.book_new();
  const add = (name, data) => {
    if (!data.length) return;
    xlsx.utils.book_append_sheet(out, xlsx.utils.json_to_sheet(data), name);
  };
  xlsx.utils.book_append_sheet(out, xlsx.utils.json_to_sheet(summary), 'SUMMARY');
  add('CHECKPOINT MISMATCH', mismatch);
  add('UNKNOWN STORE', unknownStore);
  add('NOT VERIFIED', notVerified);
  add('ICCID NOT FOUND', notFound);
  add('DUPLICATES', duplicate);
  add('READY TO UPLOAD', valid);

  xlsx.writeFile(out, OUT);
  console.log('written:', OUT);
  console.table(summary);
  await prisma.$disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
