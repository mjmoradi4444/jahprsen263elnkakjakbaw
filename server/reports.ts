import ExcelJS from 'exceljs';
import { db, hydrateCheckRow, hydrateOrderRow, hydrateProcurementRow } from './db';
import { CeoReport, CeoReportRepRow, CeoRevisionRow, CheckRecord, OrderRecord, RevisionItemsDiff, STAGES } from '../src/shared/types';

/**
 * CEO reports. Every function here reads ALL records with no role filtering, so the routes that
 * call them must be CEO-only (enforced in routes.ts with requireRoles(['ceo'])).
 */

export interface ReportRange {
  from: string | null; // inclusive ISO timestamp
  to: string | null; // exclusive ISO timestamp
}

/** Parses ?from=&to= (ISO dates or timestamps). Invalid values are ignored rather than trusted. */
export function parseReportRange(fromRaw: unknown, toRaw: unknown): ReportRange {
  const parse = (v: unknown): string | null => {
    if (typeof v !== 'string' || !v.trim() || v.length > 40) return null;
    const ms = Date.parse(v);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  };
  return { from: parse(fromRaw), to: parse(toRaw) };
}

function inRange(iso: string | null | undefined, range: ReportRange): boolean {
  if (!iso) return false;
  if (range.from && iso < range.from) return false;
  if (range.to && iso >= range.to) return false;
  return true;
}

function deliveredAt(o: OrderRecord): string | null {
  if (o.stage < 7) return null;
  const entry = [...o.stageHistory].reverse().find((h) => h.stage === 7);
  return entry?.timestamp || o.updatedAt;
}

function wasReturned(o: OrderRecord): boolean {
  return o.status !== 'active' || o.rev > 0 || Boolean(o.returnReason);
}

function loadAll(): { orders: OrderRecord[]; checks: CheckRecord[] } {
  const orders = (db.prepare(`SELECT * FROM orders ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>).map(
    hydrateOrderRow,
  );
  const checks = (db.prepare(`SELECT * FROM checks ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>).map(
    hydrateCheckRow,
  );
  return { orders, checks };
}

// ==================== Time buckets (Tehran time, Jalali labels) ====================

const TEHRAN_OFFSET_MS = 3.5 * 3_600_000; // Iran has no DST since 2022
const DAY_MS = 86_400_000;
const MAX_TIMELINE_BUCKETS = 400;

function tehranMidnight(ms: number): number {
  const local = ms + TEHRAN_OFFSET_MS;
  return local - (((local % DAY_MS) + DAY_MS) % DAY_MS) - TEHRAN_OFFSET_MS;
}

const persianParts = new Intl.DateTimeFormat('en-US-u-ca-persian-nu-latn', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: 'numeric',
  day: 'numeric',
});
function persianYmd(ms: number): { y: number; m: number; d: number } {
  const parts = persianParts.formatToParts(new Date(ms));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value || 0);
  return { y: get('year'), m: get('month'), d: get('day') };
}
const FA_MONTHS = ['فروردین', 'اردیبهشت', 'خرداد', 'تیر', 'مرداد', 'شهریور', 'مهر', 'آبان', 'آذر', 'دی', 'بهمن', 'اسفند'];
const toFaDigits = (s: string) => s.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[Number(d)]);

/** Persian week starts on Saturday. */
function tehranWeekStart(ms: number): number {
  const mid = tehranMidnight(ms);
  const weekday = new Date(mid + TEHRAN_OFFSET_MS).getUTCDay(); // 0=Sun..6=Sat in Tehran local
  const sinceSaturday = (weekday + 1) % 7;
  return mid - sinceSaturday * DAY_MS;
}

function bucketKey(ms: number, g: 'day' | 'week' | 'month'): string {
  if (g === 'day') return String(tehranMidnight(ms));
  if (g === 'week') return String(tehranWeekStart(ms));
  const { y, m } = persianYmd(ms);
  return `${y}-${String(m).padStart(2, '0')}`;
}

function bucketLabel(startMs: number, g: 'day' | 'week' | 'month'): string {
  const { y, m, d } = persianYmd(startMs);
  if (g === 'month') return `${FA_MONTHS[m - 1]} ${toFaDigits(String(y).slice(2))}`;
  return toFaDigits(`${String(m).padStart(2, '0')}/${String(d).padStart(2, '0')}`);
}

function buildTimeline(
  orders: OrderRecord[],
  range: ReportRange,
  now: Date,
): CeoReport['timeline'] {
  const createdTimes = orders.map((o) => Date.parse(o.createdAt)).filter(Number.isFinite);
  const startMs = range.from ? Date.parse(range.from) : createdTimes.length ? Math.min(...createdTimes) : now.getTime();
  const endMs = range.to ? Date.parse(range.to) - 1 : now.getTime();
  const spanDays = Math.max(1, Math.ceil((endMs - startMs) / DAY_MS));
  const granularity: 'day' | 'week' | 'month' = spanDays <= 31 ? 'day' : spanDays <= 120 ? 'week' : 'month';

  // Every bucket in the range, including empty ones, in chronological order.
  const points = new Map<string, CeoReport['timeline']['points'][number]>();
  let cursor = granularity === 'week' ? tehranWeekStart(startMs) : tehranMidnight(startMs);
  while (cursor <= endMs && points.size < MAX_TIMELINE_BUCKETS) {
    const key = bucketKey(cursor, granularity);
    if (!points.has(key)) {
      points.set(key, {
        key,
        label: bucketLabel(cursor, granularity),
        createdCount: 0,
        createdAmountToman: 0,
        deliveredCount: 0,
        deliveredAmountToman: 0,
      });
    }
    cursor += granularity === 'week' ? 7 * DAY_MS : DAY_MS;
  }

  for (const o of orders) {
    if (inRange(o.createdAt, range)) {
      const p = points.get(bucketKey(Date.parse(o.createdAt), granularity));
      if (p) {
        p.createdCount++;
        p.createdAmountToman += o.amountToman || 0;
      }
    }
    const dAt = deliveredAt(o);
    if (dAt && inRange(dAt, range)) {
      const p = points.get(bucketKey(Date.parse(dAt), granularity));
      if (p) {
        p.deliveredCount++;
        p.deliveredAmountToman += o.amountToman || 0;
      }
    }
  }
  return { granularity, points: [...points.values()] };
}

function groupOrders(orders: OrderRecord[], pick: (o: OrderRecord) => string) {
  const m = new Map<string, { label: string; count: number; amountToman: number }>();
  for (const o of orders) {
    const label = (pick(o) || 'نامشخص').trim() || 'نامشخص';
    const g = m.get(label) || { label, count: 0, amountToman: 0 };
    g.count++;
    g.amountToman += o.amountToman || 0;
    m.set(label, g);
  }
  return [...m.values()].sort((a, b) => b.amountToman - a.amountToman);
}

function loadRevisions(range: ReportRange): CeoRevisionRow[] {
  const rows = db.prepare(`SELECT * FROM order_revisions ORDER BY created_at DESC`).all() as Array<Record<string, unknown>>;
  const empty: RevisionItemsDiff = { added: [], removed: [], qtyChanged: [], priceChanged: [], unchanged: 0 };
  return rows
    .filter((r) => inRange(String(r.created_at), range))
    .map((r) => {
      let items = empty;
      try {
        items = { ...empty, ...(JSON.parse(String(r.changes_json || '{}')).items || {}) };
      } catch {
        // keep empty diff
      }
      return {
        id: String(r.id),
        orderId: String(r.order_id),
        rev: Number(r.rev),
        customer: String(r.customer),
        salesOwnerName: String(r.sales_owner_name),
        returnReason: String(r.return_reason || ''),
        returnNote: String(r.return_note || ''),
        oldProforma: String(r.old_proforma),
        newProforma: String(r.new_proforma),
        oldAmountToman: r.old_amount_toman === null ? null : Number(r.old_amount_toman),
        newAmountToman: r.new_amount_toman === null ? null : Number(r.new_amount_toman),
        items,
        comparisonSource: r.comparison_source === 'pdf' ? 'pdf' : 'text',
        createdAt: String(r.created_at),
      } as CeoRevisionRow;
    });
}

function hasItemChanges(d: RevisionItemsDiff): boolean {
  return d.added.length + d.removed.length + d.qtyChanged.length + d.priceChanged.length > 0;
}

export function buildCeoReport(range: ReportRange, now = new Date()): CeoReport {
  const { orders, checks } = loadAll();

  const created = orders.filter((o) => inRange(o.createdAt, range));
  const delivered = orders.filter((o) => inRange(deliveredAt(o), range));

  const deliveryHours = delivered
    .map((o) => (Date.parse(deliveredAt(o) as string) - Date.parse(o.createdAt)) / 3_600_000)
    .filter((h) => Number.isFinite(h) && h >= 0);

  const sum = (xs: Array<number | null | undefined>) => xs.reduce<number>((a, b) => a + (b || 0), 0);

  // Per sales rep (orders created in range + deliveries in range).
  const reps = new Map<string, CeoReportRepRow>();
  const rep = (id: string, name: string): CeoReportRepRow => {
    let r = reps.get(id);
    if (!r) {
      r = {
        salesOwnerId: id,
        salesOwnerName: name,
        ordersCreated: 0,
        amountCreatedToman: 0,
        delivered: 0,
        amountDeliveredToman: 0,
        returned: 0,
        inProgress: 0,
      };
      reps.set(id, r);
    }
    return r;
  };
  for (const o of created) {
    const r = rep(o.salesOwnerId, o.salesOwnerName);
    r.ordersCreated++;
    r.amountCreatedToman += o.amountToman || 0;
    if (wasReturned(o)) r.returned++;
    if (o.stage < 7) r.inProgress++;
  }
  for (const o of delivered) {
    const r = rep(o.salesOwnerId, o.salesOwnerName);
    r.delivered++;
    r.amountDeliveredToman += o.amountToman || 0;
  }

  // Pipeline snapshot of open orders (independent of the date range).
  const open = orders.filter((o) => o.stage < 7);
  const pipelineByStage = STAGES.map((s) => {
    const atStage = open.filter((o) => o.stage === s.id);
    return { stage: s.id, label: s.short, count: atStage.length, amountToman: sum(atStage.map((o) => o.amountToman)) };
  });

  const reasonCounts = new Map<string, number>();
  for (const o of created.filter(wasReturned)) {
    const reason = (o.returnReason || 'بدون علت ثبت‌شده').trim();
    reasonCounts.set(reason, (reasonCounts.get(reason) || 0) + 1);
  }

  // Checks submitted in range.
  const chk = checks.filter((c) => inRange(c.createdAt, range));
  const byType = new Map<string, { count: number; amountToman: number }>();
  for (const c of chk) {
    const t = byType.get(c.docType) || { count: 0, amountToman: 0 };
    t.count++;
    t.amountToman += c.amountToman || 0;
    byType.set(c.docType, t);
  }

  const today = now.toISOString().slice(0, 10);
  const in30 = new Date(now.getTime() + 30 * 86_400_000).toISOString().slice(0, 10);
  const upcomingDue = checks
    .filter((c) => c.docType === 'چک دریافتی' && c.status !== 'returned' && c.dueDate && c.dueDate >= today && c.dueDate <= in30)
    .sort((a, b) => a.dueDate.localeCompare(b.dueDate))
    .slice(0, 50)
    .map((c) => ({
      id: c.id,
      customer: c.customer,
      amountToman: c.amountToman,
      dueDate: c.dueDate,
      sayadiId: c.sayadiId,
      salesOwnerName: c.salesOwnerName,
      status: c.status,
    }));

  const procurement = (db.prepare(`SELECT * FROM procurement_items WHERE status != 'received'`).all() as Array<
    Record<string, unknown>
  >).map(hydrateProcurementRow);

  return {
    range: { from: range.from, to: range.to },
    generatedAt: now.toISOString(),
    orders: {
      created: created.length,
      amountCreatedToman: sum(created.map((o) => o.amountToman)),
      delivered: delivered.length,
      amountDeliveredToman: sum(delivered.map((o) => o.amountToman)),
      returned: created.filter(wasReturned).length,
      inProgress: created.filter((o) => o.stage < 7).length,
      avgDeliveryHours: deliveryHours.length ? Math.round((sum(deliveryHours) / deliveryHours.length) * 10) / 10 : null,
      cartonDiscrepancies: created.filter((o) => (o.cartonDiscrepancy || 0) !== 0).length,
      pipelineByStage,
      returnReasons: [...reasonCounts.entries()].map(([reason, count]) => ({ reason, count })).sort((a, b) => b.count - a.count),
    },
    reps: [...reps.values()].sort((a, b) => b.amountCreatedToman - a.amountCreatedToman),
    checks: {
      submitted: chk.length,
      amountSubmittedToman: sum(chk.map((c) => c.amountToman)),
      finalized: chk.filter((c) => c.status === 'finalized').length,
      amountFinalizedToman: sum(chk.filter((c) => c.status === 'finalized').map((c) => c.amountToman)),
      pending: chk.filter((c) => c.status === 'pending').length,
      amountPendingToman: sum(chk.filter((c) => c.status === 'pending').map((c) => c.amountToman)),
      returned: chk.filter((c) => c.status === 'returned').length,
      byDocType: [...byType.entries()].map(([docType, v]) => ({ docType, ...v })),
      upcomingDue,
    },
    procurement: {
      open: procurement.length,
      urgentOpen: procurement.filter((p) => p.priority === 'فوری').length,
    },
    timeline: buildTimeline(orders, range, now),
    byChannel: groupOrders(created, (o) => o.channel),
    byPayment: groupOrders(created, (o) => o.payment || ''),
    topCustomers: (() => {
      const m = new Map<string, { customer: string; orders: number; amountToman: number; delivered: number }>();
      for (const o of created) {
        const key = o.customer.trim();
        const c = m.get(key) || { customer: key, orders: 0, amountToman: 0, delivered: 0 };
        c.orders++;
        c.amountToman += o.amountToman || 0;
        if (o.stage >= 7) c.delivered++;
        m.set(key, c);
      }
      return [...m.values()].sort((a, b) => b.amountToman - a.amountToman).slice(0, 10);
    })(),
    revisions: (() => {
      const revs = loadRevisions(range);
      return {
        count: revs.length,
        ordersAffected: new Set(revs.map((r) => r.orderId)).size,
        withItemChanges: revs.filter((r) => hasItemChanges(r.items)).length,
        amountDeltaToman: revs.reduce((a, r) => a + ((r.newAmountToman ?? 0) - (r.oldAmountToman ?? 0)), 0),
        items: revs.slice(0, 200),
      };
    })(),
  };
}

// ==================== Excel export ====================

const TEHRAN_DT = new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});
const TEHRAN_D = new Intl.DateTimeFormat('fa-IR-u-nu-latn', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function jalaliDateTime(iso: string | null | undefined): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : TEHRAN_DT.format(d);
}
function jalaliDate(isoDate: string | null | undefined): string {
  if (!isoDate) return '';
  const d = new Date(isoDate.length === 10 ? `${isoDate}T12:00:00Z` : isoDate);
  return Number.isNaN(d.getTime()) ? isoDate : TEHRAN_D.format(d);
}

/** Excel interprets cells starting with = + - @ as formulas; neutralise user-entered text. */
function safeText(v: unknown): string {
  const s = v === null || v === undefined ? '' : String(v);
  return /^[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}

const ORDER_STATUS_FA: Record<string, string> = {
  active: 'در جریان',
  returned_to_sales: 'برگشت به کارشناس',
  returned_to_sales_mgr: 'برگشت به مدیر فروش',
  returned_to_accounting: 'برگشت به حسابداری',
};
const CHECK_STATUS_FA: Record<string, string> = { pending: 'در انتظار تایید', finalized: 'نهایی‌شده', returned: 'برگشتی' };
const APPROVAL_FA: Record<string, string> = { pending: 'در انتظار', approved: 'تایید', rejected: 'رد' };

function styleSheet(ws: ExcelJS.Worksheet): void {
  ws.views = [{ rightToLeft: true, state: 'frozen', ySplit: 1 }];
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1E3A8A' } };
  header.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
  header.height = 22;
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

export async function buildReportWorkbook(range: ReportRange): Promise<Buffer> {
  const report = buildCeoReport(range);
  const { orders, checks } = loadAll();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'پرتال یکپارچه پخش قطعات یدکی';
  wb.created = new Date();
  const money = '#,##0';

  // Summary
  const sum = wb.addWorksheet('خلاصه');
  sum.columns = [
    { header: 'شاخص', key: 'k', width: 42 },
    { header: 'مقدار', key: 'v', width: 22, style: { numFmt: money } },
  ];
  const rangeText = `${range.from ? jalaliDate(range.from) : 'ابتدا'} تا ${range.to ? jalaliDate(new Date(Date.parse(range.to) - 1).toISOString()) : 'امروز'}`;
  sum.addRows([
    { k: 'بازه گزارش', v: rangeText },
    { k: 'تاریخ تهیه', v: jalaliDateTime(report.generatedAt) },
    { k: 'پیش‌فاکتورهای ثبت‌شده', v: report.orders.created },
    { k: 'مبلغ پیش‌فاکتورهای ثبت‌شده (تومان)', v: report.orders.amountCreatedToman },
    { k: 'سفارش‌های تحویل‌شده', v: report.orders.delivered },
    { k: 'مبلغ تحویل‌شده (تومان)', v: report.orders.amountDeliveredToman },
    { k: 'سفارش‌های دارای برگشت', v: report.orders.returned },
    { k: 'سفارش‌های در جریان', v: report.orders.inProgress },
    { k: 'میانگین زمان ثبت تا تحویل (ساعت)', v: report.orders.avgDeliveryHours ?? '-' },
    { k: 'مغایرت کارتن', v: report.orders.cartonDiscrepancies },
    { k: 'چک/واریزی ثبت‌شده', v: report.checks.submitted },
    { k: 'مبلغ چک/واریزی ثبت‌شده (تومان)', v: report.checks.amountSubmittedToman },
    { k: 'چک/واریزی نهایی‌شده (تومان)', v: report.checks.amountFinalizedToman },
    { k: 'چک/واریزی در انتظار تایید (تومان)', v: report.checks.amountPendingToman },
    { k: 'اقلام کسری باز در تامین', v: report.procurement.open },
  ]);
  styleSheet(sum);

  // Per rep
  const reps = wb.addWorksheet('عملکرد کارشناسان');
  reps.columns = [
    { header: 'کارشناس', key: 'name', width: 24 },
    { header: 'پیش‌فاکتور ثبت‌شده', key: 'c', width: 16 },
    { header: 'مبلغ ثبت‌شده (تومان)', key: 'ca', width: 20, style: { numFmt: money } },
    { header: 'تحویل‌شده', key: 'd', width: 12 },
    { header: 'مبلغ تحویل‌شده (تومان)', key: 'da', width: 20, style: { numFmt: money } },
    { header: 'برگشتی', key: 'r', width: 10 },
    { header: 'در جریان', key: 'p', width: 10 },
  ];
  for (const r of report.reps) {
    reps.addRow({
      name: safeText(r.salesOwnerName),
      c: r.ordersCreated,
      ca: r.amountCreatedToman,
      d: r.delivered,
      da: r.amountDeliveredToman,
      r: r.returned,
      p: r.inProgress,
    });
  }
  styleSheet(reps);

  // Orders (created in range)
  const os = wb.addWorksheet('سفارش‌ها');
  os.columns = [
    { header: 'شماره پیش‌فاکتور', key: 'proforma', width: 16 },
    { header: 'شماره فاکتور نهایی', key: 'final', width: 16 },
    { header: 'مشتری', key: 'customer', width: 26 },
    { header: 'کارشناس', key: 'rep', width: 18 },
    { header: 'مبلغ (تومان)', key: 'amount', width: 16, style: { numFmt: money } },
    { header: 'تسویه', key: 'payment', width: 18 },
    { header: 'کانال', key: 'channel', width: 12 },
    { header: 'مرحله', key: 'stage', width: 18 },
    { header: 'وضعیت', key: 'status', width: 18 },
    { header: 'علت برگشت', key: 'reason', width: 22 },
    { header: 'کارتن خروجی', key: 'cout', width: 12 },
    { header: 'کارتن تحویلی', key: 'cin', width: 12 },
    { header: 'تاریخ ثبت', key: 'created', width: 18 },
    { header: 'تاریخ تحویل', key: 'delivered', width: 18 },
    { header: 'اقلام', key: 'items', width: 50 },
  ];
  for (const o of orders.filter((x) => inRange(x.createdAt, range))) {
    os.addRow({
      proforma: safeText(o.proforma),
      final: safeText(o.finalInvoiceNo),
      customer: safeText(o.customer),
      rep: safeText(o.salesOwnerName),
      amount: o.amountToman ?? null,
      payment: safeText(o.payment),
      channel: safeText(o.channel),
      stage: o.stage >= 7 ? 'تحویل‌شده' : STAGES[o.stage - 1]?.short || String(o.stage),
      status: ORDER_STATUS_FA[o.status] || o.status,
      reason: safeText(o.returnReason),
      cout: o.cartonsOut,
      cin: o.cartonsDelivered,
      created: jalaliDateTime(o.createdAt),
      delivered: jalaliDateTime(deliveredAt(o)),
      items: safeText(o.items),
    });
  }
  styleSheet(os);

  // Checks (submitted in range)
  const cs = wb.addWorksheet('چک‌ها و واریزی‌ها');
  cs.columns = [
    { header: 'نوع', key: 'type', width: 12 },
    { header: 'مشتری', key: 'customer', width: 26 },
    { header: 'مبلغ (تومان)', key: 'amount', width: 16, style: { numFmt: money } },
    { header: 'شناسه صیادی', key: 'sayadi', width: 20 },
    { header: 'سررسید', key: 'due', width: 12 },
    { header: 'شماره پیگیری', key: 'tracking', width: 16 },
    { header: 'کارشناس', key: 'rep', width: 18 },
    { header: 'تایید مالی', key: 'fin', width: 12 },
    { header: 'تایید مدیرعامل', key: 'ceo', width: 14 },
    { header: 'وضعیت', key: 'status', width: 16 },
    { header: 'علت رد', key: 'reject', width: 22 },
    { header: 'تاریخ ثبت', key: 'created', width: 18 },
  ];
  for (const c of checks.filter((x) => inRange(x.createdAt, range))) {
    cs.addRow({
      type: c.docType,
      customer: safeText(c.customer),
      amount: c.amountToman,
      sayadi: safeText(c.sayadiId),
      due: jalaliDate(c.dueDate),
      tracking: safeText(c.trackingNo),
      rep: safeText(c.salesOwnerName),
      fin: APPROVAL_FA[c.financeStatus] || c.financeStatus,
      ceo: APPROVAL_FA[c.ceoStatus] || c.ceoStatus,
      status: CHECK_STATUS_FA[c.status] || c.status,
      reject: safeText(c.rejectReason),
      created: jalaliDateTime(c.createdAt),
    });
  }
  styleSheet(cs);

  // Proforma revisions: one row per changed item (plus one row for amount-only revisions)
  const rv = wb.addWorksheet('مغایرت اصلاحیه‌ها');
  rv.columns = [
    { header: 'تاریخ اصلاح', key: 'date', width: 18 },
    { header: 'کارشناس', key: 'rep', width: 18 },
    { header: 'مشتری', key: 'customer', width: 24 },
    { header: 'پیش‌فاکتور قبلی', key: 'oldP', width: 14 },
    { header: 'پیش‌فاکتور جدید', key: 'newP', width: 14 },
    { header: 'شماره اصلاحیه', key: 'rev', width: 12 },
    { header: 'علت برگشت', key: 'reason', width: 26 },
    { header: 'نوع تغییر', key: 'kind', width: 16 },
    { header: 'کد کالا', key: 'code', width: 14 },
    { header: 'شرح کالا', key: 'desc', width: 34 },
    { header: 'مقدار قبلی', key: 'oldQ', width: 11 },
    { header: 'مقدار جدید', key: 'newQ', width: 11 },
    { header: 'مبلغ واحد قبلی (ریال)', key: 'oldU', width: 18, style: { numFmt: money } },
    { header: 'مبلغ واحد جدید (ریال)', key: 'newU', width: 18, style: { numFmt: money } },
    { header: 'مبلغ کل قبلی (تومان)', key: 'oldA', width: 18, style: { numFmt: money } },
    { header: 'مبلغ کل جدید (تومان)', key: 'newA', width: 18, style: { numFmt: money } },
    { header: 'مبنای مقایسه', key: 'src', width: 16 },
  ];
  for (const r of report.revisions.items) {
    const base = {
      date: jalaliDateTime(r.createdAt),
      rep: safeText(r.salesOwnerName),
      customer: safeText(r.customer),
      oldP: safeText(r.oldProforma),
      newP: safeText(r.newProforma),
      rev: r.rev,
      reason: safeText([r.returnReason, r.returnNote].filter(Boolean).join(' - ')),
      oldA: r.oldAmountToman,
      newA: r.newAmountToman,
      src: r.comparisonSource === 'pdf' ? 'خوانده‌شده از PDF' : 'متن اقلام',
    };
    const rows: Array<Record<string, unknown>> = [
      ...r.items.added.map((i) => ({ kind: 'قلم جدید', code: i.code, desc: i.description, newQ: i.qty })),
      ...r.items.removed.map((i) => ({ kind: 'قلم حذف‌شده', code: i.code, desc: i.description, oldQ: i.qty })),
      ...r.items.qtyChanged.map((i) => ({ kind: 'تغییر مقدار', code: i.code, desc: i.description, oldQ: i.oldQty, newQ: i.newQty })),
      ...r.items.priceChanged.map((i) => ({
        kind: 'تغییر قیمت',
        code: i.code,
        desc: i.description,
        oldU: i.oldUnitPriceRial,
        newU: i.newUnitPriceRial,
      })),
    ];
    if (rows.length === 0) rows.push({ kind: r.oldAmountToman !== r.newAmountToman ? 'فقط تغییر مبلغ' : 'بدون تغییر اقلام' });
    for (const row of rows) {
      rv.addRow({ ...base, ...row, code: safeText(row.code), desc: safeText(row.desc) });
    }
  }
  styleSheet(rv);

  const arrayBuffer = await wb.xlsx.writeBuffer();
  return Buffer.from(arrayBuffer as ArrayBuffer);
}
