import { SupabaseClient } from '@supabase/supabase-js';
import {
  CheckAttachmentRecord,
  CheckRecord,
  OrderDocumentRecord,
  OrderRecord,
  ProcurementItem,
  StageHistoryEntry,
  UserAccountPublic,
} from '../src/shared/types';
import {
  canRoleAccessFinance,
  canRoleAccessProcurement,
  CURRENT_SCHEMA_VERSION,
} from '../src/shared/workflow';
import { StoredObjectMetadata } from './storage';

/**
 * Mirrors normalized records (strictly with Supabase Storage URLs, zero Base64 blobs)
 * to Supabase PostgreSQL using the request-scoped `req.supabase` client authenticated
 * with the user's signed HS256 RLS JWT (`app_role`, `app_user_id`).
 */
export async function syncFileMetadataToSupabase(
  supabase: SupabaseClient | null | undefined,
  meta: StoredObjectMetadata,
  ownerKind: string,
  ownerRecordId: string | null,
  uploadedBy: string,
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('files').upsert(
    {
      id: meta.fileId,
      storage_provider: meta.storageProvider,
      storage_bucket: meta.storageBucket,
      storage_path: meta.storagePath,
      storage_url: meta.storageUrl,
      stored_filename: meta.storedFilename,
      original_name: meta.originalName,
      mime_type: meta.mimeType,
      size_bytes: meta.sizeBytes,
      owner_kind: ownerKind,
      owner_record_id: ownerRecordId,
      uploaded_by: uploadedBy,
    },
    { onConflict: 'id', ignoreDuplicates: true },
  );
  if (error) {
    console.error('[Supabase RLS] File metadata sync error:', error.message);
    throw new Error('دسترسی یا همگام‌سازی متادیتای فایل در دیتابیس سوپابیس با خطا مواجه شد.');
  }
}

/**
 * Mirrors the SQLite "file is now attached to record X" link into the Supabase `files` table.
 * Only rows still unlinked (owner_record_id IS NULL) are updated, so links are never re-pointed.
 */
export async function linkFilesToRecordInSupabase(
  supabase: SupabaseClient | null | undefined,
  fileIds: string[],
  ownerKind: 'order_doc' | 'signature' | 'check_attachment',
  ownerRecordId: string,
): Promise<void> {
  if (!supabase) return;
  const ids = Array.from(new Set(fileIds.filter(Boolean)));
  if (ids.length === 0) return;
  const { error } = await supabase
    .from('files')
    .update({ owner_kind: ownerKind, owner_record_id: ownerRecordId })
    .in('id', ids)
    .is('owner_record_id', null);
  if (error) {
    console.error(`[Supabase RLS] File link sync error (${ownerKind} ${ownerRecordId}):`, error.message);
  }
}

/** Logs a failed Supabase mirror write instead of silently swallowing it. SQLite stays authoritative. */
export function logMirrorError(kind: string, recordId: string) {
  return (err: unknown): void => {
    console.error(
      `[Supabase mirror] Failed to mirror ${kind} ${recordId}:`,
      err instanceof Error ? err.message : err,
    );
  };
}

export async function syncOrderToSupabase(
  supabase: SupabaseClient | null | undefined,
  order: OrderRecord,
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('orders').upsert(
    {
      id: order.id,
      schema_version: order.schemaVersion,
      version: order.version,
      sales_owner_id: order.salesOwnerId,
      sales_owner_name: order.salesOwnerName,
      customer: order.customer,
      proforma: order.proforma,
      final_invoice_no: order.finalInvoiceNo,
      accounting_note: order.accountingNote,
      channel: order.channel,
      amount_toman: order.amountToman,
      payment: order.payment,
      items: order.items,
      stage: order.stage,
      status: order.status,
      rev: order.rev,
      return_reason: order.returnReason,
      return_note: order.returnNote,
      cartons_out: order.cartonsOut,
      exit_time: order.exitTime,
      driver_name: order.driverName,
      cartons_delivered: order.cartonsDelivered,
      carton_discrepancy: order.cartonDiscrepancy,
      discrepancy_note: order.discrepancyNote,
      customer_signer: order.customerSigner,
      signature_file_id: order.signatureFileId,
      signature_url: order.signatureUrl || '',
      stage_history_json: order.stageHistory,
      created_at: order.createdAt,
      updated_at: order.updatedAt,
    },
    { onConflict: 'id' },
  );
  if (error) {
    console.error('[Supabase RLS] Order sync error:', error.message);
    throw new Error('عدم مجوز RLS یا خطا در همگام‌سازی سفارش با دیتابیس سوپابیس.');
  }

  for (const doc of order.documents) {
    const { error: docErr } = await supabase.from('order_documents').upsert(
      {
        id: doc.id,
        order_id: doc.orderId,
        doc_kind: doc.docKind,
        version_no: doc.versionNo,
        file_id: doc.fileId,
        file_url: doc.fileUrl,
        original_name: doc.originalName,
        mime_type: doc.mimeType,
        uploaded_by: doc.uploadedBy,
        created_at: doc.createdAt,
      },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    if (docErr) {
      console.error(`[Supabase RLS] Order document sync error (order ${order.id}, doc ${doc.id}):`, docErr.message);
    }
  }

  await linkFilesToRecordInSupabase(supabase, order.documents.map((d) => d.fileId), 'order_doc', order.id);
  if (order.signatureFileId) {
    await linkFilesToRecordInSupabase(supabase, [order.signatureFileId], 'signature', order.id);
  }
}

export async function syncCheckToSupabase(
  supabase: SupabaseClient | null | undefined,
  check: CheckRecord,
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('checks').upsert(
    {
      id: check.id,
      version: check.version,
      doc_type: check.docType,
      customer: check.customer,
      amount_toman: check.amountToman,
      sayadi_id: check.sayadiId,
      due_date: check.dueDate,
      tracking_no: check.trackingNo,
      caption: check.caption,
      sales_owner_id: check.salesOwnerId,
      sales_owner_name: check.salesOwnerName,
      status: check.status,
      finance_status: check.financeStatus,
      finance_time: check.financeTime,
      ceo_status: check.ceoStatus,
      ceo_time: check.ceoTime,
      finalized_time: check.finalizedTime,
      reject_reason: check.rejectReason,
      rejected_by: check.rejectedBy,
      created_at: check.createdAt,
      updated_at: check.updatedAt,
    },
    { onConflict: 'id' },
  );
  if (error) {
    console.error('[Supabase RLS] Check sync error:', error.message);
    throw new Error('عدم مجوز RLS یا خطا در همگام‌سازی سند مالی با دیتابیس سوپابیس.');
  }

  for (const att of check.attachments) {
    const { error: attErr } = await supabase.from('check_attachments').upsert(
      {
        id: att.id,
        check_id: att.checkId,
        file_id: att.fileId,
        file_url: att.fileUrl,
        original_name: att.originalName,
        mime_type: att.mimeType,
        created_at: att.createdAt,
      },
      { onConflict: 'id', ignoreDuplicates: true },
    );
    if (attErr) {
      console.error(`[Supabase RLS] Check attachment sync error (check ${check.id}, attachment ${att.id}):`, attErr.message);
    }
  }

  await linkFilesToRecordInSupabase(supabase, check.attachments.map((a) => a.fileId), 'check_attachment', check.id);
}

export async function syncProcurementToSupabase(
  supabase: SupabaseClient | null | undefined,
  item: ProcurementItem,
): Promise<void> {
  if (!supabase) return;
  const { error } = await supabase.from('procurement_items').upsert(
    {
      id: item.id,
      version: item.version,
      brand: item.brand,
      part_name: item.partName,
      part_code: item.partCode,
      qty_needed: item.qtyNeeded,
      priority: item.priority,
      status: item.status,
      related_order_proforma: item.relatedOrderProforma,
      reported_by_name: item.reportedByName,
      supplier_note: item.supplierNote,
      created_at: item.createdAt,
      updated_at: item.updatedAt,
    },
    { onConflict: 'id' },
  );
  if (error) {
    console.error('[Supabase RLS] Procurement sync error:', error.message);
    throw new Error('عدم مجوز RLS یا خطا در همگام‌سازی تامین کالا با دیتابیس سوپابیس.');
  }
}

// ==================== Incremental Fetching (`updated_at > since`) on Supabase PostgreSQL ====================

function mapSupabaseOrderRow(
  row: Record<string, unknown>,
  docsByOrderId: Map<string, OrderDocumentRecord[]>,
): OrderRecord {
  const id = String(row.id);
  const signatureFileId = row.signature_file_id ? String(row.signature_file_id) : null;
  const rawSigUrl = row.signature_url ? String(row.signature_url).trim() : '';
  const historyRaw = row.stage_history_json;
  const stageHistory: StageHistoryEntry[] = Array.isArray(historyRaw)
    ? (historyRaw as StageHistoryEntry[])
    : [];

  return {
    id,
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
    items: String(row.items || ''),
    stage: Number(row.stage || 1),
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
    signatureUrl: signatureFileId
      ? rawSigUrl || `/api/files/${encodeURIComponent(signatureFileId)}`
      : null,
    stageHistory,
    documents: docsByOrderId.get(id) || [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapSupabaseCheckRow(
  row: Record<string, unknown>,
  attachmentsByCheckId: Map<string, CheckAttachmentRecord[]>,
): CheckRecord {
  const id = String(row.id);
  return {
    id,
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
    attachments: attachmentsByCheckId.get(id) || [],
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapSupabaseProcurementRow(row: Record<string, unknown>): ProcurementItem {
  return {
    id: String(row.id),
    version: Number(row.version || 1),
    brand: String(row.brand),
    partName: String(row.part_name),
    partCode: String(row.part_code || ''),
    qtyNeeded: Number(row.qty_needed || 1),
    priority: row.priority === 'فوری' ? 'فوری' : 'عادی',
    status: row.status as ProcurementItem['status'],
    relatedOrderProforma: String(row.related_order_proforma || ''),
    reportedByName: String(row.reported_by_name || ''),
    supplierNote: String(row.supplier_note || ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

/**
 * Fetches ONLY records modified after `since` (`updated_at > since`) directly from Supabase
 * using the request's role-scoped RLS client (`req.supabase`).
 * Returns `null` if Supabase is unreachable or unconfigured so caller can fall back cleanly.
 */
export async function fetchIncrementalFromSupabase(
  supabase: SupabaseClient | null | undefined,
  user: UserAccountPublic,
  since: string | null,
): Promise<{ orders: OrderRecord[]; checks: CheckRecord[]; procurement: ProcurementItem[] } | null> {
  if (!supabase) return null;

  try {
    // 1. Orders via role-projected view with strict `updated_at > since` filter
    let ordersQuery = supabase
      .from('orders_role_view')
      .select('*')
      .order('updated_at', { ascending: false })
      .limit(200);
    if (since) {
      ordersQuery = ordersQuery.gt('updated_at', since);
    }

    const { data: orderRows, error: ordersErr } = await ordersQuery;
    if (ordersErr) {
      console.error('[Supabase Incremental] Orders query error:', ordersErr.message);
      return null;
    }

    const changedOrderIds = (orderRows || []).map((r) => String(r.id));
    const docsByOrderId = new Map<string, OrderDocumentRecord[]>();
    if (changedOrderIds.length > 0) {
      const { data: docRows } = await supabase
        .from('order_documents')
        .select('id, order_id, doc_kind, version_no, file_id, file_url, original_name, mime_type, uploaded_by, created_at')
        .in('order_id', changedOrderIds)
        .order('version_no', { ascending: true });
      for (const d of docRows || []) {
        const orderId = String(d.order_id);
        const list = docsByOrderId.get(orderId) || [];
        list.push({
          id: String(d.id),
          orderId,
          docKind: d.doc_kind as OrderDocumentRecord['docKind'],
          versionNo: Number(d.version_no || 1),
          fileId: String(d.file_id),
          fileUrl: String(d.file_url || `/api/files/${encodeURIComponent(String(d.file_id))}`),
          originalName: String(d.original_name),
          mimeType: String(d.mime_type),
          uploadedBy: String(d.uploaded_by),
          createdAt: String(d.created_at),
        });
        docsByOrderId.set(orderId, list);
      }
    }

    const orders = (orderRows || []).map((r) =>
      mapSupabaseOrderRow(r as Record<string, unknown>, docsByOrderId),
    );

    // 2. Checks (only for finance-authorized roles; RLS also enforces in PostgreSQL)
    let checks: CheckRecord[] = [];
    if (canRoleAccessFinance(user.id)) {
      let checksQuery = supabase
        .from('checks')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(200);
      if (since) {
        checksQuery = checksQuery.gt('updated_at', since);
      }
      const { data: checkRows, error: checksErr } = await checksQuery;
      if (checksErr) {
        console.error('[Supabase Incremental] Checks query error:', checksErr.message);
        return null;
      }

      const changedCheckIds = (checkRows || []).map((r) => String(r.id));
      const attachmentsByCheckId = new Map<string, CheckAttachmentRecord[]>();
      if (changedCheckIds.length > 0) {
        const { data: attRows } = await supabase
          .from('check_attachments')
          .select('id, check_id, file_id, file_url, original_name, mime_type, created_at')
          .in('check_id', changedCheckIds)
          .order('created_at', { ascending: true });
        for (const a of attRows || []) {
          const checkId = String(a.check_id);
          const list = attachmentsByCheckId.get(checkId) || [];
          list.push({
            id: String(a.id),
            checkId,
            fileId: String(a.file_id),
            fileUrl: String(a.file_url || `/api/files/${encodeURIComponent(String(a.file_id))}`),
            originalName: String(a.original_name),
            mimeType: String(a.mime_type),
            createdAt: String(a.created_at),
          });
          attachmentsByCheckId.set(checkId, list);
        }
      }

      checks = (checkRows || []).map((r) =>
        mapSupabaseCheckRow(r as Record<string, unknown>, attachmentsByCheckId),
      );
    }

    // 3. Procurement (only for procurement-authorized roles)
    let procurement: ProcurementItem[] = [];
    if (canRoleAccessProcurement(user.id)) {
      let procQuery = supabase
        .from('procurement_items')
        .select('*')
        .order('updated_at', { ascending: false })
        .limit(200);
      if (since) {
        procQuery = procQuery.gt('updated_at', since);
      }
      const { data: procRows, error: procErr } = await procQuery;
      if (procErr) {
        console.error('[Supabase Incremental] Procurement query error:', procErr.message);
        return null;
      }
      procurement = (procRows || []).map((r) => mapSupabaseProcurementRow(r as Record<string, unknown>));
    }

    return { orders, checks, procurement };
  } catch (err) {
    console.error('[Supabase Incremental] Unexpected fetch error:', err);
    return null;
  }
}
