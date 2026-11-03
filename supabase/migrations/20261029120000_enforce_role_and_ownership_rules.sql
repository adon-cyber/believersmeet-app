-- Migration: 20261029120000_enforce_role_and_ownership_rules.sql
-- Description: Enforces strict role and ownership rules, super admin protection, church admin role assignments within own church, and prevents self-promotion or super admin modification.

create or replace function public.assign_profile_role(target_user_id uuid, new_role text, target_church_id uuid default null)
returns void
language plpgsql
security definer
as $$
declare
    caller_id uuid := auth.uid();
    caller_role text;
    caller_church_id uuid;
    target_current_role text;
    target_current_church_id uuid;
    super_admin_email constant text := 'adonstance@gmail.com';
    super_admin_id constant uuid := '45e7b5df-8f08-4cc7-9356-35e405618329';
    caller_email text;
begin
    -- Get caller info
    select role, church_id, email into caller_role, caller_church_id, caller_email
    from public.profiles
    where id = caller_id;

    -- Get target info
    select role, church_id into target_current_role, target_current_church_id
    from public.profiles
    where id = target_user_id;

    if not found then
        raise exception 'Target user profile not found.';
    end if;

    -- Prevent modifying the designated Super Admin
    if target_user_id = super_admin_id or target_current_role in ('super_admin', 'super-admin') then
        if caller_id != super_admin_id and caller_email != super_admin_email then
            raise exception 'Access Denied: Only the Super Admin can modify Super Admin accounts.';
        end if;
        if new_role not in ('super_admin', 'super-admin') and caller_id = target_user_id then
            raise exception 'Super Admin cannot strip their own super admin privileges.';
        end if;
    end if;

    -- Check Super Admin privileges
    if caller_id = super_admin_id or caller_email = super_admin_email or caller_role in ('super_admin', 'super-admin') then
        -- Super Admin can assign any role
        update public.profiles
        set role = new_role,
            church_id = coalesce(target_church_id, church_id),
            updated_at = now()
        where id = target_user_id;
        return;
    end if;

    -- Check Church Admin privileges
    if caller_role = 'admin' then
        -- Church Admin cannot appoint another Church Admin or Super Admin
        if new_role in ('admin', 'super_admin', 'super-admin') then
            raise exception 'Church Admins cannot appoint Church Admins or Super Admins.';
        end if;

        -- Church Admin can only assign roles within their own church
        if caller_church_id is null or target_current_church_id != caller_church_id or (target_church_id is not null and target_church_id != caller_church_id) then
            raise exception 'Church Admins can only manage roles for members within their own church.';
        end if;

        -- Prevent self-promotion/modification of own role by Church Admin
        if caller_id = target_user_id then
            raise exception 'Church Admins cannot modify their own role.';
        end if;

        update public.profiles
        set role = new_role,
            updated_at = now()
        where id = target_user_id;
        return;
    end if;

    raise exception 'Access Denied: Insufficient privileges to assign roles.';
end;
$$;

-- Trigger function to prevent unauthorized admin role changes on profiles table directly
create or replace function public.prevent_admin_role_change()
returns trigger
language plpgsql
security definer
as $$
declare
    caller_id uuid := auth.uid();
    caller_role text;
    super_admin_id constant uuid := '45e7b5df-8f08-4cc7-9356-35e405618329';
    super_admin_email constant text := 'adonstance@gmail.com';
    caller_email text;
begin
    -- Allow system / service_role bypass
    if auth.role() = 'service_role' then
        return new;
    end if;

    select role, email into caller_role, caller_email
    from public.profiles
    where id = caller_id;

    -- If role is being changed
    if old.role is distinct from new.role then
        -- Only Super Admin can assign/remove admin or super_admin roles
        if new.role in ('admin', 'super_admin', 'super-admin') or old.role in ('admin', 'super_admin', 'super-admin') then
            if caller_id != super_admin_id and caller_email != super_admin_email and caller_role not in ('super_admin', 'super-admin') then
                raise exception 'Unauthorized: Only Super Admin can modify administrative roles.';
            end if;
        end if;

        -- Prevent user from promoting themselves
        if caller_id = new.id and new.role != old.role and caller_id != super_admin_id then
            raise exception 'Users cannot modify their own role.';
        end if;
    end if;

    return new;
end;
$$;

drop trigger if exists tr_prevent_admin_role_change on public.profiles;
create trigger tr_prevent_admin_role_change
    before update on public.profiles
    for each row
    execute function public.prevent_admin_role_change();
