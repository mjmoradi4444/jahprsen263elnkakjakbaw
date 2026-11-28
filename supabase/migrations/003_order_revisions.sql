-- ============================================================================
-- 003: mirror of proforma revision records (item / quantity / amount changes).
-- Run AFTER 002. Safe to re-run.
-- The previous proforma files are deleted after a revision; these rows keep the differences
-- for the CEO reports. Only the CEO can read them; a sales rep can insert only their own.
-- ============================================================================

create table if not exists public.order_revisions (
  id text primary key,
  order_id text not null references public.orders(id) on delete cascade,
  rev integer not null,
  sales_owner_id text not null,
  sales_owner_name text not null,
  customer text not null,
  return_reason text not null default '',
  return_note text not null default '',
  old_proforma text not null,
  new_proforma text not null,
  old_amount_toman bigint,
  new_amount_toman bigint,
  changes_json jsonb not null default '{}'::jsonb,
  comparison_source text not null default 'text',
  deleted_file_names text not null default '',
  created_at timestamptz not null default now()
);

create index if not exists idx_order_revisions_created on public.order_revisions (created_at);

alter table public.order_revisions enable row level security;
alter table public.order_revisions force row level security;
revoke all on public.order_revisions from anon;

drop policy if exists order_revisions_ceo_read on public.order_revisions;
create policy order_revisions_ceo_read on public.order_revisions
  for select to authenticated
  using (public.app_role() = 'ceo');

drop policy if exists order_revisions_insert_owner on public.order_revisions;
create policy order_revisions_insert_owner on public.order_revisions
  for insert to authenticated
  with check (public.app_is_sales() and sales_owner_id = public.app_role());

-- Documents of a superseded proforma are deleted by the server with the service-role key;
-- no client policy is needed for that.
