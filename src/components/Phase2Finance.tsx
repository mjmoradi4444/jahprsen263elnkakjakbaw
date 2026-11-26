import React, { useCallback, useEffect, useState } from 'react';
import { AlertCircle, CalendarClock, CheckCircle2, Plus, Upload } from 'lucide-react';
import { api, ApiError, ChecksListResponse } from '../api/client';
import { CheckAttachmentRecord, CheckRecord, UserAccountPublic } from '../shared/types';
import {
  canRoleReviseCheck,
  formatAmountToman,
  formatPersianDate,
  formatPersianDateTime,
  getDueDateUrgency,
} from '../shared/workflow';
import { AuthenticatedImage } from './AuthenticatedMedia';
import { CheckImageModal, CheckRejectModal, CheckReviseModal } from './CheckModals';

interface Phase2FinanceProps {
  user: UserAccountPublic;
  roles: UserAccountPublic[];
  refreshTrigger: number;
  onNotify: (message: string, isError?: boolean) => void;
  onDataChanged: () => void;
}

export function Phase2Finance({ user, roles, refreshTrigger, onNotify, onDataChanged }: Phase2FinanceProps) {
  const [filter, setFilter] = useState<string>(
    user.id === 'ceo' || user.id === 'accounting' ? 'pending_me' : 'all',
  );
  const [ownerFilter, setOwnerFilter] = useState<string>('all');
  const [sortBy, setSortBy] = useState<'updated' | 'due_date'>('due_date');
  const [showUploadForm, setShowUploadForm] = useState(false);

  const [data, setData] = useState<ChecksListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  // Create form state
  const [docType, setDocType] = useState<'چک دریافتی' | 'واریزی'>('چک دریافتی');
  const [customer, setCustomer] = useState('');
  const [amount, setAmount] = useState('');
  const [sayadiId, setSayadiId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [trackingNo, setTrackingNo] = useState('');
  const [caption, setCaption] = useState('');
  const [uploadedFiles, setUploadedFiles] = useState<Array<{ fileId: string; originalName: string }>>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  // Modals
  const [viewImageState, setViewImageState] = useState<{
    check: CheckRecord;
    attachment: CheckAttachmentRecord;
  } | null>(null);
  const [rejectCheck, setRejectCheck] = useState<CheckRecord | null>(null);
  const [reviseCheck, setReviseCheck] = useState<CheckRecord | null>(null);

  const fetchChecks = useCallback(async () => {
    setError(null);
    try {
      const res = await api.getChecks({ filter, owner: ownerFilter, sort: sortBy });
      setData(res);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در دریافت اطلاعات مالی.');
    } finally {
      setLoading(false);
    }
  }, [filter, ownerFilter, sortBy]);

  useEffect(() => {
    fetchChecks();
  }, [fetchChecks, refreshTrigger]);

  const canUpload = user.isSales || user.id === 'accounting';
  const uploaderRoles = roles.filter((r) => r.isSales || r.id === 'accounting');

  async function handleFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []).slice(0, 4);
    if (files.length === 0) return;
    setFormError(null);
    setUploading(true);
    const saved: Array<{ fileId: string; originalName: string }> = [];
    try {
      for (const f of files) {
        if (f.size > 5 * 1024 * 1024) {
          throw new Error(`فایل «${f.name}» بزرگ‌تر از ۵ مگابایت است.`);
        }
        const res = await api.uploadFile(f, 'check_attachment');
        saved.push({ fileId: res.fileId, originalName: res.originalName });
      }
      setUploadedFiles(saved);
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'خطا در بارگذاری تصاویر.');
      e.target.value = '';
    } finally {
      setUploading(false);
    }
  }

  async function handleCreateCheck(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || uploading) return;
    setFormError(null);
    setSubmitting(true);
    try {
      const res = await api.createCheck({
        docType,
        customer: customer.trim(),
        amountToman: amount.trim(),
        sayadiId: sayadiId.trim(),
        dueDate: dueDate.trim(),
        trackingNo: trackingNo.trim(),
        caption: caption.trim(),
        fileIds: uploadedFiles.map((f) => f.fileId),
      });
      setCustomer('');
      setAmount('');
      setSayadiId('');
      setDueDate('');
      setTrackingNo('');
      setCaption('');
      setUploadedFiles([]);
      setShowUploadForm(false);
      onNotify(`${res.check.docType} برای «${res.check.customer}» ثبت و جهت تایید دوگانه ارسال شد.`);
      onDataChanged();
      await fetchChecks();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'خطا در ثبت مدرک مالی.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleApprove(check: CheckRecord) {
    setBusyId(check.id);
    try {
      const res = await api.approveCheck(check.id);
      onNotify(
        res.check.status === 'finalized'
          ? `${check.docType} «${check.customer}» با تایید دوگانه نهایی شد.`
          : `تایید شما برای «${check.customer}» ثبت شد (در انتظار تایید دوم).`,
      );
      onDataChanged();
      await fetchChecks();
    } catch (err) {
      onNotify(err instanceof ApiError ? err.message : 'خطا در ثبت تایید.', true);
    } finally {
      setBusyId(null);
    }
  }

  const summary = data?.summary;

  return (
    <div className="space-y-6">
      {/* KPI Totals Strip */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">در انتظار تایید دوگانه</div>
          <div className="text-2xl font-extrabold text-amber-700 mt-1 tabular-nums">{summary?.pendingCount ?? 0}</div>
          <div className="text-[11px] text-slate-500 mt-1">مالی + مدیرعامل (هم‌زمانی ایمن)</div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">صندوق چک‌ها (نهایی)</div>
          <div className="text-2xl font-extrabold text-emerald-700 mt-1 tabular-nums">
            {summary?.safeChecksCount ?? 0}
          </div>
          <div className="text-[11px] text-slate-600 font-semibold mt-1 tabular-nums">
            جمع: {formatAmountToman(summary?.safeChecksAmountToman ?? 0)} تومان
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">واریزی‌های ثبت‌شده</div>
          <div className="text-2xl font-extrabold text-blue-700 mt-1 tabular-nums">
            {summary?.approvedDepositsCount ?? 0}
          </div>
          <div className="text-[11px] text-slate-600 font-semibold mt-1 tabular-nums">
            جمع: {formatAmountToman(summary?.approvedDepositsAmountToman ?? 0)} تومان
          </div>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl p-4">
          <div className="text-xs font-medium text-slate-500">برگشتی جهت اصلاح</div>
          <div className="text-2xl font-extrabold text-red-700 mt-1 tabular-nums">{summary?.returnedCount ?? 0}</div>
          <div className="text-[11px] text-slate-500 mt-1">قابل اصلاح توسط ثبت‌کننده اصلی</div>
        </div>
      </div>

      {/* Uploader Breakdown Table (includes Sales 1..4 AND Accounting!) */}
      {data && data.uploaderBreakdown.length > 0 && (
        <section className="bg-white border border-slate-200 rounded-xl overflow-hidden">
          <div className="px-5 py-3.5 border-b border-slate-200 flex items-center justify-between">
            <h2 className="text-sm font-extrabold text-slate-900">خلاصه اسناد مالی به تفکیک ثبت‌کننده (شامل حسابداری)</h2>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-xs text-right">
              <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                <tr>
                  <th className="py-2.5 px-4 font-bold">ثبت‌کننده</th>
                  <th className="py-2.5 px-4 font-bold">در انتظار تایید</th>
                  <th className="py-2.5 px-4 font-bold">چک در صندوق</th>
                  <th className="py-2.5 px-4 font-bold">واریزی ثبت‌شده</th>
                  <th className="py-2.5 px-4 font-bold">برگشتی</th>
                  <th className="py-2.5 px-4 font-bold">جمع کل نهایی‌شده (تومان)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.uploaderBreakdown.map((u) => (
                  <tr key={u.roleId} className="hover:bg-slate-50/70">
                    <td className="py-2.5 px-4 font-bold text-slate-900">{u.displayName}</td>
                    <td className="py-2.5 px-4 tabular-nums text-amber-700 font-semibold">{u.pending}</td>
                    <td className="py-2.5 px-4 tabular-nums text-emerald-700 font-semibold">{u.safeChecks}</td>
                    <td className="py-2.5 px-4 tabular-nums text-blue-700 font-semibold">{u.approvedDeposits}</td>
                    <td className="py-2.5 px-4 tabular-nums text-red-700 font-semibold">{u.returned}</td>
                    <td className="py-2.5 px-4 tabular-nums font-bold text-slate-900">
                      {formatAmountToman(u.finalizedAmountToman)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Upload Toolbar + Collapsible Form */}
      {canUpload && (
        <div className="bg-white border border-slate-200 rounded-xl p-5">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-extrabold text-slate-900">ثبت چک دریافتی (با صیادی و سررسید) یا فیش واریزی</h2>
              <p className="text-xs text-slate-500 mt-0.5">
                تایید هم‌زمان واحد مالی و مدیرعامل به‌صورت اتمی در سرور ثبت می‌شود و هیچ تاییدی از بین نمی‌رود.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowUploadForm((s) => !s)}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              {showUploadForm ? 'بستن فرم ثبت' : 'ثبت مدرک تسویه جدید'}
            </button>
          </div>

          {showUploadForm && (
            <form onSubmit={handleCreateCheck} className="mt-5 pt-5 border-t border-slate-200 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
                <div>
                  <label htmlFor="chk-type" className="block text-xs font-bold text-slate-800 mb-1">
                    نوع مدرک *
                  </label>
                  <select
                    id="chk-type"
                    value={docType}
                    onChange={(e) => setDocType(e.target.value as 'چک دریافتی' | 'واریزی')}
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
                  >
                    <option value="چک دریافتی">چک دریافتی (صندوق چک‌ها)</option>
                    <option value="واریزی">فیش واریزی بانکی</option>
                  </select>
                </div>
                <div>
                  <label htmlFor="chk-customer" className="block text-xs font-bold text-slate-800 mb-1">
                    نام مشتری / صاحب حساب *
                  </label>
                  <input
                    id="chk-customer"
                    type="text"
                    required
                    value={customer}
                    onChange={(e) => setCustomer(e.target.value)}
                    placeholder="مثلاً: فروشگاه یدک پارس"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                  />
                </div>
                <div>
                  <label htmlFor="chk-amount" className="block text-xs font-bold text-slate-800 mb-1">
                    مبلغ (تومان — عددی) *
                  </label>
                  <input
                    id="chk-amount"
                    type="text"
                    dir="ltr"
                    required
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    placeholder="45000000"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
                  />
                </div>
              </div>

              {docType === 'چک دریافتی' ? (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label htmlFor="chk-sayadi" className="block text-xs font-bold text-slate-800 mb-1">
                      شناسه صیادی ۱۶ رقمی *
                    </label>
                    <input
                      id="chk-sayadi"
                      type="text"
                      dir="ltr"
                      required
                      maxLength={19}
                      value={sayadiId}
                      onChange={(e) => setSayadiId(e.target.value)}
                      placeholder="1234567890123456"
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
                    />
                  </div>
                  <div>
                    <label htmlFor="chk-due" className="block text-xs font-bold text-slate-800 mb-1">
                      تاریخ سررسید چک (برای مرتب‌سازی و هشدار صندوق) *
                    </label>
                    <input
                      id="chk-due"
                      type="date"
                      dir="ltr"
                      required
                      value={dueDate}
                      onChange={(e) => setDueDate(e.target.value)}
                      className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
                    />
                  </div>
                </div>
              ) : (
                <div>
                  <label htmlFor="chk-track" className="block text-xs font-bold text-slate-800 mb-1">
                    شماره پیگیری بانکی *
                  </label>
                  <input
                    id="chk-track"
                    type="text"
                    dir="ltr"
                    required
                    value={trackingNo}
                    onChange={(e) => setTrackingNo(e.target.value)}
                    placeholder="REF-12345678"
                    className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
                  />
                </div>
              )}

              <div>
                <label htmlFor="chk-caption" className="block text-xs font-bold text-slate-800 mb-1">
                  شرح و توضیحات (بابت کدام فاکتور / حساب) *
                </label>
                <textarea
                  id="chk-caption"
                  rows={2}
                  required
                  value={caption}
                  onChange={(e) => setCaption(e.target.value)}
                  placeholder="مثلاً: چک صیادی بانک ملت بابت تسویه فاکتور آبان‌ماه"
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
                />
              </div>

              <div className="p-3.5 rounded-lg border border-dashed border-amber-300 bg-amber-50/40">
                <label htmlFor="chk-files" className="block text-xs font-bold text-amber-900 mb-1.5">
                  تصویر چک یا فیش واریزی (PNG/JPEG/WebP، تا ۴ تصویر، اختیاری در ثبت سریع)
                </label>
                <input
                  id="chk-files"
                  type="file"
                  accept="image/png,image/jpeg,image/webp"
                  multiple
                  onChange={handleFilesChange}
                  className="w-full text-xs text-slate-700"
                />
                {uploading && <p className="text-[11px] text-amber-800 mt-1">در حال بارگذاری امن تصاویر...</p>}
                {uploadedFiles.length > 0 && (
                  <p className="text-[11px] text-emerald-700 font-semibold mt-1">
                    {uploadedFiles.length} تصویر با موفقیت روی سرور ذخیره شد.
                  </p>
                )}
              </div>

              {formError && (
                <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-semibold text-red-700">
                  {formError}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || uploading}
                className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-xs font-bold cursor-pointer"
              >
                <Upload className="w-4 h-4" />
                {submitting ? 'در حال ثبت...' : 'ارسال مدرک جهت تایید واحد مالی و مدیرعامل'}
              </button>
            </form>
          )}
        </div>
      )}

      {/* Filter & Sort Controls */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1.5">
          {[
            { id: 'all', label: 'همه مدارک' },
            { id: 'pending_me', label: 'منتظر اقدام من' },
            { id: 'safe_checks', label: 'صندوق چک‌ها' },
            { id: 'approved_deposits', label: 'واریزی‌های تاییدشده' },
            { id: 'returned', label: 'برگشتی‌ها' },
          ].map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold whitespace-nowrap cursor-pointer ${
                filter === f.id
                  ? 'bg-slate-900 text-white'
                  : 'bg-white border border-slate-200 text-slate-600 hover:text-slate-900'
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {!user.isSales && (
            <select
              aria-label="فیلتر ثبت‌کننده مدرک مالی"
              value={ownerFilter}
              onChange={(e) => setOwnerFilter(e.target.value)}
              className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
            >
              <option value="all">همه ثبت‌کنندگان (فروش + حسابداری)</option>
              {uploaderRoles.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.displayName}
                </option>
              ))}
            </select>
          )}
          <select
            aria-label="ترتیب نمایش چک‌ها"
            value={sortBy}
            onChange={(e) => setSortBy(e.target.value as 'updated' | 'due_date')}
            className="px-3 py-1.5 text-xs bg-white border border-slate-300 rounded-lg"
          >
            <option value="due_date">مرتب‌سازی بر اساس تاریخ سررسید</option>
            <option value="updated">جدیدترین به‌روزرسانی</option>
          </select>
        </div>
      </div>

      {error && (
        <div role="alert" className="p-4 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 font-semibold">
          {error}
        </div>
      )}

      {/* Checks List */}
      {loading ? (
        <div className="space-y-3">
          {[1, 2].map((k) => (
            <div key={k} className="bg-white border border-slate-200 rounded-xl p-5 h-32 animate-pulse" />
          ))}
        </div>
      ) : !data || data.items.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-10 text-center text-xs text-slate-500">
          مدرکی در این فیلتر یافت نشد.
        </div>
      ) : (
        <div className="space-y-4">
          {data.items.map((item) => {
            const isCheck = item.docType === 'چک دریافتی';
            const urgency = isCheck ? getDueDateUrgency(item.dueDate) : { urgency: 'none' as const, label: '', daysDiff: null };
            const canRevise = canRoleReviseCheck(user.id, item);
            const canFinAct = item.status === 'pending' && user.id === 'accounting' && item.financeStatus === 'pending';
            const canCeoAct = item.status === 'pending' && user.id === 'ceo' && item.ceoStatus === 'pending';
            const isBusy = busyId === item.id;

            return (
              <article
                key={item.id}
                className={`bg-white border rounded-xl p-5 space-y-4 ${
                  item.status === 'returned'
                    ? 'border-red-300'
                    : item.status === 'finalized'
                      ? 'border-emerald-200'
                      : canFinAct || canCeoAct
                        ? 'border-amber-400'
                        : 'border-slate-200'
                }`}
              >
                <div className="flex flex-wrap items-start justify-between gap-4">
                  <div className="space-y-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-500">
                      <span className="font-bold text-slate-900">{item.docType}</span>
                      <span aria-hidden="true">·</span>
                      <span>{item.salesOwnerName}</span>
                      <span aria-hidden="true">·</span>
                      <span className="tabular-nums">{formatPersianDateTime(item.createdAt)}</span>
                      {item.sayadiId && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-slate-700">
                            صیادی: <span dir="ltr" className="font-mono-code">{item.sayadiId}</span>
                          </span>
                        </>
                      )}
                      {item.trackingNo && (
                        <>
                          <span aria-hidden="true">·</span>
                          <span className="text-slate-700">
                            پیگیری: <span dir="ltr" className="font-mono-code">{item.trackingNo}</span>
                          </span>
                        </>
                      )}
                    </div>
                    <h3 className="text-base font-extrabold text-slate-900">{item.customer}</h3>
                    <p className="text-xs text-slate-600">{item.caption}</p>
                  </div>

                  <div className="text-left shrink-0 space-y-1">
                    <div className="text-base font-extrabold text-emerald-700 tabular-nums">
                      {formatAmountToman(item.amountToman)} <span className="text-xs font-medium text-slate-500">تومان</span>
                    </div>
                    {isCheck && item.dueDate && (
                      <div
                        className={`inline-flex items-center gap-1 text-xs font-bold tabular-nums ${
                          urgency.urgency === 'overdue'
                            ? 'text-red-700'
                            : urgency.urgency === 'soon'
                              ? 'text-amber-700'
                              : 'text-slate-600'
                        }`}
                      >
                        <CalendarClock className="w-3.5 h-3.5" />
                        سررسید: {formatPersianDate(item.dueDate)}
                        {urgency.label ? ` (${urgency.label})` : ''}
                      </div>
                    )}
                  </div>
                </div>

                {/* Authenticated Thumbnails */}
                {item.attachments.length > 0 && (
                  <div className="flex flex-wrap gap-2.5">
                    {item.attachments.map((att, idx) => (
                      <button
                        key={att.id}
                        type="button"
                        onClick={() => setViewImageState({ check: item, attachment: att })}
                        aria-label={`بزرگ‌نمایی تصویر ${idx + 1} برای ${item.customer}`}
                        className="w-20 h-20 rounded-lg border border-slate-200 overflow-hidden bg-slate-50 hover:border-blue-500 transition-colors cursor-pointer"
                      >
                        <AuthenticatedImage
                          fileId={att.fileId}
                          alt={att.originalName}
                          className="w-full h-full object-cover"
                        />
                      </button>
                    ))}
                  </div>
                )}

                {item.status === 'returned' && (
                  <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-900 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 text-red-700 shrink-0 mt-0.5" />
                    <div>
                      <strong>عدم تایید توسط {item.rejectedBy}:</strong> {item.rejectReason}
                    </div>
                  </div>
                )}

                {/* Dual Approval Grid */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-2 border-t border-slate-100 text-xs">
                  <div
                    className={`p-3 rounded-lg border ${
                      item.financeStatus === 'approved'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                        : item.financeStatus === 'rejected'
                          ? 'bg-red-50 border-red-200 text-red-900'
                          : 'bg-slate-50 border-slate-200 text-slate-700'
                    }`}
                  >
                    <div className="font-bold">تایید واحد حسابداری و مالی</div>
                    <div className="mt-0.5 tabular-nums">
                      {item.financeStatus === 'approved'
                        ? `تایید شده (${formatPersianDateTime(item.financeTime)})`
                        : item.financeStatus === 'rejected'
                          ? `رد شده (${formatPersianDateTime(item.financeTime)})`
                          : 'در انتظار بررسی واحد مالی'}
                    </div>
                  </div>
                  <div
                    className={`p-3 rounded-lg border ${
                      item.ceoStatus === 'approved'
                        ? 'bg-emerald-50 border-emerald-200 text-emerald-900'
                        : item.ceoStatus === 'rejected'
                          ? 'bg-red-50 border-red-200 text-red-900'
                          : 'bg-slate-50 border-slate-200 text-slate-700'
                    }`}
                  >
                    <div className="font-bold">تایید مدیرعامل</div>
                    <div className="mt-0.5 tabular-nums">
                      {item.ceoStatus === 'approved'
                        ? `تایید شده (${formatPersianDateTime(item.ceoTime)})`
                        : item.ceoStatus === 'rejected'
                          ? `رد شده (${formatPersianDateTime(item.ceoTime)})`
                          : 'در انتظار تایید مدیرعامل'}
                    </div>
                  </div>
                </div>

                {/* Action Footer */}
                <div className="pt-3 border-t border-slate-200 flex flex-wrap items-center gap-2">
                  {item.status === 'finalized' ? (
                    <div className="inline-flex items-center gap-1.5 text-xs font-bold text-emerald-700">
                      <CheckCircle2 className="w-4 h-4" />
                      {isCheck
                        ? `تایید دوگانه کامل شد — موجود در صندوق چک‌ها (${formatPersianDateTime(item.finalizedTime)})`
                        : `تایید دوگانه کامل شد — ثبت‌شده در حسابداری (${formatPersianDateTime(item.finalizedTime)})`}
                    </div>
                  ) : item.status === 'returned' ? (
                    canRevise ? (
                      <button
                        type="button"
                        onClick={() => setReviseCheck(item)}
                        className="px-4 py-2 rounded-lg bg-amber-600 hover:bg-amber-700 text-white text-xs font-bold cursor-pointer"
                      >
                        اصلاح مدرک و ارسال مجدد به مالی و مدیریت
                      </button>
                    ) : (
                      <span className="text-xs text-red-700">
                        برگشت خورده به {item.salesOwnerName} جهت اصلاح و ارسال مجدد
                      </span>
                    )
                  ) : (
                    <>
                      {canFinAct && (
                        <>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleApprove(item)}
                            className="px-4 py-2 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-xs font-bold cursor-pointer"
                          >
                            تایید واحد مالی
                          </button>
                          <button
                            type="button"
                            onClick={() => setRejectCheck(item)}
                            className="px-4 py-2 rounded-lg border border-red-300 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold cursor-pointer"
                          >
                            رد و برگشت به ثبت‌کننده
                          </button>
                        </>
                      )}
                      {canCeoAct && (
                        <>
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleApprove(item)}
                            className="px-4 py-2 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-xs font-bold cursor-pointer"
                          >
                            تایید مدیرعامل
                          </button>
                          <button
                            type="button"
                            onClick={() => setRejectCheck(item)}
                            className="px-4 py-2 rounded-lg border border-red-300 bg-red-50 hover:bg-red-100 text-red-700 text-xs font-bold cursor-pointer"
                          >
                            رد و برگشت به ثبت‌کننده
                          </button>
                        </>
                      )}
                      {!canFinAct && !canCeoAct && (
                        <span className="text-xs text-slate-500">در انتظار تکمیل تایید دوگانه مالی و مدیرعامل</span>
                      )}
                    </>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}

      <CheckImageModal
        check={viewImageState?.check ?? null}
        attachment={viewImageState?.attachment ?? null}
        onClose={() => setViewImageState(null)}
      />
      <CheckRejectModal
        check={rejectCheck}
        onClose={() => setRejectCheck(null)}
        onDone={(_, msg) => {
          onNotify(msg);
          onDataChanged();
          fetchChecks();
        }}
      />
      <CheckReviseModal
        check={reviseCheck}
        onClose={() => setReviseCheck(null)}
        onDone={(_, msg) => {
          onNotify(msg);
          onDataChanged();
          fetchChecks();
        }}
      />
    </div>
  );
}
