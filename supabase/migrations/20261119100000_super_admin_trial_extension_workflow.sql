BEGIN;

-- =========================================================
-- BELIEVERSMEET
-- SUPER ADMIN TRIAL EXTENSION WORKFLOW
--
-- Staging migration draft.
-- Do not execute until reviewed and approved.
--
-- Updates:
--   public.churches.trial_ends_at
--   public.church_subscriptions.trial_ends_at
--   public.church_subscriptions.next_invoice_at
--
-- Audit:
--   public.subscription_events
-- =========================================================


-- =========================================================
-- 1. SECURE TRIAL EXTENSION RPC
-- =========================================================

CREATE OR REPLACE FUNCTION public.super_admin_extend_church_trial(
    p_church_id uuid,
    p_new_expiry timestamptz,
    p_reason text
)
RETURNS TABLE (
    event_id uuid,
    church_id uuid,
    subscription_id uuid,
    previous_trial_ends_at timestamptz,
    new_trial_ends_at timestamptz,
    previous_next_invoice_at timestamptz,
    new_next_invoice_at timestamptz,
    reason text,
    created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_now timestamptz := pg_catalog.clock_timestamp();
    v_reason text := pg_catalog.btrim(COALESCE(p_reason, ''));

    v_church_status text;
    v_church_subscription_status text;
    v_church_trial_end timestamptz;

    v_subscription_id uuid;
    v_subscription_status text;
    v_subscription_trial_start timestamptz;
    v_subscription_trial_end timestamptz;
    v_next_invoice_at timestamptz;

    v_event_id uuid;
    v_event_created_at timestamptz;
BEGIN

    -- Authorization
    IF v_actor_id IS NULL
       OR NOT public.is_super_admin()
    THEN
        RAISE EXCEPTION
            'Access denied: Super Admin privileges required';
    END IF;


    -- Input validation
    IF p_church_id IS NULL THEN
        RAISE EXCEPTION 'Church ID is required';
    END IF;

    IF p_new_expiry IS NULL THEN
        RAISE EXCEPTION 'New trial expiry is required';
    END IF;

    IF pg_catalog.char_length(v_reason) < 10 THEN
        RAISE EXCEPTION
            'Please provide a trial extension reason of at least 10 characters';
    END IF;

    IF pg_catalog.char_length(v_reason) > 500 THEN
        RAISE EXCEPTION
            'Trial extension reason cannot exceed 500 characters';
    END IF;


    -- Lock and inspect church
    SELECT
        c.status,
        c.subscription_status,
        c.trial_ends_at
    INTO
        v_church_status,
        v_church_subscription_status,
        v_church_trial_end
    FROM public.churches AS c
    WHERE c.id = p_church_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Church not found';
    END IF;

    IF v_church_status IS DISTINCT FROM 'approved'
       OR v_church_subscription_status IS DISTINCT FROM 'trial'
    THEN
        RAISE EXCEPTION
            'Only approved churches on trial can have their trial extended';
    END IF;


    -- Lock and inspect the unique church subscription
    SELECT
        s.id,
        s.status,
        s.trial_starts_at,
        s.trial_ends_at,
        s.next_invoice_at
    INTO
        v_subscription_id,
        v_subscription_status,
        v_subscription_trial_start,
        v_subscription_trial_end,
        v_next_invoice_at
    FROM public.church_subscriptions AS s
    WHERE s.church_id = p_church_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Church subscription record not found';
    END IF;

    IF v_subscription_status IS DISTINCT FROM 'trial' THEN
        RAISE EXCEPTION
            'Subscription is not currently on trial';
    END IF;


    -- Fail closed if existing dates are inconsistent.
    -- Do not silently overwrite an unexplained billing schedule.
    IF v_church_trial_end IS NULL
       OR v_subscription_trial_end IS NULL
       OR v_church_trial_end IS DISTINCT FROM v_subscription_trial_end
    THEN
        RAISE EXCEPTION
            'Church and subscription trial dates are inconsistent. Reconciliation is required before extension.';
    END IF;

    IF v_next_invoice_at IS DISTINCT FROM v_subscription_trial_end THEN
        RAISE EXCEPTION
            'Next invoice date does not match the current trial expiry. Billing schedule reconciliation is required before extension.';
    END IF;


    v_now := pg_catalog.clock_timestamp();

    -- New expiry must extend the existing trial.
    IF p_new_expiry <= v_now
       OR p_new_expiry <= v_subscription_trial_end
    THEN
        RAISE EXCEPTION
            'New expiry must be later than the existing trial expiry and in the future';
    END IF;

    IF v_subscription_trial_start IS NULL THEN
        RAISE EXCEPTION
            'Trial start date is missing. Subscription reconciliation is required before extension.';
    END IF;

    IF p_new_expiry <= v_subscription_trial_start THEN
        RAISE EXCEPTION
            'New expiry must be later than the trial start date';
    END IF;

    IF p_new_expiry > v_subscription_trial_end + INTERVAL '3650 days' THEN
        RAISE EXCEPTION
            'A single trial extension cannot exceed 3,650 days beyond the current trial expiry';
    END IF;


    -- Update the church trial expiry.
    UPDATE public.churches
    SET trial_ends_at = p_new_expiry
    WHERE id = p_church_id;


    -- Update subscription trial expiry and next invoice together.
    UPDATE public.church_subscriptions
    SET
        trial_ends_at = p_new_expiry,
        next_invoice_at = p_new_expiry,
        updated_at = v_now
    WHERE id = v_subscription_id;


    -- Write protected administrative event history.
    INSERT INTO public.subscription_events AS se (
        church_id,
        subscription_id,
        event_type,
        description,
        actor_user_id,
        metadata
    )
    VALUES (
        p_church_id,
        v_subscription_id,
        'trial_extended',
        v_reason,
        v_actor_id,
        pg_catalog.jsonb_build_object(
            'reason', v_reason,
            'extension_method', 'set_expiry',
            'previous_church_trial_ends_at', v_church_trial_end,
            'previous_subscription_trial_ends_at', v_subscription_trial_end,
            'new_trial_ends_at', p_new_expiry,
            'previous_next_invoice_at', v_next_invoice_at,
            'new_next_invoice_at', p_new_expiry
        )
    )
    RETURNING se.id, se.created_at
    INTO v_event_id, v_event_created_at;


    -- Return the committed operation details.
    RETURN QUERY
    SELECT
        v_event_id,
        p_church_id,
        v_subscription_id,
        v_subscription_trial_end,
        p_new_expiry,
        v_next_invoice_at,
        p_new_expiry,
        v_reason,
        v_event_created_at;

END;
$function$;


ALTER FUNCTION public.super_admin_extend_church_trial(
    uuid,
    timestamptz,
    text
) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.super_admin_extend_church_trial(
    uuid,
    timestamptz,
    text
) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.super_admin_extend_church_trial(
    uuid,
    timestamptz,
    text
) TO authenticated;


-- =========================================================
-- 2. SECURE TRIAL EXTENSION HISTORY RPC
-- =========================================================

CREATE OR REPLACE FUNCTION public.super_admin_list_trial_extensions(
    p_limit integer DEFAULT 20
)
RETURNS TABLE (
    event_id uuid,
    church_id uuid,
    church_name text,
    subscription_id uuid,
    reason text,
    actor_user_id uuid,
    actor_name text,
    previous_trial_ends_at timestamptz,
    new_trial_ends_at timestamptz,
    previous_next_invoice_at timestamptz,
    new_next_invoice_at timestamptz,
    created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_limit integer :=
        LEAST(
            GREATEST(COALESCE(p_limit, 20), 1),
            100
        );
BEGIN

    IF auth.uid() IS NULL OR NOT public.is_super_admin() THEN
        RAISE EXCEPTION
            'Access denied: Super Admin privileges required';
    END IF;


    RETURN QUERY
    SELECT
        e.id,
        e.church_id,
        c.name::text,
        e.subscription_id,

        COALESCE(
            NULLIF(e.metadata ->> 'reason', ''),
            e.description,
            'No reason recorded'
        )::text,

        e.actor_user_id,

        COALESCE(
            NULLIF(p.full_name, ''),
            CASE
                WHEN e.actor_user_id IS NOT NULL
                    THEN 'Admin ' || pg_catalog.left(
                        e.actor_user_id::text,
                        8
                    )
                ELSE 'Former administrator'
            END
        )::text,

        COALESCE(
            NULLIF(
                e.metadata ->> 'previous_subscription_trial_ends_at',
                ''
            )::timestamptz,
            NULLIF(
                e.metadata ->> 'previous_subscription_expiry',
                ''
            )::timestamptz,
            NULLIF(
                e.metadata ->> 'previous_church_expiry',
                ''
            )::timestamptz
        ),

        COALESCE(
            NULLIF(
                e.metadata ->> 'new_trial_ends_at',
                ''
            )::timestamptz,
            NULLIF(
                e.metadata ->> 'new_expiry',
                ''
            )::timestamptz
        ),

        NULLIF(
            e.metadata ->> 'previous_next_invoice_at',
            ''
        )::timestamptz,

        NULLIF(
            e.metadata ->> 'new_next_invoice_at',
            ''
        )::timestamptz,

        e.created_at

    FROM public.subscription_events AS e

    INNER JOIN public.churches AS c
        ON c.id = e.church_id

    LEFT JOIN public.profiles AS p
        ON p.id = e.actor_user_id

    WHERE e.event_type = 'trial_extended'

    ORDER BY e.created_at DESC
    LIMIT v_limit;

END;
$function$;


ALTER FUNCTION public.super_admin_list_trial_extensions(integer)
    OWNER TO postgres;

REVOKE ALL ON FUNCTION public.super_admin_list_trial_extensions(integer)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.super_admin_list_trial_extensions(integer)
    TO authenticated;


-- Retire the legacy trial-extension entry point.
-- Keep the function for compatibility, but prevent application roles
-- from bypassing the synchronized trial and billing workflow.
REVOKE ALL ON FUNCTION public.extend_church_trial(uuid, timestamptz)
FROM PUBLIC, anon, authenticated, service_role;
COMMIT;