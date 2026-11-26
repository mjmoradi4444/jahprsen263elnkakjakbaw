import React, { useEffect, useState } from 'react';
import { X, Save, ShieldAlert } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { UserAccountPublic } from '../shared/types';

interface SettingsModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: (roles: UserAccountPublic[]) => void;
}

interface RoleDraft {
  id: string;
  roleLabel: string;
  displayName: string;
  hasPin: boolean;
  newPin: string;
}

export function SettingsModal({ open, onClose, onSaved }: SettingsModalProps) {
  const [waPhone, setWaPhone] = useState('');
  const [roleDrafts, setRoleDrafts] = useState<RoleDraft[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setSuccess(null);
    setLoading(true);
    api
      .getSettings()
      .then((res) => {
        setWaPhone(res.waPhone || '');
        setRoleDrafts(
          res.roles.map((r) => ({
            id: r.id,
            roleLabel: r.roleLabel,
            displayName: r.displayName,
            hasPin: r.hasPin,
            newPin: '',
          })),
        );
      })
      .catch((err) => {
        setError(err instanceof ApiError ? err.message : 'خطا در دریافت تنظیمات.');
      })
      .finally(() => setLoading(false));
  }, [open]);

  if (!open) return null;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuccess(null);
    setSaving(true);
    try {
      const res = await api.updateSettings({
        waPhone: waPhone.trim(),
        roles: roleDrafts.map((d) => ({
          id: d.id,
          displayName: d.displayName.trim(),
          newPin: d.newPin.trim() || undefined,
        })),
      });
      setRoleDrafts(
        res.roles.map((r) => ({
          id: r.id,
          roleLabel: r.roleLabel,
          displayName: r.displayName,
          hasPin: r.hasPin,
          newPin: '',
        })),
      );
      setSuccess('تنظیمات و رمزهای جدید با موفقیت روی سرور ذخیره شد.');
      onSaved(res.roles);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در ذخیره تنظیمات.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/60 flex items-center justify-center p-4 no-print" role="dialog" aria-modal="true" aria-labelledby="settings-modal-title">
      <div className="bg-white border border-slate-200 rounded-xl w-full max-w-2xl max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 id="settings-modal-title" className="text-base font-extrabold text-slate-900">
              تنظیمات امنیتی، اسامی کارتابل‌ها و واتساپ مدیرعامل
            </h2>
            <p className="text-xs text-slate-500 mt-0.5">
              فقط مدیرعامل به این بخش دسترسی دارد. رمزها به‌صورت هش‌شده ذخیره شده و هرگز نمایش داده نمی‌شوند.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="بستن پنجره تنظیمات"
            className="p-2 rounded-lg text-slate-500 hover:bg-slate-100 hover:text-slate-900 cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={handleSave} className="overflow-y-auto p-6 space-y-5">
          {loading ? (
            <div className="text-sm text-slate-500 py-8 text-center">در حال دریافت تنظیمات از سرور...</div>
          ) : (
            <>
              <div>
                <label htmlFor="settings-wa-phone" className="block text-xs font-bold text-slate-800 mb-1.5">
                  شماره موبایل واتساپ مدیرعامل (با 09 شروع شود)
                </label>
                <input
                  id="settings-wa-phone"
                  type="tel"
                  dir="ltr"
                  value={waPhone}
                  onChange={(e) => setWaPhone(e.target.value)}
                  placeholder="09120000000"
                  className="w-full px-3.5 py-2 text-sm border border-slate-300 rounded-lg font-mono-code focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600"
                />
              </div>

              <div className="pt-4 border-t border-slate-200">
                <div className="flex items-center justify-between mb-3">
                  <h3 className="text-sm font-bold text-slate-900">مدیریت کارتابل‌ها و تغییر رمز عبور</h3>
                  <span className="text-xs text-slate-500">فیلد رمز جدید را فقط برای تغییر پر کنید</span>
                </div>

                <div className="overflow-x-auto border border-slate-200 rounded-lg">
                  <table className="w-full text-xs text-right">
                    <thead className="bg-slate-50 border-b border-slate-200 text-slate-600">
                      <tr>
                        <th className="py-2.5 px-3 font-bold">واحد / سمت</th>
                        <th className="py-2.5 px-3 font-bold">نام نمایشی در سامانه</th>
                        <th className="py-2.5 px-3 font-bold">وضعیت رمز</th>
                        <th className="py-2.5 px-3 font-bold">رمز جدید (۴ تا ۱۶ رقم)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {roleDrafts.map((draft, idx) => (
                        <tr key={draft.id} className="hover:bg-slate-50/70">
                          <td className="py-2 px-3 text-slate-600 whitespace-nowrap">{draft.roleLabel}</td>
                          <td className="py-2 px-3">
                            <input
                              type="text"
                              aria-label={`نام نمایشی ${draft.roleLabel}`}
                              value={draft.displayName}
                              onChange={(e) => {
                                const val = e.target.value;
                                setRoleDrafts((prev) => prev.map((r, i) => (i === idx ? { ...r, displayName: val } : r)));
                              }}
                              className="w-full min-w-[140px] px-2.5 py-1.5 border border-slate-300 rounded-md text-xs text-slate-900"
                            />
                          </td>
                          <td className="py-2 px-3 whitespace-nowrap">
                            {draft.hasPin ? (
                              <span className="text-emerald-700 font-semibold">تنظیم شده</span>
                            ) : (
                              <span className="text-amber-700 font-semibold">تعریف نشده</span>
                            )}
                          </td>
                          <td className="py-2 px-3">
                            <input
                              type="password"
                              dir="ltr"
                              aria-label={`رمز جدید ${draft.displayName}`}
                              value={draft.newPin}
                              onChange={(e) => {
                                const val = e.target.value;
                                setRoleDrafts((prev) => prev.map((r, i) => (i === idx ? { ...r, newPin: val } : r)));
                              }}
                              placeholder="تغییر رمز..."
                              maxLength={16}
                              className="w-full min-w-[110px] px-2.5 py-1.5 border border-slate-300 rounded-md text-xs font-mono-code text-slate-900"
                            />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="flex items-start gap-2 p-3 rounded-lg bg-slate-50 border border-slate-200 text-xs text-slate-600">
                <ShieldAlert className="w-4 h-4 text-slate-500 shrink-0 mt-0.5" />
                <span>با تغییر رمز عبور هر کارتابل، نشست‌های فعال قبلی آن کارتابل بلافاصله روی سرور لغو می‌شوند.</span>
              </div>

              {error && (
                <div role="alert" className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs font-semibold text-red-700">
                  {error}
                </div>
              )}
              {success && (
                <div role="status" className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-700">
                  {success}
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="px-4 py-2 rounded-lg border border-slate-300 text-xs font-bold text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  بستن
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="inline-flex items-center gap-1.5 px-5 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-xs font-bold cursor-pointer"
                >
                  <Save className="w-3.5 h-3.5" />
                  {saving ? 'در حال ذخیره...' : 'ذخیره تنظیمات امنیتی'}
                </button>
              </div>
            </>
          )}
        </form>
      </div>
    </div>
  );
}
