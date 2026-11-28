import test from 'node:test';
import assert from 'node:assert/strict';
import { mintSupabaseRlsJwt, verifySupabaseRlsJwt } from '../supabase';
import { buildStorageObjectPath, resolveConfinedLocalPath } from '../storage';
import {
  buildSupabaseRowFilter,
  evaluateFileRbac,
  requireFinanceAccess,
  requireProcurementAccess,
  requireRoles,
} from './rbac';
import { UserAccountPublic } from '../../src/shared/types';

function makeUser(overrides: Partial<UserAccountPublic> & { id: UserAccountPublic['id'] }): UserAccountPublic {
  return {
    displayName: overrides.id,
    roleLabel: overrides.id,
    isSales: overrides.id.startsWith('sales_') && overrides.id !== 'sales_mgr',
    canAccessFinance: !['warehouse_sup', 'driver'].includes(overrides.id),
    canAccessProcurement: ['ceo', 'sales_mgr', 'accounting', 'warehouse_sup'].includes(overrides.id),
    scope: '',
    hasPin: true,
    ...overrides,
  };
}

function runMiddleware(
  mw: (req: any, res: any, next: () => void) => void,
  user?: UserAccountPublic,
): { calledNext: boolean; statusCode: number; body: any } {
  let calledNext = false;
  let statusCode = 200;
  let body: any = null;
  const req: any = { user };
  const res: any = {
    status(code: number) {
      statusCode = code;
      return this;
    },
    json(payload: any) {
      body = payload;
      return this;
    },
  };
  mw(req, res, () => {
    calledNext = true;
  });
  return { calledNext, statusCode, body };
}

test('mintSupabaseRlsJwt signs valid HS256 role claims and rejects tampering or expiry', () => {
  const secret = 'test-supabase-jwt-secret-key-2026';
  const sales1 = makeUser({ id: 'sales_1' });
  const now = 1_750_000_000;

  const token = mintSupabaseRlsJwt(sales1, secret, 300, now);
  const claims = verifySupabaseRlsJwt(token, secret, now + 60);
  assert.ok(claims);
  assert.equal(claims.app_role, 'sales_1');
  assert.equal(claims.app_user_id, 'sales_1');
  assert.equal(claims.is_sales, true);
  assert.equal(claims.can_access_finance, true);
  assert.equal(claims.can_access_procurement, false);

  // Tampering with secret or payload fails verification
  assert.equal(verifySupabaseRlsJwt(token, 'wrong-secret-key-123456', now + 60), null);
  const tampered = `${token.slice(0, -3)}xxx`;
  assert.equal(verifySupabaseRlsJwt(tampered, secret, now + 60), null);

  // Expired token fails verification
  assert.equal(verifySupabaseRlsJwt(token, secret, now + 400), null);
});

test('buildSupabaseRowFilter mirrors database-level RLS isolation for every role', () => {
  const sales1 = buildSupabaseRowFilter(makeUser({ id: 'sales_1' }));
  assert.equal(sales1.orders.allowAll, false);
  assert.equal(sales1.orders.salesOwnerId, 'sales_1');
  assert.equal(sales1.orders.hideFinancialFields, false);
  assert.equal(sales1.checks.allowed, true);
  assert.equal(sales1.checks.salesOwnerId, 'sales_1');
  assert.equal(sales1.settings.canWrite, false);

  const driver = buildSupabaseRowFilter(makeUser({ id: 'driver' }));
  assert.equal(driver.orders.allowAll, false);
  assert.equal(driver.orders.minStage, 6);
  assert.equal(driver.orders.hideFinancialFields, true);
  assert.equal(driver.checks.allowed, false);
  assert.equal(driver.procurement.allowed, false);
  assert.equal(driver.settings.canWrite, false);

  const warehouse = buildSupabaseRowFilter(makeUser({ id: 'warehouse_sup' }));
  assert.equal(warehouse.orders.minStage, 5);
  assert.equal(warehouse.orders.includeReturnedToAccounting, true);
  assert.equal(warehouse.orders.hideFinancialFields, true);
  assert.equal(warehouse.checks.allowed, false);
  assert.equal(warehouse.procurement.allowed, true);

  const ceo = buildSupabaseRowFilter(makeUser({ id: 'ceo' }));
  assert.equal(ceo.orders.allowAll, true);
  assert.equal(ceo.checks.allowAll, true);
  assert.equal(ceo.settings.canRead, true);
  assert.equal(ceo.settings.canWrite, true);
});

test('Express RBAC middleware guards enforce 401/403 boundaries', () => {
  const ceoOnly = requireRoles(['ceo']);
  assert.equal(runMiddleware(ceoOnly, undefined).statusCode, 401);
  assert.equal(runMiddleware(ceoOnly, makeUser({ id: 'driver' })).statusCode, 403);
  assert.equal(runMiddleware(ceoOnly, makeUser({ id: 'accounting' })).statusCode, 403);
  assert.equal(runMiddleware(ceoOnly, makeUser({ id: 'ceo' })).calledNext, true);

  assert.equal(runMiddleware(requireFinanceAccess, makeUser({ id: 'driver' })).statusCode, 403);
  assert.equal(runMiddleware(requireFinanceAccess, makeUser({ id: 'warehouse_sup' })).statusCode, 403);
  assert.equal(runMiddleware(requireFinanceAccess, makeUser({ id: 'sales_1' })).calledNext, true);

  assert.equal(runMiddleware(requireProcurementAccess, makeUser({ id: 'sales_1' })).statusCode, 403);
  assert.equal(runMiddleware(requireProcurementAccess, makeUser({ id: 'warehouse_sup' })).calledNext, true);
});

test('evaluateFileRbac blocks cross-rep and unauthorized finance/order file downloads', () => {
  const sales1 = makeUser({ id: 'sales_1' });
  const sales2 = makeUser({ id: 'sales_2' });
  const driver = makeUser({ id: 'driver' });

  // Driver cannot download check attachments
  assert.equal(
    evaluateFileRbac({
      user: driver,
      ownerKind: 'check_attachment',
      uploadedBy: 'sales_1',
      ownerRecordId: 'chk-1',
      checkSalesOwnerId: 'sales_1',
    }).allowed,
    false,
  );

  // Sales 2 cannot download Sales 1's check or order document
  assert.equal(
    evaluateFileRbac({
      user: sales2,
      ownerKind: 'check_attachment',
      uploadedBy: 'sales_1',
      ownerRecordId: 'chk-1',
      checkSalesOwnerId: 'sales_1',
    }).allowed,
    false,
  );

  assert.equal(
    evaluateFileRbac({
      user: sales2,
      ownerKind: 'order_doc',
      uploadedBy: 'sales_1',
      ownerRecordId: 'ord-1',
      orderMeta: { salesOwnerId: 'sales_1', stage: 2, status: 'active' },
    }).allowed,
    false,
  );

  // Sales 1 CAN download their own order doc
  assert.equal(
    evaluateFileRbac({
      user: sales1,
      ownerKind: 'order_doc',
      uploadedBy: 'sales_1',
      ownerRecordId: 'ord-1',
      orderMeta: { salesOwnerId: 'sales_1', stage: 2, status: 'active' },
    }).allowed,
    true,
  );

  // Driver cannot download stage-4 order doc, but CAN download stage-6 order doc
  assert.equal(
    evaluateFileRbac({
      user: driver,
      ownerKind: 'order_doc',
      uploadedBy: 'sales_1',
      ownerRecordId: 'ord-1',
      orderMeta: { salesOwnerId: 'sales_1', stage: 4, status: 'active' },
    }).allowed,
    false,
  );
  assert.equal(
    evaluateFileRbac({
      user: driver,
      ownerKind: 'signature',
      uploadedBy: 'driver',
      ownerRecordId: 'ord-2',
      orderMeta: { salesOwnerId: 'sales_1', stage: 6, status: 'active' },
    }).allowed,
    true,
  );
});

test('Storage object paths are partitioned safely and reject path traversal', () => {
  assert.equal(buildStorageObjectPath('order_doc', 'fil-abc123', '.pdf'), 'orders/fil-abc123.pdf');
  assert.equal(buildStorageObjectPath('signature', 'fil-sig99', '.png'), 'signatures/fil-sig99.png');
  assert.equal(buildStorageObjectPath('check_attachment', 'fil-chk77', '.jpg'), 'checks/fil-chk77.jpg');

  assert.equal(resolveConfinedLocalPath('../../etc/passwd'), null);
  assert.equal(resolveConfinedLocalPath('orders/../../secret.txt'), null);
  assert.ok(resolveConfinedLocalPath('orders/fil-abc123.pdf')?.endsWith('orders/fil-abc123.pdf'));
});
