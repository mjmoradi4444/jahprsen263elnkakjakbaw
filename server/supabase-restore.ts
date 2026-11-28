import { SupabaseClient } from '@supabase/supabase-js';
import { db } from './db';
import { getSupabaseStorageAdminClient } from './supabase';

/**
 * Durability layer for hosts without a persistent disk.
 *
 * SQLite is the authoritative store while the server runs; every business write is mirrored to
 * Supabase. If the server restarts with an empty SQLite file (ephemeral disk), this module pulls
 * the mirrored data back so nothing is lost. Accounts (PIN hashes) and settings are mirrored with
 * the server-only service-role client because their tables have no RLS policies at all: they are
 * unreadable to every JWT-based client by design.
 */

const PAGE_SIZE = 1000;

function toIso(value: unknown): string {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : new Date().toISOString();
}

async function fetchAllRows(
  client: SupabaseClient,
  table: string,
): Promise<Array<Record<string, unknown>>> {
  const rows: Array<Record<string, unknown>> = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await client
      .from(table)
      .select('*')
      .order('id', { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`${table}: ${error.message}`);
    rows.push(...((data || []) as Array<Record<string, unknown>>));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

async function fetchAllSettings(client: SupabaseClient): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await client.from('settings').select('*');
  if (error) throw new Error(`settings: ${error.message}`);
  return (data || []) as Array<Record<string, unknown>>;
}

async function fetchAllCustomerCodes(client: SupabaseClient): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await client.from('customer_codes').select('*');
  if (error) {
    // Table is created by migration 002; restoring orders must not fail if it was not run yet.
    console.error('[Supabase restore] customer_codes:', error.message);
    return [];
  }
  return (data || []) as Array<Record<string, unknown>>;
}

/** Mirrors all accounts (display names, PIN hashes) and settings to Supabase. Never throws. */
export async function mirrorUsersAndSettingsToSupabase(): Promise<void> {
  const admin = getSupabaseStorageAdminClient();
  if (!admin) return;
  try {
    const users = db.prepare(`SELECT * FROM users`).all() as Array<Record<string, unknown>>;
    if (users.length > 0) {
      const { error } = await admin.from('users').upsert(
        users.map((u) => ({
          id: u.id,
          display_name: u.display_name,
          role_label: u.role_label,
          is_sales: Boolean(u.is_sales),
          can_access_finance: Boolean(u.can_access_finance),
          can_access_procurement: Boolean(u.can_access_procurement),
          scope: u.scope,
          pin_hash: u.pin_hash,
          pin_salt: u.pin_salt,
          updated_at: u.updated_at,
        })),
        { onConflict: 'id' },
      );
      if (error) console.error('[Supabase mirror] users:', error.message);
    }

    const settings = db.prepare(`SELECT * FROM settings`).all() as Array<Record<string, unknown>>;
    if (settings.length > 0) {
      const { error } = await admin
        .from('settings')
        .upsert(settings.map((s) => ({ key: s.key, value: s.value, updated_at: s.updated_at })), {
          onConflict: 'key',
        });
      if (error) console.error('[Supabase mirror] settings:', error.message);
    }
  } catch (err) {
    console.error('[Supabase mirror] users/settings:', err instanceof Error ? err.message : err);
  }
}

/**
 * If the local SQLite database has no business data but Supabase does, restore everything from
 * Supabase. Runs once at startup, before the server accepts requests. Never throws: on failure the
 * server still starts (with whatever SQLite has) and the error is logged.
 */
export async function restoreFromSupabaseIfEmpty(clientOverride?: SupabaseClient): Promise<void> {
  const admin = clientOverride ?? getSupabaseStorageAdminClient();
  if (!admin) return;

  const localCount = (
    db
      .prepare(
        `SELECT (SELECT COUNT(*) FROM orders) + (SELECT COUNT(*) FROM checks) + (SELECT COUNT(*) FROM procurement_items) AS n`,
      )
      .get() as { n: number }
  ).n;
  if (localCount > 0) return;

  try {
    const [files, orders, orderDocs, checks, checkAtts, procurement, users, settings, customerCodes, revisions] = await Promise.all([
      fetchAllRows(admin, 'files'),
      fetchAllRows(admin, 'orders'),
      fetchAllRows(admin, 'order_documents'),
      fetchAllRows(admin, 'checks'),
      fetchAllRows(admin, 'check_attachments'),
      fetchAllRows(admin, 'procurement_items'),
      fetchAllRows(admin, 'users'),
      fetchAllSettings(admin),
      fetchAllCustomerCodes(admin),
      fetchAllRows(admin, 'order_revisions').catch((err) => {
        // Table is created by migration 003; restoring orders must not fail if it was not run yet.
        console.error('[Supabase restore] order_revisions:', err instanceof Error ? err.message : err);
        return [] as Array<Record<string, unknown>>;
      }),
    ]);

    if (orders.length + checks.length + procurement.length === 0 && users.every((u) => !u.pin_hash)) {
      return; // Fresh installation: nothing to restore.
    }

    const restore = db.transaction(() => {
      const insFile = db.prepare(`
        INSERT OR IGNORE INTO files (
          id, storage_provider, storage_bucket, storage_path, storage_url, stored_filename,
          original_name, mime_type, size_bytes, owner_kind, owner_record_id, uploaded_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const f of files) {
        insFile.run(
          f.id, f.storage_provider, f.storage_bucket, f.storage_path, f.storage_url ?? '', f.stored_filename,
          f.original_name, f.mime_type, f.size_bytes, f.owner_kind, f.owner_record_id ?? null, f.uploaded_by,
          toIso(f.created_at),
        );
      }

      const insOrder = db.prepare(`
        INSERT OR IGNORE INTO orders (
          id, schema_version, version, sales_owner_id, sales_owner_name, customer, proforma,
          final_invoice_no, accounting_note, channel, amount_toman, payment, items, stage, status,
          rev, return_reason, return_note, cartons_out, exit_time, driver_name, cartons_delivered,
          carton_discrepancy, discrepancy_note, customer_signer, signature_file_id, signature_url,
          stage_history_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const o of orders) {
        insOrder.run(
          o.id, o.schema_version, o.version, o.sales_owner_id, o.sales_owner_name, o.customer, o.proforma,
          o.final_invoice_no ?? '', o.accounting_note ?? '', o.channel ?? '', o.amount_toman ?? null,
          o.payment ?? null, o.items, o.stage, o.status, o.rev ?? 0, o.return_reason ?? '', o.return_note ?? '',
          o.cartons_out ?? null, o.exit_time ?? '', o.driver_name ?? '', o.cartons_delivered ?? null,
          o.carton_discrepancy ?? 0, o.discrepancy_note ?? '', o.customer_signer ?? '', o.signature_file_id ?? null,
          o.signature_url ?? '', JSON.stringify(o.stage_history_json ?? []), toIso(o.created_at), toIso(o.updated_at),
        );
      }

      const insDoc = db.prepare(`
        INSERT OR IGNORE INTO order_documents (
          id, order_id, doc_kind, version_no, file_id, file_url, original_name, mime_type, uploaded_by, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const d of orderDocs) {
        insDoc.run(
          d.id, d.order_id, d.doc_kind, d.version_no, d.file_id, d.file_url ?? '', d.original_name, d.mime_type,
          d.uploaded_by, toIso(d.created_at),
        );
      }

      const insCheck = db.prepare(`
        INSERT OR IGNORE INTO checks (
          id, version, doc_type, customer, amount_toman, sayadi_id, due_date, tracking_no, caption,
          sales_owner_id, sales_owner_name, status, finance_status, finance_time, ceo_status, ceo_time,
          finalized_time, reject_reason, rejected_by, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const c of checks) {
        insCheck.run(
          c.id, c.version, c.doc_type, c.customer, c.amount_toman, c.sayadi_id ?? '', c.due_date ?? '',
          c.tracking_no ?? '', c.caption, c.sales_owner_id, c.sales_owner_name, c.status, c.finance_status,
          c.finance_time ?? '', c.ceo_status, c.ceo_time ?? '', c.finalized_time ?? '', c.reject_reason ?? '',
          c.rejected_by ?? '', toIso(c.created_at), toIso(c.updated_at),
        );
      }

      const insAtt = db.prepare(`
        INSERT OR IGNORE INTO check_attachments (id, check_id, file_id, file_url, original_name, mime_type, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const a of checkAtts) {
        insAtt.run(a.id, a.check_id, a.file_id, a.file_url ?? '', a.original_name, a.mime_type, toIso(a.created_at));
      }

      const insProc = db.prepare(`
        INSERT OR IGNORE INTO procurement_items (
          id, version, brand, part_name, part_code, qty_needed, priority, status,
          related_order_proforma, reported_by_name, supplier_note, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const p of procurement) {
        insProc.run(
          p.id, p.version, p.brand, p.part_name, p.part_code ?? '', p.qty_needed, p.priority, p.status,
          p.related_order_proforma ?? '', p.reported_by_name ?? '', p.supplier_note ?? '', toIso(p.created_at),
          toIso(p.updated_at),
        );
      }

      // Accounts already exist (seeded at startup); restore names and PIN hashes onto them.
      const updUser = db.prepare(
        `UPDATE users SET display_name = ?, pin_hash = ?, pin_salt = ?, updated_at = ? WHERE id = ?`,
      );
      for (const u of users) {
        if (u.pin_hash && u.pin_salt) {
          updUser.run(u.display_name, u.pin_hash, u.pin_salt, toIso(u.updated_at), u.id);
        }
      }

      const upsSetting = db.prepare(`
        INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `);
      for (const s of settings) {
        upsSetting.run(s.key, s.value, toIso(s.updated_at));
      }

      const insRev = db.prepare(`
        INSERT OR IGNORE INTO order_revisions (id, order_id, rev, sales_owner_id, sales_owner_name, customer,
          return_reason, return_note, old_proforma, new_proforma, old_amount_toman, new_amount_toman,
          changes_json, comparison_source, deleted_file_names, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const r of revisions) {
        insRev.run(
          r.id, r.order_id, r.rev, r.sales_owner_id, r.sales_owner_name, r.customer, r.return_reason ?? '',
          r.return_note ?? '', r.old_proforma, r.new_proforma, r.old_amount_toman ?? null, r.new_amount_toman ?? null,
          typeof r.changes_json === 'string' ? r.changes_json : JSON.stringify(r.changes_json ?? {}),
          r.comparison_source ?? 'text', r.deleted_file_names ?? '', toIso(r.created_at),
        );
      }

      const insCode = db.prepare(
        `INSERT OR IGNORE INTO customer_codes (code, customer_name, updated_by, updated_at) VALUES (?, ?, ?, ?)`,
      );
      for (const c of customerCodes) {
        insCode.run(c.code, c.customer_name, c.updated_by, toIso(c.updated_at));
      }
    });

    restore();
    console.log(
      `[Supabase restore] Restored ${orders.length} orders, ${checks.length} checks, ${procurement.length} procurement items, ${files.length} files from Supabase.`,
    );
  } catch (err) {
    console.error('[Supabase restore] Failed:', err instanceof Error ? err.message : err);
  }
}
