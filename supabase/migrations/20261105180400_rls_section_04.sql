-- ============================================================
-- BELIEVERSMEET STAGING
-- RLS SECTION 04: CONNECTIONS SECURITY
-- REVIEW DRAFT ONLY - DO NOT EXECUTE
-- Designed for Foundation Revision 6
-- ============================================================

BEGIN;
-- ============================================================
-- 1. PREFLIGHT
-- ============================================================

DO $preflight$
DECLARE
    v_rls_enabled boolean;
BEGIN
    IF current_user <> 'postgres' THEN
        RAISE EXCEPTION 'Run this section as postgres.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated')
       OR NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'anon') THEN
        RAISE EXCEPTION 'Required Supabase roles are missing.';
    END IF;

    IF pg_catalog.to_regclass('public.connections') IS NULL
       OR pg_catalog.to_regclass('public.profiles') IS NULL
       OR pg_catalog.to_regclass('public.blocks') IS NULL THEN
        RAISE EXCEPTION 'Required connections, profiles, or blocks table is missing.';
    END IF;

    SELECT c.relrowsecurity
      INTO v_rls_enabled
      FROM pg_catalog.pg_class AS c
      JOIN pg_catalog.pg_namespace AS n
        ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'connections';

    IF v_rls_enabled IS DISTINCT FROM TRUE THEN
        RAISE EXCEPTION 'RLS must already be enabled on public.connections.';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.connections AS c
         WHERE c.requester_id IS NULL
            OR c.recipient_id IS NULL
            OR c.status IS NULL
            OR c.created_at IS NULL
            OR c.updated_at IS NULL
            OR c.requester_id = c.recipient_id
    ) THEN
        RAISE EXCEPTION 'Connections contains null, self-connection, or invalid rows. Review before proceeding.';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.connections AS c
         GROUP BY
            LEAST(c.requester_id, c.recipient_id),
            GREATEST(c.requester_id, c.recipient_id)
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'Opposite-direction or duplicate connection records exist. Reconcile them before proceeding.';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_policies AS p
         WHERE p.schemaname = 'public'
           AND p.tablename = 'connections'
           AND p.policyname NOT IN (
               'Users can view their own connections',
               'Users can create connection requests',
               'Users can update their own connections',
               'connections_select_participants'
           )
    ) THEN
        RAISE EXCEPTION 'Unexpected connections policies exist. Review them before replacing policies.';
    END IF;
END;
$preflight$;
-- ============================================================
-- 2. CONNECTION DATA INTEGRITY
-- ============================================================

ALTER TABLE public.connections
    ALTER COLUMN requester_id SET NOT NULL,
    ALTER COLUMN recipient_id SET NOT NULL,
    ALTER COLUMN status SET NOT NULL,
    ALTER COLUMN created_at SET NOT NULL,
    ALTER COLUMN updated_at SET NOT NULL;
ALTER TABLE public.connections
    ADD CONSTRAINT connections_distinct_participants_check
    CHECK (requester_id <> recipient_id);
-- Prevent A -> B and B -> A from becoming separate records.
CREATE UNIQUE INDEX connections_unordered_pair_unique
    ON public.connections (
        (LEAST(requester_id, recipient_id)),
        (GREATEST(requester_id, recipient_id))
    );
-- ============================================================
-- 3. REMOVE OLD PERMISSIVE POLICIES
-- ============================================================

DROP POLICY IF EXISTS "Users can view their own connections"
    ON public.connections;
DROP POLICY IF EXISTS "Users can create connection requests"
    ON public.connections;
DROP POLICY IF EXISTS "Users can update their own connections"
    ON public.connections;
DROP POLICY IF EXISTS connections_select_participants
    ON public.connections;
-- ============================================================
-- 4. CONNECTION READ POLICY
-- ============================================================

CREATE POLICY connections_select_participants
    ON public.connections
    FOR SELECT
    TO authenticated
    USING (
        (SELECT auth.uid()) = requester_id
        OR
        (SELECT auth.uid()) = recipient_id
    );
-- No INSERT, UPDATE, or DELETE policies are created.
-- All connection writes must use the protected RPCs below.

REVOKE ALL PRIVILEGES
    ON TABLE public.connections
    FROM PUBLIC, anon, authenticated;
GRANT SELECT
    ON TABLE public.connections
    TO authenticated;
-- ============================================================
-- 5. SEND OR RESEND CONNECTION REQUEST
-- ============================================================

CREATE OR REPLACE FUNCTION public.request_connection(
    p_recipient_id uuid
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid;
    v_now timestamptz;
    v_connection public.connections%ROWTYPE;
BEGIN
    v_actor_id := (SELECT auth.uid());

    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required.'
            USING ERRCODE = '42501';
    END IF;

    IF p_recipient_id IS NULL OR p_recipient_id = v_actor_id THEN
        RAISE EXCEPTION 'Invalid connection recipient.'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.profiles AS p
         WHERE p.id = v_actor_id
           AND p.status = 'active'
           AND COALESCE(p.is_blocked, false) = false
    ) THEN
        RAISE EXCEPTION 'Your account is not eligible to send connection requests.'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.profiles AS p
         WHERE p.id = p_recipient_id
           AND p.status = 'active'
           AND COALESCE(p.is_blocked, false) = false
    ) THEN
        RAISE EXCEPTION 'This member is not available for connection requests.'
            USING ERRCODE = '42501';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.blocks AS b
         WHERE (
             b.blocker_id = v_actor_id
             AND b.blocked_id = p_recipient_id
         )
         OR (
             b.blocker_id = p_recipient_id
             AND b.blocked_id = v_actor_id
         )
    ) THEN
        RAISE EXCEPTION 'Connection requests are unavailable between these members.'
            USING ERRCODE = '42501';
    END IF;

    v_now := pg_catalog.clock_timestamp();

    INSERT INTO public.connections (
        requester_id,
        recipient_id,
        status,
        created_at,
        updated_at
    )
    VALUES (
        v_actor_id,
        p_recipient_id,
        'pending',
        v_now,
        v_now
    )
    ON CONFLICT DO NOTHING
    RETURNING * INTO v_connection;

    IF FOUND THEN
        RETURN pg_catalog.jsonb_build_object(
            'connection_id', v_connection.id,
            'status', v_connection.status,
            'request_sent', true,
            'resent', false
        );
    END IF;

    SELECT c.*
      INTO v_connection
      FROM public.connections AS c
     WHERE (
         c.requester_id = v_actor_id
         AND c.recipient_id = p_recipient_id
     )
     OR (
         c.requester_id = p_recipient_id
         AND c.recipient_id = v_actor_id
     )
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Connection request could not be resolved. Please try again.';
    END IF;

    IF v_connection.status = 'accepted' THEN
        RETURN pg_catalog.jsonb_build_object(
            'connection_id', v_connection.id,
            'status', 'accepted',
            'request_sent', false,
            'resent', false
        );
    END IF;

    IF v_connection.status = 'pending' THEN
        RETURN pg_catalog.jsonb_build_object(
            'connection_id', v_connection.id,
            'status', 'pending',
            'request_sent', false,
            'resent', false
        );
    END IF;

    IF v_connection.status = 'rejected' THEN
        IF v_connection.requester_id <> v_actor_id THEN
            RETURN pg_catalog.jsonb_build_object(
                'connection_id', v_connection.id,
                'status', 'rejected',
                'request_sent', false,
                'resent', false
            );
        END IF;

        UPDATE public.connections AS c
           SET status = 'pending',
               updated_at = v_now
         WHERE c.id = v_connection.id
        RETURNING * INTO v_connection;

        RETURN pg_catalog.jsonb_build_object(
            'connection_id', v_connection.id,
            'status', v_connection.status,
            'request_sent', true,
            'resent', true
        );
    END IF;

    RAISE EXCEPTION 'Unexpected connection status.';
END;
$function$;
ALTER FUNCTION public.request_connection(uuid)
    OWNER TO postgres;
REVOKE ALL
    ON FUNCTION public.request_connection(uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
    ON FUNCTION public.request_connection(uuid)
    TO authenticated;
-- ============================================================
-- 6. ACCEPT OR REJECT CONNECTION REQUEST
-- ============================================================

CREATE OR REPLACE FUNCTION public.respond_to_connection(
    p_connection_id uuid,
    p_response text
)
RETURNS jsonb
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid;
    v_connection_id uuid;
    v_new_status text;
BEGIN
    v_actor_id := (SELECT auth.uid());

    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required.'
            USING ERRCODE = '42501';
    END IF;

    IF p_connection_id IS NULL
       OR (
           p_response IS DISTINCT FROM 'accepted'
           AND p_response IS DISTINCT FROM 'rejected'
       ) THEN
        RAISE EXCEPTION 'Invalid connection response.'
            USING ERRCODE = '22023';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.profiles AS p
         WHERE p.id = v_actor_id
           AND p.status = 'active'
           AND COALESCE(p.is_blocked, false) = false
    ) THEN
        RAISE EXCEPTION 'Your account is not eligible to respond to connection requests.'
            USING ERRCODE = '42501';
    END IF;

    IF p_response = 'accepted' THEN
        UPDATE public.connections AS c
           SET status = 'accepted',
               updated_at = pg_catalog.clock_timestamp()
         WHERE c.id = p_connection_id
           AND c.recipient_id = v_actor_id
           AND c.status = 'pending'
           AND EXISTS (
               SELECT 1
                 FROM public.profiles AS p
                WHERE p.id = c.requester_id
                  AND p.status = 'active'
                  AND COALESCE(p.is_blocked, false) = false
           )
           AND NOT EXISTS (
               SELECT 1
                 FROM public.blocks AS b
                WHERE (
                    b.blocker_id = c.requester_id
                    AND b.blocked_id = c.recipient_id
                )
                OR (
                    b.blocker_id = c.recipient_id
                    AND b.blocked_id = c.requester_id
                )
           )
        RETURNING c.id, c.status
             INTO v_connection_id, v_new_status;
    ELSE
        -- A recipient may reject their own pending request
        -- even when the sender is now inactive or blocked.
        UPDATE public.connections AS c
           SET status = 'rejected',
               updated_at = pg_catalog.clock_timestamp()
         WHERE c.id = p_connection_id
           AND c.recipient_id = v_actor_id
           AND c.status = 'pending'
        RETURNING c.id, c.status
             INTO v_connection_id, v_new_status;
    END IF;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Connection request not found, not pending, or not available for this action.'
            USING ERRCODE = '42501';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'connection_id', v_connection_id,
        'status', v_new_status
    );
END;
$function$;
ALTER FUNCTION public.respond_to_connection(uuid, text)
    OWNER TO postgres;
REVOKE ALL
    ON FUNCTION public.respond_to_connection(uuid, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE
    ON FUNCTION public.respond_to_connection(uuid, text)
    TO authenticated;
-- ============================================================
-- 7. PRESERVE REALTIME PUBLICATION MEMBERSHIP IF AVAILABLE
-- ============================================================

DO $publication$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM pg_catalog.pg_publication
         WHERE pubname = 'supabase_realtime'
    )
    AND NOT EXISTS (
        SELECT 1
          FROM pg_catalog.pg_publication_tables
         WHERE pubname = 'supabase_realtime'
           AND schemaname = 'public'
           AND tablename = 'connections'
    ) THEN
        ALTER PUBLICATION supabase_realtime
            ADD TABLE public.connections;
    END IF;
END;
$publication$;
COMMIT;
-- ============================================================
-- END OF SECTION 04
-- REVIEW DRAFT ONLY - DO NOT EXECUTE
-- ============================================================;
