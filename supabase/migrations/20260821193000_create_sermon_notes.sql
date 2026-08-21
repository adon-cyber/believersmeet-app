-- Create migration for sermon_notes table
create table if not exists public.sermon_notes (
    id uuid default gen_random_uuid() primary key,
    sermon_id text not null, -- can be uuid or youtube video id/string
    user_id uuid references public.profiles(id) on delete cascade not null,
    note_text text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable Row Level Security
alter table public.sermon_notes enable row level security;

-- Drop existing policies if any
drop policy if exists "Users can view their own sermon notes" on public.sermon_notes;
drop policy if exists "Users can insert their own sermon notes" on public.sermon_notes;
drop policy if exists "Users can delete their own sermon notes" on public.sermon_notes;

-- Create RLS policies for sermon_notes
create policy "Users can view their own sermon notes"
    on public.sermon_notes for select
    to authenticated
    using (auth.uid() = user_id);

create policy "Users can insert their own sermon notes"
    on public.sermon_notes for insert
    to authenticated
    with check (auth.uid() = user_id);

create policy "Users can delete their own sermon notes"
    on public.sermon_notes for delete
    to authenticated
    using (auth.uid() = user_id);
