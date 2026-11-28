import crypto from 'node:crypto';
import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { RoleId, UserAccountPublic } from '../src/shared/types';

export interface SupabaseRlsJwtClaims {
  aud: 'authenticated';
  role: 'authenticated';
  sub: string;
  app_user_id: RoleId;
  app_role: RoleId;
  is_sales: boolean;
  can_access_finance: boolean;
  can_access_procurement: boolean;
  iat: number;
  exp: number;
}

export interface SupabaseConfigStatus {
  storageConfigured: boolean;
  databaseRlsConfigured: boolean;
  bucketName: string;
}

const DEFAULT_BUCKET = 'autoparts-documents';

function base64UrlEncode(input: string | Buffer): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64UrlDecode(input: string): Buffer {
  const normalized = input.replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4 === 0 ? '' : '='.repeat(4 - (normalized.length % 4));
  return Buffer.from(normalized + pad, 'base64');
}

export function getSupabaseBucketName(): string {
  const raw = (process.env.SUPABASE_STORAGE_BUCKET || DEFAULT_BUCKET).trim();
  // Restrict bucket name to safe lowercase alphanumeric/hyphen characters
  return /^[a-z0-9][a-z0-9-_]{1,62}$/.test(raw) ? raw : DEFAULT_BUCKET;
}

export function getSupabaseConfigStatus(): SupabaseConfigStatus {
  const url = (process.env.SUPABASE_URL || '').trim();
  const serviceKey = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
  const anonKey = (process.env.SUPABASE_ANON_KEY || '').trim();
  const jwtSecret = (process.env.SUPABASE_JWT_SECRET || '').trim();

  const hasValidUrl = /^https:\/\/[a-zA-Z0-9.-]+/.test(url);
  return {
    storageConfigured: hasValidUrl && serviceKey.length >= 20,
    databaseRlsConfigured: hasValidUrl && anonKey.length >= 20 && jwtSecret.length >= 16,
    bucketName: getSupabaseBucketName(),
  };
}

/**
 * Mints a short-lived HS256 JWT recognized by Supabase PostgREST / PostgreSQL RLS (`auth.jwt()`).
 * The token carries signed role claims (`app_role`, `app_user_id`, `is_sales`, etc.) so that
 * PostgreSQL Row-Level Security policies enforce RBAC directly at the database engine layer.
 * Never exposed to the browser client.
 */
export function mintSupabaseRlsJwt(
  user: UserAccountPublic,
  jwtSecret: string,
  ttlSeconds = 300,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): string {
  if (!jwtSecret || jwtSecret.length < 16) {
    throw new Error('SUPABASE_JWT_SECRET must be at least 16 characters.');
  }

  const header = { alg: 'HS256', typ: 'JWT' };
  const payload: SupabaseRlsJwtClaims = {
    aud: 'authenticated',
    role: 'authenticated',
    sub: user.id,
    app_user_id: user.id,
    app_role: user.id,
    is_sales: user.isSales,
    can_access_finance: user.canAccessFinance,
    can_access_procurement: user.canAccessProcurement,
    iat: nowEpochSeconds,
    exp: nowEpochSeconds + Math.max(30, Math.min(900, ttlSeconds)),
  };

  const encodedHeader = base64UrlEncode(JSON.stringify(header));
  const encodedPayload = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const signature = crypto.createHmac('sha256', jwtSecret).update(signingInput).digest();
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

/**
 * Verifies an HS256 Supabase RLS JWT with constant-time signature comparison and expiration check.
 */
export function verifySupabaseRlsJwt(
  token: string,
  jwtSecret: string,
  nowEpochSeconds = Math.floor(Date.now() / 1000),
): SupabaseRlsJwtClaims | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [encodedHeader, encodedPayload, encodedSig] = parts;
  const signingInput = `${encodedHeader}.${encodedPayload}`;

  const expectedSig = crypto.createHmac('sha256', jwtSecret).update(signingInput).digest();
  const actualSig = base64UrlDecode(encodedSig);
  if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
    return null;
  }

  try {
    const header = JSON.parse(base64UrlDecode(encodedHeader).toString('utf8')) as { alg?: string };
    if (header.alg !== 'HS256') return null;

    const payload = JSON.parse(base64UrlDecode(encodedPayload).toString('utf8')) as SupabaseRlsJwtClaims;
    if (typeof payload.exp !== 'number' || payload.exp <= nowEpochSeconds) return null;
    if (payload.aud !== 'authenticated' || payload.role !== 'authenticated') return null;
    return payload;
  } catch {
    return null;
  }
}

let cachedStorageAdminClient: SupabaseClient | null = null;
let cachedStorageUrl = '';
let cachedStorageKey = '';

/**
 * Returns the server-only Supabase admin client used strictly for private Storage bucket operations
 * AFTER Express RBAC middleware has authorized the caller. Never exposed to the client.
 */
export function getSupabaseStorageAdminClient(): SupabaseClient | null {
  const status = getSupabaseConfigStatus();
  if (!status.storageConfigured) return null;

  const url = process.env.SUPABASE_URL!.trim();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY!.trim();

  if (cachedStorageAdminClient && cachedStorageUrl === url && cachedStorageKey === serviceKey) {
    return cachedStorageAdminClient;
  }

  cachedStorageAdminClient = createClient(url, serviceKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
  cachedStorageUrl = url;
  cachedStorageKey = serviceKey;
  return cachedStorageAdminClient;
}

/**
 * Creates a request-scoped Supabase PostgREST client authenticated with a short-lived,
 * role-scoped HS256 JWT (`app_role`, `app_user_id`, etc.) so that Supabase PostgreSQL
 * Row-Level Security (RLS) enforces RBAC directly at the database row level.
 */
export function createRoleScopedSupabaseClient(user: UserAccountPublic): SupabaseClient | null {
  const status = getSupabaseConfigStatus();
  if (!status.databaseRlsConfigured) return null;

  const url = process.env.SUPABASE_URL!.trim();
  const anonKey = process.env.SUPABASE_ANON_KEY!.trim();
  const jwtSecret = process.env.SUPABASE_JWT_SECRET!.trim();
  const rlsJwt = mintSupabaseRlsJwt(user, jwtSecret, 300);

  return createClient(url, anonKey, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${rlsJwt}`,
      },
    },
  });
}
