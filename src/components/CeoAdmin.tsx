import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  ArchiveRestore,
  BarChart3,
  Clock,
  DatabaseBackup,
  Download,
  FileSpreadsheet,
  Loader2,
  PackageCheck,
  RotateCcw,
  ShieldCheck,
  Undo2,
} from 'lucide-react';
import { adminApi, ApiError } from '../api/client';
import { CeoReport, StoredBackupInfoDto } from '../shared/types';

/**
 * CEO-only reports and backups. App.tsx renders this only for the CEO, and every endpoint it calls
 * lives under /api/admin, which the server rejects with 403 for any other role.
 */

interface CeoAdminProps {
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
const fa = new Intl.NumberFormat('fa-IR');
const faDate = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' });
const faDateTime = new Intl.DateTimeFormat('fa-IR', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/** Start of the Tehran calendar day containing `ms`, as a UTC timestamp. */
function tehranMidnight(ms: number): number {
  const local = ms + TEHRAN_OFFSET_MS;
  return local - (local % 86_400_000) - TEHRAN_OFFSET_MS;
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
  const to = new Date(todayStart + 86_400_000).toISOString();
  switch (key) {
    case 'today':
      return { from: new Date(todayStart).toISOString(), to };
    case '7d':
      return { from: new Date(todayStart - 6 * 86_400_000).toISOString(), to };
    case '30d':
      return { from: new Date(todayStart - 29 * 86_400_000).toISOString(), to };
    case '90d':
      return { from: new Date(todayStart - 89 * 86_400_000).toISOString(), to };
    case 'month': {
      const day = persianDayOfMonth(now);
      return { from: new Date(todayStart - (day - 1) * 86_400_000).toISOString(), to };
    }
    default:
      return { from: null, to: null };
  }
}

function toman(n: number): string {
  return `${fa.format(Math.round(n))} تومان`;
}

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${fa.format(Math.max(1, Math.round(n / 1024)))} کیلوبایت`;
  return `${fa.format(Math.round((n / 1024 / 1024) * 10) / 10)} مگابایت`;
}

function Tile({ label, value, sub, icon, tone = 'slate' }: { label: string; value: string; sub?: string; icon: React.ReactNode; tone?: 'slate' | 'emerald' | 'amber' | 'red' | 'blue' }) {
  const tones = {
    slate: 'text-slate-900',
    emerald: 'text-emerald-700',
    amber: 'text-amber-700',
    red: 'text-red-700',
    blue: 'text-blue-700',
  };
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 min-w-0">
      <div className="flex items-center gap-1.5 text-[11px] font-bold text-slate-500">
        {icon}
        <span className="truncate">{label}</span>
      </div>
      <div className={`mt-1.5 text-xl font-extrabold tabular-nums ${tones[tone]}`}>{value}</div>
      {sub && <div className="mt-0.5 text-[11px] text-slate-600 truncate">{sub}</div>}
    </div>
  );
}

export function CeoAdmin({ onNotify, refreshTrigger }: CeoAdminProps) {
  const [rangeKey, setRangeKey] = useState<RangeKey>('month');
  const [report, setReport] = useState<CeoReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);

  const [backups, setBackups] = useState<StoredBackupInfoDto[]>([]);
  const [downloadingBackup, setDownloadingBackup] = useState<string | null>(null);

  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePin, setRestorePin] = useState('');
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

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

  const loadBackups = useCallback(async () => {
    try {
      const res = await adminApi.listBackups();
      setBackups(res.backups);
    } catch {
      // Non-fatal: the list is informational.
    }
  }, []);

  useEffect(() => {
    void loadReport();
  }, [loadReport, refreshTrigger]);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

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

  async function handleFullBackup() {
    setDownloadingBackup('full');
    try {
      await adminApi.downloadFullBackup();
      onNotify('نسخه پشتیبان کامل دانلود شد. آن را در جای امنی نگه دارید.');
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'ساخت نسخه پشتیبان با خطا مواجه شد.', true);
    } finally {
      setDownloadingBackup(null);
    }
  }

  async function handleStoredDownload(name: string) {
    setDownloadingBackup(name);
    try {
      await adminApi.downloadStoredBackup(name);
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'دانلود با خطا مواجه شد.', true);
    } finally {
      setDownloadingBackup(null);
    }
  }

  async function handleRestore(e: React.FormEvent) {
    e.preventDefault();
    if (!restoreFile || !restorePin || !restoreConfirm || restoring) return;
    setRestoring(true);
    setRestoreError(null);
    try {
      const res = await adminApi.restoreBackup(restoreFile, restorePin);
      const s = res.summary;
      onNotify(
        `بازگردانی انجام شد: ${fa.format(s.counts.orders || 0)} سفارش، ${fa.format(s.counts.checks || 0)} چک/واریزی و ${fa.format(s.filesRestored)} فایل. سایر کاربران باید دوباره وارد شوند.`,
      );
      setRestoreFile(null);
      setRestorePin('');
      setRestoreConfirm(false);
      void loadReport();
      void loadBackups();
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.message : 'بازگردانی با خطا مواجه شد.');
    } finally {
      setRestoring(false);
    }
  }

  const o = report?.orders;
  const c = report?.checks;
  const maxPipeline = Math.max(1, ...(o?.pipelineByStage.map((p) => p.count) || [1]));

  return (
    <div className="space-y-6">
      {/* Range + export */}
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

      {report && o && c && (
        <>
          {/* KPIs */}
          <section aria-label="شاخص‌های فروش" className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <Tile icon={<BarChart3 className="w-3.5 h-3.5" />} label="پیش‌فاکتور ثبت‌شده" value={fa.format(o.created)} sub={toman(o.amountCreatedToman)} />
            <Tile icon={<PackageCheck className="w-3.5 h-3.5" />} label="تحویل‌شده" value={fa.format(o.delivered)} sub={toman(o.amountDeliveredToman)} tone="emerald" />
            <Tile icon={<Undo2 className="w-3.5 h-3.5" />} label="دارای برگشت" value={fa.format(o.returned)} sub={o.created ? `${fa.format(Math.round((o.returned / o.created) * 100))}٪ از ثبت‌شده‌ها` : undefined} tone={o.returned ? 'red' : 'slate'} />
            <Tile
              icon={<Clock className="w-3.5 h-3.5" />}
              label="میانگین ثبت تا تحویل"
              value={o.avgDeliveryHours === null ? '—' : o.avgDeliveryHours >= 48 ? `${fa.format(Math.round(o.avgDeliveryHours / 24))} روز` : `${fa.format(Math.round(o.avgDeliveryHours))} ساعت`}
              sub={o.cartonDiscrepancies ? `${fa.format(o.cartonDiscrepancies)} مغایرت کارتن` : 'بدون مغایرت کارتن'}
              tone="blue"
            />
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Pipeline snapshot */}
            <section className="bg-white border border-slate-200 rounded-xl p-4">
              <h2 className="text-sm font-extrabold text-slate-900">سفارش‌های باز در هر مرحله</h2>
              <p className="text-[11px] text-slate-500 mb-3">وضعیت همین لحظه (مستقل از بازه زمانی)</p>
              <ul className="space-y-2.5">
                {o.pipelineByStage.map((p) => (
                  <li key={p.stage}>
                    <div className="flex items-center justify-between text-xs">
                      <span className="font-bold text-slate-800">
                        {fa.format(p.stage)}. {p.label}
                      </span>
                      <span className="text-slate-600 tabular-nums">
                        {fa.format(p.count)} سفارش · {toman(p.amountToman)}
                      </span>
                    </div>
                    <div className="mt-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full rounded-full bg-blue-600" style={{ width: `${(p.count / maxPipeline) * 100}%` }} />
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {/* Checks */}
            <section className="bg-white border border-slate-200 rounded-xl p-4">
              <h2 className="text-sm font-extrabold text-slate-900">چک‌ها و واریزی‌ها</h2>
              <p className="text-[11px] text-slate-500 mb-3">ثبت‌شده در این بازه</p>
              <dl className="grid grid-cols-2 gap-3 text-xs">
                <div className="p-3 rounded-lg bg-slate-50">
                  <dt className="text-slate-500 font-bold">ثبت‌شده</dt>
                  <dd className="mt-1 font-extrabold text-slate-900 tabular-nums">{fa.format(c.submitted)}</dd>
                  <dd className="text-[11px] text-slate-600">{toman(c.amountSubmittedToman)}</dd>
                </div>
                <div className="p-3 rounded-lg bg-emerald-50">
                  <dt className="text-emerald-800 font-bold">نهایی‌شده</dt>
                  <dd className="mt-1 font-extrabold text-emerald-800 tabular-nums">{fa.format(c.finalized)}</dd>
                  <dd className="text-[11px] text-emerald-800">{toman(c.amountFinalizedToman)}</dd>
                </div>
                <div className="p-3 rounded-lg bg-amber-50">
                  <dt className="text-amber-800 font-bold">در انتظار تایید</dt>
                  <dd className="mt-1 font-extrabold text-amber-800 tabular-nums">{fa.format(c.pending)}</dd>
                  <dd className="text-[11px] text-amber-800">{toman(c.amountPendingToman)}</dd>
                </div>
                <div className="p-3 rounded-lg bg-red-50">
                  <dt className="text-red-800 font-bold">برگشتی</dt>
                  <dd className="mt-1 font-extrabold text-red-800 tabular-nums">{fa.format(c.returned)}</dd>
                  <dd className="text-[11px] text-red-800">
                    اقلام کسری باز در تامین: {fa.format(report.procurement.open)}
                    {report.procurement.urgentOpen ? ` (${fa.format(report.procurement.urgentOpen)} فوری)` : ''}
                  </dd>
                </div>
              </dl>
            </section>
          </div>

          {/* Reps */}
          <section className="bg-white border border-slate-200 rounded-xl p-4">
            <h2 className="text-sm font-extrabold text-slate-900 mb-3">عملکرد کارشناسان فروش در این بازه</h2>
            {report.reps.length === 0 ? (
              <p className="text-xs text-slate-500">در این بازه سفارشی ثبت یا تحویل نشده است.</p>
            ) : (
              <div className="overflow-x-auto -mx-4 px-4">
                <table className="w-full min-w-[560px] text-xs">
                  <thead>
                    <tr className="text-slate-500 border-b border-slate-200">
                      <th className="text-right py-2 font-bold">کارشناس</th>
                      <th className="text-right py-2 font-bold">ثبت‌شده</th>
                      <th className="text-right py-2 font-bold">مبلغ ثبت‌شده</th>
                      <th className="text-right py-2 font-bold">تحویل‌شده</th>
                      <th className="text-right py-2 font-bold">مبلغ تحویل‌شده</th>
                      <th className="text-right py-2 font-bold">برگشتی</th>
                      <th className="text-right py-2 font-bold">در جریان</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.reps.map((r) => (
                      <tr key={r.salesOwnerId} className="border-b border-slate-100 tabular-nums">
                        <td className="py-2 font-bold text-slate-900">{r.salesOwnerName}</td>
                        <td className="py-2">{fa.format(r.ordersCreated)}</td>
                        <td className="py-2">{toman(r.amountCreatedToman)}</td>
                        <td className="py-2 text-emerald-700">{fa.format(r.delivered)}</td>
                        <td className="py-2 text-emerald-700">{toman(r.amountDeliveredToman)}</td>
                        <td className={`py-2 ${r.returned ? 'text-red-700 font-bold' : ''}`}>{fa.format(r.returned)}</td>
                        <td className="py-2">{fa.format(r.inProgress)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Upcoming due checks */}
            <section className="bg-white border border-slate-200 rounded-xl p-4">
              <h2 className="text-sm font-extrabold text-slate-900">سررسید چک‌ها در ۳۰ روز آینده</h2>
              <p className="text-[11px] text-slate-500 mb-3">مستقل از بازه زمانی</p>
              {c.upcomingDue.length === 0 ? (
                <p className="text-xs text-slate-500">چکی با سررسید نزدیک وجود ندارد.</p>
              ) : (
                <ul className="divide-y divide-slate-100 text-xs">
                  {c.upcomingDue.map((d) => (
                    <li key={d.id} className="py-2 flex items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="font-bold text-slate-900 truncate">{d.customer}</div>
                        <div className="text-[11px] text-slate-500 truncate">
                          {d.salesOwnerName} · صیادی {d.sayadiId || '—'}
                        </div>
                      </div>
                      <div className="text-left shrink-0 tabular-nums">
                        <div className="font-bold text-slate-900">{toman(d.amountToman)}</div>
                        <div className="text-[11px] text-amber-700 font-bold">{faDate.format(new Date(`${d.dueDate}T12:00:00Z`))}</div>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            {/* Return reasons */}
            <section className="bg-white border border-slate-200 rounded-xl p-4">
              <h2 className="text-sm font-extrabold text-slate-900 mb-3">علت‌های برگشت در این بازه</h2>
              {o.returnReasons.length === 0 ? (
                <p className="text-xs text-slate-500">برگشتی ثبت نشده است.</p>
              ) : (
                <ul className="space-y-1.5 text-xs">
                  {o.returnReasons.map((r) => (
                    <li key={r.reason} className="flex items-center justify-between gap-3">
                      <span className="text-slate-800">{r.reason}</span>
                      <span className="font-bold text-red-700 tabular-nums">{fa.format(r.count)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        </>
      )}

      {/* Backups */}
      <section className="bg-white border border-slate-200 rounded-xl p-4 space-y-4">
        <div className="flex items-start gap-2">
          <ShieldCheck className="w-5 h-5 text-slate-700 shrink-0 mt-0.5" />
          <div>
            <h2 className="text-sm font-extrabold text-slate-900">پشتیبان‌گیری از اطلاعات</h2>
            <p className="text-[11px] text-slate-600 mt-0.5">
              نسخه پشتیبان شامل تمام سفارش‌ها، چک‌ها، فایل‌ها، رمزها و تنظیمات است. فقط مدیرعامل به این بخش دسترسی دارد؛ فایل را در جای امن نگه دارید.
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleFullBackup}
          disabled={downloadingBackup !== null}
          className="w-full sm:w-auto inline-flex items-center justify-center gap-1.5 px-4 py-2.5 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-60 text-white text-xs font-bold cursor-pointer"
        >
          {downloadingBackup === 'full' ? <Loader2 className="w-4 h-4 animate-spin" /> : <DatabaseBackup className="w-4 h-4" />}
          {downloadingBackup === 'full' ? 'در حال آماده‌سازی نسخه پشتیبان...' : 'دانلود نسخه پشتیبان کامل (همین لحظه)'}
        </button>

        <div>
          <h3 className="text-xs font-bold text-slate-800 mb-2">نسخه‌های خودکار روزانه (۷ روز اخیر)</h3>
          {backups.length === 0 ? (
            <p className="text-[11px] text-slate-500">هنوز نسخه خودکاری ساخته نشده است؛ اولین نسخه چند دقیقه پس از روشن شدن سرور ساخته می‌شود.</p>
          ) : (
            <ul className="divide-y divide-slate-100 text-xs border border-slate-200 rounded-lg">
              {backups.map((b) => (
                <li key={b.name} className="px-3 py-2 flex items-center justify-between gap-3">
                  <div className="min-w-0">
                    <div className="font-bold text-slate-800">
                      {b.kind === 'auto' ? 'خودکار' : 'نسخه ایمنی قبل از بازگردانی'} · {faDateTime.format(new Date(b.createdAt))}
                    </div>
                    <div className="text-[11px] text-slate-500">{formatBytes(b.sizeBytes)}</div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleStoredDownload(b.name)}
                    disabled={downloadingBackup !== null}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 text-[11px] font-bold text-slate-800 hover:bg-slate-50 disabled:opacity-60 cursor-pointer"
                  >
                    {downloadingBackup === b.name ? <Loader2 className="w-3 h-3 animate-spin" /> : <Download className="w-3 h-3" />}
                    دانلود
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        {/* Restore */}
        <form onSubmit={handleRestore} className="p-4 rounded-lg border border-red-200 bg-red-50/50 space-y-3">
          <div className="flex items-start gap-2">
            <ArchiveRestore className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-xs font-extrabold text-red-800">بازگردانی از نسخه پشتیبان</h3>
              <p className="text-[11px] text-red-800 mt-0.5">
                تمام اطلاعات فعلی با محتوای فایل پشتیبان جایگزین می‌شود. پیش از بازگردانی، یک نسخه ایمنی از وضعیت فعلی به‌صورت خودکار ذخیره می‌شود. پس از بازگردانی، سایر کاربران باید دوباره وارد شوند.
              </p>
            </div>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="restore-file" className="block text-[11px] font-bold text-slate-800 mb-1">
                فایل پشتیبان (zip)
              </label>
              <input
                id="restore-file"
                type="file"
                accept=".zip,application/zip"
                onChange={(e) => setRestoreFile(e.target.files?.[0] || null)}
                disabled={restoring}
                className="w-full text-xs"
              />
            </div>
            <div>
              <label htmlFor="restore-pin" className="block text-[11px] font-bold text-slate-800 mb-1">
                رمز مدیرعامل (برای تایید)
              </label>
              <input
                id="restore-pin"
                type="password"
                inputMode="numeric"
                autoComplete="current-password"
                value={restorePin}
                onChange={(e) => setRestorePin(e.target.value)}
                disabled={restoring}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                dir="ltr"
              />
            </div>
          </div>
          <label className="flex items-start gap-2 text-[11px] text-red-900 font-bold cursor-pointer">
            <input type="checkbox" checked={restoreConfirm} onChange={(e) => setRestoreConfirm(e.target.checked)} disabled={restoring} className="mt-0.5" />
            می‌دانم که اطلاعات فعلی با اطلاعات این فایل جایگزین می‌شود.
          </label>
          {restoreError && (
            <div role="alert" className="p-2.5 rounded-lg bg-red-100 border border-red-300 text-[11px] font-bold text-red-800 flex items-start gap-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              {restoreError}
            </div>
          )}
          <button
            type="submit"
            disabled={!restoreFile || !restorePin || !restoreConfirm || restoring}
            className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg bg-red-700 hover:bg-red-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-xs font-bold cursor-pointer"
          >
            {restoring ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RotateCcw className="w-3.5 h-3.5" />}
            {restoring ? 'در حال بازگردانی...' : 'بازگردانی اطلاعات'}
          </button>
        </form>
      </section>
    </div>
  );
}
