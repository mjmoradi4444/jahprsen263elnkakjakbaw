import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, BarChart3, CheckCircle2, Clock, FileSpreadsheet, Hourglass, Loader2, PackageCheck, Undo2 } from 'lucide-react';
import { adminApi, ApiError } from '../api/client';
import { CeoReport } from '../shared/types';
import { CHART, ChartCard, compactToman, DataTable, fullToman, HBarChart, Legend, LineChart, SegmentedBar } from './charts';

/**
 * CEO-only reports tab. App.tsx renders it only for the CEO, and every endpoint it calls lives
 * under /api/admin, which the server rejects with 403 for any other role.
 */

interface CeoReportsProps {
  onNotify: (message: string, isError?: boolean) => void;
  refreshTrigger: number;
}

type RangeKey = 'today' | '7d' | 'month' | '30d' | '90d' | 'all';

const RANGE_LABELS: Record<RangeKey, string> = {
  today: 'امروز',
  '7d': '۷ روز اخیر',
  month: 'این ماه',
  '30d': '۳۰ روز اخیر',
  '90d': '۹۰ روز اخیر',
  all: 'همه زمان‌ها',
};

const TEHRAN_OFFSET_MS = 3.5 * 3_600_000; // Iran has no DST since 2022
const DAY = 86_400_000;
const fa = new Intl.NumberFormat('fa-IR');
const faDate = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' });

function tehranMidnight(ms: number): number {
  const local = ms + TEHRAN_OFFSET_MS;
  return local - (local % DAY) - TEHRAN_OFFSET_MS;
}

function persianDayOfMonth(ms: number): number {
  const part = new Intl.DateTimeFormat('en-US-u-ca-persian', { timeZone: 'Asia/Tehran', day: 'numeric' })
    .formatToParts(new Date(ms))
    .find((p) => p.type === 'day');
  return Number(part?.value || 1);
}

function computeRange(key: RangeKey): { from: string | null; to: string | null } {
  const now = Date.now();
  const todayStart = tehranMidnight(now);
  const to = new Date(todayStart + DAY).toISOString();
  switch (key) {
    case 'today':
      return { from: new Date(todayStart).toISOString(), to };
    case '7d':
      return { from: new Date(todayStart - 6 * DAY).toISOString(), to };
    case '30d':
      return { from: new Date(todayStart - 29 * DAY).toISOString(), to };
    case '90d':
      return { from: new Date(todayStart - 89 * DAY).toISOString(), to };
    case 'month':
      return { from: new Date(todayStart - (persianDayOfMonth(now) - 1) * DAY).toISOString(), to };
    default:
      return { from: null, to: null };
  }
}

const GRANULARITY_FA = { day: 'روزانه', week: 'هفتگی', month: 'ماهانه' } as const;

function Tile({ label, value, sub, icon }: { label: string; value: string; sub?: string; icon: React.ReactNode }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className="mt-1.5 text-2xl font-extrabold text-slate-900">{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-600 truncate">{sub}</div>}
    </div>
  );
}

export function CeoReports({ onNotify, refreshTrigger }: CeoReportsProps) {
  const [rangeKey, setRangeKey] = useState<RangeKey>('month');
  const [report, setReport] = useState<CeoReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const loadReport = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = computeRange(rangeKey);
      const res = await adminApi.getReport(r.from, r.to);
      setReport(res.report);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'دریافت گزارش با خطا مواجه شد.');
    } finally {
      setLoading(false);
    }
  }, [rangeKey]);

  useEffect(() => {
    void loadReport();
  }, [loadReport, refreshTrigger]);

  async function handleExport() {
    setExporting(true);
    try {
      const r = computeRange(rangeKey);
      await adminApi.downloadReportXlsx(r.from, r.to);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'دریافت فایل اکسل با خطا مواجه شد.', true);
    } finally {
      setExporting(false);
    }
  }

  const o = report?.orders;
  const c = report?.checks;
  const tl = report?.timeline;

  return (
    <div className="space-y-6">
      {/* One filter row scopes everything below */}
      <section className="bg-white border border-slate-200 rounded-xl p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="بازه زمانی گزارش">
          {(Object.keys(RANGE_LABELS) as RangeKey[]).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setRangeKey(k)}
              aria-pressed={rangeKey === k}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold border cursor-pointer ${
                rangeKey === k ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-700 border-slate-200 hover:bg-slate-50'
              }`}
            >
              {RANGE_LABELS[k]}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={handleExport}
          disabled={exporting}
          className="inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-60 text-white text-xs font-bold cursor-pointer"
        >
          {exporting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />}
          خروجی اکسل این بازه
        </button>
      </section>

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-semibold text-red-700">
          {error}
        </div>
      )}

      {loading && !report && (
        <div className="text-sm text-slate-600 flex items-center gap-2">
          <Loader2 className="w-4 h-4 animate-spin" /> در حال تهیه گزارش...
        </div>
      )}

      {report && o && c && tl && (
        // Refetch keeps the frame: previous render stays at reduced opacity while loading.
        <div className={`space-y-6 transition-opacity ${loading ? 'opacity-60' : ''}`}>
          {/* KPIs */}
          <section aria-label="شاخص‌های اصلی" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile icon={<BarChart3 className="w-3.5 h-3.5" />} label="فروش ثبت‌شده" value={compactToman(o.amountCreatedToman)} sub={`${fa.format(o.created)} پیش‌فاکتور`} />
            <Tile icon={<PackageCheck className="w-3.5 h-3.5" />} label="تحویل‌شده" value={compactToman(o.amountDeliveredToman)} sub={`${fa.format(o.delivered)} سفارش`} />
            <Tile
              icon={<Undo2 className="w-3.5 h-3.5" />}
              label="سفارش‌های دارای برگشت"
              value={fa.format(o.returned)}
              sub={o.created ? `${fa.format(Math.round((o.returned / o.created) * 100))}٪ از ثبت‌شده‌ها` : 'بدون سفارش در این بازه'}
            />
            <Tile
              icon={<Clock className="w-3.5 h-3.5" />}
              label="میانگین ثبت تا تحویل"
              value={o.avgDeliveryHours === null ? '—' : o.avgDeliveryHours >= 48 ? `${fa.format(Math.round(o.avgDeliveryHours / 24))} روز` : `${fa.format(Math.round(o.avgDeliveryHours))} ساعت`}
              sub={o.cartonDiscrepancies ? `${fa.format(o.cartonDiscrepancies)} مغایرت کارتن` : 'بدون مغایرت کارتن'}
            />
          </section>

          {/* Trend */}
          <ChartCard
            title="روند فروش و تحویل"
            subtitle={`مبلغ پیش‌فاکتورهای ثبت‌شده و سفارش‌های تحویل‌شده (${GRANULARITY_FA[tl.granularity]}، تومان)`}
            legend={
              <Legend
                items={[
                  { label: 'ثبت‌شده', color: CHART.series1, shape: 'line' },
                  { label: 'تحویل‌شده', color: CHART.series2, shape: 'line' },
                ]}
              />
            }
            table={
              <DataTable
                columns={[
                  { key: 'label', label: 'بازه' },
                  { key: 'cc', label: 'تعداد ثبت', numeric: true },
                  { key: 'ca', label: 'مبلغ ثبت', numeric: true },
                  { key: 'dc', label: 'تعداد تحویل', numeric: true },
                  { key: 'da', label: 'مبلغ تحویل', numeric: true },
                ]}
                rows={tl.points.map((p) => ({
                  label: p.label,
                  cc: fa.format(p.createdCount),
                  ca: fullToman(p.createdAmountToman),
                  dc: fa.format(p.deliveredCount),
                  da: fullToman(p.deliveredAmountToman),
                }))}
              />
            }
          >
            <LineChart
              ariaLabel="نمودار روند فروش ثبت‌شده و تحویل‌شده؛ برای جزئیات از نمای جدول استفاده کنید"
              labels={tl.points.map((p) => p.label)}
              series={[
                { key: 'created', label: 'ثبت‌شده', color: CHART.series1, values: tl.points.map((p) => p.createdAmountToman) },
                { key: 'delivered', label: 'تحویل‌شده', color: CHART.series2, values: tl.points.map((p) => p.deliveredAmountToman) },
              ]}
            />
          </ChartCard>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Reps */}
            <ChartCard
              title="عملکرد کارشناسان فروش"
              subtitle="مبلغ ثبت‌شده و تحویل‌شده در این بازه"
              legend={
                <Legend
                  items={[
                    { label: 'ثبت‌شده', color: CHART.series1 },
                    { label: 'تحویل‌شده', color: CHART.series2 },
                  ]}
                />
              }
              table={
                <DataTable
                  columns={[
                    { key: 'name', label: 'کارشناس' },
                    { key: 'c', label: 'ثبت‌شده', numeric: true },
                    { key: 'ca', label: 'مبلغ ثبت‌شده', numeric: true },
                    { key: 'd', label: 'تحویل‌شده', numeric: true },
                    { key: 'da', label: 'مبلغ تحویل‌شده', numeric: true },
                    { key: 'r', label: 'برگشتی', numeric: true },
                    { key: 'p', label: 'در جریان', numeric: true },
                  ]}
                  rows={report.reps.map((r) => ({
                    name: r.salesOwnerName,
                    c: fa.format(r.ordersCreated),
                    ca: fullToman(r.amountCreatedToman),
                    d: fa.format(r.delivered),
                    da: fullToman(r.amountDeliveredToman),
                    r: fa.format(r.returned),
                    p: fa.format(r.inProgress),
                  }))}
                />
              }
            >
              {report.reps.length === 0 ? (
                <p className="text-xs text-slate-500">در این بازه سفارشی ثبت یا تحویل نشده است.</p>
              ) : (
                <HBarChart
                  ariaLabel="مقایسه مبلغ ثبت‌شده و تحویل‌شده هر کارشناس"
                  series={[
                    { label: 'ثبت‌شده', color: CHART.series1 },
                    { label: 'تحویل‌شده', color: CHART.series2 },
                  ]}
                  rows={report.reps.map((r) => ({
                    label: r.salesOwnerName,
                    sub: `${fa.format(r.ordersCreated)} سفارش${r.returned ? ` · ${fa.format(r.returned)} برگشتی` : ''}`,
                    values: [r.amountCreatedToman, r.amountDeliveredToman],
                  }))}
                />
              )}
            </ChartCard>

            {/* Pipeline */}
            <ChartCard
              title="سفارش‌های باز در هر مرحله"
              subtitle="وضعیت همین لحظه، مستقل از بازه زمانی (تعداد سفارش)"
              table={
                <DataTable
                  columns={[
                    { key: 'stage', label: 'مرحله' },
                    { key: 'count', label: 'تعداد', numeric: true },
                    { key: 'amount', label: 'مبلغ', numeric: true },
                  ]}
                  rows={o.pipelineByStage.map((p) => ({
                    stage: `${fa.format(p.stage)}. ${p.label}`,
                    count: fa.format(p.count),
                    amount: fullToman(p.amountToman),
                  }))}
                />
              }
            >
              <HBarChart
                ariaLabel="تعداد سفارش‌های باز در هر مرحله"
                format={(n) => `${fa.format(n)} سفارش`}
                series={[{ label: 'تعداد', color: CHART.series1 }]}
                rows={o.pipelineByStage.map((p) => ({
                  label: `${fa.format(p.stage)}. ${p.label}`,
                  sub: compactToman(p.amountToman),
                  values: [p.count],
                }))}
              />
            </ChartCard>
          </div>

          {/* Order channel and payment terms: two separate charts (each order counted once in each) */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <ChartCard
              title="کانال دریافت سفارش"
              subtitle="مبلغ پیش‌فاکتورهای ثبت‌شده در این بازه؛ هر سفارش فقط یک بار شمرده می‌شود"
              table={
                <DataTable
                  columns={[
                    { key: 'l', label: 'کانال' },
                    { key: 'n', label: 'تعداد سفارش', numeric: true },
                    { key: 'a', label: 'مبلغ', numeric: true },
                  ]}
                  rows={report.byChannel.map((x) => ({ l: x.label, n: fa.format(x.count), a: fullToman(x.amountToman) }))}
                />
              }
            >
              {report.byChannel.length === 0 ? (
                <p className="text-xs text-slate-500">سفارشی در این بازه ثبت نشده است.</p>
              ) : (
                <HBarChart
                  ariaLabel="مبلغ سفارش‌ها به تفکیک کانال دریافت"
                  series={[{ label: 'مبلغ', color: CHART.series1 }]}
                  rows={report.byChannel.map((x) => ({ label: x.label, sub: `${fa.format(x.count)} سفارش`, values: [x.amountToman] }))}
                />
              )}
            </ChartCard>

            <ChartCard
              title="شرایط تسویه"
              subtitle="مبلغ پیش‌فاکتورهای ثبت‌شده در این بازه؛ هر سفارش فقط یک بار شمرده می‌شود"
              table={
                <DataTable
                  columns={[
                    { key: 'l', label: 'شرایط تسویه' },
                    { key: 'n', label: 'تعداد سفارش', numeric: true },
                    { key: 'a', label: 'مبلغ', numeric: true },
                  ]}
                  rows={report.byPayment.map((x) => ({ l: x.label, n: fa.format(x.count), a: fullToman(x.amountToman) }))}
                />
              }
            >
              {report.byPayment.length === 0 ? (
                <p className="text-xs text-slate-500">سفارشی در این بازه ثبت نشده است.</p>
              ) : (
                <HBarChart
                  ariaLabel="مبلغ سفارش‌ها به تفکیک شرایط تسویه"
                  series={[{ label: 'مبلغ', color: CHART.series1 }]}
                  rows={report.byPayment.map((x) => ({ label: x.label, sub: `${fa.format(x.count)} سفارش`, values: [x.amountToman] }))}
                />
              )}
            </ChartCard>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Checks status */}
            <ChartCard
              className={o.returnReasons.length > 0 ? undefined : 'lg:col-span-2'}
              title="وضعیت چک‌ها و واریزی‌ها"
              subtitle={`ثبت‌شده در این بازه: ${fa.format(c.submitted)} سند، ${compactToman(c.amountSubmittedToman)}`}
              table={
                <DataTable
                  columns={[
                    { key: 's', label: 'وضعیت' },
                    { key: 'n', label: 'تعداد', numeric: true },
                    { key: 'a', label: 'مبلغ', numeric: true },
                  ]}
                  rows={[
                    { s: 'نهایی‌شده', n: fa.format(c.finalized), a: fullToman(c.amountFinalizedToman) },
                    { s: 'در انتظار تایید', n: fa.format(c.pending), a: fullToman(c.amountPendingToman) },
                    {
                      s: 'برگشتی',
                      n: fa.format(c.returned),
                      a: fullToman(Math.max(0, c.amountSubmittedToman - c.amountFinalizedToman - c.amountPendingToman)),
                    },
                  ]}
                />
              }
            >
              <SegmentedBar
                ariaLabel="سهم مبلغ چک‌ها بر اساس وضعیت"
                parts={[
                  { label: 'نهایی‌شده', value: c.amountFinalizedToman, color: CHART.good, icon: <CheckCircle2 className="w-3 h-3 text-slate-600" /> },
                  { label: 'در انتظار تایید', value: c.amountPendingToman, color: CHART.warning, textColor: '#0b0b0b', icon: <Hourglass className="w-3 h-3 text-slate-600" /> },
                  {
                    label: 'برگشتی',
                    value: Math.max(0, c.amountSubmittedToman - c.amountFinalizedToman - c.amountPendingToman),
                    color: CHART.critical,
                    icon: <AlertTriangle className="w-3 h-3 text-slate-600" />,
                  },
                ]}
              />
              <div className="mt-4">
                <h3 className="text-xs font-bold text-slate-800 mb-2">به تفکیک نوع سند</h3>
                <HBarChart
                  ariaLabel="مبلغ چک‌ها و واریزی‌ها به تفکیک نوع"
                  series={[{ label: 'مبلغ', color: CHART.series1 }]}
                  rows={c.byDocType.map((d) => ({ label: d.docType, sub: `${fa.format(d.count)} سند`, values: [d.amountToman] }))}
                />
              </div>
            </ChartCard>

            {o.returnReasons.length > 0 && (
              <ChartCard title="علت‌های برگشت سفارش" subtitle="در این بازه (تعداد)">
                <HBarChart
                  ariaLabel="تعداد برگشت به تفکیک علت"
                  format={(n) => fa.format(n)}
                  series={[{ label: 'تعداد', color: CHART.series1 }]}
                  rows={o.returnReasons.map((r) => ({ label: r.reason, values: [r.count] }))}
                />
              </ChartCard>
            )}
          </div>

          {/* Tables */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <section className="bg-white border border-slate-200 rounded-xl p-4 min-w-0">
              <h2 className="text-sm font-extrabold text-slate-900 mb-3">مشتریان برتر در این بازه</h2>
              {report.topCustomers.length === 0 ? (
                <p className="text-xs text-slate-500">سفارشی در این بازه ثبت نشده است.</p>
              ) : (
                <div className="overflow-x-auto">
                  <DataTable
                    columns={[
                      { key: 'rank', label: '#', numeric: true },
                      { key: 'customer', label: 'مشتری' },
                      { key: 'orders', label: 'سفارش', numeric: true },
                      { key: 'amount', label: 'مبلغ', numeric: true },
                    ]}
                    rows={report.topCustomers.map((t, i) => ({
                      rank: fa.format(i + 1),
                      customer: t.customer,
                      orders: fa.format(t.orders),
                      amount: fullToman(t.amountToman),
                    }))}
                  />
                </div>
              )}
            </section>

            <section className="bg-white border border-slate-200 rounded-xl p-4 min-w-0">
              <h2 className="text-sm font-extrabold text-slate-900">سررسید چک‌ها در ۳۰ روز آینده</h2>
              <p className="text-[11px] text-slate-500 mb-3">مستقل از بازه زمانی</p>
              {c.upcomingDue.length === 0 ? (
                <p className="text-xs text-slate-500">چکی با سررسید نزدیک وجود ندارد.</p>
              ) : (
                <div className="overflow-x-auto">
                  <DataTable
                    columns={[
                      { key: 'due', label: 'سررسید' },
                      { key: 'customer', label: 'مشتری' },
                      { key: 'amount', label: 'مبلغ', numeric: true },
                      { key: 'rep', label: 'کارشناس' },
                    ]}
                    rows={c.upcomingDue.map((d) => ({
                      due: faDate.format(new Date(`${d.dueDate}T12:00:00Z`)),
                      customer: d.customer,
                      amount: fullToman(d.amountToman),
                      rep: d.salesOwnerName,
                    }))}
                  />
                </div>
              )}
            </section>
          </div>

          <p className="text-[11px] text-slate-500">
            اقلام کسری باز در واحد تامین: {fa.format(report.procurement.open)}
            {report.procurement.urgentOpen ? ` (${fa.format(report.procurement.urgentOpen)} مورد فوری)` : ''}
          </p>
        </div>
      )}
    </div>
  );
}
