-- Create migration to add media_type and category to sermons table if not exists, or create sermons table with them
create table if not exists public.sermons (
    id uuid default gen_random_uuid() primary key,
    title text not null,
    preacher text not null,
    audio_url text,
    media_url text,
    media_type text default 'audio', -- 'audio', 'video', 'youtube'
    category text default 'Sermon', -- 'Sermon', 'Gospel Song'
    church_id uuid references public.churches(id) on delete cascade,
    church_name text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- If table already existed without media_type or category, add them safely
do $$
begin
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sermons' and column_name = 'media_type') then
        alter table public.sermons add column media_type text default 'audio';
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sermons' and column_name = 'category') then
        alter table public.sermons add column category text default 'Sermon';
    end if;
    if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'sermons' and column_name = 'media_url') then
        alter table public.sermons add column media_url text;
    end if;
end $$;

-- Enable RLS on sermons
alter table public.sermons enable row level security;

-- Drop existing policies if any to avoid conflicts
drop policy if exists "Anyone can view sermons" on public.sermons;
drop policy if exists "Admins can insert sermons" on public.sermons;
drop policy if exists "Admins can update sermons" on public.sermons;
drop policy if exists "Admins can delete sermons" on public.sermons;

-- Create comprehensive policies
create policy "Anyone can view sermons"
    on public.sermons for select
    using (true);

create policy "Admins can insert sermons"
    on public.sermons for insert
    to authenticated
    with check (true);

create policy "Admins can update sermons"
    on public.sermons for update
    to authenticated
    using (true);

create policy "Admins can delete sermons"
    on public.sermons for delete
    to authenticated
    using (true);
