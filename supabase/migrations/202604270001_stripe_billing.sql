-- Stripe billing MVP
-- Adds Stripe subscription/customer fields to tenants
-- and lookup indexes for billing data.

alter table public.tenants
  add column if not exists stripe_customer_id text,
  add column if not exists stripe_subscription_id text,
  add column if not exists subscription_status text,
  add column if not exists current_period_end timestamptz,
  add column if not exists cancel_at_period_end boolean not null default false;

-- Keep subscription status constrained to known Stripe states.
do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'tenants_subscription_status_check'
      and conrelid = 'public.tenants'::regclass
  ) then
    alter table public.tenants
      add constraint tenants_subscription_status_check
      check (
        subscription_status is null
        or subscription_status in (
          'trialing',
          'active',
          'past_due',
          'canceled',
          'unpaid',
          'incomplete',
          'incomplete_expired',
          'paused'
        )
      );
  end if;
end $$;

-- Stripe customer lookup.
create unique index if not exists tenants_stripe_customer_id_key
  on public.tenants(stripe_customer_id)
  where stripe_customer_id is not null;

-- Stripe subscription lookup.
create unique index if not exists tenants_stripe_subscription_id_key
  on public.tenants(stripe_subscription_id)
  where stripe_subscription_id is not null;

-- Invoice lookups.
create index if not exists invoices_tenant_status_idx
  on public.invoices(tenant_id, status);

-- Billing event history.
create index if not exists billing_events_tenant_created_idx
  on public.billing_events(tenant_id, created_at desc);
