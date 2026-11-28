-- ============================================================================
-- AutoParts Distribution Portal — Supabase Schema, Private Storage & RBAC RLS
-- Run this migration in your Supabase SQL Editor or via `supabase db push`.
--
-- Security guarantees enforced directly inside PostgreSQL:
-- 1. Zero Base64 blobs in table rows: all PDFs, check photos & signatures live
--    in the private Supabase Storage bucket `autoparts-documents` and are
--    referenced solely by lightweight `files` metadata rows (`storage_path`).
-- 2. Strict Row-Level Security (RLS) on every table using signed JWT claims
--    (`app_role`, `app_user_id`, `is_sales`, `can_access_finance`) minted
--    exclusively by the server-side RBAC Middleware (`server/middleware/rbac.ts`).
-- 3. Zero anonymous/public access to tables or Storage objects.
-- ============================================================================

-- ==================== 1. Helper JWT Claim Readers ====================
create or replace function public.app_role()
returns text
language sql
stable
as $$
  select coalesce(auth.jwt() ->> 'app_role', '');
$$;

create or replace function public.app_is_sales()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() ->> 'is_sales')::boolean, false);
$$;

create or replace function public.app_can_access_finance()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() ->> 'can_access_finance')::boolean, false);
$$;

create or replace function public.app_can_access_procurement()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() ->> 'can_access_procurement')::boolean, false);
$$;

-- ==================== 2. Normalized Tables (Zero Base64 Columns) ====================
create table if not exists public.users (
  id text primary key,
  display_name text not null,
  role_label text not null,
  is_sales boolean not null default false,
  can_access_finance boolean not null default false,
  can_access_procurement boolean not null default false,
  scope text not null,
  pin_hash text,
  pin_salt text,
  updated_at timestamptz not null default now()
);

create table if not exists public.sessions (
  token_hash text primary key,
  user_id text not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

create table if not exists public.settings (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table if not exists public.files (
  id text primary key,
  storage_provider text not null default 'supabase',
  storage_bucket text not null default 'autoparts-documents',
  storage_path text not null,
  storage_url text not null default '',
  stored_filename text not null,
  original_name text not null,
  mime_type text not null,
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 5242880),
  owner_kind text not null check (owner_kind in ('order_doc', 'signature', 'check_attachment', 'temp')),
  owner_record_id text,
  uploaded_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.orders (
  id text primary key,
  schema_version integer not null default 4,
  version integer not null default 1,
  sales_owner_id text not null,
  sales_owner_name text not null,
  customer text not null,
  proforma text not null,
  final_invoice_no text not null default '',
  accounting_note text not null default '',
  channel text not null default '',
  amount_toman bigint,
  payment text,
  items text not null,
  stage integer not null default 2,
  status text not null default 'active',
  rev integer not null default 0,
  return_reason text not null default '',
  return_note text not null default '',
  cartons_out integer,
  exit_time text not null default '',
  driver_name text not null default '',
  cartons_delivered integer,
  carton_discrepancy integer not null default 0,
  discrepancy_note text not null default '',
  customer_signer text not null default '',
  signature_file_id text references public.files(id),
  signature_url text not null default '',
  stage_history_json jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index if not exists idx_orders_proforma_unique on public.orders (lower(proforma));
create index if not exists idx_orders_stage_status on public.orders (stage, status);
create index if not exists idx_orders_updated_at on public.orders (updated_at desc);

create table if not exists public.order_documents (
  id text primary key,
  order_id text not null references public.orders(id) on delete cascade,
  doc_kind text not null check (doc_kind in ('proforma', 'final_invoice')),
  version_no integer not null default 1,
  file_id text not null references public.files(id),
  file_url text not null default '',
  original_name text not null,
  mime_type text not null,
  uploaded_by text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.checks (
  id text primary key,
  version integer not null default 1,
  doc_type text not null,
  customer text not null,
  amount_toman bigint not null,
  sayadi_id text not null default '',
  due_date text not null default '',
  tracking_no text not null default '',
  caption text not null,
  sales_owner_id text not null,
  sales_owner_name text not null,
  status text not null default 'pending',
  finance_status text not null default 'pending',
  finance_time text not null default '',
  ceo_status text not null default 'pending',
  ceo_time text not null default '',
  finalized_time text not null default '',
  reject_reason text not null default '',
  rejected_by text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_checks_due_date on public.checks (due_date asc);
create index if not exists idx_checks_status on public.checks (status);
create index if not exists idx_checks_updated_at on public.checks (updated_at desc);

create table if not exists public.check_attachments (
  id text primary key,
  check_id text not null references public.checks(id) on delete cascade,
  file_id text not null references public.files(id),
  file_url text not null default '',
  original_name text not null,
  mime_type text not null,
  created_at timestamptz not null default now()
);

create table if not exists public.procurement_items (
  id text primary key,
  version integer not null default 1,
  brand text not null,
  part_name text not null,
  part_code text not null default '',
  qty_needed integer not null default 1,
  priority text not null default 'عادی',
  status text not null default 'reported',
  related_order_proforma text not null default '',
  reported_by_name text not null default '',
  supplier_note text not null default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists idx_procurement_updated_at on public.procurement_items (updated_at desc);

create table if not exists public.audit_logs (
  id bigserial primary key,
  actor_id text not null,
  actor_name text not null,
  category text not null,
  message text not null,
  created_at timestamptz not null default now()
);

create index if not exists idx_audit_logs_created on public.audit_logs (id desc);

-- ==================== 3. Role-Projected Orders View (Masks Financials for Warehouse/Driver) ====================
create or replace view public.orders_role_view
with (security_invoker = true) as
select
  id,
  schema_version,
  version,
  sales_owner_id,
  sales_owner_name,
  customer,
  proforma,
  final_invoice_no,
  accounting_note,
  channel,
  case
    when public.app_role() in ('warehouse_sup', 'driver') then null
    else amount_toman
  end as amount_toman,
  case
    when public.app_role() in ('warehouse_sup', 'driver') then null
    else payment
  end as payment,
  items,
  stage,
  status,
  rev,
  return_reason,
  return_note,
  cartons_out,
  exit_time,
  driver_name,
  cartons_delivered,
  carton_discrepancy,
  discrepancy_note,
  customer_signer,
  signature_file_id,
  signature_url,
  stage_history_json,
  created_at,
  updated_at
from public.orders;

-- ==================== 4. Enable & Force Row-Level Security (RBAC at DB Layer) ====================
alter table public.users enable row level security;
alter table public.users force row level security;

alter table public.sessions enable row level security;
alter table public.sessions force row level security;

alter table public.settings enable row level security;
alter table public.settings force row level security;

alter table public.files enable row level security;
alter table public.files force row level security;

alter table public.orders enable row level security;
alter table public.orders force row level security;

alter table public.order_documents enable row level security;
alter table public.order_documents force row level security;

alter table public.checks enable row level security;
alter table public.checks force row level security;

alter table public.check_attachments enable row level security;
alter table public.check_attachments force row level security;

alter table public.procurement_items enable row level security;
alter table public.procurement_items force row level security;

alter table public.audit_logs enable row level security;
alter table public.audit_logs force row level security;

-- Revoke all direct anonymous/public privileges
revoke all on all tables in schema public from anon;

-- --- ORDERS RLS POLICIES ---
drop policy if exists orders_select_rbac on public.orders;
create policy orders_select_rbac on public.orders
  for select to authenticated
  using (
    public.app_role() in ('ceo', 'sales_mgr', 'accounting')
    or (public.app_is_sales() and sales_owner_id = public.app_role())
    or (public.app_role() = 'warehouse_sup' and (stage >= 5 or status = 'returned_to_accounting'))
    or (public.app_role() = 'driver' and stage >= 6)
  );

drop policy if exists orders_insert_sales_only on public.orders;
create policy orders_insert_sales_only on public.orders
  for insert to authenticated
  with check (
    public.app_is_sales() and sales_owner_id = public.app_role()
  );

drop policy if exists orders_update_rbac on public.orders;
create policy orders_update_rbac on public.orders
  for update to authenticated
  using (
    (public.app_is_sales() and sales_owner_id = public.app_role())
    or public.app_role() in ('sales_mgr', 'accounting', 'warehouse_sup', 'driver')
  )
  with check (
    (public.app_is_sales() and sales_owner_id = public.app_role())
    or public.app_role() in ('sales_mgr', 'accounting', 'warehouse_sup', 'driver')
  );

-- --- ORDER DOCUMENTS RLS POLICIES ---
drop policy if exists order_documents_select_rbac on public.order_documents;
create policy order_documents_select_rbac on public.order_documents
  for select to authenticated
  using (
    exists (select 1 from public.orders o where o.id = order_documents.order_id)
  );

drop policy if exists order_documents_insert_rbac on public.order_documents;
create policy order_documents_insert_rbac on public.order_documents
  for insert to authenticated
  with check (
    (public.app_is_sales() or public.app_role() = 'accounting')
    and exists (select 1 from public.orders o where o.id = order_documents.order_id)
  );

-- --- CHECKS & CHECK ATTACHMENTS RLS POLICIES (Warehouse & Driver strictly blocked) ---
drop policy if exists checks_select_rbac on public.checks;
create policy checks_select_rbac on public.checks
  for select to authenticated
  using (
    public.app_can_access_finance()
    and (
      public.app_role() in ('ceo', 'accounting', 'sales_mgr')
      or (public.app_is_sales() and sales_owner_id = public.app_role())
    )
  );

drop policy if exists checks_insert_rbac on public.checks;
create policy checks_insert_rbac on public.checks
  for insert to authenticated
  with check (
    (public.app_is_sales() or public.app_role() = 'accounting')
    and sales_owner_id = public.app_role()
  );

drop policy if exists checks_update_rbac on public.checks;
create policy checks_update_rbac on public.checks
  for update to authenticated
  using (
    public.app_role() in ('ceo', 'accounting')
    or (public.app_is_sales() and sales_owner_id = public.app_role() and status = 'returned')
  )
  with check (
    public.app_role() in ('ceo', 'accounting')
    or (public.app_is_sales() and sales_owner_id = public.app_role())
  );

drop policy if exists check_attachments_select_rbac on public.check_attachments;
create policy check_attachments_select_rbac on public.check_attachments
  for select to authenticated
  using (
    public.app_can_access_finance()
    and exists (select 1 from public.checks c where c.id = check_attachments.check_id)
  );

drop policy if exists check_attachments_insert_rbac on public.check_attachments;
create policy check_attachments_insert_rbac on public.check_attachments
  for insert to authenticated
  with check (
    (public.app_is_sales() or public.app_role() = 'accounting')
    and exists (select 1 from public.checks c where c.id = check_attachments.check_id)
  );

-- --- PROCUREMENT RLS POLICIES ---
drop policy if exists procurement_rbac_all on public.procurement_items;
create policy procurement_rbac_all on public.procurement_items
  for all to authenticated
  using (public.app_can_access_procurement())
  with check (public.app_can_access_procurement());

-- --- SETTINGS RLS POLICIES (CEO-ONLY!) ---
drop policy if exists settings_ceo_only on public.settings;
create policy settings_ceo_only on public.settings
  for all to authenticated
  using (public.app_role() = 'ceo')
  with check (public.app_role() = 'ceo');

-- --- FILES METADATA RLS POLICIES ---
drop policy if exists files_select_rbac on public.files;
create policy files_select_rbac on public.files
  for select to authenticated
  using (
    public.app_role() = 'ceo'
    or (owner_record_id is null and uploaded_by = public.app_role())
    or (
      owner_kind = 'check_attachment'
      and public.app_can_access_finance()
      and exists (select 1 from public.checks c where c.id = files.owner_record_id)
    )
    or (
      owner_kind in ('order_doc', 'signature')
      and exists (select 1 from public.orders o where o.id = files.owner_record_id)
    )
  );

drop policy if exists files_insert_authenticated on public.files;
create policy files_insert_authenticated on public.files
  for insert to authenticated
  with check (uploaded_by = public.app_role());

-- --- AUDIT LOGS RLS POLICIES ---
drop policy if exists audit_logs_select_auth on public.audit_logs;
create policy audit_logs_select_auth on public.audit_logs
  for select to authenticated
  using (public.app_role() <> '');

drop policy if exists audit_logs_insert_auth on public.audit_logs;
create policy audit_logs_insert_auth on public.audit_logs
  for insert to authenticated
  with check (actor_id = public.app_role() or public.app_role() = 'ceo');

-- ==================== 5. Private Supabase Storage Bucket & Policies ====================
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'autoparts-documents',
  'autoparts-documents',
  false,
  5242880,
  array['application/pdf', 'image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do update
set
  public = false,
  file_size_limit = 5242880,
  allowed_mime_types = array['application/pdf', 'image/png', 'image/jpeg', 'image/webp'];

-- Block all direct client/public reads on storage.objects; only server middleware & role-scoped RLS can access
drop policy if exists storage_autoparts_select_rbac on storage.objects;
create policy storage_autoparts_select_rbac on storage.objects
  for select to authenticated
  using (
    bucket_id = 'autoparts-documents'
    and exists (
      select 1 from public.files f
      where f.storage_bucket = storage.objects.bucket_id
        and f.storage_path = storage.objects.name
    )
  );

drop policy if exists storage_autoparts_insert_rbac on storage.objects;
create policy storage_autoparts_insert_rbac on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'autoparts-documents'
    and public.app_role() <> ''
  );
