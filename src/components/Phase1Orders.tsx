import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  ChevronLeft,
  ChevronRight,
  Copy,
  FileText,
  MessageSquare,
  Plus,
  Printer,
  RotateCcw,
  Search,
  Upload,
} from 'lucide-react';
import { api, ApiError, LogsListResponse, OrdersListResponse, WhatsAppSummaryResponse } from '../api/client';
import { OrderRecord, STAGES, UserAccountPublic } from '../shared/types';
import {
  canRoleActOnOrder,
  formatAmountToman,
  formatPersianDateTime,
} from '../shared/workflow';
import { AuthenticatedImage } from './AuthenticatedMedia';
import {
  ConvertInvoiceModal,
  DriverDeliveryModal,
  OrderDocumentModal,
  ReturnOrderModal,
  ReviseOrderModal,
  WarehouseExitModal,
} from './OrderModals';

interface Phase1OrdersProps {
  user: UserAccountPublic;
  refreshTrigger: number;
  onNotify: (message: string, isError?: boolean) => void;
  onDataChanged: () => void;
}

export function Phase1Orders({ user, refreshTrigger, onNotify, onDataChanged }: Phase1OrdersProps) {
  const [subTab, setSubTab] = useState<'board' | 'new' | 'logs'>('board');
  const [filter, setFilter] = useState<string>(user.id === 'ceo' ? 'active' : 'mine');
  const [selectedStage, setSelectedStage] = useState<number | null>(null);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);

  const [data, setData] = useState<OrdersListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busyOrderId, setBusyOrderId] = useState<string | null>(null);

  // Modals
  const [convertOrder, setConvertOrder] = useState<OrderRecord | null>(null);
  const [exitOrder, setExitOrder] = useState<OrderRecord | null>(null);
  const [deliveryOrder, setDeliveryOrder] = useState<OrderRecord | null>(null);
  const [returnState, setReturnState] = useState<{
    order: OrderRecord;
    target: 'sales' | 'sales_mgr' | 'customer_reject' | 'accounting';
  } | null>(null);
  const [reviseOrder, setReviseOrder] = useState<OrderRecord | null>(null);
  const [docModalState, setDocModalState] = useState<{ order: OrderRecord; mode: 'docs' | 'print' } | null>(null);

  // New Order form state
  const [fCustomer, setFCustomer] = useState('');
  const [fProforma, setFProforma] = useState('');
  const [fChannel, setFChannel] = useState('تلفنی');
  const [fAmount, setFAmount] = useState('');
  const [fPayment, setFPayment] = useState('نقدی / واریز آنی');
  const [fItems, setFItems] = useState('');
  const [fUploadedFile, setFUploadedFile] = useState<{ fileId: string; originalName: string } | null>(null);
  const [fUploading, setFUploading] = useState(false);
  const [fSubmitting, setFSubmitting] = useState(false);
  const [fError, setFError] = useState<string | null>(null);

  // Logs & WhatsApp state
  const [logsData, setLogsData] = useState<LogsListResponse | null>(null);
  const [logsPage, setLogsPage] = useState(1);
  const [waSummary, setWaSummary] = useState<WhatsAppSummaryResponse | null>(null);
  const [copiedWa, setCopiedWa] = useState(false);

  const fetchOrders = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await api.getOrders({
        filter,
        stage: selectedStage,
        search: search.trim(),
        page,
        limit: 12,
      });
      setData(res);
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'خطا در دریافت لیست سفارش‌ها.');
    } finally {
      setLoading(false);
    }
  }, [filter, selectedStage, search, page]);

  useEffect(() => {
    fetchOrders();
  }, [fetchOrders, refreshTrigger]);

  useEffect(() => {
    if (subTab !== 'logs') return;
    api
      .getLogs(logsPage, 25)
      .then(setLogsData)
      .catch(() => {});
    api
      .getWhatsAppSummary()
      .then(setWaSummary)
      .catch(() => {});
  }, [subTab, logsPage, refreshTrigger]);

  async function handleAdvance(order: OrderRecord) {
    setBusyOrderId(order.id);
    try {
      await api.advanceOrder(order.id, order.version);
      onNotify(
        order.stage === 2
          ? `پیش‌فاکتور ${order.proforma} تایید و جهت تاییدیه مشتری ارسال شد.`
          : `تاییدیه مشتری برای ${order.proforma} ثبت و به حسابداری ارسال شد.`,
      );
      onDataChanged();
      await fetchOrders();
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'خطا در بروزرسانی مرحله.', true);
      await fetchOrders();
    } finally {
      setBusyOrderId(null);
    }
  }

  async function handleMgrResolve(order: OrderRecord) {
    setBusyOrderId(order.id);
    try {
      await api.mgrResolveOrder(order.id, order.version);
      onNotify(`مغایرت پیش‌فاکتور ${order.proforma} بررسی و مجدداً به حسابداری ارسال شد.`);
      onDataChanged();
      await fetchOrders();
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'خطا در ارسال مجدد.', true);
      await fetchOrders();
    } finally {
      setBusyOrderId(null);
    }
  }

  async function handleNewOrderFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) {
      setFUploadedFile(null);
      return;
    }
    setFError(null);
    if (file.size > 5 * 1024 * 1024) {
      setFError('حجم فایل پیوست بیشتر از ۵ مگابایت است. لطفاً فایل کم‌حجم‌تری انتخاب کنید.');
      e.target.value = '';
      return;
    }
    setFUploading(true);
    try {
      const res = await api.uploadFile(file, 'order_doc');
      setFUploadedFile({ fileId: res.fileId, originalName: res.originalName });
    } catch (err) {
      setFError(err instanceof ApiError ? err.message : 'خطا در بارگذاری فایل.');
      e.target.value = '';
    } finally {
      setFUploading(false);
    }
  }

  async function handleCreateOrder(e: React.FormEvent) {
    e.preventDefault();
    if (fSubmitting || fUploading) return;
    setFError(null);
    setFSubmitting(true);
    try {
      const res = await api.createOrder({
        customer: fCustomer.trim(),
        proforma: fProforma.trim(),
        channel: fChannel,
        amountToman: fAmount.trim(),
        payment: fPayment,
        items: fItems.trim(),
        fileId: fUploadedFile?.fileId || null,
      });
      setFCustomer('');
      setFProforma('');
      setFAmount('');
      setFItems('');
      setFUploadedFile(null);
      onNotify(`پیش‌فاکتور ${res.order.proforma} با موفقیت ثبت و به مدیر فروش ارسال شد.`);
      setSubTab('board');
      setFilter('active');
      setSelectedStage(null);
      setPage(1);
      onDataChanged();
      await fetchOrders();
    } catch (err) {
      setFError(err instanceof ApiError ? err.message : 'خطا در ثبت پیش‌فاکتور.');
    } finally {
      setFSubmitting(false);
    }
  }

  async function handleCopyWaText() {
    if (!waSummary) return;
    try {
      await navigator.clipboard.writeText(waSummary.text);
      setCopiedWa(true);
      setTimeout(() => setCopiedWa(false), 2500);
    } catch {
      onNotify('امکان کپی خودکار در این مرورگر نبود؛ متن را از کادر زیر کپی کنید.', true);
    }
  }

  const showFinancials = user.id !== 'warehouse_sup' && user.id !== 'driver';
  const stats = data?.stats;

  return (
    <div className="space-y-6">
      {/* KPI Summary Strip — tailored cleanly for Driver so delivery cards appear above the fold on mobile */}
      {user.id === 'driver' ? (
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-medium text-slate-500">آماده تحویل (نزد من)</div>
            <div className="text-2xl font-extrabold text-blue-700 mt-1 tabular-nums">{stats?.driver ?? 0}</div>
            <div className="text-[11px] text-slate-500 mt-1">منتظر تحویل و امضای مشتری</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-medium text-slate-500">تحویل قطعی‌شده</div>
            <div className="text-2xl font-extrabold text-emerald-700 mt-1 tabular-nums">{stats?.delivered ?? 0}</div>
            <div className="text-[11px] text-slate-500 mt-1">بایگانی‌شده با امضای مشتری</div>
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-medium text-slate-500">در جریان فروش و مالی</div>
            <div className="text-2xl font-extrabold text-slate-900 mt-1 tabular-nums">{stats?.salesFlow ?? 0}</div>
            {showFinancials && stats && (
              <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
                ارزش جاری: {formatAmountToman(stats.totalActiveAmountToman)} تومان
              </div>
            )}
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-medium text-slate-500">در صف سرپرست انبار</div>
            <div className="text-2xl font-extrabold text-amber-700 mt-1 tabular-nums">{stats?.warehouse ?? 0}</div>
            <div className="text-[11px] text-slate-500 mt-1">آماده جمع‌آوری و خروج</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-medium text-slate-500">در مسیر توزیع (راننده)</div>
            <div className="text-2xl font-extrabold text-blue-700 mt-1 tabular-nums">{stats?.driver ?? 0}</div>
            <div className="text-[11px] text-slate-500 mt-1">منتظر تحویل و امضای مشتری</div>
          </div>
          <div className="bg-white border border-slate-200 rounded-xl p-4">
            <div className="text-xs font-medium text-slate-500">تحویل قطعی (آرشیو)</div>
            <div className="text-2xl font-extrabold text-emerald-700 mt-1 tabular-nums">{stats?.delivered ?? 0}</div>
            {showFinancials && stats && (
              <div className="text-[11px] text-slate-500 mt-1 tabular-nums">
                جمع تحویل‌شده: {formatAmountToman(stats.totalDeliveredAmountToman)} تومان
              </div>
            )}
          </div>
        </div>
      )}

      {/* CEO / Sales Manager Rep Breakdown Table */}
      {data && data.repBreakdown.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between gap-4">
            <h2 className="text-sm font-extrabold text-slate-900">گزارش خلاصه فروش به تفکیک کارشناسان</h2>
            <span className="text-xs text-slate-500 tabular-nums">کل سفارش‌ها: {stats?.total ?? 0} مورد</span>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-right">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="py-2.5 px-4 font-bold">کارشناس فروش</th>
                  <th className="py-2.5 px-4 font-bold">کل ثبت‌شده</th>
                  <th className="py-2.5 px-4 font-bold">در جریان</th>
                  <th className="py-2.5 px-4 font-bold">برگشتی / مغایرت</th>
                  <th className="py-2.5 px-4 font-bold">تحویل قطعی</th>
                  <th className="py-2.5 px-4 font-bold">جمع ریالی کل (تومان)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.repBreakdown.map((rep) => (
                  <tr key={rep.roleId} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-bold text-slate-900">{rep.displayName}</td>
                    <td className="py-2.5 px-4 tabular-nums">{rep.total}</td>
                    <td className="py-2.5 px-4 tabular-nums font-semibold text-blue-700">{rep.inProgress}</td>
                    <td className="py-2.5 px-4 tabular-nums font-semibold text-red-700">{rep.returned}</td>
                    <td className="py-2.5 px-4 tabular-nums font-semibold text-emerald-700">{rep.delivered}</td>
                    <td className="py-2.5 px-4 tabular-nums font-bold text-slate-900">
                      {formatAmountToman(rep.totalAmountToman)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* 6-Stage Flow Schematic (hidden for Driver so delivery cards sit directly above the fold) */}
      {user.id !== 'driver' && (
        <section className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-2 mb-4">
            <h2 className="text-sm font-extrabold text-slate-900">نقشه جریان ۶ مرحله‌ای سفارش تا تحویل</h2>
            {selectedStage !== null && (
              <button
                type="button"
                onClick={() => {
                  setSelectedStage(null);
                  setPage(1);
                }}
                className="text-xs font-bold text-blue-700 hover:underline cursor-pointer"
              >
                نمایش همه ایستگاه‌ها
              </button>
            )}
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2.5">
            {STAGES.map((st) => {
              const count = data?.stageCounts?.[st.id] ?? 0;
              const isSelected = selectedStage === st.id;
              const isMyStage =
                (user.isSales && (st.id === 1 || st.id === 3)) || user.id === st.roleId;
              return (
                <button
                  key={st.id}
                  type="button"
                  onClick={() => {
                    setSubTab('board');
                    setSelectedStage(isSelected ? null : st.id);
                    setPage(1);
                  }}
                  className={`text-right p-3 rounded-lg border transition-colors cursor-pointer ${
                    isSelected
                      ? 'border-slate-900 bg-slate-900 text-white'
                      : isMyStage
                        ? 'border-blue-300 bg-blue-50/60 text-slate-900 hover:border-blue-500'
                        : 'border-slate-200 bg-slate-50/70 text-slate-800 hover:border-slate-300'
                  }`}
                >
                  <div className={`text-[11px] font-semibold ${isSelected ? 'text-slate-300' : 'text-slate-500'}`}>
                    مرحله {st.id}
                  </div>
                  <div className="text-xs font-bold mt-0.5 truncate">{st.short}</div>
                  <div
                    className={`text-sm font-extrabold mt-2 tabular-nums ${
                      isSelected ? 'text-white' : count > 0 ? 'text-blue-700' : 'text-slate-400'
                    }`}
                  >
                    {count} مورد
                  </div>
                </button>
              );
            })}
          </div>
        </section>
      )}

      {/* Sub-navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 pb-3">
        <div className="flex items-center gap-1 p-1 bg-slate-100 rounded-lg" role="tablist" aria-label="تب‌های فروش">
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'board'}
            onClick={() => setSubTab('board')}
            className={`px-3.5 py-2 rounded-md text-xs font-bold transition-colors whitespace-nowrap cursor-pointer ${
              subTab === 'board' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            کارتابل سفارش‌ها
          </button>
          {user.isSales && (
            <button
              type="button"
              role="tab"
              aria-selected={subTab === 'new'}
              onClick={() => setSubTab('new')}
              className={`inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md text-xs font-bold transition-colors whitespace-nowrap cursor-pointer ${
                subTab === 'new' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
              }`}
            >
              <Plus className="w-3.5 h-3.5" />
              ثبت پیش‌فاکتور جدید
            </button>
          )}
          <button
            type="button"
            role="tab"
            aria-selected={subTab === 'logs'}
            onClick={() => setSubTab('logs')}
            className={`px-3.5 py-2 rounded-md text-xs font-bold transition-colors whitespace-nowrap cursor-pointer ${
              subTab === 'logs' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-600 hover:text-slate-900'
            }`}
          >
            گزارش وقایع و واتساپ
          </button>
        </div>

        {subTab === 'board' && (
          <div className="relative w-full sm:w-64">
            <Search className="w-4 h-4 text-slate-400 absolute right-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="search"
              aria-label="جستجوی سفارش"
              value={search}
              onChange={(e) => {
                setSearch(e.target.value);
                setPage(1);
              }}
              placeholder="جستجوی مشتری، پیش‌فاکتور، فاکتور..."
              className="w-full pr-9 pl-3 py-2 text-xs bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
            />
          </div>
        )}
      </div>

      {/* TAB 1: ORDERS BOARD */}
      {subTab === 'board' && (
        <div className="space-y-4">
          {/* Interactive Filter Controls */}
          <div className="flex flex-wrap items-center gap-1.5">
            {(user.id === 'driver'
              ? [
                  { id: 'mine', label: 'آماده تحویل من' },
                  { id: 'done', label: 'آرشیو تحویل‌شده‌ها' },
                ]
              : [
                  ...(user.id !== 'ceo' ? [{ id: 'mine', label: 'کارتابل من' }] : []),
                  { id: 'active', label: 'همه جاری‌ها' },
                  { id: 'returned', label: 'برگشتی / مغایرت' },
                  { id: 'warehouse', label: 'در انبار' },
                  { id: 'driver', label: 'نزد راننده' },
                  { id: 'done', label: 'آرشیو تحویل‌شده‌ها' },
                ]
            ).map((f) => {
              const active = selectedStage === null && filter === f.id;
              return (
                <button
                  key={f.id}
                  type="button"
                  onClick={() => {
                    setSelectedStage(null);
                    setFilter(f.id);
                    setPage(1);
                  }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-colors whitespace-nowrap cursor-pointer ${
                    active
                      ? 'bg-slate-900 text-white'
                      : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900 hover:border-slate-300'
                  }`}
                >
                  {f.label}
                </button>
              );
            })}
          </div>

          {loadError && (
            <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-800 flex items-center justify-between gap-3">
              <span>{loadError}</span>
              <button
                type="button"
                onClick={fetchOrders}
                className="px-3 py-1.5 rounded-lg bg-red-700 text-white font-bold cursor-pointer"
              >
                تلاش مجدد
              </button>
            </div>
          )}

          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((k) => (
                <div key={k} className="bg-white border border-slate-200 rounded-xl p-5 h-36 animate-pulse" />
              ))}
            </div>
          ) : !data || data.items.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-xl p-10 text-center">
              <div className="text-sm font-bold text-slate-900">سفارشی در این فیلتر وجود ندارد</div>
              <p className="text-xs text-slate-500 mt-1">
                برای مشاهده سایر سفارش‌های قابل دسترس خود، فیلتر «همه جاری‌ها» یا «آرشیو تحویل‌شده‌ها» را انتخاب کنید.
              </p>
            </div>
          ) : (
            <div className="space-y-4">
              {data.items.map((order) => {
                const isDone = order.stage >= 7;
                const isReturned = order.status !== 'active';
                const myTurn = canRoleActOnOrder(user.id, order);
                const isBusy = busyOrderId === order.id;

                return (
                  <article
                    key={order.id}
                    className={`bg-white border rounded-xl p-5 space-y-4 ${
                      isReturned
                        ? 'border-red-300'
                        : myTurn
                          ? 'border-blue-400'
                          : isDone
                            ? 'border-emerald-200'
                            : 'border-slate-200'
                    }`}
                  >
                    {/* Header row — clean unboxed metadata with typographic separators */}
                    <div className="flex flex-wrap items-start justify-between gap-4">
                      <div className="space-y-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                          <span className="font-mono-code font-bold text-slate-800">{order.proforma}</span>
                          {order.finalInvoiceNo && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="font-bold text-emerald-700">
                                فاکتور <span dir="ltr" className="font-mono-code">{order.finalInvoiceNo}</span>
                              </span>
                            </>
                          )}
                          <span aria-hidden="true">·</span>
                          <span>{order.salesOwnerName}</span>
                          {order.rev > 0 && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span className="text-amber-700 font-semibold">اصلاحیه #{order.rev}</span>
                            </>
                          )}
                          {order.channel && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{order.channel}</span>
                            </>
                          )}
                          {order.payment && (
                            <>
                              <span aria-hidden="true">·</span>
                              <span>{order.payment}</span>
                            </>
                          )}
                        </div>
                        <h3 className="text-base font-extrabold text-slate-900">{order.customer}</h3>
                        <p className="text-xs text-slate-600 leading-relaxed">{order.items}</p>
                      </div>

                      <div className="flex flex-col items-end gap-1.5 shrink-0">
                        {order.amountToman !== null && (
                          <div className="text-left">
                            <div className="text-base font-extrabold text-slate-900 tabular-nums">
                              {formatAmountToman(order.amountToman)}
                            </div>
                            <div className="text-[11px] text-slate-500">تومان</div>
                          </div>
                        )}
                        <div className="flex items-center gap-2">
                          <button
                            type="button"
                            onClick={() => setDocModalState({ order, mode: 'docs' })}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-50 cursor-pointer"
                          >
                            <FileText className="w-3.5 h-3.5" />
                            اسناد ({order.documents.length})
                          </button>
                          <button
                            type="button"
                            onClick={() => setDocModalState({ order, mode: 'print' })}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold cursor-pointer"
                          >
                            <Printer className="w-3.5 h-3.5" />
                            برگه انبار
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Return alert */}
                    {isReturned && (
                      <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-900">
                        <span className="font-bold">
                          {order.status === 'returned_to_accounting'
                            ? 'مغایرت انبار (برگشت به حسابداری): '
                            : order.status === 'returned_to_sales_mgr'
                              ? 'عودت از مالی به مدیر فروش: '
                              : 'برگشت به کارشناس فروش: '}
                          {order.returnReason}
                        </span>
                        {order.returnNote && order.returnNote !== order.returnReason && (
                          <span className="mr-1.5 text-red-800">— {order.returnNote}</span>
                        )}
                      </div>
                    )}

                    {/* Carton Discrepancy Alert */}
                    {order.cartonDiscrepancy !== 0 && (
                      <div className="p-3 rounded-lg bg-amber-50 border border-amber-300 text-xs text-amber-950 flex items-start gap-2">
                        <AlertTriangle className="w-4 h-4 text-amber-700 shrink-0 mt-0.5" />
                        <div>
                          <strong>
                            مغایرت تعداد کارتن ثبت شده است: خروجی انبار {order.cartonsOut} کارتن / تحویل به مشتری{' '}
                            {order.cartonsDelivered} کارتن (اختلاف:{' '}
                            {order.cartonDiscrepancy > 0 ? `+${order.cartonDiscrepancy}` : order.cartonDiscrepancy})
                          </strong>
                          {order.discrepancyNote && <div className="mt-0.5 text-amber-900">توضیح راننده: {order.discrepancyNote}</div>}
                        </div>
                      </div>
                    )}

                    {/* 6-Step Progress Line with Full Date+Time */}
                    <div className="pt-3 border-t border-slate-100 overflow-x-auto">
                      <div className="grid grid-cols-6 gap-2 min-w-[540px]">
                        {STAGES.map((st) => {
                          const done = !isReturned && order.stage > st.id;
                          const returnedHere =
                            (order.status === 'returned_to_sales' && st.id === 1) ||
                            (order.status === 'returned_to_sales_mgr' && st.id === 2) ||
                            (order.status === 'returned_to_accounting' && st.id === 4);
                          const current = !isReturned && order.stage === st.id;
                          const lastEntry = [...order.stageHistory].reverse().find((h) => h.stage === st.id);

                          return (
                            <div key={st.id} className="text-center">
                              <div className="flex items-center justify-center">
                                <span
                                  className={`w-6 h-6 rounded-full text-[11px] font-bold flex items-center justify-center ${
                                    done
                                      ? 'bg-emerald-600 text-white'
                                      : returnedHere
                                        ? 'bg-red-600 text-white'
                                        : current
                                          ? 'bg-blue-700 text-white'
                                          : 'bg-slate-100 text-slate-500 border border-slate-300'
                                  }`}
                                >
                                  {done ? '✓' : returnedHere ? '!' : st.id}
                                </span>
                              </div>
                              <div
                                className={`text-[11px] font-bold mt-1.5 ${
                                  done
                                    ? 'text-emerald-700'
                                    : returnedHere
                                      ? 'text-red-700'
                                      : current
                                        ? 'text-blue-700'
                                        : 'text-slate-500'
                                }`}
                              >
                                {st.short}
                              </div>
                              <div className="text-[10px] text-slate-400 tabular-nums mt-0.5">
                                {lastEntry ? formatPersianDateTime(lastEntry.timestamp) : '—'}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>

                    {/* Logistics + Authenticated Digital Signature Strip */}
                    {(order.cartonsOut !== null || order.accountingNote || order.signatureFileId) && (
                      <div className="pt-3 border-t border-slate-100 flex flex-wrap items-center justify-between gap-4 text-xs text-slate-700">
                        <div className="flex flex-wrap items-center gap-x-4 gap-y-1">
                          {order.accountingNote && (
                            <span>
                              یادداشت مالی: <strong className="text-slate-900">{order.accountingNote}</strong>
                            </span>
                          )}
                          {order.cartonsOut !== null && (
                            <span className="tabular-nums">
                              خروجی انبار: <strong className="text-slate-900">{order.cartonsOut} کارتن</strong>
                            </span>
                          )}
                          {order.exitTime && (
                            <span className="tabular-nums">
                              ساعت خروج: <strong className="text-slate-900">{order.exitTime}</strong>
                            </span>
                          )}
                          {order.driverName && (
                            <span>
                              راننده: <strong className="text-slate-900">{order.driverName}</strong>
                            </span>
                          )}
                          {order.cartonsDelivered !== null && (
                            <span className="tabular-nums">
                              تحویلی: <strong className="text-slate-900">{order.cartonsDelivered} کارتن</strong>
                            </span>
                          )}
                          {order.customerSigner && (
                            <span>
                              تحویل‌گیرنده: <strong className="text-slate-900">{order.customerSigner}</strong>
                            </span>
                          )}
                        </div>

                        {order.signatureFileId && (
                          <div className="flex items-center gap-2 border border-slate-200 rounded-lg px-2.5 py-1 bg-slate-50">
                            <span className="text-[11px] font-bold text-emerald-700">امضای مشتری:</span>
                            <AuthenticatedImage
                              fileId={order.signatureFileId}
                              alt={`امضای تحویل ${order.customer}`}
                              className="h-9 max-w-[120px] object-contain"
                            />
                          </div>
                        )}
                      </div>
                    )}

                    {/* Action Footer */}
                    <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center gap-2">
                      {isDone ? (
                        <div className="text-xs font-bold text-emerald-700">
                          تحویل قطعی به «{order.customerSigner || 'مشتری'}» تکمیل و بایگانی شد.
                        </div>
                      ) : myTurn ? (
                        <>
                          {order.status === 'returned_to_sales' && (
                            <button
                              type="button"
                              onClick={() => setReviseOrder(order)}
                              className="px-4 py-2 rounded-lg bg-red-600 hover:bg-red-700 text-white text-xs font-bold cursor-pointer"
                            >
                              اصلاح پیش‌فاکتور و ارسال مجدد به مدیر فروش
                            </button>
                          )}

                          {order.status === 'returned_to_sales_mgr' && (
                            <>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleMgrResolve(order)}
                                className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-xs font-bold cursor-pointer"
                              >
                                بررسی شد و ارسال مجدد به حسابداری
                              </button>
                              <button
                                type="button"
                                onClick={() => setReturnState({ order, target: 'sales' })}
                                className="px-4 py-2 rounded-lg border border-red-300 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold cursor-pointer"
                              >
                                برگشت به کارشناس فروش
                              </button>
                            </>
                          )}

                          {order.status === 'returned_to_accounting' && (
                            <>
                              <button
                                type="button"
                                onClick={() => setConvertOrder(order)}
                                className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold cursor-pointer"
                              >
                                اصلاح فاکتور فروش و ارسال مجدد به انبار
                              </button>
                              <button
                                type="button"
                                onClick={() => setReturnState({ order, target: 'sales_mgr' })}
                                className="px-4 py-2 rounded-lg border border-red-300 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold cursor-pointer"
                              >
                                عودت به مدیر فروش
                              </button>
                            </>
                          )}

                          {order.status === 'active' && order.stage === 2 && (
                            <>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleAdvance(order)}
                                className="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-xs font-bold cursor-pointer"
                              >
                                تایید مدیر فروش و ارسال جهت تاییدیه مشتری
                              </button>
                              <button
                                type="button"
                                onClick={() => setReturnState({ order, target: 'sales' })}
                                className="px-4 py-2 rounded-lg border border-red-300 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold cursor-pointer"
                              >
                                برگشت به کارشناس
                              </button>
                            </>
                          )}

                          {order.status === 'active' && order.stage === 3 && (
                            <>
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleAdvance(order)}
                                className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-xs font-bold cursor-pointer"
                              >
                                ثبت تاییدیه مشتری و ارسال به حسابداری
                              </button>
                              <button
                                type="button"
                                onClick={() => setReturnState({ order, target: 'customer_reject' })}
                                className="px-4 py-2 rounded-lg border border-red-300 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold cursor-pointer"
                              >
                                عدم تایید مشتری (برگشت به مرحله ۱)
                              </button>
                            </>
                          )}

                          {order.status === 'active' && order.stage === 4 && (
                            <>
                              <button
                                type="button"
                                onClick={() => setConvertOrder(order)}
                                className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold cursor-pointer"
                              >
                                تبدیل به فاکتور فروش و ارسال به انبار
                              </button>
                              <button
                                type="button"
                                onClick={() => setReturnState({ order, target: 'sales_mgr' })}
                                className="px-4 py-2 rounded-lg border border-red-300 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold cursor-pointer"
                              >
                                مغایرت نرم‌افزار (عودت به مدیر فروش)
                              </button>
                            </>
                          )}

                          {order.status === 'active' && order.stage === 5 && (
                            <>
                              <button
                                type="button"
                                onClick={() => setExitOrder(order)}
                                className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold cursor-pointer"
                              >
                                ثبت جمع‌آوری، تعداد کارتن و ساعت خروج
                              </button>
                              <button
                                type="button"
                                onClick={() => setReturnState({ order, target: 'accounting' })}
                                className="px-4 py-2 rounded-lg border border-red-300 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold cursor-pointer"
                              >
                                مغایرت / کسری انبار (برگشت به مالی)
                              </button>
                            </>
                          )}

                          {order.status === 'active' && order.stage === 6 && (
                            <button
                              type="button"
                              onClick={() => setDeliveryOrder(order)}
                              className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 text-white text-xs font-bold cursor-pointer"
                            >
                              ثبت تحویل نهایی + امضای دیجیتال مشتری
                            </button>
                          )}
                        </>
                      ) : (
                        <div className="text-xs text-slate-500">
                          در انتظار اقدام مرحله {order.stage} ({STAGES[Math.min(order.stage - 1, 5)]?.short})
                        </div>
                      )}
                    </div>
                  </article>
                );
              })}

              {/* Server Pagination Bar */}
              {data.pagination.totalPages > 1 && (
                <div className="flex items-center justify-between pt-2">
                  <span className="text-xs text-slate-500 tabular-nums">
                    صفحه {data.pagination.page} از {data.pagination.totalPages} (مجموع {data.pagination.total} سفارش)
                  </span>
                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={page <= 1}
                      onClick={() => setPage((p) => Math.max(1, p - 1))}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-bold disabled:opacity-40 cursor-pointer"
                    >
                      <ChevronRight className="w-3.5 h-3.5" />
                      قبلی
                    </button>
                    <button
                      type="button"
                      disabled={page >= data.pagination.totalPages}
                      onClick={() => setPage((p) => p + 1)}
                      className="inline-flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-300 bg-white text-xs font-bold disabled:opacity-40 cursor-pointer"
                    >
                      بعدی
                      <ChevronLeft className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: NEW PROFORMA ORDER FORM */}
      {subTab === 'new' && user.isSales && (
        <form onSubmit={handleCreateOrder} className="bg-white border border-slate-200 rounded-xl p-6 max-w-2xl space-y-4">
          <div>
            <h2 className="text-base font-extrabold text-slate-900">ثبت پیش‌فاکتور جدید و ارسال به مدیر فروش</h2>
            <p className="text-xs text-slate-500 mt-0.5">
              شماره پیش‌فاکتور از نظر تکراری نبودن روی سرور بررسی شده و مبلغ به‌صورت عدد ساختاریافته ذخیره می‌شود.
            </p>
          </div>

          <div>
            <label htmlFor="new-customer" className="block text-xs font-bold text-slate-800 mb-1">
              نام فروشگاه / مشتری *
            </label>
            <input
              id="new-customer"
              type="text"
              required
              value={fCustomer}
              onChange={(e) => setFCustomer(e.target.value)}
              placeholder="مثلاً: لوازم یدکی مرکزی سایپا - کرج"
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="new-proforma" className="block text-xs font-bold text-slate-800 mb-1">
                شماره پیش‌فاکتور (یکتا) *
              </label>
              <input
                id="new-proforma"
                type="text"
                dir="ltr"
                required
                value={fProforma}
                onChange={(e) => setFProforma(e.target.value)}
                placeholder="PF-5020"
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
              />
            </div>
            <div>
              <label htmlFor="new-channel" className="block text-xs font-bold text-slate-800 mb-1">
                کانال دریافت سفارش
              </label>
              <select
                id="new-channel"
                value={fChannel}
                onChange={(e) => setFChannel(e.target.value)}
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="تلفنی">تلفنی</option>
                <option value="روبیکا">گروه روبیکا</option>
                <option value="ایتا">گروه ایتا</option>
                <option value="اپلیکیشن">اپلیکیشن</option>
                <option value="حضوری">حضوری</option>
              </select>
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label htmlFor="new-amount" className="block text-xs font-bold text-slate-800 mb-1">
                مبلغ پیش‌فاکتور (تومان — عددی) *
              </label>
              <input
                id="new-amount"
                type="text"
                dir="ltr"
                required
                value={fAmount}
                onChange={(e) => setFAmount(e.target.value)}
                placeholder="75000000"
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
              />
            </div>
            <div>
              <label htmlFor="new-payment" className="block text-xs font-bold text-slate-800 mb-1">
                شرایط تسویه
              </label>
              <select
                id="new-payment"
                value={fPayment}
                onChange={(e) => setFPayment(e.target.value)}
                className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="نقدی / واریز آنی">نقدی / واریز آنی</option>
                <option value="چک صیادی ۴۵ روزه">چک صیادی ۴۵ روزه</option>
                <option value="اعتباری / حساب باز">اعتباری / حساب باز</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="new-items" className="block text-xs font-bold text-slate-800 mb-1">
              شرح اقلام و برندها (ایران‌خودرو / سایپا) *
            </label>
            <textarea
              id="new-items"
              rows={3}
              required
              value={fItems}
              onChange={(e) => setFItems(e.target.value)}
              placeholder="مثلاً: دیسک و صفحه عظام پژو ۴۰۵ (۶ دست) + لنت جلو کروز پراید (۱۰ دست)"
              className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="p-4 rounded-lg border border-dashed border-blue-300 bg-blue-50/40">
            <label htmlFor="new-pdf-file" className="block text-xs font-bold text-blue-900 mb-1.5">
              بارگذاری فایل PDF یا تصویر پیش‌فاکتور (حداکثر ۵ مگابایت)
            </label>
            <input
              id="new-pdf-file"
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              onChange={handleNewOrderFile}
              className="w-full text-xs text-slate-700"
            />
            <p className="text-[11px] text-blue-800 mt-1.5">
              {fUploading
                ? 'در حال اعتبارسنجی امنیتی و ذخیره فایل روی سرور...'
                : fUploadedFile
                  ? `فایل پیوست آماده است: ${fUploadedFile.originalName}`
                  : 'فایل‌ها روی سرور ذخیره شده و بدون بارگذاری مجدد در مرورگر به‌صورت ایمن نمایش داده می‌شوند.'}
            </p>
          </div>

          {fError && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-semibold text-red-700">
              {fError}
            </div>
          )}

          <button
            type="submit"
            disabled={fSubmitting || fUploading}
            className="w-full py-2.5 px-4 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-sm font-bold cursor-pointer inline-flex items-center justify-center gap-2"
          >
            <Upload className="w-4 h-4" />
            {fSubmitting ? 'در حال ثبت سفارش...' : 'ثبت پیش‌فاکتور و ارسال به مدیر فروش'}
          </button>
        </form>
      )}

      {/* TAB 3: AUDIT LOGS & BOUNDED WHATSAPP REPORT */}
      {subTab === 'logs' && (
        <div className="space-y-4">
          <section className="bg-white border border-slate-200 rounded-xl p-5 space-y-3">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <h2 className="text-sm font-extrabold text-slate-900">گزارش خلاصه واتساپ (بهینه‌سازی‌شده برای محدودیت طول لینک)</h2>
                <p className="text-xs text-slate-500 mt-0.5">
                  فقط سفارش‌های جاری و جمع کل تحویل‌شده‌ها و صندوق چک ارسال می‌شود تا لینک واتساپ دچار قطعی نشود.
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleCopyWaText}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-bold text-slate-800 cursor-pointer"
                >
                  {copiedWa ? <Check className="w-3.5 h-3.5 text-emerald-600" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedWa ? 'کپی شد' : 'کپی متن گزارش'}
                </button>
                {waSummary && (
                  <a
                    href={waSummary.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-bold"
                  >
                    <MessageSquare className="w-3.5 h-3.5" />
                    ارسال در واتساپ
                  </a>
                )}
              </div>
            </div>
            {waSummary && (
              <pre className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-700 whitespace-pre-wrap leading-relaxed font-sans">
                {waSummary.text}
              </pre>
            )}
          </section>

          <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
            <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
              <h2 className="text-sm font-extrabold text-slate-900">تاریخچه کامل رویدادها (ذخیره‌شده با تاریخ و ساعت دقیق)</h2>
              <span className="text-xs text-slate-500 tabular-nums">
                مجموع: {logsData?.pagination.total ?? 0} رویداد
              </span>
            </div>
            <div className="divide-y divide-slate-100">
              {!logsData || logsData.items.length === 0 ? (
                <div className="p-6 text-center text-xs text-slate-500">هنوز رویدادی ثبت نشده است.</div>
              ) : (
                logsData.items.map((log) => (
                  <div key={log.id} className="px-5 py-3 flex flex-wrap items-baseline justify-between gap-2 text-xs">
                    <div className="text-slate-800">
                      <span className="font-bold text-slate-900">{log.actorName}: </span>
                      {log.message}
                    </div>
                    <span className="text-[11px] text-slate-400 tabular-nums shrink-0">
                      {formatPersianDateTime(log.createdAt)}
                    </span>
                  </div>
                ))
              )}
            </div>
            {logsData && logsData.pagination.totalPages > 1 && (
              <div className="px-5 py-3 border-t border-slate-200 flex items-center justify-between text-xs">
                <span className="text-slate-500 tabular-nums">
                  صفحه {logsData.pagination.page} از {logsData.pagination.totalPages}
                </span>
                <div className="flex gap-2">
                  <button
                    type="button"
                    disabled={logsPage <= 1}
                    onClick={() => setLogsPage((p) => Math.max(1, p - 1))}
                    className="px-3 py-1 rounded border border-slate-300 disabled:opacity-40 cursor-pointer"
                  >
                    قبلی
                  </button>
                  <button
                    type="button"
                    disabled={logsPage >= logsData.pagination.totalPages}
                    onClick={() => setLogsPage((p) => p + 1)}
                    className="px-3 py-1 rounded border border-slate-300 disabled:opacity-40 cursor-pointer"
                  >
                    بعدی
                  </button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}

      {/* Modals */}
      <ConvertInvoiceModal
        order={convertOrder}
        onClose={() => setConvertOrder(null)}
        onDone={(_, msg) => {
          onNotify(msg);
          onDataChanged();
          fetchOrders();
        }}
      />
      <WarehouseExitModal
        order={exitOrder}
        onClose={() => setExitOrder(null)}
        onDone={(_, msg) => {
          onNotify(msg);
          onDataChanged();
          fetchOrders();
        }}
      />
      <DriverDeliveryModal
        order={deliveryOrder}
        onClose={() => setDeliveryOrder(null)}
        onDone={(_, msg) => {
          onNotify(msg);
          onDataChanged();
          fetchOrders();
        }}
      />
      <ReturnOrderModal
        order={returnState?.order ?? null}
        target={returnState?.target ?? null}
        onClose={() => setReturnState(null)}
        onDone={(_, msg) => {
          onNotify(msg);
          onDataChanged();
          fetchOrders();
        }}
      />
      <ReviseOrderModal
        order={reviseOrder}
        onClose={() => setReviseOrder(null)}
        onDone={(_, msg) => {
          onNotify(msg);
          onDataChanged();
          fetchOrders();
        }}
      />
      <OrderDocumentModal
        order={docModalState?.order ?? null}
        initialMode={docModalState?.mode ?? 'docs'}
        onClose={() => setDocModalState(null)}
      />
    </div>
  );
}
