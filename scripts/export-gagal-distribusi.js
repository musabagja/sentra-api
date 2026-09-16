/**
 * Export the rows of a delivered-ICCID file that could NOT be recorded as distributions.
 * Indonesian headings, ready rows excluded.
 *
 *   node scripts/export-gagal-distribusi.js "<terdistribusi.xlsx>" [out.xlsx] [--prod]
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
const OUT = args[1] || IN.replace(/\.xlsx$/i, '') + ' - GAGAL DISTRIBUSI.xlsx';

(async () => {
  const wb = xlsx.read(fs.readFileSync(IN));
  const rows = xlsx.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { raw: false, defval: '' });

  const seen = new Set(); const parsed = [];
  rows.forEach((r, i) => {
    const iccid = String(r.ICCID ?? '').trim();
    if (!iccid) return;
    const dup = seen.has(iccid);
    seen.add(iccid);
    parsed.push({ baris: i + 2, no: String(r.NO ?? ''), iccid, dup,
                  toko: String(r['STORE CODE DISTRIBUSI'] ?? '').trim(),
                  namaToko: String(r['STORE NAME DISTRIBUSI'] ?? '').trim() });
  });

  const cards = [];
  for (const c of chunk([...seen]))
    cards.push(...await prisma.card.findMany({ where: { key: { in: c } },
      select: { key: true, status: true, checkpointCode: true, batchCode: true } }));
  const cardMap = new Map(cards.map(c => [c.key, c]));
  const cpMap = new Map((await prisma.checkpoint.findMany({ select: { code: true, name: true } }))
    .map(c => [c.code.toUpperCase(), c]));

  const gagal = [];
  const kodeTokoRusak = new Map();
  for (const r of parsed) {
    if (r.dup) continue;
    const card = cardMap.get(r.iccid);
    const posisi = card ? cpMap.get(card.checkpointCode.toUpperCase()) : null;

    let masalah = null, tindakan = null;
    if (!card) {
      masalah = 'ICCID tidak terdaftar di sistem';
      tindakan = 'Periksa kembali nomor ICCID, atau upload batch stoknya terlebih dahulu';
    } else if (!cpMap.has(r.toko.toUpperCase())) {
      masalah = `Kode toko tujuan "${r.toko}" tidak terdaftar di sistem`;
      tindakan = 'Perbaiki KODE TOKO DISTRIBUSI menjadi kode toko yang terdaftar, lalu upload ulang';
      kodeTokoRusak.set(r.toko, (kodeTokoRusak.get(r.toko) ?? 0) + 1);
    } else if (card.status !== 'VERIFIED' && card.checkpointCode.toUpperCase() !== r.toko.toUpperCase()) {
      masalah = `Status kartu ${card.status}, belum bisa didistribusikan`;
      tindakan = 'Validasi kartu di lokasi asalnya terlebih dahulu';
    } else {
      continue; // sudah terdistribusi atau memang sudah di tujuan
    }

    gagal.push({
      'BARIS DI FILE': r.baris,
      'NO': r.no,
      'ICCID': r.iccid,
      'KODE TOKO DISTRIBUSI': r.toko,
      'NAMA TOKO DI FILE': r.namaToko,
      'LOKASI KARTU SAAT INI': card?.checkpointCode ?? '',
      'NAMA LOKASI SAAT INI': posisi?.name ?? '',
      'STATUS KARTU': card?.status ?? '',
      'BATCH UPLOAD': card?.batchCode ?? '',
      'MASALAH': masalah,
      'TINDAKAN': tindakan
    });
  }
  gagal.sort((a, b) => a['BARIS DI FILE'] - b['BARIS DI FILE']);

  const ringkas = [...kodeTokoRusak.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([kode, n]) => ({ 'KODE TOKO TIDAK DIKENAL': kode, 'JUMLAH BARIS': n,
                           'TINDAKAN': 'Tentukan kode toko yang benar untuk kode ini' }));

  const out = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(out, xlsx.utils.json_to_sheet(gagal), 'GAGAL DISTRIBUSI');
  xlsx.utils.book_append_sheet(out, xlsx.utils.json_to_sheet(ringkas), 'DAFTAR KODE TOKO');
  xlsx.writeFile(out, OUT);

  console.log('written:', OUT);
  console.log('GAGAL DISTRIBUSI:', gagal.length, '| kode toko tidak dikenal:', kodeTokoRusak.size);
  await prisma.$disconnect();
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
