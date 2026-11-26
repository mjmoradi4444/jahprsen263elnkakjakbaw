import {
  CheckRecord,
  OrderRecord,
  ROLE_DEFINITIONS,
  RoleId,
  STAGES,
} from './types';

export const CURRENT_SCHEMA_VERSION = 4;

export function normalizeDigits(input: string | number | null | undefined): string {
  if (input === null || input === undefined) return '';
  const fa = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];
  const ar = ['٠', '١', '٢', '٣', '٤', '٥', '٦', '٧', '٨', '٩'];
  let out = String(input).trim();
  for (let i = 0; i < 10; i++) {
    out = out.split(fa[i]).join(String(i)).split(ar[i]).join(String(i));
  }
  return out;
}

export function parseAmountToman(input: string | number | null | undefined): number | null {
  if (input === null || input === undefined) return null;
  if (typeof input === 'number') {
    if (!Number.isFinite(input) || input < 0) return null;
    return Math.round(input);
  }
  const normalized = normalizeDigits(input).replace(/[,،\s_تومانریال]/g, '');
  if (!normalized || !/^\d+$/.test(normalized)) return null;
  const num = Number(normalized);
  if (!Number.isSafeInteger(num) || num < 0) return null;
  return num;
}

export function formatAmountToman(amount: number | null | undefined): string {
  if (amount === null || amount === undefined || !Number.isFinite(amount)) return '—';
  return new Intl.NumberFormat('fa-IR').format(Math.round(amount));
}

export function validateSayadiId(input: string): { valid: boolean; normalized: string; error?: string } {
  const normalized = normalizeDigits(input).replace(/[\s-]/g, '');
  if (!normalized) {
    return { valid: false, normalized: '', error: 'شماره صیادی ۱۶ رقمی برای چک دریافتی الزامی است.' };
  }
  if (!/^\d{16}$/.test(normalized)) {
    return { valid: false, normalized, error: 'شماره صیادی باید دقیقاً ۱۶ رقم عددی باشد.' };
  }
  return { valid: true, normalized };
}

export function formatPersianDateTime(isoString: string | null | undefined): string {
  if (!isoString) return '—';
  const d = new Date(isoString);
  if (Number.isNaN(d.getTime())) return isoString;
  const datePart = new Intl.DateTimeFormat('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
  const timePart = new Intl.DateTimeFormat('fa-IR', {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d);
  return `${datePart} - ${timePart}`;
}

export function formatPersianDate(dateIso: string | null | undefined): string {
  if (!dateIso) return '—';
  const d = new Date(dateIso.length === 10 ? `${dateIso}T12:00:00Z` : dateIso);
  if (Number.isNaN(d.getTime())) return dateIso;
  return new Intl.DateTimeFormat('fa-IR', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

export type DueUrgency = 'overdue' | 'soon' | 'normal' | 'none';

export function getDueDateUrgency(dueDateIso: string | null | undefined, now: Date = new Date()): {
  urgency: DueUrgency;
  daysDiff: number | null;
  label: string;
} {
  if (!dueDateIso || !/^\d{4}-\d{2}-\d{2}$/.test(dueDateIso)) {
    return { urgency: 'none', daysDiff: null, label: '' };
  }
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const [y, m, day] = dueDateIso.split('-').map(Number);
  const dueUtc = Date.UTC(y, m - 1, day);
  const daysDiff = Math.round((dueUtc - todayUtc) / (24 * 60 * 60 * 1000));

  if (daysDiff < 0) {
    return {
      urgency: 'overdue',
      daysDiff,
      label: `سررسید گذشته (${new Intl.NumberFormat('fa-IR').format(Math.abs(daysDiff))} روز پیش)`,
    };
  }
  if (daysDiff === 0) {
    return { urgency: 'soon', daysDiff: 0, label: 'سررسید امروز' };
  }
  if (daysDiff <= 7) {
    return {
      urgency: 'soon',
      daysDiff,
      label: `${new Intl.NumberFormat('fa-IR').format(daysDiff)} روز تا سررسید`,
    };
  }
  return {
    urgency: 'normal',
    daysDiff,
    label: `${new Intl.NumberFormat('fa-IR').format(daysDiff)} روز مانده`,
  };
}

/**
 * Idempotent migration for legacy order records (fixes the stage 3 -> 2 infinite loop bug).
 * Always stamps schemaVersion = CURRENT_SCHEMA_VERSION so repeated runs are strictly no-ops.
 */
export interface LegacyOrderInput {
  id?: string;
  schemaVersion?: number;
  status?: string;
  stage?: number | string;
}

export function migrateLegacyOrder(raw: LegacyOrderInput): {
  schemaVersion: number;
  status: OrderRecord['status'];
  stage: number;
} {
  if (raw.schemaVersion && raw.schemaVersion >= 3) {
    const parsedStage = Number(raw.stage);
    const stage = Number.isFinite(parsedStage) ? Math.min(7, Math.max(1, Math.trunc(parsedStage))) : 2;
    const validStatuses: OrderRecord['status'][] = [
      'active',
      'returned_to_sales',
      'returned_to_sales_mgr',
      'returned_to_accounting',
    ];
    const status = validStatuses.includes(raw.status as OrderRecord['status'])
      ? (raw.status as OrderRecord['status'])
      : 'active';
    return { schemaVersion: CURRENT_SCHEMA_VERSION, status, stage };
  }

  let status: OrderRecord['status'] = 'active';
  let stage = Number(raw.stage);

  if (raw.status === 'returned') {
    status = 'returned_to_sales';
    stage = 1;
  } else if (raw.status === 'pending_finance') {
    status = 'active';
    stage = 4;
  } else if (raw.status === 'pending_warehouse') {
    status = 'active';
    stage = 5;
  } else if (raw.status === 'ready_to_ship') {
    status = 'active';
    stage = 6;
  } else if (raw.status === 'delivered') {
    status = 'active';
    stage = 7;
  } else if (stage === 8) {
    stage = 7;
  } else if (stage === 7) {
    stage = 6;
  } else if (stage === 5 || stage === 6) {
    stage = 5;
  } else if (stage === 4) {
    stage = 4;
  } else if (stage === 3) {
    stage = 2;
  } else if (stage === 2) {
    stage = 4;
  } else {
    stage = 2;
  }

  return {
    schemaVersion: CURRENT_SCHEMA_VERSION,
    status,
    stage: Math.min(7, Math.max(1, Number.isFinite(stage) ? Math.trunc(stage) : 2)),
  };
}

export function isSalesRole(roleId: RoleId): boolean {
  const def = ROLE_DEFINITIONS.find((r) => r.id === roleId);
  return Boolean(def?.isSales);
}

export function canRoleAccessFinance(roleId: RoleId): boolean {
  const def = ROLE_DEFINITIONS.find((r) => r.id === roleId);
  return Boolean(def?.canAccessFinance);
}

export function canRoleAccessProcurement(roleId: RoleId): boolean {
  const def = ROLE_DEFINITIONS.find((r) => r.id === roleId);
  return Boolean(def?.canAccessProcurement);
}

export function canRoleViewOrder(roleId: RoleId, order: Pick<OrderRecord, 'salesOwnerId' | 'stage' | 'status'>): boolean {
  if (isSalesRole(roleId)) {
    return order.salesOwnerId === roleId;
  }
  if (roleId === 'warehouse_sup') {
    return order.stage >= 5 || order.status === 'returned_to_accounting';
  }
  if (roleId === 'driver') {
    return order.stage >= 6;
  }
  return true;
}

/**
 * Strips sensitive financial information (amount, payment terms, accounting notes)
 * from orders sent to Warehouse or Driver roles.
 */
export function projectOrderForRole(roleId: RoleId, order: OrderRecord): OrderRecord {
  if (roleId === 'warehouse_sup' || roleId === 'driver') {
    return {
      ...order,
      amountToman: null,
      payment: null,
      accountingNote: '',
    };
  }
  return order;
}

export function canRoleActOnOrder(
  roleId: RoleId,
  order: Pick<OrderRecord, 'salesOwnerId' | 'stage' | 'status'>,
): boolean {
  if (order.stage >= 7 || roleId === 'ceo') return false;

  if (order.status === 'returned_to_sales') {
    return isSalesRole(roleId) && order.salesOwnerId === roleId;
  }
  if (order.status === 'returned_to_sales_mgr') {
    return roleId === 'sales_mgr';
  }
  if (order.status === 'returned_to_accounting') {
    return roleId === 'accounting';
  }

  if (order.stage === 2) return roleId === 'sales_mgr';
  if (order.stage === 3) return isSalesRole(roleId) && order.salesOwnerId === roleId;
  if (order.stage === 4) return roleId === 'accounting';
  if (order.stage === 5) return roleId === 'warehouse_sup';
  if (order.stage === 6) return roleId === 'driver';
  return false;
}

/**
 * Allows the original uploader (including accounting!) to revise a rejected check.
 */
export function canRoleReviseCheck(roleId: RoleId, check: Pick<CheckRecord, 'salesOwnerId' | 'status'>): boolean {
  if (check.status !== 'returned') return false;
  return check.salesOwnerId === roleId;
}

export function computeCartonDiscrepancy(cartonsOut: number | null, cartonsDelivered: number): {
  discrepancy: number;
  hasDiscrepancy: boolean;
} {
  if (cartonsOut === null || cartonsOut === undefined) {
    return { discrepancy: 0, hasDiscrepancy: false };
  }
  const diff = cartonsDelivered - cartonsOut;
  return { discrepancy: diff, hasDiscrepancy: diff !== 0 };
}

export const WHATSAPP_MAX_CHARS = 1500;

export function buildBoundedWhatsAppSummary(
  orders: OrderRecord[],
  checks: CheckRecord[],
  waPhone: string,
): { text: string; url: string; truncatedCount: number } {
  const activeOrders = orders.filter((o) => o.stage < 7);
  const deliveredOrders = orders.filter((o) => o.stage >= 7);
  const deliveredTotal = deliveredOrders.reduce((acc, o) => acc + (o.amountToman || 0), 0);

  const safeChecks = checks.filter((c) => c.status === 'finalized' && c.docType === 'چک دریافتی');
  const safeChecksTotal = safeChecks.reduce((acc, c) => acc + c.amountToman, 0);
  const approvedDeposits = checks.filter((c) => c.status === 'finalized' && c.docType === 'واریزی');
  const approvedDepositsTotal = approvedDeposits.reduce((acc, c) => acc + c.amountToman, 0);

  const headerLines = [
    `گزارش لحظه‌ای پخش قطعات یدکی (${formatPersianDateTime(new Date().toISOString())})`,
    `سفارش‌های فعال: ${activeOrders.length} | تحویل‌شده: ${deliveredOrders.length} (جمع: ${formatAmountToman(deliveredTotal)} تومان)`,
    `صندوق چک: ${safeChecks.length} فقره (${formatAmountToman(safeChecksTotal)} تومان) | واریزی تاییدشده: ${approvedDeposits.length} فقره (${formatAmountToman(approvedDepositsTotal)} تومان)`,
    '── سفارش‌های جاری ──',
  ];

  let body = headerLines.join('\n');
  let included = 0;

  for (const o of activeOrders) {
    const statusText =
      o.status === 'returned_to_sales'
        ? `برگشت به کارشناس (${o.returnReason})`
        : o.status === 'returned_to_sales_mgr'
          ? `عودت مالی به مدیر فروش (${o.returnReason})`
          : o.status === 'returned_to_accounting'
            ? `مغایرت انبار/برگشت به مالی (${o.returnReason})`
            : `مرحله ${o.stage}: ${STAGES[Math.min(o.stage - 1, STAGES.length - 1)]?.short || ''}`;

    const line = `• ${o.customer} (${o.finalInvoiceNo || o.proforma}) - ${statusText}`;
    if (body.length + line.length + 60 > WHATSAPP_MAX_CHARS) {
      break;
    }
    body += `\n${line}`;
    included++;
  }

  const truncatedCount = activeOrders.length - included;
  if (truncatedCount > 0) {
    body += `\n... و ${truncatedCount} سفارش جاری دیگر در پرتال ثبت شده است.`;
  }

  let phone = normalizeDigits(waPhone || '').replace(/\D/g, '');
  if (phone.startsWith('09')) phone = `98${phone.slice(1)}`;
  const encoded = encodeURIComponent(body);
  const url = phone ? `https://wa.me/${phone}?text=${encoded}` : `https://wa.me/?text=${encoded}`;

  return { text: body, url, truncatedCount };
}

export interface SafeFileDetection {
  allowed: boolean;
  mimeType: 'application/pdf' | 'image/png' | 'image/jpeg' | 'image/webp' | null;
  ext: '.pdf' | '.png' | '.jpg' | '.webp' | null;
}

/**
 * Inspects file magic bytes to guarantee only genuine PDF, PNG, JPEG, or WebP files
 * are accepted — blocking HTML/SVG/JS spoofing regardless of claimed MIME or filename.
 */
export function detectSafeFileType(bytes: Uint8Array): SafeFileDetection {
  if (!bytes || bytes.length < 4) {
    return { allowed: false, mimeType: null, ext: null };
  }
  // PDF: %PDF-
  if (
    bytes.length >= 5 &&
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return { allowed: true, mimeType: 'application/pdf', ext: '.pdf' };
  }
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a
  ) {
    return { allowed: true, mimeType: 'image/png', ext: '.png' };
  }
  // JPEG: FF D8 FF
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { allowed: true, mimeType: 'image/jpeg', ext: '.jpg' };
  }
  // WebP: RIFF....WEBP
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return { allowed: true, mimeType: 'image/webp', ext: '.webp' };
  }

  return { allowed: false, mimeType: null, ext: null };
}
