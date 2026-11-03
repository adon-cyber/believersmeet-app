-- Migration: ensure conversion_requests table has enhanced category and consent columns securely
do $$
begin
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'conversion_requests' and column_name = 'category') then
        alter table public.conversion_requests add column category text default 'church_membership';
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'conversion_requests' and column_name = 'contact_method') then
        alter table public.conversion_requests add column contact_method text default 'whatsapp';
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'conversion_requests' and column_name = 'contact_detail') then
        alter table public.conversion_requests add column contact_detail text;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'conversion_requests' and column_name = 'consent_given') then
        alter table public.conversion_requests add column consent_given boolean default true;
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'conversion_requests' and column_name = 'consent_timestamp') then
        alter table public.conversion_requests add column consent_timestamp timestamp with time zone;
    end if;
end $$;

-- Enable RLS and verify policies
alter table public.conversion_requests enable row level security;

drop policy if exists "Anyone can insert conversion requests." on public.conversion_requests;
create policy "Anyone can insert conversion requests."
    on public.conversion_requests
    for insert
    to anon, authenticated
    with check (
        exists (
            select 1 from public.church_directory
            where church_directory.id = conversion_requests.church_id
        )
    );

drop policy if exists "Church admins can view conversion requests for their church." on public.conversion_requests;
create policy "Church admins can view conversion requests for their church."
    on public.conversion_requests
    for select
    to authenticated
    using (
        exists (
            select 1 from public.churches
            where churches.id = conversion_requests.church_id
            and (churches.admin_user_id = auth.uid() or public.is_super_admin(auth.uid()))
        )
    );

drop policy if exists "Church admins can update conversion requests for their church." on public.conversion_requests;
create policy "Church admins can update conversion requests for their church."
    on public.conversion_requests
    for update
    to authenticated
    using (
        exists (
            select 1 from public.churches
            where churches.id = conversion_requests.church_id
            and (churches.admin_user_id = auth.uid() or public.is_super_admin(auth.uid()))
        )
    );

grant select, insert, update on public.conversion_requests to anon, authenticated;
