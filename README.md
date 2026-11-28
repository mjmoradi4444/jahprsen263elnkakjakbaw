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

## Invoice auto-fill (proforma PDF)

Sales reps upload the proforma PDF first; the server reads it and pre-fills the form. All fields stay editable.

- Items table, line totals and the totals row are real text in the PDF: read with `pdfjs-dist`.
- Invoice number, date and buyer code are drawn as graphics: read with offline OCR (`tesseract.js`, digits only, language data bundled from `@tesseract.js-data/eng`). No invoice data leaves the server.
- Amounts on the invoice are in **rial**; the form stores **toman** (÷ 10).
- Buyer code → customer name is learned from submitted orders (`customer_codes` table).
- Cross-checks highlight fields in yellow: line totals vs. totals row, OCR number vs. digits in the file name.
- The OCR regions in `server/invoice-extract.ts` match the current accounting-software template. If the template changes, update `OCR_REGIONS` / `COLUMN_BANDS`.

Duplicate proforma and final-invoice numbers are rejected with the original registrant and Jalali date/time (Tehran).

## Deployment notes

- `npm start` runs `tsx server.ts` in production mode after `npm run build`.
- Run both SQL files in `supabase/migrations/` (001 then 002) in the Supabase SQL editor.
- Environment: `CEO_INITIAL_PIN`, `SESSION_SECRET`, `TRUST_PROXY=1` behind a proxy, and the `SUPABASE_*` variables. Never set `SEED_DEMO_DATA` in production.
- SQLite is the live database; every write is mirrored to Supabase. If the server starts with an empty disk, data (orders, checks, procurement, files metadata, accounts, settings, customer codes) is restored from Supabase automatically. A persistent disk is still recommended.
- `npm test` runs all unit tests.
