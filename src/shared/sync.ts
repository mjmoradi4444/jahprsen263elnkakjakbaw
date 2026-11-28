import {
  CheckRecord,
  OrderRecord,
  UserAccountPublic,
} from './types';
import { canRoleActOnOrder } from './workflow';

/**
 * Pure incremental synchronization, local projection/aggregation, & Storage URL validation helpers.
 * Shared across Express API routes, Supabase incremental fetchers, and React state mergers.
 */

const ISO_TIMESTAMP_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

/**
 * Validates and normalizes an incoming `since` (`updated_at`) cursor string.
 * Rejects malformed or injection strings and returns a canonical ISO-8601 UTC timestamp, or null.
 */
export function parseSinceCursor(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 40 || !ISO_TIMESTAMP_RE.test(trimmed)) {
    return null;
  }
  const ms = Date.parse(trimmed);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

/**
 * Computes the high-water mark ISO timestamp across a list of `updated_at` timestamps,
 * never moving the cursor backwards relative to `previousCursor`.
 */
export function computeLatestCursor(
  timestamps: Array<string | null | undefined>,
  previousCursor: string | null = null,
): string | null {
  let maxMs = -Infinity;
  let bestIso: string | null = null;

  const candidates = previousCursor ? [previousCursor, ...timestamps] : timestamps;
  for (const ts of candidates) {
    if (!ts) continue;
    const ms = Date.parse(ts);
    if (Number.isFinite(ms) && ms > maxMs) {
      maxMs = ms;
      bestIso = new Date(ms).toISOString();
    }
  }
  return bestIso;
}

/**
 * Merges incrementally fetched records (`updated_at > since`) into an existing list by `id`.
 * - Inserts newly created records.
 * - Replaces existing records only when the incoming record is equal or newer (`updatedAt >= existing.updatedAt`).
 * - Preserves untouched records without re-downloading them.
 * - Returns records sorted by `updatedAt DESC`.
 */
export function mergeIncrementalRecords<T extends { id: string; updatedAt: string }>(
  existing: T[],
  delta: T[],
): T[] {
  if (delta.length === 0) return existing;

  const map = new Map<string, T>();
  for (const item of existing) {
    map.set(item.id, item);
  }

  for (const incoming of delta) {
    const current = map.get(incoming.id);
    if (!current) {
      map.set(incoming.id, incoming);
      continue;
    }
    const curMs = Date.parse(current.updatedAt);
    const incMs = Date.parse(incoming.updatedAt);
    if (!Number.isFinite(curMs) || !Number.isFinite(incMs) || incMs >= curMs) {
      map.set(incoming.id, incoming);
    }
  }

  return Array.from(map.values()).sort((a, b) => {
    const aMs = Date.parse(a.updatedAt) || 0;
    const bMs = Date.parse(b.updatedAt) || 0;
    if (bMs !== aMs) return bMs - aMs;
    return b.id.localeCompare(a.id);
  });
}

/**
 * Validates that a file URL returned by the database or Storage resolver is safe to load:
 * - Allows relative authenticated proxy URLs (`/api/files/...`)
 * - Allows HTTPS Supabase Storage URLs (`https://<host>/storage/v1/...`)
 * - Strictly rejects `javascript:`, `data:`, `http:`, protocol-relative `//`, or path traversal.
 */
export function isSafeStorageResourceUrl(url: string): boolean {
  if (typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (!trimmed || trimmed.includes('\0') || trimmed.includes('..')) return false;

  if (trimmed.startsWith('/api/files/')) {
    return /^\/api\/files\/[A-Za-z0-9._~%-]+(?:\?.*)?$/.test(trimmed);
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== 'https:') return false;
    return parsed.pathname.startsWith('/storage/v1/');
  } catch {
    return false;
  }
}

/**
 * Returns true when `url` is a safe, directly readable Supabase Storage public URL
 * (`https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>`).
 */
export function isDirectSupabasePublicUrl(url: string | null | undefined): boolean {
  if (!url || !isSafeStorageResourceUrl(url)) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.protocol === 'https:' && parsed.pathname.startsWith('/storage/v1/object/public/');
  } catch {
    return false;
  }
}

/**
 * Computes filtered/paginated orders view, KPI stats, stage counts, and rep breakdown
 * locally from the incrementally synced `OrderRecord[]` cache — eliminating full-table reloads!
 */
export function buildOrdersViewState(
  visibleAll: OrderRecord[],
  user: UserAccountPublic,
  roles: UserAccountPublic[],
  options: {
    filter: string;
    stage: number | null;
    search: string;
    page: number;
    limit: number;
  },
) {
  const stats = {
    total: visibleAll.length,
    salesFlow: visibleAll.filter((o) => o.stage <= 4).length,
    warehouse: visibleAll.filter((o) => o.status === 'active' && o.stage === 5).length,
    driver: visibleAll.filter((o) => o.status === 'active' && o.stage === 6).length,
    delivered: visibleAll.filter((o) => o.stage >= 7).length,
    returned: visibleAll.filter((o) => o.status !== 'active').length,
    totalActiveAmountToman: visibleAll
      .filter((o) => o.stage < 7)
      .reduce((sum, o) => sum + (o.amountToman || 0), 0),
    totalDeliveredAmountToman: visibleAll
      .filter((o) => o.stage >= 7)
      .reduce((sum, o) => sum + (o.amountToman || 0), 0),
  };

  const stageCounts: Record<number, number> = {
    1: visibleAll.filter((o) => o.status === 'returned_to_sales').length,
    2: visibleAll.filter((o) => (o.status === 'active' && o.stage === 2) || o.status === 'returned_to_sales_mgr').length,
    3: visibleAll.filter((o) => o.status === 'active' && o.stage === 3).length,
    4: visibleAll.filter((o) => (o.status === 'active' && o.stage === 4) || o.status === 'returned_to_accounting').length,
    5: visibleAll.filter((o) => o.status === 'active' && o.stage === 5).length,
    6: visibleAll.filter((o) => o.status === 'active' && o.stage === 6).length,
  };

  const repBreakdown =
    user.id === 'ceo' || user.id === 'sales_mgr'
      ? roles
          .filter((r) => r.isSales)
          .map((sr) => {
            const repOrders = visibleAll.filter((o) => o.salesOwnerId === sr.id);
            return {
              roleId: sr.id,
              displayName: sr.displayName,
              total: repOrders.length,
              inProgress: repOrders.filter((o) => o.status === 'active' && o.stage < 7).length,
              returned: repOrders.filter((o) => o.status !== 'active').length,
              delivered: repOrders.filter((o) => o.stage >= 7).length,
              totalAmountToman: repOrders.reduce((s, o) => s + (o.amountToman || 0), 0),
            };
          })
      : [];

  let filtered = visibleAll;
  if (options.stage !== null && Number.isFinite(options.stage)) {
    if (options.stage === 1) filtered = filtered.filter((o) => o.status === 'returned_to_sales');
    else if (options.stage === 2)
      filtered = filtered.filter(
        (o) => (o.status === 'active' && o.stage === 2) || o.status === 'returned_to_sales_mgr',
      );
    else if (options.stage === 4)
      filtered = filtered.filter(
        (o) => (o.status === 'active' && o.stage === 4) || o.status === 'returned_to_accounting',
      );
    else filtered = filtered.filter((o) => o.status === 'active' && o.stage === options.stage);
  } else if (options.filter === 'mine') {
    filtered =
      user.id === 'ceo'
        ? filtered.filter((o) => o.stage < 7)
        : filtered.filter((o) => canRoleActOnOrder(user.id, o));
  } else if (options.filter === 'returned') {
    filtered = filtered.filter((o) => o.status !== 'active');
  } else if (options.filter === 'warehouse') {
    filtered = filtered.filter((o) => o.status === 'active' && o.stage === 5);
  } else if (options.filter === 'driver') {
    filtered = filtered.filter((o) => o.status === 'active' && o.stage === 6);
  } else if (options.filter === 'done') {
    filtered = filtered.filter((o) => o.stage >= 7);
  } else if (options.filter === 'active') {
    filtered = filtered.filter((o) => o.stage < 7);
  }

  const q = options.search.trim().toLowerCase();
  if (q) {
    filtered = filtered.filter(
      (o) =>
        o.customer.toLowerCase().includes(q) ||
        o.proforma.toLowerCase().includes(q) ||
        o.finalInvoiceNo.toLowerCase().includes(q) ||
        o.items.toLowerCase().includes(q),
    );
  }

  const totalFiltered = filtered.length;
  const limit = Math.max(1, options.limit);
  const totalPages = Math.max(1, Math.ceil(totalFiltered / limit));
  const safePage = Math.min(Math.max(1, options.page), totalPages);
  const items = filtered.slice((safePage - 1) * limit, safePage * limit);

  return {
    items,
    pagination: { page: safePage, limit, total: totalFiltered, totalPages },
    stats,
    stageCounts,
    repBreakdown,
  };
}

/**
 * Computes filtered/sorted checks view, summary totals, and uploader breakdown
 * locally from the incrementally synced `CheckRecord[]` cache — eliminating full-table reloads!
 */
export function buildChecksViewState(
  visibleAll: CheckRecord[],
  user: UserAccountPublic,
  roles: UserAccountPublic[],
  options: {
    filter: string;
    owner: string;
    sort: 'updated' | 'due_date';
  },
) {
  const summary = {
    pendingCount: visibleAll.filter((c) => c.status === 'pending').length,
    pendingMeCount:
      user.id === 'ceo'
        ? visibleAll.filter((c) => c.status === 'pending' && c.ceoStatus === 'pending').length
        : user.id === 'accounting'
          ? visibleAll.filter((c) => c.status === 'pending' && c.financeStatus === 'pending').length
          : visibleAll.filter((c) => c.status === 'returned' && c.salesOwnerId === user.id).length,
    safeChecksCount: visibleAll.filter((c) => c.status === 'finalized' && c.docType === 'چک دریافتی').length,
    safeChecksAmountToman: visibleAll
      .filter((c) => c.status === 'finalized' && c.docType === 'چک دریافتی')
      .reduce((s, c) => s + c.amountToman, 0),
    approvedDepositsCount: visibleAll.filter((c) => c.status === 'finalized' && c.docType === 'واریزی').length,
    approvedDepositsAmountToman: visibleAll
      .filter((c) => c.status === 'finalized' && c.docType === 'واریزی')
      .reduce((s, c) => s + c.amountToman, 0),
    returnedCount: visibleAll.filter((c) => c.status === 'returned').length,
  };

  const uploaderRoles = roles.filter((r) => r.isSales || r.id === 'accounting');
  const uploaderBreakdown =
    user.id === 'ceo' || user.id === 'accounting' || user.id === 'sales_mgr'
      ? uploaderRoles.map((r) => {
          const list = visibleAll.filter((c) => c.salesOwnerId === r.id);
          return {
            roleId: r.id,
            displayName: r.displayName,
            pending: list.filter((c) => c.status === 'pending').length,
            safeChecks: list.filter((c) => c.status === 'finalized' && c.docType === 'چک دریافتی').length,
            approvedDeposits: list.filter((c) => c.status === 'finalized' && c.docType === 'واریزی').length,
            returned: list.filter((c) => c.status === 'returned').length,
            finalizedAmountToman: list
              .filter((c) => c.status === 'finalized')
              .reduce((s, c) => s + c.amountToman, 0),
          };
        })
      : [];

  let list = visibleAll;
  if (!user.isSales && options.owner !== 'all') {
    list = list.filter((c) => c.salesOwnerId === options.owner);
  }

  if (options.filter === 'pending_me') {
    if (user.id === 'ceo') list = list.filter((c) => c.status === 'pending' && c.ceoStatus === 'pending');
    else if (user.id === 'accounting')
      list = list.filter((c) => c.status === 'pending' && c.financeStatus === 'pending');
    else if (user.isSales) list = list.filter((c) => c.status === 'returned');
    else list = list.filter((c) => c.status === 'pending');
  } else if (options.filter === 'safe_checks') {
    list = list.filter((c) => c.status === 'finalized' && c.docType === 'چک دریافتی');
  } else if (options.filter === 'approved_deposits') {
    list = list.filter((c) => c.status === 'finalized' && c.docType === 'واریزی');
  } else if (options.filter === 'returned') {
    list = list.filter((c) => c.status === 'returned');
  }

  if (options.sort === 'due_date' || options.filter === 'safe_checks') {
    list = [...list].sort((a, b) => {
      if (!a.dueDate && !b.dueDate) return 0;
      if (!a.dueDate) return 1;
      if (!b.dueDate) return -1;
      return a.dueDate.localeCompare(b.dueDate);
    });
  }

  return {
    items: list,
    summary,
    uploaderBreakdown,
  };
}
