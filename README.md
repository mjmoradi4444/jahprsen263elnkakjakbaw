# پرتال یکپارچه فرآیندهای سازمانی — پخش قطعات یدکی

سامانه تمام‌استک (Full-Stack) مدیریت زنجیره فروش تا تحویل، تایید دوگانه مالی و صندوق چک‌ها، و صف تامین ۵۰ برند قطعات یدکی خودرو (ایران‌خودرو و سایپا).

## معماری ذخیره‌سازی Supabase Storage و لایه واسط RBAC

1. **ذخیره‌سازی فایل‌ها با URL در Supabase Storage (`server/storage.ts`)**:
   - تمام فایل‌های PDF (پیش‌فاکتور / فاکتور نهایی)، عکس چک‌ها/واریزی‌ها و امضای دیجیتال مشتری به‌صورت فایل باینری (پس از بررسی بایت‌های جادویی و سقف ۵ مگابایت) در **Supabase Storage** (`autoparts-documents`) ذخیره می‌شوند.
   - در ردیف‌های جداول دیتابیس هیچ رشته Base64 ذخیره نمی‌شود و فیلدهای `storage_url`، `file_url` و `signature_url` آدرس URL فایل در Storage را نگهداری می‌کنند.
   - در حالت `SUPABASE_STORAGE_PUBLIC="true"` آدرس عمومی مستقیم (`getPublicUrl`) ذخیره و بدون درخواست اضافی نمایش داده می‌شود، و در حالت امن پیش‌فرض (`SUPABASE_STORAGE_PUBLIC="false"`) فایل‌های مالی در سطل خصوصی نگهداری شده و از طریق `POST /api/files/:id/signed-url` آدرس امضاشده ۶۰ ثانیه‌ای دریافت می‌کنند.
   - در نبود تنظیمات محیطی Supabase در پیش‌نمایش محلی، سامانه به‌طور خودکار از ذخیره‌سازی امن محلی با همان قرارداد URL استفاده می‌کند.

2. **واکشی افزایشی (`Incremental Fetching`) با فیلتر `updated_at` (`GET /api/sync?since=<ISO>`)**:
   - به‌جای دانلود کل دیتابیس در هر ۴.۵ ثانیه، هر ماژول در شروع یک‌بار اسنپ‌شات نقش‌محور را بارگذاری کرده و آخرین برچسب زمانی (`cursor` بر اساس `updated_at`) را نگه می‌دارد؛ در هر تیک ۴.۵ ثانیه‌ای یا اعلان زنده SSE فقط رکوردهای تغییریافته (`updated_at > since`) واکشی و با کش محلی ادغام (`mergeIncrementalRecords`) می‌شوند و آمار/فیلترها بدون دانلود مجدد کل جدول محاسبه می‌گردند.
   - روی ستون `updated_at` در جداول `orders`، `checks` و `procurement_items` ایندکس اختصاصی در Supabase PostgreSQL و SQLite تعریف شده است.

3. **لایه واسط RBAC سمت سرور و سیاست‌های RLS سوپابیس (`server/middleware/rbac.ts` و `server/supabase.ts`)**:
   - هیچ کلید Supabase (`SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_JWT_SECRET`) در کلاینت یا باندل مرورگر قرار نمی‌گیرد.
   - لایه واسط RBAC سمت سرور برای هر درخواست احرازهویت‌شده یک توکن کوتاه‌مدت HS256 حاوی نقش کاربر (`app_role`, `app_user_id`, `is_sales`, `can_access_finance`, `can_access_procurement`) صادر کرده و کلاینت Supabase اختصاصی همان درخواست (`req.supabase`) را می‌سازد تا **Row-Level Security (RLS)** مستقیماً در سطح دیتابیس سوپابیس از دسترسی غیرمجاز به ردیف‌ها جلوگیری کند.
   - فایل مهاجرت و سیاست‌های RLS و سطل خصوصی ذخیره‌سازی در مسیر `supabase/migrations/001_rbac_and_storage.sql` آماده اجرا در SQL Editor سوپابیس است.

## ساختار پروژه

- `server.ts` — نقطه ورود سرور Express + Vite
- `server/supabase.ts` — اتصال سمت سرور به Supabase و صدور/اعتبارسنجی JWTهای نقش‌محور برای RLS
- `server/storage.ts` — سرویس ذخیره‌سازی باینری روی Supabase Storage (مخزن خصوصی + URL امضاشده کوتاه‌مدت) با پشتیبان امن محلی
- `server/middleware/rbac.ts` — لایه واسط (Middleware) احراز هویت، فیلتر ردیف‌ها، گاردهای نقش و مجوز دانلود فایل‌ها
- `server/supabase-sync.ts` — همگام‌سازی رکوردهای نرمال‌شده با دیتابیس Supabase تحت کلاینت RLS هر کاربر
- `supabase/migrations/001_rbac_and_storage.sql` — اسکیمای جداول، نمای مخفی‌ساز مبالغ برای انبار/راننده (`orders_role_view`)، سیاست‌های RLS و مخزن خصوصی Storage
- `server/db.ts` — پایگاه‌داده SQLite محلی (`better-sqlite3`) برای پیش‌نمایش و کارکرد بدون وقفه
- `server/routes.ts` — مسیرهای REST و SSE با قفل خوش‌بینانه نسخه و تایید دوتایی اتمیک
- `src/shared/` — تعاریف TypeScript و منطق خالص کسب‌وکار + آزمون‌های واحد

## راه‌اندازی و اتصال به Supabase

1. فایل `supabase/migrations/001_rbac_and_storage.sql` را در SQL Editor پروژه Supabase خود اجرا کنید.
2. متغیرهای محیطی سمت سرور را (مطابق `.env.example` و **بدون** پیشوند `VITE_`) در بخش Secrets تنظیم نمایید:
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
   - `SUPABASE_JWT_SECRET`
   - `SUPABASE_STORAGE_BUCKET` (پیش‌فرض: `autoparts-documents`)
3. اجرای توسعه: `npm run dev` | ساخت تولید: `npm run build` و اجرا با `npm start`.
4. در اولین ورود، صفحه راه‌اندازی اولیه برای تعیین رمز مدیرعامل نمایش داده می‌شود (یا می‌توان `CEO_INITIAL_PIN` را در متغیرهای محیطی تنظیم کرد).
