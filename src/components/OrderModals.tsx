import React, { useEffect, useRef, useState } from 'react';
import { Download, FileText, Printer, Trash2, Upload, X, AlertTriangle } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { OrderDocumentRecord, OrderRecord, TOP_BRANDS } from '../shared/types';
import {
  computeCartonDiscrepancy,
  formatAmountToman,
  formatPersianDateTime,
  normalizeDigits,
} from '../shared/workflow';

// ==================== Convert Invoice Modal (Stage 4 Accounting) ====================
interface ConvertInvoiceModalProps {
  order: OrderRecord | null;
  onClose: () => void;
  onDone: (updated: OrderRecord, message: string) => void;
}

export function ConvertInvoiceModal({ order, onClose, onDone }: ConvertInvoiceModalProps) {
  const [finalInvoiceNo, setFinalInvoiceNo] = useState('');
  const [amount, setAmount] = useState('');
  const [items, setItems] = useState('');
  const [accountingNote, setAccountingNote] = useState('');
  const [uploadedFile, setUploadedFile] = useState<{ fileId: string; originalName: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!order) return;
    setFinalInvoiceNo(order.finalInvoiceNo || '');
    setAmount(order.amountToman ? String(order.amountToman) : '');
    setItems(order.items || '');
    setAccountingNote(order.accountingNote || '');
    setUploadedFile(null);
    setError(null);
  }, [order]);

  if (!order) return null;

  const isWarehouseReturn = order.status === 'returned_to_accounting';

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > 5 * 1024 * 1024) {
      setError('حجم فایل بیشتر از ۵ مگابایت است. فایل‌های قبلی بدون تغییر حفظ شدند.');
      e.target.value = '';
      return;
    }
    setUploading(true);
    try {
      const res = await api.uploadFile(file, 'order_doc');
      setUploadedFile({ fileId: res.fileId, originalName: res.originalName });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در بارگذاری فایل.');
      e.target.value = '';
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!order || uploading) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.convertInvoice(order.id, {
        expectedVersion: order.version,
        finalInvoiceNo: finalInvoiceNo.trim(),
        amountToman: amount.trim(),
        items: items.trim(),
        accountingNote: accountingNote.trim(),
        fileId: uploadedFile?.fileId || null,
      });
      onDone(
        res.order,
        isWarehouseReturn
          ? `اصلاحیه فاکتور ${res.order.finalInvoiceNo} ثبت و به انبار ارسال شد.`
          : `فاکتور نهایی ${res.order.finalInvoiceNo} صادر و به انبار ارسال شد.`,
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در ثبت فاکتور نهایی.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 no-print" role="dialog" aria-modal="true" aria-labelledby="convert-inv-title">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200">
          <h3 id="convert-inv-title" className="text-sm font-extrabold text-slate-900">
            {isWarehouseReturn ? 'اصلاح فاکتور فروش (مغایرت انبار) و ارسال مجدد' : 'تبدیل پیش‌فاکتور به فاکتور فروش نهایی'}
          </h3>
          <button type="button" onClick={onClose} aria-label="بستن" className="p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        {isWarehouseReturn && (
          <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
            <div className="font-bold">علت مغایرت انبار: {order.returnReason}</div>
            {order.returnNote && <div className="mt-1">{order.returnNote}</div>}
          </div>
        )}

        <p className="text-xs text-slate-600 mb-4">
          مشتری: <strong className="text-slate-900">{order.customer}</strong> · پیش‌فاکتور:{' '}
          <span className="font-mono-code font-semibold">{order.proforma}</span>
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="conv-inv-no" className="block text-xs font-bold text-slate-800 mb-1">
                شماره فاکتور فروش نهایی *
              </label>
              <input
                id="conv-inv-no"
                type="text"
                dir="ltr"
                required
                value={finalInvoiceNo}
                onChange={(e) => setFinalInvoiceNo(e.target.value)}
                placeholder="INV-1405-8821"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
              />
            </div>
            <div>
              <label htmlFor="conv-inv-amt" className="block text-xs font-bold text-slate-800 mb-1">
                مبلغ نهایی فاکتور (تومان) *
              </label>
              <input
                id="conv-inv-amt"
                type="text"
                dir="ltr"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                placeholder="75000000"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
              />
            </div>
          </div>

          <div>
            <label htmlFor="conv-inv-items" className="block text-xs font-bold text-slate-800 mb-1">
              شرح اقلام فاکتور (قابل ویرایش در صورت اصلاح مغایرت)
            </label>
            <textarea
              id="conv-inv-items"
              rows={2}
              value={items}
              onChange={(e) => setItems(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div>
            <label htmlFor="conv-inv-note" className="block text-xs font-bold text-slate-800 mb-1">
              یادداشت واحد مالی (اختیاری)
            </label>
            <input
              id="conv-inv-note"
              type="text"
              value={accountingNote}
              onChange={(e) => setAccountingNote(e.target.value)}
              placeholder="مثلاً: مانده حساب بررسی و تایید شد"
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="p-3.5 rounded-lg border border-dashed border-emerald-300 bg-emerald-50/50">
            <label htmlFor="conv-inv-file" className="block text-xs font-bold text-emerald-900 mb-1.5">
              بارگذاری فایل فاکتور فروش نهایی (PDF یا تصویر، حداکثر ۵ مگابایت)
            </label>
            <input
              id="conv-inv-file"
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              onChange={handleFileChange}
              className="w-full text-xs text-slate-700"
            />
            <p className="text-[11px] text-emerald-800 mt-1.5">
              {uploading
                ? 'در حال بررسی امنیتی و ذخیره فایل روی سرور...'
                : uploadedFile
                  ? `فایل جدید ضمیمه شد: ${uploadedFile.originalName} (فایل پیش‌فاکتور قبلی نیز در تاریخچه حفظ می‌شود)`
                  : 'نسخه اصلی پیش‌فاکتور در تاریخچه اسناد حفظ شده و فایل فاکتور نهایی به‌عنوان نسخه جدید اضافه می‌شود.'}
            </p>
          </div>

          {error && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-semibold text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting || uploading}
            className="w-full py-2.5 px-4 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-sm font-bold cursor-pointer"
          >
            {submitting
              ? 'در حال ثبت روی سرور...'
              : isWarehouseReturn
                ? 'ثبت اصلاحیه فاکتور و ارسال مجدد به انبار'
                : 'صدور فاکتور نهایی و ارسال به انبار'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ==================== Warehouse Exit Modal (Stage 5) ====================
interface WarehouseExitModalProps {
  order: OrderRecord | null;
  onClose: () => void;
  onDone: (updated: OrderRecord, message: string) => void;
}

export function WarehouseExitModal({ order, onClose, onDone }: WarehouseExitModalProps) {
  const [cartonsOut, setCartonsOut] = useState('');
  const [exitTime, setExitTime] = useState('');
  const [driverName, setDriverName] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!order) return;
    setCartonsOut(order.cartonsOut ? String(order.cartonsOut) : '');
    const nowTime = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    setExitTime(order.exitTime || nowTime);
    setDriverName(order.driverName || '');
    setError(null);
  }, [order]);

  if (!order) return null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!order) return;
    setError(null);
    const cartonsNum = Number(normalizeDigits(cartonsOut));
    if (!Number.isInteger(cartonsNum) || cartonsNum < 1 || !driverName.trim()) {
      setError('لطفاً تعداد کارتن معتبر (حداقل ۱) و نام راننده را وارد کنید.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await api.warehouseExit(order.id, {
        expectedVersion: order.version,
        cartonsOut: cartonsNum,
        exitTime: exitTime.trim(),
        driverName: driverName.trim(),
      });
      onDone(res.order, `خروج بار (${cartonsNum} کارتن) ثبت و به کارتابل راننده ارسال شد.`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در ثبت خروج بار.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 no-print" role="dialog" aria-modal="true" aria-labelledby="wh-exit-title">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md p-6">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200">
          <h3 id="wh-exit-title" className="text-sm font-extrabold text-slate-900">
            ثبت جمع‌آوری کالا، تعداد کارتن و ساعت خروج
          </h3>
          <button type="button" onClick={onClose} aria-label="بستن" className="p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-600 mb-4">
          مشتری: <strong className="text-slate-900">{order.customer}</strong> · فاکتور:{' '}
          <span className="font-mono-code font-semibold">{order.finalInvoiceNo || order.proforma}</span>
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="wh-cartons" className="block text-xs font-bold text-slate-800 mb-1">
                تعداد کارتن خروجی *
              </label>
              <input
                id="wh-cartons"
                type="number"
                min={1}
                required
                dir="ltr"
                value={cartonsOut}
                onChange={(e) => setCartonsOut(e.target.value)}
                placeholder="8"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
              />
            </div>
            <div>
              <label htmlFor="wh-time" className="block text-xs font-bold text-slate-800 mb-1">
                ساعت خروج *
              </label>
              <input
                id="wh-time"
                type="text"
                dir="ltr"
                required
                value={exitTime}
                onChange={(e) => setExitTime(e.target.value)}
                placeholder="14:30"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
              />
            </div>
          </div>

          <div>
            <label htmlFor="wh-driver" className="block text-xs font-bold text-slate-800 mb-1">
              نام راننده / خودرو حمل *
            </label>
            <input
              id="wh-driver"
              type="text"
              required
              value={driverName}
              onChange={(e) => setDriverName(e.target.value)}
              placeholder="مثلاً: نیسان توزیع ۲"
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
            className="w-full py-2.5 px-4 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-sm font-bold cursor-pointer"
          >
            {submitting ? 'در حال ثبت...' : 'تایید خروج از انبار و ارسال به راننده'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ==================== Driver Delivery Modal (Stage 6 + Signature Pad + Carton Discrepancy) ====================
interface DriverDeliveryModalProps {
  order: OrderRecord | null;
  onClose: () => void;
  onDone: (updated: OrderRecord, message: string) => void;
}

export function DriverDeliveryModal({ order, onClose, onDone }: DriverDeliveryModalProps) {
  const [cartonsDelivered, setCartonsDelivered] = useState('');
  const [signer, setSigner] = useState('');
  const [discrepancyNote, setDiscrepancyNote] = useState('');
  const [hasStroke, setHasStroke] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const drawingRef = useRef(false);

  useEffect(() => {
    if (!order) return;
    setCartonsDelivered(order.cartonsOut ? String(order.cartonsOut) : '');
    setSigner('');
    setDiscrepancyNote('');
    setHasStroke(false);
    setError(null);

    const timer = setTimeout(() => {
      const canvas = canvasRef.current;
      if (!canvas) return;
      const rect = canvas.getBoundingClientRect();
      const ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = Math.max(300, Math.round(rect.width)) * ratio;
      canvas.height = 170 * ratio;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.scale(ratio, ratio);
        ctx.lineWidth = 2.4;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.strokeStyle = '#0f172a';
      }
    }, 30);
    return () => clearTimeout(timer);
  }, [order]);

  if (!order) return null;

  const parsedDelivered = Number(normalizeDigits(cartonsDelivered));
  const discrepancyInfo =
    Number.isInteger(parsedDelivered) && parsedDelivered > 0
      ? computeCartonDiscrepancy(order.cartonsOut, parsedDelivered)
      : { discrepancy: 0, hasDiscrepancy: false };

  function getPoint(e: React.PointerEvent<HTMLCanvasElement>) {
    const rect = e.currentTarget.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function handlePointerDown(e: React.PointerEvent<HTMLCanvasElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    drawingRef.current = true;
    const p = getPoint(e);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
  }

  function handlePointerMove(e: React.PointerEvent<HTMLCanvasElement>) {
    if (!drawingRef.current) return;
    const ctx = canvasRef.current?.getContext('2d');
    if (!ctx) return;
    const p = getPoint(e);
    ctx.lineTo(p.x, p.y);
    ctx.stroke();
    setHasStroke(true);
  }

  function handlePointerUp() {
    if (!drawingRef.current) return;
    drawingRef.current = false;
    canvasRef.current?.getContext('2d')?.closePath();
  }

  function clearSignature() {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    setHasStroke(false);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!order || !canvasRef.current) return;
    setError(null);

    if (!Number.isInteger(parsedDelivered) || parsedDelivered < 1 || !signer.trim()) {
      setError('لطفاً تعداد کارتن تحویلی و نام تحویل‌گیرنده را وارد کنید.');
      return;
    }
    if (discrepancyInfo.hasDiscrepancy && !discrepancyNote.trim()) {
      setError('به علت مغایرت تعداد کارتن با خروجی انبار، ثبت توضیح مغایرت الزامی است.');
      return;
    }
    if (!hasStroke) {
      setError('دریافت امضای دیجیتال مشتری در کادر امضا الزامی است.');
      return;
    }

    const signaturePngBase64 = canvasRef.current.toDataURL('image/png');
    setSubmitting(true);
    try {
      const res = await api.driverDelivery(order.id, {
        expectedVersion: order.version,
        cartonsDelivered: parsedDelivered,
        customerSigner: signer.trim(),
        discrepancyNote: discrepancyNote.trim(),
        signaturePngBase64,
      });
      onDone(
        res.order,
        discrepancyInfo.hasDiscrepancy
          ? `تحویل با ثبت مغایرت کارتن (${parsedDelivered} از ${order.cartonsOut}) نهایی شد.`
          : `تحویل قطعی (${parsedDelivered} کارتن) با امضای «${signer.trim()}» ثبت شد.`,
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در ثبت تحویل نهایی.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 no-print" role="dialog" aria-modal="true" aria-labelledby="driver-del-title">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200">
          <h3 id="driver-del-title" className="text-sm font-extrabold text-slate-900">
            ثبت تحویل نهایی و امضای دیجیتال مشتری
          </h3>
          <button type="button" onClick={onClose} aria-label="بستن" className="p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <p className="text-xs text-slate-600 mb-4">
          مشتری: <strong className="text-slate-900">{order.customer}</strong> · فاکتور:{' '}
          <span className="font-mono-code font-semibold">{order.finalInvoiceNo || order.proforma}</span> · خروجی انبار:{' '}
          <strong className="tabular-nums text-slate-900">{order.cartonsOut ?? '—'} کارتن</strong>
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="del-cartons" className="block text-xs font-bold text-slate-800 mb-1">
                تعداد کارتن تحویلی *
              </label>
              <input
                id="del-cartons"
                type="number"
                min={1}
                required
                dir="ltr"
                value={cartonsDelivered}
                onChange={(e) => setCartonsDelivered(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
              />
            </div>
            <div>
              <label htmlFor="del-signer" className="block text-xs font-bold text-slate-800 mb-1">
                نام تحویل‌گیرنده در فروشگاه *
              </label>
              <input
                id="del-signer"
                type="text"
                required
                value={signer}
                onChange={(e) => setSigner(e.target.value)}
                placeholder="مثلاً: مسئول انبار فروشگاه"
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          {discrepancyInfo.hasDiscrepancy && (
            <div className="p-3.5 rounded-lg bg-amber-50 border border-amber-300 space-y-2">
              <div className="flex items-center gap-2 text-xs font-bold text-amber-900">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-700" />
                <span>
                  هشدار مغایرت تعداد کارتن: خروجی انبار {order.cartonsOut} کارتن بوده ولی تحویلی {parsedDelivered} کارتن ثبت شده است (اختلاف:{' '}
                  {discrepancyInfo.discrepancy > 0 ? `+${discrepancyInfo.discrepancy}` : discrepancyInfo.discrepancy}).
                </span>
              </div>
              <div>
                <label htmlFor="del-disc-note" className="block text-xs font-bold text-amber-900 mb-1">
                  توضیح علت مغایرت کارتن (الزامی) *
                </label>
                <input
                  id="del-disc-note"
                  type="text"
                  required
                  value={discrepancyNote}
                  onChange={(e) => setDiscrepancyNote(e.target.value)}
                  placeholder="مثلاً: ۱ کارتن آسیب دیده بود و عودت داده شد"
                  className="w-full px-3 py-2 text-xs border border-amber-300 rounded-lg bg-white"
                />
              </div>
            </div>
          )}

          <div>
            <div className="flex items-center justify-between mb-1.5">
              <label className="text-xs font-bold text-slate-800">
                کادر امضای دیجیتال مشتری (با ماوس یا انگشت امضا کنید) *
              </label>
              <button
                type="button"
                onClick={clearSignature}
                className="inline-flex items-center gap-1 text-xs font-semibold text-red-700 hover:text-red-800 cursor-pointer"
              >
                <Trash2 className="w-3.5 h-3.5" />
                پاک کردن امضا
              </button>
            </div>
            <div className="border-2 border-dashed border-slate-300 rounded-lg bg-white overflow-hidden touch-none">
              <canvas
                ref={canvasRef}
                data-testid="driver-signature-canvas"
                onPointerDown={handlePointerDown}
                onPointerMove={handlePointerMove}
                onPointerUp={handlePointerUp}
                onPointerCancel={handlePointerUp}
                className="w-full h-[170px] block cursor-crosshair touch-none"
              />
            </div>
          </div>

          {error && (
            <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-semibold text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 px-4 rounded-lg bg-emerald-700 hover:bg-emerald-800 disabled:opacity-50 text-white text-sm font-bold cursor-pointer"
          >
            {submitting ? 'در حال ثبت تحویل و ذخیره امن امضا...' : 'ثبت قطعی تحویل بار و امضای مشتری'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ==================== Return Order Modal (with Auto Phase-3 Shortage Option) ====================
interface ReturnOrderModalProps {
  order: OrderRecord | null;
  target: 'sales' | 'sales_mgr' | 'customer_reject' | 'accounting' | null;
  onClose: () => void;
  onDone: (updated: OrderRecord, message: string) => void;
}

const RETURN_REASON_OPTIONS: Record<string, string[]> = {
  accounting: [
    'کسری موجودی قطعه در انبار',
    'مغایرت تعداد یا اقلام فاکتور با موجودی انبار',
    'مغایرت کد فنی / برند درخواستی',
    'آسیب‌دیدگی کالا یا نیاز به اصلاح فاکتور فروش',
  ],
  sales_mgr: [
    'مغایرت پیش‌فاکتور کارتابل با نرم‌افزار حسابداری',
    'مغایرت قیمت یا تخفیف ثبت‌شده در نرم‌افزار',
    'مغایرت شرایط تسویه یا سقف اعتبار مشتری',
  ],
  customer_reject: [
    'عدم تایید مشتری - درخواست تغییر اقلام یا تعداد',
    'عدم تایید مشتری - درخواست اصلاح قیمت یا تخفیف',
    'عدم تایید مشتری - تغییر شرایط تسویه',
  ],
  sales: [
    'اصلاح تخفیف یا قیمت فروش',
    'اصلاح شرایط تسویه یا اعتبار مشتری',
    'اصلاح اقلام یا کد فنی قطعات',
    'نقص اطلاعات یا فایل پیش‌فاکتور',
  ],
};

export function ReturnOrderModal({ order, target, onClose, onDone }: ReturnOrderModalProps) {
  const [reason, setReason] = useState('');
  const [note, setNote] = useState('');
  const [createShortage, setCreateShortage] = useState(false);
  const [shortageBrand, setShortageBrand] = useState(TOP_BRANDS[0]);
  const [shortagePart, setShortagePart] = useState('');
  const [shortageQty, setShortageQty] = useState('10');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!order || !target) return;
    const opts = RETURN_REASON_OPTIONS[target] || [];
    setReason(opts[0] || '');
    setNote('');
    setCreateShortage(target === 'accounting');
    setShortageBrand(TOP_BRANDS[0]);
    setShortagePart('');
    setShortageQty('10');
    setError(null);
  }, [order, target]);

  if (!order || !target) return null;

  const options = RETURN_REASON_OPTIONS[target] || [];
  const titles: Record<string, string> = {
    accounting: 'گزارش مغایرت انبار و برگشت به مالی',
    sales_mgr: 'مغایرت نرم‌افزار و عودت به مدیر فروش',
    customer_reject: 'ثبت عدم تایید مشتری و برگشت به مرحله اول',
    sales: 'برگشت پیش‌فاکتور به کارشناس فروش',
  };

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!order || !target) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.returnOrder(order.id, {
        expectedVersion: order.version,
        target,
        reason,
        note: note.trim(),
        createShortageTicket: target === 'accounting' && createShortage,
        shortageBrand,
        shortagePart: shortagePart.trim(),
        shortageQty: Number(normalizeDigits(shortageQty)) || 1,
      });
      onDone(
        res.order,
        target === 'accounting' && createShortage
          ? 'مغایرت ثبت شد و درخواست کسری به‌طور خودکار به صف تامین (فاز ۳) ارسال گردید.'
          : `سفارش «${order.finalInvoiceNo || order.proforma}» با موفقیت برگشت داده شد.`,
      );
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در ثبت برگشت.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 no-print" role="dialog" aria-modal="true" aria-labelledby="ret-order-title">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-md max-h-[92vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200">
          <h3 id="ret-order-title" className="text-sm font-extrabold text-red-700">
            {titles[target]}
          </h3>
          <button type="button" onClick={onClose} aria-label="بستن" className="p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="ret-reason" className="block text-xs font-bold text-slate-800 mb-1">
              علت برگشت / مغایرت *
            </label>
            <select
              id="ret-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
            >
              {options.map((opt) => (
                <option key={opt} value={opt}>
                  {opt}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="ret-note" className="block text-xs font-bold text-slate-800 mb-1">
              توضیحات تکمیلی
            </label>
            <textarea
              id="ret-note"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="جزئیات مغایرت یا اصلاح موردنیاز..."
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          {target === 'accounting' && (
            <div className="p-3.5 rounded-lg bg-slate-50 border border-slate-200 space-y-3">
              <label className="flex items-center gap-2 text-xs font-bold text-slate-900 cursor-pointer">
                <input
                  type="checkbox"
                  checked={createShortage}
                  onChange={(e) => setCreateShortage(e.target.checked)}
                  className="rounded border-slate-300"
                />
                ثبت خودکار کسری در ماژول تامین ۵۰ برند (فاز ۳)
              </label>

              {createShortage && (
                <div className="space-y-2.5 pt-2 border-t border-slate-200">
                  <div>
                    <label htmlFor="sh-brand" className="block text-[11px] font-bold text-slate-700 mb-1">
                      برند قطعه
                    </label>
                    <select
                      id="sh-brand"
                      value={shortageBrand}
                      onChange={(e) => setShortageBrand(e.target.value)}
                      className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md bg-white"
                    >
                      {TOP_BRANDS.map((b) => (
                        <option key={b} value={b}>
                          {b}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    <div className="col-span-2">
                      <label htmlFor="sh-part" className="block text-[11px] font-bold text-slate-700 mb-1">
                        نام قطعه کسری
                      </label>
                      <input
                        id="sh-part"
                        type="text"
                        value={shortagePart}
                        onChange={(e) => setShortagePart(e.target.value)}
                        placeholder="مثلاً: لنت جلو پراید"
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md"
                      />
                    </div>
                    <div>
                      <label htmlFor="sh-qty" className="block text-[11px] font-bold text-slate-700 mb-1">
                        تعداد
                      </label>
                      <input
                        id="sh-qty"
                        type="number"
                        min={1}
                        dir="ltr"
                        value={shortageQty}
                        onChange={(e) => setShortageQty(e.target.value)}
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-300 rounded-md font-mono-code"
                      />
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}

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
            {submitting ? 'در حال ثبت...' : 'ثبت برگشت سفارش'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ==================== Revise Returned Proforma Modal ====================
interface ReviseOrderModalProps {
  order: OrderRecord | null;
  onClose: () => void;
  onDone: (updated: OrderRecord, message: string) => void;
}

export function ReviseOrderModal({ order, onClose, onDone }: ReviseOrderModalProps) {
  const [proforma, setProforma] = useState('');
  const [amount, setAmount] = useState('');
  const [items, setItems] = useState('');
  const [uploadedFile, setUploadedFile] = useState<{ fileId: string; originalName: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!order) return;
    setProforma(order.proforma);
    setAmount(order.amountToman ? String(order.amountToman) : '');
    setItems(order.items);
    setUploadedFile(null);
    setError(null);
  }, [order]);

  if (!order) return null;

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    if (file.size > 5 * 1024 * 1024) {
      setError('حجم فایل بیشتر از ۵ مگابایت است. فایل‌های قبلی حفظ شدند.');
      e.target.value = '';
      return;
    }
    setUploading(true);
    try {
      const res = await api.uploadFile(file, 'order_doc');
      setUploadedFile({ fileId: res.fileId, originalName: res.originalName });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در بارگذاری فایل.');
      e.target.value = '';
    } finally {
      setUploading(false);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!order || uploading) return;
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.reviseOrder(order.id, {
        expectedVersion: order.version,
        proforma: proforma.trim(),
        amountToman: amount.trim(),
        items: items.trim(),
        fileId: uploadedFile?.fileId || null,
      });
      onDone(res.order, `اصلاحیه #${res.order.rev} پیش‌فاکتور ثبت و مجدداً به مدیر فروش ارسال شد.`);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در ثبت اصلاحیه.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 no-print" role="dialog" aria-modal="true" aria-labelledby="rev-order-title">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-lg max-h-[92vh] overflow-y-auto p-6">
        <div className="flex items-center justify-between pb-3 mb-4 border-b border-slate-200">
          <h3 id="rev-order-title" className="text-sm font-extrabold text-slate-900">
            اصلاح پیش‌فاکتور و ارسال مجدد به مدیر فروش
          </h3>
          <button type="button" onClick={onClose} aria-label="بستن" className="p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="mb-4 p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-800">
          <div className="font-bold">علت برگشت: {order.returnReason}</div>
          {order.returnNote && <div className="mt-1">{order.returnNote}</div>}
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label htmlFor="rev-pf" className="block text-xs font-bold text-slate-800 mb-1">
                شماره پیش‌فاکتور *
              </label>
              <input
                id="rev-pf"
                type="text"
                dir="ltr"
                required
                value={proforma}
                onChange={(e) => setProforma(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
              />
            </div>
            <div>
              <label htmlFor="rev-amt" className="block text-xs font-bold text-slate-800 mb-1">
                مبلغ اصلاح‌شده (تومان) *
              </label>
              <input
                id="rev-amt"
                type="text"
                dir="ltr"
                required
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg font-mono-code"
              />
            </div>
          </div>

          <div>
            <label htmlFor="rev-items" className="block text-xs font-bold text-slate-800 mb-1">
              شرح اقلام اصلاح‌شده *
            </label>
            <textarea
              id="rev-items"
              rows={2}
              required
              value={items}
              onChange={(e) => setItems(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <div className="p-3.5 rounded-lg border border-dashed border-blue-300 bg-blue-50/40">
            <label htmlFor="rev-file" className="block text-xs font-bold text-blue-900 mb-1.5">
              پیوست نسخه اصلاحی پیش‌فاکتور (PDF یا تصویر - نسخه‌های قبلی حفظ می‌شوند)
            </label>
            <input
              id="rev-file"
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              onChange={handleFileChange}
              className="w-full text-xs text-slate-700"
            />
            {uploadedFile && (
              <p className="text-[11px] text-blue-800 mt-1.5 flex items-center gap-1">
                <Upload className="w-3.5 h-3.5" /> فایل آماده ثبت: {uploadedFile.originalName}
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
            className="w-full py-2.5 px-4 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-sm font-bold cursor-pointer"
          >
            {submitting ? 'در حال ثبت...' : 'ثبت اصلاحیه و ارسال مجدد به مدیر فروش'}
          </button>
        </form>
      </div>
    </div>
  );
}

// ==================== Order Document History & Clean Multi-Page Print Modal ====================
interface OrderDocumentModalProps {
  order: OrderRecord | null;
  initialMode: 'docs' | 'print';
  onClose: () => void;
}

export function OrderDocumentModal({ order, initialMode, onClose }: OrderDocumentModalProps) {
  const [selectedDoc, setSelectedDoc] = useState<OrderDocumentRecord | null>(null);
  const [viewMode, setViewMode] = useState<'sheet' | 'file'>('sheet');
  const [blobState, setBlobState] = useState<{ url: string; mimeType: string } | null>(null);
  const [loadingFile, setLoadingFile] = useState(false);

  useEffect(() => {
    if (!order) return;
    const latestDoc = order.documents.length > 0 ? order.documents[order.documents.length - 1] : null;
    setSelectedDoc(latestDoc);
    setViewMode(initialMode === 'print' || !latestDoc ? 'sheet' : 'file');
  }, [order, initialMode]);

  useEffect(() => {
    if (!selectedDoc || viewMode !== 'file') {
      setBlobState((prev) => {
        if (prev) URL.revokeObjectURL(prev.url);
        return null;
      });
      return;
    }

    let active = true;
    let createdUrl: string | null = null;
    setLoadingFile(true);
    api
      .fetchFileBlobUrl(selectedDoc.fileId)
      .then((res) => {
        if (!active) {
          URL.revokeObjectURL(res.blobUrl);
          return;
        }
        createdUrl = res.blobUrl;
        setBlobState({ url: res.blobUrl, mimeType: res.mimeType });
      })
      .catch(() => {
        if (active) setBlobState(null);
      })
      .finally(() => {
        if (active) setLoadingFile(false);
      });

    return () => {
      active = false;
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [selectedDoc, viewMode]);

  if (!order) return null;

  function handlePrintSlip() {
    setViewMode('sheet');
    setTimeout(() => window.print(), 120);
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-labelledby="doc-modal-title">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-3xl max-h-[92vh] flex flex-col overflow-hidden print-only-sheet">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-4 border-b border-slate-200 no-print">
          <div>
            <h3 id="doc-modal-title" className="text-sm font-extrabold text-slate-900">
              اسناد و برگه چاپی سفارش {order.finalInvoiceNo || order.proforma}
            </h3>
            <p className="text-xs text-slate-500">
              تاریخچه کامل پیش‌فاکتورها و فاکتورهای نهایی بدون بازنویسی حفظ شده است.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setViewMode('sheet')}
              className={`px-3 py-1.5 rounded-lg text-xs font-bold cursor-pointer ${
                viewMode === 'sheet' ? 'bg-slate-900 text-white' : 'border border-slate-300 text-slate-700 hover:bg-slate-50'
              }`}
            >
              برگه استاندارد انبار
            </button>
            <button
              type="button"
              onClick={handlePrintSlip}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-blue-700 hover:bg-blue-800 text-white text-xs font-bold cursor-pointer"
            >
              <Printer className="w-3.5 h-3.5" />
              پرینت برگه انبار
            </button>
            <button type="button" onClick={onClose} aria-label="بستن" className="p-1.5 rounded-lg hover:bg-slate-100 cursor-pointer">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Versioned Document Selector */}
        {order.documents.length > 0 && (
          <div className="px-5 py-2.5 bg-slate-50 border-b border-slate-200 flex flex-wrap items-center gap-2 no-print">
            <span className="text-xs font-bold text-slate-600">نسخه‌های فایل پیوست:</span>
            {order.documents.map((doc) => {
              const active = viewMode === 'file' && selectedDoc?.id === doc.id;
              return (
                <button
                  key={doc.id}
                  type="button"
                  onClick={() => {
                    setSelectedDoc(doc);
                    setViewMode('file');
                  }}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-semibold cursor-pointer ${
                    active
                      ? 'bg-blue-700 text-white'
                      : 'bg-white border border-slate-300 text-slate-700 hover:border-slate-400'
                  }`}
                >
                  <FileText className="w-3.5 h-3.5" />
                  {doc.docKind === 'final_invoice' ? `فاکتور نهایی v${doc.versionNo}` : `پیش‌فاکتور v${doc.versionNo}`}
                </button>
              );
            })}
            {selectedDoc && (
              <button
                type="button"
                onClick={() => api.downloadFile(selectedDoc.fileId, selectedDoc.originalName)}
                className="mr-auto inline-flex items-center gap-1 px-2.5 py-1 rounded-md border border-slate-300 bg-white text-xs font-bold text-slate-800 hover:bg-slate-100 cursor-pointer"
              >
                <Download className="w-3.5 h-3.5" />
                دانلود فایل
              </button>
            )}
          </div>
        )}

        <div className="overflow-y-auto p-5 flex-1">
          {viewMode === 'file' && selectedDoc ? (
            <div className="space-y-3 no-print">
              <div className="text-xs text-slate-600 flex flex-wrap items-center justify-between gap-2">
                <span>
                  فایل: <strong className="text-slate-900">{selectedDoc.originalName}</strong> · بارگذاری توسط{' '}
                  {selectedDoc.uploadedBy}
                </span>
                <span className="tabular-nums">{formatPersianDateTime(selectedDoc.createdAt)}</span>
              </div>
              {loadingFile ? (
                <div className="h-[55vh] flex items-center justify-center bg-slate-50 rounded-lg border border-slate-200 text-xs text-slate-500">
                  در حال بارگذاری امن فایل از سرور...
                </div>
              ) : blobState ? (
                blobState.mimeType.startsWith('image/') ? (
                  <div className="bg-slate-50 border border-slate-200 rounded-lg p-3 text-center">
                    <img
                      src={blobState.url}
                      alt={selectedDoc.originalName}
                      className="max-w-full max-h-[60vh] mx-auto rounded"
                    />
                  </div>
                ) : (
                  <object
                    data={blobState.url}
                    type="application/pdf"
                    className="w-full h-[60vh] rounded-lg border border-slate-200 bg-slate-50"
                  >
                    <div className="p-6 text-center text-xs text-slate-600">
                      مرورگر شما نمایش مستقیم PDF را پشتیبانی نمی‌کند. برای مشاهده از دکمه «دانلود فایل» استفاده کنید.
                    </div>
                  </object>
                )
              ) : (
                <div className="p-6 text-center text-xs text-red-700 bg-red-50 rounded-lg border border-red-200">
                  امکان نمایش فایل وجود ندارد.
                </div>
              )}
            </div>
          ) : (
            <div className="border-2 border-slate-900 rounded-xl p-6 bg-white space-y-5">
              <div className="flex flex-wrap items-start justify-between gap-4 pb-4 border-b-2 border-slate-900 print-page-section">
                <div>
                  <h4 className="text-base font-extrabold text-slate-900">
                    {order.finalInvoiceNo ? 'فاکتور فروش نهایی و حواله خروج انبار' : 'برگه پیش‌فاکتور فروش'}
                  </h4>
                  <p className="text-xs text-slate-600 mt-1">پخش قطعات یدکی خودرو (ایران‌خودرو و سایپا — ۵۰ برند)</p>
                </div>
                <div className="text-xs space-y-1 text-left">
                  <div>
                    شماره پیش‌فاکتور: <strong className="font-mono-code">{order.proforma}</strong>
                  </div>
                  {order.finalInvoiceNo && (
                    <div className="text-emerald-800 font-bold">
                      شماره فاکتور فروش: <strong className="font-mono-code">{order.finalInvoiceNo}</strong>
                    </div>
                  )}
                  <div>کارشناس فروش: {order.salesOwnerName}</div>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3 bg-slate-50 p-4 rounded-lg border border-slate-200 text-xs print-page-section">
                <div>
                  <span className="text-slate-500">مشتری: </span>
                  <strong className="text-slate-900">{order.customer}</strong>
                </div>
                <div>
                  <span className="text-slate-500">کانال سفارش: </span>
                  <strong className="text-slate-900">{order.channel || '—'}</strong>
                </div>
                {order.amountToman !== null && (
                  <div>
                    <span className="text-slate-500">مبلغ کل: </span>
                    <strong className="text-slate-900 tabular-nums">{formatAmountToman(order.amountToman)} تومان</strong>
                  </div>
                )}
                {order.payment && (
                  <div>
                    <span className="text-slate-500">شرایط تسویه: </span>
                    <strong className="text-slate-900">{order.payment}</strong>
                  </div>
                )}
              </div>

              <div className="border border-slate-300 rounded-lg p-4 text-xs print-page-section">
                <div className="font-bold text-slate-900 mb-2">شرح اقلام جهت جمع‌آوری و بسته‌بندی در انبار:</div>
                <p className="text-slate-800 leading-relaxed whitespace-pre-wrap">{order.items}</p>
              </div>

              {order.accountingNote && (
                <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs text-emerald-900 print-page-section">
                  <strong>یادداشت واحد مالی:</strong> {order.accountingNote}
                </div>
              )}

              <div className="print-page-section">
                <div className="text-xs font-bold text-slate-800 mb-2">تاریخچه مراحل و تاییدیه‌ها (با تاریخ و ساعت دقیق):</div>
                <table className="w-full text-xs border border-slate-200">
                  <thead className="bg-slate-50 border-b border-slate-200">
                    <tr>
                      <th className="py-2 px-3 text-right font-bold">اقدام</th>
                      <th className="py-2 px-3 text-right font-bold">ثبت‌کننده</th>
                      <th className="py-2 px-3 text-right font-bold">تاریخ و ساعت</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {order.stageHistory.map((h, i) => (
                      <tr key={i}>
                        <td className="py-1.5 px-3">{h.action}</td>
                        <td className="py-1.5 px-3 text-slate-600">{h.actorName}</td>
                        <td className="py-1.5 px-3 tabular-nums text-slate-600">{formatPersianDateTime(h.timestamp)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
