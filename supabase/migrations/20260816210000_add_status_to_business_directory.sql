-- Add status column to business_directory table for submission approval flow
alter table public.business_directory add column if not exists status text default 'pending' not null;

-- Update existing records: if is_approved is true, set status to 'approved', otherwise 'pending'
update public.business_directory set status = case when is_approved = true then 'approved' else 'pending' end where status is null or status = 'pending';

-- Update RLS policies or grant admin permissions if needed
-- Admins can update status of business directory entries
drop policy if exists "Admins can update business directory status" on public.business_directory;
create policy "Admins can update business directory status"
    on public.business_directory for update
    to authenticated
    using (
        auth.uid() = user_id or 
        exists (
            select 1 from public.profiles 
            where profiles.id = auth.uid() 
            and (profiles.role = 'admin' or profiles.role = 'super_admin' or profiles.role = 'super-admin')
        )
    )
    with check (
        auth.uid() = user_id or 
        exists (
            select 1 from public.profiles 
            where profiles.id = auth.uid() 
            and (profiles.role = 'admin' or profiles.role = 'super_admin' or profiles.role = 'super-admin')
        )
    );
