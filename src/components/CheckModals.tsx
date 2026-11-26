import React, { useEffect, useState } from 'react';
import { Download, X } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { CheckAttachmentRecord, CheckRecord } from '../shared/types';
import { formatAmountToman, formatPersianDate, formatPersianDateTime } from '../shared/workflow';
import { AuthenticatedImage } from './AuthenticatedMedia';

// ==================== Check Image Viewer Modal ====================
interface CheckImageModalProps {
  check: CheckRecord | null;
  attachment: CheckAttachmentRecord | null;
  onClose: () => void;
}

export function CheckImageModal({ check, attachment, onClose }: CheckImageModalProps) {
  if (!check || !attachment) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 no-print" role="dialog" aria-modal="true" aria-labelledby="chk-img-title">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl max-h-[92vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-200">
          <h3 id="chk-img-title" className="text-sm font-extrabold text-slate-900">
            {check.docType} — {check.customer}
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => api.downloadFile(attachment.fileId, attachment.originalName)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-slate-300 text-xs font-bold text-slate-800 hover:bg-slate-50 cursor-pointer"
            >
              <Download className="w-3.5 h-3.5" />
              دانلود تصویر
            </button>
            <button type="button" onClick={onClose} aria-label="بستن" className="p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="p-5 overflow-y-auto space-y-4">
          <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 text-xs space-y-1">
            <div>
              <strong>توضیحات:</strong> {check.caption}
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-slate-700 pt-1">
              <span className="font-bold text-emerald-700 tabular-nums">
                مبلغ: {formatAmountToman(check.amountToman)} تومان
              </span>
              {check.sayadiId && (
                <span className="font-mono-code">صیادی: {check.sayadiId}</span>
              )}
              {check.dueDate && (
                <span className="tabular-nums">سررسید: {formatPersianDate(check.dueDate)}</span>
              )}
              {check.trackingNo && (
                <span className="font-mono-code">شماره پیگیری: {check.trackingNo}</span>
              )}
            </div>
            <div className="text-[11px] text-slate-500">
              ثبت‌کننده: {check.salesOwnerName} · زمان ثبت: {formatPersianDateTime(check.createdAt)}
            </div>
          </div>

          <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-center">
            <AuthenticatedImage
              fileId={attachment.fileId}
              alt={attachment.originalName}
              className="max-w-full max-h-[60vh] mx-auto rounded object-contain"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

// ==================== Check Reject Modal ====================
interface CheckRejectModalProps {
  check: CheckRecord | null;
  onClose: () => void;
  onDone: (updated: CheckRecord, message: string) => void;
}

export function CheckRejectModal({ check, onClose, onDone }: CheckRejectModalProps) {
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (check) {
      setReason('');
      setError(null);
    }
  }, [check]);

  if (!check) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!check) return;
    if (!reason.trim()) {
      setError('وارد کردن علت عدم تایید الزامی است.');
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.rejectCheck(check.id, reason.trim());
      onDone(res.check, `مدرک ${check.docType} «${check.customer}» رد و به ثبت‌کننده برگشت داده شد.`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در ثبت عدم تایید.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 no-print" role="dialog" aria-modal="true" aria-labelledby="chk-rej-title">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200">
          <h3 id="chk-rej-title" className="text-sm font-extrabold text-red-700">
            رد مدرک تسویه و برگشت به ثبت‌کننده
          </h3>
          <button type="button" onClick={onClose} aria-label="بستن" className="p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-600 mb-4">
          {check.docType} · مشتری: <strong className="text-slate-900">{check.customer}</strong> (
          <span className="tabular-nums">{formatAmountToman(check.amountToman)} تومان</span>)
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="chk-rej-reason" className="block text-xs font-bold text-slate-800 mb-1">
              علت عدم تایید (جهت اصلاح توسط {check.salesOwnerName}) *
            </label>
            <textarea
              id="chk-rej-reason"
              rows={3}
              required
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="مثلاً: تصویر چک ناخواناست / شماره صیادی ثبت نشده / مبلغ مغایرت دارد..."
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
            className="w-full py-2.5 px-4 rounded-lg bg-red-600 hover:bg-red-700 disabled:opacity-50 text-white text-sm font-bold cursor-pointer"
          >
            {submitting ? 'در حال ثبت...' : 'ثبت عدم تایید و برگشت'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ==================== Check Revise Modal (Sales OR Accounting original uploader!) ====================
interface CheckReviseModalProps {
  check: CheckRecord | null;
  onClose: () => void;
  onDone: (updated: CheckRecord, message: string) => void;
}

export function CheckReviseModal({ check, onClose, onDone }: CheckReviseModalProps) {
  const [customer, setCustomer] = useState('');
  const [amount, setAmount] = useState('');
  const [sayadiId, setSayadiId] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [trackingNo, setTrackingNo] = useState('');
  const [caption, setCaption] = useState('');
  const [uploadedFileIds, setUploadedFileIds] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!check) return;
    setCustomer(check.customer);
    setAmount(String(check.amountToman));
    setSayadiId(check.sayadiId || '');
    setDueDate(check.dueDate || '');
    setTrackingNo(check.trackingNo || '');
    setCaption(check.caption);
    setUploadedFileIds([]);
    setError(null);
  }, [check]);

  if (!check) return null;

  async function handleFilesChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []).slice(0, 4);
    if (files.length === 0) return;
    setError(null);
    setUploading(true);
    const ids: string[] = [];
    try {
      for (const f of files) {
        const res = await api.uploadFile(f, 'check_attachment');
        ids.push(res.fileId);
      }
      setUploadedFileIds(ids);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در بارگذاری تصویر.');
      e.target.value = '';
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!check || uploading) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.reviseCheck(check.id, {
        customer: customer.trim(),
        amountToman: amount.trim(),
        sayadiId: sayadiId.trim(),
        dueDate: dueDate.trim(),
        trackingNo: trackingNo.trim(),
        caption: caption.trim(),
        fileIds: uploadedFileIds,
      });
      onDone(res.check, `مدرک ${check.docType} «${customer.trim()}» اصلاح و مجدداً برای تایید ارسال شد.`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در ثبت اصلاحیه.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 no-print" role="dialog" aria-modal="true" aria-labelledby="chk-rev-title">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200">
          <h3 id="chk-rev-title" className="text-sm font-extrabold text-slate-900">
            اصلاح و ارسال مجدد مدرک تسویه ({check.docType})
          </h3>
          <button type="button" onClick={onClose} aria-label="بستن" className="p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          <div className="font-bold">علت برگشت ({check.rejectedBy}):</div>
          <div className="mt-1">{check.rejectReason}</div>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="rev-chk-cust" className="block text-xs font-bold text-slate-800 mb-1">
                نام مشتری *
              </label>
              <input
                id="rev-chk-cust"
                type="text"
                required
                value={customer}
                onChange={(e) => setCustomer(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label htmlFor="rev-chk-amt" className="block text-xs font-bold text-slate-800 mb-1">
                مبلغ (تومان) *
              </label>
              <input
                id="rev-chk-amt"
                type="text"
                dir="ltr"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
              />
            </div>
          </div>

          {check.docType === 'چک دریافتی' ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label htmlFor="rev-chk-sayadi" className="block text-xs font-bold text-slate-800 mb-1">
                  شماره صیادی (۱۶ رقم) *
                </label>
                <input
                  id="rev-chk-sayadi"
                  type="text"
                  dir="ltr"
                  required
                  value={sayadiId}
                  onChange={(e) => setSayadiId(e.target.value)}
                  className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
                />
              </div>
              <div>
                <label htmlFor="rev-chk-due" className="block text-xs font-bold text-slate-800 mb-1">
                  تاریخ سررسید *
                </label>
                <input
                  id="rev-chk-due"
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
              <label htmlFor="rev-chk-track" className="block text-xs font-bold text-slate-800 mb-1">
                شماره پیگیری واریز *
              </label>
              <input
                id="rev-chk-track"
                type="text"
                dir="ltr"
                required
                value={trackingNo}
                onChange={(e) => setTrackingNo(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
              />
            </div>
          )}

          <div>
            <label htmlFor="rev-chk-cap" className="block text-xs font-bold text-slate-800 mb-1">
              کپشن و توضیحات اصلاح‌شده *
            </label>
            <textarea
              id="rev-chk-cap"
              rows={2}
              required
              value={caption}
              onChange={(e) => setCaption(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="p-3.5 rounded-lg border border-dashed border-amber-300 bg-amber-50/40">
            <label htmlFor="rev-chk-files" className="block text-xs font-bold text-amber-900 mb-1.5">
              بارگذاری تصویر جدید (اختیاری - تصاویر قبلی حفظ می‌شوند)
            </label>
            <input
              id="rev-chk-files"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              onChange={handleFilesChange}
              className="w-full text-xs text-slate-700"
            />
            {uploading && <p className="text-[11px] text-amber-800 mt-1">در حال بارگذاری امن تصاویر...</p>}
            {uploadedFileIds.length > 0 && (
              <p className="text-[11px] text-emerald-700 font-semibold mt-1">
                {uploadedFileIds.length} تصویر جدید آماده ثبت است.
              </p>
            )}
          </div>

          {error && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-semibold text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || uploading}
            className="w-full py-2.5 px-4 rounded-lg bg-amber-600 hover:bg-amber-700 disabled:opacity-50 text-white text-sm font-bold cursor-pointer"
          >
            {submitting ? 'در حال ثبت...' : 'ثبت اصلاحیه و ارسال مجدد به مالی و مدیریت'}
          </button>
        </form>
      </div>
    </div>
  );
}
