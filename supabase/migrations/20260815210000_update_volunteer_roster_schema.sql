-- Add role and total_spots to volunteer_roster if not present
do $$
begin
    if not exists (select 1 from information_schema.columns where table_name='volunteer_roster' and column_name='role') then
        alter table public.volunteer_roster add column role text default 'Usher';
    end if;

    if not exists (select 1 from information_schema.columns where table_name='volunteer_roster' and column_name='total_spots') then
        alter table public.volunteer_roster add column total_spots integer default 1;
    end if;
end $$;

-- Update RLS policy to allow users to cancel/change shift (i.e. set assigned_user_id to null if it was assigned to them, or update assigned_user_id)
drop policy if exists "Allow users to sign up for open slots" on public.volunteer_roster;

create policy "Allow users to sign up and manage their volunteer slots"
    on public.volunteer_roster for update
    using (assigned_user_id is null or assigned_user_id = auth.uid())
    with check (assigned_user_id is null or assigned_user_id = auth.uid());
