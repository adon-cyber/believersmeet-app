CREATE OR REPLACE FUNCTION public.request_connection(p_recipient_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid;
    v_actor_name text;
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

    SELECT COALESCE(
        NULLIF(pg_catalog.btrim(p.full_name), ''),
        'A believer'
    )
    INTO v_actor_name
    FROM public.profiles AS p
    WHERE p.id = v_actor_id;

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
        INSERT INTO public.notifications (
            user_id,
            title,
            message,
            is_read,
            type,
            actor_id,
            link
        )
        VALUES (
            p_recipient_id,
            'New Connection Request',
            v_actor_name || ' sent you a connection request.',
            false,
            'connection_request',
            v_actor_id,
            '/profile.html'
        );

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

        INSERT INTO public.notifications (
            user_id,
            title,
            message,
            is_read,
            type,
            actor_id,
            link
        )
        VALUES (
            p_recipient_id,
            'New Connection Request',
            v_actor_name || ' resent you a connection request.',
            false,
            'connection_request',
            v_actor_id,
            '/profile.html'
        );

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

REVOKE ALL ON FUNCTION public.request_connection(uuid)
    FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION public.request_connection(uuid)
    TO authenticated;
