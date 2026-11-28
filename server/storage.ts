import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { detectSafeFileType } from '../src/shared/workflow';
import { getSupabaseBucketName, getSupabaseStorageAdminClient } from './supabase';

export type FileOwnerKind = 'order_doc' | 'signature' | 'check_attachment' | 'temp';
export type StorageProviderKind = 'supabase' | 'local';

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024; // 5 MB strict cap
export const ALLOWED_MIME_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'image/webp'] as const;

export interface StoredObjectMetadata {
  fileId: string;
  storageProvider: StorageProviderKind;
  storageBucket: string;
  storagePath: string;
  storageUrl: string;
  storedFilename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

export function isSupabasePublicStorageEnabled(): boolean {
  return String(process.env.SUPABASE_STORAGE_PUBLIC || '').trim().toLowerCase() === 'true';
}

/**
 * Builds the canonical Storage resource URL saved in DB columns (`storage_url`, `file_url`, `signature_url`).
 * - When Supabase Storage is configured in public mode (`SUPABASE_STORAGE_PUBLIC=true`):
 *   `https://<project>.supabase.co/storage/v1/object/public/<bucket>/<path>`
 * - When Supabase Storage is configured in private mode (default):
 *   `https://<project>.supabase.co/storage/v1/object/<bucket>/<path>`
 * - In local preview fallback: `/api/files/<fileId>`
 */
export function buildStorageResourceUrl(params: {
  storageProvider: StorageProviderKind;
  storageBucket: string;
  storagePath: string;
  fileId: string;
  isPublic?: boolean;
}): string {
  if (params.storageProvider === 'supabase') {
    const base = (process.env.SUPABASE_URL || '').trim().replace(/\/+$/, '');
    if (base.startsWith('https://')) {
      const encodedPath = params.storagePath
        .split('/')
        .map((seg) => encodeURIComponent(seg))
        .join('/');
      const segment = params.isPublic ? 'object/public' : 'object';
      return `${base}/storage/v1/${segment}/${encodeURIComponent(params.storageBucket)}/${encodedPath}`;
    }
  }
  return `/api/files/${encodeURIComponent(params.fileId)}`;
}

const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(process.cwd(), 'data'));
export const LOCAL_UPLOADS_DIR = path.resolve(DATA_DIR, 'uploads');
fs.mkdirSync(LOCAL_UPLOADS_DIR, { recursive: true });

let bucketReadyPromise: Promise<void> | null = null;

export function sanitizeOriginalName(name: string): string {
  const base = path.basename(name || 'document').replace(/[^\w.\-\u0600-\u06FF ]/g, '_');
  return base.slice(0, 120) || 'document';
}

/**
 * Generates a deterministic, non-enumerable object path partitioned by document domain.
 * Never uses untrusted client filenames in storage paths.
 */
export function buildStorageObjectPath(ownerKind: FileOwnerKind, fileId: string, ext: string): string {
  const safeId = fileId.replace(/[^a-zA-Z0-9_-]/g, '');
  const safeExt = ext.startsWith('.') ? ext.toLowerCase() : `.${ext.toLowerCase()}`;
  const folder =
    ownerKind === 'signature'
      ? 'signatures'
      : ownerKind === 'check_attachment'
        ? 'checks'
        : 'orders';
  return `${folder}/${safeId}${safeExt}`;
}

/**
 * Resolves a local fallback path with strict directory confinement (`path.sep` boundary check).
 */
export function resolveConfinedLocalPath(storagePath: string): string | null {
  const normalized = storagePath.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..') || normalized.includes('\0')) {
    return null;
  }
  const resolved = path.resolve(LOCAL_UPLOADS_DIR, normalized);
  if (!resolved.startsWith(LOCAL_UPLOADS_DIR + path.sep)) {
    return null;
  }
  return resolved;
}

async function ensureSupabaseStorageBucket(bucketName: string): Promise<void> {
  const client = getSupabaseStorageAdminClient();
  if (!client) return;

  if (!bucketReadyPromise) {
    const isPublic = isSupabasePublicStorageEnabled();
    bucketReadyPromise = (async () => {
      const { data: existing, error: getErr } = await client.storage.getBucket(bucketName);
      if (existing && !getErr) return;

      const { error: createErr } = await client.storage.createBucket(bucketName, {
        public: isPublic,
        fileSizeLimit: MAX_UPLOAD_BYTES,
        allowedMimeTypes: [...ALLOWED_MIME_TYPES],
      });
      if (createErr && !String(createErr.message || '').toLowerCase().includes('already exists')) {
        bucketReadyPromise = null;
        throw new Error(`خطا در آماده‌سازی مخزن Supabase Storage: ${createErr.message}`);
      }
    })();
  }
  await bucketReadyPromise;
}

/**
 * Validates file binary magic bytes and uploads directly to Supabase Storage (when configured)
 * or confined local disk storage (fallback). Never stores Base64 inside database table rows.
 */
export async function storeValidatedBinaryFile(params: {
  buffer: Buffer;
  originalName: string;
  ownerKind: FileOwnerKind;
  allowPdf: boolean;
}): Promise<StoredObjectMetadata> {
  const { buffer, originalName, ownerKind, allowPdf } = params;

  if (!buffer || buffer.length === 0 || buffer.length > MAX_UPLOAD_BYTES) {
    throw new Error('حجم فایل باید بین ۱ بایت تا ۵ مگابایت باشد.');
  }

  const detected = detectSafeFileType(new Uint8Array(buffer));
  if (!detected.allowed || !detected.mimeType || !detected.ext) {
    throw new Error('فرمت فایل نامعتبر است. فقط PDF، PNG، JPEG و WebP معتبر مجاز هستند.');
  }
  if (!allowPdf && detected.mimeType === 'application/pdf') {
    throw new Error('برای این بخش فقط تصویر معتبر (PNG/JPEG/WebP) مجاز است.');
  }

  const fileId = `fil-${crypto.randomUUID()}`;
  const storedFilename = `${fileId}${detected.ext}`;
  const storagePath = buildStorageObjectPath(ownerKind, fileId, detected.ext);
  const bucketName = getSupabaseBucketName();
  const cleanName = sanitizeOriginalName(originalName);

  const supabaseAdmin = getSupabaseStorageAdminClient();
  if (supabaseAdmin) {
    const isPublic = isSupabasePublicStorageEnabled();
    await ensureSupabaseStorageBucket(bucketName);
    const { error } = await supabaseAdmin.storage.from(bucketName).upload(storagePath, buffer, {
      contentType: detected.mimeType,
      upsert: false,
      cacheControl: '3600',
    });
    if (error) {
      throw new Error(`خطا در ذخیره‌سازی فایل در Supabase Storage: ${error.message}`);
    }

    let storageUrl: string;
    if (isPublic) {
      const { data: publicData } = supabaseAdmin.storage.from(bucketName).getPublicUrl(storagePath);
      storageUrl =
        publicData?.publicUrl ||
        buildStorageResourceUrl({
          storageProvider: 'supabase',
          storageBucket: bucketName,
          storagePath,
          fileId,
          isPublic: true,
        });
    } else {
      storageUrl = buildStorageResourceUrl({
        storageProvider: 'supabase',
        storageBucket: bucketName,
        storagePath,
        fileId,
        isPublic: false,
      });
    }

    return {
      fileId,
      storageProvider: 'supabase',
      storageBucket: bucketName,
      storagePath,
      storageUrl,
      storedFilename,
      originalName: cleanName,
      mimeType: detected.mimeType,
      sizeBytes: buffer.length,
    };
  }

  // Confined local storage fallback when Supabase Storage env vars are not set in preview
  const resolvedDest = resolveConfinedLocalPath(storagePath);
  if (!resolvedDest) {
    throw new Error('مسیر ذخیره‌سازی فایل نامعتبر است.');
  }
  fs.mkdirSync(path.dirname(resolvedDest), { recursive: true });
  fs.writeFileSync(resolvedDest, buffer);

  const storageUrl = buildStorageResourceUrl({
    storageProvider: 'local',
    storageBucket: bucketName,
    storagePath,
    fileId,
  });

  return {
    fileId,
    storageProvider: 'local',
    storageBucket: bucketName,
    storagePath,
    storageUrl,
    storedFilename,
    originalName: cleanName,
    mimeType: detected.mimeType,
    sizeBytes: buffer.length,
  };
}

/** Explicit alias for uploading PDFs, check images, and signatures to Supabase Storage */
export const uploadFileToStorage = storeValidatedBinaryFile;

/**
 * Streams an authorized binary object from Supabase Storage or confined local storage.
 */
export async function readStoredFileStream(params: {
  storageProvider: string;
  storageBucket: string;
  storagePath: string;
  storedFilename: string;
}): Promise<{ stream: Readable } | null> {
  if (params.storageProvider === 'supabase') {
    const supabaseAdmin = getSupabaseStorageAdminClient();
    if (!supabaseAdmin) return null;
    const bucket = params.storageBucket || getSupabaseBucketName();
    const { data, error } = await supabaseAdmin.storage.from(bucket).download(params.storagePath);
    if (error || !data) return null;
    const arrayBuffer = await data.arrayBuffer();
    return { stream: Readable.from(Buffer.from(arrayBuffer)) };
  }

  // Local fallback: support both partitioned storagePath and legacy flat storedFilename
  const candidates = [
    params.storagePath ? resolveConfinedLocalPath(params.storagePath) : null,
    params.storedFilename ? resolveConfinedLocalPath(path.basename(params.storedFilename)) : null,
  ].filter((p): p is string => Boolean(p));

  for (const resolved of candidates) {
    if (fs.existsSync(resolved)) {
      return { stream: fs.createReadStream(resolved) };
    }
  }
  return null;
}

/**
 * Permanently deletes a stored binary (local disk or Supabase Storage). Best effort: returns false
 * instead of throwing, so a storage hiccup never breaks the request that triggered the cleanup.
 */
export async function deleteStoredFile(params: {
  storageProvider: string;
  storageBucket: string;
  storagePath: string;
  storedFilename: string;
}): Promise<boolean> {
  try {
    if (params.storageProvider === 'supabase') {
      const supabaseAdmin = getSupabaseStorageAdminClient();
      if (!supabaseAdmin) return false;
      const bucket = params.storageBucket || getSupabaseBucketName();
      const { error } = await supabaseAdmin.storage.from(bucket).remove([params.storagePath]);
      return !error;
    }
    const candidates = [
      params.storagePath ? resolveConfinedLocalPath(params.storagePath) : null,
      params.storedFilename ? resolveConfinedLocalPath(path.basename(params.storedFilename)) : null,
    ].filter((p): p is string => Boolean(p));
    let deleted = false;
    for (const resolved of candidates) {
      if (fs.existsSync(resolved)) {
        fs.rmSync(resolved, { force: true });
        deleted = true;
      }
    }
    return deleted;
  } catch {
    return false;
  }
}

/**
 * Generates a short-lived signed URL (default 60s) from Supabase Storage after server-side RBAC passes.
 * Returns null if the file is stored in local fallback mode (client continues using authenticated /api/files/:id proxy).
 */
export async function createSignedStorageUrl(params: {
  storageProvider: string;
  storageBucket: string;
  storagePath: string;
  expiresInSeconds?: number;
}): Promise<{ signedUrl: string; expiresInSeconds: number } | null> {
  if (params.storageProvider !== 'supabase') return null;
  const supabaseAdmin = getSupabaseStorageAdminClient();
  if (!supabaseAdmin) return null;

  const ttl = Math.max(30, Math.min(300, params.expiresInSeconds ?? 60));
  const bucket = params.storageBucket || getSupabaseBucketName();
  const { data, error } = await supabaseAdmin.storage.from(bucket).createSignedUrl(params.storagePath, ttl);
  if (error || !data?.signedUrl) return null;
  return { signedUrl: data.signedUrl, expiresInSeconds: ttl };
}

/** Explicit alias for streaming binary PDFs/images back from Supabase Storage */
export const fetchFileFromStorage = readStoredFileStream;

/**
 * Resolves a verified access URL for a stored PDF/image after RBAC succeeds.
 * - If Supabase Storage public bucket mode (`SUPABASE_STORAGE_PUBLIC=true`) is enabled, returns `getPublicUrl()`.
 * - Otherwise if stored in private Supabase Storage, issues a 60s signed URL via `createSignedUrl()`.
 * - Otherwise falls back to `/api/files/:id` authenticated proxy.
 */
export async function resolveStorageAccessUrl(params: {
  fileId: string;
  storageProvider: string;
  storageBucket: string;
  storagePath: string;
  storageUrl?: string;
  expiresInSeconds?: number;
}): Promise<{
  url: string;
  accessMode: 'public_url' | 'signed_url' | 'proxy';
  storageProvider: string;
  expiresInSeconds: number | null;
}> {
  if (params.storageProvider === 'supabase') {
    const supabaseAdmin = getSupabaseStorageAdminClient();
    const bucket = params.storageBucket || getSupabaseBucketName();
    if (
      supabaseAdmin &&
      (isSupabasePublicStorageEnabled() ||
        (params.storageUrl && params.storageUrl.includes('/storage/v1/object/public/')))
    ) {
      const { data } = supabaseAdmin.storage.from(bucket).getPublicUrl(params.storagePath);
      if (data?.publicUrl) {
        return {
          url: data.publicUrl,
          accessMode: 'public_url',
          storageProvider: 'supabase',
          expiresInSeconds: null,
        };
      }
    }

    const signed = await createSignedStorageUrl(params);
    if (signed) {
      return {
        url: signed.signedUrl,
        accessMode: 'signed_url',
        storageProvider: 'supabase',
        expiresInSeconds: signed.expiresInSeconds,
      };
    }
  }
  return {
    url: `/api/files/${encodeURIComponent(params.fileId)}`,
    accessMode: 'proxy',
    storageProvider: params.storageProvider,
    expiresInSeconds: null,
  };
}
