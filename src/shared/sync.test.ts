import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildChecksViewState,
  buildOrdersViewState,
  computeLatestCursor,
  isDirectSupabasePublicUrl,
  isSafeStorageResourceUrl,
  mergeIncrementalRecords,
  parseSinceCursor,
} from './sync';
import type { CheckRecord, OrderRecord, UserAccountPublic } from './types';

test('parseSinceCursor accepts valid ISO timestamps and rejects malformed/injection inputs', () => {
  assert.equal(parseSinceCursor('2026-11-27T10:15:30.123Z'), '2026-11-27T10:15:30.123Z');
  assert.equal(parseSinceCursor('2026-11-27T10:15:30Z'), '2026-11-27T10:15:30.000Z');
  assert.equal(parseSinceCursor('2026-11-27T13:45:30+03:30'), '2026-11-27T10:15:30.000Z');

  assert.equal(parseSinceCursor(''), null);
  assert.equal(parseSinceCursor(null), null);
  assert.equal(parseSinceCursor('2026-11-27'), null);
  assert.equal(parseSinceCursor("2026-11-27T10:00:00Z' OR '1'='1"), null);
  assert.equal(parseSinceCursor('invalid-date'), null);
});

test('computeLatestCursor advances monotonically and never moves backwards', () => {
  const prev = '2026-11-27T12:00:00.000Z';
  assert.equal(computeLatestCursor([], prev), prev);
  assert.equal(
    computeLatestCursor(['2026-11-27T11:00:00.000Z', '2026-11-27T10:00:00.000Z'], prev),
    prev,
  );
  assert.equal(
    computeLatestCursor(['2026-11-27T11:30:00.000Z', '2026-11-27T14:22:05.500Z'], prev),
    '2026-11-27T14:22:05.500Z',
  );
  assert.equal(computeLatestCursor([]), null);
});

test('mergeIncrementalRecords merges new/updated deltas without overwriting newer local state', () => {
  const existing = [
    { id: 'ord-1', updatedAt: '2026-11-27T10:00:00.000Z', label: 'v1' },
    { id: 'ord-2', updatedAt: '2026-11-27T09:00:00.000Z', label: 'v1' },
  ];

  // Empty delta returns exact same reference (no unnecessary re-render)
  assert.equal(mergeIncrementalRecords(existing, []), existing);

  // Delta updates ord-2, adds ord-3, and attempts stale downgrade on ord-1
  const merged = mergeIncrementalRecords(existing, [
    { id: 'ord-2', updatedAt: '2026-11-27T11:00:00.000Z', label: 'v2' },
    { id: 'ord-3', updatedAt: '2026-11-27T12:00:00.000Z', label: 'new' },
    { id: 'ord-1', updatedAt: '2026-11-27T08:00:00.000Z', label: 'stale' },
  ]);

  assert.equal(merged.length, 3);
  assert.equal(merged[0].id, 'ord-3');
  assert.equal(merged[1].id, 'ord-2');
  assert.equal(merged[1].label, 'v2');
  assert.equal(merged[2].id, 'ord-1');
  assert.equal(merged[2].label, 'v1'); // Stale delta ignored!
});

test('isSafeStorageResourceUrl and isDirectSupabasePublicUrl validate Storage URLs strictly', () => {
  assert.equal(isSafeStorageResourceUrl('/api/files/fil-12345'), true);
  assert.equal(
    isSafeStorageResourceUrl(
      'https://xyzproject.supabase.co/storage/v1/object/sign/autoparts-documents/checks/fil-1.png?token=abc',
    ),
    true,
  );
  assert.equal(
    isDirectSupabasePublicUrl(
      'https://xyzproject.supabase.co/storage/v1/object/public/autoparts-documents/checks/fil-1.png',
    ),
    true,
  );
  assert.equal(
    isDirectSupabasePublicUrl(
      'https://xyzproject.supabase.co/storage/v1/object/sign/autoparts-documents/checks/fil-1.png?token=abc',
    ),
    false,
  );
  assert.equal(isDirectSupabasePublicUrl('/api/files/fil-12345'), false);

  assert.equal(isSafeStorageResourceUrl('data:text/html,<script>alert(1)</script>'), false);
  assert.equal(isSafeStorageResourceUrl('javascript:alert(1)'), false);
  assert.equal(isSafeStorageResourceUrl('http://xyzproject.supabase.co/storage/v1/object/public/a.png'), false);
  assert.equal(isSafeStorageResourceUrl('https://evil.example.com/phishing.png'), false);
  assert.equal(isSafeStorageResourceUrl('/api/files/../../etc/passwd'), false);
  assert.equal(isSafeStorageResourceUrl('//evil.example.com/storage/v1/a.png'), false);
});

test('buildOrdersViewState and buildChecksViewState recompute KPIs and filters locally from incremental cache', () => {
  const ceo: UserAccountPublic = {
    id: 'ceo',
    displayName: 'مدیرعامل',
    roleLabel: 'مدیریت ارشد',
    isSales: false,
    canAccessFinance: true,
    canAccessProcurement: true,
    scope: '',
    hasPin: true,
  };
  const sales1: UserAccountPublic = {
    id: 'sales_1',
    displayName: 'کارشناس ۱',
    roleLabel: 'فروش',
    isSales: true,
    canAccessFinance: true,
    canAccessProcurement: false,
    scope: '',
    hasPin: true,
  };

  const orders: OrderRecord[] = [
    {
      id: 'o1',
      schemaVersion: 4,
      version: 1,
      salesOwnerId: 'sales_1',
      salesOwnerName: 'کارشناس ۱',
      customer: 'مشتری اول',
      proforma: 'PF-1',
      finalInvoiceNo: '',
      accountingNote: '',
      channel: 'تلفنی',
      amountToman: 50000000,
      payment: 'نقدی',
      items: 'لنت جلو',
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
      createdAt: '2026-11-27T08:00:00.000Z',
      updatedAt: '2026-11-27T08:00:00.000Z',
    },
    {
      id: 'o2',
      schemaVersion: 4,
      version: 2,
      salesOwnerId: 'sales_1',
      salesOwnerName: 'کارشناس ۱',
      customer: 'مشتری دوم',
      proforma: 'PF-2',
      finalInvoiceNo: 'INV-2',
      accountingNote: '',
      channel: 'تلفنی',
      amountToman: 30000000,
      payment: 'نقدی',
      items: 'دیسک صفحه',
      stage: 7,
      status: 'active',
      rev: 0,
      returnReason: '',
      returnNote: '',
      cartonsOut: 3,
      exitTime: '10:00',
      driverName: 'راننده',
      cartonsDelivered: 3,
      cartonDiscrepancy: 0,
      discrepancyNote: '',
      customerSigner: 'مشتری',
      signatureFileId: null,
      signatureUrl: null,
      stageHistory: [],
      documents: [],
      createdAt: '2026-11-27T07:00:00.000Z',
      updatedAt: '2026-11-27T09:00:00.000Z',
    },
  ];

  const ordView = buildOrdersViewState(orders, ceo, [ceo, sales1], {
    filter: 'active',
    stage: null,
    search: '',
    page: 1,
    limit: 12,
  });
  assert.equal(ordView.items.length, 1);
  assert.equal(ordView.items[0].id, 'o1');
  assert.equal(ordView.stats.totalActiveAmountToman, 50000000);
  assert.equal(ordView.stats.totalDeliveredAmountToman, 30000000);
  assert.equal(ordView.stageCounts[2], 1);
  assert.equal(ordView.repBreakdown[0].total, 2);

  const checks: CheckRecord[] = [
    {
      id: 'c1',
      version: 1,
      docType: 'چک دریافتی',
      customer: 'مشتری چک',
      amountToman: 40000000,
      sayadiId: '1234567890123456',
      dueDate: '2026-12-01',
      trackingNo: '',
      caption: 'بابت فاکتور',
      salesOwnerId: 'sales_1',
      salesOwnerName: 'کارشناس ۱',
      status: 'pending',
      financeStatus: 'approved',
      financeTime: '2026-11-27T09:00:00.000Z',
      ceoStatus: 'pending',
      ceoTime: '',
      finalizedTime: '',
      rejectReason: '',
      rejectedBy: '',
      attachments: [],
      createdAt: '2026-11-27T08:00:00.000Z',
      updatedAt: '2026-11-27T09:00:00.000Z',
    },
  ];
  const chkView = buildChecksViewState(checks, ceo, [ceo, sales1], {
    filter: 'pending_me',
    owner: 'all',
    sort: 'due_date',
  });
  assert.equal(chkView.items.length, 1);
  assert.equal(chkView.summary.pendingMeCount, 1);
});
