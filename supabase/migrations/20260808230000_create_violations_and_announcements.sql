-- Create violations table and extend profiles for blocking/deactivation if needed
create table if not exists public.violations (
    id uuid default gen_random_uuid() primary key,
    reporter_id uuid references public.profiles(id) on delete set null,
    reported_user_id uuid references public.profiles(id) on delete cascade not null,
    reason text not null,
    details text,
    status text default 'pending' check (status in ('pending', 'reviewed', 'actioned', 'dismissed')),
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Add is_blocked or status column to profiles if not exists
alter table public.profiles add column if not exists is_blocked boolean default false;

-- Enable RLS on violations
alter table public.violations enable row level security;

drop policy if exists "Users can create violation reports" on public.violations;
drop policy if exists "Admins can view all violation reports" on public.violations;
drop policy if exists "Admins can update violation reports" on public.violations;

create policy "Users can create violation reports"
    on public.violations for insert
    with check (auth.uid() = reporter_id);

create policy "Admins can view all violation reports"
    on public.violations for select
    using (public.is_admin(auth.uid()) or auth.uid() = reporter_id);

create policy "Admins can update violation reports"
    on public.violations for update
    using (public.is_admin(auth.uid()));

-- Update messages table to support broadcast/group fields if needed, or create announcements table
create table if not exists public.announcements (
    id uuid default gen_random_uuid() primary key,
    sender_id uuid references public.profiles(id) on delete set null,
    target_type text not null check (target_type in ('all', 'admins', 'church', 'user')),
    target_id uuid, -- church_id or user_id if applicable
    title text not null,
    content text not null,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

alter table public.announcements enable row level security;

drop policy if exists "Everyone can view announcements" on public.announcements;
drop policy if exists "Admins can manage announcements" on public.announcements;

create policy "Everyone can view announcements"
    on public.announcements for select
    using (true);

create policy "Admins can manage announcements"
    on public.announcements for all
    using (public.is_admin(auth.uid()));
