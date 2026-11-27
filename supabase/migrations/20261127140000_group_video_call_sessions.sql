BEGIN;

CREATE TABLE IF NOT EXISTS public.group_video_call_sessions (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    church_id uuid NOT NULL REFERENCES public.churches(id) ON DELETE CASCADE,
    group_id uuid NOT NULL REFERENCES public.groups(id) ON DELETE CASCADE,
    created_by uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    status text NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'ended', 'expired')),
    created_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    expires_at timestamptz NOT NULL,
    ended_at timestamptz,
    ended_by uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    CONSTRAINT group_video_call_expiry_check CHECK (expires_at > created_at),
    CONSTRAINT group_video_call_ended_state_check CHECK (
        (status = 'ended' AND ended_at IS NOT NULL AND ended_by IS NOT NULL)
        OR (status <> 'ended' AND ended_at IS NULL AND ended_by IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS group_video_call_sessions_group_created_idx
    ON public.group_video_call_sessions (group_id, created_at DESC);

CREATE INDEX IF NOT EXISTS group_video_call_sessions_expiry_idx
    ON public.group_video_call_sessions (expires_at)
    WHERE status = 'active';

CREATE UNIQUE INDEX IF NOT EXISTS group_video_call_one_active_per_group_uidx
    ON public.group_video_call_sessions (group_id)
    WHERE status = 'active';

ALTER TABLE public.group_video_call_sessions ENABLE ROW LEVEL SECURITY;

REVOKE ALL PRIVILEGES ON TABLE public.group_video_call_sessions
    FROM PUBLIC, anon, authenticated;
GRANT SELECT ON TABLE public.group_video_call_sessions TO authenticated, service_role;

DROP POLICY IF EXISTS group_video_call_members_read
    ON public.group_video_call_sessions;
CREATE POLICY group_video_call_members_read
    ON public.group_video_call_sessions
    FOR SELECT TO authenticated
    USING (
        public.is_approved_group_member(group_id)
        OR public.can_manage_church_content(church_id)
    );

CREATE OR REPLACE FUNCTION public.create_group_video_call(
    p_group_id uuid
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor uuid := auth.uid();
    v_church_id uuid;
    v_profile_church_id uuid;
    v_profile_status text;
    v_is_blocked boolean;
    v_church_status text;
    v_session_id uuid;
BEGIN
    IF v_actor IS NULL OR p_group_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and a group are required.' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended('believersmeet-group-call:' || p_group_id::text, 0)
    );

    SELECT p.church_id, p.status, COALESCE(p.is_blocked, false)
      INTO v_profile_church_id, v_profile_status, v_is_blocked
      FROM public.profiles p
     WHERE p.id = v_actor;

    IF NOT FOUND OR v_profile_status IS DISTINCT FROM 'active' OR v_is_blocked THEN
        RAISE EXCEPTION 'Your account is not eligible to start a group call.' USING ERRCODE = '42501';
    END IF;

    SELECT g.church_id, c.status
      INTO v_church_id, v_church_status
      FROM public.groups g
      JOIN public.churches c ON c.id = g.church_id
     WHERE g.id = p_group_id
     FOR UPDATE OF g;

    IF NOT FOUND OR v_church_status IS DISTINCT FROM 'approved' THEN
        RAISE EXCEPTION 'The group or its church is not available.' USING ERRCODE = 'P0002';
    END IF;

    IF v_profile_church_id IS DISTINCT FROM v_church_id
       OR NOT public.is_approved_group_member(p_group_id) THEN
        RAISE EXCEPTION 'Only active, approved members of this church group can start a group call.' USING ERRCODE = '42501';
    END IF;

    UPDATE public.group_video_call_sessions
       SET status = 'expired'
     WHERE group_id = p_group_id
       AND status = 'active'
       AND expires_at <= pg_catalog.clock_timestamp();

    IF EXISTS (
        SELECT 1
          FROM public.group_video_call_sessions s
         WHERE s.group_id = p_group_id
           AND s.status = 'active'
           AND s.expires_at > pg_catalog.clock_timestamp()
    ) THEN
        RAISE EXCEPTION 'A group video call is already active. Join the existing call instead.' USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.group_video_call_sessions (
        church_id, group_id, created_by, status, expires_at
    ) VALUES (
        v_church_id, p_group_id, v_actor, 'active',
        pg_catalog.clock_timestamp() + interval '2 hours'
    ) RETURNING id INTO v_session_id;

    RETURN v_session_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.end_group_video_call(
    p_session_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor uuid := auth.uid();
    v_church_id uuid;
    v_created_by uuid;
    v_status text;
BEGIN
    IF v_actor IS NULL OR p_session_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and a call session are required.' USING ERRCODE = '42501';
    END IF;

    SELECT s.church_id, s.created_by, s.status
      INTO v_church_id, v_created_by, v_status
      FROM public.group_video_call_sessions s
     WHERE s.id = p_session_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Group video call session was not found.' USING ERRCODE = 'P0002';
    END IF;

    IF v_status <> 'active' THEN
        RETURN;
    END IF;

    IF v_created_by IS DISTINCT FROM v_actor
       AND NOT public.can_manage_church_content(v_church_id) THEN
        RAISE EXCEPTION 'Only the call host or an authorized church manager can end this group call.' USING ERRCODE = '42501';
    END IF;

    UPDATE public.group_video_call_sessions
       SET status = 'ended',
           ended_at = pg_catalog.clock_timestamp(),
           ended_by = v_actor
     WHERE id = p_session_id AND status = 'active';
END;
$function$;

REVOKE ALL ON FUNCTION public.create_group_video_call(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.create_group_video_call(uuid)
    TO authenticated;

REVOKE ALL ON FUNCTION public.end_group_video_call(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.end_group_video_call(uuid)
    TO authenticated;

ALTER FUNCTION public.create_group_video_call(uuid) OWNER TO postgres;
ALTER FUNCTION public.end_group_video_call(uuid) OWNER TO postgres;

DO $publication$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_publication WHERE pubname = 'supabase_realtime')
       AND NOT EXISTS (
           SELECT 1 FROM pg_catalog.pg_publication_tables
            WHERE pubname = 'supabase_realtime'
              AND schemaname = 'public'
              AND tablename = 'group_video_call_sessions'
       ) THEN
        ALTER PUBLICATION supabase_realtime
            ADD TABLE public.group_video_call_sessions;
    END IF;
END;
$publication$;

COMMIT;
