-- Create business_directory table for Phase 1 of Believers Business & Skills Directory
create table if not exists public.business_directory (
    id uuid default gen_random_uuid() primary key,
    church_id uuid references public.churches(id) on delete cascade not null,
    user_id uuid references auth.users(id) on delete cascade not null,
    business_name text not null,
    category text not null,
    description text,
    phone text,
    email text,
    website_url text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable Row Level Security (RLS)
alter table public.business_directory enable row level security;

-- Drop existing policies if they exist
drop policy if exists "Authenticated users can select church business directories" on public.business_directory;
drop policy if exists "Users can insert their own business directory entries" on public.business_directory;
drop policy if exists "Users can update their own business directory entries" on public.business_directory;
drop policy if exists "Users can delete their own business directory entries" on public.business_directory;

-- RLS Policies
create policy "Authenticated users can select church business directories"
    on public.business_directory for select
    to authenticated
    using (
        church_id in (
            select church_id from public.profiles where id = auth.uid()
        )
    );

create policy "Users can insert their own business directory entries"
    on public.business_directory for insert
    to authenticated
    with check (
        auth.uid() = user_id and
        church_id in (
            select church_id from public.profiles where id = auth.uid()
        )
    );

create policy "Users can update their own business directory entries"
    on public.business_directory for update
    to authenticated
    using (auth.uid() = user_id)
    with check (auth.uid() = user_id);

create policy "Users can delete their own business directory entries"
    on public.business_directory for delete
    to authenticated
    using (auth.uid() = user_id);

-- Create trigger for updated_at
create or replace function public.handle_updated_at()
returns trigger as $$
begin
    new.updated_at = timezone('utc'::text, now());
    return new;
end;
$$ language plpgsql;

drop trigger if exists handle_business_directory_updated_at on public.business_directory;
create trigger handle_business_directory_updated_at
    before update on public.business_directory
    for execution procedure public.handle_updated_at();
