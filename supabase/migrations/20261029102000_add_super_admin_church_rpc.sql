create or replace function public.list_church_applications()
returns table (
    application_id uuid,
    church_name text,
    church_location text,
    church_address text,
    submitted_at timestamptz,
    application_status text,
    applicant_full_name text,
    applicant_email text,
    admin_feedback text
)
language plpgsql
security definer
as $$
begin
    if not public.is_super_admin(auth.uid()) then
        raise exception 'Access denied: Super Admin privileges required.';
    end if;

    return query
    select 
        c.id as application_id,
        c.name as church_name,
        c.location as church_location,
        c.address as church_address,
        c.created_at as submitted_at,
        coalesce(c.status, c.subscription_status, 'pending') as application_status,
        p.full_name as applicant_full_name,
        p.email as applicant_email,
        c.admin_feedback as admin_feedback
    from public.churches c
    left join public.profiles p on p.id = c.admin_user_id
    where coalesce(c.status, c.subscription_status, 'pending') = 'pending'
    order by c.created_at desc;
end;
$$;

create or replace function public.get_super_admin_church_stats()
returns json
language plpgsql
security definer
as $$
declare
    total_count bigint;
    pending_count bigint;
begin
    if not public.is_super_admin(auth.uid()) then
        raise exception 'Access denied: Super Admin privileges required.';
    end if;

    select count(*) into total_count from public.churches;
    select count(*) into pending_count from public.churches where coalesce(status, subscription_status, 'pending') = 'pending';

    return json_build_object(
        'total_churches', total_count,
        'pending_churches', pending_count
    );
end;
$$;
