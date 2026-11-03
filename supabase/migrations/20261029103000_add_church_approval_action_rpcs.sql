create or replace function public.approve_church_application(p_church_id uuid)
returns void
language plpgsql
security definer
as $$
begin
    if not public.is_super_admin(auth.uid()) then
        raise exception 'Access denied: Super Admin privileges required.';
    end if;

    update public.churches
    set status = 'approved',
        subscription_status = 'active',
        trial_ends_at = now() + interval '6 months',
        updated_at = now()
    where id = p_church_id;
end;
$$;

create or replace function public.reject_church_application(p_church_id uuid, p_feedback text default null)
returns void
language plpgsql
security definer
as $$
begin
    if not public.is_super_admin(auth.uid()) then
        raise exception 'Access denied: Super Admin privileges required.';
    end if;

    update public.churches
    set status = 'rejected',
        subscription_status = 'rejected',
        admin_feedback = p_feedback,
        updated_at = now()
    where id = p_church_id;
end;
$$;

create or replace function public.request_changes_church_application(p_church_id uuid, p_feedback text)
returns void
language plpgsql
security definer
as $$
begin
    if not public.is_super_admin(auth.uid()) then
        raise exception 'Access denied: Super Admin privileges required.';
    end if;

    update public.churches
    set status = 'changes_requested',
        subscription_status = 'changes_requested',
        admin_feedback = p_feedback,
        updated_at = now()
    where id = p_church_id;
end;
$$;
