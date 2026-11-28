import React from 'react';
import { RevisionItemsDiff } from '../shared/types';

const fa = (n: number | null | undefined) => (n === null || n === undefined ? '—' : n.toLocaleString('fa-IR'));

function itemLabel(i: { code: string; description: string }) {
  return (
    <>
      <span className="font-semibold text-slate-800">{i.description || '—'}</span>
      {i.code && <span className="text-slate-500 font-mono-code text-[10px] mr-1" dir="ltr">({i.code})</span>}
    </>
  );
}

export function diffCount(d: RevisionItemsDiff): number {
  return d.added.length + d.removed.length + d.qtyChanged.length + d.priceChanged.length;
}

/** Compact list of the item / quantity / price differences between two proformas. */
export function RevisionDiffList({
  diff,
  oldAmountToman,
  newAmountToman,
}: {
  diff: RevisionItemsDiff;
  oldAmountToman?: number | null;
  newAmountToman?: number | null;
}) {
  const amountChanged =
    oldAmountToman !== undefined && newAmountToman !== undefined && oldAmountToman !== newAmountToman;
  const none = diffCount(diff) === 0;
  return (
    <ul className="space-y-1 text-[11px] leading-5">
      {diff.added.map((i, k) => (
        <li key={`a${k}`} className="flex gap-1.5 items-baseline">
          <span className="shrink-0 px-1.5 rounded bg-emerald-100 text-emerald-800 font-bold">قلم جدید</span>
          <span>
            {itemLabel(i)} — {fa(i.qty)} {i.unit}
          </span>
        </li>
      ))}
      {diff.removed.map((i, k) => (
        <li key={`r${k}`} className="flex gap-1.5 items-baseline">
          <span className="shrink-0 px-1.5 rounded bg-red-100 text-red-800 font-bold">حذف شد</span>
          <span>
            {itemLabel(i)} — {fa(i.qty)} {i.unit}
          </span>
        </li>
      ))}
      {diff.qtyChanged.map((i, k) => (
        <li key={`q${k}`} className="flex gap-1.5 items-baseline">
          <span className="shrink-0 px-1.5 rounded bg-amber-100 text-amber-900 font-bold">تغییر مقدار</span>
          <span>
            {itemLabel(i)}: {fa(i.oldQty)} ← {fa(i.newQty)} {i.unit}
          </span>
        </li>
      ))}
      {diff.priceChanged.map((i, k) => (
        <li key={`p${k}`} className="flex gap-1.5 items-baseline">
          <span className="shrink-0 px-1.5 rounded bg-blue-100 text-blue-900 font-bold">تغییر قیمت</span>
          <span>
            {itemLabel(i)}: {fa(Math.round(i.oldUnitPriceRial / 10))} ← {fa(Math.round(i.newUnitPriceRial / 10))} تومان
          </span>
        </li>
      ))}
      {amountChanged && (
        <li className="flex gap-1.5 items-baseline">
          <span className="shrink-0 px-1.5 rounded bg-slate-200 text-slate-800 font-bold">مبلغ کل</span>
          <span>
            {fa(oldAmountToman)} ← {fa(newAmountToman)} تومان
          </span>
        </li>
      )}
      {none && !amountChanged && <li className="text-slate-600">اقلام و مقادیر با پیش‌فاکتور قبلی یکسان است.</li>}
      {diff.unchanged > 0 && !none && (
        <li className="text-slate-500">{fa(diff.unchanged)} قلم دیگر بدون تغییر.</li>
      )}
    </ul>
  );
}
