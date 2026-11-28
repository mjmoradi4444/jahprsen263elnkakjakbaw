import React, { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, FileSearch, Loader2, Upload } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { DuplicateInvoiceInfo, InvoiceFieldKey, OrderRecord } from '../shared/types';

interface NewOrderFormProps {
  onCreated: (order: OrderRecord) => void;
}

type ExtractState = 'idle' | 'uploading' | 'reading' | 'done' | 'manual';

const faNumber = new Intl.NumberFormat('fa-IR');

function toLatinDigits(s: string): string {
  return s
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)));
}

/**
 * New proforma form. Flow: the rep uploads the invoice PDF first; the server reads it and the
 * fields are pre-filled. Every field stays editable; anything that failed a cross-check is
 * highlighted. Duplicate proforma numbers are detected immediately and block submission.
 */
export function NewOrderForm({ onCreated }: NewOrderFormProps) {
  const [customer, setCustomer] = useState('');
  const [proforma, setProforma] = useState('');
  const [channel, setChannel] = useState('تلفنی');
  const [amount, setAmount] = useState('');
  const [payment, setPayment] = useState('نقدی / واریز آنی');
  const [items, setItems] = useState('');

  const [uploadedFile, setUploadedFile] = useState<{ fileId: string; originalName: string } | null>(null);
  const [extractState, setExtractState] = useState<ExtractState>('idle');
  const [extractMessage, setExtractMessage] = useState<string | null>(null);
  const [invoiceDate, setInvoiceDate] = useState<string | null>(null);
  const [customerCode, setCustomerCode] = useState<string | null>(null);
  const [autoFilled, setAutoFilled] = useState<Set<InvoiceFieldKey>>(new Set());
  const [warnings, setWarnings] = useState<Partial<Record<InvoiceFieldKey, string>>>({});

  const [duplicate, setDuplicate] = useState<DuplicateInvoiceInfo | null>(null);
  const [checkingDuplicate, setCheckingDuplicate] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const dupRequestRef = useRef(0);

  // Debounced duplicate check whenever the proforma number changes (typed or auto-filled).
  useEffect(() => {
    const num = toLatinDigits(proforma).trim();
    if (!num) {
      setDuplicate(null);
      setCheckingDuplicate(false);
      return;
    }
    const requestId = ++dupRequestRef.current;
    setCheckingDuplicate(true);
    const timer = setTimeout(async () => {
      try {
        const res = await api.checkProforma(num);
        if (dupRequestRef.current === requestId) setDuplicate(res.duplicate);
      } catch {
        // The server re-checks on submit, so a failed pre-check is not fatal.
        if (dupRequestRef.current === requestId) setDuplicate(null);
      } finally {
        if (dupRequestRef.current === requestId) setCheckingDuplicate(false);
      }
    }, 450);
    return () => clearTimeout(timer);
  }, [proforma]);

  function clearFieldFlag(field: InvoiceFieldKey) {
    setWarnings((w) => {
      if (!w[field]) return w;
      const next = { ...w };
      delete next[field];
      return next;
    });
    setAutoFilled((s) => {
      if (!s.has(field)) return s;
      const next = new Set(s);
      next.delete(field);
      return next;
    });
  }

  function resetForm() {
    setCustomer('');
    setProforma('');
    setAmount('');
    setItems('');
    setUploadedFile(null);
    setExtractState('idle');
    setExtractMessage(null);
    setInvoiceDate(null);
    setCustomerCode(null);
    setAutoFilled(new Set());
    setWarnings({});
    setDuplicate(null);
    if (fileInputRef.current) fileInputRef.current.value = '';
  }

  async function handleFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    setError(null);
    setExtractMessage(null);
    if (!file) {
      setUploadedFile(null);
      setExtractState('idle');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      setError('حجم فایل بیشتر از ۵ مگابایت است. لطفاً فایل کم‌حجم‌تری انتخاب کنید.');
      e.target.value = '';
      return;
    }

    setExtractState('uploading');
    let uploaded: { fileId: string; originalName: string; mimeType: string };
    try {
      const res = await api.uploadFile(file, 'order_doc');
      uploaded = { fileId: res.fileId, originalName: res.originalName, mimeType: res.mimeType };
      setUploadedFile({ fileId: res.fileId, originalName: res.originalName });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در بارگذاری فایل.');
      setExtractState('idle');
      e.target.value = '';
      return;
    }

    if (uploaded.mimeType !== 'application/pdf') {
      setExtractState('manual');
      setExtractMessage('فایل تصویری بارگذاری شد. خواندن خودکار فقط برای PDF فاکتور انجام می‌شود؛ لطفاً فیلدها را دستی پر کنید.');
      return;
    }

    setExtractState('reading');
    try {
      const res = await api.extractInvoice(uploaded.fileId);
      const r = res.result;
      if (!r.ok) {
        setExtractState('manual');
        setExtractMessage(r.error || 'اطلاعات فاکتور خوانده نشد؛ لطفاً دستی وارد کنید.');
        return;
      }

      const filled = new Set<InvoiceFieldKey>();
      if (r.invoiceNumber) {
        setProforma(r.invoiceNumber);
        filled.add('proforma');
      }
      if (r.amountToman) {
        setAmount(String(r.amountToman));
        filled.add('amountToman');
      }
      if (r.itemsText) {
        setItems(r.itemsText);
        filled.add('items');
      }
      const nextWarnings: Partial<Record<InvoiceFieldKey, string>> = { ...(r.warnings || {}) };
      if (res.customerName) {
        setCustomer(res.customerName);
        filled.add('customer');
      } else if (r.buyerCode) {
        nextWarnings.customer = `مشتری با کد ${r.buyerCode} قبلاً ثبت نشده؛ نام مشتری را یک بار وارد کنید تا دفعات بعد خودکار پر شود.`;
      }
      setCustomerCode(r.buyerCode || null);
      setInvoiceDate(r.invoiceDate || null);
      setAutoFilled(filled);
      setWarnings(nextWarnings);
      if (res.duplicate) setDuplicate(res.duplicate);
      setExtractState('done');
      setExtractMessage(
        Object.keys(nextWarnings).length > 0
          ? 'اطلاعات از روی فاکتور خوانده شد. موارد زردرنگ را بررسی کنید.'
          : 'اطلاعات از روی فاکتور خوانده شد. لطفاً پیش از ثبت یک بار مرور کنید.',
      );
    } catch (err) {
      setExtractState('manual');
      setExtractMessage(
        err instanceof ApiError ? err.message : 'اطلاعات فاکتور خوانده نشد؛ لطفاً دستی وارد کنید.',
      );
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (submitting || extractState === 'uploading' || extractState === 'reading') return;
    if (!uploadedFile) {
      setError('ابتدا فایل پیش‌فاکتور را بارگذاری کنید.');
      return;
    }
    if (duplicate) {
      setError(duplicate.message);
      return;
    }
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.createOrder({
        customer: customer.trim(),
        proforma: toLatinDigits(proforma).trim(),
        channel,
        amountToman: toLatinDigits(amount).replace(/[,٬\s]/g, ''),
        payment,
        items: items.trim(),
        fileId: uploadedFile.fileId,
        customerCode,
      });
      resetForm();
      onCreated(res.order);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در ثبت پیش‌فاکتور.');
    } finally {
      setSubmitting(false);
    }
  }

  const busyReading = extractState === 'uploading' || extractState === 'reading';
  const fieldClass = (field: InvoiceFieldKey, extra = '') =>
    `w-full px-3.5 py-2 text-sm border rounded-lg ${extra} ${
      warnings[field]
        ? 'border-amber-400 bg-amber-50 ring-1 ring-amber-300'
        : autoFilled.has(field)
          ? 'border-emerald-300 bg-emerald-50/40'
          : 'border-slate-300'
    }`;
  const FieldHint = ({ field }: { field: InvoiceFieldKey }) =>
    warnings[field] ? (
      <p className="mt-1 text-[11px] font-semibold text-amber-800 flex items-start gap-1">
        <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
        {warnings[field]}
      </p>
    ) : autoFilled.has(field) ? (
      <p className="mt-1 text-[11px] text-emerald-700">خوانده‌شده از فاکتور (قابل ویرایش)</p>
    ) : null;

  const amountNum = Number(toLatinDigits(amount).replace(/[,٬\s]/g, ''));
  const amountPreview = Number.isFinite(amountNum) && amountNum > 0 ? faNumber.format(amountNum) : null;

  return (
    <form onSubmit={handleSubmit} className="bg-white border border-slate-200 rounded-xl p-4 sm:p-6 max-w-2xl space-y-4">
      <div>
        <h2 className="text-base font-extrabold text-slate-900">ثبت پیش‌فاکتور جدید و ارسال به مدیر فروش</h2>
        <p className="text-xs text-slate-500 mt-0.5">
          ابتدا فایل PDF پیش‌فاکتور را بارگذاری کنید؛ اطلاعات به‌صورت خودکار خوانده می‌شود و همه فیلدها قابل اصلاح هستند.
        </p>
      </div>

      {/* Step 1: invoice file */}
      <div className="p-4 rounded-lg border border-dashed border-blue-300 bg-blue-50/40">
        <label htmlFor="new-pdf-file" className="block text-xs font-bold text-blue-900 mb-1.5">
          ۱. بارگذاری فایل پیش‌فاکتور (PDF؛ حداکثر ۵ مگابایت) *
        </label>
        <input
          ref={fileInputRef}
          id="new-pdf-file"
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          onChange={handleFile}
          disabled={busyReading || submitting}
          className="w-full text-xs text-slate-700"
        />
        <div className="text-[11px] mt-2 flex items-start gap-1.5" aria-live="polite">
          {extractState === 'uploading' && (
            <>
              <Loader2 className="w-3.5 h-3.5 animate-spin text-blue-700 shrink-0" />
              <span className="text-blue-800">در حال بارگذاری و بررسی امنیتی فایل...</span>
            </>
          )}
          {extractState === 'reading' && (
            <>
              <FileSearch className="w-3.5 h-3.5 animate-pulse text-blue-700 shrink-0" />
              <span className="text-blue-800">در حال خواندن فاکتور...</span>
            </>
          )}
          {extractState === 'done' && extractMessage && (
            <>
              <CheckCircle2 className="w-3.5 h-3.5 text-emerald-700 shrink-0" />
              <span className="text-emerald-800 font-semibold">{extractMessage}</span>
            </>
          )}
          {extractState === 'manual' && extractMessage && (
            <>
              <AlertTriangle className="w-3.5 h-3.5 text-amber-700 shrink-0" />
              <span className="text-amber-800 font-semibold">{extractMessage}</span>
            </>
          )}
          {extractState === 'idle' && (
            <span className="text-blue-800">پس از بارگذاری، شماره، مبلغ و اقلام از روی فاکتور پر می‌شوند.</span>
          )}
        </div>
        {uploadedFile && !busyReading && (
          <p className="text-[11px] text-slate-600 mt-1">
            فایل: {uploadedFile.originalName}
            {invoiceDate ? ` — تاریخ فاکتور: ${invoiceDate}` : ''}
          </p>
        )}
      </div>

      <fieldset disabled={busyReading} className="space-y-4">
        <div>
          <label htmlFor="new-customer" className="block text-xs font-bold text-slate-800 mb-1">
            نام فروشگاه / مشتری *
          </label>
          <input
            id="new-customer"
            type="text"
            required
            value={customer}
            onChange={(e) => {
              setCustomer(e.target.value);
              clearFieldFlag('customer');
            }}
            placeholder="مثلاً: نمایندگی اویسی"
            className={fieldClass('customer')}
          />
          <FieldHint field="customer" />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label htmlFor="new-proforma" className="block text-xs font-bold text-slate-800 mb-1">
              شماره پیش‌فاکتور (یکتا) *
            </label>
            <input
              id="new-proforma"
              type="text"
              inputMode="numeric"
              dir="ltr"
              required
              value={proforma}
              onChange={(e) => {
                setProforma(e.target.value);
                clearFieldFlag('proforma');
              }}
              placeholder="7191"
              aria-invalid={Boolean(duplicate)}
              aria-describedby="proforma-dup"
              className={fieldClass('proforma', `font-mono-code ${duplicate ? '!border-red-500 !bg-red-50 !ring-red-300' : ''}`)}
            />
            <div id="proforma-dup" aria-live="polite">
              {duplicate ? (
                <p role="alert" className="mt-1 text-[11px] font-bold text-red-700 flex items-start gap-1">
                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
                  {duplicate.message}
                </p>
              ) : checkingDuplicate ? (
                <p className="mt-1 text-[11px] text-slate-500">در حال بررسی تکراری نبودن...</p>
              ) : (
                <FieldHint field="proforma" />
              )}
            </div>
          </div>
          <div>
            <label htmlFor="new-channel" className="block text-xs font-bold text-slate-800 mb-1">
              کانال دریافت سفارش
            </label>
            <select
              id="new-channel"
              value={channel}
              onChange={(e) => setChannel(e.target.value)}
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
              مبلغ پیش‌فاکتور (تومان) *
            </label>
            <input
              id="new-amount"
              type="text"
              inputMode="numeric"
              dir="ltr"
              required
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value);
                clearFieldFlag('amountToman');
              }}
              placeholder="41860000"
              className={fieldClass('amountToman', 'font-mono-code')}
            />
            {amountPreview && <p className="mt-1 text-[11px] text-slate-600">{amountPreview} تومان</p>}
            <FieldHint field="amountToman" />
          </div>
          <div>
            <label htmlFor="new-payment" className="block text-xs font-bold text-slate-800 mb-1">
              شرایط تسویه
            </label>
            <select
              id="new-payment"
              value={payment}
              onChange={(e) => setPayment(e.target.value)}
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
            شرح اقلام *
          </label>
          <textarea
            id="new-items"
            rows={4}
            required
            value={items}
            onChange={(e) => {
              setItems(e.target.value);
              clearFieldFlag('items');
            }}
            placeholder="مثلاً: شمع موتور تیپ 5 - تورچ × 100 عدد"
            className={fieldClass('items')}
          />
          <FieldHint field="items" />
        </div>
      </fieldset>

      {error && (
        <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-semibold text-red-700">
          {error}
        </div>
      )}

      <button
        type="submit"
        disabled={submitting || busyReading || !uploadedFile || Boolean(duplicate)}
        className="w-full py-2.5 px-4 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-bold cursor-pointer inline-flex items-center justify-center gap-2"
      >
        <Upload className="w-4 h-4" />
        {submitting
          ? 'در حال ثبت سفارش...'
          : !uploadedFile
            ? 'ابتدا فایل پیش‌فاکتور را بارگذاری کنید'
            : duplicate
              ? 'شماره پیش‌فاکتور تکراری است'
              : 'ثبت پیش‌فاکتور و ارسال به مدیر فروش'}
      </button>
    </form>
  );
}
