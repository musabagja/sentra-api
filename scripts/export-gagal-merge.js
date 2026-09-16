/**
 * Export the rows of a sold-sales file that cannot be merged, split into two sheets
 * with Indonesian headings for the team that has to correct them. Ready rows are
 * excluded on purpose - this file is only the work list.
 *
 *   node scripts/export-gagal-merge.js "<sales.xlsx>" [out.xlsx] [--prod]
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
const OUT = args[1] || IN.replace(/\.xlsx$/i, '') + ' - GAGAL MERGE.xlsx';

(async () => {
  const wb = xlsx.read(fs.readFileSync(IN));
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' });

  const seen = new Set(); const parsed = [];
  rows.forEach((r, i) => {
    const iccid = String(r.ICCID ?? '').trim();
    if (!iccid || seen.has(iccid)) return;
    seen.add(iccid);
    parsed.push({ baris: i + 2, iccid, msisdn: String(r.MSISDN ?? '').trim(), toko: String(r.STORE_CODE ?? '').trim() });
  });

  const cards = [];
  for (const c of chunk(parsed.map(r => r.iccid)))
    cards.push(...await prisma.card.findMany({ where: { key: { in: c } },
      select: { key: true, status: true, checkpointCode: true, batchCode: true } }));
  const cardMap = new Map(cards.map(c => [c.key, c]));
  const cpMap = new Map((await prisma.checkpoint.findMany({ select: { code: true, name: true, type: true } }))
    .map(c => [c.code, c]));

  const JENIS = { DC: 'Gudang / DC', STORE: 'Toko', HQ: 'Kantor Pusat' };
  const bedaLokasi = [], tokoTidakAda = [];

  for (const r of parsed) {
    const card = cardMap.get(r.iccid);
    if (!card) continue;
    const tujuan = cpMap.get(r.toko);
    const posisi = cpMap.get(card.checkpointCode);

    if (!tujuan) {
      tokoTidakAda.push({
        'BARIS DI FILE': r.baris,
        'ICCID': r.iccid,
        'MSISDN': r.msisdn,
        'KODE TOKO DI FILE': r.toko,
        'LOKASI KARTU SAAT INI': card.checkpointCode,
        'NAMA LOKASI SAAT INI': posisi?.name ?? '',
        'MASALAH': `Kode toko "${r.toko}" tidak terdaftar di sistem`,
        'TINDAKAN': 'Perbaiki KODE TOKO pada file penjualan menjadi kode toko yang terdaftar, lalu upload ulang'
      });
      continue;
    }
    if (card.checkpointCode === r.toko) continue;   // sudah cocok, tidak perlu diperbaiki

    bedaLokasi.push({
      'BARIS DI FILE': r.baris,
      'ICCID': r.iccid,
      'MSISDN': r.msisdn,
      'KODE TOKO DI FILE': r.toko,
      'NAMA TOKO DI FILE': tujuan.name,
      'LOKASI KARTU SAAT INI': card.checkpointCode,
      'NAMA LOKASI SAAT INI': posisi?.name ?? '',
      'JENIS LOKASI SAAT INI': JENIS[posisi?.type] ?? (posisi?.type ?? ''),
      'STATUS KARTU': card.status,
      'BATCH UPLOAD': card.batchCode,
      'MASALAH': `Kartu masih tercatat di ${card.checkpointCode}, bukan di ${r.toko}`,
      'TINDAKAN': `Distribusikan kartu dari ${card.checkpointCode} ke ${r.toko}, atau perbaiki KODE TOKO pada file penjualan`
    });
  }

  bedaLokasi.sort((a, b) => a['BARIS DI FILE'] - b['BARIS DI FILE']);
  tokoTidakAda.sort((a, b) => a['BARIS DI FILE'] - b['BARIS DI FILE']);

  const out = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(out, xlsx.utils.json_to_sheet(bedaLokasi), 'LOKASI KARTU BEDA');
  xlsx.utils.book_append_sheet(out, xlsx.utils.json_to_sheet(tokoTidakAda), 'KODE TOKO TIDAK ADA');
  xlsx.writeFile(out, OUT);

  console.log('written:', OUT);
  console.log('LOKASI KARTU BEDA  :', bedaLokasi.length);
  console.log('KODE TOKO TIDAK ADA:', tokoTidakAda.length);
  console.log('total gagal        :', bedaLokasi.length + tokoTidakAda.length);
  await prisma.$disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
