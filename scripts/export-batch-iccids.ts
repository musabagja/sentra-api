/**
 * Export all ICCIDs (Card rows) belonging to a given UploadBatch.code to CSV/XLSX.
 * Read-only.
 *
 * Usage:
 *   npx tsx scripts/export-batch-iccids.ts --batch=UP4 [--format=csv|xlsx] [--out=<path>]
 */

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import * as xlsx from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

function createPrismaClient(): PrismaClient {
  const provider = (process.env.DATABASE_PROVIDER || 'sqlserver').toLowerCase();
  const url = process.env.DATABASE_URL!;
  if (provider === 'sqlserver') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { PrismaMssql } = require('@prisma/adapter-mssql') as typeof import('@prisma/adapter-mssql');
    const withoutScheme = url.replace(/^sqlserver:\/\//, '');
    const segments = withoutScheme.split(';');
    const hostPort = segments[0] ?? '';
    const parts = segments.slice(1);
    const colonIdx = hostPort.lastIndexOf(':');
    const server = colonIdx > 0 ? hostPort.slice(0, colonIdx) : hostPort;
    const port = colonIdx > 0 ? parseInt(hostPort.slice(colonIdx + 1)) : 1433;
    const params: Record<string, string> = {};
    for (const part of parts) {
      const eqIdx = part.indexOf('=');
      if (eqIdx > 0) params[part.slice(0, eqIdx).toLowerCase()] = part.slice(eqIdx + 1);
    }
    const adapter = new PrismaMssql({
      server: server || '',
      port,
      database: params['database'] ?? params['initial catalog'] ?? '',
      user: params['user'] ?? params['user id'] ?? '',
      password: params['password'] ?? '',
      options: {
        encrypt: params['encrypt'] !== 'false',
        trustServerCertificate: params['trustservercertificate'] === 'true'
      }
    });
    return new PrismaClient({ adapter });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaPg } = require('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

const prisma = createPrismaClient();

function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const p = argv.find(a => a.startsWith(`--${name}=`));
    return p ? p.slice(name.length + 3) : undefined;
  };
  const batch = get('batch');
  if (!batch) throw new Error('--batch=<code> is required');
  const format = (get('format') ?? 'xlsx') as 'csv' | 'xlsx';
  if (!['csv', 'xlsx'].includes(format)) throw new Error(`--format must be csv or xlsx, got "${format}"`);
  const out = get('out') ?? path.join(process.cwd(), 'scratchpad', `${batch}-iccids.${format}`);
  return { batch, format, out };
}

async function main() {
  const { batch, format, out } = parseArgs();

  const uploadBatch = await prisma.uploadBatch.findUnique({ where: { code: batch } });
  if (!uploadBatch) throw new Error(`UploadBatch with code "${batch}" not found`);

  const cards = await prisma.card.findMany({
    where: { batchCode: batch },
    select: {
      key: true,
      name: true,
      status: true,
      checkpointCode: true,
      remark: true,
      createdAt: true,
      updatedAt: true,
      validatedAt: true
    },
    orderBy: { id: 'asc' }
  });

  console.log(`Batch ${batch} (${uploadBatch.name ?? ''}): ${cards.length} cards found`);

  fs.mkdirSync(path.dirname(out), { recursive: true });

  const rows = cards.map(c => ({
    ICCID: c.key,
    Name: c.name ?? '',
    Status: c.status,
    CheckpointCode: c.checkpointCode,
    Remark: c.remark ?? '',
    CreatedAt: c.createdAt.toISOString(),
    UpdatedAt: c.updatedAt.toISOString(),
    ValidatedAt: c.validatedAt ? c.validatedAt.toISOString() : ''
  }));

  if (format === 'csv') {
    const header = Object.keys(rows[0] ?? { ICCID: '', Name: '', Status: '', CheckpointCode: '', Remark: '', CreatedAt: '', UpdatedAt: '', ValidatedAt: '' });
    const escape = (v: string) => `"${v.replace(/"/g, '""')}"`;
    const csv = [header.join(',')]
      .concat(rows.map(r => header.map(h => escape(String((r as any)[h]))).join(',')))
      .join('\n');
    fs.writeFileSync(out, csv);
  } else {
    const ws = xlsx.utils.json_to_sheet(rows);
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
    xlsx.writeFile(wb, out);
  }

  console.log(`Wrote ${rows.length} rows to ${out}`);
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
