-- Create worship_songs table for the Music Playlist Widget
create table if not exists public.worship_songs (
    id uuid default gen_random_uuid() primary key,
    title text not null,
    artist text not null,
    audio_url text not null,
    cover_art text,
    church_id uuid references public.churches(id) on delete cascade,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.worship_songs enable row level security;

-- Policies for worship_songs
create policy "Authenticated users can view worship songs"
    on public.worship_songs for select
    to authenticated
    using (true);

create policy "Admins can insert worship songs"
    on public.worship_songs for insert
    to authenticated
    with check (true);

create policy "Admins can update worship songs"
    on public.worship_songs for update
    to authenticated
    using (true);

create policy "Admins can delete worship songs"
    on public.worship_songs for delete
    to authenticated
    using (true);
