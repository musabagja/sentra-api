const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

// The development database. Any test that touches a DB must resolve to this host —
// see requireDevDatabase() below.
const DEV_DB_HOST = '10.145.25.233';
const DEV_DB_PORT = '14300';

const envTestPath = path.resolve(__dirname, '..', '.env.test');

process.env.NODE_ENV = 'test';

// `override: true` matters: lib/prisma.ts does `import "dotenv/config"`, which would
// otherwise load .env (production) first and win. Without .env.test we deliberately
// load nothing, so a stray query fails loudly instead of reaching a real database.
const hasEnvTest = fs.existsSync(envTestPath);
if (hasEnvTest) {
  dotenv.config({ path: envTestPath, override: true });
} else {
  delete process.env.DATABASE_URL;
}

/**
 * Guard for DB-backed tests. Call inside `before()`; it throws unless the resolved
 * connection points at the development host, so a production URL can never be used
 * by the suite even if one is exported into the shell.
 */
function requireDevDatabase() {
  if (!hasEnvTest) {
    throw new Error(
      'Missing .env.test — DB-backed tests need a development DATABASE_URL. ' +
      `Expected host ${DEV_DB_HOST}:${DEV_DB_PORT}.`
    );
  }
  const url = process.env.DATABASE_URL || '';
  if (!url.includes(`${DEV_DB_HOST}:${DEV_DB_PORT}`)) {
    throw new Error(
      'Refusing to run: DATABASE_URL does not point at the development database ' +
      `(${DEV_DB_HOST}:${DEV_DB_PORT}). Tests never run against production.`
    );
  }
}

module.exports = { DEV_DB_HOST, DEV_DB_PORT, hasEnvTest, requireDevDatabase };
