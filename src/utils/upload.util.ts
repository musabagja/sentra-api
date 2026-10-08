import * as xlsx from 'xlsx';

/**
 * Helpers for reading an uploaded Excel file and reporting problems row by row. Shared by the
 * stock uploads (Tambah Stok, sales) and the distribution upload (Kirim Barang via Excel).
 */

// Excel hands back numeric cells as JS doubles. An ICCID is 19-20 digits, well past
// Number.MAX_SAFE_INTEGER (~9.0e15), so an ICCID column that was not formatted as Text
// arrives silently rounded and never matches the string keys stored in the DB.
// Reading with raw:false makes SheetJS return each cell's displayed text instead.
export const sheetRows = (sheet: xlsx.WorkSheet): any[] =>
  xlsx.utils.sheet_to_json(sheet, { raw: false, defval: '' });

// Values Excel already destroyed before we ever saw them, e.g. "8.96211E+18".
const SCIENTIFIC = /^[+-]?\d+(\.\d+)?e[+-]?\d+$/i;

/**
 * Trim the decorations spreadsheets add around identifiers (spaces, NBSP, quotes,
 * thousands separators, a leading +) without stripping trailing check letters that
 * are part of some ICCIDs. `unreadable` marks a cell that reached us as a float.
 */
export const normalizeKeyCell = (value: unknown): { key: string; unreadable: boolean } => {
  const raw = value === null || value === undefined ? '' : String(value).trim();
  if (!raw) return { key: '', unreadable: false };
  const cleaned = raw.replace(/[\s'"`,\u00a0]/g, '').replace(/^\+/, '');
  if (SCIENTIFIC.test(cleaned)) return { key: raw, unreadable: true };
  return { key: cleaned, unreadable: false };
};

// SQL Server caps a statement at 2,100 parameters, so `in` lists are always chunked.
export const CHUNK = 500;
export const chunkArray = <T,>(arr: T[], size = CHUNK): T[][] => {
  const chunks: T[][] = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
};

export const fetchChunked = async <T,>(keys: string[], fn: (batch: string[]) => Promise<T[]>): Promise<T[]> => {
  const out: T[] = [];
  for (const batch of chunkArray(keys)) out.push(...(await fn(batch)));
  return out;
};

// Error lists are capped so a bad 5,000-row upload does not return a 5,000-item payload.
export const MAX_LISTED_ERRORS = 50;

// One rejected row, addressed by its position in the uploaded sheet so the person
// fixing the file can find it without counting.
export type RowIssue = {
  row: number;
  iccid: string;
  msisdn?: string;
  storeCode?: string;
  fromCode?: string; // where the card is actually held (cross-location sales)
  detail?: string;
};

export const errorBucket = (items: RowIssue[]) => ({
  count: items.length,
  samples: items.slice(0, MAX_LISTED_ERRORS),
  truncated: Math.max(0, items.length - MAX_LISTED_ERRORS)
});
