-- GDPR Art. 15 / Art. 17 compliance audit support.
--
-- Makes audit_log survive hard deletion of a tenant.
--
-- Changes:
-- 1. audit_log.tenant_id -> ON DELETE SET NULL
-- 2. audit_log.user_id   -> ON DELETE SET NULL
-- 3. Adds an index for GDPR/compliance action lookups.
--
-- GDPR actions used by the application:
--
--   gdpr.tenant.export.requested
--   gdpr.tenant.deletion.requested
--   gdpr.tenant.deletion.cancelled
--   gdpr.tenant.hard_delete.executed
--   gdpr.customer.export.requested
--   gdpr.customer.deletion.executed

alter table public.audit_log
  drop constraint if exists audit_log_tenant_id_fkey;

alter table public.audit_log
  add constraint audit_log_tenant_id_fkey
  foreign key (tenant_id)
  references public.tenants(id)
  on delete set null;


alter table public.audit_log
  drop constraint if exists audit_log_user_id_fkey;

alter table public.audit_log
  add constraint audit_log_user_id_fkey
  foreign key (user_id)
  references public.users(id)
  on delete set null;


create index if not exists audit_log_action_idx
  on public.audit_log(action, created_at desc);
