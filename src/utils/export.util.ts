import type { Response } from 'express';
import ExcelJS from 'exceljs';

/** Excel allows 1,048,576 rows per sheet, one is the header */
export const MAX_EXPORT_ROWS = 1_000_000;

// Jakarta is UTC+7. Excel dates carry no time zone, so shift them to show local time.
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;
export const wib = (value: Date | string | null | undefined): Date | null =>
  value ? new Date(new Date(value).getTime() + WIB_OFFSET_MS) : null;

export const DATE_FORMAT = 'dd mmm yyyy';
export const DATE_TIME_FORMAT = 'dd mmm yyyy hh:mm';

export type ExportColumn = {
  header: string;
  key: string;
  width: number;
  /** 'date' / 'datetime' columns get a number format; strings (ICCID, MSISDN) stay text */
  type?: 'date' | 'datetime';
};

export type ExportSheet = {
  name: string;
  columns: ExportColumn[];
  /** Rows come in chunks so memory never grows with the number of rows */
  rows: AsyncIterable<Record<string, unknown>[]>;
};

const tooMany = (count: number) => {
  const err = new Error(
    `This export has ${count.toLocaleString('en-US')} rows, more than the ${MAX_EXPORT_ROWS.toLocaleString('en-US')} limit. Narrow the filters and try again.`
  );
  (err as any).status = 422;
  return err;
};

/** Throws a 422 before anything is streamed, so the client still gets a readable JSON error */
export const assertExportSize = (count: number) => {
  if (count > MAX_EXPORT_ROWS) throw tooMany(count);
};

/**
 * Pages through a table by id (newest first) without skip/offset or counts, so the cost
 * of every page is the same however deep it is.
 */
export async function* keysetPages<T extends { id: number }>(
  fetchPage: (args: { where: any; take: number }) => Promise<T[]>,
  where: any,
  pageSize = 2000
): AsyncGenerator<T[]> {
  let lastId: number | undefined;
  while (true) {
    const page = await fetchPage({
      where: lastId === undefined ? where : { AND: [where, { id: { lt: lastId } }] },
      take: pageSize
    });
    if (page.length === 0) return;
    yield page;
    lastId = page[page.length - 1]!.id;
    if (page.length < pageSize) return;
  }
}

const safeName = (name: string) => name.replace(/[^\w.\- ]+/g, '_');

/**
 * Streams a real .xlsx to the response one chunk at a time. Headers go out first, so any
 * validation that can fail must happen before this is called.
 */
export const streamXlsx = async (res: Response, filename: string, sheets: ExportSheet[]) => {
  const file = `${safeName(filename)}.xlsx`;
  res.status(200);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${file}"; filename*=UTF-8''${encodeURIComponent(file)}`);
  res.setHeader('Cache-Control', 'no-store');

  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: res, useStyles: true, useSharedStrings: false });
  let closed = false;
  res.on('close', () => { closed = true; });

  try {
    for (const sheet of sheets) {
      const worksheet = workbook.addWorksheet(sheet.name, { views: [{ state: 'frozen', ySplit: 1 }] });
      worksheet.columns = sheet.columns.map(c => ({
        header: c.header,
        key: c.key,
        width: c.width,
        ...(c.type === 'date' && { style: { numFmt: DATE_FORMAT } }),
        ...(c.type === 'datetime' && { style: { numFmt: DATE_TIME_FORMAT } })
      }));
      worksheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: sheet.columns.length } };

      const header = worksheet.getRow(1);
      header.font = { bold: true };
      header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF1F3F5' } };
      header.commit();

      for await (const chunk of sheet.rows) {
        // The person closed the tab or cancelled: stop reading the database
        if (closed) return;
        for (const row of chunk) worksheet.addRow(row).commit();
        // Let the socket drain between chunks so a slow client cannot balloon memory
        await new Promise(resolve => setImmediate(resolve));
      }
      worksheet.commit();
    }
    await workbook.commit();
  } catch (error) {
    console.error('[export] failed after the download started:', error);
    // Headers are already sent: all that is left is to cut the connection so the browser
    // sees a failed download instead of a truncated file that looks complete.
    res.destroy(error as Error);
  }
};
