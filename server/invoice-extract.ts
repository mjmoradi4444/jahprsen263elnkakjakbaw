import path from 'node:path';
import { createRequire } from 'node:module';

/**
 * Server-side reader for the company's proforma invoice PDFs (accounting software printed via
 * "Microsoft Print to PDF", Letter page, Persian RTL).
 *
 * What the PDF contains:
 *  - The items table, line totals and the column-totals row are REAL TEXT  -> read with pdf.js.
 *  - The header (invoice number, Jalali date) and the buyer code are DRAWN AS GRAPHICS -> OCR on
 *    fixed regions of the rendered page, digits only (very reliable for printed digits).
 *
 * Everything runs locally on the server (no external API). Every extracted value is a suggestion:
 * the form keeps all fields editable and flags anything that failed a cross-check.
 */

// ==================== Template geometry (PDF points, origin top-left, page 612 x 792) ====================

/** OCR regions, measured on the template. Values sit LEFT of fixed Persian labels, so they grow leftwards. */
const OCR_REGIONS = {
  invoiceNumber: { x0: 330, y0: 42, x1: 482, y1: 59 },
  invoiceDate: { x0: 330, y0: 59, x1: 482, y1: 76 },
  buyerCode: { x0: 380, y0: 147, x1: 510, y1: 168 },
} as const;

/** Column bands of the items table by x position (left edge of each text run). */
const COLUMN_BANDS = {
  code: { min: 470, max: Infinity },
  description: { min: 360, max: 470 },
  qty: { min: 315, max: 360 },
  unit: { min: 275, max: 315 },
  unitPrice: { min: 200, max: 275 },
  lineAmount: { min: 140, max: 200 },
  vat: { min: 95, max: 140 },
  lineTotal: { min: -Infinity, max: 95 },
} as const;

type Band = keyof typeof COLUMN_BANDS;

const RENDER_SCALE = 4; // ~288 DPI, enough for reliable digit OCR
const MAX_PAGES = 5;

// ==================== Types ====================

export interface PositionedText {
  str: string;
  x: number; // left edge, PDF points
  y: number; // baseline from top, PDF points
  page: number;
}

export interface ExtractedInvoiceItem {
  code: string;
  description: string;
  qty: number | null;
  unit: string;
  unitPriceRial: number | null;
  lineTotalRial: number | null;
}

export type InvoiceFieldKey = 'proforma' | 'amountToman' | 'items' | 'customer';

export interface InvoiceExtractionResult {
  ok: boolean;
  invoiceNumber: string | null;
  invoiceDate: string | null;
  buyerCode: string | null;
  grandTotalRial: number | null;
  amountToman: number | null;
  items: ExtractedInvoiceItem[];
  itemsText: string;
  /** Fields the user must double-check, with a Persian reason for each. */
  warnings: Partial<Record<InvoiceFieldKey, string>>;
  /** Human-readable reason when ok=false. */
  error?: string;
}

// ==================== Text normalisation ====================

const PERSIAN_DIGITS = '۰۱۲۳۴۵۶۷۸۹';
const ARABIC_DIGITS = '٠١٢٣٤٥٦٧٨٩';

export function normalizeInvoiceText(input: string): string {
  let s = input
    .replace(/[‎‏‪-‮⁦-⁩]/g, '') // bidi control marks
    .replace(/ي/g, 'ی')
    .replace(/ى/g, 'ی')
    .replace(/ك/g, 'ک')
    .replace(/ة/g, 'ه');
  s = s.replace(/[۰-۹]/g, (d) => String(PERSIAN_DIGITS.indexOf(d)));
  s = s.replace(/[٠-٩]/g, (d) => String(ARABIC_DIGITS.indexOf(d)));
  return s.replace(/\s+/g, ' ').trim();
}

const HAS_PERSIAN_LETTER = /[؀-ۿ]/;

/** Parses "418,600,000" -> 418600000. Returns null for anything that is not a plain grouped integer. */
export function parseRialAmount(token: string): number | null {
  const t = normalizeInvoiceText(token).replace(/[,٬،]/g, '');
  if (!/^\d{1,15}$/.test(t)) return null;
  const n = Number(t);
  return Number.isSafeInteger(n) ? n : null;
}

/**
 * pdf.js returns non-Persian runs inside RTL text in visual (left-to-right) order, e.g. the
 * logical "5 -" arrives as "- 5". Reversing the word order of such runs restores logical order;
 * Persian runs and single numbers are already in logical order.
 */
function toLogicalOrder(run: string): string {
  if (HAS_PERSIAN_LETTER.test(run)) return run;
  const words = run.split(' ').filter(Boolean);
  return words.length > 1 ? words.reverse().join(' ') : run;
}

function bandOf(x: number): Band | null {
  for (const [band, range] of Object.entries(COLUMN_BANDS) as Array<[Band, { min: number; max: number }]>) {
    if (x >= range.min && x < range.max) return band;
  }
  return null;
}

// ==================== Table parsing (pure, unit-tested) ====================

/** Groups text runs into visual rows (same page, baselines within 3pt). */
function groupRows(texts: PositionedText[]): PositionedText[][] {
  const sorted = [...texts].sort((a, b) => a.page - b.page || a.y - b.y || b.x - a.x);
  const rows: PositionedText[][] = [];
  for (const t of sorted) {
    const last = rows[rows.length - 1];
    if (last && last[0].page === t.page && Math.abs(last[0].y - t.y) <= 3) {
      last.push(t);
    } else {
      rows.push([t]);
    }
  }
  return rows;
}

export function parseInvoiceTable(rawTexts: PositionedText[]): {
  items: ExtractedInvoiceItem[];
  totalsRowTotalRial: number | null;
} {
  const texts = rawTexts
    .map((t) => ({ ...t, str: normalizeInvoiceText(t.str) }))
    .filter((t) => t.str.length > 0);

  const items: ExtractedInvoiceItem[] = [];
  let totalsRowTotalRial: number | null = null;

  for (const row of groupRows(texts)) {
    const cells: Partial<Record<Band, PositionedText[]>> = {};
    for (const t of row) {
      const band = bandOf(t.x);
      if (!band) continue;
      (cells[band] ||= []).push(t);
    }

    const codeCell = (cells.code || []).find((t) => /^\d{4,20}$/.test(t.str));
    const lineTotal = cells.lineTotal?.length ? parseRialAmount(cells.lineTotal[0].str) : null;

    if (codeCell) {
      const description = (cells.description || [])
        .sort((a, b) => b.x - a.x) // RTL: rightmost run first
        .map((t) => toLogicalOrder(t.str))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
      const qtyRaw = cells.qty?.[0]?.str ?? '';
      const qty = /^\d+(\.\d+)?$/.test(qtyRaw.replace(/,/g, '')) ? Number(qtyRaw.replace(/,/g, '')) : null;
      items.push({
        code: codeCell.str,
        description,
        qty,
        unit: (cells.unit || []).map((t) => t.str).join(' '),
        unitPriceRial: cells.unitPrice?.length ? parseRialAmount(cells.unitPrice[0].str) : null,
        lineTotalRial: lineTotal,
      });
      continue;
    }

    // Column-totals row: no item code, has a grand total in the rightmost-left column and a qty sum.
    // The last such row on the last page wins.
    if (lineTotal !== null && cells.qty?.length && items.length > 0) {
      totalsRowTotalRial = lineTotal;
    }
  }

  return { items, totalsRowTotalRial };
}

/** Pulls the invoice number, date and buyer code out of raw OCR strings. */
export function parseHeaderOcr(raw: { invoiceNumber: string; invoiceDate: string; buyerCode: string }): {
  invoiceNumber: string | null;
  invoiceDate: string | null;
  buyerCode: string | null;
} {
  const longestDigitRun = (s: string, min: number, max: number): string | null => {
    const runs = (normalizeInvoiceText(s).match(/\d+/g) || []).filter((r) => r.length >= min && r.length <= max);
    if (runs.length === 0) return null;
    return runs.sort((a, b) => b.length - a.length)[0];
  };

  const dateMatch = normalizeInvoiceText(raw.invoiceDate).match(/(1[34]\d{2})\/(\d{1,2})\/(\d{1,2})/);
  let invoiceDate: string | null = null;
  if (dateMatch) {
    const [, y, m, d] = dateMatch;
    if (Number(m) >= 1 && Number(m) <= 12 && Number(d) >= 1 && Number(d) <= 31) {
      invoiceDate = `${y}/${m.padStart(2, '0')}/${d.padStart(2, '0')}`;
    }
  }

  const buyerNorm = normalizeInvoiceText(raw.buyerCode);
  const inParens = buyerNorm.match(/\(\s*(\d{2,12})\s*\)/);

  return {
    invoiceNumber: longestDigitRun(raw.invoiceNumber, 2, 12),
    invoiceDate,
    buyerCode: inParens ? inParens[1] : longestDigitRun(buyerNorm, 2, 12),
  };
}

function formatItemsText(items: ExtractedInvoiceItem[]): string {
  return items
    .map((it) => {
      const qty = it.qty !== null ? ` × ${it.qty}${it.unit ? ` ${it.unit}` : ''}` : '';
      return `${it.description || 'کالا'}${qty} (کد ${it.code})`;
    })
    .join('\n');
}

/**
 * Combines table + OCR results into suggested form values and cross-checks them.
 * Pure function (no I/O) so it is fully unit-testable.
 */
export function buildExtractionResult(params: {
  items: ExtractedInvoiceItem[];
  totalsRowTotalRial: number | null;
  header: { invoiceNumber: string | null; invoiceDate: string | null; buyerCode: string | null };
  originalFileName: string;
}): InvoiceExtractionResult {
  const { items, totalsRowTotalRial, header, originalFileName } = params;
  const warnings: InvoiceExtractionResult['warnings'] = {};

  if (items.length === 0) {
    return {
      ok: false,
      invoiceNumber: header.invoiceNumber,
      invoiceDate: header.invoiceDate,
      buyerCode: header.buyerCode,
      grandTotalRial: null,
      amountToman: null,
      items: [],
      itemsText: '',
      warnings: {},
      error: 'ردیف کالایی در فاکتور پیدا نشد؛ احتمالاً قالب فاکتور با قالب نرم‌افزار حسابداری فرق دارد.',
    };
  }

  // Grand total: prefer the totals row; cross-check it against the sum of line totals.
  const lineSum = items.every((i) => i.lineTotalRial !== null)
    ? items.reduce((acc, i) => acc + (i.lineTotalRial as number), 0)
    : null;
  const grandTotalRial = totalsRowTotalRial ?? lineSum;

  if (grandTotalRial === null) {
    warnings.amountToman = 'جمع مبلغ فاکتور خوانده نشد؛ لطفاً مبلغ را دستی وارد کنید.';
  } else if (lineSum !== null && totalsRowTotalRial !== null && lineSum !== totalsRowTotalRial) {
    warnings.amountToman = 'جمع ردیف‌ها با جمع کل فاکتور برابر نیست؛ لطفاً مبلغ را بررسی کنید.';
  } else if (grandTotalRial % 10 !== 0) {
    warnings.amountToman = 'مبلغ ریالی بر ۱۰ بخش‌پذیر نیست؛ لطفاً تبدیل به تومان را بررسی کنید.';
  }

  // Invoice number: OCR result, cross-checked against digits in the file name when present.
  const fileNameNumbers = (normalizeInvoiceText(originalFileName).match(/\d{3,12}/g) || []).filter(
    (n) => !/^1[34]\d{2}$/.test(n), // ignore years like 1405
  );
  if (!header.invoiceNumber) {
    warnings.proforma = 'شماره فاکتور خوانده نشد؛ لطفاً دستی وارد کنید.';
  } else if (fileNameNumbers.length > 0 && !fileNameNumbers.includes(header.invoiceNumber)) {
    warnings.proforma = `شماره خوانده‌شده (${header.invoiceNumber}) با عدد داخل نام فایل یکی نیست؛ لطفاً بررسی کنید.`;
  }

  if (items.some((i) => !i.description || i.qty === null)) {
    warnings.items = 'شرح یا تعداد برخی ردیف‌ها کامل خوانده نشد؛ لطفاً اقلام را بررسی کنید.';
  }

  return {
    ok: true,
    invoiceNumber: header.invoiceNumber,
    invoiceDate: header.invoiceDate,
    buyerCode: header.buyerCode,
    grandTotalRial,
    amountToman: grandTotalRial !== null ? Math.round(grandTotalRial / 10) : null,
    items,
    itemsText: formatItemsText(items),
    warnings,
  };
}

// ==================== PDF + OCR runtime ====================

type PdfJsModule = typeof import('pdfjs-dist/legacy/build/pdf.mjs');
type TesseractWorker = Awaited<ReturnType<typeof import('tesseract.js')['createWorker']>>;

let pdfjsPromise: Promise<PdfJsModule> | null = null;
function loadPdfJs(): Promise<PdfJsModule> {
  if (!pdfjsPromise) pdfjsPromise = import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjsPromise;
}

let workerPromise: Promise<TesseractWorker> | null = null;
async function getOcrWorker(): Promise<TesseractWorker> {
  if (!workerPromise) {
    workerPromise = (async () => {
      const { createWorker, PSM } = await import('tesseract.js');
      // Language data ships inside node_modules: no network access at runtime.
      const require = createRequire(import.meta.url);
      const engDir = path.join(path.dirname(require.resolve('@tesseract.js-data/eng/package.json')), '4.0.0');
      const worker = await createWorker('eng', 1, {
        langPath: engDir,
        cachePath: path.join(path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data')), 'ocr-cache'),
        gzip: true,
      });
      await worker.setParameters({
        tessedit_char_whitelist: '0123456789/()',
        tessedit_pageseg_mode: PSM.SINGLE_LINE,
      });
      return worker;
    })().catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

// One extraction at a time: keeps memory flat on a small server and the OCR worker single-threaded.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(job: () => Promise<T>): Promise<T> {
  const run = queue.then(job, job);
  queue = run.catch(() => undefined);
  return run;
}

async function extractFromPdf(buffer: Buffer, originalFileName: string): Promise<InvoiceExtractionResult> {
  const pdfjs = await loadPdfJs();
  const { createCanvas } = await import('@napi-rs/canvas');

  const doc = await pdfjs.getDocument({
    data: new Uint8Array(buffer),
    isEvalSupported: false,
    disableFontFace: true,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;

  try {
    const pageCount = Math.min(doc.numPages, MAX_PAGES);
    const texts: PositionedText[] = [];
    for (let p = 1; p <= pageCount; p++) {
      const page = await doc.getPage(p);
      const viewport = page.getViewport({ scale: 1 });
      const content = await page.getTextContent();
      for (const item of content.items) {
        if (!('str' in item) || !item.str.trim()) continue;
        const [, , , , x, y] = item.transform as number[];
        texts.push({ str: item.str, x, y: viewport.height - y, page: p });
      }
    }
    const table = parseInvoiceTable(texts);

    // Render page 1 and OCR the header regions.
    const page1 = await doc.getPage(1);
    const vp = page1.getViewport({ scale: RENDER_SCALE });
    const canvas = createCanvas(Math.ceil(vp.width), Math.ceil(vp.height));
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page1.render({ canvasContext: ctx as unknown as CanvasRenderingContext2D, viewport: vp }).promise;

    const cropPng = (r: { x0: number; y0: number; x1: number; y1: number }): Buffer => {
      const w = Math.round((r.x1 - r.x0) * RENDER_SCALE);
      const h = Math.round((r.y1 - r.y0) * RENDER_SCALE);
      const c = createCanvas(w, h);
      c.getContext('2d').drawImage(canvas, r.x0 * RENDER_SCALE, r.y0 * RENDER_SCALE, w, h, 0, 0, w, h);
      return c.toBuffer('image/png');
    };

    const worker = await getOcrWorker();
    const ocr = async (r: { x0: number; y0: number; x1: number; y1: number }) =>
      (await worker.recognize(cropPng(r))).data.text || '';

    const header = parseHeaderOcr({
      invoiceNumber: await ocr(OCR_REGIONS.invoiceNumber),
      invoiceDate: await ocr(OCR_REGIONS.invoiceDate),
      buyerCode: await ocr(OCR_REGIONS.buyerCode),
    });

    return buildExtractionResult({ ...table, header, originalFileName });
  } finally {
    await doc.destroy();
  }
}

const EXTRACTION_TIMEOUT_MS = 30_000;

/** Public entry point. Never throws: failures come back as ok=false with a Persian message. */
export function extractInvoiceFields(buffer: Buffer, originalFileName: string): Promise<InvoiceExtractionResult> {
  const failed = (error: string): InvoiceExtractionResult => ({
    ok: false,
    invoiceNumber: null,
    invoiceDate: null,
    buyerCode: null,
    grandTotalRial: null,
    amountToman: null,
    items: [],
    itemsText: '',
    warnings: {},
    error,
  });

  return enqueue(async () => {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        extractFromPdf(buffer, originalFileName),
        new Promise<InvoiceExtractionResult>((resolve) => {
          timer = setTimeout(
            () => resolve(failed('خواندن فاکتور بیش از حد طول کشید؛ لطفاً اطلاعات را دستی وارد کنید.')),
            EXTRACTION_TIMEOUT_MS,
          );
        }),
      ]);
    } catch (err) {
      console.error('[Invoice extract] Failed:', err instanceof Error ? err.message : err);
      return failed('اطلاعات فاکتور خوانده نشد؛ لطفاً دستی وارد کنید.');
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
}
