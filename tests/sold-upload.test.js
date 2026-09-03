const assert = require('assert');
const request = require('supertest');
const xlsx = require('xlsx');

const { requireDevDatabase, hasEnvTest } = require('./setup');

// Loaded lazily inside before(): requiring these pulls in lib/prisma, and we only
// want a client constructed once the dev-database guard has passed.
let app, prisma, JWT;

// Everything this suite creates is prefixed so cleanup can never touch real data.
const RUN = Date.now().toString().slice(-8);
const CIRCLE = `TCIR${RUN}`;
const STORE = `TSTR${RUN}`;
const USER = `TUSR${RUN}`;
const BATCH = `TBAT${RUN}`;

// ICCID/MSISDN shaped like the real thing: 19 and 12 digits.
const iccid = (n) => `89620${RUN}${String(n).padStart(6, '0')}`;
const msisdn = (n) => `6281${RUN}${String(n)}`;

const STARTING_STOCK = 10;

const sheetBuffer = (rows) => {
  const ws = xlsx.utils.json_to_sheet(rows, { header: ['ICCID', 'MSISDN', 'STORE_CODE'] });
  const wb = xlsx.utils.book_new();
  xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');
  return xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
};

const postSold = (buffer) =>
  request(app)
    .post('/api/stock/upload/sold-xlsx')
    .set('Cookie', [`access_token=${token}`])
    .attach('source', buffer, 'sold.xlsx');

let token;
let fixturesCreated = false;

(hasEnvTest ? describe : describe.skip)('POST /api/stock/upload/sold-xlsx', function () {
  this.timeout(60000);

  before(async () => {
    requireDevDatabase();

    app = require('../app').default;
    prisma = require('../lib/prisma').default;
    JWT = require('../src/utils/jwt.util').default;

    // Surface a credentials/connectivity problem as an instruction rather than a
    // raw driver stack trace — .env.test is copied from .env, whose login may not
    // exist on the development server.
    try {
      await prisma.$queryRaw`SELECT 1`;
    } catch (e) {
      throw new Error(
        `Cannot reach the development database (10.145.25.233:14300): ${e.message}\n` +
        'Fix the user/password (and database, if it differs) in .env.test — ' +
        'it was copied from .env, which may use a different login on this server.'
      );
    }

    await prisma.circle.create({ data: { code: CIRCLE, name: 'Test Circle' } });
    await prisma.checkpoint.create({ data: { code: STORE, type: 'STORE', name: 'Test Store' } });
    await prisma.checkpointCircle.create({ data: { checkpointCode: STORE, circleCode: CIRCLE } });
    await prisma.user.create({ data: { code: USER, name: 'Test User', circleCode: CIRCLE } });
    await prisma.uploadBatch.create({ data: { code: BATCH, userCode: USER, status: 'COMPLETED', total: 0 } });
    await prisma.cardStock.create({ data: { checkpointCode: STORE, amount: STARTING_STOCK } });

    // Cards 1..3 are sellable; card 4 is deliberately left UNVERIFIED.
    await prisma.card.createMany({
      data: [1, 2, 3].map((n) => ({
        key: iccid(n), checkpointCode: STORE, batchCode: BATCH,
        status: 'VERIFIED', validatedAt: new Date()
      }))
    });
    await prisma.card.create({
      data: { key: iccid(4), checkpointCode: STORE, batchCode: BATCH, status: 'UNVERIFIED' }
    });

    fixturesCreated = true;
    token = JWT.sign({ code: USER }, { expiresIn: '1h' });
  });

  after(async () => {
    if (!prisma || !fixturesCreated) return;
    const cardKeys = [1, 2, 3, 4].map(iccid);
    const numberKeys = [1, 2, 3, 4].map(msisdn);
    const cards = await prisma.card.findMany({ where: { key: { in: cardKeys } }, select: { id: true } });

    // FK-safe teardown order.
    await prisma.merge.deleteMany({ where: { cardKey: { in: cardKeys } } });
    await prisma.cardMovement.deleteMany({ where: { cardID: { in: cards.map(c => c.id) } } });
    await prisma.cardStock.deleteMany({ where: { checkpointCode: STORE } });
    await prisma.card.deleteMany({ where: { key: { in: cardKeys } } });
    await prisma.number.deleteMany({ where: { key: { in: numberKeys } } });
    await prisma.uploadBatch.deleteMany({ where: { code: { startsWith: 'AUTOSOLD-' }, userCode: USER } });
    await prisma.uploadBatch.deleteMany({ where: { code: BATCH } });
    await prisma.checkpointCircle.deleteMany({ where: { circleCode: CIRCLE } });
    await prisma.checkpoint.deleteMany({ where: { code: STORE } });
    await prisma.user.deleteMany({ where: { code: USER } });
    await prisma.circle.deleteMany({ where: { code: CIRCLE } });
    await prisma.$disconnect();
  });

  it('records a sale and auto-creates the MSISDN', async () => {
    const res = await postSold(sheetBuffer([
      { ICCID: iccid(1), MSISDN: msisdn(1), STORE_CODE: STORE }
    ]));

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.merged, 1);
    assert.equal(res.body.data.numbersCreated, 1);
    assert.ok(res.body.data.batchCode.startsWith('AUTOSOLD-'));

    const merge = await prisma.merge.findUnique({ where: { cardKey: iccid(1) } });
    assert.ok(merge, 'merge row should exist');
    assert.equal(merge.numberKey, msisdn(1));
    assert.equal(merge.checkpointCode, STORE);
    assert.ok(merge.soldAt && merge.verifiedAt, 'sale should be sold and verified');

    const card = await prisma.card.findUnique({ where: { key: iccid(1) } });
    assert.equal(card.status, 'SOLD');

    const number = await prisma.number.findUnique({ where: { key: msisdn(1) } });
    assert.equal(number.status, 'SOLD');
    assert.equal(number.remark, 'AUTO_CREATED_FROM_SOLD_UPLOAD');

    const stock = await prisma.cardStock.findFirst({
      where: { checkpointCode: STORE }, orderBy: { createdAt: 'desc' }
    });
    assert.equal(Number(stock.amount), STARTING_STOCK - 1, 'stock should drop by one');

    const movement = await prisma.cardMovement.findFirst({
      where: { cardID: card.id, type: 'SALE' }
    });
    assert.ok(movement, 'a SALE movement should be recorded');
    assert.equal(movement.sourceCode, STORE);
  });

  it('is idempotent when the same file is uploaded again', async () => {
    const res = await postSold(sheetBuffer([
      { ICCID: iccid(1), MSISDN: msisdn(1), STORE_CODE: STORE }
    ]));

    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data.merged, 0, 'must not merge twice');
    assert.equal(res.body.data.numbersCreated, 0);
    assert.equal(res.body.data.skipped, 1, 'already-verified row is skipped');

    const merges = await prisma.merge.count({ where: { cardKey: iccid(1) } });
    assert.equal(merges, 1, 'no duplicate merge');
  });

  it('writes nothing at all when any row fails (all-or-nothing)', async () => {
    const unknown = iccid(99);
    const res = await postSold(sheetBuffer([
      { ICCID: iccid(2), MSISDN: msisdn(2), STORE_CODE: STORE },  // valid
      { ICCID: unknown, MSISDN: msisdn(3), STORE_CODE: STORE }    // not in the system
    ]));

    assert.equal(res.status, 422);
    assert.ok(res.body.details, 'response should carry a structured breakdown');
    const bucket = res.body.details.errors.cardNotFound;
    assert.equal(bucket.count, 1);
    assert.ok(bucket.action, 'each bucket should tell the user how to fix it');
    assert.equal(bucket.samples[0].iccid, unknown);
    assert.equal(bucket.samples[0].row, 3, 'row number should point at the sheet row');
    assert.equal(res.body.details.readyRows, 1, 'the valid row should be counted as ready');

    // The valid row must not have been applied.
    const merge = await prisma.merge.findUnique({ where: { cardKey: iccid(2) } });
    assert.equal(merge, null, 'valid row must be rolled back with the batch');
    const card = await prisma.card.findUnique({ where: { key: iccid(2) } });
    assert.equal(card.status, 'VERIFIED', 'card status must be untouched');
    const number = await prisma.number.findUnique({ where: { key: msisdn(2) } });
    assert.equal(number, null, 'no number should be auto-created on a failed upload');
  });

  it('rejects a card that is not VERIFIED', async () => {
    const res = await postSold(sheetBuffer([
      { ICCID: iccid(4), MSISDN: msisdn(4), STORE_CODE: STORE }
    ]));

    assert.equal(res.status, 422);
    const bucket = res.body.details.errors.cardNotVerified;
    assert.equal(bucket.count, 1);
    assert.match(bucket.samples[0].detail, /UNVERIFIED/);
    assert.equal(bucket.samples[0].row, 2);
    assert.match(bucket.action, /Validate the card/);
  });

  it('reports an ICCID that Excel stored as a number instead of text', async () => {
    const ws = xlsx.utils.aoa_to_sheet([['ICCID', 'MSISDN', 'STORE_CODE']]);
    ws['A2'] = { t: 'n', v: 8962110001234567890, w: '8.96211E+18' };
    ws['B2'] = { t: 's', v: msisdn(3) };
    ws['C2'] = { t: 's', v: STORE };
    ws['!ref'] = 'A1:C2';
    const wb = xlsx.utils.book_new();
    xlsx.utils.book_append_sheet(wb, ws, 'Sheet1');

    const res = await postSold(xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' }));

    assert.equal(res.status, 422);
    const bucket = res.body.details.errors.unreadableIccid;
    assert.equal(bucket.count, 1);
    assert.match(bucket.action, /Format the ICCID column as Text/);
    assert.match(res.body.message, /could not be processed/);
  });
});
