-- Create connections table for member networking
create table if not exists public.connections (
    id uuid default gen_random_uuid() primary key,
    requester_id uuid references public.profiles(id) on delete cascade not null,
    recipient_id uuid references public.profiles(id) on delete cascade not null,
    status text default 'pending' check (status in ('pending', 'accepted', 'rejected')),
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
    constraint unique_connection unique (requester_id, recipient_id)
);

-- Enable RLS
alter table public.connections enable row level security;

-- Drop policies if they already exist
drop policy if exists "Users can view their own connections" on public.connections;
drop policy if exists "Users can create connection requests" on public.connections;
drop policy if exists "Users can update their own connections" on public.connections;

-- RLS Policies
create policy "Users can view their own connections"
    on public.connections for select
    using (auth.uid() = requester_id or auth.uid() = recipient_id);

create policy "Users can create connection requests"
    on public.connections for insert
    with check (auth.uid() = requester_id);

create policy "Users can update their own connections"
    on public.connections for update
    using (auth.uid() = requester_id or auth.uid() = recipient_id);

-- Enable realtime for connections
alter publication supabase_realtime add table public.connections;
