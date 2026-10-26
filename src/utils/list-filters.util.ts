import { ALL_CIRCLES, checkpointInCircle } from './access.util';
import { wibEndOfDay, wibStartOfDay } from './wib.util';

/**
 * Filters shared by the list endpoints and the Excel exports, so the rows a person
 * sees on screen and the rows in the downloaded file are always chosen the same way.
 * Every multi-select filter arrives as a comma-separated query value
 * (`status=VERIFIED,SOLD`); a single value behaves like it always did.
 */

// SQL Server allows about 2,100 parameters in one query
export const MAX_FILTER_VALUES = 200;

export const CARD_STATUSES = ['UNVERIFIED', 'VERIFIED', 'SOLD', 'BROKEN', 'LOST', 'DELIVERY', 'OPNAME'] as const;
export const NUMBER_STATUSES = ['UNVERIFIED', 'VERIFIED', 'SOLD', 'BROKEN', 'LOST', 'HOLD', 'DELIVERY', 'OPNAME'] as const;
export const DISTRIBUTION_STATUSES = ['SCHEDULED', 'DELIVERED', 'CANCELLED'] as const;
export const CHECKPOINT_TYPES = ['STORE', 'DC', 'HQ'] as const;

const badRequest = (message: string) => {
  const err = new Error(message);
  (err as any).status = 422;
  return err;
};

/** "a,b" or ["a","b,c"] -> ["a","b","c"] (trimmed, de-duplicated, empties dropped) */
export const csvParam = (
  value: unknown,
  name: string,
  options: { allowed?: readonly string[]; upper?: boolean } = {}
): string[] => {
  const parts = (Array.isArray(value) ? value : [value])
    .filter((v): v is string => typeof v === 'string')
    .flatMap(v => v.split(','))
    .map(v => (options.upper ? v.trim().toUpperCase() : v.trim()))
    .filter(Boolean);
  const unique = [...new Set(parts)];

  if (unique.length > MAX_FILTER_VALUES) {
    throw badRequest(`Filter ${name} maksimal ${MAX_FILTER_VALUES} pilihan`);
  }
  if (options.allowed) {
    const unknown = unique.find(v => !options.allowed!.includes(v));
    if (unknown) throw badRequest(`Filter ${name} berisi nilai yang tidak dikenal: "${unknown}"`);
  }
  return unique;
};

/** Checkpoints of the caller's circle, optionally narrowed to some codes */
const scopedCheckpoint = (circleCode: string, codes: string[]) =>
  codes.length ? { AND: [checkpointInCircle(circleCode), { code: { in: codes } }] } : checkpointInCircle(circleCode);

const containsAny = (field: string, values: string[]) =>
  values.length === 1
    ? { [field]: { contains: values[0] } }
    : { OR: values.map(v => ({ [field]: { contains: v } })) };

// ---------------------------------------------------------------- ICCID (Card)

export const buildCardWhere = (query: any, circleCode: string) => {
  const codes = csvParam(query.checkpointCode, 'checkpointCode');
  const statuses = csvParam(query.status, 'status', { allowed: CARD_STATUSES, upper: true });
  const batches = csvParam(query.batch, 'batch');
  const keys = csvParam(query.keys, 'keys');
  const { search, uploadAt, validatedAt } = query;

  const where: any = { checkpoint: scopedCheckpoint(circleCode, codes) };
  if (statuses.length) where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
  if (keys.length) where.key = { in: keys };
  if (search) {
    where.OR = [{ key: { contains: search as string } }, { name: { contains: search as string } }];
  }
  if (validatedAt) {
    where.validatedAt = {
      gte: wibStartOfDay(String(validatedAt)),
      lte: wibEndOfDay(String(validatedAt))
    };
  }
  if (uploadAt || batches.length) {
    where.uploadBatch = {
      ...(uploadAt && {
        createdAt: {
          gte: wibStartOfDay(String(uploadAt)),
          lte: wibEndOfDay(String(uploadAt))
        }
      }),
      ...(batches.length && containsAny('code', batches))
    };
  }
  return where;
};

// -------------------------------------------------------------- MSISDN (Number)

export const buildNumberWhere = (query: any, circleCode: string) => {
  const codes = csvParam(query.checkpointCode, 'checkpointCode');
  const statuses = csvParam(query.status, 'status', { allowed: NUMBER_STATUSES, upper: true });
  const remarks = csvParam(query.remark, 'remark');
  const keys = csvParam(query.keys, 'keys');
  const { search } = query;

  // Numbers with no checkpoint are globally visible (available stock);
  // numbers with a checkpoint are restricted to the user's circle.
  const where: any = {
    AND: [{ OR: [{ checkpoint: scopedCheckpoint(circleCode, codes) }, { checkpointCode: null }] }]
  };
  if (statuses.length) where.status = statuses.length === 1 ? statuses[0] : { in: statuses };
  if (keys.length) where.AND.push({ key: { in: keys } });
  // Both conditions go into AND: each of them can be an OR of its own, and two ORs cannot
  // share one `where.OR` key
  if (search) {
    where.AND.push({ OR: [{ key: { contains: search as string } }, { name: { contains: search as string } }] });
  }
  if (remarks.length) where.AND.push(containsAny('remark', remarks));
  return where;
};

// ----------------------------------------------------------------- Distribution

export const buildDistributionWhere = (query: any, circleCode: string) => {
  const statuses = csvParam(query.status, 'status', { allowed: DISTRIBUTION_STATUSES, upper: true });
  const sources = csvParam(query.sourceCode, 'sourceCode');
  const targets = csvParam(query.targetCode, 'targetCode');
  const { startDueDate, endDueDate } = query;

  // User sees distributions where they own either end (source or target). Specific filters
  // are AND-appended so they don't collapse into an OR that matches only one side.
  const and: any[] = [
    { OR: [{ source: checkpointInCircle(circleCode) }, { target: checkpointInCircle(circleCode) }] }
  ];
  if (statuses.length) and.push({ status: { in: statuses } });
  if (sources.length) and.push({ sourceCode: { in: sources } });
  if (targets.length) and.push({ targetCode: { in: targets } });
  if (startDueDate || endDueDate) {
    and.push({
      scheduledAt: {
        ...(startDueDate && { gte: wibStartOfDay(String(startDueDate)) }),
        // The whole end day counts: a schedule at 14:00 on the end date is still in range
        ...(endDueDate && { lte: wibEndOfDay(String(endDueDate)) })
      }
    });
  }
  return { AND: and };
};

// -------------------------------------------------------------------- Checkpoint

/** Places of the caller's circle; `circle` / `type` / `search` only ever narrow that set */
export const buildPlaceWhere = (query: any, circleCode: string) => {
  const circles = csvParam(query.circle, 'circle');
  const types = csvParam(query.type, 'type', { allowed: CHECKPOINT_TYPES, upper: true });
  const { search } = query;

  const and: any[] = [checkpointInCircle(circleCode)];
  if (circles.length) and.push({ checkpointCircles: { some: { circleCode: { in: circles } } } });

  return {
    AND: and,
    ...(types.length ? { type: types.length === 1 ? types[0] : { in: types } } : {}),
    ...(search
      ? { OR: [{ code: { contains: String(search) } }, { name: { contains: String(search) } }] }
      : {})
  } as any;
};

/** Merge.createdAt range from startSoldAt / endSoldAt (whole days) */
export const buildSoldRange = (query: any) => {
  const { startSoldAt, endSoldAt } = query;
  if (!startSoldAt && !endSoldAt) return undefined;
  return {
    ...(startSoldAt && { gte: wibStartOfDay(String(startSoldAt)) }),
    ...(endSoldAt && { lte: wibEndOfDay(String(endSoldAt)) })
  };
};

// ---------------------------------------------------------------------- UploadBatch

// An upload batch is visible to a circle when it holds a card in one of the circle's checkpoints,
// or a number the circle can see (numbers with no checkpoint belong to everyone). This keeps a
// batch that only carries MSISDNs from disappearing from the list. The AUTOSOLD-* batches are
// created by the sales upload for numbers it had to add; they are not procurement uploads.
export const batchInScope = (circleCode: string) => ({
  AND: [
    { NOT: { code: { startsWith: 'AUTOSOLD-' } } },
    // Every circle: every procurement batch
    ...(circleCode === ALL_CIRCLES ? [] : [{
      OR: [
        { cards: { some: { checkpoint: checkpointInCircle(circleCode) } } },
        { numbers: { some: { OR: [{ checkpoint: checkpointInCircle(circleCode) }, { checkpointCode: null }] } } }
      ]
    }])
  ]
});


export const BATCH_STATUSES = ['ONGOING', 'COMPLETED'] as const;

/** Upload batches of the caller's circle; status / batch code / search only ever narrow them */
export const buildBatchWhere = (query: any, circleCode: string) => {
  const statuses = csvParam(query.status, 'status', { allowed: BATCH_STATUSES, upper: true });
  const codes = csvParam(query.batch, 'batch');
  const { search } = query;

  const and: any[] = [batchInScope(circleCode)];
  if (codes.length) and.push({ code: { in: codes } });
  if (search) {
    and.push({ OR: [{ code: { contains: String(search) } }, { name: { contains: String(search) } }] });
  }
  return { AND: and, ...(statuses.length ? { status: statuses.length === 1 ? statuses[0] : { in: statuses } } : {}) } as any;
};
