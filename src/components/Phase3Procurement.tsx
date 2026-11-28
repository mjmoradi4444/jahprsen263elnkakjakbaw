import React, { useCallback, useEffect, useRef, useState } from 'react';
import { PackagePlus, Plus } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { computeLatestCursor, mergeIncrementalRecords } from '../shared/sync';
import { ProcurementItem, ProcurementStatus, TOP_BRANDS } from '../shared/types';
import { formatPersianDateTime, normalizeDigits } from '../shared/workflow';

interface Phase3ProcurementProps {
  refreshTrigger: number;
  onNotify: (message: string, isError?: boolean) => void;
  onDataChanged: () => void;
}

export function Phase3Procurement({ refreshTrigger, onNotify, onDataChanged }: Phase3ProcurementProps) {
  const [items, setItems] = useState<ProcurementItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'all' | ProcurementStatus>('all');
  const [showForm, setShowForm] = useState(false);

  const [brand, setBrand] = useState(TOP_BRANDS[0]);
  const [partName, setPartName] = useState('');
  const [partCode, setPartCode] = useState('');
  const [qtyNeeded, setQtyNeeded] = useState('10');
  const [priority, setPriority] = useState<'فوری' | 'عادی'>('فوری');
  const [relatedProforma, setRelatedProforma] = useState('');
  const [supplierNote, setSupplierNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const lastSyncCursorRef = useRef<string | null>(null);
  const inFlightSyncRef = useRef(false);
  const initialRefreshRef = useRef(refreshTrigger);

  const mergeItemLocal = useCallback((updated: ProcurementItem) => {
    setItems((prev) => mergeIncrementalRecords(prev, [updated]));
    // Do not advance the sync cursor from a local action: other users' changes with earlier
    // timestamps may not have been fetched yet and would otherwise be skipped forever.
  }, []);

  const fetchItems = useCallback(async () => {
    try {
      const snapshot = await api.syncChanges(null);
      setItems(snapshot.procurement);
      lastSyncCursorRef.current =
        snapshot.cursor ||
        computeLatestCursor(
          snapshot.procurement.map((i) => i.updatedAt),
          lastSyncCursorRef.current,
        ) ||
        new Date().toISOString();
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'خطا در دریافت صف تامین.', true);
    } finally {
      setLoading(false);
    }
  }, [onNotify]);

  const runIncrementalSync = useCallback(async () => {
    if (inFlightSyncRef.current) return;
    if (!lastSyncCursorRef.current) {
      await fetchItems();
      return;
    }
    inFlightSyncRef.current = true;
    try {
      const delta = await api.syncChanges(lastSyncCursorRef.current);
      lastSyncCursorRef.current = delta.cursor;
      if (delta.procurement.length > 0) {
        setItems((prev) => mergeIncrementalRecords(prev, delta.procurement));
      }
    } catch {
      // ignore transient errors
    } finally {
      inFlightSyncRef.current = false;
    }
  }, [fetchItems]);

  useEffect(() => {
    fetchItems();
  }, [fetchItems]);

  useEffect(() => {
    if (refreshTrigger === initialRefreshRef.current) return;
    initialRefreshRef.current = refreshTrigger;
    runIncrementalSync();
  }, [refreshTrigger, runIncrementalSync]);

  // Lightweight 4.5s incremental sync (`updated_at > cursor`) — zero unchanged rows downloaded
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') {
        runIncrementalSync();
      }
    }, 4_500);
    return () => clearInterval(timer);
  }, [runIncrementalSync]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (submitting) return;
    setError(null);
    const qty = Number(normalizeDigits(qtyNeeded));
    if (!partName.trim() || !Number.isInteger(qty) || qty < 1) {
      setError('نام قطعه و تعداد معتبر (حداقل ۱) الزامی است.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.createProcurement({
        brand,
        partName: partName.trim(),
        partCode: partCode.trim(),
        qtyNeeded: qty,
        priority,
        relatedOrderProforma: relatedProforma.trim(),
        supplierNote: supplierNote.trim(),
      });
      mergeItemLocal(res.item);
      setPartName('');
      setPartCode('');
      setQtyNeeded('10');
      setRelatedProforma('');
      setSupplierNote('');
      setShowForm(false);
      onNotify(`کسری قطعه «${res.item.partName}» در صف تامین ثبت شد.`);
      onDataChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در ثبت درخواست تامین.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleTransition(item: ProcurementItem, nextStatus: ProcurementStatus) {
    setBusyId(item.id);
    try {
      const res = await api.updateProcurement(item.id, { status: nextStatus });
      mergeItemLocal(res.item);
      onNotify(
        nextStatus === 'ordered'
          ? `سفارش تامین «${item.partName}» به تامین‌کننده ثبت شد.`
          : `ورود قطعه «${item.partName}» به انبار تایید شد.`,
      );
      onDataChanged();
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'خطا در تغییر وضعیت تامین.', true);
      await runIncrementalSync();
    } finally {
      setBusyId(null);
    }
  }

  const reportedCount = items.filter((i) => i.status === 'reported').length;
  const orderedCount = items.filter((i) => i.status === 'ordered').length;
  const receivedCount = items.filter((i) => i.status === 'received').length;
  const filtered = statusFilter === 'all' ? items : items.filter((i) => i.status === statusFilter);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">کسری‌های جدید انبار</div>
          <div className="text-2xl font-extrabold text-red-700 mt-1 tabular-nums">{reportedCount}</div>
          <div className="text-[11px] text-slate-500 mt-1">نیازمند استعلام و سفارش خرید</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">سفارش‌شده به ۵۰ برند</div>
          <div className="text-2xl font-extrabold text-blue-700 mt-1 tabular-nums">{orderedCount}</div>
          <div className="text-[11px] text-slate-500 mt-1">در انتظار دریافت و ورود به انبار</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">تامین و وارد انبار شده</div>
          <div className="text-2xl font-extrabold text-emerald-700 mt-1 tabular-nums">{receivedCount}</div>
          <div className="text-[11px] text-slate-500 mt-1">تکمیل‌شده</div>
        </div>
      </div>

      {/* Header + Add Form */}
      <div className="bg-white border border-slate-200 rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="text-sm font-extrabold text-slate-900">صف تامین کالا و نقطه سفارش ۵۰ برند (ایران‌خودرو و سایپا)</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              کسری‌های اعلام‌شده در مرحله انبار به‌طور خودکار در این لیست ثبت شده و تا لحظه ورود به انبار پیگیری می‌شوند.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowForm((s) => !s)}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold cursor-pointer"
          >
            <Plus className="w-3.5 h-3.5" />
            {showForm ? 'بستن فرم' : 'ثبت درخواست تامین جدید'}
          </button>
        </div>

        {showForm && (
          <form onSubmit={handleCreate} className="mt-5 pt-5 border-t border-slate-200 space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="p3-brand" className="block text-xs font-bold text-slate-800 mb-1">
                  برند قطعه *
                </label>
                <select
                  id="p3-brand"
                  value={brand}
                  onChange={(e) => setBrand(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  {TOP_BRANDS.map((b) => (
                    <option key={b} value={b}>
                      {b}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label htmlFor="p3-part" className="block text-xs font-bold text-slate-800 mb-1">
                  نام قطعه و خودرو *
                </label>
                <input
                  id="p3-part"
                  type="text"
                  required
                  value={partName}
                  onChange={(e) => setPartName(e.target.value)}
                  placeholder="مثلاً: دیسک و صفحه پژو ۲۰۶ تیپ ۵"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>
              <div>
                <label htmlFor="p3-code" className="block text-xs font-bold text-slate-800 mb-1">
                  کد فنی (اختیاری)
                </label>
                <input
                  id="p3-code"
                  type="text"
                  dir="ltr"
                  value={partCode}
                  onChange={(e) => setPartCode(e.target.value)}
                  placeholder="EZ-206-CL"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
                />
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label htmlFor="p3-qty" className="block text-xs font-bold text-slate-800 mb-1">
                  تعداد مورد نیاز *
                </label>
                <input
                  id="p3-qty"
                  type="number"
                  min={1}
                  dir="ltr"
                  required
                  value={qtyNeeded}
                  onChange={(e) => setQtyNeeded(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
                />
              </div>
              <div>
                <label htmlFor="p3-priority" className="block text-xs font-bold text-slate-800 mb-1">
                  اولویت تامین
                </label>
                <select
                  id="p3-priority"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value as 'فوری' | 'عادی')}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                >
                  <option value="فوری">فوری</option>
                  <option value="عادی">عادی</option>
                </select>
              </div>
              <div>
                <label htmlFor="p3-pf" className="block text-xs font-bold text-slate-800 mb-1">
                  شماره سفارش مرتبط (اختیاری)
                </label>
                <input
                  id="p3-pf"
                  type="text"
                  dir="ltr"
                  value={relatedProforma}
                  onChange={(e) => setRelatedProforma(e.target.value)}
                  placeholder="PF-5013"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
                />
              </div>
            </div>

            <div>
              <label htmlFor="p3-note" className="block text-xs font-bold text-slate-800 mb-1">
                توضیحات تامین‌کننده / انبار
              </label>
              <input
                id="p3-note"
                type="text"
                value={supplierNote}
                onChange={(e) => setSupplierNote(e.target.value)}
                placeholder="مثلاً: موجودی کمتر از نقطه سفارش است"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            {error && (
              <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-semibold text-red-700">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-xs font-bold cursor-pointer"
            >
              <PackagePlus className="w-4 h-4" />
              {submitting ? 'در حال ثبت...' : 'افزودن به صف تامین'}
            </button>
          </form>
        )}
      </div>

      {/* Filter Bar */}
      <div className="flex flex-wrap items-center gap-1.5">
        {[
          { id: 'all', label: 'همه اقلام' },
          { id: 'reported', label: 'ثبت کسری' },
          { id: 'ordered', label: 'سفارش‌شده' },
          { id: 'received', label: 'تامین و وارد انبار شده' },
        ].map((f) => (
          <button
            key={f.id}
            type="button"
            onClick={() => setStatusFilter(f.id as 'all' | ProcurementStatus)}
            className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${
              statusFilter === f.id
                ? 'bg-slate-900 text-white'
                : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900'
            }`}
          >
            {f.label}
          </button>
        ))}
      </div>

      {/* Data Table */}
      <div className="bg-white border border-slate-200 rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-xs text-slate-500">در حال دریافت صف تامین...</div>
        ) : filtered.length === 0 ? (
          <div className="p-8 text-center text-xs text-slate-500">درخواستی در این وضعیت ثبت نشده است.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-right">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="py-3 px-4 font-bold">برند / قطعه</th>
                  <th className="py-3 px-4 font-bold">تعداد</th>
                  <th className="py-3 px-4 font-bold">اولویت</th>
                  <th className="py-3 px-4 font-bold">وضعیت</th>
                  <th className="py-3 px-4 font-bold">ثبت‌کننده / زمان</th>
                  <th className="py-3 px-4 font-bold">اقدام</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((item) => (
                  <tr key={item.id} className="hover:bg-slate-50/70">
                    <td className="py-3 px-4">
                      <div className="font-bold text-slate-900">{item.partName}</div>
                      <div className="text-[11px] text-slate-500 mt-0.5">
                        {item.brand}
                        {item.partCode ? ` · کد: ${item.partCode}` : ''}
                        {item.relatedOrderProforma ? ` · سفارش: ${item.relatedOrderProforma}` : ''}
                      </div>
                      {item.supplierNote && <div className="text-[11px] text-slate-600 mt-0.5">{item.supplierNote}</div>}
                    </td>
                    <td className="py-3 px-4 font-bold tabular-nums">{item.qtyNeeded}</td>
                    <td className="py-3 px-4">
                      <span className={item.priority === 'فوری' ? 'text-red-700 font-bold' : 'text-slate-600'}>
                        {item.priority}
                      </span>
                    </td>
                    <td className="py-3 px-4 font-bold">
                      {item.status === 'reported' && <span className="text-red-700">ثبت کسری</span>}
                      {item.status === 'ordered' && <span className="text-blue-700">سفارش به تامین‌کننده</span>}
                      {item.status === 'received' && <span className="text-emerald-700">تامین و وارد انبار شد</span>}
                    </td>
                    <td className="py-3 px-4 text-slate-600">
                      <div>{item.reportedByName}</div>
                      <div className="text-[10px] text-slate-400 tabular-nums">{formatPersianDateTime(item.updatedAt)}</div>
                    </td>
                    <td className="py-3 px-4 whitespace-nowrap">
                      {item.status === 'reported' && (
                        <button
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => handleTransition(item, 'ordered')}
                          className="px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white font-bold cursor-pointer"
                        >
                          ثبت سفارش خرید
                        </button>
                      )}
                      {item.status === 'ordered' && (
                        <button
                          type="button"
                          disabled={busyId === item.id}
                          onClick={() => handleTransition(item, 'received')}
                          className="px-3 py-1.5 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white font-bold cursor-pointer"
                        >
                          تایید ورود به انبار
                        </button>
                      )}
                      {item.status === 'received' && <span className="text-emerald-700 font-semibold">بسته‌شده</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
