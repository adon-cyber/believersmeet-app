BEGIN;
DO $preflight$
BEGIN
    IF to_regclass('public.churches') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: public.churches is missing.';
    END IF;

    IF to_regprocedure('public.can_manage_church_content(uuid)') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: Section 02 authorization helper is missing.';
    END IF;

    IF to_regprocedure('public.is_approved_public_church(uuid)') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: approved-church verification helper is missing.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute
        WHERE attrelid = 'public.churches'::regclass
          AND attname = 'live_stream_id'
          AND NOT attisdropped
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_attribute
        WHERE attrelid = 'public.churches'::regclass
          AND attname = 'is_live'
          AND NOT attisdropped
    ) THEN
        RAISE EXCEPTION 'Preflight failed: required church live-stream columns are missing.';
    END IF;
END;
$preflight$;
CREATE OR REPLACE FUNCTION public.set_church_live_stream(
    p_church_id uuid,
    p_live_stream_id text,
    p_is_live boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required.'
            USING ERRCODE = '42501';
    END IF;

    IF p_church_id IS NULL OR p_is_live IS NULL THEN
        RAISE EXCEPTION 'Church ID and live status are required.'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.can_manage_church_content(p_church_id) THEN
        RAISE EXCEPTION 'You are not authorized to manage this church broadcast.'
            USING ERRCODE = '42501';
    END IF;

    IF NOT public.is_approved_public_church(p_church_id) THEN
        RAISE EXCEPTION 'Live-stream controls are available only for approved churches.'
            USING ERRCODE = '42501';
    END IF;

    IF p_is_live THEN
        IF p_live_stream_id IS NULL
           OR p_live_stream_id !~ '^[A-Za-z0-9_-]{11}$' THEN
            RAISE EXCEPTION 'A valid 11-character YouTube video ID is required.'
                USING ERRCODE = '22023';
        END IF;

        UPDATE public.churches
        SET live_stream_id = p_live_stream_id,
            is_live = true
        WHERE id = p_church_id;
    ELSE
        UPDATE public.churches
        SET is_live = false
        WHERE id = p_church_id;
    END IF;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Church not found.';
    END IF;
END;
$function$;
ALTER FUNCTION public.set_church_live_stream(uuid, text, boolean)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.set_church_live_stream(uuid, text, boolean)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_church_live_stream(uuid, text, boolean)
    TO authenticated;
COMMENT ON FUNCTION public.set_church_live_stream(uuid, text, boolean)
    IS 'Updates a church live stream only when can_manage_church_content authorizes the caller.';
COMMIT;
