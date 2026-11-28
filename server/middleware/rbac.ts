import { NextFunction, Request, Response } from 'express';
import { SupabaseClient } from '@supabase/supabase-js';
import { OrderRecord, RoleId, UserAccountPublic } from '../../src/shared/types';
import {
  canRoleAccessFinance,
  canRoleAccessProcurement,
  canRoleViewOrder,
} from '../../src/shared/workflow';
import { createRoleScopedSupabaseClient } from '../supabase';

export interface RbacRowFilter {
  orders: {
    allowAll: boolean;
    salesOwnerId?: RoleId;
    minStage?: number;
    includeReturnedToAccounting?: boolean;
    hideFinancialFields: boolean;
  };
  checks: {
    allowed: boolean;
    allowAll: boolean;
    salesOwnerId?: RoleId;
  };
  procurement: {
    allowed: boolean;
  };
  settings: {
    canRead: boolean;
    canWrite: boolean;
  };
}

export interface AuthedRequest extends Request {
  user?: UserAccountPublic;
  sessionTokenHash?: string;
  rbac?: RbacRowFilter;
  /**
   * Request-scoped Supabase client authenticated with a short-lived HS256 RLS JWT
   * bearing the verified user's `app_role` and `app_user_id`. Null when Supabase
   * environment variables are not configured (local SQLite fallback mode).
   */
  supabase?: SupabaseClient | null;
}

export type TokenAuthenticator = (
  rawToken: string,
) => { user: UserAccountPublic; tokenHash: string } | null;

export function extractBearerToken(req: Request): string | null {
  const header = req.headers.authorization;
  if (header && header.startsWith('Bearer ')) {
    const token = header.slice(7).trim();
    if (token.length >= 32) return token;
  }
  return null;
}

/**
 * Pure RBAC policy descriptor mirroring the PostgreSQL Row-Level Security (RLS) policies
 * in `supabase/migrations/001_rbac_and_storage.sql` 1:1.
 */
export function buildSupabaseRowFilter(user: Pick<UserAccountPublic, 'id' | 'isSales'>): RbacRowFilter {
  const roleId = user.id;
  const hideFinancialFields = roleId === 'warehouse_sup' || roleId === 'driver';

  const orders: RbacRowFilter['orders'] =
    roleId === 'ceo' || roleId === 'sales_mgr' || roleId === 'accounting'
      ? { allowAll: true, hideFinancialFields: false }
      : user.isSales
        ? { allowAll: false, salesOwnerId: roleId, hideFinancialFields: false }
        : roleId === 'warehouse_sup'
          ? { allowAll: false, minStage: 5, includeReturnedToAccounting: true, hideFinancialFields: true }
          : { allowAll: false, minStage: 6, hideFinancialFields: true };

  const financeAllowed = canRoleAccessFinance(roleId);
  const checks: RbacRowFilter['checks'] = !financeAllowed
    ? { allowed: false, allowAll: false }
    : user.isSales
      ? { allowed: true, allowAll: false, salesOwnerId: roleId }
      : { allowed: true, allowAll: true };

  return {
    orders,
    checks,
    procurement: { allowed: canRoleAccessProcurement(roleId) },
    settings: {
      canRead: roleId === 'ceo',
      canWrite: roleId === 'ceo',
    },
  };
}

/**
 * Evaluates row-level authorization for a stored file object before streaming or issuing a signed URL.
 */
export function evaluateFileRbac(params: {
  user: Pick<UserAccountPublic, 'id' | 'isSales'>;
  ownerKind: string;
  uploadedBy: string;
  ownerRecordId: string | null;
  checkSalesOwnerId?: string | null;
  orderMeta?: { salesOwnerId: string; stage: number; status: OrderRecord['status'] } | null;
}): { allowed: boolean; error?: string } {
  const { user, ownerKind, uploadedBy, ownerRecordId, checkSalesOwnerId, orderMeta } = params;

  // Unlinked temporary upload: strictly confined to the uploader or CEO
  if (!ownerRecordId) {
    if (uploadedBy === user.id || user.id === 'ceo') {
      return { allowed: true };
    }
    return { allowed: false, error: 'دسترسی به فایل موقت سایر کاربران مجاز نیست.' };
  }

  if (ownerKind === 'check_attachment') {
    if (!canRoleAccessFinance(user.id)) {
      return { allowed: false, error: 'دسترسی به تصاویر اسناد مالی برای این نقش مجاز نیست.' };
    }
    if (user.isSales && checkSalesOwnerId && checkSalesOwnerId !== user.id) {
      return { allowed: false, error: 'شما فقط مجاز به مشاهده مدارک مشتریان خود هستید.' };
    }
    return { allowed: true };
  }

  if (ownerKind === 'order_doc' || ownerKind === 'signature') {
    if (orderMeta && !canRoleViewOrder(user.id, orderMeta)) {
      return { allowed: false, error: 'دسترسی به فایل این سفارش برای شما مجاز نیست.' };
    }
    return { allowed: true };
  }

  return user.id === 'ceo'
    ? { allowed: true }
    : { allowed: false, error: 'دسترسی به این فایل مجاز نیست.' };
}

/**
 * Server-side Authentication & RBAC Context Middleware Factory.
 * Verifies the Bearer session token, computes the role's database row filter, and attaches
 * a request-scoped Supabase RLS client (`req.supabase`) without ever exposing API keys to the client.
 */
export function createAuthMiddleware(authenticateToken: TokenAuthenticator) {
  return function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
    const token = extractBearerToken(req);
    if (!token) {
      res.status(401).json({ error: 'لطفاً ابتدا وارد کارتابل سازمانی شوید.' });
      return;
    }
    const auth = authenticateToken(token);
    if (!auth) {
      res.status(401).json({ error: 'نشست شما منقضی شده است؛ لطفاً مجدداً وارد شوید.' });
      return;
    }
    req.user = auth.user;
    req.sessionTokenHash = auth.tokenHash;
    req.rbac = buildSupabaseRowFilter(auth.user);
    req.supabase = createRoleScopedSupabaseClient(auth.user);
    next();
  };
}

/**
 * Declarative Express RBAC Middleware enforcing allowed role IDs at the server boundary.
 */
export function requireRoles(allowedRoles: RoleId[], customMessage?: string) {
  const allowedSet = new Set<RoleId>(allowedRoles);
  return function rbacRoleGuard(req: AuthedRequest, res: Response, next: NextFunction): void {
    if (!req.user) {
      res.status(401).json({ error: 'احراز هویت الزامی است.' });
      return;
    }
    if (!allowedSet.has(req.user.id)) {
      res.status(403).json({
        error: customMessage || 'شما مجوز دسترسی به این عملیات را ندارید.',
      });
      return;
    }
    next();
  };
}

export function requireSalesRole(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'احراز هویت الزامی است.' });
    return;
  }
  if (!req.user.isSales) {
    res.status(403).json({ error: 'این عملیات فقط برای کارشناسان فروش مجاز است.' });
    return;
  }
  next();
}

export function requireFinanceAccess(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'احراز هویت الزامی است.' });
    return;
  }
  if (!canRoleAccessFinance(req.user.id)) {
    res.status(403).json({ error: 'دسترسی به اسناد مالی، چک‌ها و واریزی‌ها برای این نقش مجاز نیست.' });
    return;
  }
  next();
}

export function requireProcurementAccess(req: AuthedRequest, res: Response, next: NextFunction): void {
  if (!req.user) {
    res.status(401).json({ error: 'احراز هویت الزامی است.' });
    return;
  }
  if (!canRoleAccessProcurement(req.user.id)) {
    res.status(403).json({ error: 'دسترسی به ماژول تامین کالا برای این نقش مجاز نیست.' });
    return;
  }
  next();
}
