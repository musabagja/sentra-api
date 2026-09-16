/**
 * One-off backfill: mark ICCIDs already physically distributed to stores as
 * VERIFIED at their destination store, replicating the exact rule sequence
 * the API enforces (validateCard -> createDistribution -> submitDistribution)
 * instead of writing status/checkpointCode directly.
 *
 * Source: an xlsx export with columns
 *   ICCID | STORE CODE DISTRIBUSI | STORE NAME DISTRIBUSI | DEALER CODE
 *
 * The file carries no dates, so the three stages are backdated onto an
 * explicit synthetic timeline (see TIMELINE below) that sits between the
 * cards' real upload date and today, so initialStock/finalStock dashboard
 * math stays internally consistent.
 *
 * Usage:
 *   npx tsx scripts/backfill-distributed-iccid.ts --file=<path> --user=<userCode> [--commit] [--only=verify|distribute|submit] [--limit=n]
 *
 * Defaults to --dry-run (no writes) unless --commit is passed.
 */

import 'dotenv/config';
import { PrismaClient } from '../generated/prisma/client';
import * as xlsx from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

// A dedicated client, not lib/prisma.ts's shared export: this backfill needs
// a much longer mssql request timeout than the app's default (the driver's
// default is 15s; our multi-hundred-row chunked transactions against a
// remote SQL Server routinely exceed that). Scoped to this script only, so
// the app's own request-timeout behavior is untouched.
function createBackfillPrismaClient(): PrismaClient {
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
      },
      requestTimeout: Number(process.env.BACKFILL_REQUEST_TIMEOUT_MS) || 90000,
      connectionTimeout: Number(process.env.BACKFILL_CONNECTION_TIMEOUT_MS) || 30000
    });
    return new PrismaClient({ adapter });
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { PrismaPg } = require('@prisma/adapter-pg') as typeof import('@prisma/adapter-pg');
  return new PrismaClient({ adapter: new PrismaPg({ connectionString: url }) });
}

const prisma = createBackfillPrismaClient();

// Smaller than the 500-row cap used elsewhere in the app (stock.controller.ts
// uses 500 for a single updateMany/createMany) — each chunk here does several
// round trips (updateMany + findMany + createMany + N progress upserts) *inside
// one held transaction*, so it needs more headroom against the same ~2100
// SQL Server parameter cap and the remote connection's latency.
const CHUNK_SIZE = 200;
// Same convention as stock.controller.ts's uploadExcel — the remote SQL
// Server round-trip is slow enough that Prisma's 5s default interactive
// transaction timeout is too tight for a chunk this size.
const TX_OPTS = {
  timeout: Number(process.env.BACKFILL_TX_TIMEOUT_MS) || 120000,
  maxWait: Number(process.env.BACKFILL_TX_MAXWAIT_MS) || 10000
};

function chunk<T>(arr: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// --- Backdated timeline. All ISO strings so re-runs are deterministic. ---
const VERIFY_AT = new Date('2026-07-25T03:00:00.000Z');
const DISTRIBUTION_CREATE_AT = new Date('2026-07-25T08:00:00.000Z');
const DELIVERY_BASE_AT = new Date('2026-07-26T03:00:00.000Z');
// Each distribution gets its own second so per-checkpoint CardStock rows are
// strictly increasing — the dashboard reads latest-row-wins with no tiebreak.
const deliveryTimestampFor = (index: number) => new Date(DELIVERY_BASE_AT.getTime() + index * 1000);

type Args = {
  file: string;
  user: string;
  commit: boolean;
  only?: 'verify' | 'distribute' | 'submit' | undefined;
  limit?: number | undefined;
};

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (name: string) => {
    const p = argv.find(a => a.startsWith(`--${name}=`));
    return p ? p.slice(name.length + 3) : undefined;
  };
  const file = get('file');
  const user = get('user');
  if (!file) throw new Error('--file=<path> is required');
  if (!user) throw new Error('--user=<userCode> is required');
  const only = get('only') as Args['only'];
  if (only && !['verify', 'distribute', 'submit'].includes(only)) {
    throw new Error(`--only must be one of verify|distribute|submit, got "${only}"`);
  }
  const limitRaw = get('limit');
  return {
    file,
    user,
    commit: argv.includes('--commit'),
    only,
    limit: limitRaw ? Number(limitRaw) : undefined
  };
}

type ExcelRow = { excelRow: number; key: string; store: string; storeName: string; dealer: string };
type Reject = ExcelRow & { reason: 'NOT_IN_DB' | 'CHECKPOINT_NOT_FOUND' | 'STORE_CODE_NAME_CONFLICT' };
type Processable = { key: string; sourceCode: string; targetCode: string };

function loadExcel(file: string): ExcelRow[] {
  const wb = xlsx.readFile(file);
  const sheet = wb.Sheets['Sheet1'];
  if (!sheet) throw new Error(`Sheet1 not found in ${file}`);
  const rows: any[] = xlsx.utils.sheet_to_json(sheet, { raw: false });
  return rows
    .map((r, i) => ({
      excelRow: i + 2, // header is row 1
      key: String(r['ICCID'] ?? '').trim(),
      store: String(r['STORE CODE DISTRIBUSI'] ?? '').trim(),
      storeName: String(r['STORE NAME DISTRIBUSI'] ?? '').trim(),
      dealer: String(r['DEALER CODE'] ?? '').trim()
    }))
    .filter(r => r.key);
}

async function classify(rows: ExcelRow[]) {
  // Dedupe by ICCID (file is already unique, but be defensive)
  const seen = new Set<string>();
  const deduped = rows.filter(r => {
    if (seen.has(r.key)) return false;
    seen.add(r.key);
    return true;
  });

  const keys = deduped.map(r => r.key);
  const found = new Map<string, { status: string; checkpointCode: string; batchCode: string }>();
  for (const c of chunk(keys, CHUNK_SIZE)) {
    const cards = await prisma.card.findMany({
      where: { key: { in: c } },
      select: { key: true, status: true, checkpointCode: true, batchCode: true }
    });
    for (const card of cards) found.set(card.key, card);
  }

  const checkpointCodes = new Set(
    (await prisma.checkpoint.findMany({ select: { code: true } })).map(c => c.code)
  );

  const batches = await prisma.uploadBatch.findMany({
    where: { code: { in: [...new Set([...found.values()].map(c => c.batchCode))] } },
    select: { code: true, status: true }
  });
  const batchStatus = new Map(batches.map(b => [b.code, b.status]));

  const rejects: Reject[] = [];
  const processable: Processable[] = [];
  const alreadyMigratedKeys: string[] = [];

  for (const r of deduped) {
    const card = found.get(r.key);
    if (!card) {
      rejects.push({ ...r, reason: 'NOT_IN_DB' });
      continue;
    }
    if (!checkpointCodes.has(r.store)) {
      rejects.push({ ...r, reason: 'CHECKPOINT_NOT_FOUND' });
      continue;
    }
    if (r.store === 'X171' && /MEDAN/i.test(r.storeName)) {
      rejects.push({ ...r, reason: 'STORE_CODE_NAME_CONFLICT' });
      continue;
    }
    // A prior (possibly partial) run of this same script can have already
    // carried a card all the way to VERIFIED at its target store — that's
    // success, not an anomaly. Skip it from processable rather than
    // re-deriving a source (its checkpointCode is now the target, not the DC).
    if (card.status === 'VERIFIED' && card.checkpointCode === r.store) {
      alreadyMigratedKeys.push(r.key);
      continue;
    }
    // A prior interrupted run can also have left a card mid-pipeline:
    // VERIFIED (step 1 done) or DELIVERY (step 2 done) while still sitting at
    // its original DC (checkpointCode unchanged, since neither step moves it).
    // That's a legitimate resume point, not an anomaly — re-include it with
    // its current checkpointCode as the source; stepVerify/stepDistribute's
    // own status filters make re-processing it a no-op for whatever already
    // completed.
    if ((card.status === 'VERIFIED' || card.status === 'DELIVERY') && card.checkpointCode !== r.store) {
      processable.push({ key: r.key, sourceCode: card.checkpointCode, targetCode: r.store });
      continue;
    }
    // Any other non-UNVERIFIED state (BROKEN, LOST, OPNAME, SOLD, ...) is a
    // genuine anomaly for these specific rows — abort for manual review
    // rather than silently mis-processing.
    if (card.status !== 'UNVERIFIED') {
      throw new Error(`Invariant violated: card ${r.key} expected UNVERIFIED or a known backfill state, found status=${card.status} checkpointCode=${card.checkpointCode}`);
    }
    if (batchStatus.get(card.batchCode) === 'COMPLETED') {
      throw new Error(`Invariant violated: card ${r.key} batch ${card.batchCode} is COMPLETED`);
    }
    if (card.checkpointCode === r.store) {
      throw new Error(`Invariant violated: card ${r.key} source == target (${r.store})`);
    }
    processable.push({ key: r.key, sourceCode: card.checkpointCode, targetCode: r.store });
  }

  // Recover the original source DC for already-migrated cards from their own
  // audit trail (the INITIAL movement's targetCode = the DC they were first
  // verified at) so the ledger can reconcile the FULL 11,000-card set, not
  // just whatever this particular invocation processed.
  let alreadyMigrated: Processable[] = [];
  if (alreadyMigratedKeys.length > 0) {
    const cardRows = await prisma.card.findMany({
      where: { key: { in: alreadyMigratedKeys } },
      select: { id: true, key: true, checkpointCode: true }
    });
    const idToKey = new Map(cardRows.map(c => [c.id, c.key]));
    const keyToTarget = new Map(cardRows.map(c => [c.key, c.checkpointCode]));
    const initials = await prisma.cardMovement.findMany({
      where: { cardID: { in: cardRows.map(c => c.id) }, type: 'INITIAL' },
      select: { cardID: true, targetCode: true }
    });
    const keyToSource = new Map(initials.map(m => [idToKey.get(m.cardID)!, m.targetCode!]));
    alreadyMigrated = alreadyMigratedKeys
      .filter(k => keyToSource.has(k))
      .map(k => ({ key: k, sourceCode: keyToSource.get(k)!, targetCode: keyToTarget.get(k)! }));
    console.log(`${alreadyMigratedKeys.length} cards already fully migrated by a prior run — skipped from processing, included in ledger totals.`);
  }

  return { processable, alreadyMigrated, rejects, batchStatus, found };
}

function writeReports(rejects: Reject[]) {
  const dir = path.join(process.cwd(), 'scratchpad');
  fs.mkdirSync(dir, { recursive: true });

  const rowsCsv = ['excelRow,ICCID,storeCode,storeName,dealerCode,reason']
    .concat(rejects.map(r => `${r.excelRow},${r.key},${r.store},"${r.storeName.replace(/"/g, '""')}",${r.dealer},${r.reason}`))
    .join('\n');
  fs.writeFileSync(path.join(dir, 'backfill-rejects.csv'), rowsCsv);

  const summary = new Map<string, { store: string; storeName: string; dealer: string; reason: string; count: number }>();
  for (const r of rejects) {
    const k = `${r.reason}|${r.store}|${r.storeName}|${r.dealer}`;
    const existing = summary.get(k);
    if (existing) existing.count++;
    else summary.set(k, { store: r.store, storeName: r.storeName, dealer: r.dealer, reason: r.reason, count: 1 });
  }
  const summaryCsv = ['reason,storeCode,storeName,dealerCode,count']
    .concat([...summary.values()]
      .sort((a, b) => b.count - a.count)
      .map(s => `${s.reason},${s.store},"${s.storeName.replace(/"/g, '""')}",${s.dealer},${s.count}`))
    .join('\n');
  fs.writeFileSync(path.join(dir, 'backfill-rejects-summary.csv'), summaryCsv);

  console.log(`Wrote ${rejects.length} rejects to scratchpad/backfill-rejects.csv (+ summary)`);
}

async function stepVerify(processable: Processable[], userCode: string, commit: boolean) {
  const bySource = new Map<string, Processable[]>();
  for (const p of processable) {
    const arr = bySource.get(p.sourceCode);
    if (arr) arr.push(p); else bySource.set(p.sourceCode, [p]);
  }

  console.log(`\n=== Step 1: verify at DC (${processable.length} cards across ${bySource.size} DCs) ===`);

  for (const [sourceCode, cards] of bySource) {
    // Only act on cards still UNVERIFIED — makes the step naturally resumable
    // (and makes the dry-run preview honest about a partially-completed prior
    // run). Chunked: a single DC can hold thousands of keys, well past SQL
    // Server's ~2100 parameter cap for one `IN` list.
    const stillUnverified: string[] = [];
    for (const keyChunk of chunk(cards.map(c => c.key), CHUNK_SIZE)) {
      const found = await prisma.card.findMany({
        where: { key: { in: keyChunk }, status: 'UNVERIFIED' },
        select: { key: true }
      });
      stillUnverified.push(...found.map(c => c.key));
    }

    if (stillUnverified.length === 0) {
      console.log(`  ${sourceCode}: nothing to verify (already done)`);
      continue;
    }

    console.log(`  ${sourceCode}: verifying ${stillUnverified.length} cards`);
    if (!commit) continue;

    for (const keyChunk of chunk(stillUnverified, CHUNK_SIZE)) {
      await prisma.$transaction(async (tx) => {
        const result = await tx.card.updateMany({
          where: { key: { in: keyChunk }, status: 'UNVERIFIED' },
          data: { status: 'VERIFIED', validatedAt: VERIFY_AT }
        });
        if (result.count !== keyChunk.length) {
          throw new Error(`Verify chunk mismatch at ${sourceCode}: expected ${keyChunk.length}, updated ${result.count}`);
        }

        const cardIds = await tx.card.findMany({
          where: { key: { in: keyChunk } },
          select: { id: true, batchCode: true }
        });

        await tx.cardMovement.createMany({
          data: cardIds.map(c => ({
            cardID: c.id,
            type: 'INITIAL',
            userCode,
            sourceCode: null,
            targetCode: sourceCode,
            createdAt: VERIFY_AT
          }))
        });

        // One UploadBatchProgress bump per affected batch, mirroring +1-per-card
        // semantics without one row per card. A batch spans many chunks (and
        // possibly many resumed invocations), each writing its own progress
        // row — getBatch() reads the latest by `orderBy: createdAt desc`
        // (take: 1), so every row for a batch needs a distinct, increasing
        // timestamp, same hazard as the CardStock snapshot above.
        const byBatch = new Map<string, number>();
        for (const c of cardIds) byBatch.set(c.batchCode, (byBatch.get(c.batchCode) ?? 0) + 1);
        for (const [batchCode, count] of byBatch) {
          const priorProgressRows = await tx.uploadBatchProgress.count({ where: { batchCode } });
          const progressAt = new Date(VERIFY_AT.getTime() + priorProgressRows * 1000);
          const last = await tx.uploadBatchProgress.findFirst({
            where: { batchCode },
            orderBy: { id: 'desc' }
          });
          await tx.uploadBatchProgress.create({
            data: { batchCode, progress: (last?.progress ?? 0) + count, createdAt: progressAt }
          });
        }
      }, TX_OPTS);
    }

    // One CardStock snapshot per DC after all its chunks land. Offset the
    // timestamp by how many CardStock rows this DC already has: a DC that
    // gets verified across more than one resumed invocation would otherwise
    // write two rows at the exact same fixed VERIFY_AT, a real tie the
    // dashboard's latest-row-wins read (distinct + orderBy createdAt desc)
    // cannot break deterministically.
    const priorRowCount = await prisma.cardStock.count({ where: { checkpointCode: sourceCode } });
    const at = new Date(VERIFY_AT.getTime() + priorRowCount * 1000);
    const latest = await prisma.cardStock.findFirst({
      where: { checkpointCode: sourceCode },
      orderBy: { id: 'desc' }
    });
    await prisma.cardStock.create({
      data: { checkpointCode: sourceCode, amount: (latest?.amount ?? 0) + stillUnverified.length, createdAt: at }
    });
  }
}

async function stepDistribute(processable: Processable[], userCode: string, commit: boolean) {
  const groups = new Map<string, Processable[]>();
  for (const p of processable) {
    const k = `${p.sourceCode}->${p.targetCode}`;
    const arr = groups.get(k);
    if (arr) arr.push(p); else groups.set(k, [p]);
  }

  console.log(`\n=== Step 2: create distributions (${groups.size} source->target pairs) ===`);

  // DV-<n> generated once, incremented locally — the controller's per-call
  // findFirst({orderBy:{id:'desc'}}) is race-prone across a loop of this size.
  const lastDistribution = await prisma.distribution.findFirst({ orderBy: { id: 'desc' } });
  let nextId = lastDistribution?.batch ? parseInt(lastDistribution.batch.replace('DV-', '')) + 1 : 1;

  const created: { id: number; sourceCode: string; targetCode: string; keys: string[] }[] = [];

  for (const [pairKey, cards] of groups) {
    const [sourceCode, targetCode] = pairKey.split('->') as [string, string];

    // A prior (possibly interrupted) run may have already itemized some of
    // THESE SPECIFIC cards into a distribution for this pair (whole or
    // partial — the pair can have more than one Distribution across resumed
    // runs, just as the real app would create a second one for a later
    // shipment). Only the cards not yet itemized anywhere need a new
    // Distribution here.
    const itemRows = await prisma.distributionItem.findMany({
      where: { itemKey: { in: cards.map(c => c.key) }, distribution: { status: { not: 'CANCELLED' } } },
      select: { itemKey: true, distributionID: true, distribution: { select: { status: true, sourceCode: true, targetCode: true } } }
    });
    const alreadyItemized = new Set(itemRows.map(i => i.itemKey));
    const remaining = cards.filter(c => !alreadyItemized.has(c.key));

    // Any distribution from a prior run that already owns some of these
    // cards but hasn't been submitted yet (SCHEDULED/DELIVERY) must still be
    // picked up so step 3 can finish it — otherwise those cards would be
    // stuck in DELIVERY forever.
    const byDistId = new Map<number, { sourceCode: string; targetCode: string; keys: string[] }>();
    for (const row of itemRows) {
      if (row.distribution.status === 'DELIVERED') continue; // already finished
      const entry = byDistId.get(row.distributionID);
      if (entry) entry.keys.push(row.itemKey);
      else byDistId.set(row.distributionID, { sourceCode: row.distribution.sourceCode, targetCode: row.distribution.targetCode, keys: [row.itemKey] });
    }
    for (const [id, d] of byDistId) {
      console.log(`  ${pairKey}: resuming existing undelivered distribution id ${id} (${d.keys.length} cards)`);
      created.push({ id, sourceCode: d.sourceCode, targetCode: d.targetCode, keys: d.keys });
    }

    if (remaining.length === 0) {
      console.log(`  ${pairKey}: all ${cards.length} cards already itemized in an existing distribution, nothing new to create`);
      continue;
    }
    if (alreadyItemized.size > 0) {
      console.log(`  ${pairKey}: ${alreadyItemized.size}/${cards.length} already itemized, creating a new distribution for the remaining ${remaining.length}`);
    }

    if (!commit) {
      // Dry-run preview only — id is a placeholder so step 3's preview can
      // still show what it would submit; no id is actually reserved.
      created.push({ id: -1, sourceCode, targetCode, keys: remaining.map(c => c.key) });
      nextId++;
      continue;
    }

    const batch = `DV-${nextId}`;
    nextId++;

    const dist = await prisma.$transaction(async (tx) => {
      const keys = remaining.map(c => c.key);
      const result = await tx.card.updateMany({
        where: { key: { in: keys }, status: 'VERIFIED' },
        data: { status: 'DELIVERY' }
      });
      if (result.count !== keys.length) {
        throw new Error(`Distribute mismatch for ${pairKey}: expected ${keys.length}, updated ${result.count}`);
      }

      const distribution = await tx.distribution.create({
        data: {
          sourceCode,
          targetCode,
          batch,
          amount: keys.length,
          status: 'SCHEDULED',
          userCode,
          scheduledAt: DISTRIBUTION_CREATE_AT,
          createdAt: DISTRIBUTION_CREATE_AT
        }
      });

      for (const keyChunk of chunk(keys, CHUNK_SIZE)) {
        await tx.distributionItem.createMany({
          data: keyChunk.map(itemKey => ({ itemKey, distributionID: distribution.id, createdAt: DISTRIBUTION_CREATE_AT }))
        });
      }

      return distribution;
    }, TX_OPTS);

    created.push({ id: dist.id, sourceCode, targetCode, keys: remaining.map(c => c.key) });
  }

  return created;
}

async function stepSubmit(
  distributions: { id: number; sourceCode: string; targetCode: string; keys: string[] }[],
  userCode: string,
  commit: boolean
) {
  console.log(`\n=== Step 3: submit deliveries (${distributions.length} distributions) ===`);

  // Sequential on purpose: each distribution gets its own timestamp so the
  // CardStock snapshots for a given checkpoint stay strictly increasing.
  // Offset by the distribution's own (globally unique, creation-order) id
  // rather than a loop-local counter — a loop-local index restarts at 0 on
  // every resumed invocation, which can collide with a timestamp already
  // written by an earlier interrupted run for the same checkpoint. `id` is
  // stable across resumes since it's never reused. d.id is -1 in dry-run
  // preview mode (no row exists yet); fall back to array position there.
  for (const [idx, d] of distributions.entries()) {
    const current = d.id > 0 ? await prisma.distribution.findUnique({ where: { id: d.id }, select: { status: true } }) : null;
    if (current?.status === 'DELIVERED') {
      console.log(`  DV(${d.id}) ${d.sourceCode}->${d.targetCode}: already delivered, skipping`);
      continue;
    }

    const at = deliveryTimestampFor(d.id > 0 ? d.id : idx);
    console.log(`  DV(${d.id}) ${d.sourceCode}->${d.targetCode}: ${d.keys.length} cards @ ${at.toISOString()}`);
    if (!commit) continue;

    await prisma.$transaction(async (tx) => {
      const holdCount = await tx.card.count({
        where: { key: { in: d.keys }, checkpointCode: d.sourceCode, status: 'DELIVERY' }
      });
      if (holdCount !== d.keys.length) {
        throw new Error(`Submit mismatch for DV(${d.id}): expected ${d.keys.length} DELIVERY cards, found ${holdCount}`);
      }

      const [sourceStock, targetStock] = await Promise.all([
        tx.cardStock.findFirst({ where: { checkpointCode: d.sourceCode }, orderBy: { createdAt: 'desc' } }),
        tx.cardStock.findFirst({ where: { checkpointCode: d.targetCode }, orderBy: { createdAt: 'desc' } })
      ]);
      if (!sourceStock) throw new Error(`Submit for DV(${d.id}): source ${d.sourceCode} has no stock record`);

      await tx.distributionSubmittance.create({
        data: {
          distributionID: d.id,
          userCode,
          note: 'Backfill: physical distribution already completed prior to system upload',
          createdAt: at
        }
      });

      await tx.distribution.update({
        where: { id: d.id },
        data: { status: 'DELIVERED', completedAt: at }
      });

      const cardRecords = await tx.card.findMany({ where: { key: { in: d.keys } }, select: { id: true } });

      await tx.card.updateMany({
        where: { key: { in: d.keys } },
        data: { checkpointCode: d.targetCode, status: 'VERIFIED' }
      });

      await tx.cardMovement.createMany({
        data: cardRecords.map(c => ({
          cardID: c.id,
          type: 'TRANSFER',
          userCode,
          sourceCode: d.sourceCode,
          targetCode: d.targetCode,
          createdAt: at
        }))
      });

      await tx.cardStock.create({
        data: { checkpointCode: d.sourceCode, amount: Math.max(0, sourceStock.amount - d.keys.length), createdAt: at }
      });
      await tx.cardStock.create({
        data: { checkpointCode: d.targetCode, amount: (targetStock?.amount ?? 0) + d.keys.length, createdAt: at }
      });
    }, TX_OPTS);
  }
}

async function printLedger(processable: Processable[]) {
  console.log('\n=== Accountability ledger ===');
  const sourceDCs = new Set(processable.map(p => p.sourceCode));
  const targetStores = new Set(processable.map(p => p.targetCode));
  const pairs = new Set(processable.map(p => `${p.sourceCode}->${p.targetCode}`));
  const n = processable.length;

  // Everything below is scoped to THIS run's cards/pairs, not system-wide
  // totals — the backfill can be (and has been) invoked more than once with
  // different, non-overlapping card sets (e.g. a later corrected-rejects
  // batch), and other cards' VERIFIED/movement/distribution rows are not
  // this invocation's business.
  const keys = processable.map(p => p.key);
  const cardIds: number[] = [];
  for (const keyChunk of chunk(keys, CHUNK_SIZE)) {
    const rows = await prisma.card.findMany({ where: { key: { in: keyChunk } }, select: { id: true } });
    cardIds.push(...rows.map(r => r.id));
  }

  let verified = 0;
  for (const keyChunk of chunk(keys, CHUNK_SIZE)) {
    verified += await prisma.card.count({ where: { key: { in: keyChunk }, status: 'VERIFIED' } });
  }
  let initialMoves = 0, transferMoves = 0;
  for (const idChunk of chunk(cardIds, CHUNK_SIZE)) {
    initialMoves += await prisma.cardMovement.count({ where: { cardID: { in: idChunk }, type: 'INITIAL' } });
    transferMoves += await prisma.cardMovement.count({ where: { cardID: { in: idChunk }, type: 'TRANSFER' } });
  }
  const totalMoves = initialMoves + transferMoves;

  const pairFilter = { OR: [...pairs].map(p => { const [sourceCode, targetCode] = p.split('->') as [string, string]; return { sourceCode, targetCode }; }) };
  const dists = await prisma.distribution.count({ where: pairFilter });
  const delivered = await prisma.distribution.count({ where: { ...pairFilter, status: 'DELIVERED' } });
  const submittances = await prisma.distributionSubmittance.count({ where: { distribution: pairFilter } });
  const stockRows = await prisma.cardStock.count({ where: { checkpointCode: { in: [...sourceDCs, ...targetStores] } } });

  // dists/delivered/submittances/stockRows are NOT asserted against
  // `pairs.size` directly — a resumed run can legitimately split one
  // (source,target) pair across two Distributions (the second created for
  // whatever remained after an earlier interrupted attempt), exactly as the
  // real app would for two separate shipments between the same checkpoints.
  // What must hold is internal consistency: every created distribution was
  // delivered and has exactly one submittance, and dists >= pairs.size
  // (never fewer than one per pair, possibly more).
  const expected = {
    verified: n,
    initialMoves: n,
    transferMoves: n,
    totalMoves: 2 * n
  };
  const actual = { verified, initialMoves, transferMoves, totalMoves };
  console.log('expected:', expected);
  console.log('actual:  ', actual);
  for (const key of Object.keys(expected) as (keyof typeof expected)[]) {
    if (actual[key] !== expected[key]) {
      throw new Error(`Ledger mismatch on ${key}: expected ${expected[key]}, got ${actual[key]}`);
    }
  }

  console.log('distributions:', { dists, delivered, submittances, minExpectedPairs: pairs.size });
  if (dists < pairs.size) throw new Error(`Fewer distributions (${dists}) than distinct source->target pairs (${pairs.size})`);
  if (delivered !== dists) throw new Error(`Not all distributions delivered: ${delivered}/${dists}`);
  if (submittances !== dists) throw new Error(`Submittance count (${submittances}) != distribution count (${dists})`);

  // Not asserted to an exact count: a resumed run can write more than one
  // CardStock increment for the same DC across separate stepVerify
  // invocations (each is numerically correct — cumulative from the latest
  // row — just not exactly "one per DC"). The reconciliation loop below,
  // which checks final amounts and timestamp ordering per checkpoint, is
  // the real invariant; this is just visibility into the row count.
  console.log('stockRows (informational, not asserted under multi-resume):', stockRows);

  // Per-checkpoint stock reconciliation: source DCs must net to 0, target
  // stores must equal the live VERIFIED count at that checkpoint, and every
  // touched checkpoint's CardStock history must be strictly increasing by
  // createdAt (the dashboard reads latest-row-wins with no tiebreak).
  for (const code of [...sourceDCs, ...targetStores]) {
    const history = await prisma.cardStock.findMany({ where: { checkpointCode: code }, orderBy: { createdAt: 'asc' } });
    for (let i = 1; i < history.length; i++) {
      if (history[i]!.createdAt.getTime() <= history[i - 1]!.createdAt.getTime()) {
        throw new Error(`CardStock timestamps not strictly increasing for ${code}`);
      }
    }
    const latest = history[history.length - 1];
    const liveVerified = await prisma.card.count({ where: { checkpointCode: code, status: 'VERIFIED' } });
    if (sourceDCs.has(code) && (latest?.amount ?? 0) !== 0) {
      throw new Error(`DC ${code} expected to net to 0 stock, got ${latest?.amount}`);
    }
    if (targetStores.has(code) && (latest?.amount ?? 0) !== liveVerified) {
      throw new Error(`Store ${code} CardStock (${latest?.amount}) != live VERIFIED count (${liveVerified})`);
    }
  }
  console.log(`Reconciled CardStock history for ${sourceDCs.size} DCs and ${targetStores.size} stores.`);
}

async function main() {
  const args = parseArgs();
  const commit = args.commit;
  console.log(commit ? '*** COMMIT MODE ***' : 'DRY RUN (pass --commit to write)');

  const rows = loadExcel(args.file);
  console.log(`Loaded ${rows.length} rows from ${args.file}`);

  const { processable: allProcessable, alreadyMigrated, rejects } = await classify(rows);
  writeReports(rejects);

  // Backup: the pre-backfill state (every card's real original checkpoint,
  // captured from the DB before any write) plus enough metadata for
  // backfill-rollback.ts to undo this run precisely. Written every run,
  // dry or committed, so it's always current before a --commit.
  fs.writeFileSync(
    path.join(process.cwd(), 'scratchpad', 'backfill-snapshot.json'),
    JSON.stringify({
      user: args.user,
      timeline: {
        verifyAt: VERIFY_AT.toISOString(),
        distributionCreateAt: DISTRIBUTION_CREATE_AT.toISOString(),
        deliveryWindowStart: DELIVERY_BASE_AT.toISOString(),
        // generous upper bound on the delivery window (330 distributions * 1s each)
        deliveryWindowEnd: new Date(DELIVERY_BASE_AT.getTime() + 3600_000).toISOString()
      },
      // Union of still-pending cards and ones a prior run already finished —
      // otherwise, once the whole backfill completes, allProcessable is
      // empty and the snapshot would no longer be able to roll back
      // anything (alreadyMigrated's sourceCode is recovered from each
      // card's own INITIAL movement, same as the ledger does).
      cards: [...allProcessable, ...alreadyMigrated] // [{ key, sourceCode, targetCode }, ...] — original state before any write
    }, null, 2)
  );
  console.log(`Snapshot of ${allProcessable.length + alreadyMigrated.length} cards' pre-backfill state written to scratchpad/backfill-snapshot.json`);

  const bySource: Record<string, number> = {};
  for (const p of allProcessable) bySource[p.sourceCode] = (bySource[p.sourceCode] ?? 0) + 1;
  console.log(`\nProcessable: ${allProcessable.length} / Rejected: ${rejects.length}`);
  console.log('By source DC:', bySource);
  const byReason: Record<string, number> = {};
  for (const r of rejects) byReason[r.reason] = (byReason[r.reason] ?? 0) + 1;
  console.log('Rejects by reason:', byReason);

  const processable = args.limit ? allProcessable.slice(0, args.limit) : allProcessable;
  if (args.limit) console.log(`--limit=${args.limit} applied: processing ${processable.length} cards`);

  if (!args.only || args.only === 'verify') {
    await stepVerify(processable, args.user, commit);
  }

  let distributions: { id: number; sourceCode: string; targetCode: string; keys: string[] }[] = [];
  if (!args.only || args.only === 'distribute' || args.only === 'submit') {
    distributions = await stepDistribute(processable, args.user, commit);
  }

  if (!args.only || args.only === 'submit') {
    await stepSubmit(distributions, args.user, commit);
  }

  if (commit) {
    if (args.only || args.limit) {
      console.log('\n(Skipping full ledger reconciliation — --only/--limit means this is a partial run.)');
    } else {
      await printLedger([...processable, ...alreadyMigrated]);
    }
  }

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error('FAILED:', err);
  await prisma.$disconnect();
  process.exit(1);
});
