BEGIN;
-- ============================================================
-- MEMBER SUBMISSION
-- Authenticated member identity is derived from auth.uid().
-- Only active members of approved churches may submit.
-- Notifications go only to active, unblocked church_admin users
-- belonging to that same church. Super Admins are excluded.
-- ============================================================

CREATE OR REPLACE FUNCTION public.submit_counseling_appointment(
    p_appointment_date date,
    p_appointment_time time without time zone,
    p_reason text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_church_id uuid;
    v_member_name text;
    v_member_email text;
    v_reason text;
    v_appointment_id uuid;
    v_notification_count integer;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required.'
            USING ERRCODE = '42501';
    END IF;

    IF p_appointment_date IS NULL
       OR p_appointment_date < CURRENT_DATE
       OR p_appointment_time IS NULL
       OR p_reason IS NULL
       OR pg_catalog.length(pg_catalog.btrim(p_reason)) = 0
       OR pg_catalog.length(p_reason) > 2000 THEN
        RAISE EXCEPTION 'Please provide a valid future appointment date, time, and reason.'
            USING ERRCODE = '22023';
    END IF;

    -- Derive member identity and church from the authenticated profile.
    SELECT
        p.church_id,
        NULLIF(pg_catalog.btrim(p.full_name), ''),
        COALESCE(
            NULLIF(pg_catalog.btrim(p.email), ''),
            NULLIF(pg_catalog.btrim(u.email), '')
        )
    INTO
        v_church_id,
        v_member_name,
        v_member_email
    FROM public.profiles AS p
    INNER JOIN public.churches AS c
        ON c.id = p.church_id
    LEFT JOIN auth.users AS u
        ON u.id = p.id
    WHERE p.id = v_actor_id
      AND p.status = 'active'
      AND COALESCE(p.is_blocked, false) = false
      AND c.status = 'approved';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'An active, unblocked profile belonging to an approved church is required.'
            USING ERRCODE = '42501';
    END IF;

    IF v_member_name IS NULL THEN
        RAISE EXCEPTION 'Please add your full name to your profile before requesting counseling.'
            USING ERRCODE = '22023';
    END IF;

    v_reason := pg_catalog.btrim(p_reason);

    INSERT INTO public.counseling_appointments (
        user_id,
        member_name,
        member_email,
        appointment_date,
        appointment_time,
        reason,
        status
    )
    VALUES (
        v_actor_id,
        v_member_name,
        v_member_email,
        p_appointment_date,
        p_appointment_time,
        v_reason,
        'Pending'
    )
    RETURNING id INTO v_appointment_id;

    -- Notify eligible church administrators only.
    INSERT INTO public.notifications (
        user_id,
        title,
        message,
        is_read,
        type,
        actor_id,
        church_id,
        link
    )
    SELECT
        admin_profile.id,
        'New Counseling Request',
        'New counseling request from '
            || v_member_name
            || ' for '
            || p_appointment_date::text
            || '.',
        false,
        'counseling_request',
        v_actor_id,
        v_church_id,
        '/admin-counseling.html'
    FROM public.profiles AS admin_profile
    WHERE admin_profile.church_id = v_church_id
      AND admin_profile.role = 'church_admin'
      AND admin_profile.status = 'active'
      AND COALESCE(admin_profile.is_blocked, false) = false;

    GET DIAGNOSTICS v_notification_count = ROW_COUNT;

    -- Roll back the appointment too if no eligible administrator exists.
    IF v_notification_count = 0 THEN
        RAISE EXCEPTION 'No active church administrator is available to receive this request.';
    END IF;

    RETURN pg_catalog.jsonb_build_object(
        'appointment_id', v_appointment_id,
        'status', 'Pending',
        'notification_created', true,
        'notification_count', v_notification_count
    );
END;
$function$;
ALTER FUNCTION public.submit_counseling_appointment(
    date, time without time zone, text
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.submit_counseling_appointment(
    date, time without time zone, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_counseling_appointment(
    date, time without time zone, text
) TO authenticated;
-- ============================================================
-- CHURCH ADMIN APPROVAL / DECLINE
-- Only active, unblocked church_admin accounts for an approved
-- church may update a Pending request belonging to that church.
-- The member is notified in the same transaction.
-- ============================================================

CREATE OR REPLACE FUNCTION public.update_counseling_appointment_status(
    p_appointment_id uuid,
    p_new_status text
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_admin_church_id uuid;
    v_member_user_id uuid;
    v_appointment_date date;
    v_current_status text;
    v_rows integer;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication is required.'
            USING ERRCODE = '42501';
    END IF;

    IF p_appointment_id IS NULL
       OR p_new_status IS NULL
       OR p_new_status NOT IN ('Approved', 'Declined') THEN
        RAISE EXCEPTION 'Invalid counseling status request.'
            USING ERRCODE = '22023';
    END IF;

    SELECT p.church_id
    INTO v_admin_church_id
    FROM public.profiles AS p
    INNER JOIN public.churches AS c
        ON c.id = p.church_id
    WHERE p.id = v_actor_id
      AND p.role = 'church_admin'
      AND p.status = 'active'
      AND COALESCE(p.is_blocked, false) = false
      AND c.status = 'approved';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Active church administrator access required.'
            USING ERRCODE = '42501';
    END IF;

    SELECT
        a.user_id,
        a.appointment_date,
        a.status
    INTO
        v_member_user_id,
        v_appointment_date,
        v_current_status
    FROM public.counseling_appointments AS a
    WHERE a.id = p_appointment_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Counseling request not found.';
    END IF;

    -- Explicit same-church check; do not rely on client-supplied church IDs.
    IF NOT EXISTS (
        SELECT 1
        FROM public.profiles AS member_profile
        WHERE member_profile.id = v_member_user_id
          AND member_profile.church_id = v_admin_church_id
    ) THEN
        RAISE EXCEPTION 'This counseling request is outside your church.'
            USING ERRCODE = '42501';
    END IF;

    IF v_current_status IS DISTINCT FROM 'Pending' THEN
        RAISE EXCEPTION 'Only pending counseling requests can be updated.';
    END IF;

    UPDATE public.counseling_appointments
    SET status = p_new_status
    WHERE id = p_appointment_id
      AND status = 'Pending';

    GET DIAGNOSTICS v_rows = ROW_COUNT;

    IF v_rows <> 1 THEN
        RAISE EXCEPTION 'Counseling request could not be updated.';
    END IF;

    INSERT INTO public.notifications (
        user_id,
        title,
        message,
        is_read,
        type,
        actor_id,
        church_id,
        link
    )
    VALUES (
        v_member_user_id,
        'Counseling Request ' || p_new_status,
        'Your counseling appointment request for '
            || v_appointment_date::text
            || ' has been '
            || pg_catalog.lower(p_new_status)
            || '.',
        false,
        'counseling_status',
        v_actor_id,
        v_admin_church_id,
        '/counseling.html'
    );

    RETURN pg_catalog.jsonb_build_object(
        'appointment_id', p_appointment_id,
        'status', p_new_status,
        'notification_created', true
    );
END;
$function$;
ALTER FUNCTION public.update_counseling_appointment_status(uuid, text)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION
    public.update_counseling_appointment_status(uuid, text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION
    public.update_counseling_appointment_status(uuid, text)
    TO authenticated;
-- ============================================================
-- REMOVE DIRECT CLIENT WRITES
-- Preserve both existing SELECT policies:
--   counseling_appointments_select_own
--   counseling_appointments_church_admin_select
-- ============================================================

DROP POLICY IF EXISTS counseling_appointments_insert_own_pending
    ON public.counseling_appointments;
DROP POLICY IF EXISTS counseling_appointments_church_admin_update_status
    ON public.counseling_appointments;
REVOKE INSERT ON TABLE public.counseling_appointments
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE UPDATE ON TABLE public.counseling_appointments
    FROM PUBLIC, anon, authenticated, service_role;
-- Explicitly clear any column-level grants as well.
REVOKE INSERT (
    id,
    user_id,
    member_name,
    member_email,
    appointment_date,
    appointment_time,
    reason,
    status,
    created_at
) ON TABLE public.counseling_appointments
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE UPDATE (
    id,
    user_id,
    member_name,
    member_email,
    appointment_date,
    appointment_time,
    reason,
    status,
    created_at
) ON TABLE public.counseling_appointments
    FROM PUBLIC, anon, authenticated, service_role;
COMMIT;
