-- Create counseling_appointments table
create table if not exists counseling_appointments (
    id uuid primary key default gen_random_uuid(),
    user_id uuid references auth.users(id) on delete cascade,
    member_name text not null,
    member_email text not null,
    appointment_date date not null,
    appointment_time time not null,
    reason text not null,
    status text default 'Pending',
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table counseling_appointments enable row level security;

-- Policies for users to insert their own appointments
create policy "Users can insert their own counseling appointments"
    on counseling_appointments for insert
    to authenticated
    with check (auth.uid() = user_id);

-- Policies for users to view their own appointments
create policy "Users can view their own counseling appointments"
    on counseling_appointments for select
    to authenticated
    using (auth.uid() = user_id);

-- Policies for admins to view and update all counseling appointments
create policy "Admins can view all counseling appointments"
    on counseling_appointments for select
    to authenticated
    using (public.is_admin(auth.uid()) or public.is_super_admin(auth.uid()));

create policy "Admins can update counseling appointments status"
    on counseling_appointments for update
    to authenticated
    using (public.is_admin(auth.uid()) or public.is_super_admin(auth.uid()));
