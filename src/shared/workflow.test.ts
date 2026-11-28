import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBoundedWhatsAppSummary,
  canRoleAccessFinance,
  canRoleActOnOrder,
  canRoleReviseCheck,
  canRoleViewOrder,
  computeCartonDiscrepancy,
  CURRENT_SCHEMA_VERSION,
  detectSafeFileType,
  getDueDateUrgency,
  migrateLegacyOrder,
  normalizeDigits,
  parseAmountToman,
  projectOrderForRole,
  validateSayadiId,
  WHATSAPP_MAX_CHARS,
} from './workflow';
import type { OrderRecord } from './types';

test('normalizeDigits and parseAmountToman handle Persian/Arabic numerals and separators', () => {
  assert.equal(normalizeDigits('۱۴۰۵/۰۹/۰۴'), '1405/09/04');
  assert.equal(parseAmountToman('۷۵,۰۰۰,۰۰۰ تومان'), 75000000);
  assert.equal(parseAmountToman('45،500،000'), 45500000);
  assert.equal(parseAmountToman('متن نامعتبر'), null);
  assert.equal(parseAmountToman(''), null);
});

test('validateSayadiId enforces 16 numeric digits', () => {
  const ok = validateSayadiId('۱۲۳۴-۵۶۷۸-۹۰۱۲-۳۴۵۶');
  assert.equal(ok.valid, true);
  assert.equal(ok.normalized, '1234567890123456');

  const tooShort = validateSayadiId('123456');
  assert.equal(tooShort.valid, false);

  const nonDigits = validateSayadiId('123456789012345a');
  assert.equal(nonDigits.valid, false);
});

test('migrateLegacyOrder is strictly idempotent and prevents stage 3 -> 2 loop', () => {
  // Legacy order at stage 3 (previously mapped to stage 2)
  const firstPass = migrateLegacyOrder({ stage: 3, status: 'active' });
  assert.equal(firstPass.schemaVersion, CURRENT_SCHEMA_VERSION);
  assert.equal(firstPass.stage, 2);

  // Now sales manager approves -> advances to stage 3 with stamped schemaVersion
  const advanced = { ...firstPass, stage: 3 };
  const secondPass = migrateLegacyOrder(advanced);
  assert.equal(secondPass.stage, 3);
  assert.equal(secondPass.schemaVersion, CURRENT_SCHEMA_VERSION);
});

test('RBAC isolates sales reps, restricts warehouse/driver from finance, and strips financial fields', () => {
  const sampleOrder: OrderRecord = {
    id: 'ord-1',
    schemaVersion: 4,
    version: 1,
    salesOwnerId: 'sales_1',
    salesOwnerName: 'کارشناس فروش ۱',
    customer: 'یدک پارس',
    proforma: 'PF-1001',
    finalInvoiceNo: 'INV-1001',
    accountingNote: 'تخفیف ۵ درصد',
    channel: 'تلفنی',
    amountToman: 85000000,
    payment: 'چک صیادی ۴۵ روزه',
    items: 'دیسک و صفحه عظام',
    stage: 6,
    status: 'active',
    rev: 0,
    returnReason: '',
    returnNote: '',
    cartonsOut: 8,
    exitTime: '14:00',
    driverName: 'راننده ۱',
    cartonsDelivered: null,
    cartonDiscrepancy: 0,
    discrepancyNote: '',
    customerSigner: '',
    signatureFileId: null,
    signatureUrl: null,
    stageHistory: [],
    documents: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  assert.equal(canRoleViewOrder('sales_1', sampleOrder), true);
  assert.equal(canRoleViewOrder('sales_2', sampleOrder), false);
  assert.equal(canRoleViewOrder('driver', sampleOrder), true);
  assert.equal(canRoleViewOrder('driver', { ...sampleOrder, stage: 4 }), false);
  assert.equal(canRoleViewOrder('warehouse_sup', { ...sampleOrder, stage: 3 }), false);

  assert.equal(canRoleAccessFinance('warehouse_sup'), false);
  assert.equal(canRoleAccessFinance('driver'), false);
  assert.equal(canRoleAccessFinance('accounting'), true);
  assert.equal(canRoleAccessFinance('ceo'), true);

  const driverView = projectOrderForRole('driver', sampleOrder);
  assert.equal(driverView.amountToman, null);
  assert.equal(driverView.payment, null);
  assert.equal(driverView.accountingNote, '');

  const ceoView = projectOrderForRole('ceo', sampleOrder);
  assert.equal(ceoView.amountToman, 85000000);
});

test('accounting-uploaded rejected checks can be revised by accounting', () => {
  assert.equal(
    canRoleReviseCheck('accounting', { salesOwnerId: 'accounting', status: 'returned' }),
    true,
  );
  assert.equal(
    canRoleReviseCheck('sales_1', { salesOwnerId: 'accounting', status: 'returned' }),
    false,
  );
  assert.equal(
    canRoleReviseCheck('sales_1', { salesOwnerId: 'sales_1', status: 'returned' }),
    true,
  );
});

test('canRoleActOnOrder enforces role-stage boundaries', () => {
  assert.equal(
    canRoleActOnOrder('ceo', { salesOwnerId: 'sales_1', stage: 2, status: 'active' }),
    false,
  );
  assert.equal(
    canRoleActOnOrder('sales_mgr', { salesOwnerId: 'sales_1', stage: 2, status: 'active' }),
    true,
  );
  assert.equal(
    canRoleActOnOrder('accounting', {
      salesOwnerId: 'sales_1',
      stage: 4,
      status: 'returned_to_accounting',
    }),
    true,
  );
});

test('computeCartonDiscrepancy flags differences cleanly', () => {
  assert.deepEqual(computeCartonDiscrepancy(8, 8), { discrepancy: 0, hasDiscrepancy: false });
  assert.deepEqual(computeCartonDiscrepancy(8, 7), { discrepancy: -1, hasDiscrepancy: true });
  assert.deepEqual(computeCartonDiscrepancy(8, 9), { discrepancy: 1, hasDiscrepancy: true });
});

test('getDueDateUrgency categorizes overdue, upcoming, and normal checks', () => {
  const ref = new Date('2026-11-25T10:00:00Z');
  assert.equal(getDueDateUrgency('2026-11-20', ref).urgency, 'overdue');
  assert.equal(getDueDateUrgency('2026-11-28', ref).urgency, 'soon');
  assert.equal(getDueDateUrgency('2026-12-20', ref).urgency, 'normal');
});

test('detectSafeFileType allows real PDF/PNG/JPEG/WebP and rejects HTML/SVG XSS payloads', () => {
  const pdf = new TextEncoder().encode('%PDF-1.7\n...');
  assert.equal(detectSafeFileType(pdf).allowed, true);
  assert.equal(detectSafeFileType(pdf).mimeType, 'application/pdf');

  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00]);
  assert.equal(detectSafeFileType(png).allowed, true);
  assert.equal(detectSafeFileType(png).mimeType, 'image/png');

  const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);
  assert.equal(detectSafeFileType(jpeg).allowed, true);
  assert.equal(detectSafeFileType(jpeg).mimeType, 'image/jpeg');

  const htmlPayload = new TextEncoder().encode('<!DOCTYPE html><script>alert(1)</script>');
  assert.equal(detectSafeFileType(htmlPayload).allowed, false);

  const svgPayload = new TextEncoder().encode('<svg onload="alert(1)"></svg>');
  assert.equal(detectSafeFileType(svgPayload).allowed, false);
});

test('buildBoundedWhatsAppSummary enforces safe URL length cap on many orders', () => {
  const manyOrders: OrderRecord[] = Array.from({ length: 120 }, (_, i) => ({
    id: `ord-${i}`,
    schemaVersion: 4,
    version: 1,
    salesOwnerId: 'sales_1',
    salesOwnerName: 'کارشناس فروش ۱',
    customer: `فروشگاه قطعات یدکی شماره ${i + 1}`,
    proforma: `PF-${5000 + i}`,
    finalInvoiceNo: '',
    accountingNote: '',
    channel: 'تلفنی',
    amountToman: 25000000,
    payment: 'نقدی',
    items: 'لنت ترمز کروز',
    stage: 2,
    status: 'active',
    rev: 0,
    returnReason: '',
    returnNote: '',
    cartonsOut: null,
    exitTime: '',
    driverName: '',
    cartonsDelivered: null,
    cartonDiscrepancy: 0,
    discrepancyNote: '',
    customerSigner: '',
    signatureFileId: null,
    signatureUrl: null,
    stageHistory: [],
    documents: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }));

  const summary = buildBoundedWhatsAppSummary(manyOrders, [], '09120000000');
  assert.ok(summary.text.length <= WHATSAPP_MAX_CHARS + 120);
  assert.ok(summary.truncatedCount > 0);
  assert.ok(summary.url.startsWith('https://wa.me/989120000000?text='));
});
