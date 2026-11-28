import crypto from 'node:crypto';
import express, { Response } from 'express';
import multer from 'multer';
import {
  addAuditLog,
  db,
  getPublicUser,
  getSetting,
  hashPin,
  hashSessionToken,
  hydrateCheckRow,
  hydrateOrderRow,
  hydrateProcurementRow,
  isSystemInitialized,
  listPublicRoles,
  setSetting,
  verifyPinHash,
} from './db';
import {
  AuthedRequest,
  createAuthMiddleware,
  evaluateFileRbac,
  extractBearerToken,
  requireFinanceAccess,
  requireProcurementAccess,
  requireRoles,
  requireSalesRole,
} from './middleware/rbac';
import {
  fetchFileFromStorage,
  MAX_UPLOAD_BYTES,
  resolveStorageAccessUrl,
  uploadFileToStorage,
} from './storage';
import {
  syncCheckToSupabase,
  syncFileMetadataToSupabase,
  syncOrderToSupabase,
  syncProcurementToSupabase,
  logMirrorError,
} from './supabase-sync';
import { mirrorUsersAndSettingsToSupabase } from './supabase-restore';
import { extractInvoiceFields } from './invoice-extract';
import {
  AuditLogEntry,
  CheckRecord,
  IncrementalSyncResponse,
  OrderRecord,
  ProcurementItem,
  ProcurementStatus,
  RoleId,
  StageHistoryEntry,
  UserAccountPublic,
} from '../src/shared/types';
import {
  computeLatestCursor,
  parseSinceCursor,
} from '../src/shared/sync';
import {
  buildBoundedWhatsAppSummary,
  canRoleAccessFinance,
  canRoleAccessProcurement,
  canRoleActOnOrder,
  canRoleReviseCheck,
  canRoleViewOrder,
  computeCartonDiscrepancy,
  CURRENT_SCHEMA_VERSION,
  normalizeDigits,
  parseAmountToman,
  projectOrderForRole,
  validateSayadiId,
} from '../src/shared/workflow';

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

// ==================== SSE Live Change Notifier (Replaces 4.5s Full-Table Polling) ====================
const sseClients = new Set<Response>();

function broadcastChange(scope: 'orders' | 'checks' | 'procurement' | 'settings' | 'logs'): void {
  const payload = `data: ${JSON.stringify({ scope, updatedAt: new Date().toISOString() })}\n\n`;
  for (const res of sseClients) {
    try {
      res.write(payload);
    } catch {
      sseClients.delete(res);
    }
  }
}

// ==================== Session Verification & RBAC Middleware ====================
function authenticateToken(rawToken: string): { user: UserAccountPublic; tokenHash: string } | null {
  const tokenHash = hashSessionToken(rawToken);
  const nowIso = new Date().toISOString();
  const row = db
    .prepare(`SELECT user_id, expires_at FROM sessions WHERE token_hash = ?`)
    .get(tokenHash) as { user_id: string; expires_at: string } | undefined;

  if (!row) return null;
  if (row.expires_at <= nowIso) {
    db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(tokenHash);
    return null;
  }

  const user = getPublicUser(row.user_id);
  if (!user) return null;
  return { user, tokenHash };
}

const requireAuth = createAuthMiddleware(authenticateToken);

function createSessionForUser(userId: string): { token: string; expiresAt: string } {
  const rawToken = crypto.randomBytes(32).toString('hex');
  const tokenHash = hashSessionToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 12 * 60 * 60 * 1000).toISOString(); // 12h session
  db.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`).run(
    tokenHash,
    userId,
    now.toISOString(),
    expiresAt,
  );
  return { token: rawToken, expiresAt };
}

// ==================== Express Router ====================
/**
 * Multer decodes multipart file names as latin1, which turns Persian names into mojibake.
 * Re-decode as UTF-8 when the bytes form valid UTF-8; otherwise keep the original string.
 */
export function decodeUploadFileName(name: string): string {
  if (!name || /[^\u0000-\u00ff]/.test(name)) return name; // already proper Unicode
  const decoded = Buffer.from(name, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? name : decoded;
}

// ==================== Duplicate invoice detection ====================
const TEHRAN_DATE_FMT = new Intl.DateTimeFormat('fa-IR', {
  timeZone: 'Asia/Tehran',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const TEHRAN_TIME_FMT = new Intl.DateTimeFormat('fa-IR', {
  timeZone: 'Asia/Tehran',
  hour: '2-digit',
  minute: '2-digit',
  hour12: false,
});

function formatTehranDateTime(iso: string): { date: string; time: string } {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return { date: iso, time: '' };
  return { date: TEHRAN_DATE_FMT.format(d), time: TEHRAN_TIME_FMT.format(d) };
}

export interface DuplicateInvoiceInfo {
  orderId: string;
  number: string;
  registeredBy: string;
  registeredAt: string;
  message: string;
}

/** Finds an existing order with the same proforma number (case/digit-insensitive). */
export function findDuplicateProforma(proforma: string, excludeOrderId: string | null = null): DuplicateInvoiceInfo | null {
  const row = db
    .prepare(
      `SELECT id, proforma, sales_owner_name, created_at FROM orders WHERE lower(proforma) = lower(?) AND id != ? LIMIT 1`,
    )
    .get(proforma, excludeOrderId ?? '') as
    | { id: string; proforma: string; sales_owner_name: string; created_at: string }
    | undefined;
  if (!row) return null;
  const { date, time } = formatTehranDateTime(row.created_at);
  return {
    orderId: row.id,
    number: row.proforma,
    registeredBy: row.sales_owner_name,
    registeredAt: row.created_at,
    message: `این شماره پیش‌فاکتور («${row.proforma}») قبلاً توسط «${row.sales_owner_name}» در تاریخ ${date} ساعت ${time} ثبت شده است.`,
  };
}

/** Finds another order that already uses this final invoice number, with who issued it and when. */
export function findDuplicateFinalInvoice(finalInvoiceNo: string, excludeOrderId: string): DuplicateInvoiceInfo | null {
  const row = db
    .prepare(
      `SELECT id, final_invoice_no, proforma, customer, stage_history_json, updated_at
       FROM orders WHERE final_invoice_no != '' AND lower(final_invoice_no) = lower(?) AND id != ? LIMIT 1`,
    )
    .get(finalInvoiceNo, excludeOrderId) as
    | { id: string; final_invoice_no: string; proforma: string; customer: string; stage_history_json: string; updated_at: string }
    | undefined;
  if (!row) return null;

  // The stage-4 history entry records who issued the final invoice and when.
  let issuedBy = 'واحد حسابداری';
  let issuedAt = row.updated_at;
  try {
    const history = JSON.parse(row.stage_history_json || '[]') as StageHistoryEntry[];
    const issue = [...history].reverse().find((h) => h.stage === 4);
    if (issue) {
      issuedBy = issue.actorName || issuedBy;
      issuedAt = issue.timestamp || issuedAt;
    }
  } catch {
    // keep defaults
  }
  const { date, time } = formatTehranDateTime(issuedAt);
  return {
    orderId: row.id,
    number: row.final_invoice_no,
    registeredBy: issuedBy,
    registeredAt: issuedAt,
    message: `این شماره فاکتور نهایی («${row.final_invoice_no}») قبلاً توسط «${issuedBy}» در تاریخ ${date} ساعت ${time} برای پیش‌فاکتور «${row.proforma}» (مشتری «${row.customer}») ثبت شده است.`,
  };
}

export function createApiRouter(): express.Router {
  const router = express.Router();

  // Simple in-memory login rate limiter per IP
  const loginAttempts = new Map<string, { count: number; resetAt: number }>();

  // 1. Auth Status & Roles List (returns no PINs or secrets!)
  router.get('/auth/status', (_req, res) => {
    const initialized = isSystemInitialized();
    res.json({
      initialized,
      roles: listPublicRoles(),
    });
  });

  // 2. First-Run One-Time Admin Setup / Bootstrap (locks itself permanently once claimed)
  router.post('/auth/bootstrap', (req, res) => {
    if (isSystemInitialized()) {
      res.status(409).json({ error: 'سامانه قبلاً راه‌اندازی شده است. از صفحه ورود استفاده کنید.' });
      return;
    }

    const ceoPin = normalizeDigits(req.body?.ceoPin || '');
    const staffInitialPin = normalizeDigits(req.body?.staffInitialPin || '');
    const waPhone = normalizeDigits(req.body?.waPhone || '').trim();

    if (ceoPin.length < 4 || ceoPin.length > 16) {
      res.status(400).json({ error: 'رمز مدیرعامل باید بین ۴ تا ۱۶ کاراکتر باشد.' });
      return;
    }
    if (staffInitialPin && (staffInitialPin.length < 4 || staffInitialPin.length > 16)) {
      res.status(400).json({ error: 'رمز اولیه سایر واحدها باید بین ۴ تا ۱۶ کاراکتر باشد.' });
      return;
    }

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      // Atomic re-check inside transaction
      const ceoRow = db.prepare(`SELECT pin_hash FROM users WHERE id = 'ceo'`).get() as { pin_hash: string | null };
      if (ceoRow?.pin_hash) {
        throw new Error('ALREADY_INITIALIZED');
      }

      const ceoHashed = hashPin(ceoPin);
      db.prepare(`UPDATE users SET pin_hash = ?, pin_salt = ?, updated_at = ? WHERE id = 'ceo'`).run(
        ceoHashed.hash,
        ceoHashed.salt,
        now,
      );

      // If CEO provided an initial operational PIN for staff roles, hash it per-role with unique salts
      if (staffInitialPin) {
        const staffIds: RoleId[] = [
          'sales_1',
          'sales_2',
          'sales_3',
          'sales_4',
          'sales_mgr',
          'accounting',
          'warehouse_sup',
          'driver',
        ];
        for (const roleId of staffIds) {
          const hashed = hashPin(staffInitialPin);
          db.prepare(`UPDATE users SET pin_hash = ?, pin_salt = ?, updated_at = ? WHERE id = ?`).run(
            hashed.hash,
            hashed.salt,
            now,
            roleId,
          );
        }
      }

      if (waPhone) {
        setSetting('wa_phone', waPhone);
      }
      setSetting('initialized', '1');
      addAuditLog('ceo', 'مدیرعامل', 'security', 'راه‌اندازی اولیه سامانه و ثبت امن رمز عبور مدیرعامل انجام شد.');
    });

    try {
      tx();
    } catch (err) {
      if (err instanceof Error && err.message === 'ALREADY_INITIALIZED') {
        res.status(409).json({ error: 'سامانه قبلاً راه‌اندازی شده است.' });
        return;
      }
      throw err;
    }

    const user = getPublicUser('ceo')!;
    const session = createSessionForUser('ceo');
    void mirrorUsersAndSettingsToSupabase();
    res.status(201).json({ token: session.token, expiresAt: session.expiresAt, user });
  });

  // 3. Server-Side Role Login
  router.post('/auth/login', (req, res) => {
    const ip = req.ip || 'local';
    const nowMs = Date.now();
    const record = loginAttempts.get(ip);
    if (record && record.resetAt > nowMs && record.count >= 25) {
      res.status(429).json({ error: 'تعداد تلاش‌های ورود بیش از حد مجاز است. لطفاً کمی بعد دوباره تلاش کنید.' });
      return;
    }

    const roleId = String(req.body?.roleId || '').trim();
    const pin = normalizeDigits(req.body?.pin || '');

    if (!roleId || !pin) {
      res.status(400).json({ error: 'انتخاب کارتابل و وارد کردن رمز عبور الزامی است.' });
      return;
    }

    const userRow = db
      .prepare(`SELECT id, display_name, pin_hash, pin_salt FROM users WHERE id = ?`)
      .get(roleId) as
      | { id: RoleId; display_name: string; pin_hash: string | null; pin_salt: string | null }
      | undefined;

    if (!userRow) {
      res.status(401).json({ error: 'کارتابل یا رمز عبور نامعتبر است.' });
      return;
    }

    // process.env.CEO_INITIAL_PIN overrides stored CEO hash if configured
    let isValid = false;
    const envCeoPin = process.env.CEO_INITIAL_PIN ? normalizeDigits(process.env.CEO_INITIAL_PIN) : '';
    if (roleId === 'ceo' && envCeoPin.length >= 4) {
      const a = Buffer.from(pin);
      const b = Buffer.from(envCeoPin);
      isValid = a.length === b.length && crypto.timingSafeEqual(a, b);
    } else {
      isValid = verifyPinHash(pin, userRow.pin_hash, userRow.pin_salt);
    }

    if (!isValid) {
      const nextCount = record && record.resetAt > nowMs ? record.count + 1 : 1;
      loginAttempts.set(ip, { count: nextCount, resetAt: nowMs + 60_000 });
      res.status(401).json({
        error: userRow.pin_hash
          ? 'رمز عبور وارد شده برای این کارتابل صحیح نیست.'
          : 'برای این کارتابل هنوز رمزی توسط مدیرعامل تعریف نشده است.',
      });
      return;
    }

    loginAttempts.delete(ip);
    const session = createSessionForUser(userRow.id);
    const user = getPublicUser(userRow.id)!;
    res.json({ token: session.token, expiresAt: session.expiresAt, user });
  });

  router.post('/auth/logout', requireAuth, (req: AuthedRequest, res) => {
    if (req.sessionTokenHash) {
      db.prepare(`DELETE FROM sessions WHERE token_hash = ?`).run(req.sessionTokenHash);
    }
    res.json({ ok: true });
  });

  router.get('/auth/me', requireAuth, (req: AuthedRequest, res) => {
    res.json({ user: req.user, roles: listPublicRoles() });
  });

  // 4. Lightweight SSE Stream (replaces wasteful 4.5s base64 full-table polling)
  router.get('/events', (req, res) => {
    // EventSource cannot set Authorization headers easily, so we support short-lived SSE ticket or query token validated server-side
    const token = extractBearerToken(req) || (typeof req.query.token === 'string' ? req.query.token : '');
    if (!token || !authenticateToken(token)) {
      res.status(401).json({ error: 'احراز هویت الزامی است.' });
      return;
    }

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();
    res.write(`data: ${JSON.stringify({ scope: 'connected', updatedAt: new Date().toISOString() })}\n\n`);

    sseClients.add(res);
    const keepAlive = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        clearInterval(keepAlive);
        sseClients.delete(res);
      }
    }, 25_000);

    req.on('close', () => {
      clearInterval(keepAlive);
      sseClients.delete(res);
    });
  });

  // ==================== Secure Supabase Storage Upload & RBAC-Gated Serving ====================
  router.post('/files', requireAuth, (req: AuthedRequest, res) => {
    upload.single('file')(req, res, async (err) => {
      if (err) {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
          res.status(413).json({ error: 'حجم فایل بیشتر از ۵ مگابایت است. فایل قبلی بدون تغییر حفظ شد.' });
          return;
        }
        res.status(400).json({ error: 'خطا در دریافت فایل ارسالی.' });
        return;
      }

      if (!req.file) {
        res.status(400).json({ error: 'هیچ فایلی انتخاب نشده است.' });
        return;
      }

      const kind = String(req.body?.kind || 'order_doc');
      const ownerKind =
        kind === 'check_attachment' ? 'check_attachment' : kind === 'signature' ? 'signature' : 'order_doc';
      const allowPdf = ownerKind === 'order_doc';

      // RBAC check before storing binary object
      if (ownerKind === 'check_attachment' && !canRoleAccessFinance(req.user!.id)) {
        res.status(403).json({ error: 'نقش شما مجاز به بارگذاری مدارک مالی نیست.' });
        return;
      }
      if (ownerKind === 'signature' && req.user!.id !== 'driver') {
        res.status(403).json({ error: 'ثبت تصویر امضای تحویل فقط برای راننده مجاز است.' });
        return;
      }

      try {
        const stored = await uploadFileToStorage({
          buffer: req.file.buffer,
          originalName: decodeUploadFileName(req.file.originalname),
          ownerKind,
          allowPdf,
        });

        const now = new Date().toISOString();
        db.prepare(`
          INSERT INTO files (
            id, storage_provider, storage_bucket, storage_path, storage_url, stored_filename,
            original_name, mime_type, size_bytes, owner_kind, owner_record_id, uploaded_by, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, ?)
        `).run(
          stored.fileId,
          stored.storageProvider,
          stored.storageBucket,
          stored.storagePath,
          stored.storageUrl,
          stored.storedFilename,
          stored.originalName,
          stored.mimeType,
          stored.sizeBytes,
          ownerKind,
          req.user!.id,
          now,
        );

        // The Supabase metadata row is only a mirror: a mirror failure must never fail the upload
        // (the binary and the authoritative SQLite row are already stored at this point).
        await syncFileMetadataToSupabase(req.supabase, stored, ownerKind, null, req.user!.id).catch(
          logMirrorError('file', stored.fileId),
        );

        res.status(201).json({
          fileId: stored.fileId,
          fileUrl: stored.storageUrl,
          storageUrl: stored.storageUrl,
          mimeType: stored.mimeType,
          originalName: stored.originalName,
          storageProvider: stored.storageProvider,
        });
      } catch (validationErr) {
        res.status(400).json({
          error: validationErr instanceof Error ? validationErr.message : 'فایل نامعتبر است.',
        });
      }
    });
  });

  function loadAndAuthorizeFile(
    fileId: string,
    user: UserAccountPublic,
  ):
    | {
        ok: true;
        fileRow: {
          id: string;
          storage_provider: string;
          storage_bucket: string;
          storage_path: string;
          storage_url: string;
          stored_filename: string;
          original_name: string;
          mime_type: string;
          owner_kind: string;
          owner_record_id: string | null;
          uploaded_by: string;
        };
      }
    | { ok: false; status: number; error: string } {
    const fileRow = db
      .prepare(`
        SELECT id, storage_provider, storage_bucket, storage_path, storage_url, stored_filename,
               original_name, mime_type, owner_kind, owner_record_id, uploaded_by
        FROM files WHERE id = ?
      `)
      .get(fileId) as
      | {
          id: string;
          storage_provider: string;
          storage_bucket: string;
          storage_path: string;
          storage_url: string;
          stored_filename: string;
          original_name: string;
          mime_type: string;
          owner_kind: string;
          owner_record_id: string | null;
          uploaded_by: string;
        }
      | undefined;

    if (!fileRow) {
      return { ok: false, status: 404, error: 'فایل مورد نظر یافت نشد.' };
    }

    let checkSalesOwnerId: string | null = null;
    let orderMeta: { salesOwnerId: string; stage: number; status: OrderRecord['status'] } | null = null;

    if (fileRow.owner_kind === 'check_attachment' && fileRow.owner_record_id) {
      const chk = db
        .prepare(`SELECT sales_owner_id FROM checks WHERE id = ?`)
        .get(fileRow.owner_record_id) as { sales_owner_id: string } | undefined;
      checkSalesOwnerId = chk?.sales_owner_id ?? null;
    } else if ((fileRow.owner_kind === 'order_doc' || fileRow.owner_kind === 'signature') && fileRow.owner_record_id) {
      const ord = db
        .prepare(`SELECT sales_owner_id, stage, status FROM orders WHERE id = ?`)
        .get(fileRow.owner_record_id) as
        | { sales_owner_id: string; stage: number; status: OrderRecord['status'] }
        | undefined;
      if (ord) {
        orderMeta = { salesOwnerId: ord.sales_owner_id, stage: ord.stage, status: ord.status };
      }
    }

    const rbacCheck = evaluateFileRbac({
      user,
      ownerKind: fileRow.owner_kind,
      uploadedBy: fileRow.uploaded_by,
      ownerRecordId: fileRow.owner_record_id,
      checkSalesOwnerId,
      orderMeta,
    });

    if (!rbacCheck.allowed) {
      return { ok: false, status: 403, error: rbacCheck.error || 'دسترسی به این فایل مجاز نیست.' };
    }

    return { ok: true, fileRow };
  }

  router.get('/files/:id', requireAuth, async (req: AuthedRequest, res) => {
    const fileId = String(req.params.id || '').trim();
    const authz = loadAndAuthorizeFile(fileId, req.user!);
    if (!authz.ok) {
      res.status(authz.status).json({ error: authz.error });
      return;
    }

    const { fileRow } = authz;
    const streamResult = await fetchFileFromStorage({
      storageProvider: fileRow.storage_provider,
      storageBucket: fileRow.storage_bucket,
      storagePath: fileRow.storage_path,
      storedFilename: fileRow.stored_filename,
    });

    if (!streamResult) {
      res.status(404).json({ error: 'فایل در مخزن ذخیره‌سازی یافت نشد.' });
      return;
    }

    // Security headers to completely prevent stored XSS execution inside file views
    res.setHeader('Content-Type', fileRow.mime_type);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'");
    res.setHeader('Cache-Control', 'private, max-age=300');
    if (req.query.download === '1') {
      res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(fileRow.original_name)}`);
    } else {
      res.setHeader('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(fileRow.original_name)}`);
    }

    streamResult.stream.pipe(res);
  });

  // Supabase Storage URL resolver (public URL when SUPABASE_STORAGE_PUBLIC=true, else 60s RBAC-gated signed URL)
  router.post('/files/:id/signed-url', requireAuth, async (req: AuthedRequest, res) => {
    const fileId = String(req.params.id || '').trim();
    const authz = loadAndAuthorizeFile(fileId, req.user!);
    if (!authz.ok) {
      res.status(authz.status).json({ error: authz.error });
      return;
    }

    const { fileRow } = authz;
    const access = await resolveStorageAccessUrl({
      fileId: fileRow.id,
      storageProvider: fileRow.storage_provider,
      storageBucket: fileRow.storage_bucket,
      storagePath: fileRow.storage_path,
      storageUrl: fileRow.storage_url,
      expiresInSeconds: 60,
    });

    res.json({
      url: access.url,
      accessMode: access.accessMode,
      mimeType: fileRow.mime_type,
      originalName: fileRow.original_name,
      storageProvider: access.storageProvider,
      expiresInSeconds: access.expiresInSeconds,
    });
  });

  // ==================== Incremental Fetching Endpoint (`updated_at > since`) ====================
  const SYNC_OVERLAP_MS = 5_000;
  router.get('/sync', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.user!;
    const rawSince = req.query.since;
    if (rawSince !== undefined && rawSince !== '' && parseSinceCursor(rawSince) === null) {
      res.status(400).json({ error: 'پارامتر since باید تاریخ معتبر با فرمت استاندارد ISO-8601 باشد.' });
      return;
    }

    const since = parseSinceCursor(rawSince);
    const serverTime = new Date().toISOString();

    // SQLite is the authoritative store (Supabase is a mirror), so deltas always come from SQLite.
    // Reading the mirror here could miss writes whose mirror call failed or is still in flight.
    const source: 'supabase' | 'local' = 'local';
    let orders: OrderRecord[] = [];
    let checks: CheckRecord[] = [];
    let procurement: ProcurementItem[] = [];
    const removedOrderIds: string[] = [];
    const removedCheckIds: string[] = [];
    const allChangedTimestamps: string[] = [];

    // Re-read a small overlap window before the cursor so a write that committed slightly out of
    // timestamp order is never skipped. The client merges by id, so duplicates are harmless.
    const sinceQuery = since ? new Date(Date.parse(since) - SYNC_OVERLAP_MS).toISOString() : null;

    const orderRows = sinceQuery
      ? (db
          .prepare(`SELECT * FROM orders WHERE updated_at > ? ORDER BY updated_at DESC`)
          .all(sinceQuery) as Array<Record<string, unknown>>)
      : (db.prepare(`SELECT * FROM orders ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>);

    for (const order of orderRows.map(hydrateOrderRow)) {
      allChangedTimestamps.push(order.updatedAt);
      if (canRoleViewOrder(user.id, order)) {
        orders.push(projectOrderForRole(user.id, order));
      } else if (sinceQuery) {
        // Changed and no longer visible to this role (e.g. returned to an earlier stage): tell the
        // client to drop its stale copy. Only the id is sent, never the record contents.
        removedOrderIds.push(order.id);
      }
    }

    if (canRoleAccessFinance(user.id)) {
      const checkRows = sinceQuery
        ? (db
            .prepare(`SELECT * FROM checks WHERE updated_at > ? ORDER BY updated_at DESC`)
            .all(sinceQuery) as Array<Record<string, unknown>>)
        : (db.prepare(`SELECT * FROM checks ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>);

      for (const chk of checkRows.map(hydrateCheckRow)) {
        allChangedTimestamps.push(chk.updatedAt);
        if (!user.isSales || chk.salesOwnerId === user.id) {
          checks.push(chk);
        } else if (sinceQuery) {
          removedCheckIds.push(chk.id);
        }
      }
    }

    if (canRoleAccessProcurement(user.id)) {
      const procRows = sinceQuery
        ? (db
            .prepare(`SELECT * FROM procurement_items WHERE updated_at > ? ORDER BY updated_at DESC`)
            .all(sinceQuery) as Array<Record<string, unknown>>)
        : (db
            .prepare(`SELECT * FROM procurement_items ORDER BY updated_at DESC`)
            .all() as Array<Record<string, unknown>>);

      procurement = procRows.map(hydrateProcurementRow);
      allChangedTimestamps.push(...procurement.map((p) => p.updatedAt));
    }

    const cursor = computeLatestCursor(allChangedTimestamps, since) || serverTime;
    const payload: IncrementalSyncResponse = {
      cursor,
      serverTime,
      since,
      isIncremental: Boolean(since),
      source,
      changedCount: orders.length + checks.length + procurement.length,
      orders,
      checks,
      procurement,
      removedOrderIds,
      removedCheckIds,
    };
    res.json(payload);
  });

  // ==================== Orders Endpoints (Phase 1) ====================
  router.get('/orders', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const includeArchived = req.query.archived === '1';
    const filter = String(req.query.filter || 'all');
    const stageParam = req.query.stage ? Number(req.query.stage) : null;
    const search = String(req.query.search || '').trim().toLowerCase();
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(50, Math.max(5, Number(req.query.limit || 20)));

    const since = parseSinceCursor(req.query.since);
    const allRows = since
      ? (db.prepare(`SELECT * FROM orders WHERE updated_at > ? ORDER BY updated_at DESC`).all(since) as Array<Record<string, unknown>>)
      : (db.prepare(`SELECT * FROM orders ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>);
    const visibleAll = allRows
      .map(hydrateOrderRow)
      .filter((o) => canRoleViewOrder(user.id, o))
      .map((o) => projectOrderForRole(user.id, o));

    // Calculate live role-scoped summary stats before pagination
    const stats = {
      total: visibleAll.length,
      salesFlow: visibleAll.filter((o) => o.stage <= 4).length,
      warehouse: visibleAll.filter((o) => o.status === 'active' && o.stage === 5).length,
      driver: visibleAll.filter((o) => o.status === 'active' && o.stage === 6).length,
      delivered: visibleAll.filter((o) => o.stage >= 7).length,
      returned: visibleAll.filter((o) => o.status !== 'active').length,
      totalActiveAmountToman: visibleAll
        .filter((o) => o.stage < 7)
        .reduce((sum, o) => sum + (o.amountToman || 0), 0),
      totalDeliveredAmountToman: visibleAll
        .filter((o) => o.stage >= 7)
        .reduce((sum, o) => sum + (o.amountToman || 0), 0),
    };

    const stageCounts: Record<number, number> = {
      1: visibleAll.filter((o) => o.status === 'returned_to_sales').length,
      2: visibleAll.filter((o) => (o.status === 'active' && o.stage === 2) || o.status === 'returned_to_sales_mgr').length,
      3: visibleAll.filter((o) => o.status === 'active' && o.stage === 3).length,
      4: visibleAll.filter((o) => (o.status === 'active' && o.stage === 4) || o.status === 'returned_to_accounting').length,
      5: visibleAll.filter((o) => o.status === 'active' && o.stage === 5).length,
      6: visibleAll.filter((o) => o.status === 'active' && o.stage === 6).length,
    };

    // CEO per-sales-rep breakdown with real Toman totals
    const repBreakdown =
      user.id === 'ceo' || user.id === 'sales_mgr'
        ? listPublicRoles()
            .filter((r) => r.isSales)
            .map((sr) => {
              const repOrders = visibleAll.filter((o) => o.salesOwnerId === sr.id);
              return {
                roleId: sr.id,
                displayName: sr.displayName,
                total: repOrders.length,
                inProgress: repOrders.filter((o) => o.status === 'active' && o.stage < 7).length,
                returned: repOrders.filter((o) => o.status !== 'active').length,
                delivered: repOrders.filter((o) => o.stage >= 7).length,
                totalAmountToman: repOrders.reduce((s, o) => s + (o.amountToman || 0), 0),
              };
            })
        : [];

    // Apply requested filter
    let filtered = visibleAll;
    if (stageParam !== null && Number.isFinite(stageParam)) {
      if (stageParam === 1) filtered = filtered.filter((o) => o.status === 'returned_to_sales');
      else if (stageParam === 2)
        filtered = filtered.filter((o) => (o.status === 'active' && o.stage === 2) || o.status === 'returned_to_sales_mgr');
      else if (stageParam === 4)
        filtered = filtered.filter((o) => (o.status === 'active' && o.stage === 4) || o.status === 'returned_to_accounting');
      else filtered = filtered.filter((o) => o.status === 'active' && o.stage === stageParam);
    } else if (filter === 'mine') {
      filtered = user.id === 'ceo' ? filtered.filter((o) => o.stage < 7) : filtered.filter((o) => canRoleActOnOrder(user.id, o));
    } else if (filter === 'returned') {
      filtered = filtered.filter((o) => o.status !== 'active');
    } else if (filter === 'warehouse') {
      filtered = filtered.filter((o) => o.status === 'active' && o.stage === 5);
    } else if (filter === 'driver') {
      filtered = filtered.filter((o) => o.status === 'active' && o.stage === 6);
    } else if (filter === 'done' || includeArchived) {
      filtered = filtered.filter((o) => o.stage >= 7);
    } else if (filter === 'active') {
      filtered = filtered.filter((o) => o.stage < 7);
    }

    if (search) {
      filtered = filtered.filter(
        (o) =>
          o.customer.toLowerCase().includes(search) ||
          o.proforma.toLowerCase().includes(search) ||
          o.finalInvoiceNo.toLowerCase().includes(search) ||
          o.items.toLowerCase().includes(search),
      );
    }

    const totalFiltered = filtered.length;
    const totalPages = Math.max(1, Math.ceil(totalFiltered / limit));
    const safePage = Math.min(page, totalPages);
    const items = filtered.slice((safePage - 1) * limit, safePage * limit);

    const syncCursor = computeLatestCursor(visibleAll.map((o) => o.updatedAt), since) || new Date().toISOString();

    res.json({
      items,
      pagination: { page: safePage, limit, total: totalFiltered, totalPages },
      stats,
      stageCounts,
      repBreakdown,
      syncCursor,
    });
  });

  // Create new proforma order (sales reps only via RBAC middleware, duplicate proforma guard, structured numeric amount)
  // ==================== Invoice auto-fill (server-side PDF text + header OCR) ====================
  // The rep uploads the invoice first (POST /files), then asks the server to read it. Only the
  // uploader may read their own not-yet-attached file. Nothing leaves the server.
  router.post('/invoices/extract', requireAuth, requireSalesRole, async (req: AuthedRequest, res) => {
    const user = req.user!;
    const fileId = String(req.body?.fileId || '').trim();
    const fileRow = db
      .prepare(
        `SELECT id, storage_provider, storage_bucket, storage_path, stored_filename, original_name, mime_type, uploaded_by, owner_record_id FROM files WHERE id = ?`,
      )
      .get(fileId) as
      | {
          id: string;
          storage_provider: string;
          storage_bucket: string;
          storage_path: string;
          stored_filename: string;
          original_name: string;
          mime_type: string;
          uploaded_by: string;
          owner_record_id: string | null;
        }
      | undefined;

    if (!fileRow || fileRow.uploaded_by !== user.id || fileRow.owner_record_id) {
      res.status(404).json({ error: 'فایل بارگذاری‌شده پیدا نشد.' });
      return;
    }
    if (fileRow.mime_type !== 'application/pdf') {
      res.json({
        result: {
          ok: false,
          error: 'خواندن خودکار فقط برای فایل PDF فاکتور ممکن است؛ لطفاً اطلاعات را دستی وارد کنید.',
        },
      });
      return;
    }

    const streamResult = await fetchFileFromStorage({
      storageProvider: fileRow.storage_provider,
      storageBucket: fileRow.storage_bucket,
      storagePath: fileRow.storage_path,
      storedFilename: fileRow.stored_filename,
    });
    if (!streamResult) {
      res.status(404).json({ error: 'فایل در مخزن ذخیره‌سازی یافت نشد.' });
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of streamResult.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }

    const result = await extractInvoiceFields(Buffer.concat(chunks), fileRow.original_name);

    // Customer name: look up the buyer code learned from earlier orders.
    let customerName: string | null = null;
    if (result.buyerCode) {
      const row = db.prepare(`SELECT customer_name FROM customer_codes WHERE code = ?`).get(result.buyerCode) as
        | { customer_name: string }
        | undefined;
      customerName = row?.customer_name ?? null;
    }

    // Duplicate check right away, so the rep sees it before filling anything else.
    const duplicate = result.invoiceNumber ? findDuplicateProforma(result.invoiceNumber) : null;

    res.json({ result, customerName, duplicate });
  });

  // Instant duplicate check while the rep is filling the form (before submit).
  router.get('/orders/check-proforma', requireAuth, requireSalesRole, (req: AuthedRequest, res) => {
    const number = normalizeDigits(String(req.query.number || '')).trim();
    const excludeOrderId = req.query.excludeOrderId ? String(req.query.excludeOrderId) : null;
    if (!number || number.length > 60) {
      res.json({ duplicate: null });
      return;
    }
    const dup = findDuplicateProforma(number, excludeOrderId);
    res.json({ duplicate: dup });
  });

  router.post('/orders', requireAuth, requireSalesRole, async (req: AuthedRequest, res) => {
    const user = req.user!;

    const customer = String(req.body?.customer || '').trim();
    const proforma = normalizeDigits(String(req.body?.proforma || '')).trim();
    const channel = String(req.body?.channel || 'تلفنی').trim();
    const payment = String(req.body?.payment || 'نقدی / واریز آنی').trim();
    const items = String(req.body?.items || '').trim();
    const amountParsed = parseAmountToman(req.body?.amountToman ?? req.body?.amount);
    const fileId = req.body?.fileId ? String(req.body.fileId).trim() : null;
    // Buyer code read from the invoice (optional). Used to remember code -> customer name.
    const customerCodeRaw = normalizeDigits(String(req.body?.customerCode || '')).trim();
    const customerCode = /^\d{2,12}$/.test(customerCodeRaw) ? customerCodeRaw : null;

    if (!customer || !proforma || !items) {
      res.status(400).json({ error: 'نام مشتری، شماره پیش‌فاکتور و شرح اقلام الزامی است.' });
      return;
    }
    if (amountParsed === null || amountParsed <= 0) {
      res.status(400).json({ error: 'لطفاً مبلغ پیش‌فاکتور را به صورت عدد معتبر (بزرگ‌تر از صفر) وارد کنید.' });
      return;
    }

    const dup = findDuplicateProforma(proforma);
    if (dup) {
      res.status(409).json({ error: dup.message, duplicate: dup });
      return;
    }

    const now = new Date().toISOString();
    const orderId = `ord-${crypto.randomUUID().slice(0, 10)}`;
    const history: StageHistoryEntry[] = [
      { stage: 1, action: 'ثبت پیش‌فاکتور', actorName: user.displayName, timestamp: now },
    ];

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO orders (
          id, schema_version, version, sales_owner_id, sales_owner_name, customer, proforma,
          final_invoice_no, accounting_note, channel, amount_toman, payment, items, stage, status,
          rev, return_reason, return_note, cartons_out, exit_time, driver_name, cartons_delivered,
          carton_discrepancy, discrepancy_note, customer_signer, signature_file_id,
          stage_history_json, created_at, updated_at
        ) VALUES (
          ?, ?, 1, ?, ?, ?, ?, '', '', ?, ?, ?, ?, 2, 'active',
          0, '', '', NULL, '', '', NULL, 0, '', '', NULL, ?, ?, ?
        )
      `).run(
        orderId,
        CURRENT_SCHEMA_VERSION,
        user.id,
        user.displayName,
        customer,
        proforma,
        channel,
        amountParsed,
        payment,
        items,
        JSON.stringify(history),
        now,
        now,
      );

      if (fileId) {
        const fRow = db
          .prepare(`SELECT id, storage_url, original_name, mime_type, uploaded_by FROM files WHERE id = ?`)
          .get(fileId) as { id: string; storage_url: string; original_name: string; mime_type: string; uploaded_by: string } | undefined;
        if (fRow && fRow.uploaded_by === user.id) {
          const resolvedUrl = fRow.storage_url || `/api/files/${encodeURIComponent(fRow.id)}`;
          db.prepare(`UPDATE files SET owner_kind = 'order_doc', owner_record_id = ? WHERE id = ?`).run(orderId, fileId);
          db.prepare(`
            INSERT INTO order_documents (id, order_id, doc_kind, version_no, file_id, file_url, original_name, mime_type, uploaded_by, created_at)
            VALUES (?, ?, 'proforma', 1, ?, ?, ?, ?, ?, ?)
          `).run(`doc-${crypto.randomUUID().slice(0, 8)}`, orderId, fRow.id, resolvedUrl, fRow.original_name, fRow.mime_type, user.displayName, now);
        }
      }

      addAuditLog(
        user.id,
        user.displayName,
        'order',
        `پیش‌فاکتور جدید «${proforma}» برای «${customer}» به مبلغ ${new Intl.NumberFormat('fa-IR').format(amountParsed)} تومان ثبت و به مدیر فروش ارسال شد.`,
      );
    });

    tx();

    if (customerCode) {
      db.prepare(`
        INSERT INTO customer_codes (code, customer_name, updated_by, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET customer_name = excluded.customer_name,
          updated_by = excluded.updated_by, updated_at = excluded.updated_at
      `).run(customerCode, customer, user.id, now);
      if (req.supabase) {
        const { error: codeErr } = await req.supabase
          .from('customer_codes')
          .upsert({ code: customerCode, customer_name: customer, updated_by: user.id, updated_at: now }, { onConflict: 'code' });
        if (codeErr) console.error(`[Supabase mirror] customer code ${customerCode}:`, codeErr.message);
      }
    }

    const created = hydrateOrderRow(db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId) as Record<string, unknown>);
    await syncOrderToSupabase(req.supabase, created).catch(logMirrorError('order', created.id));
    broadcastChange('orders');
    res.status(201).json({ order: created });
  });

  // Helper to fetch + verify optimistic version lock
  function getOrderWithVersionCheck(orderId: string, expectedVersion: number): { order?: OrderRecord; error?: { status: number; message: string } } {
    const row = db.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId) as Record<string, unknown> | undefined;
    if (!row) return { error: { status: 404, message: 'سفارش مورد نظر یافت نشد.' } };
    const order = hydrateOrderRow(row);
    if (Number.isFinite(expectedVersion) && order.version !== expectedVersion) {
      return {
        error: {
          status: 409,
          message: 'این سفارش هم‌زمان توسط کاربر دیگری تغییر کرده است. صفحه به‌روزرسانی شد؛ لطفاً وضعیت جدید را بررسی کنید.',
        },
      };
    }
    return { order };
  }

  // Advance stages 2 -> 3 (sales_mgr) and 3 -> 4 (sales owner)
  router.post(
    '/orders/:id/advance',
    requireAuth,
    requireRoles(['sales_mgr', 'sales_1', 'sales_2', 'sales_3', 'sales_4'], 'شما مجاز به تایید این مرحله از سفارش نیستید.'),
    async (req: AuthedRequest, res) => {
      const user = req.user!;
      const expectedVersion = Number(req.body?.expectedVersion);
      const check = getOrderWithVersionCheck(String(req.params.id), expectedVersion);
      if (check.error || !check.order) {
        res.status(check.error!.status).json({ error: check.error!.message });
        return;
      }

      const order = check.order;
      if (!canRoleActOnOrder(user.id, order) || (order.stage !== 2 && order.stage !== 3) || order.status !== 'active') {
        res.status(403).json({ error: 'شما مجاز به تایید این مرحله از سفارش نیستید.' });
        return;
      }

      const now = new Date().toISOString();
      const nextStage = order.stage === 2 ? 3 : 4;
      const actionLabel = order.stage === 2 ? 'تایید مدیر فروش' : 'ثبت تاییدیه مشتری';
      const nextHistory: StageHistoryEntry[] = [
        ...order.stageHistory,
        { stage: order.stage, action: actionLabel, actorName: user.displayName, timestamp: now },
      ];

      const updated = db
        .prepare(`UPDATE orders SET stage = ?, stage_history_json = ?, version = version + 1, updated_at = ? WHERE id = ? AND version = ?`)
        .run(nextStage, JSON.stringify(nextHistory), now, order.id, order.version);

      if (updated.changes === 0) {
        res.status(409).json({ error: 'تداخل ویرایش هم‌زمان رخ داد؛ لطفاً دوباره تلاش کنید.' });
        return;
      }

      addAuditLog(
        user.id,
        user.displayName,
        'order',
        order.stage === 2
          ? `مدیر فروش پیش‌فاکتور «${order.proforma}» (${order.customer}) را تایید کرد و جهت اخذ تاییدیه مشتری ارسال نمود.`
          : `تاییدیه مشتری برای پیش‌فاکتور «${order.proforma}» (${order.customer}) ثبت و به واحد حسابداری ارسال شد.`,
      );

      const fresh = hydrateOrderRow(db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id) as Record<string, unknown>);
      await syncOrderToSupabase(req.supabase, fresh).catch(logMirrorError('order', fresh.id));
      broadcastChange('orders');
      res.json({ order: fresh });
    },
  );

  // Sales manager resolves return from accounting -> send back to accounting (stage 4)
  router.post(
    '/orders/:id/mgr-resolve',
    requireAuth,
    requireRoles(['sales_mgr'], 'این اقدام فقط برای مدیر فروش در وضعیت عودت مالی مجاز است.'),
    async (req: AuthedRequest, res) => {
    const user = req.user!;
    const expectedVersion = Number(req.body?.expectedVersion);
    const check = getOrderWithVersionCheck(String(req.params.id), expectedVersion);
    if (check.error || !check.order) {
      res.status(check.error!.status).json({ error: check.error!.message });
      return;
    }
    const order = check.order;
    if (user.id !== 'sales_mgr' || order.status !== 'returned_to_sales_mgr') {
      res.status(403).json({ error: 'این اقدام فقط برای مدیر فروش در وضعیت عودت مالی مجاز است.' });
      return;
    }

    const now = new Date().toISOString();
    const nextHistory: StageHistoryEntry[] = [
      ...order.stageHistory,
      { stage: 2, action: 'رسیدگی به مغایرت مالی و ارسال مجدد به حسابداری', actorName: user.displayName, timestamp: now },
    ];

    const updated = db
      .prepare(`
        UPDATE orders
        SET status = 'active', stage = 4, return_reason = '', return_note = '',
            stage_history_json = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `)
      .run(JSON.stringify(nextHistory), now, order.id, order.version);

    if (updated.changes === 0) {
      res.status(409).json({ error: 'تداخل ویرایش هم‌زمان رخ داد.' });
      return;
    }

    addAuditLog(user.id, user.displayName, 'order', `مدیر فروش مغایرت پیش‌فاکتور «${order.proforma}» (${order.customer}) را بررسی و به حسابداری ارسال کرد.`);
    const fresh = hydrateOrderRow(db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id) as Record<string, unknown>);
    await syncOrderToSupabase(req.supabase, fresh).catch(logMirrorError('order', fresh.id));
    broadcastChange('orders');
    res.json({ order: fresh });
  });

  // Stage 4: Accounting converts proforma to final invoice (or fixes warehouse return) — PRESERVES proforma doc history!
  router.post(
    '/orders/:id/convert-invoice',
    requireAuth,
    requireRoles(['accounting'], 'تبدیل یا اصلاح فاکتور فقط برای واحد حسابداری در مرحله ۴ مجاز است.'),
    async (req: AuthedRequest, res) => {
    const user = req.user!;
    const expectedVersion = Number(req.body?.expectedVersion);
    const check = getOrderWithVersionCheck(String(req.params.id), expectedVersion);
    if (check.error || !check.order) {
      res.status(check.error!.status).json({ error: check.error!.message });
      return;
    }
    const order = check.order;
    const canConvert =
      user.id === 'accounting' &&
      ((order.status === 'active' && order.stage === 4) || order.status === 'returned_to_accounting');

    if (!canConvert) {
      res.status(403).json({ error: 'تبدیل یا اصلاح فاکتور فقط برای واحد حسابداری در مرحله ۴ مجاز است.' });
      return;
    }

    const finalInvoiceNo = normalizeDigits(String(req.body?.finalInvoiceNo || '')).trim();
    const amountParsed =
      req.body?.amountToman !== undefined && req.body?.amountToman !== ''
        ? parseAmountToman(req.body.amountToman)
        : order.amountToman;
    const newItems = String(req.body?.items || '').trim() || order.items;
    const accountingNote = String(req.body?.accountingNote || '').trim();
    const fileId = req.body?.fileId ? String(req.body.fileId).trim() : null;

    if (!finalInvoiceNo) {
      res.status(400).json({ error: 'شماره فاکتور فروش نهایی الزامی است.' });
      return;
    }
    const dupFinal = findDuplicateFinalInvoice(finalInvoiceNo, order.id);
    if (dupFinal) {
      res.status(409).json({ error: dupFinal.message, duplicate: dupFinal });
      return;
    }
    if (amountParsed === null || amountParsed <= 0) {
      res.status(400).json({ error: 'مبلغ فاکتور باید عدد معتبر بزرگ‌تر از صفر باشد.' });
      return;
    }

    const now = new Date().toISOString();
    const wasReturn = order.status === 'returned_to_accounting';
    const nextRev = wasReturn ? order.rev + 1 : order.rev;
    const nextHistory: StageHistoryEntry[] = [
      ...order.stageHistory,
      {
        stage: 4,
        action: wasReturn
          ? `اصلاح فاکتور نهایی ${finalInvoiceNo} (اصلاحیه #${nextRev})`
          : `صدور فاکتور فروش نهایی ${finalInvoiceNo}`,
        actorName: user.displayName,
        timestamp: now,
        note: accountingNote || undefined,
      },
    ];

    const tx = db.transaction(() => {
      const updated = db
        .prepare(`
          UPDATE orders
          SET final_invoice_no = ?, amount_toman = ?, items = ?, accounting_note = ?,
              rev = ?, return_reason = '', return_note = '', status = 'active', stage = 5,
              stage_history_json = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?
        `)
        .run(
          finalInvoiceNo,
          amountParsed,
          newItems,
          accountingNote,
          nextRev,
          JSON.stringify(nextHistory),
          now,
          order.id,
          order.version,
        );

      if (updated.changes === 0) {
        throw new Error('VERSION_CONFLICT');
      }

      // Append final invoice document WITHOUT deleting/overwriting the original proforma!
      if (fileId) {
        const fRow = db
          .prepare(`SELECT id, storage_url, original_name, mime_type, uploaded_by FROM files WHERE id = ?`)
          .get(fileId) as { id: string; storage_url: string; original_name: string; mime_type: string; uploaded_by: string } | undefined;
        if (fRow && fRow.uploaded_by === user.id) {
          const maxVer = (
            db
              .prepare(`SELECT COALESCE(MAX(version_no), 0) as mv FROM order_documents WHERE order_id = ? AND doc_kind = 'final_invoice'`)
              .get(order.id) as { mv: number }
          ).mv;
          const resolvedUrl = fRow.storage_url || `/api/files/${encodeURIComponent(fRow.id)}`;
          db.prepare(`UPDATE files SET owner_kind = 'order_doc', owner_record_id = ? WHERE id = ?`).run(order.id, fileId);
          db.prepare(`
            INSERT INTO order_documents (id, order_id, doc_kind, version_no, file_id, file_url, original_name, mime_type, uploaded_by, created_at)
            VALUES (?, ?, 'final_invoice', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            `doc-${crypto.randomUUID().slice(0, 8)}`,
            order.id,
            maxVer + 1,
            fRow.id,
            resolvedUrl,
            fRow.original_name,
            fRow.mime_type,
            user.displayName,
            now,
          );
        }
      }

      addAuditLog(
        user.id,
        user.displayName,
        'order',
        wasReturn
          ? `واحد مالی مغایرت انبار فاکتور «${finalInvoiceNo}» (${order.customer}) را اصلاح و مجدداً به انبار ارسال کرد.`
          : `پیش‌فاکتور «${order.proforma}» (${order.customer}) به فاکتور نهایی «${finalInvoiceNo}» تبدیل و به انبار ارسال شد.`,
      );
    });

    try {
      tx();
    } catch (e) {
      if (e instanceof Error && e.message === 'VERSION_CONFLICT') {
        res.status(409).json({ error: 'تداخل ویرایش هم‌زمان رخ داد؛ صفحه را به‌روزرسانی کنید.' });
        return;
      }
      throw e;
    }

    const fresh = hydrateOrderRow(db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id) as Record<string, unknown>);
    await syncOrderToSupabase(req.supabase, fresh).catch(logMirrorError('order', fresh.id));
    broadcastChange('orders');
    res.json({ order: fresh });
  });

  // Stage 5: Warehouse Exit
  router.post(
    '/orders/:id/warehouse-exit',
    requireAuth,
    requireRoles(['warehouse_sup'], 'ثبت خروج بار فقط برای سرپرست انبار در مرحله ۵ مجاز است.'),
    async (req: AuthedRequest, res) => {
    const user = req.user!;
    const expectedVersion = Number(req.body?.expectedVersion);
    const check = getOrderWithVersionCheck(String(req.params.id), expectedVersion);
    if (check.error || !check.order) {
      res.status(check.error!.status).json({ error: check.error!.message });
      return;
    }
    const order = check.order;
    if (user.id !== 'warehouse_sup' || order.status !== 'active' || order.stage !== 5) {
      res.status(403).json({ error: 'ثبت خروج بار فقط برای سرپرست انبار در مرحله ۵ مجاز است.' });
      return;
    }

    const cartonsOut = Number(normalizeDigits(String(req.body?.cartonsOut || '')));
    const exitTime = normalizeDigits(String(req.body?.exitTime || '')).trim();
    const driverName = String(req.body?.driverName || '').trim();

    if (!Number.isInteger(cartonsOut) || cartonsOut < 1 || !driverName) {
      res.status(400).json({ error: 'تعداد کارتن معتبر (حداقل ۱) و نام راننده الزامی است.' });
      return;
    }

    const now = new Date().toISOString();
    const effectiveExitTime = exitTime || new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const nextHistory: StageHistoryEntry[] = [
      ...order.stageHistory,
      {
        stage: 5,
        action: `خروج از انبار (${cartonsOut} کارتن - ${driverName})`,
        actorName: user.displayName,
        timestamp: now,
      },
    ];

    const updated = db
      .prepare(`
        UPDATE orders
        SET cartons_out = ?, exit_time = ?, driver_name = ?, stage = 6,
            stage_history_json = ?, version = version + 1, updated_at = ?
        WHERE id = ? AND version = ?
      `)
      .run(cartonsOut, effectiveExitTime, driverName, JSON.stringify(nextHistory), now, order.id, order.version);

    if (updated.changes === 0) {
      res.status(409).json({ error: 'تداخل ویرایش هم‌زمان رخ داد.' });
      return;
    }

    addAuditLog(
      user.id,
      user.displayName,
      'order',
      `خروج از انبار: فاکتور «${order.finalInvoiceNo || order.proforma}» (${order.customer}) به تعداد ${cartonsOut} کارتن در ساعت ${effectiveExitTime} تحویل ${driverName} شد.`,
    );

    const fullFresh = hydrateOrderRow(db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id) as Record<string, unknown>);
    await syncOrderToSupabase(req.supabase, fullFresh).catch(logMirrorError('order', fullFresh.id));
    const fresh = projectOrderForRole(user.id, fullFresh);
    broadcastChange('orders');
    res.json({ order: fresh });
  });

  // Stage 6: Driver Delivery + Binary-Uploaded Signature File Reference (Zero Base64!) + Carton Discrepancy Enforcement
  router.post(
    '/orders/:id/driver-delivery',
    requireAuth,
    requireRoles(['driver'], 'ثبت تحویل نهایی فقط برای راننده در مرحله ۶ مجاز است.'),
    async (req: AuthedRequest, res) => {
      const user = req.user!;
      const expectedVersion = Number(req.body?.expectedVersion);
      const check = getOrderWithVersionCheck(String(req.params.id), expectedVersion);
      if (check.error || !check.order) {
        res.status(check.error!.status).json({ error: check.error!.message });
        return;
      }
      const order = check.order;
      if (order.status !== 'active' || order.stage !== 6) {
        res.status(403).json({ error: 'ثبت تحویل نهایی فقط برای سفارش‌های مرحله ۶ (در دست راننده) مجاز است.' });
        return;
      }

      const cartonsDelivered = Number(normalizeDigits(String(req.body?.cartonsDelivered || '')));
      const customerSigner = String(req.body?.customerSigner || '').trim();
      const discrepancyNote = String(req.body?.discrepancyNote || '').trim();
      const signatureFileId = String(req.body?.signatureFileId || '').trim();

      if (!Number.isInteger(cartonsDelivered) || cartonsDelivered < 1 || !customerSigner) {
        res.status(400).json({ error: 'تعداد کارتن تحویلی و نام تحویل‌گیرنده الزامی است.' });
        return;
      }

      const disc = computeCartonDiscrepancy(order.cartonsOut, cartonsDelivered);
      if (disc.hasDiscrepancy && !discrepancyNote) {
        res.status(400).json({
          error: `تعداد کارتن تحویلی (${cartonsDelivered}) با خروجی انبار (${order.cartonsOut}) مغایرت دارد. لطفاً توضیح علت مغایرت را وارد کنید.`,
        });
        return;
      }

      if (!signatureFileId) {
        res.status(400).json({ error: 'بارگذاری تصویر امضای دیجیتال مشتری در مخزن فایل الزامی است.' });
        return;
      }

      const sigRow = db
        .prepare(`SELECT id, storage_url, owner_kind, uploaded_by, mime_type FROM files WHERE id = ?`)
        .get(signatureFileId) as
        | { id: string; storage_url: string; owner_kind: string; uploaded_by: string; mime_type: string }
        | undefined;

      if (!sigRow || sigRow.uploaded_by !== user.id || sigRow.owner_kind !== 'signature' || sigRow.mime_type !== 'image/png') {
        res.status(400).json({ error: 'فایل امضای دیجیتال معتبر و متعلق به این نشست یافت نشد.' });
        return;
      }

      const sigUrl = sigRow.storage_url || `/api/files/${encodeURIComponent(sigRow.id)}`;
      const now = new Date().toISOString();
      const nextHistory: StageHistoryEntry[] = [
        ...order.stageHistory,
        {
          stage: 6,
          action: disc.hasDiscrepancy
            ? `تحویل با مغایرت کارتن (${cartonsDelivered} از ${order.cartonsOut}) به ${customerSigner}`
            : `تحویل قطعی (${cartonsDelivered} کارتن) با امضای ${customerSigner}`,
          actorName: user.displayName,
          timestamp: now,
          note: disc.hasDiscrepancy ? discrepancyNote : undefined,
        },
      ];

      const tx = db.transaction(() => {
        db.prepare(`UPDATE files SET owner_record_id = ? WHERE id = ?`).run(order.id, sigRow.id);
        const updated = db
          .prepare(`
            UPDATE orders
            SET cartons_delivered = ?, carton_discrepancy = ?, discrepancy_note = ?,
                customer_signer = ?, signature_file_id = ?, signature_url = ?, stage = 7,
                stage_history_json = ?, version = version + 1, updated_at = ?
            WHERE id = ? AND version = ?
          `)
          .run(
            cartonsDelivered,
            disc.discrepancy,
            discrepancyNote,
            customerSigner,
            sigRow.id,
            sigUrl,
            JSON.stringify(nextHistory),
            now,
            order.id,
            order.version,
          );
        if (updated.changes === 0) {
          throw new Error('VERSION_CONFLICT');
        }

        addAuditLog(
          user.id,
          user.displayName,
          'order',
          disc.hasDiscrepancy
            ? `هشدار مغایرت تحویل: فاکتور «${order.finalInvoiceNo || order.proforma}» (${order.customer}) با ${cartonsDelivered} کارتن (خروجی انبار: ${order.cartonsOut}) به «${customerSigner}» تحویل شد. توضیح: ${discrepancyNote}`
            : `تحویل قطعی و امضاشده: فاکتور «${order.finalInvoiceNo || order.proforma}» (${order.customer}) به تعداد ${cartonsDelivered} کارتن به «${customerSigner}» تحویل گردید.`,
        );
      });

      try {
        tx();
      } catch (e) {
        if (e instanceof Error && e.message === 'VERSION_CONFLICT') {
          res.status(409).json({ error: 'تداخل ویرایش هم‌زمان رخ داد.' });
          return;
        }
        throw e;
      }

      const fullFresh = hydrateOrderRow(db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id) as Record<string, unknown>);
      await syncOrderToSupabase(req.supabase, fullFresh).catch(logMirrorError('order', fullFresh.id));
      const fresh = projectOrderForRole(user.id, fullFresh);
      broadcastChange('orders');
      res.json({ order: fresh });
    },
  );

  // Return order (with optional automatic Phase 3 shortage log when warehouse reports shortage!)
  router.post('/orders/:id/return', requireAuth, async (req: AuthedRequest, res) => {
    const user = req.user!;
    const expectedVersion = Number(req.body?.expectedVersion);
    const check = getOrderWithVersionCheck(String(req.params.id), expectedVersion);
    if (check.error || !check.order) {
      res.status(check.error!.status).json({ error: check.error!.message });
      return;
    }
    const order = check.order;

    const target = String(req.body?.target || ''); // 'sales' | 'sales_mgr' | 'customer_reject' | 'accounting'
    const reason = String(req.body?.reason || '').trim();
    const note = String(req.body?.note || '').trim() || reason;
    const createShortageTicket = Boolean(req.body?.createShortageTicket);
    const shortageBrand = String(req.body?.shortageBrand || 'سایر برندهای ۵۰گانه').trim();
    const shortagePart = String(req.body?.shortagePart || '').trim();
    const shortageQty = Math.max(1, Number(normalizeDigits(String(req.body?.shortageQty || '1'))) || 1);

    if (!reason) {
      res.status(400).json({ error: 'انتخاب علت برگشت الزامی است.' });
      return;
    }

    let nextStatus: OrderRecord['status'];
    let nextStage: number;

    if (target === 'accounting') {
      if (user.id !== 'warehouse_sup' || order.stage !== 5 || order.status !== 'active') {
        res.status(403).json({ error: 'برگشت مغایرت انبار فقط برای سرپرست انبار در مرحله ۵ مجاز است.' });
        return;
      }
      nextStatus = 'returned_to_accounting';
      nextStage = 4;
    } else if (target === 'sales_mgr') {
      if (
        user.id !== 'accounting' ||
        !((order.stage === 4 && order.status === 'active') || order.status === 'returned_to_accounting')
      ) {
        res.status(403).json({ error: 'عودت به مدیر فروش فقط برای واحد حسابداری مجاز است.' });
        return;
      }
      nextStatus = 'returned_to_sales_mgr';
      nextStage = 2;
    } else if (target === 'customer_reject') {
      if (!user.isSales || order.salesOwnerId !== user.id || order.stage !== 3 || order.status !== 'active') {
        res.status(403).json({ error: 'ثبت عدم تایید مشتری فقط برای کارشناس فروش مسئول سفارش در مرحله ۳ مجاز است.' });
        return;
      }
      nextStatus = 'returned_to_sales';
      nextStage = 1;
    } else if (target === 'sales') {
      if (user.id !== 'sales_mgr' || !(order.stage === 2 || order.status === 'returned_to_sales_mgr')) {
        res.status(403).json({ error: 'برگشت به کارشناس فقط برای مدیر فروش مجاز است.' });
        return;
      }
      nextStatus = 'returned_to_sales';
      nextStage = 1;
    } else {
      res.status(400).json({ error: 'مقصد برگشت نامعتبر است.' });
      return;
    }

    const now = new Date().toISOString();
    const nextHistory: StageHistoryEntry[] = [
      ...order.stageHistory,
      {
        stage: order.stage,
        action: `برگشت سفارش (${reason})`,
        actorName: user.displayName,
        timestamp: now,
        note,
      },
    ];

    let shortageProcId: string | null = null;
    const tx = db.transaction(() => {
      const updated = db
        .prepare(`
          UPDATE orders
          SET status = ?, stage = ?, return_reason = ?, return_note = ?,
              stage_history_json = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?
        `)
        .run(nextStatus, nextStage, reason, note, JSON.stringify(nextHistory), now, order.id, order.version);
      if (updated.changes === 0) throw new Error('VERSION_CONFLICT');

      if (target === 'accounting' && createShortageTicket) {
        const procId = `proc-${crypto.randomUUID().slice(0, 8)}`;
        shortageProcId = procId;
        db.prepare(`
          INSERT INTO procurement_items (
            id, version, brand, part_name, part_code, qty_needed, priority, status,
            related_order_proforma, reported_by_name, supplier_note, created_at, updated_at
          ) VALUES (?, 1, ?, ?, '', ?, 'فوری', 'reported', ?, ?, ?, ?, ?)
        `).run(
          procId,
          shortageBrand,
          shortagePart || order.items.slice(0, 120),
          shortageQty,
          order.finalInvoiceNo || order.proforma,
          user.displayName,
          `اعلام کسری خودکار از مغایرت انبار: ${note}`,
          now,
          now,
        );
      }

      addAuditLog(
        user.id,
        user.displayName,
        'order',
        `برگشت سفارش «${order.finalInvoiceNo || order.proforma}» (${order.customer}) به علت «${reason}».`,
      );
    });

    try {
      tx();
    } catch (e) {
      if (e instanceof Error && e.message === 'VERSION_CONFLICT') {
        res.status(409).json({ error: 'تداخل ویرایش هم‌زمان رخ داد.' });
        return;
      }
      throw e;
    }

    // Mirror the full (unmasked) record; only the response is projected for the caller's role.
    const fullReturned = hydrateOrderRow(
      db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id) as Record<string, unknown>,
    );
    await syncOrderToSupabase(req.supabase, fullReturned).catch(logMirrorError('order', fullReturned.id));
    if (shortageProcId) {
      const procRow = db.prepare(`SELECT * FROM procurement_items WHERE id = ?`).get(shortageProcId) as
        | Record<string, unknown>
        | undefined;
      if (procRow) {
        const procItem = hydrateProcurementRow(procRow);
        await syncProcurementToSupabase(req.supabase, procItem).catch(logMirrorError('procurement item', procItem.id));
      }
    }
    const fresh = projectOrderForRole(user.id, fullReturned);
    broadcastChange('orders');
    if (createShortageTicket) broadcastChange('procurement');
    res.json({ order: fresh });
  });

  // Revise returned order (Sales owner only — preserves full stage history & proforma document history!)
  router.post('/orders/:id/revise', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const expectedVersion = Number(req.body?.expectedVersion);
    const check = getOrderWithVersionCheck(String(req.params.id), expectedVersion);
    if (check.error || !check.order) {
      res.status(check.error!.status).json({ error: check.error!.message });
      return;
    }
    const order = check.order;
    if (!user.isSales || order.salesOwnerId !== user.id || order.status !== 'returned_to_sales') {
      res.status(403).json({ error: 'اصلاح پیش‌فاکتور برگشتی فقط برای کارشناس فروش مسئول آن مجاز است.' });
      return;
    }

    const newProforma = normalizeDigits(String(req.body?.proforma || '')).trim() || order.proforma;
    const newAmount =
      req.body?.amountToman !== undefined && req.body?.amountToman !== ''
        ? parseAmountToman(req.body.amountToman)
        : order.amountToman;
    const newItems = String(req.body?.items || '').trim() || order.items;
    const fileId = req.body?.fileId ? String(req.body.fileId).trim() : null;

    if (newAmount === null || newAmount <= 0) {
      res.status(400).json({ error: 'مبلغ جدید باید عدد معتبر بزرگ‌تر از صفر باشد.' });
      return;
    }

    if (newProforma.toLowerCase() !== order.proforma.toLowerCase()) {
      const dup = findDuplicateProforma(newProforma, order.id);
      if (dup) {
        res.status(409).json({ error: dup.message, duplicate: dup });
        return;
      }
    }

    const now = new Date().toISOString();
    const nextRev = order.rev + 1;
    // Append to history instead of wiping previous stageHistory!
    const nextHistory: StageHistoryEntry[] = [
      ...order.stageHistory,
      { stage: 1, action: `اصلاح پیش‌فاکتور (نسخه #${nextRev}) و ارسال مجدد`, actorName: user.displayName, timestamp: now },
    ];

    const tx = db.transaction(() => {
      const updated = db
        .prepare(`
          UPDATE orders
          SET proforma = ?, amount_toman = ?, items = ?, rev = ?,
              status = 'active', stage = 2, return_reason = '', return_note = '',
              stage_history_json = ?, version = version + 1, updated_at = ?
          WHERE id = ? AND version = ?
        `)
        .run(
          newProforma,
          newAmount,
          newItems,
          nextRev,
          JSON.stringify(nextHistory),
          now,
          order.id,
          order.version,
        );
      if (updated.changes === 0) throw new Error('VERSION_CONFLICT');

      if (fileId) {
        const fRow = db
          .prepare(`SELECT id, storage_url, original_name, mime_type, uploaded_by FROM files WHERE id = ?`)
          .get(fileId) as { id: string; storage_url: string; original_name: string; mime_type: string; uploaded_by: string } | undefined;
        if (fRow && fRow.uploaded_by === user.id) {
          const maxVer = (
            db
              .prepare(`SELECT COALESCE(MAX(version_no), 0) as mv FROM order_documents WHERE order_id = ? AND doc_kind = 'proforma'`)
              .get(order.id) as { mv: number }
          ).mv;
          const resolvedUrl = fRow.storage_url || `/api/files/${encodeURIComponent(fRow.id)}`;
          db.prepare(`UPDATE files SET owner_kind = 'order_doc', owner_record_id = ? WHERE id = ?`).run(order.id, fileId);
          db.prepare(`
            INSERT INTO order_documents (id, order_id, doc_kind, version_no, file_id, file_url, original_name, mime_type, uploaded_by, created_at)
            VALUES (?, ?, 'proforma', ?, ?, ?, ?, ?, ?, ?)
          `).run(
            `doc-${crypto.randomUUID().slice(0, 8)}`,
            order.id,
            maxVer + 1,
            fRow.id,
            resolvedUrl,
            fRow.original_name,
            fRow.mime_type,
            user.displayName,
            now,
          );
        }
      }

      addAuditLog(
        user.id,
        user.displayName,
        'order',
        `اصلاحیه #${nextRev} پیش‌فاکتور «${newProforma}» (${order.customer}) ثبت و مجدداً به مدیر فروش ارسال شد.`,
      );
    });

    try {
      tx();
    } catch (e) {
      if (e instanceof Error && e.message === 'VERSION_CONFLICT') {
        res.status(409).json({ error: 'تداخل ویرایش هم‌زمان رخ داد.' });
        return;
      }
      throw e;
    }

    const fresh = hydrateOrderRow(db.prepare(`SELECT * FROM orders WHERE id = ?`).get(order.id) as Record<string, unknown>);
    syncOrderToSupabase(req.supabase, fresh).catch(logMirrorError('order', fresh.id));
    broadcastChange('orders');
    res.json({ order: fresh });
  });

  // ==================== Finance & Checks Endpoints (Phase 2 — Protected by RBAC Middleware) ====================
  router.get('/checks', requireAuth, requireFinanceAccess, (req: AuthedRequest, res) => {
    const user = req.user!;

    const filter = String(req.query.filter || 'all');
    const ownerFilter = String(req.query.owner || 'all');
    const sortBy = String(req.query.sort || 'updated'); // 'due_date' | 'updated'

    const since = parseSinceCursor(req.query.since);
    const allRows = since
      ? (db.prepare(`SELECT * FROM checks WHERE updated_at > ? ORDER BY updated_at DESC`).all(since) as Array<Record<string, unknown>>)
      : (db.prepare(`SELECT * FROM checks ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>);
    const visibleAll = allRows
      .map(hydrateCheckRow)
      .filter((c) => (user.isSales ? c.salesOwnerId === user.id : true));

    const summary = {
      pendingCount: visibleAll.filter((c) => c.status === 'pending').length,
      pendingMeCount:
        user.id === 'ceo'
          ? visibleAll.filter((c) => c.status === 'pending' && c.ceoStatus === 'pending').length
          : user.id === 'accounting'
            ? visibleAll.filter((c) => c.status === 'pending' && c.financeStatus === 'pending').length
            : visibleAll.filter((c) => c.status === 'returned' && c.salesOwnerId === user.id).length,
      safeChecksCount: visibleAll.filter((c) => c.status === 'finalized' && c.docType === 'چک دریافتی').length,
      safeChecksAmountToman: visibleAll
        .filter((c) => c.status === 'finalized' && c.docType === 'چک دریافتی')
        .reduce((s, c) => s + c.amountToman, 0),
      approvedDepositsCount: visibleAll.filter((c) => c.status === 'finalized' && c.docType === 'واریزی').length,
      approvedDepositsAmountToman: visibleAll
        .filter((c) => c.status === 'finalized' && c.docType === 'واریزی')
        .reduce((s, c) => s + c.amountToman, 0),
      returnedCount: visibleAll.filter((c) => c.status === 'returned').length,
    };

    // Breakdown includes ALL uploaders (Sales 1..4 AND Accounting!) so accounting checks are never invisible
    const uploaderRoles = listPublicRoles().filter((r) => r.isSales || r.id === 'accounting');
    const uploaderBreakdown =
      user.id === 'ceo' || user.id === 'accounting' || user.id === 'sales_mgr'
        ? uploaderRoles.map((r) => {
            const list = visibleAll.filter((c) => c.salesOwnerId === r.id);
            return {
              roleId: r.id,
              displayName: r.displayName,
              pending: list.filter((c) => c.status === 'pending').length,
              safeChecks: list.filter((c) => c.status === 'finalized' && c.docType === 'چک دریافتی').length,
              approvedDeposits: list.filter((c) => c.status === 'finalized' && c.docType === 'واریزی').length,
              returned: list.filter((c) => c.status === 'returned').length,
              finalizedAmountToman: list
                .filter((c) => c.status === 'finalized')
                .reduce((s, c) => s + c.amountToman, 0),
            };
          })
        : [];

    let list = visibleAll;
    if (!user.isSales && ownerFilter !== 'all') {
      list = list.filter((c) => c.salesOwnerId === ownerFilter);
    }

    if (filter === 'pending_me') {
      if (user.id === 'ceo') list = list.filter((c) => c.status === 'pending' && c.ceoStatus === 'pending');
      else if (user.id === 'accounting') list = list.filter((c) => c.status === 'pending' && c.financeStatus === 'pending');
      else if (user.isSales) list = list.filter((c) => c.status === 'returned');
      else list = list.filter((c) => c.status === 'pending');
    } else if (filter === 'safe_checks') {
      list = list.filter((c) => c.status === 'finalized' && c.docType === 'چک دریافتی');
    } else if (filter === 'approved_deposits') {
      list = list.filter((c) => c.status === 'finalized' && c.docType === 'واریزی');
    } else if (filter === 'returned') {
      list = list.filter((c) => c.status === 'returned');
    }

    if (sortBy === 'due_date' || filter === 'safe_checks') {
      list = [...list].sort((a, b) => {
        if (!a.dueDate && !b.dueDate) return 0;
        if (!a.dueDate) return 1;
        if (!b.dueDate) return -1;
        return a.dueDate.localeCompare(b.dueDate);
      });
    }

    const syncCursor = computeLatestCursor(visibleAll.map((c) => c.updatedAt), since) || new Date().toISOString();
    res.json({ items: list, summary, uploaderBreakdown, syncCursor });
  });

  router.post(
    '/checks',
    requireAuth,
    requireFinanceAccess,
    requireRoles(['sales_1', 'sales_2', 'sales_3', 'sales_4', 'accounting'], 'ثبت مدارک تسویه فقط برای کارشناسان فروش و واحد حسابداری مجاز است.'),
    async (req: AuthedRequest, res) => {
      const user = req.user!;

    const docType = req.body?.docType === 'واریزی' ? 'واریزی' : 'چک دریافتی';
    const customer = String(req.body?.customer || '').trim();
    const amountParsed = parseAmountToman(req.body?.amountToman ?? req.body?.amount);
    const sayadiRaw = String(req.body?.sayadiId || '').trim();
    const dueDate = normalizeDigits(String(req.body?.dueDate || '')).trim();
    const trackingNo = normalizeDigits(String(req.body?.trackingNo || '')).trim();
    const caption = String(req.body?.caption || '').trim();
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds.map(String) : [];

    if (!customer || !caption) {
      res.status(400).json({ error: 'نام مشتری و توضیحات مدرک الزامی است.' });
      return;
    }
    if (amountParsed === null || amountParsed <= 0) {
      res.status(400).json({ error: 'لطفاً مبلغ را به صورت عدد معتبر (بزرگ‌تر از صفر) وارد کنید.' });
      return;
    }

    let normalizedSayadi = '';
    if (docType === 'چک دریافتی') {
      const sayadiCheck = validateSayadiId(sayadiRaw);
      if (!sayadiCheck.valid) {
        res.status(400).json({ error: sayadiCheck.error });
        return;
      }
      normalizedSayadi = sayadiCheck.normalized;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        res.status(400).json({ error: 'انتخاب تاریخ سررسید ساختاریافته برای چک دریافتی الزامی است.' });
        return;
      }
    } else if (!trackingNo) {
      res.status(400).json({ error: 'شماره پیگیری بانکی برای تصویر واریزی الزامی است.' });
      return;
    }

    const now = new Date().toISOString();
    const checkId = `chk-${crypto.randomUUID().slice(0, 10)}`;

    const tx = db.transaction(() => {
      db.prepare(`
        INSERT INTO checks (
          id, version, doc_type, customer, amount_toman, sayadi_id, due_date, tracking_no, caption,
          sales_owner_id, sales_owner_name, status, finance_status, finance_time, ceo_status, ceo_time,
          finalized_time, reject_reason, rejected_by, created_at, updated_at
        ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 'pending', '', 'pending', '', '', '', '', ?, ?)
      `).run(
        checkId,
        docType,
        customer,
        amountParsed,
        normalizedSayadi,
        docType === 'چک دریافتی' ? dueDate : '',
        docType === 'واریزی' ? trackingNo : '',
        caption,
        user.id,
        user.displayName,
        now,
        now,
      );

      for (const fid of fileIds.slice(0, 4)) {
        const fRow = db
          .prepare(`SELECT id, storage_url, original_name, mime_type, uploaded_by FROM files WHERE id = ?`)
          .get(fid) as { id: string; storage_url: string; original_name: string; mime_type: string; uploaded_by: string } | undefined;
        if (fRow && fRow.uploaded_by === user.id) {
          const resolvedUrl = fRow.storage_url || `/api/files/${encodeURIComponent(fRow.id)}`;
          db.prepare(`UPDATE files SET owner_kind = 'check_attachment', owner_record_id = ? WHERE id = ?`).run(checkId, fid);
          db.prepare(`
            INSERT INTO check_attachments (id, check_id, file_id, file_url, original_name, mime_type, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(`att-${crypto.randomUUID().slice(0, 8)}`, checkId, fRow.id, resolvedUrl, fRow.original_name, fRow.mime_type, now);
        }
      }

      addAuditLog(
        user.id,
        user.displayName,
        'finance',
        `مدرک تسویه جدید (${docType}) برای «${customer}» به مبلغ ${new Intl.NumberFormat('fa-IR').format(amountParsed)} تومان بارگذاری شد.`,
      );
    });

    tx();
    const fresh = hydrateCheckRow(db.prepare(`SELECT * FROM checks WHERE id = ?`).get(checkId) as Record<string, unknown>);
    await syncCheckToSupabase(req.supabase, fresh).catch(logMirrorError('check', fresh.id));
    broadcastChange('checks');
    res.status(201).json({ check: fresh });
  });

  // ATOMIC Field-Level Dual-Approval (Fixes simultaneous Finance + CEO lost update bug!)
  router.post(
    '/checks/:id/approve',
    requireAuth,
    requireRoles(['accounting', 'ceo'], 'تایید مدارک مالی فقط برای واحد حسابداری و مدیرعامل مجاز است.'),
    async (req: AuthedRequest, res) => {
      const user = req.user!;

    const checkId = String(req.params.id);
    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      const row = db.prepare(`SELECT * FROM checks WHERE id = ?`).get(checkId) as Record<string, unknown> | undefined;
      if (!row) throw new Error('NOT_FOUND');
      if (row.status === 'returned') throw new Error('IS_RETURNED');

      if (user.id === 'accounting') {
        db.prepare(`
          UPDATE checks
          SET finance_status = 'approved',
              finance_time = ?,
              status = CASE WHEN ceo_status = 'approved' THEN 'finalized' ELSE 'pending' END,
              finalized_time = CASE WHEN ceo_status = 'approved' THEN ? ELSE finalized_time END,
              version = version + 1,
              updated_at = ?
          WHERE id = ?
        `).run(now, now, now, checkId);
      } else {
        db.prepare(`
          UPDATE checks
          SET ceo_status = 'approved',
              ceo_time = ?,
              status = CASE WHEN finance_status = 'approved' THEN 'finalized' ELSE 'pending' END,
              finalized_time = CASE WHEN finance_status = 'approved' THEN ? ELSE finalized_time END,
              version = version + 1,
              updated_at = ?
          WHERE id = ?
        `).run(now, now, now, checkId);
      }

      const fresh = hydrateCheckRow(db.prepare(`SELECT * FROM checks WHERE id = ?`).get(checkId) as Record<string, unknown>);
      const endMsg =
        fresh.status === 'finalized'
          ? fresh.docType === 'چک دریافتی'
            ? ' و به صندوق چک‌ها منتقل شد.'
            : ' و جهت ثبت حسابداری نهایی شد.'
          : ' (در انتظار تایید دوم).';

      addAuditLog(
        user.id,
        user.displayName,
        'finance',
        `${fresh.docType} «${fresh.customer}» (${new Intl.NumberFormat('fa-IR').format(fresh.amountToman)} تومان) توسط ${user.displayName} تایید شد${endMsg}`,
      );
      return fresh;
    });

    try {
      const fresh = tx();
      await syncCheckToSupabase(req.supabase, fresh).catch(logMirrorError('check', fresh.id));
      broadcastChange('checks');
      res.json({ check: fresh });
    } catch (e) {
      if (e instanceof Error && e.message === 'NOT_FOUND') {
        res.status(404).json({ error: 'مدرک مالی یافت نشد.' });
        return;
      }
      if (e instanceof Error && e.message === 'IS_RETURNED') {
        res.status(409).json({ error: 'این مدرک برگشت خورده و پیش از اصلاح مجدد قابل تایید نیست.' });
        return;
      }
      throw e;
    }
  });

  router.post(
    '/checks/:id/reject',
    requireAuth,
    requireRoles(['accounting', 'ceo'], 'رد مدارک مالی فقط برای واحد حسابداری و مدیرعامل مجاز است.'),
    async (req: AuthedRequest, res) => {
      const user = req.user!;

    const reason = String(req.body?.reason || '').trim();
    if (!reason) {
      res.status(400).json({ error: 'وارد کردن علت عدم تایید الزامی است.' });
      return;
    }

    const checkId = String(req.params.id);
    const now = new Date().toISOString();

    const row = db.prepare(`SELECT * FROM checks WHERE id = ?`).get(checkId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'مدرک مالی یافت نشد.' });
      return;
    }

    if (user.id === 'accounting') {
      db.prepare(`
        UPDATE checks
        SET finance_status = 'rejected', finance_time = ?, status = 'returned',
            reject_reason = ?, rejected_by = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(now, reason, user.displayName, now, checkId);
    } else {
      db.prepare(`
        UPDATE checks
        SET ceo_status = 'rejected', ceo_time = ?, status = 'returned',
            reject_reason = ?, rejected_by = ?, version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(now, reason, user.displayName, now, checkId);
    }

    const fresh = hydrateCheckRow(db.prepare(`SELECT * FROM checks WHERE id = ?`).get(checkId) as Record<string, unknown>);
    await syncCheckToSupabase(req.supabase, fresh).catch(logMirrorError('check', fresh.id));
    addAuditLog(
      user.id,
      user.displayName,
      'finance',
      `مدرک ${fresh.docType} «${fresh.customer}» توسط ${user.displayName} رد شد و به کارتابل ${fresh.salesOwnerName} برگشت خورد.`,
    );
    broadcastChange('checks');
    res.json({ check: fresh });
  });

  // Revise returned check (allows BOTH sales reps AND accounting when accounting uploaded it!)
  router.post('/checks/:id/revise', requireAuth, requireFinanceAccess, async (req: AuthedRequest, res) => {
    const user = req.user!;
    const checkId = String(req.params.id);
    const row = db.prepare(`SELECT * FROM checks WHERE id = ?`).get(checkId) as Record<string, unknown> | undefined;
    if (!row) {
      res.status(404).json({ error: 'مدرک مالی یافت نشد.' });
      return;
    }
    const existing = hydrateCheckRow(row);
    if (!canRoleReviseCheck(user.id, existing)) {
      res.status(403).json({ error: 'اصلاح مدرک برگشتی فقط برای ثبت‌کننده اصلی آن مجاز است.' });
      return;
    }

    const customer = String(req.body?.customer || '').trim() || existing.customer;
    const amountParsed = parseAmountToman(req.body?.amountToman ?? req.body?.amount ?? existing.amountToman);
    const caption = String(req.body?.caption || '').trim() || existing.caption;
    const sayadiRaw = String(req.body?.sayadiId ?? existing.sayadiId).trim();
    const dueDate = normalizeDigits(String(req.body?.dueDate ?? existing.dueDate)).trim();
    const trackingNo = normalizeDigits(String(req.body?.trackingNo ?? existing.trackingNo)).trim();
    const fileIds = Array.isArray(req.body?.fileIds) ? req.body.fileIds.map(String) : [];

    if (amountParsed === null || amountParsed <= 0) {
      res.status(400).json({ error: 'مبلغ باید عدد معتبر بزرگ‌تر از صفر باشد.' });
      return;
    }

    let normalizedSayadi = existing.sayadiId;
    if (existing.docType === 'چک دریافتی') {
      const sayadiCheck = validateSayadiId(sayadiRaw);
      if (!sayadiCheck.valid) {
        res.status(400).json({ error: sayadiCheck.error });
        return;
      }
      normalizedSayadi = sayadiCheck.normalized;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
        res.status(400).json({ error: 'تاریخ سررسید معتبر الزامی است.' });
        return;
      }
    }

    const now = new Date().toISOString();
    const tx = db.transaction(() => {
      db.prepare(`
        UPDATE checks
        SET customer = ?, amount_toman = ?, sayadi_id = ?, due_date = ?, tracking_no = ?, caption = ?,
            status = 'pending', finance_status = 'pending', finance_time = '', ceo_status = 'pending', ceo_time = '',
            reject_reason = '', rejected_by = '', version = version + 1, updated_at = ?
        WHERE id = ?
      `).run(
        customer,
        amountParsed,
        existing.docType === 'چک دریافتی' ? normalizedSayadi : '',
        existing.docType === 'چک دریافتی' ? dueDate : '',
        existing.docType === 'واریزی' ? trackingNo : '',
        caption,
        now,
        checkId,
      );

      if (fileIds.length > 0) {
        // Append new attachments while preserving audit trail (or add new version)
        for (const fid of fileIds.slice(0, 4)) {
          const fRow = db
            .prepare(`SELECT id, storage_url, original_name, mime_type, uploaded_by FROM files WHERE id = ?`)
            .get(fid) as { id: string; storage_url: string; original_name: string; mime_type: string; uploaded_by: string } | undefined;
          if (fRow && fRow.uploaded_by === user.id) {
            const resolvedUrl = fRow.storage_url || `/api/files/${encodeURIComponent(fRow.id)}`;
            db.prepare(`UPDATE files SET owner_kind = 'check_attachment', owner_record_id = ? WHERE id = ?`).run(checkId, fid);
            db.prepare(`
              INSERT INTO check_attachments (id, check_id, file_id, file_url, original_name, mime_type, created_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)
            `).run(`att-${crypto.randomUUID().slice(0, 8)}`, checkId, fRow.id, resolvedUrl, fRow.original_name, fRow.mime_type, now);
          }
        }
      }

      addAuditLog(user.id, user.displayName, 'finance', `مدرک ${existing.docType} «${customer}» توسط ${user.displayName} اصلاح و مجدداً ارسال شد.`);
    });

    tx();
    const fresh = hydrateCheckRow(db.prepare(`SELECT * FROM checks WHERE id = ?`).get(checkId) as Record<string, unknown>);
    await syncCheckToSupabase(req.supabase, fresh).catch(logMirrorError('check', fresh.id));
    broadcastChange('checks');
    res.json({ check: fresh });
  });

  // ==================== Phase 3: Procurement & 50-Brand Shortage Queue (Protected by RBAC Middleware) ====================
  router.get('/procurement', requireAuth, requireProcurementAccess, (req: AuthedRequest, res) => {
    const since = parseSinceCursor(req.query.since);
    const rows = since
      ? (db
          .prepare(`SELECT * FROM procurement_items WHERE updated_at > ? ORDER BY updated_at DESC`)
          .all(since) as Array<Record<string, unknown>>)
      : (db
          .prepare(`SELECT * FROM procurement_items ORDER BY updated_at DESC`)
          .all() as Array<Record<string, unknown>>);
    const items = rows.map(hydrateProcurementRow);
    const syncCursor = computeLatestCursor(items.map((i) => i.updatedAt), since) || new Date().toISOString();
    res.json({ items, syncCursor });
  });

  router.post('/procurement', requireAuth, requireProcurementAccess, async (req: AuthedRequest, res) => {
    const user = req.user!;

    const brand = String(req.body?.brand || '').trim();
    const partName = String(req.body?.partName || '').trim();
    const partCode = normalizeDigits(String(req.body?.partCode || '')).trim();
    const qtyNeeded = Number(normalizeDigits(String(req.body?.qtyNeeded || '1')));
    const priority = req.body?.priority === 'فوری' ? 'فوری' : 'عادی';
    const relatedOrderProforma = normalizeDigits(String(req.body?.relatedOrderProforma || '')).trim();
    const supplierNote = String(req.body?.supplierNote || '').trim();

    if (!brand || !partName || !Number.isInteger(qtyNeeded) || qtyNeeded < 1) {
      res.status(400).json({ error: 'برند، نام قطعه و تعداد مورد نیاز (حداقل ۱) الزامی است.' });
      return;
    }

    const now = new Date().toISOString();
    const id = `proc-${crypto.randomUUID().slice(0, 8)}`;

    db.prepare(`
      INSERT INTO procurement_items (
        id, version, brand, part_name, part_code, qty_needed, priority, status,
        related_order_proforma, reported_by_name, supplier_note, created_at, updated_at
      ) VALUES (?, 1, ?, ?, ?, ?, ?, 'reported', ?, ?, ?, ?, ?)
    `).run(id, brand, partName, partCode, qtyNeeded, priority, relatedOrderProforma, user.displayName, supplierNote, now, now);

    addAuditLog(user.id, user.displayName, 'procurement', `درخواست تامین جدید ثبت شد: ${partName} (${brand}) به تعداد ${qtyNeeded} عدد.`);
    const fresh = hydrateProcurementRow(db.prepare(`SELECT * FROM procurement_items WHERE id = ?`).get(id) as Record<string, unknown>);
    await syncProcurementToSupabase(req.supabase, fresh).catch(logMirrorError('procurement item', fresh.id));
    broadcastChange('procurement');
    res.status(201).json({ item: fresh });
  });

  router.patch('/procurement/:id', requireAuth, requireProcurementAccess, async (req: AuthedRequest, res) => {
    const user = req.user!;

    const id = String(req.params.id);
    const status = String(req.body?.status || '') as ProcurementStatus;
    const supplierNote = req.body?.supplierNote !== undefined ? String(req.body.supplierNote).trim() : null;
    if (!['reported', 'ordered', 'received'].includes(status)) {
      res.status(400).json({ error: 'وضعیت تامین نامعتبر است.' });
      return;
    }

    const now = new Date().toISOString();
    const existing = db.prepare(`SELECT * FROM procurement_items WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    if (!existing) {
      res.status(404).json({ error: 'رکورد تامین یافت نشد.' });
      return;
    }

    db.prepare(`
      UPDATE procurement_items
      SET status = ?, supplier_note = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(status, supplierNote !== null ? supplierNote : String(existing.supplier_note || ''), now, id);

    const statusLabel = status === 'ordered' ? 'در حال سفارش به تامین‌کننده' : status === 'received' ? 'تامین و وارد انبار شد' : 'ثبت کسری';
    addAuditLog(user.id, user.displayName, 'procurement', `وضعیت تامین قطعه «${String(existing.part_name)}» به «${statusLabel}» تغییر یافت.`);
    const fresh = hydrateProcurementRow(db.prepare(`SELECT * FROM procurement_items WHERE id = ?`).get(id) as Record<string, unknown>);
    await syncProcurementToSupabase(req.supabase, fresh).catch(logMirrorError('procurement item', fresh.id));
    broadcastChange('procurement');
    res.json({ item: fresh });
  });

  // ==================== Audit Logs & Bounded WhatsApp Summary ====================
  router.get('/logs', requireAuth, (req: AuthedRequest, res) => {
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(100, Math.max(10, Number(req.query.limit || 30)));
    const offset = (page - 1) * limit;

    // Audit messages contain customer names and amounts across all reps. Only supervisory roles
    // (CEO, sales manager, accounting) see the full log; everyone else sees only their own actions.
    const logUser = req.user!;
    const seesAllLogs = logUser.id === 'ceo' || logUser.id === 'sales_mgr' || logUser.id === 'accounting';
    const whereClause = seesAllLogs ? '' : 'WHERE actor_id = ?';
    const whereArgs: unknown[] = seesAllLogs ? [] : [logUser.id];

    const total = (
      db.prepare(`SELECT COUNT(*) as cnt FROM audit_logs ${whereClause}`).get(...whereArgs) as { cnt: number }
    ).cnt;
    const rows = db
      .prepare(
        `SELECT id, actor_id, actor_name, category, message, created_at FROM audit_logs ${whereClause} ORDER BY id DESC LIMIT ? OFFSET ?`,
      )
      .all(...whereArgs, limit, offset) as Array<{
        id: number;
        actor_id: string;
        actor_name: string;
        category: AuditLogEntry['category'];
        message: string;
        created_at: string;
      }>;

    res.json({
      items: rows.map(
        (r): AuditLogEntry => ({
          id: r.id,
          actorId: r.actor_id,
          actorName: r.actor_name,
          category: r.category,
          message: r.message,
          createdAt: r.created_at,
        }),
      ),
      pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) },
    });
  });

  router.get('/whatsapp-summary', requireAuth, (req: AuthedRequest, res) => {
    const user = req.user!;
    const allOrders = (db.prepare(`SELECT * FROM orders ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>)
      .map(hydrateOrderRow)
      .filter((o) => canRoleViewOrder(user.id, o))
      .map((o) => projectOrderForRole(user.id, o));

    const allChecks = canRoleAccessFinance(user.id)
      ? (db.prepare(`SELECT * FROM checks ORDER BY updated_at DESC`).all() as Array<Record<string, unknown>>)
          .map(hydrateCheckRow)
          .filter((c) => (user.isSales ? c.salesOwnerId === user.id : true))
      : ([] as CheckRecord[]);

    const waPhone = getSetting('wa_phone');
    const summary = buildBoundedWhatsAppSummary(allOrders, allChecks, waPhone);
    res.json(summary);
  });

  // ==================== CEO-Only Settings (Enforced by RBAC Middleware & Supabase RLS) ====================
  router.get(
    '/settings',
    requireAuth,
    requireRoles(['ceo'], 'مشاهده و تغییر تنظیمات امنیتی فقط برای مدیرعامل مجاز است.'),
    (_req: AuthedRequest, res) => {
      res.json({
        waPhone: getSetting('wa_phone'),
        roles: listPublicRoles(),
      });
    },
  );

  router.put(
    '/settings',
    requireAuth,
    requireRoles(['ceo'], 'تغییر شماره واتساپ مدیرعامل و رمزها فقط توسط مدیرعامل مجاز است.'),
    (req: AuthedRequest, res) => {

    const waPhone = req.body?.waPhone !== undefined ? normalizeDigits(String(req.body.waPhone)).trim() : null;
    const roleUpdates = Array.isArray(req.body?.roles)
      ? (req.body.roles as Array<{ id: string; displayName?: string; newPin?: string }>)
      : [];

    const now = new Date().toISOString();

    const tx = db.transaction(() => {
      if (waPhone !== null) {
        if (waPhone !== '' && !/^09\d{9}$/.test(waPhone)) {
          throw new Error('شماره موبایل واتساپ باید ۱۱ رقم و با 09 شروع شود (یا خالی باشد).');
        }
        setSetting('wa_phone', waPhone);
      }

      for (const ru of roleUpdates) {
        const existing = db.prepare(`SELECT id FROM users WHERE id = ?`).get(ru.id) as { id: string } | undefined;
        if (!existing) continue;

        if (ru.displayName && ru.displayName.trim().length >= 2) {
          db.prepare(`UPDATE users SET display_name = ?, updated_at = ? WHERE id = ?`).run(
            ru.displayName.trim().slice(0, 60),
            now,
            ru.id,
          );
        }

        if (ru.newPin && normalizeDigits(ru.newPin).length > 0) {
          const normalizedPin = normalizeDigits(ru.newPin);
          if (normalizedPin.length < 4 || normalizedPin.length > 16) {
            throw new Error('رمز عبور جدید هر کارتابل باید بین ۴ تا ۱۶ کاراکتر باشد.');
          }
          const hashed = hashPin(normalizedPin);
          db.prepare(`UPDATE users SET pin_hash = ?, pin_salt = ?, updated_at = ? WHERE id = ?`).run(
            hashed.hash,
            hashed.salt,
            now,
            ru.id,
          );
          // Revoke existing sessions for roles whose PIN was changed (except CEO's own active session)
          if (ru.id !== 'ceo') {
            db.prepare(`DELETE FROM sessions WHERE user_id = ?`).run(ru.id);
          }
        }
      }

      addAuditLog('ceo', req.user!.displayName, 'settings', 'تنظیمات مدیریتی، اسامی کارتابل‌ها و رمزهای عبور به‌روزرسانی شد.');
    });

    try {
      tx();
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'خطا در ذخیره تنظیمات.' });
      return;
    }

    broadcastChange('settings');
    void mirrorUsersAndSettingsToSupabase();
    res.json({
      waPhone: getSetting('wa_phone'),
      roles: listPublicRoles(),
    });
  });

  return router;
}
