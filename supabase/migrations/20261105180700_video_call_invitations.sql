BEGIN;
-- ============================================================
-- BELIEVERSMEET STAGING
-- ONE-TO-ONE VIDEO CALL INVITATIONS
-- REVIEW-ONLY SECURITY/RLS DRAFT
--
-- Do not execute until reviewed and approved.
-- Agora credentials are issued only after acceptance.
-- ============================================================

DO $preflight$
BEGIN
    IF current_user <> 'postgres' THEN
        RAISE EXCEPTION 'This script must be reviewed/executed as postgres.';
    END IF;

    IF to_regclass('public.profiles') IS NULL
       OR to_regclass('public.blocks') IS NULL THEN
        RAISE EXCEPTION 'Required profiles or blocks table is missing.';
    END IF;

    IF to_regclass('public.video_call_invitations') IS NOT NULL THEN
        RAISE EXCEPTION 'video_call_invitations already exists.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'service_role'
    ) THEN
        RAISE EXCEPTION 'Expected Supabase roles are missing.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_publication
        WHERE pubname = 'supabase_realtime'
    ) THEN
        RAISE EXCEPTION 'supabase_realtime publication is missing.';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'profiles'
          AND column_name = 'status'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'profiles'
          AND column_name = 'is_blocked'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'blocks'
          AND column_name = 'blocker_id'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'blocks'
          AND column_name = 'blocked_id'
    ) THEN
        RAISE EXCEPTION 'Required profile or block columns are missing.';
    END IF;
END;
$preflight$;
-- ============================================================
-- 1. INVITATION TABLE
-- ============================================================

CREATE TABLE public.video_call_invitations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

    caller_id uuid NOT NULL
        REFERENCES public.profiles(id) ON DELETE CASCADE,

    recipient_id uuid NOT NULL
        REFERENCES public.profiles(id) ON DELETE CASCADE,

    status text NOT NULL DEFAULT 'ringing',

    created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),

    expires_at timestamptz NOT NULL
        DEFAULT (pg_catalog.clock_timestamp() + interval '60 seconds'),

    responded_at timestamptz,
    ended_at timestamptz,

    CONSTRAINT video_call_invitations_distinct_participants
        CHECK (caller_id <> recipient_id),

    CONSTRAINT video_call_invitations_valid_status
        CHECK (
            status IN (
                'ringing',
                'accepted',
                'declined',
                'cancelled',
                'ended',
                'expired'
            )
        )
);
CREATE INDEX video_call_invitations_recipient_status_idx
    ON public.video_call_invitations (recipient_id, status, created_at DESC);
CREATE INDEX video_call_invitations_caller_status_idx
    ON public.video_call_invitations (caller_id, status, created_at DESC);
-- ============================================================
-- 2. ROW-LEVEL SECURITY AND PRIVILEGES
-- ============================================================

ALTER TABLE public.video_call_invitations ENABLE ROW LEVEL SECURITY;
REVOKE ALL PRIVILEGES
    ON TABLE public.video_call_invitations
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT
    ON TABLE public.video_call_invitations
    TO authenticated;
-- The authenticated Edge Function uses its server-only service-role client.
GRANT SELECT
    ON TABLE public.video_call_invitations
    TO service_role;
CREATE POLICY "Participants can read their own video call invitations"
    ON public.video_call_invitations
    FOR SELECT
    TO authenticated
    USING (
        caller_id = (SELECT auth.uid())
        OR recipient_id = (SELECT auth.uid())
    );
-- No direct authenticated INSERT, UPDATE or DELETE policies.
-- Invitation changes must go through the RPC functions below.

-- ============================================================
-- 3. CREATE INVITATION
-- Only the authenticated caller can create an invitation.
-- Locks both profile rows to prevent concurrent active calls.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_video_call_invitation(
    p_recipient_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_caller_id uuid := auth.uid();
    v_now timestamptz;
    v_profile_count integer;
    v_invitation_id uuid;
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = '28000';
    END IF;

    IF p_recipient_id IS NULL OR p_recipient_id = v_caller_id THEN
        RAISE EXCEPTION 'Invalid call recipient.'
            USING ERRCODE = '22023';
    END IF;

    PERFORM p.id
    FROM public.profiles AS p
    WHERE p.id IN (v_caller_id, p_recipient_id)
    ORDER BY p.id
    FOR UPDATE;

    v_now := pg_catalog.clock_timestamp();

    SELECT pg_catalog.count(*)::integer
    INTO v_profile_count
    FROM public.profiles AS p
    WHERE p.id IN (v_caller_id, p_recipient_id)
      AND p.status = 'active'
      AND p.is_blocked = false;

    IF v_profile_count <> 2 THEN
        RAISE EXCEPTION 'This call is not available.'
            USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.blocks AS b
        WHERE
            (b.blocker_id = v_caller_id AND b.blocked_id = p_recipient_id)
            OR
            (b.blocker_id = p_recipient_id AND b.blocked_id = v_caller_id)
    ) THEN
        RAISE EXCEPTION 'This call is not available.'
            USING ERRCODE = '42501';
    END IF;

    -- Mark expired unanswered invitations for either participant.
    UPDATE public.video_call_invitations AS v
    SET
        status = 'expired',
        responded_at = COALESCE(v.responded_at, v_now)
    WHERE v.status IN ('ringing', 'accepted')
      AND v.expires_at <= v_now
      AND (
          v.caller_id IN (v_caller_id, p_recipient_id)
          OR v.recipient_id IN (v_caller_id, p_recipient_id)
      );

    -- A participant can have only one active call at a time.
    IF EXISTS (
        SELECT 1
        FROM public.video_call_invitations AS v
        WHERE
            (
                v.caller_id IN (v_caller_id, p_recipient_id)
                OR v.recipient_id IN (v_caller_id, p_recipient_id)
            )
            AND v.status IN ('ringing', 'accepted')
            AND v.expires_at > v_now
    ) THEN
        RAISE EXCEPTION 'One of the participants already has an active call.'
            USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.video_call_invitations (
        caller_id,
        recipient_id,
        status,
        created_at,
        expires_at
    )
    VALUES (
        v_caller_id,
        p_recipient_id,
        'ringing',
        v_now,
        v_now + interval '60 seconds'
    )
    RETURNING id INTO v_invitation_id;

    RETURN v_invitation_id;
END;
$function$;
-- ============================================================
-- 4. ACCEPT OR DECLINE INVITATION
-- Only the intended recipient may respond.
-- ============================================================

CREATE OR REPLACE FUNCTION public.respond_to_video_call_invitation(
    p_invitation_id uuid,
    p_action text
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_invitation public.video_call_invitations%ROWTYPE;
    v_profile_count integer;
    v_now timestamptz;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = '28000';
    END IF;

    IF p_action IS NULL OR p_action NOT IN ('accepted', 'declined') THEN
        RAISE EXCEPTION 'Invalid invitation response.'
            USING ERRCODE = '22023';
    END IF;

    SELECT v.*
    INTO v_invitation
    FROM public.video_call_invitations AS v
    WHERE v.id = p_invitation_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invitation not found.'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_invitation.recipient_id <> v_actor_id THEN
        RAISE EXCEPTION 'Only the intended recipient can respond.'
            USING ERRCODE = '42501';
    END IF;

    IF v_invitation.status <> 'ringing' THEN
        RETURN v_invitation.status;
    END IF;

    -- Use the same profile-lock order as invitation creation.
    PERFORM p.id
    FROM public.profiles AS p
    WHERE p.id IN (
        v_invitation.caller_id,
        v_invitation.recipient_id
    )
    ORDER BY p.id
    FOR UPDATE;

    SELECT v.*
    INTO v_invitation
    FROM public.video_call_invitations AS v
    WHERE v.id = p_invitation_id
    FOR UPDATE;

    v_now := pg_catalog.clock_timestamp();

    IF v_invitation.recipient_id <> v_actor_id THEN
        RAISE EXCEPTION 'Only the intended recipient can respond.'
            USING ERRCODE = '42501';
    END IF;

    IF v_invitation.status <> 'ringing' THEN
        RETURN v_invitation.status;
    END IF;

    IF v_invitation.expires_at <= v_now THEN
        UPDATE public.video_call_invitations
        SET status = 'expired', responded_at = v_now
        WHERE id = p_invitation_id;

        RETURN 'expired';
    END IF;

    SELECT pg_catalog.count(*)::integer
    INTO v_profile_count
    FROM public.profiles AS p
    WHERE p.id IN (
        v_invitation.caller_id,
        v_invitation.recipient_id
    )
      AND p.status = 'active'
      AND p.is_blocked = false;

    IF v_profile_count <> 2 OR EXISTS (
        SELECT 1
        FROM public.blocks AS b
        WHERE
            (
                b.blocker_id = v_invitation.caller_id
                AND b.blocked_id = v_invitation.recipient_id
            )
            OR
            (
                b.blocker_id = v_invitation.recipient_id
                AND b.blocked_id = v_invitation.caller_id
            )
    ) THEN
        UPDATE public.video_call_invitations
        SET status = 'cancelled', responded_at = v_now
        WHERE id = p_invitation_id;

        RETURN 'cancelled';
    END IF;

    -- Profile locks above serialize acceptance for both participants.
    IF p_action = 'accepted' AND EXISTS (
        SELECT 1
        FROM public.video_call_invitations AS active
        WHERE active.id <> p_invitation_id
          AND (
              active.caller_id IN (
                  v_invitation.caller_id,
                  v_invitation.recipient_id
              )
              OR active.recipient_id IN (
                  v_invitation.caller_id,
                  v_invitation.recipient_id
              )
          )
          AND active.status IN ('ringing', 'accepted')
          AND active.expires_at > v_now
    ) THEN
        RAISE EXCEPTION
            'One of the participants already has an active call.'
            USING ERRCODE = '55000';
    END IF;

    UPDATE public.video_call_invitations
    SET
        status = p_action,
        responded_at = v_now,
        expires_at = CASE
            WHEN p_action = 'accepted'
                THEN v_now + interval '2 hours'
            ELSE expires_at
        END
    WHERE id = p_invitation_id;

    RETURN p_action;
END;
$function$;
-- ============================================================
-- 5. END OR CANCEL INVITATION
-- Either participant may terminate the invitation/call.
-- ============================================================

CREATE OR REPLACE FUNCTION public.end_video_call_invitation(
    p_invitation_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_invitation public.video_call_invitations%ROWTYPE;
    v_new_status text;
    v_now timestamptz;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = '28000';
    END IF;

    SELECT v.*
    INTO v_invitation
    FROM public.video_call_invitations AS v
    WHERE v.id = p_invitation_id
    FOR UPDATE;

    v_now := pg_catalog.clock_timestamp();

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invitation not found.'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_actor_id NOT IN (
        v_invitation.caller_id,
        v_invitation.recipient_id
    ) THEN
        RAISE EXCEPTION 'You are not a participant in this call.'
            USING ERRCODE = '42501';
    END IF;

    IF v_invitation.status = 'ringing' THEN
        v_new_status := CASE
            WHEN v_invitation.expires_at <= v_now THEN 'expired'
            ELSE 'cancelled'
        END;
    ELSIF v_invitation.status = 'accepted' THEN
        v_new_status := CASE
            WHEN v_invitation.expires_at <= v_now THEN 'expired'
            ELSE 'ended'
        END;
    ELSE
        RETURN v_invitation.status;
    END IF;

    UPDATE public.video_call_invitations
    SET
        status = v_new_status,
        ended_at = v_now,
        responded_at = CASE
            WHEN v_new_status = 'expired'
                THEN COALESCE(responded_at, v_now)
            ELSE responded_at
        END
    WHERE id = p_invitation_id;

    RETURN v_new_status;
END;
$function$;
-- ============================================================
-- 5A. EXPIRE INVITATION USING THE DATABASE CLOCK
-- Either participant may request expiry, but PostgreSQL decides
-- whether the invitation lease has actually elapsed.
-- ============================================================

CREATE OR REPLACE FUNCTION public.expire_video_call_invitation(
    p_invitation_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_invitation public.video_call_invitations%ROWTYPE;
    v_now timestamptz;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = '28000';
    END IF;

    SELECT v.*
    INTO v_invitation
    FROM public.video_call_invitations AS v
    WHERE v.id = p_invitation_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Invitation not found.'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_actor_id NOT IN (
        v_invitation.caller_id,
        v_invitation.recipient_id
    ) THEN
        RAISE EXCEPTION 'You are not a participant in this call.'
            USING ERRCODE = '42501';
    END IF;

    -- Capture time after acquiring the invitation row lock.
    v_now := pg_catalog.clock_timestamp();

    IF v_invitation.status NOT IN ('ringing', 'accepted') THEN
        RETURN v_invitation.status;
    END IF;

    -- Never expire a call based on the browser's clock.
    IF v_invitation.expires_at > v_now THEN
        RETURN v_invitation.status;
    END IF;

    UPDATE public.video_call_invitations
    SET
        status = 'expired',
        ended_at = COALESCE(ended_at, v_now),
        responded_at = COALESCE(responded_at, v_now)
    WHERE id = p_invitation_id;

    RETURN 'expired';
END;
$function$;
-- ============================================================
-- 6. FUNCTION PRIVILEGES
-- ============================================================

REVOKE ALL ON FUNCTION
    public.create_video_call_invitation(uuid)
    FROM PUBLIC;
REVOKE ALL ON FUNCTION
    public.create_video_call_invitation(uuid)
    FROM anon;
REVOKE ALL ON FUNCTION
    public.create_video_call_invitation(uuid)
    FROM authenticated;
REVOKE ALL ON FUNCTION
    public.create_video_call_invitation(uuid)
    FROM service_role;
GRANT EXECUTE ON FUNCTION
    public.create_video_call_invitation(uuid)
    TO authenticated;
REVOKE ALL ON FUNCTION
    public.respond_to_video_call_invitation(uuid, text)
    FROM PUBLIC;
REVOKE ALL ON FUNCTION
    public.respond_to_video_call_invitation(uuid, text)
    FROM anon;
REVOKE ALL ON FUNCTION
    public.respond_to_video_call_invitation(uuid, text)
    FROM authenticated;
REVOKE ALL ON FUNCTION
    public.respond_to_video_call_invitation(uuid, text)
    FROM service_role;
GRANT EXECUTE ON FUNCTION
    public.respond_to_video_call_invitation(uuid, text)
    TO authenticated;
REVOKE ALL ON FUNCTION
    public.end_video_call_invitation(uuid)
    FROM PUBLIC;
REVOKE ALL ON FUNCTION
    public.end_video_call_invitation(uuid)
    FROM anon;
REVOKE ALL ON FUNCTION
    public.end_video_call_invitation(uuid)
    FROM authenticated;
REVOKE ALL ON FUNCTION
    public.end_video_call_invitation(uuid)
    FROM service_role;
GRANT EXECUTE ON FUNCTION
    public.end_video_call_invitation(uuid)
    TO authenticated;
REVOKE ALL ON FUNCTION
    public.expire_video_call_invitation(uuid)
    FROM PUBLIC;
REVOKE ALL ON FUNCTION
    public.expire_video_call_invitation(uuid)
    FROM anon;
REVOKE ALL ON FUNCTION
    public.expire_video_call_invitation(uuid)
    FROM authenticated;
REVOKE ALL ON FUNCTION
    public.expire_video_call_invitation(uuid)
    FROM service_role;
GRANT EXECUTE ON FUNCTION
    public.expire_video_call_invitation(uuid)
    TO authenticated;
ALTER FUNCTION public.create_video_call_invitation(uuid) OWNER TO postgres;
ALTER FUNCTION public.respond_to_video_call_invitation(uuid, text) OWNER TO postgres;
ALTER FUNCTION public.end_video_call_invitation(uuid) OWNER TO postgres;
ALTER FUNCTION public.expire_video_call_invitation(uuid) OWNER TO postgres;
-- ============================================================
-- 7. POSTGRES CHANGES PUBLICATION
-- RLS limits delivery to the two participants.
-- ============================================================

DO $publication$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_publication_tables
        WHERE pubname = 'supabase_realtime'
          AND schemaname = 'public'
          AND tablename = 'video_call_invitations'
    ) THEN
        ALTER PUBLICATION supabase_realtime
            ADD TABLE public.video_call_invitations;
    END IF;
END;
$publication$;
COMMIT;
