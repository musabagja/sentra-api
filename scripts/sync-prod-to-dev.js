/**
 * One-way data sync: production (read-only) -> development.
 *
 * Never issues a write against the source. Identity ids are preserved, because
 * CardMovement.cardID, DistributionItem.distributionID, DistributionSubmittance
 * and the Opname chain all reference parent identity columns rather than codes.
 *
 *   node scripts/sync-prod-to-dev.js [--apply]
 *
 * Without --apply it is a dry run: it reports what it would copy and writes nothing.
 */
require('tsx/cjs');
const path = require('path');
const dotenv = require('dotenv');

const APPLY = process.argv.includes('--apply');
const DEV_HOST = '10.145.25.233:14300';

// FK-safe order. `table` is the SQL Server table name, `model` the Prisma model.
// `preserveId` is only needed where another table references this one's identity
// column. Checkpoint/CheckpointCircle are referenced by code (or not at all) and are
// already partly populated in dev with independently-assigned ids, so they are matched
// on their logical key and let the destination assign new ids.
const PLAN = [
  { model: 'checkpoint',              table: 'Checkpoint',              dedupe: r => r.code,                              preserveId: false },
  { model: 'checkpointCircle',        table: 'CheckpointCircle',        dedupe: r => `${r.checkpointCode}|${r.circleCode}`, preserveId: false },
  { model: 'uploadBatch',             table: 'UploadBatch',             dedupe: r => r.code,                              preserveId: true  },
  { model: 'uploadBatchProgress',     table: 'UploadBatchProgress',     dedupe: r => r.id,                                preserveId: true  },
  { model: 'card',                    table: 'Card',                    dedupe: r => r.key,                               preserveId: true  },
  { model: 'cardStock',               table: 'CardStock',               dedupe: r => r.id,                                preserveId: true  },
  { model: 'cardMovement',            table: 'CardMovement',            dedupe: r => r.id,                                preserveId: true  },
  { model: 'distribution',            table: 'Distribution',            dedupe: r => r.id,                                preserveId: true  },
  { model: 'distributionSubmittance', table: 'DistributionSubmittance', dedupe: r => r.id,                                preserveId: true  },
  { model: 'distributionItem',        table: 'DistributionItem',        dedupe: r => r.id,                                preserveId: true  },
  { model: 'opname',                  table: 'Opname',                  dedupe: r => r.id,                                preserveId: true  },
  { model: 'opnameSubmittance',       table: 'OpnameSubmittance',       dedupe: r => r.id,                                preserveId: true  },
  { model: 'opnameSubmittanceDocumentation', table: 'OpnameSubmittanceDocumentation', dedupe: r => r.id, preserveId: true },
  { model: 'opnameUpdate',            table: 'OpnameUpdate',            dedupe: r => r.id,                                preserveId: true  },
  { model: 'session',                 table: 'Session',                 dedupe: r => r.id,                                preserveId: false }
];


const READ_PAGE = 5000;  // rows pulled from production per query
const PARAM_CAP = 2000;  // SQL Server allows 2100 parameters per statement

function loadClient(envPath) {
  Object.keys(require.cache).forEach(k => {
    if (k.includes('lib/prisma') || k.includes('generated/prisma')) delete require.cache[k];
  });
  dotenv.config({ path: envPath, override: true });
  return require(path.resolve('./lib/prisma')).default;
}

(async () => {
  const prod = loadClient('.env');
  const prodUrl = process.env.DATABASE_URL;
  if (prodUrl.includes(DEV_HOST)) throw new Error('.env points at dev; refusing to run');

  const dev = loadClient('.env.test');
  if (!process.env.DATABASE_URL.includes(DEV_HOST)) {
    throw new Error(`Refusing to write: destination is not ${DEV_HOST}`);
  }

  console.log(APPLY ? '== APPLY ==' : '== DRY RUN (pass --apply to write) ==');
  const summary = [];

  for (const { model, table, dedupe, preserveId } of PLAN) {
    const [srcCount, dstCount] = await Promise.all([prod[model].count(), dev[model].count()]);
    if (srcCount === dstCount) {
      summary.push(`${table}: in sync (${srcCount})`);
      continue;
    }

    // Only copy what the destination is missing, so re-running is safe.
    const existing = new Set((await dev[model].findMany()).map(dedupe));

    let copied = 0;
    for (let skip = 0; skip < srcCount; skip += READ_PAGE) {
      const page = await prod[model].findMany({ skip, take: READ_PAGE, orderBy: { id: 'asc' } });
      const missing = page
        .filter(r => !existing.has(dedupe(r)))
        .map(r => { if (!preserveId) { const { id, ...rest } = r; return rest; } return r; });
      if (missing.length === 0) continue;

      // Stay under the parameter cap: one placeholder per column per row.
      const cols = Object.keys(missing[0]).length;
      const writeChunk = Math.max(1, Math.floor(PARAM_CAP / cols));

      for (let i = 0; i < missing.length; i += writeChunk) {
        const chunk = missing.slice(i, i + writeChunk);
        if (!APPLY) { copied += chunk.length; continue; }
        // IDENTITY_INSERT is connection-scoped, so the toggle and the insert must
        // share one connection — an interactive transaction pins exactly that.
        if (preserveId) {
          // Prisma omits autoincrement ids from createMany input on SQL Server, so the
          // id-preserving path builds a parameterised multi-row INSERT instead. There are
          // no @map directives in the schema, so field names are the column names.
          const columns = Object.keys(chunk[0]);
          const params = [];
          const tuples = chunk.map(row => {
            const slots = columns.map(c => { params.push(row[c]); return `@P${params.length}`; });
            return `(${slots.join(',')})`;
          });
          // IDENTITY_INSERT is session-scoped and an interactive transaction does not
          // reliably pin one connection through the driver adapter, so the toggle and the
          // insert are sent as a single batch — guaranteeing one session.
          const sql =
            `SET IDENTITY_INSERT dbo.[${table}] ON; ` +
            `INSERT INTO dbo.[${table}] (${columns.map(c => `[${c}]`).join(',')}) ` +
            `VALUES ${tuples.join(',')}; ` +
            `SET IDENTITY_INSERT dbo.[${table}] OFF;`;
          await dev.$executeRawUnsafe(sql, ...params);
        } else {
          await dev[model].createMany({ data: chunk });
        }
        copied += chunk.length;
      }
      process.stdout.write(`\r${table}: ${copied}/${srcCount - dstCount}   `);
    }
    process.stdout.write('\n');
    summary.push(`${table}: ${APPLY ? 'copied' : 'would copy'} ${copied} (prod ${srcCount}, dev was ${dstCount})`);
  }

  console.log('\n--- summary ---');
  console.log(summary.join('\n'));
  await prod.$disconnect();
  await dev.$disconnect();
})().catch(e => { console.error('\nFAILED:', e.message); process.exit(1); });
