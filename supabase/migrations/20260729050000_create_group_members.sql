-- Create group_members table
create table if not exists public.group_members (
    id uuid default gen_random_uuid() primary key,
    group_id uuid references public.groups(id) on delete cascade not null,
    user_id uuid references auth.users(id) on delete cascade not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    constraint unique_group_member unique (group_id, user_id)
);

-- Enable RLS
alter table public.group_members enable row level security;

-- RLS Policies
create policy "Allow authenticated users to select all group memberships"
    on public.group_members for select
    to authenticated
    using (true);

create policy "Allow authenticated users to insert their own group membership"
    on public.group_members for insert
    to authenticated
    with check (auth.uid() = user_id);

create policy "Allow authenticated users to delete their own group membership"
    on public.group_members for delete
    to authenticated
    using (auth.uid() = user_id);
