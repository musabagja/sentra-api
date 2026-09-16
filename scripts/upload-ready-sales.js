/**
 * Upload the READY TO UPLOAD sheet of a report workbook to /api/stock/upload/sold-xlsx.
 *
 *   node scripts/upload-ready-sales.js "<workbook.xlsx>"            # development
 *   node scripts/upload-ready-sales.js "<workbook.xlsx>" --prod     # production
 *
 * Large files exceed the endpoint's default 120s transaction budget, so set
 * UPLOAD_TX_TIMEOUT_MS well above it. Reports persisted counts from a fresh read
 * rather than trusting the response body.
 */
require('tsx/cjs');
const PROD = process.argv.includes('--prod');
require('dotenv').config({ path: PROD ? '.env' : '.env.test', override: true });
process.env.NODE_ENV = 'test';

const fs = require('fs');
const xlsx = require('xlsx');
const request = require('supertest');
const prisma = require('../lib/prisma').default;
const JWT = require('../src/utils/jwt.util').default;
const app = require('../app').default;

const FILE = process.argv.slice(2).find(a => !a.startsWith('--'));
const url = process.env.DATABASE_URL || '';

(async () => {
  console.log('target:', (url.match(/:\/\/([^;]+)/) || [])[1], (url.match(/database=([^;]+)/) || [])[1]);

  // Upload only the rows classified as ready; the rest are reported separately.
  const src = xlsx.read(fs.readFileSync(FILE));
  const ready = xlsx.utils.sheet_to_json(src.Sheets['READY TO UPLOAD'], { raw: false, defval: '' })
    .map(r => ({ ICCID: String(r.ICCID), MSISDN: String(r.MSISDN), STORE_CODE: String(r.STORE_CODE) }));
  console.log('rows to upload:', ready.length);

  const ws = xlsx.utils.json_to_sheet(ready, { header: ['ICCID', 'MSISDN', 'STORE_CODE'] });
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'My Sheet');
  const buf = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });

  const before = {
    merges: await prisma.merge.count(),
    sold: await prisma.card.count({ where: { status: 'SOLD' } }),
    numbers: await prisma.number.count()
  };
  console.log('before:', JSON.stringify(before));

  const circles = await prisma.checkpointCircle.groupBy({ by: ['circleCode'], _count: { checkpointCode: true } });
  circles.sort((a, b) => b._count.checkpointCode - a._count.checkpointCode);
  const user = await prisma.user.findFirst({ where: { circleCode: circles[0].circleCode, status: 'ACTIVE' } });

  const t0 = Date.now();
  const res = await request(app).post('/api/stock/upload/sold-xlsx')
    .set('Cookie', ['access_token=' + JWT.sign({ code: user.code }, { expiresIn: '2h' })])
    .attach('source', buf, 'sold.xlsx');
  console.log('HTTP', res.status, '(' + ((Date.now() - t0) / 1000).toFixed(1) + 's)');
  if (res.status === 200) console.log('data:', JSON.stringify(res.body.data));
  else console.log(res.body.message.split('\n').slice(0, 6).join('\n'));

  const after = {
    merges: await prisma.merge.count(),
    sold: await prisma.card.count({ where: { status: 'SOLD' } }),
    numbers: await prisma.number.count()
  };
  console.log('after (fresh read):', JSON.stringify(after));
  console.log('delta merges:', after.merges - before.merges, '| delta SOLD:', after.sold - before.sold,
              '| delta numbers:', after.numbers - before.numbers);
  await prisma.$disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
