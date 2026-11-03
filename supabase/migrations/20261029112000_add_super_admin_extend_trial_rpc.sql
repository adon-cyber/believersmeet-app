create or replace function public.extend_church_trial(p_church_id uuid, p_new_expiry timestamptz)
returns void
language plpgsql
security definer
as $$
begin
    if not public.is_super_admin(auth.uid()) then
        raise exception 'Access denied: Super Admin privileges required.';
    end if;

    update public.churches
    set trial_ends_at = p_new_expiry,
        updated_at = now()
    where id = p_church_id;
end;
$$;
