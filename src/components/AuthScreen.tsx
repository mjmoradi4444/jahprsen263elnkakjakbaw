import React, { useState } from 'react';
import { Eye, EyeOff, KeyRound, ShieldCheck } from 'lucide-react';
import { api, ApiError } from '../api/client';
import { UserAccountPublic } from '../shared/types';

interface AuthScreenProps {
  initialized: boolean;
  roles: UserAccountPublic[];
  onAuthenticated: (token: string, user: UserAccountPublic) => void;
}

export function AuthScreen({ initialized, roles, onAuthenticated }: AuthScreenProps) {
  // First-run setup state
  const [ceoPin, setCeoPin] = useState('');
  const [ceoPinConfirm, setCeoPinConfirm] = useState('');
  const [staffInitialPin, setStaffInitialPin] = useState('');
  const [waPhone, setWaPhone] = useState('');

  // Login state
  const [selectedRole, setSelectedRole] = useState<string>('ceo');
  const [pin, setPin] = useState('');
  const [showPin, setShowPin] = useState(false);

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const salesRoles = roles.filter((r) => r.isSales);
  const opsRoles = roles.filter((r) => !r.isSales && r.id !== 'ceo');
  const ceoRole = roles.find((r) => r.id === 'ceo');

  async function handleBootstrap(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (ceoPin.trim().length < 4) {
      setError('رمز عبور مدیرعامل باید حداقل ۴ کاراکتر باشد.');
      return;
    }
    if (ceoPin !== ceoPinConfirm) {
      setError('رمز عبور مدیرعامل و تکرار آن یکسان نیست.');
      return;
    }
    if (staffInitialPin && staffInitialPin.trim().length < 4) {
      setError('رمز اولیه سایر واحدها در صورت وارد کردن باید حداقل ۴ کاراکتر باشد.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.bootstrapAdmin({
        ceoPin: ceoPin.trim(),
        staffInitialPin: staffInitialPin.trim() || undefined,
        waPhone: waPhone.trim() || undefined,
      });
      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'خطا در راه‌اندازی اولیه سامانه.');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!pin.trim()) {
      setError('لطفاً رمز عبور کارتابل را وارد کنید.');
      return;
    }

    setSubmitting(true);
    try {
      const res = await api.login(selectedRole, pin.trim());
      setPin('');
      onAuthenticated(res.token, res.user);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'ورود با خطا مواجه شد.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-slate-50 flex flex-col justify-between">
      <header className="bg-white border-b border-slate-200 px-6 py-4">
        <div className="max-w-5xl mx-auto flex items-center justify-between gap-4">
          <span className="text-base font-extrabold text-slate-900 whitespace-nowrap">
            پرتال یکپارچه پخش قطعات یدکی
          </span>
          <span className="text-xs text-slate-500 whitespace-nowrap">
            ایران‌خودرو و سایپا · ۵۰ برند منتخب
          </span>
        </div>
      </header>

      <main className="flex-1 flex items-center justify-center px-4 py-10">
        {!initialized ? (
          <section className="w-full max-w-lg bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
            <div className="mb-6">
              <div className="inline-flex items-center justify-center w-11 h-11 rounded-lg bg-slate-900 text-white mb-4">
                <ShieldCheck className="w-5 h-5" />
              </div>
              <h1 className="text-xl font-extrabold text-slate-900">راه‌اندازی اولیه و تعریف رمز مدیرعامل</h1>
              <p className="text-sm text-slate-600 mt-1.5 leading-relaxed">
                هیچ رمز پیش‌فرضی در کد ذخیره نشده است. برای شروع کار، رمز عبور اختصاصی مدیرعامل را تعیین کنید. این فرم پس از ثبت، به‌صورت دائمی قفل می‌شود.
              </p>
            </div>

            <form onSubmit={handleBootstrap} className="space-y-4">
              <div>
                <label htmlFor="setup-ceo-pin" className="block text-xs font-bold text-slate-800 mb-1.5">
                  رمز عبور مدیرعامل (حداقل ۴ کاراکتر) *
                </label>
                <input
                  id="setup-ceo-pin"
                  type="password"
                  dir="ltr"
                  value={ceoPin}
                  onChange={(e) => setCeoPin(e.target.value)}
                  required
                  minLength={4}
                  maxLength={16}
                  placeholder="••••••"
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 tabular-nums"
                />
              </div>

              <div>
                <label htmlFor="setup-ceo-pin-confirm" className="block text-xs font-bold text-slate-800 mb-1.5">
                  تکرار رمز عبور مدیرعامل *
                </label>
                <input
                  id="setup-ceo-pin-confirm"
                  type="password"
                  dir="ltr"
                  value={ceoPinConfirm}
                  onChange={(e) => setCeoPinConfirm(e.target.value)}
                  required
                  minLength={4}
                  maxLength={16}
                  placeholder="••••••"
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 tabular-nums"
                />
              </div>

              <div className="pt-2 border-t border-slate-100 grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label htmlFor="setup-staff-pin" className="block text-xs font-bold text-slate-800 mb-1.5">
                    رمز اولیه سایر واحدها (اختیاری)
                  </label>
                  <input
                    id="setup-staff-pin"
                    type="password"
                    dir="ltr"
                    value={staffInitialPin}
                    onChange={(e) => setStaffInitialPin(e.target.value)}
                    maxLength={16}
                    placeholder="••••••"
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 tabular-nums"
                  />
                </div>
                <div>
                  <label htmlFor="setup-wa-phone" className="block text-xs font-bold text-slate-800 mb-1.5">
                    واتساپ مدیرعامل (اختیاری)
                  </label>
                  <input
                    id="setup-wa-phone"
                    type="tel"
                    dir="ltr"
                    value={waPhone}
                    onChange={(e) => setWaPhone(e.target.value)}
                    placeholder="09120000000"
                    className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 tabular-nums"
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
                className="w-full py-2.5 px-4 rounded-lg bg-slate-900 hover:bg-slate-800 disabled:opacity-50 text-white text-sm font-bold transition-colors cursor-pointer"
              >
                {submitting ? 'در حال ثبت امن رمزها...' : 'ثبت رمز مدیرعامل و ورود به سامانه'}
              </button>
            </form>
          </section>
        ) : (
          <section className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 sm:p-8">
            <div className="mb-6">
              <div className="inline-flex items-center justify-center w-11 h-11 rounded-lg bg-blue-700 text-white mb-4">
                <KeyRound className="w-5 h-5" />
              </div>
              <h1 className="text-xl font-extrabold text-slate-900">ورود به کارتابل سازمانی</h1>
              <p className="text-sm text-slate-600 mt-1">
                واحد سازمانی خود را انتخاب و رمز عبور را وارد کنید. نشست ورود در حافظه محلی ذخیره نمی‌شود.
              </p>
            </div>

            <form onSubmit={handleLogin} className="space-y-4">
              <div>
                <label htmlFor="login-role-select" className="block text-xs font-bold text-slate-800 mb-1.5">
                  انتخاب کارتابل / واحد سازمانی
                </label>
                <select
                  id="login-role-select"
                  value={selectedRole}
                  onChange={(e) => {
                    setSelectedRole(e.target.value);
                    setError(null);
                  }}
                  className="w-full px-3.5 py-2.5 text-sm border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 cursor-pointer"
                >
                  {ceoRole && (
                    <option value={ceoRole.id}>
                      {ceoRole.displayName} ({ceoRole.roleLabel})
                    </option>
                  )}
                  <optgroup label="کارشناسان فروش (کارتابل اختصاصی)">
                    {salesRoles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.displayName} — {r.roleLabel}{!r.hasPin ? ' (بدون رمز)' : ''}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="واحدهای عملیاتی و ستادی">
                    {opsRoles.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.displayName}{!r.hasPin ? ' (بدون رمز)' : ''}
                      </option>
                    ))}
                  </optgroup>
                </select>
              </div>

              <div>
                <label htmlFor="login-pin-input" className="block text-xs font-bold text-slate-800 mb-1.5">
                  رمز عبور
                </label>
                <div className="relative">
                  <input
                    id="login-pin-input"
                    type={showPin ? 'text' : 'password'}
                    dir="ltr"
                    value={pin}
                    onChange={(e) => setPin(e.target.value)}
                    required
                    maxLength={16}
                    autoComplete="current-password"
                    placeholder="••••"
                    className="w-full pl-11 pr-3.5 py-2.5 text-sm border border-slate-300 rounded-lg bg-white text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600/20 focus:border-blue-600 font-mono-code tracking-widest"
                  />
                  <button
                    type="button"
                    onClick={() => setShowPin((s) => !s)}
                    aria-label={showPin ? 'مخفی کردن رمز عبور' : 'نمایش رمز عبور'}
                    className="absolute left-2.5 top-1/2 -translate-y-1/2 p-1.5 text-slate-500 hover:text-slate-900 cursor-pointer"
                  >
                    {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
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
                className="w-full py-2.5 px-4 rounded-lg bg-blue-700 hover:bg-blue-800 disabled:opacity-50 text-white text-sm font-bold transition-colors cursor-pointer"
              >
                {submitting ? 'در حال بررسی اعتبار...' : 'ورود به کارتابل'}
              </button>
            </form>
          </section>
        )}
      </main>

      <footer className="py-4 px-6 text-center text-xs text-slate-500 border-t border-slate-200 bg-white">
        احراز هویت سمت سرور · کنترل دسترسی تفکیک‌شده · بدون ذخیره اطلاعات حساس در مرورگر
      </footer>
    </div>
  );
}
