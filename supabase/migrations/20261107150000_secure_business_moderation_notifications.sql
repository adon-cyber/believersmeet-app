BEGIN;
CREATE OR REPLACE FUNCTION public.moderate_business_listing(
    p_business_id uuid,
    p_status text,
    p_is_approved boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_is_super_admin boolean;
    v_actor_role text;
    v_actor_church_id uuid;
    v_actor_status text;
    v_actor_is_blocked boolean;
    v_actor_church_status text;
    v_business_church_id uuid;
    v_business_user_id uuid;
    v_business_name text;
    v_previous_status text;
    v_status text;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required.';
    END IF;

    IF p_business_id IS NULL
       OR p_status IS NULL
       OR p_is_approved IS NULL THEN
        RAISE EXCEPTION 'All moderation fields are required.';
    END IF;

    v_status := pg_catalog.lower(pg_catalog.btrim(p_status));

    IF v_status NOT IN ('pending', 'approved', 'rejected') THEN
        RAISE EXCEPTION 'Invalid business status.';
    END IF;

    IF p_is_approved IS DISTINCT FROM (v_status = 'approved') THEN
        RAISE EXCEPTION 'Business status and approval flag conflict.';
    END IF;

    v_is_super_admin := public.is_super_admin();

    IF NOT v_is_super_admin THEN
        SELECT
            p.role,
            p.church_id,
            p.status,
            COALESCE(p.is_blocked, false),
            c.status
        INTO
            v_actor_role,
            v_actor_church_id,
            v_actor_status,
            v_actor_is_blocked,
            v_actor_church_status
        FROM public.profiles AS p
        LEFT JOIN public.churches AS c
            ON c.id = p.church_id
        WHERE p.id = v_actor_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Administrator profile not found.';
        END IF;

        IF v_actor_role IS DISTINCT FROM 'church_admin'
           OR v_actor_church_id IS NULL THEN
            RAISE EXCEPTION
                'You are not authorized to moderate businesses.';
        END IF;

        IF v_actor_status IS DISTINCT FROM 'active'
           OR v_actor_is_blocked IS DISTINCT FROM false THEN
            RAISE EXCEPTION
                'An active, unblocked Church Admin account is required.';
        END IF;

        IF v_actor_church_status IS DISTINCT FROM 'approved' THEN
            RAISE EXCEPTION
                'Business moderation requires an approved assigned church.';
        END IF;
    END IF;

    -- Lock and retrieve the listing and its owner.
    SELECT
        b.church_id,
        b.user_id,
        b.business_name,
        b.status
    INTO
        v_business_church_id,
        v_business_user_id,
        v_business_name,
        v_previous_status
    FROM public.business_directory AS b
    WHERE b.id = p_business_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Business listing not found.';
    END IF;

    IF NOT v_is_super_admin
       AND v_actor_church_id IS DISTINCT FROM v_business_church_id THEN
        RAISE EXCEPTION
            'You cannot moderate businesses belonging to another church.';
    END IF;

    UPDATE public.business_directory
    SET
        status = v_status,
        is_approved = p_is_approved,
        updated_at = pg_catalog.now()
    WHERE id = p_business_id;

    -- Notify the listing owner only when its moderation status changes.
    -- This runs inside the same transaction as the business update.
    IF v_status IN ('approved', 'rejected')
       AND v_previous_status IS DISTINCT FROM v_status THEN

        INSERT INTO public.notifications (
            user_id,
            church_id,
            title,
            message,
            type,
            is_read,
            actor_id
        )
        VALUES (
            v_business_user_id,
            v_business_church_id,
            CASE
                WHEN v_status = 'approved'
                    THEN 'Business Approved!'
                ELSE 'Business Submission Declined'
            END,
            CASE
                WHEN v_status = 'approved' THEN
                    'Your business "'
                    || v_business_name
                    || '" has been approved and is now live in the directory.'
                ELSE
                    'Your business "'
                    || v_business_name
                    || '" was declined by the administrator.'
            END,
            'business_approval',
            false,
            v_actor_id
        );
    END IF;
END;
$function$;
ALTER FUNCTION public.moderate_business_listing(uuid, text, boolean)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION
    public.moderate_business_listing(uuid, text, boolean)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
    public.moderate_business_listing(uuid, text, boolean)
    TO authenticated;
COMMIT;
