export type RoleId =
  | 'ceo'
  | 'sales_1'
  | 'sales_2'
  | 'sales_3'
  | 'sales_4'
  | 'sales_mgr'
  | 'accounting'
  | 'warehouse_sup'
  | 'driver';

export interface RoleDefinition {
  id: RoleId;
  defaultTitle: string;
  roleLabel: string;
  isSales: boolean;
  canAccessFinance: boolean;
  canAccessProcurement: boolean;
  scope: string;
}

export interface UserAccountPublic {
  id: RoleId;
  displayName: string;
  roleLabel: string;
  isSales: boolean;
  canAccessFinance: boolean;
  canAccessProcurement: boolean;
  scope: string;
  hasPin: boolean;
}

export type OrderStatus =
  | 'active'
  | 'returned_to_sales'
  | 'returned_to_sales_mgr'
  | 'returned_to_accounting';

export interface OrderDocumentRecord {
  id: string;
  orderId: string;
  docKind: 'proforma' | 'final_invoice';
  versionNo: number;
  fileId: string;
  fileUrl: string;
  originalName: string;
  mimeType: string;
  uploadedBy: string;
  createdAt: string;
}

export interface StageHistoryEntry {
  stage: number;
  action: string;
  actorName: string;
  timestamp: string;
  note?: string;
}

export interface OrderRecord {
  id: string;
  schemaVersion: number;
  version: number;
  salesOwnerId: string;
  salesOwnerName: string;
  customer: string;
  proforma: string;
  finalInvoiceNo: string;
  accountingNote: string;
  channel: string;
  amountToman: number | null;
  payment: string | null;
  items: string;
  stage: number; // 1..7 (7 = delivered)
  status: OrderStatus;
  rev: number;
  returnReason: string;
  returnNote: string;
  cartonsOut: number | null;
  exitTime: string;
  driverName: string;
  cartonsDelivered: number | null;
  cartonDiscrepancy: number;
  discrepancyNote: string;
  customerSigner: string;
  signatureFileId: string | null;
  signatureUrl: string | null;
  stageHistory: StageHistoryEntry[];
  documents: OrderDocumentRecord[];
  createdAt: string;
  updatedAt: string;
}

export type CheckDocType = 'چک دریافتی' | 'واریزی';
export type CheckApprovalStatus = 'pending' | 'approved' | 'rejected';
export type CheckLifecycleStatus = 'pending' | 'finalized' | 'returned';

export interface CheckAttachmentRecord {
  id: string;
  checkId: string;
  fileId: string;
  fileUrl: string;
  originalName: string;
  mimeType: string;
  createdAt: string;
}

export interface CheckRecord {
  id: string;
  version: number;
  docType: CheckDocType;
  customer: string;
  amountToman: number;
  sayadiId: string;
  dueDate: string; // YYYY-MM-DD (Gregorian ISO date for reliable sorting/alerts)
  trackingNo: string;
  caption: string;
  salesOwnerId: string;
  salesOwnerName: string;
  status: CheckLifecycleStatus;
  financeStatus: CheckApprovalStatus;
  financeTime: string;
  ceoStatus: CheckApprovalStatus;
  ceoTime: string;
  finalizedTime: string;
  rejectReason: string;
  rejectedBy: string;
  attachments: CheckAttachmentRecord[];
  createdAt: string;
  updatedAt: string;
}

export type ProcurementStatus = 'reported' | 'ordered' | 'received';

export interface ProcurementItem {
  id: string;
  version: number;
  brand: string;
  partName: string;
  partCode: string;
  qtyNeeded: number;
  priority: 'فوری' | 'عادی';
  status: ProcurementStatus;
  relatedOrderProforma: string;
  reportedByName: string;
  supplierNote: string;
  createdAt: string;
  updatedAt: string;
}

export interface AuditLogEntry {
  id: number;
  actorId: string;
  actorName: string;
  /** 'admin' entries (backups, restores, report exports) are visible to the CEO only. */
  category: 'order' | 'finance' | 'procurement' | 'security' | 'settings' | 'admin';
  message: string;
  createdAt: string;
}

export interface IncrementalSyncResponse {
  cursor: string;
  serverTime: string;
  since: string | null;
  isIncremental: boolean;
  source: 'supabase' | 'local';
  changedCount: number;
  orders: OrderRecord[];
  checks: CheckRecord[];
  procurement: ProcurementItem[];
  /** Records that changed since the cursor but are no longer visible to the caller's role. */
  removedOrderIds?: string[];
  removedCheckIds?: string[];
}

export const ROLE_DEFINITIONS: RoleDefinition[] = [
  {
    id: 'ceo',
    defaultTitle: 'مدیرعامل',
    roleLabel: 'مدیریت ارشد',
    isSales: false,
    canAccessFinance: true,
    canAccessProcurement: true,
    scope: 'گزارش جامع فروش، تایید مدارک مالی، تنظیمات امنیتی و نظارت تامین',
  },
  {
    id: 'sales_1',
    defaultTitle: 'کارشناس فروش ۱',
    roleLabel: 'کارشناس فروش',
    isSales: true,
    canAccessFinance: true,
    canAccessProcurement: false,
    scope: 'ثبت پیش‌فاکتور، اخذ تاییدیه مشتری و بارگذاری مدارک تسویه مشتریان خود',
  },
  {
    id: 'sales_2',
    defaultTitle: 'کارشناس فروش ۲',
    roleLabel: 'کارشناس فروش',
    isSales: true,
    canAccessFinance: true,
    canAccessProcurement: false,
    scope: 'ثبت پیش‌فاکتور، اخذ تاییدیه مشتری و بارگذاری مدارک تسویه مشتریان خود',
  },
  {
    id: 'sales_3',
    defaultTitle: 'کارشناس فروش ۳',
    roleLabel: 'کارشناس فروش',
    isSales: true,
    canAccessFinance: true,
    canAccessProcurement: false,
    scope: 'ثبت پیش‌فاکتور، اخذ تاییدیه مشتری و بارگذاری مدارک تسویه مشتریان خود',
  },
  {
    id: 'sales_4',
    defaultTitle: 'کارشناس فروش ۴',
    roleLabel: 'کارشناس فروش',
    isSales: true,
    canAccessFinance: true,
    canAccessProcurement: false,
    scope: 'ثبت پیش‌فاکتور، اخذ تاییدیه مشتری و بارگذاری مدارک تسویه مشتریان خود',
  },
  {
    id: 'sales_mgr',
    defaultTitle: 'مدیر فروش',
    roleLabel: 'سرپرستی فروش',
    isSales: false,
    canAccessFinance: true,
    canAccessProcurement: true,
    scope: 'تایید پیش‌فاکتورها و رسیدگی به مغایرت‌های عودتی از واحد مالی',
  },
  {
    id: 'accounting',
    defaultTitle: 'واحد حسابداری و مالی',
    roleLabel: 'مالی و حسابداری',
    isSales: false,
    canAccessFinance: true,
    canAccessProcurement: true,
    scope: 'تبدیل پیش‌فاکتور به فاکتور فروش، اصلاح مغایرت انبار و مدیریت صندوق چک',
  },
  {
    id: 'warehouse_sup',
    defaultTitle: 'سرپرست انبار',
    roleLabel: 'انبار و لجستیک',
    isSales: false,
    canAccessFinance: false,
    canAccessProcurement: true,
    scope: 'جمع‌آوری کالا، ثبت تعداد کارتن، ساعت خروج و اعلام کسری موجودی',
  },
  {
    id: 'driver',
    defaultTitle: 'راننده و توزیع',
    roleLabel: 'توزیع و تحویل',
    isSales: false,
    canAccessFinance: false,
    canAccessProcurement: false,
    scope: 'تحویل نهایی بار، ثبت مغایرت کارتن و دریافت امضای دیجیتال مشتری',
  },
];

export interface StageDefinition {
  id: number;
  short: string;
  roleId: string;
}

export const STAGES: StageDefinition[] = [
  { id: 1, short: 'کارشناس فروش', roleId: 'sales' },
  { id: 2, short: 'مدیر فروش', roleId: 'sales_mgr' },
  { id: 3, short: 'تاییدیه مشتری', roleId: 'sales_owner' },
  { id: 4, short: 'حسابداری و فاکتور', roleId: 'accounting' },
  { id: 5, short: 'سرپرست انبار', roleId: 'warehouse_sup' },
  { id: 6, short: 'راننده و امضا', roleId: 'driver' },
];

export const TOP_BRANDS: string[] = [
  'عظام (Ezam)',
  'کروز (Crouse)',
  'ایساکو (ISACO)',
  'سایپا یدک (Saipa Yadak)',
  'دینا پارت (Dina Part)',
  'والئو (Valeo)',
  'امکو (EMCO)',
  'بوش (Bosch)',
  'تکستار (Textar)',
  'پارس لنت (Pars Lent)',
  'گیتس (Gates)',
  'کانتیننتال (Continental)',
  'سکو (SECO)',
  'فرانتک (Frantech)',
  'ماندگار پارت',
  'سایر برندهای ۵۰گانه',
];

// ==================== Invoice auto-fill & duplicate detection ====================
export interface DuplicateInvoiceInfo {
  orderId: string;
  number: string;
  registeredBy: string;
  registeredAt: string;
  message: string;
}

export type InvoiceFieldKey = 'proforma' | 'amountToman' | 'items' | 'customer';

export interface InvoiceExtractionResultDto {
  ok: boolean;
  invoiceNumber?: string | null;
  invoiceDate?: string | null;
  buyerCode?: string | null;
  grandTotalRial?: number | null;
  amountToman?: number | null;
  itemsText?: string;
  warnings?: Partial<Record<InvoiceFieldKey, string>>;
  error?: string;
}

export interface InvoiceExtractionResponse {
  result: InvoiceExtractionResultDto;
  customerName?: string | null;
  duplicate?: DuplicateInvoiceInfo | null;
}

// ==================== CEO reports (CEO-only endpoints) ====================
export interface CeoReportRepRow {
  salesOwnerId: string;
  salesOwnerName: string;
  ordersCreated: number;
  amountCreatedToman: number;
  delivered: number;
  amountDeliveredToman: number;
  returned: number;
  inProgress: number;
}

export interface CeoReport {
  range: { from: string | null; to: string | null };
  generatedAt: string;
  orders: {
    created: number;
    amountCreatedToman: number;
    delivered: number;
    amountDeliveredToman: number;
    returned: number;
    inProgress: number;
    avgDeliveryHours: number | null;
    cartonDiscrepancies: number;
    /** Current pipeline snapshot (all open orders, ignores the date range). */
    pipelineByStage: Array<{ stage: number; label: string; count: number; amountToman: number }>;
    returnReasons: Array<{ reason: string; count: number }>;
  };
  reps: CeoReportRepRow[];
  checks: {
    submitted: number;
    amountSubmittedToman: number;
    finalized: number;
    amountFinalizedToman: number;
    pending: number;
    amountPendingToman: number;
    returned: number;
    byDocType: Array<{ docType: string; count: number; amountToman: number }>;
    /** Pending/finalized received checks due in the next 30 days (ignores the date range). */
    upcomingDue: Array<{ id: string; customer: string; amountToman: number; dueDate: string; sayadiId: string; salesOwnerName: string; status: string }>;
  };
  procurement: { open: number; urgentOpen: number };
  /** Time series over the range: day buckets up to 31 days, weeks up to ~4 months, Jalali months beyond. */
  timeline: {
    granularity: 'day' | 'week' | 'month';
    points: Array<{
      key: string;
      label: string;
      createdCount: number;
      createdAmountToman: number;
      deliveredCount: number;
      deliveredAmountToman: number;
    }>;
  };
  byChannel: Array<{ label: string; count: number; amountToman: number }>;
  byPayment: Array<{ label: string; count: number; amountToman: number }>;
  topCustomers: Array<{ customer: string; orders: number; amountToman: number; delivered: number }>;
}

export interface StoredBackupInfoDto {
  name: string;
  kind: 'auto' | 'safety';
  sizeBytes: number;
  createdAt: string;
}
