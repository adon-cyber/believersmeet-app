-- Create volunteer_signups table to allow multiple signups per volunteer slot
create table if not exists public.volunteer_signups (
    id uuid default gen_random_uuid() primary key,
    slot_id uuid references public.volunteer_roster(id) on delete cascade not null,
    user_id uuid references auth.users(id) on delete set null,
    full_name text,
    email text,
    phone text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    unique(slot_id, user_id)
);

-- Enable RLS
alter table public.volunteer_signups enable row level security;

-- Policies for volunteer_signups
create policy "Allow everyone to read volunteer_signups"
    on public.volunteer_signups for select
    using (true);

create policy "Allow authenticated users to insert their own signup"
    on public.volunteer_signups for insert
    with check (
        auth.uid() = user_id or user_id is null
    );

create policy "Allow users to delete their own signup or admins to delete any"
    on public.volunteer_signups for delete
    using (
        auth.uid() = user_id 
        or public.is_admin(auth.uid()) 
        or exists (
            select 1 from public.volunteer_roster r 
            where r.id = slot_id and (r.assigned_user_id = auth.uid() or public.is_admin(auth.uid()))
        )
    );
