-- Public contact form submissions.
--
-- Used by POST /api/contact for collecting leads, support requests,
-- agency inquiries, press requests, and general feedback.
--
-- Flow:
-- 1. Public user submits POST /api/contact.
-- 2. Application rate-limits submissions (5/min per IP).
-- 3. Submission is stored with processed_at = NULL.
-- 4. Notification email is sent to the configured internal address.
-- 5. Operator marks the submission as processed.
--
-- Privacy:
-- - Not multi-tenant.
-- - Submitters are not associated with an authenticated user or tenant.
-- - Contains personal data and must not be exposed to tenants.
-- - Only service_role can access this table.

create table if not exists public.contact_submissions (
  id uuid primary key default gen_random_uuid(),

  name text not null,
  email text not null,
  company text,

  topic text not null check (
    topic in (
      'sales',
      'support',
      'agency',
      'press',
      'other'
    )
  ),

  message text not null,

  ip_address inet,
  user_agent text,

  created_at timestamptz not null default now(),
  processed_at timestamptz,
  updated_at timestamptz not null default now(),

  constraint contact_submissions_email_check
    check (
      length(email) between 3 and 320
      and position('@' in email) > 1
    ),

  constraint contact_submissions_name_check
    check (length(trim(name)) > 0),

  constraint contact_submissions_message_check
    check (length(trim(message)) > 0)
);


create index if not exists contact_submissions_created_idx
  on public.contact_submissions(created_at desc);


create index if not exists contact_submissions_unprocessed_idx
  on public.contact_submissions(created_at desc)
  where processed_at is null;


create index if not exists contact_submissions_topic_idx
  on public.contact_submissions(topic, created_at desc);


alter table public.contact_submissions
  enable row level security;


-- Explicitly deny direct table access to public client roles.
revoke all on table public.contact_submissions
  from anon, authenticated;


-- service_role bypasses RLS in Supabase, but this policy documents
-- the intended access model and protects against accidental policy changes.
drop policy if exists contact_submissions_service_role_all
  on public.contact_submissions;

create policy contact_submissions_service_role_all
  on public.contact_submissions
  for all
  using (auth.role() = 'service_role')
  with check (auth.role() = 'service_role');


-- Keep updated_at consistent with the rest of the backend schema.
drop trigger if exists set_updated_at
  on public.contact_submissions;

create trigger set_updated_at
  before update on public.contact_submissions
  for each row
  execute function public.update_updated_at_column();
