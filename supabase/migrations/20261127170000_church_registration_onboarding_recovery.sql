-- BelieversMeet Staging — Church Registration Onboarding Recovery
-- Review and apply to BelieversMeet-Staging only.
-- This migration does not modify Production or existing church/member data,
-- except for backfilling last_submitted_at from each existing church created_at.
-- It adds controlled resubmission, enabled-currency discovery and an application
-- status history. Existing submit_church_application signatures remain intact.

BEGIN;

-- 1. Keep an accurate latest submission timestamp without rewriting created_at.
ALTER TABLE public.churches
    ADD COLUMN IF NOT EXISTS last_submitted_at timestamptz;

UPDATE public.churches
   SET last_submitted_at = COALESCE(created_at, pg_catalog.clock_timestamp())
 WHERE last_submitted_at IS NULL;

ALTER TABLE public.churches
    ALTER COLUMN last_submitted_at SET DEFAULT pg_catalog.clock_timestamp(),
    ALTER COLUMN last_submitted_at SET NOT NULL;

-- 2. Immutable application status history.
CREATE TABLE IF NOT EXISTS public.church_application_status_history (
    id uuid PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    church_id uuid NOT NULL REFERENCES public.churches(id) ON DELETE CASCADE,
    applicant_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    actor_user_id uuid REFERENCES auth.users(id) ON DELETE SET NULL,
    event_type text NOT NULL,
    previous_status text,
    new_status text,
    previous_feedback text,
    new_feedback text,
    occurred_at timestamptz NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    CONSTRAINT church_application_status_history_event_type_check
        CHECK (event_type IN (
            'application_submitted',
            'changes_requested',
            'application_rejected',
            'application_approved',
            'resubmitted_after_changes',
            'reapplied_after_rejection',
            'application_feedback_updated',
            'application_status_updated'
        ))
);

CREATE INDEX IF NOT EXISTS idx_church_application_status_history_church_time
    ON public.church_application_status_history(church_id, occurred_at DESC);

ALTER TABLE public.church_application_status_history ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.church_application_status_history
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.church_application_status_history TO authenticated;

DROP POLICY IF EXISTS church_application_status_history_read_own_or_platform_admin
    ON public.church_application_status_history;
CREATE POLICY church_application_status_history_read_own_or_platform_admin
    ON public.church_application_status_history
    FOR SELECT TO authenticated
    USING (
        public.is_super_admin()
        OR applicant_user_id = auth.uid()
    );

CREATE OR REPLACE FUNCTION public.capture_church_application_status_history()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_event_type text;
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.applicant_user_id IS NOT NULL THEN
            INSERT INTO public.church_application_status_history (
                church_id, applicant_user_id, actor_user_id, event_type,
                previous_status, new_status, previous_feedback, new_feedback
            ) VALUES (
                NEW.id, NEW.applicant_user_id, auth.uid(), 'application_submitted',
                NULL, NEW.status, NULL, NEW.admin_feedback
            );
        END IF;
        RETURN NEW;
    END IF;

    IF OLD.status IS DISTINCT FROM NEW.status
       OR OLD.admin_feedback IS DISTINCT FROM NEW.admin_feedback THEN
        v_event_type := CASE
            WHEN OLD.status = 'changes requested' AND NEW.status = 'pending'
                THEN 'resubmitted_after_changes'
            WHEN OLD.status = 'rejected' AND NEW.status = 'pending'
                THEN 'reapplied_after_rejection'
            WHEN NEW.status = 'changes requested'
                THEN 'changes_requested'
            WHEN NEW.status = 'rejected'
                THEN 'application_rejected'
            WHEN NEW.status = 'approved'
                THEN 'application_approved'
            WHEN OLD.status IS NOT DISTINCT FROM NEW.status
                THEN 'application_feedback_updated'
            ELSE 'application_status_updated'
        END;

        INSERT INTO public.church_application_status_history (
            church_id, applicant_user_id, actor_user_id, event_type,
            previous_status, new_status, previous_feedback, new_feedback
        ) VALUES (
            NEW.id, NEW.applicant_user_id, auth.uid(), v_event_type,
            OLD.status, NEW.status, OLD.admin_feedback, NEW.admin_feedback
        );
    END IF;

    RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.capture_church_application_status_history()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_church_application_history_insert ON public.churches;
CREATE TRIGGER trg_church_application_history_insert
AFTER INSERT ON public.churches
FOR EACH ROW
EXECUTE FUNCTION public.capture_church_application_status_history();

DROP TRIGGER IF EXISTS trg_church_application_history_update ON public.churches;
CREATE TRIGGER trg_church_application_history_update
AFTER UPDATE OF status, admin_feedback ON public.churches
FOR EACH ROW
EXECUTE FUNCTION public.capture_church_application_status_history();

-- 3. Currency availability is exposed without exposing the pricing amounts.
CREATE OR REPLACE FUNCTION public.get_enabled_church_registration_currencies()
RETURNS TABLE(currency text)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT pc.currency
      FROM public.subscription_price_catalog AS pc
     WHERE pc.is_enabled IS TRUE
       AND pc.monthly_base_fee IS NOT NULL
       AND pc.monthly_additional_member_fee IS NOT NULL
     ORDER BY pc.currency;
$function$;
REVOKE ALL ON FUNCTION public.get_enabled_church_registration_currencies()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_enabled_church_registration_currencies()
    TO anon, authenticated;

-- 4. Server-side validation also blocks unsupported currencies. The public form
-- cannot bypass this trigger by calling the registration RPC directly.
CREATE OR REPLACE FUNCTION public.enforce_church_application_submission_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF NEW.applicant_user_id IS NOT NULL AND NEW.status = 'pending' THEN
        IF NEW.name IS NULL
           OR pg_catalog.length(pg_catalog.btrim(NEW.name)) < 2
           OR pg_catalog.length(pg_catalog.btrim(NEW.name)) > 150 THEN
            RAISE EXCEPTION 'Church name must contain 2 to 150 characters.'
                USING ERRCODE = '22023';
        END IF;

        IF NEW.country_code IS NOT NULL THEN
            IF NULLIF(pg_catalog.btrim(COALESCE(NEW.location, '')), '') IS NULL
               OR pg_catalog.length(pg_catalog.btrim(COALESCE(NEW.location, ''))) > 160
               OR NULLIF(pg_catalog.btrim(COALESCE(NEW.address, '')), '') IS NULL
               OR pg_catalog.length(pg_catalog.btrim(COALESCE(NEW.address, ''))) > 300 THEN
                RAISE EXCEPTION 'Church city/location (max 160 characters) and physical address (max 300 characters) are required.'
                    USING ERRCODE = '22023';
            END IF;

            IF NEW.country_code !~ '^[A-Z]{2}$' THEN
                RAISE EXCEPTION 'A valid two-letter country code is required.'
                    USING ERRCODE = '22023';
            END IF;
        END IF;

        IF NEW.logo_url IS NOT NULL
           AND (pg_catalog.length(NEW.logo_url) > 1200 OR NEW.logo_url !~* '^https://') THEN
            RAISE EXCEPTION 'Church logo URL must be HTTPS and no longer than 1200 characters.'
                USING ERRCODE = '22023';
        END IF;

        IF NOT EXISTS (
            SELECT 1
              FROM public.subscription_price_catalog AS pc
             WHERE pc.currency = NEW.billing_currency
               AND pc.is_enabled IS TRUE
               AND pc.monthly_base_fee IS NOT NULL
               AND pc.monthly_additional_member_fee IS NOT NULL
        ) THEN
            RAISE EXCEPTION
                'Online church registration is not available for currency %. Approved subscription pricing has not been configured yet.',
                COALESCE(NEW.billing_currency, '(not selected)')
                USING ERRCODE = '55000';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;
REVOKE ALL ON FUNCTION public.enforce_church_application_submission_rules()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS trg_enforce_church_application_submission_rules ON public.churches;
CREATE TRIGGER trg_enforce_church_application_submission_rules
BEFORE INSERT OR UPDATE OF name, location, address, logo_url, country_code, billing_currency, status
ON public.churches
FOR EACH ROW
EXECUTE FUNCTION public.enforce_church_application_submission_rules();

-- 5. Applicant-only read RPC for pre-filling the edit/resubmit form.
CREATE OR REPLACE FUNCTION public.get_my_church_registration_details()
RETURNS TABLE (
    church_id uuid,
    church_name text,
    church_location text,
    church_address text,
    church_logo_url text,
    country_code text,
    billing_currency text,
    application_status text,
    admin_feedback text,
    join_code text,
    admin_position text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_user_id uuid := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.' USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        c.id,
        c.name,
        c.location,
        c.address,
        c.logo_url,
        c.country_code,
        c.billing_currency,
        c.status,
        c.admin_feedback,
        c.join_code,
        p.position
    FROM public.churches AS c
    JOIN public.profiles AS p
      ON p.id = v_user_id
     AND p.church_id = c.id
    WHERE c.applicant_user_id = v_user_id
      AND p.status = 'active'
      AND COALESCE(p.is_blocked, false) = false
    ORDER BY c.last_submitted_at DESC, c.created_at DESC
    LIMIT 1;
END;
$function$;
REVOKE ALL ON FUNCTION public.get_my_church_registration_details()
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_my_church_registration_details()
    TO authenticated;

-- 6. Controlled same-record update for applications awaiting changes or rejected.
-- It derives the applicant/church link from auth.uid(); callers cannot choose a
-- different church ID. The original application and its status history remain.
CREATE OR REPLACE FUNCTION public.resubmit_church_application(
    p_name text,
    p_location text,
    p_address text,
    p_logo_url text,
    p_admin_position text,
    p_country_code text,
    p_billing_currency text
)
RETURNS TABLE(church_id uuid, join_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id uuid := auth.uid();
    v_profile_role text;
    v_profile_church_id uuid;
    v_profile_status text;
    v_is_blocked boolean;
    v_is_admin boolean;
    v_country_code text := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_country_code, '')));
    v_billing_currency text := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_billing_currency, '')));
    v_expected_currency text;
    v_church_status text;
    v_join_code text;
    v_name text := NULLIF(pg_catalog.btrim(COALESCE(p_name, '')), '');
    v_location text := NULLIF(pg_catalog.btrim(COALESCE(p_location, '')), '');
    v_address text := NULLIF(pg_catalog.btrim(COALESCE(p_address, '')), '');
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Please sign in before resubmitting your church application.'
            USING ERRCODE = '42501';
    END IF;

    IF v_name IS NULL OR pg_catalog.length(v_name) > 150 THEN
        RAISE EXCEPTION 'Church name is required and must not exceed 150 characters.'
            USING ERRCODE = '22023';
    END IF;
    IF v_location IS NULL OR pg_catalog.length(v_location) > 160 THEN
        RAISE EXCEPTION 'Church city/location is required and must not exceed 160 characters.'
            USING ERRCODE = '22023';
    END IF;
    IF v_address IS NULL OR pg_catalog.length(v_address) > 300 THEN
        RAISE EXCEPTION 'Church physical address is required and must not exceed 300 characters.'
            USING ERRCODE = '22023';
    END IF;
    IF v_country_code !~ '^[A-Z]{2}$' THEN
        RAISE EXCEPTION 'A valid two-letter church country code is required.'
            USING ERRCODE = '22023';
    END IF;

    v_expected_currency := CASE v_country_code
        WHEN 'UG' THEN 'UGX'
        WHEN 'KE' THEN 'KES'
        WHEN 'TZ' THEN 'TZS'
        ELSE 'USD'
    END;
    IF v_billing_currency IS DISTINCT FROM v_expected_currency THEN
        RAISE EXCEPTION 'The selected billing currency does not match the church country. Expected %.',
            v_expected_currency USING ERRCODE = '23514';
    END IF;

    IF v_billing_currency NOT IN ('UGX', 'KES', 'TZS', 'USD') THEN
        RAISE EXCEPTION 'Unsupported church billing currency.' USING ERRCODE = '22023';
    END IF;
    IF p_logo_url IS NOT NULL AND pg_catalog.btrim(p_logo_url) <> ''
       AND p_logo_url !~* '^https://' THEN
        RAISE EXCEPTION 'Church logo URL must use HTTPS.' USING ERRCODE = '22023';
    END IF;

    -- Read the linked church ID first without taking a row lock. Lock order is
    -- deliberately church -> profile, matching approve_church_application and
    -- avoiding a profile/church deadlock if review and resubmission race.
    SELECT p.church_id
      INTO v_profile_church_id
      FROM public.profiles AS p
     WHERE p.id = v_actor_id;

    IF NOT FOUND OR v_profile_church_id IS NULL THEN
        RAISE EXCEPTION 'This account is not linked to a church application.'
            USING ERRCODE = '42501';
    END IF;

    SELECT c.status, c.join_code
      INTO v_church_status, v_join_code
      FROM public.churches AS c
     WHERE c.id = v_profile_church_id
       AND c.applicant_user_id = v_actor_id
     FOR UPDATE;

    IF NOT FOUND OR v_church_status NOT IN ('changes requested', 'rejected') THEN
        RAISE EXCEPTION 'Only an application marked changes requested or rejected can be resubmitted.'
            USING ERRCODE = '55000';
    END IF;

    -- Re-read and lock the profile after the church row. Verify the relationship
    -- did not change between the initial lookup and the two locks.
    SELECT p.role, p.status,
           COALESCE(p.is_blocked, false), COALESCE(p.is_admin, false)
      INTO v_profile_role, v_profile_status, v_is_blocked, v_is_admin
      FROM public.profiles AS p
     WHERE p.id = v_actor_id
       AND p.church_id = v_profile_church_id
     FOR UPDATE;

    IF NOT FOUND
       OR v_profile_role IS DISTINCT FROM 'member'
       OR v_profile_status IS DISTINCT FROM 'active'
       OR v_is_blocked IS TRUE
       OR v_is_admin IS TRUE THEN
        RAISE EXCEPTION 'This account is not eligible to update this church application.'
            USING ERRCODE = '42501';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM public.subscription_price_catalog AS pc
         WHERE pc.currency = v_billing_currency
           AND pc.is_enabled IS TRUE
           AND pc.monthly_base_fee IS NOT NULL
           AND pc.monthly_additional_member_fee IS NOT NULL
    ) THEN
        RAISE EXCEPTION
            'Online church registration is not available for currency %. Approved subscription pricing has not been configured yet.',
            v_billing_currency USING ERRCODE = '55000';
    END IF;

    UPDATE public.churches
       SET name = v_name,
           location = v_location,
           address = v_address,
           logo_url = NULLIF(pg_catalog.btrim(COALESCE(p_logo_url, '')), ''),
           country_code = v_country_code,
           billing_currency = v_billing_currency,
           status = 'pending',
           subscription_status = 'pending_trial',
           admin_feedback = NULL,
           last_submitted_at = pg_catalog.clock_timestamp()
     WHERE id = v_profile_church_id
       AND applicant_user_id = v_actor_id;

    UPDATE public.profiles
       SET position = NULLIF(pg_catalog.btrim(COALESCE(p_admin_position, '')), '')
     WHERE id = v_actor_id;

    RETURN QUERY SELECT v_profile_church_id, v_join_code;
END;
$function$;
REVOKE ALL ON FUNCTION public.resubmit_church_application(
    text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resubmit_church_application(
    text, text, text, text, text, text, text
) TO authenticated;

-- 7. Keep the existing status RPC signature and permissions, but report the
-- latest submission/resubmission timestamp instead of the original created_at.
CREATE OR REPLACE FUNCTION public.get_my_church_application_status()
RETURNS TABLE (
    church_id uuid,
    church_name text,
    church_location text,
    church_address text,
    submitted_at timestamptz,
    application_status text,
    admin_feedback text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_user_id uuid := auth.uid();
BEGIN
    IF v_user_id IS NULL THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        c.id,
        c.name,
        c.location,
        c.address,
        c.last_submitted_at,
        c.status,
        c.admin_feedback
    FROM public.churches AS c
    INNER JOIN public.profiles AS p
        ON p.id = v_user_id
       AND p.church_id = c.id
    WHERE c.applicant_user_id = v_user_id
      AND p.status = 'active'
      AND COALESCE(p.is_blocked, false) = false
    ORDER BY c.last_submitted_at DESC, c.created_at DESC
    LIMIT 1;
END;
$function$;

COMMIT;

-- Post-apply checks (read-only):
-- 1. get_enabled_church_registration_currencies() returns UGX only at launch.
-- 2. A fresh registration in KES/TZS/USD is rejected server-side until priced.
-- 3. resubmit_church_application only updates the caller's own linked
--    changes-requested/rejected application and sends it back to pending.
-- 4. Every insert/status/feedback change is retained in
--    church_application_status_history.
-- 5. Last submitted timestamp changes on resubmission; created_at is preserved.
-- 6. All new browser RPCs are SECURITY DEFINER with search_path=''.
