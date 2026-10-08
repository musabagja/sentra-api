/**
 * Jakarta time (WIB, UTC+7, no daylight saving). Every "day" a person picks or sees in the app
 * and in the Excel files is a WIB day, whatever time zone the server runs in, so a sale at
 * 03:00 WIB on 8 Oct is found by a filter for 8 Oct (that instant is 7 Oct in UTC).
 */
export const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

// Only a bare day is taken as written; anything with a time is an instant and is read in WIB
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const invalid = (value: unknown) => {
  const err = new Error(`Tanggal "${String(value)}" tidak valid`);
  (err as any).status = 422;
  return err;
};

/** The WIB calendar day of a "YYYY-MM-DD" string or of any instant, as [year, month0, day] */
const wibParts = (value: string | Date): [number, number, number] => {
  const match = typeof value === 'string' ? DAY_PATTERN.exec(value.trim()) : null;
  if (match) return [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) throw invalid(value);
  const shifted = new Date(instant.getTime() + WIB_OFFSET_MS);
  return [shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()];
};

/** The WIB calendar day of an instant: month is 1-12 */
export const wibYmd = (value: string | Date = new Date()) => {
  const [year, month0, day] = wibParts(value);
  return { year, month: month0 + 1, day };
};

/** The WIB month (0-11) an instant falls in, for bucketing rows by month */
export const wibMonthIndex = (value: string | Date): number => wibParts(value)[1];

/** 00:00:00.000 WIB of that day */
export const wibStartOfDay = (value: string | Date): Date => {
  const [y, m, d] = wibParts(value);
  return new Date(Date.UTC(y, m, d) - WIB_OFFSET_MS);
};

/** 23:59:59.999 WIB of that day */
export const wibEndOfDay = (value: string | Date): Date => {
  const [y, m, d] = wibParts(value);
  return new Date(Date.UTC(y, m, d, 23, 59, 59, 999) - WIB_OFFSET_MS);
};

/** Start of the current WIB day / month */
export const wibToday = (): Date => wibStartOfDay(new Date());
export const wibMonthStart = (): Date => {
  const [y, m] = wibParts(new Date());
  return new Date(Date.UTC(y, m, 1) - WIB_OFFSET_MS);
};

/** 00:00:00.000 WIB on 1 January of the year */
export const wibYearStart = (year: number): Date => new Date(Date.UTC(year, 0, 1) - WIB_OFFSET_MS);

/** 23:59:59.999 WIB on 31 December of the year */
export const wibYearEnd = (year: number): Date =>
  new Date(Date.UTC(year, 11, 31, 23, 59, 59, 999) - WIB_OFFSET_MS);

/** 23:59:59.999 WIB on the last day of the month (month is 1-12) */
export const wibMonthEnd = (year: number, month: number): Date =>
  new Date(Date.UTC(year, month, 0, 23, 59, 59, 999) - WIB_OFFSET_MS);
