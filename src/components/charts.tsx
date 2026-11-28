import React, { useEffect, useRef, useState } from 'react';

/**
 * Small, dependency-free chart kit for the CEO reports (light surface only).
 * Colours follow the validated reference palette: categorical slot 1 blue, slot 2 orange;
 * status green / amber / red always paired with an icon + label. Text never wears series colours.
 */

export const CHART = {
  series1: '#257de0',
  series2: '#f47230',
  good: '#0aac23',
  warning: '#fbb315',
  critical: '#dc3c3d',
  grid: '#e7e7e7',
  axis: '#c2c2c2',
  inkPrimary: '#191919',
  inkSecondary: '#666666',
  surface: '#ffffff',
};

const faNum = new Intl.NumberFormat('fa-IR');

/** Compact Persian money: ۳۷۰ میلیون / ۱٫۲ میلیارد. */
export function compactToman(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1e9) return `${faNum.format(Math.round((n / 1e9) * 10) / 10)} میلیارد`;
  if (abs >= 1e6) return `${faNum.format(Math.round((n / 1e6) * 10) / 10)} میلیون`;
  if (abs >= 1e3) return `${faNum.format(Math.round(n / 1e3))} هزار`;
  return faNum.format(n);
}

export function fullToman(n: number): string {
  return `${faNum.format(Math.round(n))} تومان`;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(v)));
  const f = v / exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * exp;
}

function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number] {
  const ref = useRef<T>(null);
  const [w, setW] = useState(600);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => setW(Math.max(260, entries[0].contentRect.width)));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return [ref, w];
}

// ==================== Card shell with chart / table toggle ====================

export function ChartCard({
  title,
  subtitle,
  table,
  children,
  legend,
  className,
}: {
  className?: string;
  title: string;
  subtitle?: string;
  table?: React.ReactNode;
  legend?: React.ReactNode;
  children: React.ReactNode;
}) {
  const [showTable, setShowTable] = useState(false);
  return (
    <section className={`bg-white border border-slate-200 rounded-xl p-4 min-w-0 ${className || ''}`}>
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="min-w-0">
          <h2 className="text-sm font-extrabold text-slate-900">{title}</h2>
          {subtitle && <p className="text-[11px] text-slate-500 mt-0.5">{subtitle}</p>}
        </div>
        {table && (
          <div className="inline-flex rounded-lg border border-slate-200 p-0.5 shrink-0" role="group" aria-label="نوع نمایش">
            {(['نمودار', 'جدول'] as const).map((t, i) => (
              <button
                key={t}
                type="button"
                aria-pressed={showTable === (i === 1)}
                onClick={() => setShowTable(i === 1)}
                className={`px-2.5 py-1 rounded-md text-[11px] font-bold cursor-pointer ${
                  showTable === (i === 1) ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-50'
                }`}
              >
                {t}
              </button>
            ))}
          </div>
        )}
      </div>
      {legend && !showTable && <div className="mb-2">{legend}</div>}
      {showTable ? <div className="overflow-x-auto">{table}</div> : children}
    </section>
  );
}

export function Legend({ items }: { items: Array<{ label: string; color: string; shape?: 'line' | 'rect' }> }) {
  return (
    <ul className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-slate-600">
      {items.map((it) => (
        <li key={it.label} className="inline-flex items-center gap-1.5">
          {it.shape === 'line' ? (
            <span aria-hidden className="inline-block w-3.5 h-0.5 rounded" style={{ background: it.color }} />
          ) : (
            <span aria-hidden className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: it.color }} />
          )}
          {it.label}
        </li>
      ))}
    </ul>
  );
}

// ==================== Line chart (time series, one money axis) ====================

export interface LineSeries {
  key: string;
  label: string;
  color: string;
  values: number[];
}

export function LineChart({
  labels,
  series,
  height = 240,
  ariaLabel,
}: {
  labels: string[];
  series: LineSeries[];
  height?: number;
  ariaLabel: string;
}) {
  const [wrapRef, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { top: 12, right: 12, bottom: 28, left: 64 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const n = labels.length;
  const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
  const x = (i: number) => pad.left + (n <= 1 ? innerW / 2 : (i / (n - 1)) * innerW);
  const y = (v: number) => pad.top + innerH - (v / max) * innerH;
  const ticks = [0, 0.25, 0.5, 0.75, 1].map((t) => t * max);
  const labelEvery = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(innerW / 56))));

  function indexFromClientX(clientX: number, rect: DOMRect): number {
    const px = ((clientX - rect.left) / rect.width) * width;
    if (n <= 1) return 0;
    return Math.min(n - 1, Math.max(0, Math.round(((px - pad.left) / innerW) * (n - 1))));
  }

  const tooltip =
    hover !== null ? (
      <div
        className="pointer-events-none absolute z-10 bg-white border border-slate-200 rounded-lg shadow-md px-3 py-2 text-[11px] min-w-[150px]"
        style={{
          top: 4,
          left: Math.min(Math.max(x(hover) - 75, 0), width - 160),
        }}
        dir="rtl"
      >
        <div className="text-slate-500 mb-1">{labels[hover]}</div>
        {series.map((s) => (
          <div key={s.key} className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-slate-600">
              <span aria-hidden className="inline-block w-3 h-0.5 rounded" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="font-bold text-slate-900 tabular-nums">{compactToman(s.values[hover] || 0)}</span>
          </div>
        ))}
      </div>
    ) : null;

  return (
    <div ref={wrapRef} className="relative" dir="ltr">
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        role="img"
        aria-label={ariaLabel}
        tabIndex={0}
        className="block focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 rounded"
        onPointerMove={(e) => setHover(indexFromClientX(e.clientX, e.currentTarget.getBoundingClientRect()))}
        onPointerLeave={() => setHover(null)}
        onFocus={() => setHover((h) => h ?? n - 1)}
        onBlur={() => setHover(null)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowRight') setHover((h) => Math.min(n - 1, (h ?? -1) + 1));
          if (e.key === 'ArrowLeft') setHover((h) => Math.max(0, (h ?? n) - 1));
        }}
      >
        {ticks.map((t) => (
          <g key={t}>
            <line x1={pad.left} x2={width - pad.right} y1={y(t)} y2={y(t)} stroke={t === 0 ? CHART.axis : CHART.grid} strokeWidth={1} />
            <text x={pad.left - 8} y={y(t)} textAnchor="end" dominantBaseline="middle" fontSize={10} fill={CHART.inkSecondary}>
              {compactToman(t)}
            </text>
          </g>
        ))}
        {labels.map((l, i) =>
          i % labelEvery === 0 || i === n - 1 ? (
            <text key={l + i} x={x(i)} y={height - 8} textAnchor="middle" fontSize={10} fill={CHART.inkSecondary}>
              {l}
            </text>
          ) : null,
        )}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.top} y2={pad.top + innerH} stroke={CHART.axis} strokeWidth={1} />}
        {series.map((s) => (
          <g key={s.key}>
            <path
              d={s.values.map((v, i) => `${i === 0 ? 'M' : 'L'}${x(i)},${y(v)}`).join(' ')}
              fill="none"
              stroke={s.color}
              strokeWidth={2}
              strokeLinejoin="round"
              strokeLinecap="round"
            />
            {/* End dot (and the hovered point) with a 2px surface ring */}
            {[n - 1, ...(hover !== null && hover !== n - 1 ? [hover] : [])].map((i) =>
              i >= 0 ? <circle key={i} cx={x(i)} cy={y(s.values[i] || 0)} r={4} fill={s.color} stroke={CHART.surface} strokeWidth={2} /> : null,
            )}
          </g>
        ))}
      </svg>
      {tooltip}
    </div>
  );
}

// ==================== Horizontal bars (one or two series) ====================

export interface BarRow {
  label: string;
  values: number[]; // one value per series
  sub?: string;
}

export function HBarChart({
  rows,
  series,
  format = compactToman,
  ariaLabel,
}: {
  rows: BarRow[];
  series: Array<{ label: string; color: string }>;
  format?: (n: number) => string;
  ariaLabel: string;
}) {
  const max = Math.max(1, ...rows.flatMap((r) => r.values));
  const [hover, setHover] = useState<string | null>(null);
  return (
    <ul className="space-y-3" aria-label={ariaLabel}>
      {rows.map((r) => (
        <li key={r.label}>
          <div className="flex items-baseline justify-between gap-2 text-xs mb-1">
            <span className="font-bold text-slate-800 truncate">{r.label}</span>
            {r.sub && <span className="text-[11px] text-slate-500 shrink-0">{r.sub}</span>}
          </div>
          <div className="space-y-[2px]">
            {r.values.map((v, i) => {
              const id = `${r.label}-${i}`;
              const pct = (v / max) * 100;
              return (
                <div
                  key={id}
                  className="flex items-center gap-2"
                  tabIndex={0}
                  onPointerEnter={() => setHover(id)}
                  onPointerLeave={() => setHover(null)}
                  onFocus={() => setHover(id)}
                  onBlur={() => setHover(null)}
                  aria-label={`${r.label} – ${series[i]?.label}: ${format(v)}`}
                >
                  <div className="flex-1 h-3.5 relative">
                    {v > 0 && (
                      <div
                        className="absolute inset-y-0 right-0 rounded-l"
                        style={{
                          width: `${Math.max(pct, 0.8)}%`,
                          background: series[i]?.color,
                          filter: hover === id ? 'brightness(1.12)' : undefined,
                        }}
                      />
                    )}
                    {v === 0 && <div className="absolute inset-y-0 right-0 w-px" style={{ background: CHART.axis }} />}
                  </div>
                  <span className="w-20 shrink-0 text-[11px] text-slate-700 tabular-nums text-left">{format(v)}</span>
                </div>
              );
            })}
          </div>
        </li>
      ))}
    </ul>
  );
}

// ==================== Tall segmented bar (one whole, split by status) ====================

export function SegmentedBar({
  parts,
  ariaLabel,
}: {
  parts: Array<{ label: string; value: number; color: string; textColor?: string; icon?: React.ReactNode }>;
  ariaLabel: string;
}) {
  const total = parts.reduce((a, p) => a + p.value, 0);
  const [hover, setHover] = useState<string | null>(null);
  if (total <= 0) return <p className="text-xs text-slate-500">داده‌ای برای نمایش وجود ندارد.</p>;
  return (
    <div>
      <div className="flex h-7 gap-[2px]" role="img" aria-label={ariaLabel}>
        {parts
          .filter((p) => p.value > 0)
          .map((p) => {
            const share = p.value / total;
            const showText = share >= 0.12;
            return (
              <div
                key={p.label}
                tabIndex={0}
                onPointerEnter={() => setHover(p.label)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setHover(p.label)}
                onBlur={() => setHover(null)}
                className="rounded h-full flex items-center px-2 text-[11px] font-bold min-w-[6px]"
                style={{
                  width: `${share * 100}%`,
                  background: p.color,
                  color: p.textColor || '#ffffff',
                  filter: hover === p.label ? 'brightness(1.1)' : undefined,
                }}
                aria-label={`${p.label}: ${compactToman(p.value)} (${faNum.format(Math.round(share * 100))}٪)`}
              >
                {showText ? `${faNum.format(Math.round(share * 100))}٪` : ''}
              </div>
            );
          })}
      </div>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 mt-2 text-[11px] text-slate-700">
        {parts.map((p) => (
          <li key={p.label} className={`inline-flex items-center gap-1.5 ${hover === p.label ? 'font-bold' : ''}`}>
            <span aria-hidden className="inline-block w-2.5 h-2.5 rounded-sm" style={{ background: p.color }} />
            {p.icon}
            {p.label}: {compactToman(p.value)}
          </li>
        ))}
      </ul>
    </div>
  );
}

// ==================== Simple table used for "table view" ====================

export function DataTable({
  columns,
  rows,
}: {
  columns: Array<{ key: string; label: string; numeric?: boolean }>;
  rows: Array<Record<string, React.ReactNode>>;
}) {
  return (
    <table className="w-full text-xs min-w-[420px]">
      <thead>
        <tr className="text-slate-500 border-b border-slate-200">
          {columns.map((c) => (
            <th key={c.key} className="text-right py-2 font-bold whitespace-nowrap">
              {c.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={i} className="border-b border-slate-100">
            {columns.map((c) => (
              <td key={c.key} className={`py-1.5 ${c.numeric ? 'tabular-nums' : ''}`}>
                {r[c.key]}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}
