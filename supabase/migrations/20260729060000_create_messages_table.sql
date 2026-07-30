-- Create messages table for direct messaging
create table if not exists public.messages (
    id uuid default gen_random_uuid() primary key,
    sender_id uuid references public.profiles(id) on delete cascade not null,
    receiver_id uuid references public.profiles(id) on delete cascade not null,
    content text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.messages enable row level security;

-- Drop policies if they already exist
drop policy if exists "Users can view their own messages" on public.messages;
drop policy if exists "Users can send messages" on public.messages;

-- RLS Policies
create policy "Users can view their own messages"
    on public.messages for select
    using (auth.uid() = sender_id or auth.uid() = receiver_id);

create policy "Users can send messages"
    on public.messages for insert
    with check (auth.uid() = sender_id);

-- Enable realtime for messages
alter publication supabase_realtime add table public.messages;
