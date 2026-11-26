import React, { useCallback, useEffect, useState } from 'react';
import {
  Factory,
  Landmark,
  LogOut,
  Menu,
  Package,
  RefreshCw,
  Settings,
  X,
} from 'lucide-react';
import { api, setAuthToken, subscribeLiveEvents } from './api/client';
import { AuthScreen } from './components/AuthScreen';
import { Phase1Orders } from './components/Phase1Orders';
import { Phase2Finance } from './components/Phase2Finance';
import { Phase3Procurement } from './components/Phase3Procurement';
import { SettingsModal } from './components/SettingsModal';
import { UserAccountPublic } from './shared/types';

export default function App() {
  const [bootLoading, setBootLoading] = useState(true);
  const [initialized, setInitialized] = useState(false);
  const [roles, setRoles] = useState<UserAccountPublic[]>([]);
  const [user, setUser] = useState<UserAccountPublic | null>(null);

  const [activePhase, setActivePhase] = useState<1 | 2 | 3>(1);
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [refreshTrigger, setRefreshTrigger] = useState(0);
  const [toast, setToast] = useState<{ message: string; isError?: boolean } | null>(null);

  const loadAuthStatus = useCallback(async () => {
    try {
      const res = await api.getAuthStatus();
      setInitialized(res.initialized);
      setRoles(res.roles);
    } finally {
      setBootLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAuthStatus();
  }, [loadAuthStatus]);

  // Live SSE updates (only lightweight change pings, zero 4.5s base64 polling)
  useEffect(() => {
    if (!user) return;
    const unsubscribe = subscribeLiveEvents(() => {
      setRefreshTrigger((n) => n + 1);
    });
    return unsubscribe;
  }, [user]);

  const showToast = useCallback((message: string, isError = false) => {
    setToast({ message, isError });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast]);

  function handleAuthenticated(token: string, authedUser: UserAccountPublic) {
    setAuthToken(token);
    setUser(authedUser);
    setInitialized(true);
    setActivePhase(1);
    loadAuthStatus();
  }

  async function handleLogout() {
    try {
      await api.logout();
    } catch {
      // Ignore network errors on logout; always clear client session immediately
    }
    setAuthToken(null);
    setUser(null);
    setSettingsOpen(false);
    setMobileMenuOpen(false);
    setToast(null);
    loadAuthStatus();
  }

  if (bootLoading) {
    return (
      <div className="min-h-screen bg-slate-50 flex items-center justify-center text-sm text-slate-600">
        در حال برقراری ارتباط با سرور...
      </div>
    );
  }

  if (!user) {
    return (
      <AuthScreen
        initialized={initialized}
        roles={roles}
        onAuthenticated={handleAuthenticated}
      />
    );
  }

  const phaseTitle =
    activePhase === 1
      ? 'فروش تا تحویل (فاز ۱)'
      : activePhase === 2
        ? 'مالی و صندوق چک‌ها (فاز ۲)'
        : 'تامین ۵۰ برند (فاز ۳)';

  const navItems: Array<{ id: 1 | 2 | 3; label: string; sub: string; icon: React.ReactNode; visible: boolean }> = [
    {
      id: 1,
      label: 'فروش تا تحویل',
      sub: 'زنجیره ۶ مرحله‌ای سفارش',
      icon: <Package className="w-4 h-4 shrink-0" />,
      visible: true,
    },
    {
      id: 2,
      label: 'مالی و صندوق چک‌ها',
      sub: 'تایید دوگانه و سررسیدها',
      icon: <Landmark className="w-4 h-4 shrink-0" />,
      visible: user.canAccessFinance,
    },
    {
      id: 3,
      label: 'تامین ۵۰ برند',
      sub: 'کسری انبار و خرید',
      icon: <Factory className="w-4 h-4 shrink-0" />,
      visible: user.canAccessProcurement,
    },
  ];

  return (
    <div className="min-h-screen bg-slate-50 flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-64 shrink-0 bg-white border-l border-slate-200 no-print">
        <div className="px-5 py-4 border-b border-slate-200">
          <div className="text-sm font-extrabold text-slate-900">پرتال پخش قطعات یدکی</div>
          <div className="text-[11px] text-slate-500 mt-0.5">ایران‌خودرو و سایپا · ۵۰ برند</div>
        </div>

        <nav className="flex-1 p-3 space-y-1" aria-label="ماژول‌های سامانه">
          {navItems
            .filter((item) => item.visible)
            .map((item) => {
              const active = activePhase === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setActivePhase(item.id)}
                  className={`w-full text-right flex items-center gap-3 px-3.5 py-2.5 rounded-lg transition-colors cursor-pointer ${
                    active
                      ? 'bg-slate-900 text-white'
                      : 'text-slate-700 hover:bg-slate-100 hover:text-slate-900'
                  }`}
                >
                  {item.icon}
                  <div className="min-w-0">
                    <div className="text-xs font-bold truncate">{item.label}</div>
                    <div className={`text-[10px] truncate ${active ? 'text-slate-300' : 'text-slate-500'}`}>
                      {item.sub}
                    </div>
                  </div>
                </button>
              );
            })}
        </nav>

        <div className="p-4 border-t border-slate-200 space-y-3">
          <div>
            <div className="text-xs font-extrabold text-slate-900 truncate">{user.displayName}</div>
            <div className="text-[11px] text-slate-500 truncate">{user.roleLabel}</div>
          </div>
          <div className="flex flex-col gap-1.5">
            {user.id === 'ceo' && (
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-slate-300 bg-white hover:bg-slate-50 text-xs font-bold text-slate-800 cursor-pointer"
              >
                <Settings className="w-3.5 h-3.5" />
                تنظیمات و رمزها
              </button>
            )}
            <button
              type="button"
              onClick={handleLogout}
              className="w-full inline-flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg border border-red-200 bg-red-50 hover:bg-red-100 text-xs font-bold text-red-700 cursor-pointer"
            >
              <LogOut className="w-3.5 h-3.5" />
              خروج امن
            </button>
          </div>
        </div>
      </aside>

      {/* Mobile Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex no-print">
          <div className="w-72 max-w-[85vw] bg-white h-full border-l border-slate-200 flex flex-col">
            <div className="px-4 py-4 border-b border-slate-200 flex items-center justify-between">
              <span className="text-sm font-extrabold text-slate-900">منوی سامانه</span>
              <button
                type="button"
                onClick={() => setMobileMenuOpen(false)}
                aria-label="بستن منو"
                className="p-1.5 rounded-lg hover:bg-slate-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {navItems
                .filter((item) => item.visible)
                .map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActivePhase(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full text-right flex items-center gap-3 px-3.5 py-2.5 rounded-lg text-xs font-bold ${
                      activePhase === item.id ? 'bg-slate-900 text-white' : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    {item.icon}
                    <span>{item.label}</span>
                  </button>
                ))}
            </nav>
            <div className="p-4 border-t border-slate-200 space-y-2">
              <div className="text-xs font-bold text-slate-900">{user.displayName}</div>
              {user.id === 'ceo' && (
                <button
                  type="button"
                  onClick={() => {
                    setMobileMenuOpen(false);
                    setSettingsOpen(true);
                  }}
                  className="w-full py-2 px-3 rounded-lg border border-slate-300 text-xs font-bold text-slate-800"
                >
                  تنظیمات و رمزها
                </button>
              )}
              <button
                type="button"
                onClick={handleLogout}
                className="w-full py-2 px-3 rounded-lg bg-red-50 border border-red-200 text-xs font-bold text-red-700"
              >
                خروج امن
              </button>
            </div>
          </div>
          <div className="flex-1 bg-slate-900/50" onClick={() => setMobileMenuOpen(false)} />
        </div>
      )}

      {/* Main Content Area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Clean 1-row Top Bar */}
        <header className="bg-white border-b border-slate-200 px-4 sm:px-6 py-3.5 flex items-center justify-between gap-4 no-print">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              aria-label="باز کردن منو"
              className="lg:hidden p-2 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="min-w-0">
              <h1 className="text-sm sm:text-base font-extrabold text-slate-900 truncate">{phaseTitle}</h1>
              <p className="text-[11px] text-slate-500 truncate hidden sm:block">
                {user.displayName} · {user.scope}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => setRefreshTrigger((n) => n + 1)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 text-xs font-bold text-slate-700 whitespace-nowrap cursor-pointer"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              بروزرسانی
            </button>
            {user.id === 'ceo' && (
              <button
                type="button"
                onClick={() => setSettingsOpen(true)}
                className="hidden sm:inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-bold whitespace-nowrap cursor-pointer"
              >
                <Settings className="w-3.5 h-3.5" />
                تنظیمات
              </button>
            )}
          </div>
        </header>

        <main className="flex-1 p-4 sm:p-6 max-w-6xl w-full mx-auto no-print">
          {activePhase === 1 && (
            <Phase1Orders
              user={user}
              refreshTrigger={refreshTrigger}
              onNotify={showToast}
              onDataChanged={() => setRefreshTrigger((n) => n + 1)}
            />
          )}
          {activePhase === 2 && user.canAccessFinance && (
            <Phase2Finance
              user={user}
              roles={roles}
              refreshTrigger={refreshTrigger}
              onNotify={showToast}
              onDataChanged={() => setRefreshTrigger((n) => n + 1)}
            />
          )}
          {activePhase === 3 && user.canAccessProcurement && (
            <Phase3Procurement
              refreshTrigger={refreshTrigger}
              onNotify={showToast}
              onDataChanged={() => setRefreshTrigger((n) => n + 1)}
            />
          )}
        </main>
      </div>

      {/* CEO-Only Settings Modal */}
      {user.id === 'ceo' && (
        <SettingsModal
          open={settingsOpen}
          onClose={() => setSettingsOpen(false)}
          onSaved={(updatedRoles) => {
            setRoles(updatedRoles);
            const me = updatedRoles.find((r) => r.id === user.id);
            if (me) setUser(me);
            showToast('تنظیمات مدیریتی و رمزهای عبور ذخیره شد.');
          }}
        />
      )}

      {/* Toast Notification */}
      {toast && (
        <div
          role={toast.isError ? 'alert' : 'status'}
          className={`fixed bottom-4 left-4 right-4 sm:right-auto sm:w-96 z-50 px-4 py-3 rounded-xl border text-xs font-bold flex items-center justify-between gap-3 shadow-lg no-print ${
            toast.isError
              ? 'bg-red-900 border-red-700 text-white'
              : 'bg-slate-900 border-slate-700 text-white'
          }`}
        >
          <span>{toast.message}</span>
          <button
            type="button"
            onClick={() => setToast(null)}
            aria-label="بستن اعلان"
            className="p-1 rounded hover:bg-white/10 shrink-0 cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}
    </div>
  );
}
