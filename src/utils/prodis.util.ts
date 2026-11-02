import type { NextFunction, Request, Response } from 'express';
import prisma from '../../lib/prisma';
import { USER_STATUS } from './access.util';
import { wibEndOfDay, wibMonthStart, wibStartOfDay, wibToday } from './wib.util';

export type ProdisFieldError = { field: string; code: string; message: string };

export class ProdisError extends Error {
  status: number;
  code: string;
  data?: unknown;
  errors?: ProdisFieldError[] | undefined;

  constructor(status: number, code: string, message: string, extra: { data?: unknown; errors?: ProdisFieldError[] } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.data = extra.data;
    this.errors = extra.errors;
  }
}

export const prodisOk = (
  res: Response,
  data: unknown,
  options: { meta?: unknown; message?: string; status?: number } = {}
) => {
  const status = options.status ?? 200;
  return res.status(status).json({
    status,
    code: 'OK',
    message: options.message ?? 'Data retrieved successfully',
    data,
    meta: options.meta ?? null,
    errors: null
  });
};

export const validationFailed = (errors: ProdisFieldError[]) =>
  new ProdisError(422, 'VALIDATION_ERROR', 'Invalid request parameters', { errors });

export const prodisErrorHandler = (err: any, req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) return;
  if (err instanceof ProdisError) {
    return res.status(err.status).json({
      status: err.status,
      code: err.code,
      message: err.message,
      data: err.data ?? null,
      meta: null,
      errors: err.errors ?? null
    });
  }
  if (err?.type === 'entity.parse.failed') {
    return res.status(422).json({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'Invalid request parameters',
      data: null,
      meta: null,
      errors: [{ field: 'body', code: 'INVALID_FORMAT', message: 'Body must be valid JSON' }]
    });
  }
  if (err?.name === 'MulterError') {
    return res.status(422).json({
      status: 422,
      code: 'VALIDATION_ERROR',
      message: 'Invalid request parameters',
      data: null,
      meta: null,
      errors: [{ field: err.field ?? 'file', code: err.code ?? 'INVALID_VALUE', message: err.message }]
    });
  }
  return res.status(500).json({
    status: 500,
    code: 'INTERNAL_ERROR',
    message: 'Internal server error',
    data: null,
    meta: null,
    errors: null
  });
};

export const prodisPaging = (query: any, defaultLimit = 20) => {
  const page = query?.page === undefined ? 1 : Number(query.page);
  const limit = query?.limit === undefined ? defaultLimit : Number(query.limit);
  if (!Number.isInteger(page) || page < 1) {
    throw validationFailed([{ field: 'page', code: 'INVALID_VALUE', message: 'page must be a positive integer' }]);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw validationFailed([{ field: 'limit', code: 'INVALID_VALUE', message: 'limit must be between 1 and 100' }]);
  }
  return { page, limit, skip: (page - 1) * limit, meta: (total: number) => ({ page, limit, total, totalPages: Math.ceil(total / limit) }) };
};

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export const prodisDay = (value: unknown, field: string): Date => {
  if (!value) {
    throw validationFailed([{ field, code: 'REQUIRED', message: `${field} is required` }]);
  }
  if (!DAY_PATTERN.test(String(value))) {
    throw validationFailed([{ field, code: 'INVALID_FORMAT', message: `${field} must be YYYY-MM-DD` }]);
  }
  return wibStartOfDay(String(value));
};

export const prodisRange = (from: unknown, to: unknown) => {
  const fromDate = prodisDay(from, 'from');
  const toDate = prodisDay(to, 'to');
  if (fromDate > toDate) {
    throw validationFailed([{ field: 'from', code: 'INVALID_VALUE', message: 'from must be before or equal to to' }]);
  }
  const days = (Number(toDate) - Number(fromDate)) / (24 * 60 * 60 * 1000);
  if (days > 31) {
    throw new ProdisError(422, 'RANGE_TOO_LARGE', 'Date range exceeds the maximum allowed');
  }
  return { from: fromDate, to: wibEndOfDay(String(to)), fromStr: String(from), toStr: String(to) };
};

const pad = (n: number) => String(n).padStart(2, '0');

export const isoWib = (value: Date | null | undefined): string | null => {
  if (!value) return null;
  const d = new Date(value.getTime() + 7 * 60 * 60 * 1000);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}+07:00`;
};

export const ddMmYyyy = (value: Date): string => {
  const d = new Date(value.getTime() + 7 * 60 * 60 * 1000);
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}`;
};

export const cardStatusToApp = (status: string): string => {
  const map: Record<string, string> = { VERIFIED: 'VERIFIED', SOLD: 'SOLD', BROKEN: 'DAMAGED', LOST: 'LOST' };
  return map[status] ?? 'VERIFIED';
};

export const cardStatusFromApp = (status: string): string | null => {
  const map: Record<string, string> = { VERIFIED: 'VERIFIED', SOLD: 'SOLD', DAMAGED: 'BROKEN', LOST: 'LOST' };
  return map[status.toUpperCase()] ?? null;
};

export const numberStatusToApp = (status: string): string => (status === 'SOLD' ? 'SOLD' : 'AVAILABLE');

export const saleStatus = (verifiedAt: Date | null): string => (verifiedAt ? 'ACTIVATED' : 'WAITING_ACTIVATION');

export const anomalyPreview = (note: string | null, max = 120): string | null => {
  if (!note) return null;
  return note.length > max ? `${note.slice(0, max - 1)}…` : note;
};

export type ProdisEmployee = { code: string; name: string; circleCode: string };

export const resolveEmployee = async (nrk: unknown): Promise<ProdisEmployee> => {
  const code = typeof nrk === 'string' ? nrk.trim() : '';
  if (!code) throw validationFailed([{ field: 'nrk', code: 'REQUIRED', message: 'nrk is required' }]);
  const user = await prisma.user.findUnique({
    where: { code },
    select: { code: true, name: true, circleCode: true, status: true }
  });
  if (!user || user.status !== USER_STATUS.ACTIVE) {
    throw new ProdisError(404, 'EMPLOYEE_NOT_FOUND', 'Employee not found');
  }
  return { code: user.code, name: user.name, circleCode: user.circleCode };
};

export const employeeStoreWhere = async (employee: ProdisEmployee) => {
  const allCircles = !!(await prisma.permission.findFirst({
    where: { userCode: employee.code, accessCode: 'SA01', status: true },
    select: { id: true }
  }));
  return allCircles ? {} : { checkpointCircles: { some: { circleCode: employee.circleCode } } };
};

export const employeeHasStore = async (employee: ProdisEmployee, checkpointCode: string): Promise<boolean> => {
  const scope: any = await employeeStoreWhere(employee);
  if (!scope.checkpointCircles) return true;
  const link = await prisma.checkpointCircle.findFirst({
    where: { checkpointCode, circleCode: employee.circleCode },
    select: { id: true }
  });
  return !!link;
};

export const resolveStore = async (ref: unknown) => {
  const value = typeof ref === 'string' ? ref.trim() : '';
  if (!value) throw new ProdisError(404, 'STORE_NOT_FOUND', 'Store not found');
  const numeric = /^\d+$/.test(value) ? Number(value) : null;
  const store = await prisma.checkpoint.findFirst({
    where: numeric !== null ? { OR: [{ id: numeric }, { code: value }] } : { code: value }
  });
  if (!store) throw new ProdisError(404, 'STORE_NOT_FOUND', 'Store not found');
  return store;
};

export const storeRef = (store: { id: number; code: string; name: string }) => ({
  id: String(store.id),
  code: store.code,
  name: store.name
});

const RATE_WINDOW_MS = 60_000;
const RATE_MAX = 120;
const limiterBuckets = new Map<string, { count: number; resetAt: number }>();

export const prodisRateLimit = (req: Request, res: Response, next: NextFunction) => {
  const key = req.ip ?? req.socket.remoteAddress ?? 'unknown';
  const now = Date.now();
  const bucket = limiterBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    limiterBuckets.set(key, { count: 1, resetAt: now + RATE_WINDOW_MS });
    return next();
  }
  bucket.count += 1;
  if (bucket.count > RATE_MAX) {
    return res.status(429).json({
      status: 429,
      code: 'RATE_LIMITED',
      message: 'Too many requests, please try again later',
      data: null,
      meta: null,
      errors: null
    });
  }
  return next();
};

export { wibMonthStart, wibToday, wibEndOfDay, wibStartOfDay };
