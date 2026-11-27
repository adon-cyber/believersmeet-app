-- BelieversMeet Staging — Super Admin moderation RPC component (REVIEW DRAFT v2)
-- Merge into the final ordered RLS/grants package; do NOT execute standalone.
-- Prerequisites: corrected Foundation installed; private schema, public.profiles,
-- public.violations, public.is_super_admin(), and public.is_platform_admin(uuid) exist.
-- Execute as the database owner (expected: postgres). The profile-protection trigger
-- must be attached after initial Staging Platform Admin bootstrap, before testing RPCs.

BEGIN;
-- Keep private implementation/audit objects inaccessible to browser roles.
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS private.moderation_audit_log (
    id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    actor_user_id   uuid NOT NULL,
    target_user_id  uuid,
    violation_id    uuid,
    action_type     text NOT NULL
        CHECK (action_type IN (
            'block_account',
            'unblock_account',
            'update_violation_status'
        )),
    previous_value  text,
    new_value       text,
    created_at      timestamptz NOT NULL DEFAULT pg_catalog.now()
);
ALTER TABLE private.moderation_audit_log ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.moderation_audit_log
    FROM PUBLIC, anon, authenticated, service_role;
CREATE INDEX IF NOT EXISTS moderation_audit_log_created_at_idx
    ON private.moderation_audit_log (created_at DESC);
CREATE INDEX IF NOT EXISTS moderation_audit_log_target_user_idx
    ON private.moderation_audit_log (target_user_id, created_at DESC);
-- Remove the exact historical violation policies and the names used by the
-- earlier review draft. The preflight below fails closed on any other policy,
-- rather than leaving an unknown permissive policy OR-combined with this one.
DROP POLICY IF EXISTS "Users can create violation reports" ON public.violations;
DROP POLICY IF EXISTS "Admins can view all violation reports" ON public.violations;
DROP POLICY IF EXISTS "Admins can update violation reports" ON public.violations;
DROP POLICY IF EXISTS violations_authenticated_insert_own ON public.violations;
DROP POLICY IF EXISTS violations_select_own_or_platform_admin ON public.violations;
DROP POLICY IF EXISTS violations_authenticated_insert_own_pending ON public.violations;
DO $policy_check$
DECLARE
    v_remaining text;
BEGIN
    SELECT pg_catalog.string_agg(p.polname, ', ' ORDER BY p.polname)
      INTO v_remaining
      FROM pg_catalog.pg_policy AS p
     WHERE p.polrelid = 'public.violations'::pg_catalog.regclass;

    IF v_remaining IS NOT NULL THEN
        RAISE EXCEPTION
            'Unexpected policies remain on public.violations: %. Review and explicitly reconcile them before applying this component.',
            v_remaining;
    END IF;
END;
$policy_check$;
ALTER TABLE public.violations ENABLE ROW LEVEL SECURITY;
-- The application only inserts reports directly. Reading and moderation are
-- handled by allowlist-checked SECURITY DEFINER RPCs below.
CREATE POLICY violations_authenticated_insert_own_pending
    ON public.violations
    FOR INSERT
    TO authenticated
    WITH CHECK (
        reporter_id = auth.uid()
        AND reported_user_id IS NOT NULL
        AND COALESCE(status, 'pending') = 'pending'
    );
-- The three report forms insert only these fields. IDs and timestamps remain
-- database-generated; callers cannot set proof_url or read report rows directly.
REVOKE ALL PRIVILEGES ON TABLE public.violations
    FROM PUBLIC, anon, authenticated, service_role;
GRANT INSERT (reporter_id, reported_user_id, reason, details, status)
    ON TABLE public.violations TO authenticated;
-- Super Admin report reader. A SECURITY DEFINER join avoids granting broad
-- profile-column reads or relying on embedded-relationship RLS visibility.
CREATE OR REPLACE FUNCTION public.super_admin_list_violation_reports()
RETURNS TABLE (
    id                  uuid,
    event_id            uuid,
    reporter_id         uuid,
    reported_user_id    uuid,
    reason              text,
    details             text,
    status              text,
    created_at          timestamptz,
    proof_url           text,
    offender_name       text,
    offender_email      text,
    offender_is_blocked boolean,
    reporter_name       text,
    reporter_email      text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Platform Admin privileges are required.'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        v.id,
        v.event_id,
        v.reporter_id,
        v.reported_user_id,
        v.reason,
        v.details,
        COALESCE(v.status, 'pending'),
        v.created_at,
        v.proof_url,
        offender.full_name,
        offender.email,
        COALESCE(offender.is_blocked, false),
        reporter.full_name,
        reporter.email
    FROM public.violations AS v
    LEFT JOIN public.profiles AS offender
        ON offender.id = v.reported_user_id
    LEFT JOIN public.profiles AS reporter
        ON reporter.id = v.reporter_id
    ORDER BY v.created_at DESC;
END;
$function$;
-- Change violation status only after the allowlist check. Historical values
-- are retained: pending, reviewed, actioned, dismissed.
CREATE OR REPLACE FUNCTION public.super_admin_update_violation_status(
    p_violation_id uuid,
    p_new_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_old_status text;
    v_target_user_id uuid;
BEGIN
    IF v_actor_id IS NULL OR NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Platform Admin privileges are required.'
            USING ERRCODE = '42501';
    END IF;

    IF p_violation_id IS NULL
       OR p_new_status IS NULL
       OR p_new_status NOT IN ('pending', 'reviewed', 'actioned', 'dismissed') THEN
        RAISE EXCEPTION 'Invalid violation ID or moderation status.'
            USING ERRCODE = '22023';
    END IF;

    SELECT v.status, v.reported_user_id
      INTO v_old_status, v_target_user_id
      FROM public.violations AS v
     WHERE v.id = p_violation_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Violation report not found.'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_old_status IS NOT DISTINCT FROM p_new_status THEN
        RETURN;
    END IF;

    UPDATE public.violations
       SET status = p_new_status
     WHERE id = p_violation_id;

    INSERT INTO private.moderation_audit_log (
        actor_user_id, target_user_id, violation_id,
        action_type, previous_value, new_value
    ) VALUES (
        v_actor_id, v_target_user_id, p_violation_id,
        'update_violation_status', v_old_status, p_new_status
    );
END;
$function$;
-- Change profiles.is_blocked only through this allowlist-checked RPC. Once the
-- profile trigger is attached, public.is_super_admin() is the authorized path
-- through the Foundation's protected-field trigger.
CREATE OR REPLACE FUNCTION public.super_admin_set_profile_blocked(
    p_target_user_id uuid,
    p_is_blocked boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_target_role text;
    v_old_blocked boolean;
BEGIN
    IF v_actor_id IS NULL OR NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Platform Admin privileges are required.'
            USING ERRCODE = '42501';
    END IF;

    IF p_target_user_id IS NULL OR p_is_blocked IS NULL THEN
        RAISE EXCEPTION 'Target user and block state are required.'
            USING ERRCODE = '22023';
    END IF;

    IF p_target_user_id = v_actor_id THEN
        RAISE EXCEPTION 'You cannot block your own Platform Admin account.'
            USING ERRCODE = '42501';
    END IF;

    SELECT p.role, p.is_blocked
      INTO v_target_role, v_old_blocked
      FROM public.profiles AS p
     WHERE p.id = p_target_user_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target profile not found.'
            USING ERRCODE = 'P0002';
    END IF;

    IF public.is_platform_admin(p_target_user_id)
       OR v_target_role IN ('super_admin', 'super-admin') THEN
        RAISE EXCEPTION 'A Platform Admin account cannot be blocked here.'
            USING ERRCODE = '42501';
    END IF;

    IF COALESCE(v_old_blocked, false) = p_is_blocked THEN
        RETURN;
    END IF;

    UPDATE public.profiles
       SET is_blocked = p_is_blocked
     WHERE id = p_target_user_id;

    INSERT INTO private.moderation_audit_log (
        actor_user_id, target_user_id, action_type,
        previous_value, new_value
    ) VALUES (
        v_actor_id,
        p_target_user_id,
        CASE WHEN p_is_blocked THEN 'block_account' ELSE 'unblock_account' END,
        COALESCE(v_old_blocked, false)::text,
        p_is_blocked::text
    );
END;
$function$;
-- Explicitly deny default/PUBLIC execution, then grant only the three browser
-- RPCs to authenticated users. Each function independently checks the allowlist.
REVOKE ALL ON FUNCTION public.super_admin_list_violation_reports()
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.super_admin_update_violation_status(uuid, text)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.super_admin_set_profile_blocked(uuid, boolean)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.super_admin_list_violation_reports()
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.super_admin_update_violation_status(uuid, text)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.super_admin_set_profile_blocked(uuid, boolean)
    TO authenticated;
COMMENT ON TABLE private.moderation_audit_log IS
    'Private audit trail for allowlist-authorized Platform Admin moderation actions.';
COMMIT;
