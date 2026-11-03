-- ============================================================================
-- BELIEVERSMEET READ-ONLY SQL VERIFICATION SCRIPT
-- Owner: Run this manually in Supabase SQL Editor to inspect database state,
-- functions, RLS policies, table grants, and migration objects without modifying anything.
-- ============================================================================

-- 1. Verify Super Admin and Role Mapping
SELECT 
    id, 
    email, 
    role, 
    church_id, 
    updated_at 
FROM public.profiles 
WHERE role IN ('super_admin', 'super-admin', 'admin', 'finance', 'user', 'member')
ORDER BY role, created_at;

-- 2. Inspect Security Functions
SELECT 
    routine_name, 
    routine_type, 
    security_type, 
    external_language 
FROM information_schema.routines 
WHERE routine_schema = 'public' 
  AND routine_name IN (
    'is_admin', 
    'is_super_admin', 
    'assign_profile_role', 
    'prevent_admin_role_change', 
    'super_admin_update_user_role',
    'super_admin_list_churches',
    'get_super_admin_church_stats',
    'super_admin_approve_church',
    'super_admin_reject_church',
    'super_admin_request_church_changes',
    'super_admin_extend_trial',
    'get_my_church_subscription_rpc'
);

-- 3. Inspect RLS Status on Core Tables
SELECT 
    schemaname, 
    tablename, 
    rowsecurity as rls_enabled 
FROM pg_tables 
WHERE schemaname = 'public'
ORDER BY tablename;

-- 4. Inspect Active RLS Policies
SELECT 
    schemaname, 
    tablename, 
    policyname, 
    permissive, 
    roles, 
    cmd, 
    qual, 
    with_check 
FROM pg_policies 
WHERE schemaname = 'public'
ORDER BY tablename, policyname;

-- 5. Inspect View Grants (`public.church_directory`)
SELECT 
    grantee, 
    table_name, 
    privilege_type 
FROM information_schema.role_table_grants 
WHERE table_schema = 'public' 
  AND table_name = 'church_directory';

-- 6. Inspect Triggers on public.profiles and other key tables
SELECT 
    trigger_schema, 
    trigger_name, 
    event_manipulation, 
    event_object_table, 
    action_statement 
FROM information_schema.triggers 
WHERE trigger_schema = 'public';
