import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildExtractionResult,
  normalizeInvoiceText,
  parseHeaderOcr,
  parseInvoiceTable,
  parseRialAmount,
  PositionedText,
} from './invoice-extract';

const t = (str: string, x: number, y: number, page = 1): PositionedText => ({ str, x, y, page });

// Exactly what pdf.js returns for the real sample invoice (single item), coordinates included.
const SINGLE_ITEM: PositionedText[] = [
  t('پيش فاكتور فروش', 264, 33),
  t('4,186,000', 230, 249),
  t('418,600,000', 158, 249),
  t('1310021007', 495, 249),
  t('تورچ', 404, 249),
  t('- 5', 420, 249),
  t('شمع موتور تيپ', 433, 249),
  t('418,600,000', 37, 248),
  t('0', 118, 248),
  t('100', 333, 249),
  t('عدد', 294, 249),
  t('0%= 0', 236, 263),
  t('0', 178, 263),
  t('418,600,000', 161, 276),
  t('100', 333, 277),
  t('418,600,000', 37, 276),
  t('0', 118, 276),
];

test('normalizes Arabic letters, digits and bidi marks', () => {
  assert.equal(normalizeInvoiceText('‫شمع موتور تيپ‬'), 'شمع موتور تیپ');
  assert.equal(normalizeInvoiceText('كد ۱۲۳'), 'کد 123');
  assert.equal(parseRialAmount('418,600,000'), 418600000);
  assert.equal(parseRialAmount('0%= 0'), null);
  assert.equal(parseRialAmount('abc'), null);
});

test('parses the real single-item sample invoice table', () => {
  const { items, totalsRowTotalRial } = parseInvoiceTable(SINGLE_ITEM);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0], {
    code: '1310021007',
    description: 'شمع موتور تیپ 5 - تورچ',
    qty: 100,
    unit: 'عدد',
    unitPriceRial: 4186000,
    lineTotalRial: 418600000,
  });
  assert.equal(totalsRowTotalRial, 418600000);
});

test('converts rial to toman and produces a clean result for the sample', () => {
  const table = parseInvoiceTable(SINGLE_ITEM);
  const r = buildExtractionResult({
    ...table,
    header: { invoiceNumber: '7191', invoiceDate: '1405/09/04', buyerCode: '10014' },
    originalFileName: 'پیش فاکتور 7191.pdf',
  });
  assert.equal(r.ok, true);
  assert.equal(r.grandTotalRial, 418600000);
  assert.equal(r.amountToman, 41860000);
  assert.equal(r.itemsText, 'شمع موتور تیپ 5 - تورچ × 100 عدد (کد 1310021007)');
  assert.deepEqual(r.warnings, {});
});

test('parses a multi-item invoice with VAT and sums correctly', () => {
  const rows: PositionedText[] = [
    // item 1
    t('1310021007', 495, 249), t('شمع موتور تيپ', 433, 249), t('100', 333, 249), t('عدد', 294, 249),
    t('4,186,000', 230, 249), t('418,600,000', 158, 249), t('41,860,000', 118, 248), t('460,460,000', 37, 248),
    t('0%= 0', 236, 263), t('0', 178, 263),
    // item 2 (description split into two runs, with a model number)
    t('2210050011', 495, 290), t('لنت ترمز جلو پژو', 430, 290), t('405', 410, 290), t('20', 333, 290),
    t('دست', 294, 290), t('1,500,000', 230, 290), t('30,000,000', 158, 290), t('3,000,000', 118, 290),
    t('33,000,000', 37, 290),
    t('0%= 0', 236, 304), t('0', 178, 304),
    // totals row
    t('448,600,000', 161, 318), t('120', 333, 318), t('44,860,000', 118, 318), t('493,460,000', 37, 318),
  ];
  const table = parseInvoiceTable(rows);
  assert.equal(table.items.length, 2);
  assert.equal(table.items[1].description, 'لنت ترمز جلو پژو 405');
  assert.equal(table.items[1].qty, 20);
  assert.equal(table.items[1].unit, 'دست');
  assert.equal(table.totalsRowTotalRial, 493460000);

  const r = buildExtractionResult({
    ...table,
    header: { invoiceNumber: '7192', invoiceDate: '1405/09/05', buyerCode: '10020' },
    originalFileName: 'invoice.pdf',
  });
  assert.equal(r.amountToman, 49346000);
  assert.deepEqual(r.warnings, {});
  assert.equal(r.itemsText.split('\n').length, 2);
});

test('flags a mismatch between line totals and the totals row', () => {
  const rows = SINGLE_ITEM.map((x) => (x.y === 276 && x.x === 37 ? { ...x, str: '418,600,010' } : x));
  const r = buildExtractionResult({
    ...parseInvoiceTable(rows),
    header: { invoiceNumber: '7191', invoiceDate: null, buyerCode: null },
    originalFileName: 'x.pdf',
  });
  assert.ok(r.warnings.amountToman);
});

test('flags an invoice number that does not match the file name', () => {
  const r = buildExtractionResult({
    ...parseInvoiceTable(SINGLE_ITEM),
    header: { invoiceNumber: '7181', invoiceDate: '1405/09/04', buyerCode: '10014' },
    originalFileName: 'پیش فاکتور 7191.pdf',
  });
  assert.ok(r.warnings.proforma);
  // A year in the file name is not treated as an invoice number.
  const r2 = buildExtractionResult({
    ...parseInvoiceTable(SINGLE_ITEM),
    header: { invoiceNumber: '7191', invoiceDate: null, buyerCode: null },
    originalFileName: 'فاکتور 1405.pdf',
  });
  assert.equal(r2.warnings.proforma, undefined);
});

test('missing OCR number produces a warning, not a guess', () => {
  const r = buildExtractionResult({
    ...parseInvoiceTable(SINGLE_ITEM),
    header: { invoiceNumber: null, invoiceDate: null, buyerCode: null },
    originalFileName: 'x.pdf',
  });
  assert.equal(r.invoiceNumber, null);
  assert.ok(r.warnings.proforma);
});

test('a PDF from a different template fails cleanly', () => {
  const r = buildExtractionResult({
    ...parseInvoiceTable([t('Hello world', 100, 100)]),
    header: { invoiceNumber: null, invoiceDate: null, buyerCode: null },
    originalFileName: 'x.pdf',
  });
  assert.equal(r.ok, false);
  assert.ok(r.error);
});

test('parses noisy OCR output for header fields', () => {
  assert.deepEqual(parseHeaderOcr({ invoiceNumber: '7191\n', invoiceDate: '1405/09/04\n', buyerCode: '(10014)3/0\n' }), {
    invoiceNumber: '7191',
    invoiceDate: '1405/09/04',
    buyerCode: '10014',
  });
  assert.equal(parseHeaderOcr({ invoiceNumber: '', invoiceDate: '1405/13/40', buyerCode: '' }).invoiceDate, null);
  assert.equal(parseHeaderOcr({ invoiceNumber: '', invoiceDate: '1405/9/4', buyerCode: '' }).invoiceDate, '1405/09/04');
});
