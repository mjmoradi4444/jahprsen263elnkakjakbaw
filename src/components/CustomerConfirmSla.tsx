import React, { useEffect, useState } from 'react';
import { Timer } from 'lucide-react';
import { adminApi, ApiError } from '../api/client';
import { CustomerConfirmSla } from '../shared/types';
import { formatHours } from '../shared/format-hours';
import { CHART, ChartCard, DataTable, HBarChart, LineChart } from './charts';

const fa = new Intl.NumberFormat('fa-IR', { maximumFractionDigits: 1 });
const faDate = new Intl.DateTimeFormat('fa-IR', { timeZone: 'Asia/Tehran', month: 'short', day: 'numeric' });
const faDateTime = new Intl.DateTimeFormat('fa-IR', {
  timeZone: 'Asia/Tehran',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function Stat({ label, value, sub, tone }: { label: string; value: string; sub?: string; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 min-w-0">
      <div className="text-[11px] text-slate-500">{label}</div>
      <div
        className={`text-lg font-extrabold tabular-nums mt-0.5 ${
          tone === 'good' ? 'text-emerald-700' : tone === 'bad' ? 'text-red-700' : 'text-slate-900'
        }`}
      >
        {value}
      </div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export function CustomerConfirmSlaSection({
  sla,
  onTargetSaved,
  onNotify,
}: {
  sla: CustomerConfirmSla;
  onTargetSaved: () => void;
  onNotify: (msg: string, isError?: boolean) => void;
}) {
  const [target, setTarget] = useState(String(sla.targetHours));
  const [saving, setSaving] = useState(false);
  useEffect(() => setTarget(String(sla.targetHours)), [sla.targetHours]);

  async function saveTarget(e: React.FormEvent) {
    e.preventDefault();
    const n = Number(target.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d))));
    setSaving(true);
    try {
      await adminApi.setSla(n);
      onNotify('هدف زمانی تاییدیه مشتری ذخیره شد.');
      onTargetSaved();
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'ذخیره هدف زمانی ناموفق بود.', true);
    } finally {
      setSaving(false);
    }
  }

  const pct = sla.withinTargetPct;
  const overdueNow = sla.waiting.filter((w) => w.overdue).length;

  return (
    <section className="bg-white border border-slate-200 rounded-xl p-4 min-w-0 space-y-4" aria-labelledby="sla-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="sla-title" className="text-sm font-extrabold text-slate-900 flex items-center gap-1.5">
            <Timer className="w-4 h-4" /> زمان اخذ تاییدیه مشتری (SLA)
          </h2>
          <p className="text-[11px] text-slate-500 mt-0.5">
            از تایید پیش‌فاکتور توسط مدیر فروش (مرحله ۲) تا ثبت تاییدیه مشتری و ارسال به حسابداری توسط کارشناس (مرحله ۳)
          </p>
        </div>
        <form onSubmit={saveTarget} className="flex items-center gap-2 text-xs">
          <label htmlFor="sla-target" className="font-bold text-slate-700">
            هدف:
          </label>
          <input
            id="sla-target"
            dir="ltr"
            inputMode="decimal"
            value={target}
            onChange={(e) => setTarget(e.target.value)}
            className="w-16 px-2 py-1.5 border border-slate-300 rounded-lg text-center tabular-nums"
          />
          <span className="text-slate-600">ساعت</span>
          <button
            type="submit"
            disabled={saving || target === String(sla.targetHours)}
            className="px-3 py-1.5 rounded-lg bg-slate-900 text-white font-bold disabled:opacity-40 cursor-pointer"
          >
            {saving ? '...' : 'ذخیره'}
          </button>
        </form>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Stat
          label={`در هدف ${fa.format(sla.targetHours)} ساعت`}
          value={pct === null ? '—' : `${fa.format(pct)}٪`}
          sub={`${fa.format(sla.confirmed)} تاییدیه در این بازه`}
          tone={pct === null ? undefined : pct >= 80 ? 'good' : pct < 50 ? 'bad' : undefined}
        />
        <Stat label="میانه زمان" value={formatHours(sla.medianHours)} sub="نصف سفارش‌ها سریع‌تر از این" />
        <Stat label="میانگین زمان" value={formatHours(sla.avgHours)} />
        <Stat label="۹۰٪ سفارش‌ها تا" value={formatHours(sla.p90Hours)} sub="کندترین ۱۰٪ بیشتر از این" />
        <Stat
          label="منتظر مشتری الان"
          value={fa.format(sla.waiting.length)}
          sub={overdueNow ? `${fa.format(overdueNow)} مورد از هدف گذشته` : 'هیچ موردی از هدف نگذشته'}
          tone={overdueNow ? 'bad' : undefined}
        />
      </div>
      {sla.rejected > 0 && (
        <p className="text-[11px] text-slate-500">
          {fa.format(sla.rejected)} مورد در این بازه با عدم تایید مشتری به کارشناس برگشت (در محاسبه زمان‌ها حساب نشده).
        </p>
      )}

      {sla.confirmed > 0 && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <ChartCard
            title="پراکندگی زمان تاییدیه"
            subtitle="تعداد تاییدیه‌ها بر اساس مدت انتظار"
            table={
              <DataTable
                columns={[
                  { key: 'l', label: 'مدت' },
                  { key: 'c', label: 'تعداد', numeric: true },
                ]}
                rows={sla.distribution.map((d) => ({ l: d.label, c: fa.format(d.count) }))}
              />
            }
          >
            <HBarChart
              ariaLabel="تعداد تاییدیه‌ها به تفکیک مدت انتظار"
              format={(n) => fa.format(n)}
              series={[{ label: 'تعداد', color: CHART.series1 }]}
              rows={sla.distribution.map((d) => ({ label: d.label, values: [d.count] }))}
            />
          </ChartCard>

          {sla.trend.length >= 2 ? (
            <ChartCard
              title="روند هفتگی"
              subtitle="میانه زمان تاییدیه در هر هفته (ساعت)"
              table={
                <DataTable
                  columns={[
                    { key: 'w', label: 'شروع هفته' },
                    { key: 'm', label: 'میانه', numeric: true },
                    { key: 'c', label: 'تعداد', numeric: true },
                  ]}
                  rows={sla.trend.map((t) => ({
                    w: faDate.format(new Date(t.weekStart)),
                    m: formatHours(t.medianHours),
                    c: fa.format(t.count),
                  }))}
                />
              }
            >
              <LineChart
                ariaLabel="روند هفتگی میانه زمان اخذ تاییدیه مشتری"
                labels={sla.trend.map((t) => faDate.format(new Date(t.weekStart)))}
                format={(n) => fa.format(Math.round(n * 10) / 10)}
                series={[{ key: 'median', label: 'میانه (ساعت)', color: CHART.series1, values: sla.trend.map((t) => t.medianHours) }]}
              />
            </ChartCard>
          ) : (
            <ChartCard title="روند هفتگی" subtitle="برای نمایش روند، داده دست‌کم دو هفته لازم است">
              <p className="text-xs text-slate-500 py-6 text-center">بازه بلندتری انتخاب کنید.</p>
            </ChartCard>
          )}
        </div>
      )}

      {sla.byRep.length > 0 && (
        <div className="overflow-x-auto">
          <h3 className="text-xs font-extrabold text-slate-900 mb-2">به تفکیک کارشناس</h3>
          <DataTable
            columns={[
              { key: 'rep', label: 'کارشناس' },
              { key: 'n', label: 'تاییدیه', numeric: true },
              { key: 'med', label: 'میانه', numeric: true },
              { key: 'avg', label: 'میانگین', numeric: true },
              { key: 'pct', label: 'در هدف', numeric: true },
              { key: 'rej', label: 'عدم تایید', numeric: true },
              { key: 'wait', label: 'منتظر / از هدف گذشته', numeric: true },
            ]}
            rows={sla.byRep.map((r) => ({
              rep: r.salesOwnerName,
              n: fa.format(r.confirmed),
              med: formatHours(r.medianHours),
              avg: formatHours(r.avgHours),
              pct: r.withinTargetPct === null ? '—' : `${fa.format(r.withinTargetPct)}٪`,
              rej: fa.format(r.rejected),
              wait: (
                <span className={r.overdue ? 'text-red-700 font-bold' : ''}>
                  {fa.format(r.waiting)} / {fa.format(r.overdue)}
                </span>
              ),
            }))}
          />
        </div>
      )}

      {sla.waiting.length > 0 && (
        <div className="overflow-x-auto">
          <h3 className="text-xs font-extrabold text-slate-900 mb-2">سفارش‌های منتظر تاییدیه مشتری (همین الان)</h3>
          <DataTable
            columns={[
              { key: 'h', label: 'مدت انتظار' },
              { key: 'rep', label: 'کارشناس' },
              { key: 'customer', label: 'مشتری' },
              { key: 'pf', label: 'پیش‌فاکتور' },
              { key: 'since', label: 'تایید مدیر فروش' },
            ]}
            rows={sla.waiting.map((w) => ({
              h: (
                <span className={w.overdue ? 'text-red-700 font-bold' : 'text-slate-800'}>
                  {formatHours(w.hours)}
                  {w.overdue ? ' (از هدف گذشته)' : ''}
                </span>
              ),
              rep: w.salesOwnerName,
              customer: w.customer,
              pf: (
                <span className="font-mono-code" dir="ltr">
                  {w.proforma}
                </span>
              ),
              since: faDateTime.format(new Date(w.startedAt)),
            }))}
          />
        </div>
      )}

      {sla.confirmed === 0 && sla.waiting.length === 0 && (
        <p className="text-xs text-slate-500">در این بازه تاییدیه مشتری ثبت نشده است.</p>
      )}
    </section>
  );
}
