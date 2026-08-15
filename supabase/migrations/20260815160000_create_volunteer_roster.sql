-- Create volunteer_roster table
create table if not exists public.volunteer_roster (
    id uuid default gen_random_uuid() primary key,
    title text not null,
    event_date timestamp with time zone not null,
    description text,
    assigned_user_id uuid references auth.users(id) on delete set null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.volunteer_roster enable row level security;

-- Policies
create policy "Allow everyone to read volunteer_roster"
    on public.volunteer_roster for select
    using (true);

create policy "Allow admins to insert volunteer_roster"
    on public.volunteer_roster for insert
    with check (
        exists (
            select 1 from public.profiles
            where profiles.id = auth.uid()
            and (profiles.role = 'admin' or profiles.role = 'super_admin')
        )
    );

create policy "Allow admins to update volunteer_roster"
    on public.volunteer_roster for update
    using (
        exists (
            select 1 from public.profiles
            where profiles.id = auth.uid()
            and (profiles.role = 'admin' or profiles.role = 'super_admin')
        )
    );

create policy "Allow users to sign up for open slots"
    on public.volunteer_roster for update
    using (assigned_user_id is null)
    with check (assigned_user_id = auth.uid());

create policy "Allow admins to delete volunteer_roster"
    on public.volunteer_roster for delete
    using (
        exists (
            select 1 from public.profiles
            where profiles.id = auth.uid()
            and (profiles.role = 'admin' or profiles.role = 'super_admin')
        )
    );
