import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { buildRevisionChanges, parseItemsText } from './proforma-diff';

/**
 * Proforma revision flow (diff, deletion of the superseded file, CEO report) and the
 * events-log / WhatsApp access rules. Runs the real API router against a throwaway database.
 */

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'jp-rev-test-'));
process.env.DATA_DIR = tmp;
delete process.env.CEO_INITIAL_PIN;
delete process.env.SUPABASE_URL;

const CEO_PIN = '48291736';
const STAFF_PIN = '735164';
const STAFF = ['sales_1', 'sales_2', 'sales_3', 'sales_4', 'sales_mgr', 'accounting', 'warehouse_sup', 'driver'];

let server: Server;
let base = '';
const tokens: Record<string, string> = {};
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let db: any;

async function call(method: string, url: string, token?: string, body?: unknown) {
  const headers: Record<string, string> = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload: BodyInit | undefined;
  if (body instanceof FormData) payload = body;
  else if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  return fetch(base + url, { method, headers, body: payload });
}

async function upload(token: string, name: string, content: string) {
  const fd = new FormData();
  fd.append('kind', 'order_doc');
  fd.append('file', new Blob([Buffer.from(`%PDF-1.4\n% ${content}\n%%EOF\n`)], { type: 'application/pdf' }), name);
  const res = await call('POST', '/files', token, fd);
  assert.equal(res.status, 201, await res.clone().text());
  return (await res.json()).fileId as string;
}

before(async () => {
  const express = (await import('express')).default;
  const { createApiRouter } = await import('./routes');
  db = (await import('./db')).db;
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter());
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const boot = await call('POST', '/auth/bootstrap', undefined, { ceoPin: CEO_PIN, staffInitialPin: STAFF_PIN });
  assert.equal(boot.status, 201);
  tokens.ceo = (await boot.json()).token;
  for (const role of STAFF) {
    const r = await call('POST', '/auth/login', undefined, { roleId: role, pin: STAFF_PIN });
    assert.equal(r.status, 200);
    tokens[role] = (await r.json()).token;
  }
});

after(() => {
  server?.close();
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------- pure diff ----------------

test('parseItemsText reads the auto-fill format', () => {
  const items = parseItemsText('لنت ترمز جلو × 100 عدد (کد 1310021007)\nفیلتر روغن × 20 عدد (کد 22)');
  assert.deepEqual(
    items.map((i) => [i.code, i.description, i.qty, i.unit]),
    [
      ['1310021007', 'لنت ترمز جلو', 100, 'عدد'],
      ['22', 'فیلتر روغن', 20, 'عدد'],
    ],
  );
});

test('diff finds added, removed, quantity and price changes', () => {
  const mk = (code: string, qty: number, price: number | null = null) => ({
    code,
    description: `قطعه ${code}`,
    qty,
    unit: 'عدد',
    unitPriceRial: price,
    lineTotalRial: null,
  });
  const c = buildRevisionChanges([mk('1', 10, 1000), mk('2', 5), mk('3', 1)], [mk('1', 12, 1200), mk('2', 5), mk('4', 7)]);
  assert.equal(c.hasItemChanges, true);
  assert.deepEqual(c.items.added.map((i) => i.code), ['4']);
  assert.deepEqual(c.items.removed.map((i) => i.code), ['3']);
  assert.deepEqual(c.items.qtyChanged.map((i) => [i.code, i.oldQty, i.newQty]), [['1', 10, 12]]);
  assert.deepEqual(c.items.priceChanged.map((i) => [i.code, i.oldUnitPriceRial, i.newUnitPriceRial]), [['1', 1000, 1200]]);
  assert.equal(c.items.unchanged, 1);
});

test('diff without codes matches by normalised description and sums duplicates', () => {
  const c = buildRevisionChanges(parseItemsText('پمپ بنزين × 2\nپمپ بنزین × 3'), parseItemsText('پمپ بنزین × 5'));
  assert.equal(c.hasItemChanges, false);
});

// ---------------- events log & WhatsApp access ----------------

test('events log & WhatsApp summary: only CEO, accounting and warehouse supervisor', async () => {
  for (const role of ['sales_1', 'sales_2', 'sales_3', 'sales_4', 'sales_mgr', 'driver']) {
    assert.equal((await call('GET', '/logs', tokens[role])).status, 403, `${role} /logs`);
    assert.equal((await call('GET', '/whatsapp-summary', tokens[role])).status, 403, `${role} /whatsapp-summary`);
  }
  for (const role of ['ceo', 'accounting', 'warehouse_sup']) {
    assert.equal((await call('GET', '/logs', tokens[role])).status, 200, `${role} /logs`);
    assert.equal((await call('GET', '/whatsapp-summary', tokens[role])).status, 200, `${role} /whatsapp-summary`);
  }
  assert.equal((await call('GET', '/logs')).status, 401);
});

// ---------------- revision flow ----------------

test('revising a returned proforma records the differences, deletes the old file, and reports them to the CEO only', async () => {
  const oldFile = await upload(tokens.sales_1, 'pf-5001.pdf', 'old');
  // Simulate what the PDF reader stored for the original proforma.
  db.prepare(
    `INSERT INTO invoice_extractions (file_id, invoice_number, grand_total_rial, items_json, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    oldFile,
    '5001',
    30000000,
    JSON.stringify([
      { code: '100', description: 'لنت', qty: 10, unit: 'عدد', unitPriceRial: 2000000, lineTotalRial: 20000000 },
      { code: '200', description: 'فیلتر', qty: 5, unit: 'عدد', unitPriceRial: 2000000, lineTotalRial: 10000000 },
    ]),
    new Date().toISOString(),
  );
  const created = await call('POST', '/orders', tokens.sales_1, {
    customer: 'مشتری اصلاحیه',
    proforma: '5001',
    amountToman: '3000000',
    items: 'لنت × 10 عدد (کد 100)\nفیلتر × 5 عدد (کد 200)',
    fileId: oldFile,
  });
  assert.equal(created.status, 201, await created.clone().text());
  let order = (await created.json()).order;

  const oldStored = db.prepare(`SELECT stored_filename, storage_path FROM files WHERE id = ?`).get(oldFile);
  const oldDiskPath = path.join(tmp, 'uploads', oldStored.storage_path || oldStored.stored_filename);
  const diskFilesBefore = fs.readdirSync(path.join(tmp, 'uploads'), { recursive: true }).length;

  // Sales manager returns it to the rep.
  const ret = await call('POST', `/orders/${order.id}/return`, tokens.sales_mgr, {
    expectedVersion: order.version,
    target: 'sales',
    reason: 'اصلاح تعداد اقلام',
  });
  assert.equal(ret.status, 200, await ret.clone().text());
  order = (await ret.json()).order;
  assert.equal(order.status, 'returned_to_sales');

  // Rep uploads the corrected proforma; the server read it as: لنت 12, فیلتر removed, روغن added.
  const newFile = await upload(tokens.sales_1, 'pf-5001-v2.pdf', 'new');
  db.prepare(
    `INSERT INTO invoice_extractions (file_id, invoice_number, grand_total_rial, items_json, created_at) VALUES (?, ?, ?, ?, ?)`,
  ).run(
    newFile,
    '5001',
    32000000,
    JSON.stringify([
      { code: '100', description: 'لنت', qty: 12, unit: 'عدد', unitPriceRial: 2000000, lineTotalRial: 24000000 },
      { code: '300', description: 'روغن', qty: 4, unit: 'لیتر', unitPriceRial: 2000000, lineTotalRial: 8000000 },
    ]),
    new Date().toISOString(),
  );

  // Another rep cannot revise it.
  const foreign = await call('POST', `/orders/${order.id}/revise`, tokens.sales_2, {
    expectedVersion: order.version,
    proforma: '5001',
    amountToman: '3200000',
    items: 'x',
    fileId: newFile,
  });
  assert.equal(foreign.status, 403);

  const rev = await call('POST', `/orders/${order.id}/revise`, tokens.sales_1, {
    expectedVersion: order.version,
    proforma: '5001',
    amountToman: '3200000',
    items: 'لنت × 12 عدد (کد 100)\nروغن × 4 لیتر (کد 300)',
    fileId: newFile,
  });
  assert.equal(rev.status, 200, await rev.clone().text());
  const revBody = await rev.json();
  assert.equal(revBody.order.stage, 2);
  assert.equal(revBody.order.status, 'active');
  assert.equal(revBody.revision.comparisonSource, 'pdf');

  // Old proforma file is gone (row, document and binary); only the new one remains.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM files WHERE id = ?`).get(oldFile).n, 0);
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM invoice_extractions WHERE file_id = ?`).get(oldFile).n, 0);
  const docs = db.prepare(`SELECT file_id FROM order_documents WHERE order_id = ? AND doc_kind = 'proforma'`).all(order.id);
  assert.deepEqual(docs.map((d: { file_id: string }) => d.file_id), [newFile]);
  assert.equal(fs.existsSync(oldDiskPath), false, 'old binary deleted');
  const diskFilesAfter = fs.readdirSync(path.join(tmp, 'uploads'), { recursive: true }).length;
  assert.equal(diskFilesAfter, diskFilesBefore, 'one file removed, one added');
  assert.equal((await call('GET', `/files/${oldFile}`, tokens.sales_1)).status, 404);

  // The differences are in the CEO report.
  const rep = await call('GET', '/admin/reports/summary', tokens.ceo);
  assert.equal(rep.status, 200);
  const { report } = await rep.json();
  assert.equal(report.revisions.count, 1);
  assert.equal(report.revisions.withItemChanges, 1);
  assert.equal(report.revisions.amountDeltaToman, 200000);
  const r = report.revisions.items[0];
  assert.equal(r.customer, 'مشتری اصلاحیه');
  assert.equal(r.returnReason, 'اصلاح تعداد اقلام');
  assert.deepEqual(r.items.added.map((i: { code: string }) => i.code), ['300']);
  assert.deepEqual(r.items.removed.map((i: { code: string }) => i.code), ['200']);
  assert.deepEqual(
    r.items.qtyChanged.map((i: { code: string; oldQty: number; newQty: number }) => [i.code, i.oldQty, i.newQty]),
    [['100', 10, 12]],
  );

  // Excel export has the revisions sheet.
  const x = await call('GET', '/admin/reports/export.xlsx', tokens.ceo);
  assert.equal(x.status, 200);
  const ExcelJS = (await import('exceljs')).default;
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await x.arrayBuffer()) as never);
  const sheet = wb.getWorksheet('مغایرت اصلاحیه‌ها');
  assert.ok(sheet, 'revisions sheet exists');
  assert.equal(sheet!.rowCount, 1 + 3, 'header + added + removed + qty change');

  // Nobody else can read the report.
  for (const role of STAFF) {
    assert.equal((await call('GET', '/admin/reports/summary', tokens[role])).status, 403);
  }

  // A second return + revision without a new file compares against the new baseline.
  const ret2 = await call('POST', `/orders/${order.id}/return`, tokens.sales_mgr, {
    expectedVersion: revBody.order.version,
    target: 'sales',
    reason: 'قیمت',
  });
  const o2 = (await ret2.json()).order;
  const rev2 = await call('POST', `/orders/${order.id}/revise`, tokens.sales_1, {
    expectedVersion: o2.version,
    proforma: '5001',
    amountToman: '3200000',
    items: 'لنت × 12 عدد (کد 100)\nروغن × 4 لیتر (کد 300)',
  });
  assert.equal(rev2.status, 200);
  const { report: report2 } = await (await call('GET', '/admin/reports/summary', tokens.ceo)).json();
  assert.equal(report2.revisions.count, 2);
  assert.equal(report2.revisions.withItemChanges, 1, 'second revision has no item changes');
  // The new proforma file is kept when no replacement is uploaded.
  assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM files WHERE id = ?`).get(newFile).n, 1);
});

test('warehouse supervisor sees only order/procurement events, with amounts masked', async () => {
  const res = await call('GET', '/logs?limit=100', tokens.warehouse_sup);
  const { items } = await res.json();
  assert.ok(items.length > 0);
  for (const i of items as Array<{ category: string; message: string }>) {
    assert.ok(['order', 'procurement'].includes(i.category), i.category);
    assert.ok(!/[0-9۰-۹][0-9۰-۹٬,]*\s*تومان/.test(i.message), `amount leaked: ${i.message}`);
  }
  const acc = await (await call('GET', '/logs?limit=100', tokens.accounting)).json();
  assert.ok(acc.items.some((i: { message: string }) => /[۰-۹]+\s*تومان/.test(i.message)), 'accounting sees amounts');
});

// ---------------- «سایر» return reason ----------------

test('findReasonThemes surfaces the most repeated themes', async () => {
  const { findReasonThemes } = await import('./reason-insights');
  const themes = findReasonThemes([
    'مشتری موجودی انبار را می‌خواهد',
    'كد انبار اشتباه وارد شده',
    'موجودی انبار کافی نیست',
    'مشتری تماس نگرفت',
    'آدرس تحویل اشتباه است',
    'آدرس تحویل عوض شده',
  ]);
  const phrases = themes.map((t) => t.phrase);
  assert.ok(phrases.includes('موجودی انبار'), phrases.join(','));
  assert.ok(phrases.includes('آدرس تحویل'), phrases.join(','));
  assert.equal(themes.find((t) => t.phrase === 'موجودی انبار')!.count, 2);
  assert.equal(themes.find((t) => t.phrase === 'انبار')?.count ?? 3, 3);
});

test('«سایر» requires a written reason and is analysed in the CEO report', async () => {
  const reasons = ['آدرس تحویل مشتری تغییر کرده', 'آدرس تحویل اشتباه ثبت شده', 'مشتری انصراف داد'];
  for (const [i, text] of reasons.entries()) {
    const c = await call('POST', '/orders', tokens.sales_2, {
      customer: `مشتری سایر ${i}`,
      proforma: `900${i}`,
      amountToman: '1000000',
      items: 'قطعه',
    });
    const o = (await c.json()).order;
    if (i === 0) {
      const bad = await call('POST', `/orders/${o.id}/return`, tokens.sales_mgr, {
        expectedVersion: o.version,
        target: 'sales',
        reason: 'سایر',
        note: '',
      });
      assert.equal(bad.status, 400);
    }
    const ok = await call('POST', `/orders/${o.id}/return`, tokens.sales_mgr, {
      expectedVersion: o.version,
      target: 'sales',
      reason: 'سایر',
      note: text,
    });
    assert.equal(ok.status, 200, await ok.clone().text());
  }
  const { report } = await (await call('GET', '/admin/reports/summary', tokens.ceo)).json();
  assert.equal(report.orders.otherReasons.count, 3);
  assert.equal(report.orders.returnReasons.find((r: { reason: string }) => r.reason === 'سایر').count, 3);
  const theme = report.orders.otherReasons.themes.find((t: { phrase: string }) => t.phrase === 'آدرس تحویل');
  assert.ok(theme, JSON.stringify(report.orders.otherReasons.themes));
  assert.equal(theme.count, 2);
  // Earlier returns are still counted after their order was revised.
  assert.ok(report.orders.returnReasons.some((r: { reason: string }) => r.reason === 'اصلاح تعداد اقلام'));
});
