import {
  AuditLogEntry,
  CheckRecord,
  OrderRecord,
  ProcurementItem,
  ProcurementStatus,
  UserAccountPublic,
} from '../shared/types';

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

  uploadFile: async (file: File, kind: 'order_doc' | 'check_attachment' | 'signature') => {
    const fd = new FormData();
    fd.append('file', file);
    fd.append('kind', kind);
    return apiRequest<{ fileId: string; mimeType: string; originalName: string }>('/api/files', {
      method: 'POST',
      body: fd,
    });
  },

  fetchFileBlobUrl: async (fileId: string): Promise<{ blobUrl: string; mimeType: string }> => {
    const headers = new Headers();
    if (inMemoryToken) headers.set('Authorization', `Bearer ${inMemoryToken}`);
    const res = await fetch(`/api/files/${encodeURIComponent(fileId)}`, { headers });
    if (!res.ok) {
      throw new ApiError(res.status, 'عدم دسترسی یا خطا در دریافت فایل از سرور');
    }
    const blob = await res.blob();
    return { blobUrl: URL.createObjectURL(blob), mimeType: blob.type };
  },

  downloadFile: async (fileId: string, filename: string): Promise<void> => {
    const { blobUrl } = await api.fetchFileBlobUrl(fileId);
    const a = document.createElement('a');
    a.href = blobUrl;
    a.download = filename || 'document';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(blobUrl), 2000);
  },

  getOrders: (params: { filter?: string; stage?: number | null; search?: string; page?: number; limit?: number }) => {
    const sp = new URLSearchParams();
    if (params.filter) sp.set('filter', params.filter);
    if (params.stage !== null && params.stage !== undefined) sp.set('stage', String(params.stage));
    if (params.search) sp.set('search', params.search);
    if (params.page) sp.set('page', String(params.page));
    if (params.limit) sp.set('limit', String(params.limit));
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
  }) => apiRequest<{ order: OrderRecord }>('/api/orders', { method: 'POST', body: JSON.stringify(payload) }),

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
      signaturePngBase64: string;
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

  getProcurement: () => apiRequest<{ items: ProcurementItem[] }>('/api/procurement'),
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
