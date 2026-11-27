-- BelieversMeet Staging — RLS/Grants Section 01
-- Self-owned member data: blocks, sermon_notes, user_reflections
-- STATUS: REVIEW-ONLY DRAFT. DO NOT EXECUTE YET.
-- Target: a fresh database initialized from the corrected Foundation v4.
-- This script is intentionally limited to three user-owned tables.
-- It does not complete the application's RLS/grants configuration.
-- No database changes have been made by preparing this file.

BEGIN;
-- The SECURITY DEFINER helpers below must be owned by the trusted database
-- owner so they can inspect profiles without recursively invoking profile RLS.
DO $preflight$
BEGIN
    IF current_user <> 'postgres' THEN
        RAISE EXCEPTION
            'Refusing Section 01: execute/review under the expected postgres owner role; current_user=%',
            current_user;
    END IF;
END;
$preflight$;
-- Fail closed if this is not the expected clean Foundation target.
-- Permissive RLS policies are OR-combined, so unknown existing policies could
-- silently broaden these restrictions.
DO $preflight$
DECLARE
    v_existing_policies text;
BEGIN
    SELECT string_agg(format('%I.%I (%I)', schemaname, tablename, policyname), ', ')
      INTO v_existing_policies
      FROM pg_catalog.pg_policies
     WHERE schemaname = 'public'
       AND tablename = ANY (ARRAY['blocks', 'sermon_notes', 'user_reflections']);

    IF v_existing_policies IS NOT NULL THEN
        RAISE EXCEPTION
            'Refusing Section 01: unexpected policies already exist on target tables: %',
            v_existing_policies;
    END IF;

    IF to_regclass('public.profiles') IS NULL
       OR to_regclass('public.blocks') IS NULL
       OR to_regclass('public.sermon_notes') IS NULL
       OR to_regclass('public.user_reflections') IS NULL THEN
        RAISE EXCEPTION
            'Refusing Section 01: required Foundation tables are missing';
    END IF;
END;
$preflight$;
-- -------------------------------------------------------------------------
-- 1. Reusable identity/tenant helpers
-- -------------------------------------------------------------------------
-- These helpers derive identity only from auth.uid(); they do not accept a
-- caller-supplied user ID or church ID. The church-role helpers are for later
-- tenant-scoped policy sections. Section 01 uses the active-user helper only.

CREATE OR REPLACE FUNCTION public.is_current_user_active()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
          FROM public.profiles AS p
         WHERE p.id = (SELECT auth.uid())
           AND p.status = 'active'
           AND COALESCE(p.is_blocked, false) = false
    );
$function$;
CREATE OR REPLACE FUNCTION public.current_user_church_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT p.church_id
      FROM public.profiles AS p
     WHERE p.id = (SELECT auth.uid())
       AND p.status = 'active'
       AND COALESCE(p.is_blocked, false) = false
     LIMIT 1;
$function$;
CREATE OR REPLACE FUNCTION public.is_current_user_church_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
          FROM public.profiles AS p
         WHERE p.id = (SELECT auth.uid())
           AND p.role = 'church_admin'
           AND p.church_id IS NOT NULL
           AND p.status = 'active'
           AND COALESCE(p.is_blocked, false) = false
    );
$function$;
CREATE OR REPLACE FUNCTION public.is_current_user_finance()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
          FROM public.profiles AS p
         WHERE p.id = (SELECT auth.uid())
           AND p.role = 'finance'
           AND p.church_id IS NOT NULL
           AND p.status = 'active'
           AND COALESCE(p.is_blocked, false) = false
    );
$function$;
-- No anonymous or service-role RPC exposure. Authenticated callers can only
-- inspect their own active/role/church context through no-argument helpers.
REVOKE ALL ON FUNCTION public.is_current_user_active()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.current_user_church_id()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_current_user_church_admin()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.is_current_user_finance()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_current_user_active() TO authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_church_id() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_current_user_church_admin() TO authenticated;
GRANT EXECUTE ON FUNCTION public.is_current_user_finance() TO authenticated;
-- Keep the helpers' execution context trusted and deterministic.
ALTER FUNCTION public.is_current_user_active() OWNER TO postgres;
ALTER FUNCTION public.current_user_church_id() OWNER TO postgres;
ALTER FUNCTION public.is_current_user_church_admin() OWNER TO postgres;
ALTER FUNCTION public.is_current_user_finance() OWNER TO postgres;
-- -------------------------------------------------------------------------
-- 2. Table privileges and RLS policies
-- -------------------------------------------------------------------------

GRANT USAGE ON SCHEMA public TO authenticated;
-- blocks: members may see block relationships involving themselves and create
-- only a block where they are the blocker. The app has no unblock/delete path
-- in the reviewed source, so no UPDATE or DELETE privilege is granted.
ALTER TABLE public.blocks ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.blocks FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.blocks TO authenticated;
GRANT INSERT (blocker_id, blocked_id) ON TABLE public.blocks TO authenticated;
CREATE POLICY blocks_select_involved_user
    ON public.blocks
    FOR SELECT
    TO authenticated
    USING (
        (blocker_id = (SELECT auth.uid()) OR blocked_id = (SELECT auth.uid()))
        AND (SELECT public.is_current_user_active())
    );
CREATE POLICY blocks_insert_as_blocker
    ON public.blocks
    FOR INSERT
    TO authenticated
    WITH CHECK (
        blocker_id = (SELECT auth.uid())
        AND blocked_id <> (SELECT auth.uid())
        AND (SELECT public.is_current_user_active())
    );
-- sermon_notes: the app reads, creates and deletes the signed-in user's own
-- notes. No UPDATE permission is granted; the sermon association is therefore
-- immutable after insert through the browser API.
ALTER TABLE public.sermon_notes ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.sermon_notes FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.sermon_notes TO authenticated;
GRANT INSERT (user_id, sermon_id, note_text)
    ON TABLE public.sermon_notes TO authenticated;
GRANT DELETE ON TABLE public.sermon_notes TO authenticated;
CREATE POLICY sermon_notes_select_own
    ON public.sermon_notes
    FOR SELECT
    TO authenticated
    USING (
        user_id = (SELECT auth.uid())
        AND (SELECT public.is_current_user_active())
    );
CREATE POLICY sermon_notes_insert_own
    ON public.sermon_notes
    FOR INSERT
    TO authenticated
    WITH CHECK (
        user_id = (SELECT auth.uid())
        AND (SELECT public.is_current_user_active())
    );
CREATE POLICY sermon_notes_delete_own
    ON public.sermon_notes
    FOR DELETE
    TO authenticated
    USING (
        user_id = (SELECT auth.uid())
        AND (SELECT public.is_current_user_active())
    );
-- user_reflections: the archived app currently inserts and reads reflections.
-- UPDATE/DELETE are intentionally withheld until a current caller requires
-- them; that is narrower than the aspirational CRUD target in the policy map.
ALTER TABLE public.user_reflections ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES ON TABLE public.user_reflections FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.user_reflections TO authenticated;
GRANT INSERT (user_id, verse_reference, verse_text, note)
    ON TABLE public.user_reflections TO authenticated;
CREATE POLICY user_reflections_select_own
    ON public.user_reflections
    FOR SELECT
    TO authenticated
    USING (
        user_id = (SELECT auth.uid())
        AND (SELECT public.is_current_user_active())
    );
CREATE POLICY user_reflections_insert_own
    ON public.user_reflections
    FOR INSERT
    TO authenticated
    WITH CHECK (
        user_id = (SELECT auth.uid())
        AND (SELECT public.is_current_user_active())
    );
COMMIT;
