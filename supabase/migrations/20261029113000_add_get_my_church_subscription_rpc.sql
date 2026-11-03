create or replace function public.get_my_church_subscription()
returns table (
    id uuid,
    name text,
    subscription_status text,
    trial_ends_at timestamptz
)
language plpgsql
security definer
as $$
declare
    v_church_id uuid;
begin
    select church_id into v_church_id
    from public.profiles
    where id = auth.uid();

    if v_church_id is null then
        return;
    end if;

    return query
    select c.id, c.name, c.subscription_status, c.trial_ends_at
    from public.churches c
    where c.id = v_church_id;
end;
$$;
