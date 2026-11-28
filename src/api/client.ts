import {
  AuditLogEntry,
  CeoReport,
  StoredBackupInfoDto,
  CheckRecord,
  DuplicateInvoiceInfo,
  InvoiceExtractionResponse,
  IncrementalSyncResponse,
  OrderRecord,
  ProcurementItem,
  ProcurementStatus,
  UserAccountPublic,
} from '../shared/types';
import { isDirectSupabasePublicUrl, isSafeStorageResourceUrl } from '../shared/sync';

// Strictly in-memory session token — NEVER written to localStorage or sessionStorage
let inMemoryToken: string | null = null;

export function setAuthToken(token: string | null): void {
  inMemoryToken = token;
}

export function getAuthToken(): string | null {
  return inMemoryToken;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function apiRequest<T>(url: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers || {});
  if (inMemoryToken) {
    headers.set('Authorization', `Bearer ${inMemoryToken}`);
  }
  if (!(init.body instanceof FormData) && init.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const res = await fetch(url, { ...init, headers });
  const contentType = res.headers.get('content-type') || '';
  const data = contentType.includes('application/json') ? await res.json() : null;

  if (!res.ok) {
    throw new ApiError(res.status, data?.error || `خطای سرور (کد ${res.status})`);
  }
  return data as T;
}

export interface AuthStatusResponse {
  initialized: boolean;
  roles: UserAccountPublic[];
}

export interface LoginResponse {
  token: string;
  expiresAt: string;
  user: UserAccountPublic;
}

export interface OrdersListResponse {
  items: OrderRecord[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
  stats: {
    total: number;
    salesFlow: number;
    warehouse: number;
    driver: number;
    delivered: number;
    returned: number;
    totalActiveAmountToman: number;
    totalDeliveredAmountToman: number;
  };
  stageCounts: Record<number, number>;
  repBreakdown: Array<{
    roleId: string;
    displayName: string;
    total: number;
    inProgress: number;
    returned: number;
    delivered: number;
    totalAmountToman: number;
  }>;
  syncCursor?: string;
}

export interface ChecksListResponse {
  items: CheckRecord[];
  summary: {
    pendingCount: number;
    pendingMeCount: number;
    safeChecksCount: number;
    safeChecksAmountToman: number;
    approvedDepositsCount: number;
    approvedDepositsAmountToman: number;
    returnedCount: number;
  };
  uploaderBreakdown: Array<{
    roleId: string;
    displayName: string;
    pending: number;
    safeChecks: number;
    approvedDeposits: number;
    returned: number;
    finalizedAmountToman: number;
  }>;
  syncCursor?: string;
}

export interface LogsListResponse {
  items: AuditLogEntry[];
  pagination: { page: number; limit: number; total: number; totalPages: number };
}

export interface WhatsAppSummaryResponse {
  text: string;
  url: string;
  truncatedCount: number;
}

export interface SettingsResponse {
  waPhone: string;
  roles: UserAccountPublic[];
}

export const api = {
  getAuthStatus: () => apiRequest<AuthStatusResponse>('/api/auth/status'),
  bootstrapAdmin: (payload: { ceoPin: string; staffInitialPin?: string; waPhone?: string }) =>
    apiRequest<LoginResponse>('/api/auth/bootstrap', { method: 'POST', body: JSON.stringify(payload) }),
  login: (roleId: string, pin: string) =>
    apiRequest<LoginResponse>('/api/auth/login', { method: 'POST', body: JSON.stringify({ roleId, pin }) }),
  logout: () => apiRequest<{ ok: boolean }>('/api/auth/logout', { method: 'POST' }),
  me: () => apiRequest<{ user: UserAccountPublic; roles: UserAccountPublic[] }>('/api/auth/me'),

  syncChanges: (since?: string | null) => {
    const sp = new URLSearchParams();
    if (since) sp.set('since', since);
    const qs = sp.toString();
    return apiRequest<IncrementalSyncResponse>(qs ? `/api/sync?${qs}` : '/api/sync');
  },

  uploadFile: async (file: File, kind: 'order_doc' | 'check_attachment' | 'signature') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind);
    return apiRequest<{
      fileId: string;
      fileUrl: string;
      storageUrl: string;
      storageProvider: string;
      mimeType: string;
      originalName: string;
    }>('/api/files', {
      method: 'POST',
      body: fd,
    });
  },

  /**
   * Resolves a verified display URL for a PDF, check photo, or signature stored in Supabase Storage.
   * 1. If the DB record already holds a verified Supabase Storage public URL (`/storage/v1/object/public/...`),
   *    returns it directly with zero extra server round-trip.
   * 2. Otherwise requests a short-lived RBAC-gated URL from `POST /api/files/:id/signed-url`
   *    (returns Supabase signed/public HTTPS URL directly when Supabase Storage is configured).
   * 3. Falls back to authenticated `/api/files/:id` proxy stream returning a revocable Blob URL.
   */
  resolveFileDisplayUrl: async (
    fileId: string,
    fileUrl?: string | null,
    mimeTypeHint?: string | null,
  ): Promise<{ url: string; mimeType: string; revoke: boolean }> => {
    if (fileUrl && isDirectSupabasePublicUrl(fileUrl)) {
      return {
        url: fileUrl,
        mimeType: mimeTypeHint || 'application/octet-stream',
        revoke: false,
      };
    }

    const signedInfo = await apiRequest<{
      url: string;
      accessMode?: 'public_url' | 'signed_url' | 'proxy';
      mimeType: string;
      originalName: string;
      storageProvider: string;
      expiresInSeconds: number | null;
    }>(`/api/files/${encodeURIComponent(fileId)}/signed-url`, { method: 'POST' });

    if (
      signedInfo.storageProvider === 'supabase' &&
      signedInfo.url.startsWith('https://') &&
      isSafeStorageResourceUrl(signedInfo.url)
    ) {
      return {
        url: signedInfo.url,
        mimeType: signedInfo.mimeType || mimeTypeHint || 'application/octet-stream',
        revoke: false,
      };
    }

    const proxyPath = isSafeStorageResourceUrl(signedInfo.url)
      ? signedInfo.url
      : `/api/files/${encodeURIComponent(fileId)}`;

    const headers = new Headers();
    if (inMemoryToken) headers.set('Authorization', `Bearer ${inMemoryToken}`);
    const res = await fetch(proxyPath, { headers });
    if (!res.ok) {
      throw new ApiError(res.status, 'عدم دسترسی یا خطا در دریافت فایل از مخزن ذخیره‌سازی');
    }
    const blob = await res.blob();
    return {
      url: URL.createObjectURL(blob),
      mimeType: blob.type || signedInfo.mimeType || mimeTypeHint || 'application/octet-stream',
      revoke: true,
    };
  },

  fetchFileBlobUrl: async (
    fileId: string,
    fileUrl?: string | null,
    mimeTypeHint?: string | null,
  ): Promise<{ blobUrl: string; mimeType: string }> => {
    const resolved = await api.resolveFileDisplayUrl(fileId, fileUrl, mimeTypeHint);
    if (resolved.revoke) {
      return { blobUrl: resolved.url, mimeType: resolved.mimeType };
    }
    const res = await fetch(resolved.url);
    if (!res.ok) {
      throw new ApiError(res.status, 'خطا در دریافت فایل از Supabase Storage');
    }
    const blob = await res.blob();
    return { blobUrl: URL.createObjectURL(blob), mimeType: blob.type || resolved.mimeType };
  },

  downloadFile: async (fileId: string, filename: string, fileUrl?: string | null): Promise<void> => {
    const { blobUrl } = await api.fetchFileBlobUrl(fileId, fileUrl);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'document';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
  },

  getOrders: (params: {
    filter?: string;
    stage?: number | null;
    search?: string;
    page?: number;
    limit?: number;
    since?: string | null;
  }) => {
    const sp = new URLSearchParams();
    if (params.filter) sp.set('filter', params.filter);
    if (params.stage !== null && params.stage !== undefined) sp.set('stage', String(params.stage));
    if (params.search) sp.set('search', params.search);
    if (params.page) sp.set('page', String(params.page));
    if (params.limit) sp.set('limit', String(params.limit));
    if (params.since) sp.set('since', params.since);
    return apiRequest<OrdersListResponse>(`/api/orders?${sp.toString()}`);
  },

  createOrder: (payload: {
    customer: string;
    proforma: string;
    channel: string;
    amountToman: string | number;
    payment: string;
    items: string;
    fileId?: string | null;
    customerCode?: string | null;
  }) => apiRequest<{ order: OrderRecord }>('/api/orders', { method: 'POST', body: JSON.stringify(payload) }),

  /** Reads an uploaded proforma PDF on the server and returns suggested (editable) form values. */
  extractInvoice: (fileId: string, orderId?: string | null) =>
    apiRequest<InvoiceExtractionResponse>('/api/invoices/extract', {
      method: 'POST',
      body: JSON.stringify(orderId ? { fileId, orderId } : { fileId }),
    }),

  /** Instant duplicate check for a proforma number while the form is being filled. */
  checkProforma: (num: string, excludeOrderId?: string | null) => {
    const sp = new URLSearchParams({ number: num });
    if (excludeOrderId) sp.set('excludeOrderId', excludeOrderId);
    return apiRequest<{ duplicate: DuplicateInvoiceInfo | null }>(`/api/orders/check-proforma?${sp.toString()}`);
  },

  advanceOrder: (id: string, expectedVersion: number) =>
    apiRequest<{ order: OrderRecord }>(`/api/orders/${encodeURIComponent(id)}/advance`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion }),
    }),

  mgrResolveOrder: (id: string, expectedVersion: number) =>
    apiRequest<{ order: OrderRecord }>(`/api/orders/${encodeURIComponent(id)}/mgr-resolve`, {
      method: 'POST',
      body: JSON.stringify({ expectedVersion }),
    }),

  convertInvoice: (
    id: string,
    payload: {
      expectedVersion: number;
      finalInvoiceNo: string;
      amountToman: string | number;
      items: string;
      accountingNote: string;
      fileId?: string | null;
    },
  ) =>
    apiRequest<{ order: OrderRecord }>(`/api/orders/${encodeURIComponent(id)}/convert-invoice`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  warehouseExit: (
    id: string,
    payload: { expectedVersion: number; cartonsOut: number; exitTime: string; driverName: string },
  ) =>
    apiRequest<{ order: OrderRecord }>(`/api/orders/${encodeURIComponent(id)}/warehouse-exit`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  driverDelivery: (
    id: string,
    payload: {
      expectedVersion: number;
      cartonsDelivered: number;
      customerSigner: string;
      discrepancyNote: string;
      signatureFileId: string;
    },
  ) =>
    apiRequest<{ order: OrderRecord }>(`/api/orders/${encodeURIComponent(id)}/driver-delivery`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  returnOrder: (
    id: string,
    payload: {
      expectedVersion: number;
      target: 'sales' | 'sales_mgr' | 'customer_reject' | 'accounting';
      reason: string;
      note: string;
      createShortageTicket?: boolean;
      shortageBrand?: string;
      shortagePart?: string;
      shortageQty?: number;
    },
  ) =>
    apiRequest<{ order: OrderRecord }>(`/api/orders/${encodeURIComponent(id)}/return`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  reviseOrder: (
    id: string,
    payload: {
      expectedVersion: number;
      proforma: string;
      amountToman: string | number;
      items: string;
      fileId?: string | null;
    },
  ) =>
    apiRequest<{ order: OrderRecord }>(`/api/orders/${encodeURIComponent(id)}/revise`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getChecks: (params: { filter?: string; owner?: string; sort?: string }) => {
    const sp = new URLSearchParams();
    if (params.filter) sp.set('filter', params.filter);
    if (params.owner) sp.set('owner', params.owner);
    if (params.sort) sp.set('sort', params.sort);
    return apiRequest<ChecksListResponse>(`/api/checks?${sp.toString()}`);
  },

  createCheck: (payload: {
    docType: 'چک دریافتی' | 'واریزی';
    customer: string;
    amountToman: string | number;
    sayadiId: string;
    dueDate: string;
    trackingNo: string;
    caption: string;
    fileIds: string[];
  }) => apiRequest<{ check: CheckRecord }>('/api/checks', { method: 'POST', body: JSON.stringify(payload) }),

  approveCheck: (id: string) =>
    apiRequest<{ check: CheckRecord }>(`/api/checks/${encodeURIComponent(id)}/approve`, { method: 'POST' }),

  rejectCheck: (id: string, reason: string) =>
    apiRequest<{ check: CheckRecord }>(`/api/checks/${encodeURIComponent(id)}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  reviseCheck: (
    id: string,
    payload: {
      customer: string;
      amountToman: string | number;
      sayadiId: string;
      dueDate: string;
      trackingNo: string;
      caption: string;
      fileIds: string[];
    },
  ) =>
    apiRequest<{ check: CheckRecord }>(`/api/checks/${encodeURIComponent(id)}/revise`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  getProcurement: (since?: string | null) => {
    const sp = new URLSearchParams();
    if (since) sp.set('since', since);
    const qs = sp.toString();
    return apiRequest<{ items: ProcurementItem[]; syncCursor?: string }>(
      qs ? `/api/procurement?${qs}` : '/api/procurement',
    );
  },
  createProcurement: (payload: {
    brand: string;
    partName: string;
    partCode: string;
    qtyNeeded: number;
    priority: 'فوری' | 'عادی';
    relatedOrderProforma: string;
    supplierNote: string;
  }) => apiRequest<{ item: ProcurementItem }>('/api/procurement', { method: 'POST', body: JSON.stringify(payload) }),

  updateProcurement: (id: string, payload: { status: ProcurementStatus; supplierNote?: string }) =>
    apiRequest<{ item: ProcurementItem }>(`/api/procurement/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(payload),
    }),

  getLogs: (page = 1, limit = 30) => apiRequest<LogsListResponse>(`/api/logs?page=${page}&limit=${limit}`),
  getWhatsAppSummary: () => apiRequest<WhatsAppSummaryResponse>('/api/whatsapp-summary'),

  getSettings: () => apiRequest<SettingsResponse>('/api/settings'),
  updateSettings: (payload: {
    waPhone?: string;
    roles?: Array<{ id: string; displayName?: string; newPin?: string }>;
  }) => apiRequest<SettingsResponse>('/api/settings', { method: 'PUT', body: JSON.stringify(payload) }),
};

export function subscribeLiveEvents(onEvent: (scope: string) => void): () => void {
  if (!inMemoryToken) return () => {};
  const es = new EventSource(`/api/events?token=${encodeURIComponent(inMemoryToken)}`);
  es.onmessage = (ev) => {
    try {
      const parsed = JSON.parse(ev.data);
      if (parsed?.scope && parsed.scope !== 'connected') {
        onEvent(String(parsed.scope));
      }
    } catch {
      // ignore malformed ping
    }
  };
  return () => {
    es.close();
  };
}


// ==================== CEO-only admin API (server rejects every other role with 403) ====================

/** Downloads an authenticated binary response and hands it to the browser as a file. */
async function downloadAuthenticated(url: string, fallbackName: string): Promise<void> {
  const headers = new Headers();
  if (inMemoryToken) headers.set('Authorization', `Bearer ${inMemoryToken}`);
  const res = await fetch(url, { headers });
  if (!res.ok) {
    const data = (res.headers.get('content-type') || '').includes('application/json') ? await res.json() : null;
    throw new ApiError(res.status, data?.error || `خطای سرور (کد ${res.status})`);
  }
  const disposition = res.headers.get('content-disposition') || '';
  const match = disposition.match(/filename="([^"]+)"/);
  const blob = await res.blob();
  const objectUrl = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = objectUrl;
  a.download = match?.[1] || fallbackName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(objectUrl), 10_000);
}

function rangeQuery(from: string | null, to: string | null): string {
  const sp = new URLSearchParams();
  if (from) sp.set('from', from);
  if (to) sp.set('to', to);
  const q = sp.toString();
  return q ? `?${q}` : '';
}

export const adminApi = {
  getReport: (from: string | null, to: string | null) =>
    apiRequest<{ report: CeoReport }>(`/api/admin/reports/summary${rangeQuery(from, to)}`),

  downloadReportXlsx: (from: string | null, to: string | null) =>
    downloadAuthenticated(`/api/admin/reports/export.xlsx${rangeQuery(from, to)}`, 'report.xlsx'),

  downloadFullBackup: () => downloadAuthenticated('/api/admin/backups/full', 'portal-backup.zip'),

  listBackups: () => apiRequest<{ backups: StoredBackupInfoDto[] }>('/api/admin/backups'),

  downloadStoredBackup: (name: string) =>
    downloadAuthenticated(`/api/admin/backups/stored/${encodeURIComponent(name)}`, name),

  restoreBackup: (file: File, pin: string) => {
    const fd = new FormData();
    fd.append('pin', pin);
    fd.append('backup', file);
    return apiRequest<{
      summary: { backupCreatedAt: string; counts: Record<string, number>; filesRestored: number; safetyBackup: string };
    }>('/api/admin/backups/restore', { method: 'POST', body: fd });
  },
};
