-- Create conversion_requests table for public visitors to request conversion or joining the church
create table if not exists public.conversion_requests (
    id uuid default gen_random_uuid() primary key,
    church_id uuid references public.churches(id) on delete cascade not null,
    full_name text not null,
    phone_number text not null,
    email text,
    prayer_request text,
    status text default 'pending', -- 'pending', 'contacted', 'completed'
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS on conversion_requests
alter table public.conversion_requests enable row level security;

-- Allow anonymous and authenticated users to insert conversion requests
create policy "Anyone can insert conversion requests."
    on public.conversion_requests
    for insert
    to anon, authenticated
    with check (true);

-- Allow church admins to view and update conversion requests for their church
create policy "Church admins can view conversion requests for their church."
    on public.conversion_requests
    for select
    to authenticated
    using (
        exists (
            select 1 from public.churches
            where churches.id = conversion_requests.church_id
            and churches.admin_user_id = auth.uid()
        )
    );

create policy "Church admins can update conversion requests for their church."
    on public.conversion_requests
    for update
    to authenticated
    using (
        exists (
            select 1 from public.churches
            where churches.id = conversion_requests.church_id
            and churches.admin_user_id = auth.uid()
        )
    );
