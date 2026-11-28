import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ArchiveRestore, DatabaseBackup, Download, Loader2, RotateCcw, ShieldCheck } from 'lucide-react';
import { adminApi, ApiError } from '../api/client';
import { StoredBackupInfoDto } from '../shared/types';

/**
 * CEO-only backups tab. App.tsx renders it only for the CEO, and every endpoint it calls lives
 * under /api/admin, which the server rejects with 403 for any other role.
 */

interface CeoBackupsProps {
  onNotify: (message: string, isError?: boolean) => void;
}

const fa = new Intl.NumberFormat('fa-IR');
const faDateTime = new Intl.DateTimeFormat('fa-IR', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${fa.format(Math.max(1, Math.round(n / 1024)))} کیلوبایت`;
  return `${fa.format(Math.round((n / 1024 / 1024) * 10) / 10)} مگابایت`;
}

export function CeoBackups({ onNotify }: CeoBackupsProps) {
  const [backups, setBackups] = useState<StoredBackupInfoDto[]>([]);
  const [downloadingBackup, setDownloadingBackup] = useState<string | null>(null);

  const [restoreFile, setRestoreFile] = useState<File | null>(null);
  const [restorePin, setRestorePin] = useState('');
  const [restoreConfirm, setRestoreConfirm] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);

  const loadBackups = useCallback(async () => {
    try {
      const res = await adminApi.listBackups();
      setBackups(res.backups);
    } catch {
      // Non-fatal: the list is informational.
    }
  }, []);

  useEffect(() => {
    void loadBackups();
  }, [loadBackups]);

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
      void loadBackups();
    } catch (err) {
      setRestoreError(err instanceof ApiError ? err.message : 'بازگردانی با خطا مواجه شد.');
    } finally {
      setRestoring(false);
    }
  }

  return (
    <div className="space-y-6 max-w-3xl">
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
