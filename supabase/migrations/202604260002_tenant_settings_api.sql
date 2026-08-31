create or replace function public.replace_tenant_business_hours(
  p_tenant_id uuid,
  p_hours jsonb
)
returns setof public.business_hours
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Only service_role may execute this function.
  if auth.role() <> 'service_role' then
    raise insufficient_privilege
      using message = 'service_role required';
  end if;

  -- Validate tenant ID.
  if p_tenant_id is null then
    raise exception 'p_tenant_id is required';
  end if;

  -- Validate JSON input.
  if p_hours is null or jsonb_typeof(p_hours) <> 'array' then
    raise exception 'p_hours must be a JSON array';
  end if;

  -- Validate every business-hours entry before deleting existing data.
  if exists (
    select 1
    from jsonb_array_elements(p_hours) as hour
    where
      hour ->> 'weekday' is null
      or hour ->> 'opensAt' is null
      or hour ->> 'closesAt' is null
  ) then
    raise exception 'Each business hour requires weekday, opensAt and closesAt';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_hours) as hour
    where
      (hour ->> 'weekday')::integer not between 0 and 6
  ) then
    raise exception 'weekday must be between 0 and 6';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_hours) as hour
    where
      (hour ->> 'opensAt')::time >= (hour ->> 'closesAt')::time
  ) then
    raise exception 'opensAt must be earlier than closesAt';
  end if;

  -- Replace the tenant's existing business hours atomically.
  delete from public.business_hours
  where tenant_id = p_tenant_id;

  insert into public.business_hours (
    tenant_id,
    weekday,
    opens_at,
    closes_at,
    active
  )
  select
    p_tenant_id,
    (hour ->> 'weekday')::integer,
    (hour ->> 'opensAt')::time,
    (hour ->> 'closesAt')::time,
    coalesce((hour ->> 'active')::boolean, true)
  from jsonb_array_elements(p_hours) as hour;

  -- Return the newly inserted schedule.
  return query
  select *
  from public.business_hours
  where tenant_id = p_tenant_id
  order by weekday asc, opens_at asc;
end;
$$;

revoke execute
on function public.replace_tenant_business_hours(uuid, jsonb)
from public, anon, authenticated;

grant execute
on function public.replace_tenant_business_hours(uuid, jsonb)
to service_role;
