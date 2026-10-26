import PDFDocument from 'pdfkit';

export interface BeritaAcaraInput {
  docNumber: string;
  storeLabel: string;
  date: Date;
  pelaksanaName: string;
  picName: string | null;
  companyName: string;
  summary: { baik: number; rusak: number; belum: number; total: number };
  cards: { no: number; iccid: string; kondisi: string }[];
  signImage: Buffer | null;
  picSignImage: Buffer | null;
}

const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

const formatDate = (date: Date): string => {
  const d = new Date(date.getTime() + WIB_OFFSET_MS);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getUTCDate())}-${pad(d.getUTCMonth() + 1)}-${d.getUTCFullYear()}, ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())} WIB`;
};

export const imageDataFromRef = async (ref?: string | null): Promise<Buffer | null> => {
  if (!ref) return null;
  const dataUrl = /^data:image\/[a-z0-9+.-]+;base64,([A-Za-z0-9+/=\s]+)$/i.exec(ref.trim());
  if (dataUrl?.[1]) return Buffer.from(dataUrl[1].replace(/\s/g, ''), 'base64');
  if (/^https?:\/\//i.test(ref)) {
    try {
      const response = await fetch(ref, { signal: AbortSignal.timeout(5000) });
      if (response.ok) return Buffer.from(await response.arrayBuffer());
    } catch {
    }
  }
  return null;
};

export const buildBeritaAcaraPdf = (input: BeritaAcaraInput): Promise<Buffer> =>
  new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.fontSize(14).font('Helvetica-Bold').text('MyWorkSpace', { align: 'center' });
    doc.fontSize(10).font('Helvetica').text(input.companyName, { align: 'center' });
    doc.moveDown(0.5);
    doc.moveTo(50, doc.y).lineTo(545, doc.y).strokeColor('#444').stroke();

    doc.moveDown(1.2);
    doc.fontSize(13).font('Helvetica-Bold').text('BERITA ACARA STOCK OPNAME', { align: 'center' });
    doc.moveDown(1.2);

    const meta: [string, string][] = [
      ['No. Dokumen', input.docNumber],
      ['Toko / DC', input.storeLabel],
      ['Tanggal', formatDate(input.date)],
      ['Pelaksana', input.pelaksanaName],
      ['Pihak yang Mengetahui', input.picName ?? '-']
    ];
    doc.fontSize(10).font('Helvetica');
    for (const [label, value] of meta) {
      doc.font('Helvetica-Bold').text(`${label}`, { continued: true, width: 150 });
      doc.font('Helvetica').text(`: ${value}`);
    }

    doc.moveDown(1);
    doc.fontSize(11).font('Helvetica-Bold').text('Ringkasan');
    doc.moveDown(0.4);
    doc.fontSize(10).font('Helvetica');
    const summaryRows: [string, string][] = [
      ['Baik', String(input.summary.baik)],
      ['Rusak', String(input.summary.rusak)],
      ['Belum dicek', String(input.summary.belum)],
      ['Total kartu', String(input.summary.total)]
    ];
    for (const [label, value] of summaryRows) {
      doc.font('Helvetica-Bold').text(`${label}`, { continued: true, width: 150 });
      doc.font('Helvetica').text(`: ${value}`);
    }

    doc.moveDown(1.2);
    doc.fontSize(11).font('Helvetica-Bold').text('Daftar kartu');
    doc.moveDown(0.4);

    const tableTop = doc.y;
    const colNo = 50;
    const colIccid = 100;
    const colKondisi = 330;
    doc.fontSize(9).font('Helvetica-Bold');
    doc.text('No', colNo, tableTop, { width: 45 });
    doc.text('ICCID', colIccid, tableTop, { width: 220 });
    doc.text('Kondisi', colKondisi, tableTop, { width: 150 });
    doc.moveDown(0.2);
    doc.font('Helvetica');

    for (const card of input.cards) {
      const y = doc.y;
      if (y > 720) {
        doc.addPage();
        doc.fontSize(9).font('Helvetica-Bold');
        doc.text('No', colNo, 50, { width: 45 });
        doc.text('ICCID', colIccid, 50, { width: 220 });
        doc.text('Kondisi', colKondisi, 50, { width: 150 });
        doc.font('Helvetica');
      }
      const rowY = doc.y;
      doc.text(String(card.no), colNo, rowY, { width: 45 });
      doc.text(card.iccid, colIccid, rowY, { width: 220 });
      doc.text(card.kondisi, colKondisi, rowY, { width: 150 });
    }

    doc.moveDown(2);
    const signY = Math.min(Math.max(doc.y, 560), 620);
    const drawSignBox = async (x: number, title: string, name: string, image: Buffer | null) => {
      doc.fontSize(10).font('Helvetica-Bold').text(title, x, signY, { width: 200 });
      if (image) {
        try {
          doc.image(image, x, signY + 18, { fit: [180, 80] });
        } catch {
        }
      } else {
        doc.rect(x, signY + 18, 180, 80).strokeColor('#999').stroke();
      }
      doc.fontSize(9).font('Helvetica').text(`(${name})`, x, signY + 106, { width: 200 });
    };

    void drawSignBox(50, 'Pelaksana', input.pelaksanaName, input.signImage)
      .then(() => drawSignBox(320, 'Pihak yang Mengetahui', input.picName ?? '-', input.picSignImage))
      .then(() => doc.end())
      .catch(reject);
  });
