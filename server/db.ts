import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  AuditLogEntry,
  CheckAttachmentRecord,
  CheckRecord,
  OrderDocumentRecord,
  OrderRecord,
  ProcurementItem,
  ROLE_DEFINITIONS,
  RoleId,
  StageHistoryEntry,
  UserAccountPublic,
} from '../src/shared/types';
import { CURRENT_SCHEMA_VERSION, normalizeDigits } from '../src/shared/workflow';

const DATA_DIR = path.resolve(process.cwd(), 'data');
export const UPLOADS_DIR = path.resolve(DATA_DIR, 'uploads');
const DB_PATH = path.resolve(DATA_DIR, 'autoparts_erp.sqlite');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ==================== Schema Initialization ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    role_label TEXT NOT NULL,
    is_sales INTEGER NOT NULL DEFAULT 0,
    can_access_finance INTEGER NOT NULL DEFAULT 0,
    can_access_procurement INTEGER NOT NULL DEFAULT 0,
    scope TEXT NOT NULL,
    pin_hash TEXT,
    pin_salt TEXT,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS files (
    id TEXT PRIMARY KEY,
    storage_provider TEXT NOT NULL DEFAULT 'local',
    storage_bucket TEXT NOT NULL DEFAULT 'autoparts-documents',
    storage_path TEXT NOT NULL DEFAULT '',
    storage_url TEXT NOT NULL DEFAULT '',
    stored_filename TEXT NOT NULL,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    owner_kind TEXT NOT NULL, -- 'order_doc' | 'signature' | 'check_attachment' | 'temp'
    owner_record_id TEXT,
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS orders (
    id TEXT PRIMARY KEY,
    schema_version INTEGER NOT NULL DEFAULT 4,
    version INTEGER NOT NULL DEFAULT 1,
    sales_owner_id TEXT NOT NULL,
    sales_owner_name TEXT NOT NULL,
    customer TEXT NOT NULL,
    proforma TEXT NOT NULL,
    final_invoice_no TEXT NOT NULL DEFAULT '',
    accounting_note TEXT NOT NULL DEFAULT '',
    channel TEXT NOT NULL DEFAULT '',
    amount_toman INTEGER,
    payment TEXT,
    items TEXT NOT NULL,
    stage INTEGER NOT NULL DEFAULT 2,
    status TEXT NOT NULL DEFAULT 'active',
    rev INTEGER NOT NULL DEFAULT 0,
    return_reason TEXT NOT NULL DEFAULT '',
    return_note TEXT NOT NULL DEFAULT '',
    cartons_out INTEGER,
    exit_time TEXT NOT NULL DEFAULT '',
    driver_name TEXT NOT NULL DEFAULT '',
    cartons_delivered INTEGER,
    carton_discrepancy INTEGER NOT NULL DEFAULT 0,
    discrepancy_note TEXT NOT NULL DEFAULT '',
    customer_signer TEXT NOT NULL DEFAULT '',
    signature_file_id TEXT,
    signature_url TEXT NOT NULL DEFAULT '',
    stage_history_json TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_proforma_unique ON orders(lower(proforma));
  CREATE INDEX IF NOT EXISTS idx_orders_stage_status ON orders(stage, status);
  CREATE INDEX IF NOT EXISTS idx_orders_updated_at ON orders(updated_at DESC);

  CREATE TABLE IF NOT EXISTS order_documents (
    id TEXT PRIMARY KEY,
    order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
    doc_kind TEXT NOT NULL, -- 'proforma' | 'final_invoice'
    version_no INTEGER NOT NULL DEFAULT 1,
    file_id TEXT NOT NULL REFERENCES files(id),
    file_url TEXT NOT NULL DEFAULT '',
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    uploaded_by TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS checks (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    doc_type TEXT NOT NULL,
    customer TEXT NOT NULL,
    amount_toman INTEGER NOT NULL,
    sayadi_id TEXT NOT NULL DEFAULT '',
    due_date TEXT NOT NULL DEFAULT '',
    tracking_no TEXT NOT NULL DEFAULT '',
    caption TEXT NOT NULL,
    sales_owner_id TEXT NOT NULL,
    sales_owner_name TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    finance_status TEXT NOT NULL DEFAULT 'pending',
    finance_time TEXT NOT NULL DEFAULT '',
    ceo_status TEXT NOT NULL DEFAULT 'pending',
    ceo_time TEXT NOT NULL DEFAULT '',
    finalized_time TEXT NOT NULL DEFAULT '',
    reject_reason TEXT NOT NULL DEFAULT '',
    rejected_by TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_checks_due_date ON checks(due_date ASC);
  CREATE INDEX IF NOT EXISTS idx_checks_status ON checks(status);
  CREATE INDEX IF NOT EXISTS idx_checks_updated_at ON checks(updated_at DESC);

  CREATE TABLE IF NOT EXISTS check_attachments (
    id TEXT PRIMARY KEY,
    check_id TEXT NOT NULL REFERENCES checks(id) ON DELETE CASCADE,
    file_id TEXT NOT NULL REFERENCES files(id),
    file_url TEXT NOT NULL DEFAULT '',
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS procurement_items (
    id TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 1,
    brand TEXT NOT NULL,
    part_name TEXT NOT NULL,
    part_code TEXT NOT NULL DEFAULT '',
    qty_needed INTEGER NOT NULL DEFAULT 1,
    priority TEXT NOT NULL DEFAULT 'عادی',
    status TEXT NOT NULL DEFAULT 'reported',
    related_order_proforma TEXT NOT NULL DEFAULT '',
    reported_by_name TEXT NOT NULL DEFAULT '',
    supplier_note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_procurement_updated_at ON procurement_items(updated_at DESC);

  CREATE TABLE IF NOT EXISTS audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor_id TEXT NOT NULL,
    actor_name TEXT NOT NULL,
    category TEXT NOT NULL,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_audit_logs_created ON audit_logs(id DESC);
`);

// Idempotent column migrations for pre-existing local SQLite databases
(function ensureStorageUrlColumns() {
  const ensureCol = (table: string, col: string, ddl: string) => {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    const existing = new Set(cols.map((c) => c.name));
    if (!existing.has(col)) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
    }
  };
  ensureCol('files', 'storage_provider', `storage_provider TEXT NOT NULL DEFAULT 'local'`);
  ensureCol('files', 'storage_bucket', `storage_bucket TEXT NOT NULL DEFAULT 'autoparts-documents'`);
  ensureCol('files', 'storage_path', `storage_path TEXT NOT NULL DEFAULT ''`);
  ensureCol('files', 'storage_url', `storage_url TEXT NOT NULL DEFAULT ''`);
  ensureCol('orders', 'signature_url', `signature_url TEXT NOT NULL DEFAULT ''`);
  ensureCol('order_documents', 'file_url', `file_url TEXT NOT NULL DEFAULT ''`);
  ensureCol('check_attachments', 'file_url', `file_url TEXT NOT NULL DEFAULT ''`);
})();

// ==================== Password / PIN Hashing (scrypt + timingSafeEqual) ====================
export function hashPin(pin: string): { hash: string; salt: string } {
  const normalized = normalizeDigits(pin);
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(normalized, salt, 64).toString('hex');
  return { hash: derived, salt };
}

export function verifyPinHash(pin: string, hash: string | null, salt: string | null): boolean {
  if (!hash || !salt) return false;
  const normalized = normalizeDigits(pin);
  const derived = crypto.scryptSync(normalized, salt, 64);
  const storedBuf = Buffer.from(hash, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

const SESSION_SECRET =
  process.env.SESSION_SECRET && process.env.SESSION_SECRET.trim().length >= 16
    ? process.env.SESSION_SECRET.trim()
    : crypto.randomBytes(32).toString('hex');

export function hashSessionToken(rawToken: string): string {
  return crypto.createHmac('sha256', SESSION_SECRET).update(rawToken).digest('hex');
}

// ==================== Seed Roles & Realistic Sample Records (NO Hardcoded PINs / NO Real PII) ====================
function ensureRolesSeeded(): void {
  const now = new Date().toISOString();
  const insertRole = db.prepare(`
    INSERT OR IGNORE INTO users (
      id, display_name, role_label, is_sales, can_access_finance, can_access_procurement, scope, pin_hash, pin_salt, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?)
  `);

  const tx = db.transaction(() => {
    for (const r of ROLE_DEFINITIONS) {
      insertRole.run(
        r.id,
        r.defaultTitle,
        r.roleLabel,
        r.isSales ? 1 : 0,
        r.canAccessFinance ? 1 : 0,
        r.canAccessProcurement ? 1 : 0,
        r.scope,
        now,
      );
    }

    db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('wa_phone', '', ?)`).run(now);
    db.prepare(`INSERT OR IGNORE INTO settings (key, value, updated_at) VALUES ('initialized', '0', ?)`).run(now);
  });
  tx();
}

function seedDemoRecordsIfEmpty(): void {
  const orderCount = (db.prepare(`SELECT COUNT(*) as cnt FROM orders`).get() as { cnt: number }).cnt;
  if (orderCount > 0) return;

  const now = Date.now();
  const hoursAgo = (h: number) => new Date(now - h * 3600 * 1000).toISOString();
  const daysFromNow = (d: number) => {
    const dt = new Date(now + d * 24 * 3600 * 1000);
    return dt.toISOString().slice(0, 10);
  };

  const insertOrder = db.prepare(`
    INSERT INTO orders (
      id, schema_version, version, sales_owner_id, sales_owner_name, customer, proforma,
      final_invoice_no, accounting_note, channel, amount_toman, payment, items, stage, status,
      rev, return_reason, return_note, cartons_out, exit_time, driver_name, cartons_delivered,
      carton_discrepancy, discrepancy_note, customer_signer, signature_file_id,
      stage_history_json, created_at, updated_at
    ) VALUES (
      ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, '', '', ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?
    )
  `);

  const insertCheck = db.prepare(`
    INSERT INTO checks (
      id, version, doc_type, customer, amount_toman, sayadi_id, due_date, tracking_no, caption,
      sales_owner_id, sales_owner_name, status, finance_status, finance_time, ceo_status, ceo_time,
      finalized_time, reject_reason, rejected_by, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', '', ?, ?)
  `);

  const insertProc = db.prepare(`
    INSERT INTO procurement_items (
      id, version, brand, part_name, part_code, qty_needed, priority, status,
      related_order_proforma, reported_by_name, supplier_note, created_at, updated_at
    ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertLog = db.prepare(`
    INSERT INTO audit_logs (actor_id, actor_name, category, message, created_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  const tx = db.transaction(() => {
    // 1. Order at Stage 2 (Sales Manager)
    insertOrder.run(
      'ord-seed-1',
      CURRENT_SCHEMA_VERSION,
      'sales_1',
      'کارشناس فروش ۱',
      'فروشگاه لوازم یدکی مرکزی غرب',
      'PF-5011',
      '',
      '',
      'تلفنی',
      68500000,
      'چک صیادی ۴۵ روزه',
      'دیسک و صفحه عظام پژو ۴۰۵ (۶ دست) + تسمه تایم گیتس TU5 (۱۲ عدد)',
      2,
      'active',
      null,
      '',
      '',
      null,
      0,
      '',
      '',
      JSON.stringify([
        { stage: 1, action: 'ثبت پیش‌فاکتور', actorName: 'کارشناس فروش ۱', timestamp: hoursAgo(6) },
      ]),
      hoursAgo(6),
      hoursAgo(6),
    );

    // 2. Order at Stage 4 (Accounting)
    insertOrder.run(
      'ord-seed-2',
      CURRENT_SCHEMA_VERSION,
      'sales_2',
      'کارشناس فروش ۲',
      'پخش یدک البرز - کرج',
      'PF-5012',
      '',
      '',
      'روبیکا',
      112000000,
      'نقدی / واریز آنی',
      'لنت جلو کروز پراید (۲۰ دست) + شمع بوش اصلی (۴۰ دست)',
      4,
      'active',
      null,
      '',
      '',
      null,
      0,
      '',
      '',
      JSON.stringify([
        { stage: 1, action: 'ثبت پیش‌فاکتور', actorName: 'کارشناس فروش ۲', timestamp: hoursAgo(12) },
        { stage: 2, action: 'تایید مدیر فروش', actorName: 'مدیر فروش', timestamp: hoursAgo(10) },
        { stage: 3, action: 'ثبت تاییدیه مشتری', actorName: 'کارشناس فروش ۲', timestamp: hoursAgo(8) },
      ]),
      hoursAgo(12),
      hoursAgo(8),
    );

    // 3. Order at Stage 5 (Warehouse)
    insertOrder.run(
      'ord-seed-3',
      CURRENT_SCHEMA_VERSION,
      'sales_1',
      'کارشناس فروش ۱',
      'اتو پارتس جنوب شرق',
      'PF-5013',
      'INV-1405-8810',
      'مانده حساب بررسی و تایید شد',
      'اپلیکیشن',
      94200000,
      'اعتباری / حساب باز',
      'کمک‌فنر جلو عظام سمند (۱۰ عدد) + پمپ بنزین کامل دینا پارت (۸ عدد)',
      5,
      'active',
      null,
      '',
      '',
      null,
      0,
      '',
      '',
      JSON.stringify([
        { stage: 1, action: 'ثبت پیش‌فاکتور', actorName: 'کارشناس فروش ۱', timestamp: hoursAgo(20) },
        { stage: 2, action: 'تایید مدیر فروش', actorName: 'مدیر فروش', timestamp: hoursAgo(18) },
        { stage: 3, action: 'ثبت تاییدیه مشتری', actorName: 'کارشناس فروش ۱', timestamp: hoursAgo(16) },
        { stage: 4, action: 'صدور فاکتور نهایی INV-1405-8810', actorName: 'واحد حسابداری و مالی', timestamp: hoursAgo(4) },
      ]),
      hoursAgo(20),
      hoursAgo(4),
    );

    // 4. Order at Stage 6 (Driver)
    insertOrder.run(
      'ord-seed-4',
      CURRENT_SCHEMA_VERSION,
      'sales_3',
      'کارشناس فروش ۳',
      'نمایندگی یدک شمال',
      'PF-5014',
      'INV-1405-8811',
      '',
      'حضوری',
      53800000,
      'نقدی / واریز آنی',
      'وایر شمع کروز تیبا (۱۵ دست) + سنسور اکسیژن والئو (۱۲ عدد)',
      6,
      'active',
      6,
      '10:15',
      'نیسان توزیع ۱',
      null,
      0,
      '',
      '',
      JSON.stringify([
        { stage: 1, action: 'ثبت پیش‌فاکتور', actorName: 'کارشناس فروش ۳', timestamp: hoursAgo(30) },
        { stage: 2, action: 'تایید مدیر فروش', actorName: 'مدیر فروش', timestamp: hoursAgo(28) },
        { stage: 3, action: 'ثبت تاییدیه مشتری', actorName: 'کارشناس فروش ۳', timestamp: hoursAgo(26) },
        { stage: 4, action: 'صدور فاکتور نهایی INV-1405-8811', actorName: 'واحد حسابداری و مالی', timestamp: hoursAgo(24) },
        { stage: 5, action: 'خروج از انبار (۶ کارتن)', actorName: 'سرپرست انبار', timestamp: hoursAgo(3) },
      ]),
      hoursAgo(30),
      hoursAgo(3),
    );

    // 5. Delivered Order (Stage 7 - Archive)
    insertOrder.run(
      'ord-seed-5',
      CURRENT_SCHEMA_VERSION,
      'sales_2',
      'کارشناس فروش ۲',
      'لوازم یدکی تک‌ستاره شرق',
      'PF-5009',
      'INV-1405-8802',
      'تسویه نقدی انجام شد',
      'تلفنی',
      41500000,
      'نقدی / واریز آنی',
      'فیلتر روغن ایساکو (۱۰۰ عدد) + بلبرینگ چرخ جلو امکو (۱۰ عدد)',
      7,
      'active',
      5,
      '09:30',
      'وانت آریسان ۲',
      5,
      0,
      '',
      'مسئول انبار فروشگاه',
      JSON.stringify([
        { stage: 1, action: 'ثبت پیش‌فاکتور', actorName: 'کارشناس فروش ۲', timestamp: hoursAgo(50) },
        { stage: 4, action: 'صدور فاکتور نهایی INV-1405-8802', actorName: 'واحد حسابداری و مالی', timestamp: hoursAgo(44) },
        { stage: 5, action: 'خروج از انبار (۵ کارتن)', actorName: 'سرپرست انبار', timestamp: hoursAgo(40) },
        { stage: 6, action: 'تحویل قطعی به مشتری (۵ کارتن)', actorName: 'راننده و توزیع', timestamp: hoursAgo(36) },
      ]),
      hoursAgo(50),
      hoursAgo(36),
    );

    // Seed Checks (1 pending dual-approval, 1 finalized in vault with upcoming due date, 1 finalized deposit)
    insertCheck.run(
      'chk-seed-1',
      'چک دریافتی',
      'فروشگاه لوازم یدکی مرکزی غرب',
      45000000,
      '6104337890123456',
      daysFromNow(5),
      '',
      'چک صیادی بانک ملت بابت تسویه فاکتورهای ماه جاری',
      'sales_1',
      'کارشناس فروش ۱',
      'pending',
      'approved',
      hoursAgo(2),
      'pending',
      '',
      '',
      hoursAgo(5),
      hoursAgo(2),
    );

    insertCheck.run(
      'chk-seed-2',
      'چک دریافتی',
      'اتو پارتس جنوب شرق',
      82000000,
      '5892101122334455',
      daysFromNow(3),
      '',
      'چک صیادی ثبت‌شده بابت تسویه فاکتور INV-1405-8810',
      'sales_2',
      'کارشناس فروش ۲',
      'finalized',
      'approved',
      hoursAgo(14),
      'approved',
      hoursAgo(12),
      hoursAgo(12),
      hoursAgo(18),
      hoursAgo(12),
    );

    insertCheck.run(
      'chk-seed-3',
      'واریزی',
      'پخش یدک البرز - کرج',
      64000000,
      '',
      '',
      'REF-9928174',
      'واریز پایا بابت پیش‌پرداخت سفارش PF-5012',
      'accounting',
      'واحد حسابداری و مالی',
      'finalized',
      'approved',
      hoursAgo(7),
      'approved',
      hoursAgo(6),
      hoursAgo(6),
      hoursAgo(9),
      hoursAgo(6),
    );

    // Seed Phase 3 Procurement Shortage Items
    insertProc.run(
      'proc-seed-1',
      'عظام (Ezam)',
      'دیسک و صفحه پژو ۲۰۶ تیپ ۵',
      'EZ-206-CL',
      25,
      'فوری',
      'reported',
      'PF-5013',
      'سرپرست انبار',
      'موجودی کف انبار به کمتر از ۵ دست رسیده است',
      hoursAgo(5),
      hoursAgo(5),
    );

    insertProc.run(
      'proc-seed-2',
      'کروز (Crouse)',
      'چراغ جلو راست دنا پلاس',
      'CR-DN-HL-R',
      12,
      'عادی',
      'ordered',
      '',
      'واحد حسابداری و مالی',
      'استعلام قیمت از نماینده انجام و سفارش ثبت شد',
      hoursAgo(22),
      hoursAgo(8),
    );

    insertLog.run(
      'system',
      'سامانه',
      'security',
      'زیرساخت امنیتی سرور، پایگاه‌داده رابطه‌ای و ذخیره‌سازی امن فایل‌ها راه‌اندازی شد.',
      hoursAgo(1),
    );
  });

  tx();
}

ensureRolesSeeded();
seedDemoRecordsIfEmpty();

// ==================== Helper Queries ====================
export function getSetting(key: string): string {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? row.value : '';
}

export function setSetting(key: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now);
}

export function isSystemInitialized(): boolean {
  if (process.env.CEO_INITIAL_PIN && process.env.CEO_INITIAL_PIN.trim().length >= 4) {
    return true;
  }
  const ceo = db.prepare(`SELECT pin_hash FROM users WHERE id = 'ceo'`).get() as { pin_hash: string | null } | undefined;
  return Boolean(ceo?.pin_hash);
}

export function listPublicRoles(): UserAccountPublic[] {
  const rows = db.prepare(`
    SELECT id, display_name, role_label, is_sales, can_access_finance, can_access_procurement, scope, pin_hash
    FROM users
    ORDER BY CASE id
      WHEN 'ceo' THEN 1
      WHEN 'sales_1' THEN 2
      WHEN 'sales_2' THEN 3
      WHEN 'sales_3' THEN 4
      WHEN 'sales_4' THEN 5
      WHEN 'sales_mgr' THEN 6
      WHEN 'accounting' THEN 7
      WHEN 'warehouse_sup' THEN 8
      WHEN 'driver' THEN 9
      ELSE 99
    END
  `).all() as Array<{
    id: RoleId;
    display_name: string;
    role_label: string;
    is_sales: number;
    can_access_finance: number;
    can_access_procurement: number;
    scope: string;
    pin_hash: string | null;
  }>;

  const envCeo = Boolean(process.env.CEO_INITIAL_PIN && process.env.CEO_INITIAL_PIN.trim().length >= 4);

  return rows.map((r) => ({
    id: r.id,
    displayName: r.display_name,
    roleLabel: r.role_label,
    isSales: r.is_sales === 1,
    canAccessFinance: r.can_access_finance === 1,
    canAccessProcurement: r.can_access_procurement === 1,
    scope: r.scope,
    hasPin: Boolean(r.pin_hash) || (r.id === 'ceo' && envCeo),
  }));
}

export function getPublicUser(roleId: string): UserAccountPublic | null {
  return listPublicRoles().find((r) => r.id === roleId) || null;
}

export function addAuditLog(
  actorId: string,
  actorName: string,
  category: AuditLogEntry['category'],
  message: string,
): AuditLogEntry {
  const now = new Date().toISOString();
  const res = db
    .prepare(`INSERT INTO audit_logs (actor_id, actor_name, category, message, created_at) VALUES (?, ?, ?, ?, ?)`)
    .run(actorId, actorName, category, message, now);
  return {
    id: Number(res.lastInsertRowid),
    actorId,
    actorName,
    category,
    message,
    createdAt: now,
  };
}

export function hydrateOrderRow(row: Record<string, unknown>): OrderRecord {
  const docs = db
    .prepare(`
      SELECT id, order_id, doc_kind, version_no, file_id, file_url, original_name, mime_type, uploaded_by, created_at
      FROM order_documents
      WHERE order_id = ?
      ORDER BY version_no ASC, created_at ASC
    `)
    .all(String(row.id)) as Array<{
      id: string;
      order_id: string;
      doc_kind: 'proforma' | 'final_invoice';
      version_no: number;
      file_id: string;
      file_url: string;
      original_name: string;
      mime_type: string;
      uploaded_by: string;
      created_at: string;
    }>;

  let history: StageHistoryEntry[] = [];
  try {
    const parsed = JSON.parse(String(row.stage_history_json || '[]'));
    if (Array.isArray(parsed)) history = parsed;
  } catch {
    history = [];
  }

  const signatureFileId = row.signature_file_id ? String(row.signature_file_id) : null;
  const rawSignatureUrl = row.signature_url ? String(row.signature_url).trim() : '';
  const signatureUrl = signatureFileId
    ? rawSignatureUrl || `/api/files/${encodeURIComponent(signatureFileId)}`
    : null;

  return {
    id: String(row.id),
    schemaVersion: Number(row.schema_version || CURRENT_SCHEMA_VERSION),
    version: Number(row.version || 1),
    salesOwnerId: String(row.sales_owner_id),
    salesOwnerName: String(row.sales_owner_name),
    customer: String(row.customer),
    proforma: String(row.proforma),
    finalInvoiceNo: String(row.final_invoice_no || ''),
    accountingNote: String(row.accounting_note || ''),
    channel: String(row.channel || ''),
    amountToman: row.amount_toman === null || row.amount_toman === undefined ? null : Number(row.amount_toman),
    payment: row.payment === null || row.payment === undefined ? null : String(row.payment),
    items: String(row.items),
    stage: Number(row.stage),
    status: row.status as OrderRecord['status'],
    rev: Number(row.rev || 0),
    returnReason: String(row.return_reason || ''),
    returnNote: String(row.return_note || ''),
    cartonsOut: row.cartons_out === null || row.cartons_out === undefined ? null : Number(row.cartons_out),
    exitTime: String(row.exit_time || ''),
    driverName: String(row.driver_name || ''),
    cartonsDelivered:
      row.cartons_delivered === null || row.cartons_delivered === undefined ? null : Number(row.cartons_delivered),
    cartonDiscrepancy: Number(row.carton_discrepancy || 0),
    discrepancyNote: String(row.discrepancy_note || ''),
    customerSigner: String(row.customer_signer || ''),
    signatureFileId,
    signatureUrl,
    stageHistory: history,
    documents: docs.map(
      (d): OrderDocumentRecord => ({
        id: d.id,
        orderId: d.order_id,
        docKind: d.doc_kind,
        versionNo: d.version_no,
        fileId: d.file_id,
        fileUrl: d.file_url || `/api/files/${encodeURIComponent(d.file_id)}`,
        originalName: d.original_name,
        mimeType: d.mime_type,
        uploadedBy: d.uploaded_by,
        createdAt: d.created_at,
      }),
    ),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function hydrateCheckRow(row: Record<string, unknown>): CheckRecord {
  const attachments = db
    .prepare(`
      SELECT id, check_id, file_id, file_url, original_name, mime_type, created_at
      FROM check_attachments
      WHERE check_id = ?
      ORDER BY created_at ASC
    `)
    .all(String(row.id)) as Array<{
      id: string;
      check_id: string;
      file_id: string;
      file_url: string;
      original_name: string;
      mime_type: string;
      created_at: string;
    }>;

  return {
    id: String(row.id),
    version: Number(row.version || 1),
    docType: row.doc_type as CheckRecord['docType'],
    customer: String(row.customer),
    amountToman: Number(row.amount_toman || 0),
    sayadiId: String(row.sayadi_id || ''),
    dueDate: String(row.due_date || ''),
    trackingNo: String(row.tracking_no || ''),
    caption: String(row.caption || ''),
    salesOwnerId: String(row.sales_owner_id),
    salesOwnerName: String(row.sales_owner_name),
    status: row.status as CheckRecord['status'],
    financeStatus: row.finance_status as CheckRecord['financeStatus'],
    financeTime: String(row.finance_time || ''),
    ceoStatus: row.ceo_status as CheckRecord['ceoStatus'],
    ceoTime: String(row.ceo_time || ''),
    finalizedTime: String(row.finalized_time || ''),
    rejectReason: String(row.reject_reason || ''),
    rejectedBy: String(row.rejected_by || ''),
    attachments: attachments.map(
      (a): CheckAttachmentRecord => ({
        id: a.id,
        checkId: a.check_id,
        fileId: a.file_id,
        fileUrl: a.file_url || `/api/files/${encodeURIComponent(a.file_id)}`,
        originalName: a.original_name,
        mimeType: a.mime_type,
        createdAt: a.created_at,
      }),
    ),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function hydrateProcurementRow(row: Record<string, unknown>): ProcurementItem {
  return {
    id: String(row.id),
    version: Number(row.version || 1),
    brand: String(row.brand),
    partName: String(row.part_name),
    partCode: String(row.part_code || ''),
    qtyNeeded: Number(row.qty_needed || 1),
    priority: (row.priority === 'فوری' ? 'فوری' : 'عادی'),
    status: row.status as ProcurementItem['status'],
    relatedOrderProforma: String(row.related_order_proforma || ''),
    reportedByName: String(row.reported_by_name || ''),
    supplierNote: String(row.supplier_note || ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
