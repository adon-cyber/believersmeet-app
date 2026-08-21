-- Create community_needs table for Fellowship Needs & Ride-Share Board
create table if not exists public.community_needs (
    id uuid default gen_random_uuid() primary key,
    church_id uuid references public.churches(id) on delete cascade,
    user_id uuid references public.profiles(id) on delete cascade,
    category text not null default 'Ride Share', -- Ride Share, Meal Train, Volunteer, General
    title text not null,
    description text,
    contact_info text not null,
    status text not null default 'open', -- open, fulfilled
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable Row Level Security
alter table public.community_needs enable row level security;

-- Drop existing policies if any to ensure clean creation
drop policy if exists "Enable read access for all authenticated users" on public.community_needs;
drop policy if exists "Enable insert for authenticated users" on public.community_needs;
drop policy if exists "Enable update for owners" on public.community_needs;

-- RLS Policies
create policy "Enable read access for all authenticated users"
    on public.community_needs for select
    to authenticated
    using (true);

create policy "Enable insert for authenticated users"
    on public.community_needs for insert
    to authenticated
    with check (auth.uid() = user_id);

create policy "Enable update for owners"
    on public.community_needs for update
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);
