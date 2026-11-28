-- ============================================================================
-- 002: allow the server to mirror "file attached to record" links, and add the
--      customer-code memory table used by invoice auto-fill.
-- Run AFTER 001_rbac_and_storage.sql (SQL Editor or `supabase db push`). Safe to re-run.
-- ============================================================================

-- The uploader may attach their own still-unlinked file to a record exactly once.
drop policy if exists files_link_by_uploader on public.files;
create policy files_link_by_uploader on public.files
  for update to authenticated
  using (uploaded_by = public.app_role() and owner_record_id is null)
  with check (uploaded_by = public.app_role());

-- Customer code -> customer name, learned from submitted orders (invoice auto-fill).
create table if not exists public.customer_codes (
  code text primary key,
  customer_name text not null,
  updated_by text not null,
  updated_at timestamptz not null default now()
);

alter table public.customer_codes enable row level security;
alter table public.customer_codes force row level security;
revoke all on public.customer_codes from anon;

drop policy if exists customer_codes_read on public.customer_codes;
create policy customer_codes_read on public.customer_codes
  for select to authenticated
  using (public.app_role() <> '');

drop policy if exists customer_codes_write_sales on public.customer_codes;
create policy customer_codes_write_sales on public.customer_codes
  for insert to authenticated
  with check (public.app_is_sales() and updated_by = public.app_role());

drop policy if exists customer_codes_update_sales on public.customer_codes;
create policy customer_codes_update_sales on public.customer_codes
  for update to authenticated
  using (public.app_is_sales())
  with check (public.app_is_sales() and updated_by = public.app_role());
