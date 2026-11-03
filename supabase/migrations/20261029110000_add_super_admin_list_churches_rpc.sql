create or replace function public.super_admin_list_churches()
returns table (
    id uuid,
    name text,
    trial_ends_at timestamptz
)
language plpgsql
security definer
as $$
begin
    if not public.is_super_admin(auth.uid()) then
        raise exception 'Access denied: Super Admin privileges required.';
    end if;

    return query
    select c.id, c.name, c.trial_ends_at
    from public.churches c;
end;
$$;
