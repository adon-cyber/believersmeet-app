-- Create user_reflections table for Daily Scripture & Personal Reflections
create table if not exists public.user_reflections (
    id uuid default gen_random_uuid() primary key,
    user_id uuid references auth.users(id) on delete cascade not null,
    verse_reference text not null,
    verse_text text not null,
    note text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.user_reflections enable row level security;

-- Policies for user_reflections
create policy "Users can view their own reflections"
    on public.user_reflections for select
    using (auth.uid() = user_id);

create policy "Users can insert their own reflections"
    on public.user_reflections for insert
    with check  (auth.uid() = user_id);

create policy "Users can update their own reflections"
    on public.user_reflections for update
    using (auth.uid() = user_id);

create policy "Users can delete their own reflections"
    on public.user_reflections for delete
    using (auth.uid() = user_id);

-- Indexes for performance
create index if not exists user_reflections_user_id_idx on public.user_reflections(user_id);
create index if not exists user_reflections_created_at_idx on public.user_reflections(created_at desc);
