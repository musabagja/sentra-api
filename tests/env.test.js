const assert = require('assert');
const { DEV_DB_HOST, DEV_DB_PORT, hasEnvTest, requireDevDatabase } = require('./setup');

describe('test environment safety', () => {
  it('never resolves DATABASE_URL to a non-development host', function () {
    const url = process.env.DATABASE_URL;
    if (!hasEnvTest) {
      assert.equal(url, undefined, 'without .env.test there must be no DATABASE_URL at all');
      return;
    }
    assert.ok(url, 'DATABASE_URL should come from .env.test');
    assert.ok(
      url.includes(`${DEV_DB_HOST}:${DEV_DB_PORT}`),
      'DATABASE_URL must point at the development database'
    );
  });

  it('rejects a DATABASE_URL that is not the development host', function () {
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = 'sqlserver://10.0.0.1:1433;database=x';
    try {
      assert.throws(() => requireDevDatabase(), /development database/);
    } finally {
      process.env.DATABASE_URL = original;
    }
  });

  it('runs with NODE_ENV=test', function () {
    assert.equal(process.env.NODE_ENV, 'test');
  });
});
