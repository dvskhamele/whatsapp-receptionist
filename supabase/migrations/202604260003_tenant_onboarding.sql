create or replace function public.create_tenant_onboarding(
  p_user_id uuid,
  p_user_email text,
  p_full_name text,
  p_tenant jsonb,
  p_config jsonb,
  p_services jsonb,
  p_business_hours jsonb,
  p_audit jsonb
)
returns table (
  tenant_id uuid,
  tenant_slug text,
  tenant_name text,
  trial_ends_at timestamptz
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_tenant_id uuid;
  v_tenant_slug text;
  v_tenant_name text;
  v_trial_ends_at timestamptz;
begin
  ---------------------------------------------------------------------------
  -- SECURITY
  ---------------------------------------------------------------------------

  if auth.role() <> 'service_role' then
    raise insufficient_privilege
      using message = 'service_role required';
  end if;

  ---------------------------------------------------------------------------
  -- BASIC INPUT VALIDATION
  ---------------------------------------------------------------------------

  if p_user_id is null then
    raise exception 'p_user_id is required';
  end if;

  if not exists (
    select 1
    from auth.users
    where id = p_user_id
  ) then
    raise exception 'auth user does not exist';
  end if;

  if p_tenant is null or jsonb_typeof(p_tenant) <> 'object' then
    raise exception 'p_tenant must be a JSON object';
  end if;

  if p_config is null or jsonb_typeof(p_config) <> 'object' then
    raise exception 'p_config must be a JSON object';
  end if;

  if p_services is null or jsonb_typeof(p_services) <> 'array' then
    raise exception 'p_services must be a JSON array';
  end if;

  if p_business_hours is null
     or jsonb_typeof(p_business_hours) <> 'array' then
    raise exception 'p_business_hours must be a JSON array';
  end if;

  if p_audit is null or jsonb_typeof(p_audit) <> 'object' then
    raise exception 'p_audit must be a JSON object';
  end if;

  ---------------------------------------------------------------------------
  -- PREVENT DUPLICATE USER MEMBERSHIP
  ---------------------------------------------------------------------------

  if exists (
    select 1
    from public.users
    where id = p_user_id
  ) then
    raise unique_violation
      using message = 'user already has a tenant membership';
  end if;

  ---------------------------------------------------------------------------
  -- TENANT VALIDATION
  ---------------------------------------------------------------------------

  if nullif(trim(p_tenant ->> 'name'), '') is null then
    raise exception 'tenant name is required';
  end if;

  if nullif(trim(p_tenant ->> 'slug'), '') is null then
    raise exception 'tenant slug is required';
  end if;

  if nullif(trim(p_tenant ->> 'billingEmail'), '') is null then
    raise exception 'billing email is required';
  end if;

  if nullif(trim(p_tenant ->> 'country'), '') is not null
     and length(trim(p_tenant ->> 'country')) <> 2 then
    raise exception 'country must be a 2-letter ISO country code';
  end if;

  if nullif(trim(p_tenant ->> 'timezone'), '') is null then
    raise exception 'timezone is required';
  end if;

  ---------------------------------------------------------------------------
  -- CONFIG VALIDATION
  ---------------------------------------------------------------------------

  if nullif(trim(p_config ->> 'studioName'), '') is null then
    raise exception 'studioName is required';
  end if;

  if nullif(trim(p_config ->> 'defaultLocale'), '') is null then
    raise exception 'defaultLocale is required';
  end if;

  ---------------------------------------------------------------------------
  -- SERVICE VALIDATION
  ---------------------------------------------------------------------------

  if exists (
    select 1
    from jsonb_array_elements(p_services) as service
    where jsonb_typeof(service) <> 'object'
  ) then
    raise exception 'each service must be a JSON object';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_services) as service
    where nullif(trim(service ->> 'name'), '') is null
  ) then
    raise exception 'each service requires a name';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_services) as service
    where
      coalesce((service ->> 'durationMinutes')::integer, 30) <= 0
  ) then
    raise exception 'service durationMinutes must be greater than zero';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_services) as service
    where
      nullif(service ->> 'priceCents', '') is not null
      and (service ->> 'priceCents')::integer < 0
  ) then
    raise exception 'service priceCents cannot be negative';
  end if;

  ---------------------------------------------------------------------------
  -- BUSINESS HOURS VALIDATION
  ---------------------------------------------------------------------------

  if exists (
    select 1
    from jsonb_array_elements(p_business_hours) as hour
    where jsonb_typeof(hour) <> 'object'
  ) then
    raise exception 'each business hour must be a JSON object';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_business_hours) as hour
    where
      hour ->> 'weekday' is null
      or hour ->> 'opensAt' is null
      or hour ->> 'closesAt' is null
  ) then
    raise exception
      'each business hour requires weekday, opensAt and closesAt';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_business_hours) as hour
    where
      (hour ->> 'weekday')::integer not between 0 and 6
  ) then
    raise exception 'weekday must be between 0 and 6';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_business_hours) as hour
    where
      (hour ->> 'opensAt')::time >=
      (hour ->> 'closesAt')::time
  ) then
    raise exception 'opensAt must be earlier than closesAt';
  end if;

  ---------------------------------------------------------------------------
  -- CREATE TENANT
  ---------------------------------------------------------------------------

  insert into public.tenants (
    name,
    slug,
    plan,
    status,
    billing_email,
    country,
    timezone,
    business_type,
    trial_ends_at
  )
  values (
    trim(p_tenant ->> 'name'),
    lower(trim(p_tenant ->> 'slug')),
    'trial',
    'active',
    lower(trim(p_tenant ->> 'billingEmail')),
    coalesce(
      upper(nullif(trim(p_tenant ->> 'country'), '')),
      'IT'
    ),
    coalesce(
      nullif(trim(p_tenant ->> 'timezone'), ''),
      'Europe/Rome'
    ),
    nullif(trim(p_tenant ->> 'businessType'), ''),
    nullif(trim(p_tenant ->> 'trialEndsAt'), '')::timestamptz
  )
  returning
    id,
    slug,
    name,
    trial_ends_at
  into
    v_tenant_id,
    v_tenant_slug,
    v_tenant_name,
    v_trial_ends_at;

  ---------------------------------------------------------------------------
  -- CREATE OWNER USER
  ---------------------------------------------------------------------------

  insert into public.users (
    id,
    tenant_id,
    role,
    full_name,
    phone
  )
  values (
    p_user_id,
    v_tenant_id,
    'owner',
    nullif(trim(p_full_name), ''),
    nullif(trim(p_config ->> 'phone'), '')
  );

  ---------------------------------------------------------------------------
  -- CREATE TENANT CONFIG
  ---------------------------------------------------------------------------

  insert into public.tenant_config (
    tenant_id,
    studio_name,
    assistant_name,
    city,
    address,
    phone,
    email,
    default_locale,
    ai_disclosure_enabled,
    auto_reply_enabled,
    voice_messages_enabled,
    voice_replies_enabled,
    booking_min_lead_minutes,
    booking_slot_step_minutes,
    booking_buffer_minutes,
    booking_max_days_ahead,
    elevenlabs_voice_id,
    elevenlabs_stt_model,
    elevenlabs_tts_model,
    human_escalation_email
  )
  values (
    v_tenant_id,

    trim(p_config ->> 'studioName'),

    coalesce(
      nullif(trim(p_config ->> 'assistantName'), ''),
      'Ambrogio'
    ),

    nullif(trim(p_config ->> 'city'), ''),
    nullif(trim(p_config ->> 'address'), ''),
    nullif(trim(p_config ->> 'phone'), ''),
    nullif(trim(p_config ->> 'email'), ''),

    coalesce(
      nullif(trim(p_config ->> 'defaultLocale'), ''),
      'it-IT'
    ),

    coalesce(
      (p_config ->> 'aiDisclosureEnabled')::boolean,
      true
    ),

    coalesce(
      (p_config ->> 'autoReplyEnabled')::boolean,
      false
    ),

    coalesce(
      (p_config ->> 'voiceMessagesEnabled')::boolean,
      true
    ),

    coalesce(
      (p_config ->> 'voiceRepliesEnabled')::boolean,
      false
    ),

    coalesce(
      (p_config ->> 'bookingMinLeadMinutes')::integer,
      120
    ),

    coalesce(
      (p_config ->> 'bookingSlotStepMinutes')::integer,
      15
    ),

    coalesce(
      (p_config ->> 'bookingBufferMinutes')::integer,
      0
    ),

    coalesce(
      (p_config ->> 'bookingMaxDaysAhead')::integer,
      30
    ),

    nullif(trim(p_config ->> 'elevenlabsVoiceId'), ''),

    coalesce(
      nullif(trim(p_config ->> 'elevenlabsSttModel'), ''),
      'scribe_v2'
    ),

    coalesce(
      nullif(trim(p_config ->> 'elevenlabsTtsModel'), ''),
      'eleven_flash_v2_5'
    ),

    nullif(trim(p_config ->> 'humanEscalationEmail'), '')
  );

  ---------------------------------------------------------------------------
  -- CREATE SERVICES
  ---------------------------------------------------------------------------

  insert into public.services (
    tenant_id,
    name,
    description,
    duration_minutes,
    price_cents,
    active
  )
  select
    v_tenant_id,
    trim(service ->> 'name'),
    nullif(trim(service ->> 'description'), ''),
    coalesce(
      (service ->> 'durationMinutes')::integer,
      30
    ),
    case
      when nullif(service ->> 'priceCents', '') is null
        then null
      else (service ->> 'priceCents')::integer
    end,
    coalesce(
      (service ->> 'active')::boolean,
      true
    )
  from jsonb_array_elements(p_services) as service;

  ---------------------------------------------------------------------------
  -- CREATE BUSINESS HOURS
  ---------------------------------------------------------------------------

  insert into public.business_hours (
    tenant_id,
    weekday,
    opens_at,
    closes_at,
    active
  )
  select
    v_tenant_id,
    (hour ->> 'weekday')::integer,
    (hour ->> 'opensAt')::time,
    (hour ->> 'closesAt')::time,
    coalesce(
      (hour ->> 'active')::boolean,
      true
    )
  from jsonb_array_elements(p_business_hours) as hour;

  ---------------------------------------------------------------------------
  -- AUDIT LOG
  ---------------------------------------------------------------------------

  insert into public.audit_log (
    tenant_id,
    user_id,
    action,
    resource_type,
    resource_id,
    ip_address,
    user_agent,
    metadata
  )
  values (
    v_tenant_id,
    p_user_id,
    'onboarding.tenant.created',
    'tenant',
    v_tenant_id,

    case
      when nullif(trim(p_audit ->> 'ipAddress'), '') is null
        then null
      else (p_audit ->> 'ipAddress')::inet
    end,

    nullif(trim(p_audit ->> 'userAgent'), ''),

    jsonb_build_object(
      'source', 'api',
      'userEmail', p_user_email,
      'billingEmail', p_tenant ->> 'billingEmail',
      'servicesCount', jsonb_array_length(p_services),
      'businessHoursCount', jsonb_array_length(p_business_hours)
    )
  );

  ---------------------------------------------------------------------------
  -- RETURN CREATED TENANT
  ---------------------------------------------------------------------------

  return query
  select
    v_tenant_id,
    v_tenant_slug,
    v_tenant_name,
    v_trial_ends_at;
end;
$$;


revoke execute on function public.create_tenant_onboarding(
  uuid,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb
)
from public, anon, authenticated;


grant execute on function public.create_tenant_onboarding(
  uuid,
  text,
  text,
  jsonb,
  jsonb,
  jsonb,
  jsonb,
  jsonb
)
to service_role;
