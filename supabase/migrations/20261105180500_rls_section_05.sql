-- ============================================================
-- BELIEVERSMEET STAGING RLS - SECTION 05
-- Public church directory and church-specific giving
--
-- REVIEW ONLY. DO NOT EXECUTE ON HOSTED SUPABASE YET.
--
-- Dependencies:
--   Foundation Revision 6 (reviewed V4 ordering correction)
--   RLS Section 01
--
-- Design:
--   1. Public church directory remains read-only.
--   2. One giving settings record per church.
--   3. Public visitors only see published instructions
--      belonging to approved churches.
--   4. Underlying giving settings table has no API grants.
--   5. Authenticated managers use restricted RPCs.
--   6. No Pesapal consumer credentials are stored here.
-- ============================================================

BEGIN;
-- ------------------------------------------------------------
-- 1. PREFLIGHT
-- ------------------------------------------------------------

DO $preflight$
BEGIN
    IF to_regclass('public.churches') IS NULL
       OR to_regclass('public.profiles') IS NULL
       OR to_regclass('public.church_directory') IS NULL
       OR to_regclass('private.platform_admins') IS NULL
       OR to_regprocedure('public.is_super_admin()') IS NULL THEN

        RAISE EXCEPTION
            'Section 05 preflight failed: required Foundation objects are missing.';
    END IF;

    IF to_regclass('public.church_giving_settings') IS NOT NULL
       OR to_regclass('public.church_giving_directory') IS NOT NULL
       OR to_regprocedure('public.get_church_giving_settings(uuid)') IS NOT NULL
       OR to_regprocedure(
            'public.save_church_giving_settings(uuid,text,text,text,text,text,text,text,text,boolean)'
          ) IS NOT NULL THEN

        RAISE EXCEPTION
            'Section 05 preflight failed: one or more Section 05 objects already exist. Review before replacement.';
    END IF;
END;
$preflight$;
-- ------------------------------------------------------------
-- 2. PUBLIC CHURCH DIRECTORY ACCESS
-- ------------------------------------------------------------

-- The existing view exposes an explicit public projection.
-- It must not provide direct access to the underlying churches table.

ALTER VIEW public.church_directory OWNER TO postgres;
REVOKE ALL PRIVILEGES ON TABLE public.church_directory
    FROM PUBLIC, anon, authenticated, service_role;
GRANT USAGE ON SCHEMA public TO anon, authenticated;
GRANT SELECT ON TABLE public.church_directory
    TO anon, authenticated;
-- ------------------------------------------------------------
-- 3. CHURCH-SPECIFIC GIVING SETTINGS
-- ------------------------------------------------------------

CREATE TABLE public.church_giving_settings (
    church_id uuid PRIMARY KEY
        REFERENCES public.churches(id) ON DELETE CASCADE,

    bank_name text,
    account_name text,
    account_number text,
    branch text,

    momo_name text,
    momo_number text,

    airtel_name text,
    airtel_number text,

    is_published boolean NOT NULL DEFAULT false,

    created_at timestamp with time zone NOT NULL DEFAULT now(),
    updated_at timestamp with time zone NOT NULL DEFAULT now(),

    CONSTRAINT church_giving_bank_name_length
        CHECK (bank_name IS NULL OR char_length(bank_name) <= 150),

    CONSTRAINT church_giving_account_name_length
        CHECK (account_name IS NULL OR char_length(account_name) <= 150),

    CONSTRAINT church_giving_account_number_length
        CHECK (account_number IS NULL OR char_length(account_number) <= 100),

    CONSTRAINT church_giving_branch_length
        CHECK (branch IS NULL OR char_length(branch) <= 150),

    CONSTRAINT church_giving_momo_name_length
        CHECK (momo_name IS NULL OR char_length(momo_name) <= 150),

    CONSTRAINT church_giving_momo_number_length
        CHECK (momo_number IS NULL OR char_length(momo_number) <= 100),

    CONSTRAINT church_giving_airtel_name_length
        CHECK (airtel_name IS NULL OR char_length(airtel_name) <= 150),

    CONSTRAINT church_giving_airtel_number_length
        CHECK (airtel_number IS NULL OR char_length(airtel_number) <= 100)
);
ALTER TABLE public.church_giving_settings
    ENABLE ROW LEVEL SECURITY;
-- No direct browser/API access to the underlying settings table.
REVOKE ALL PRIVILEGES ON TABLE public.church_giving_settings
    FROM PUBLIC, anon, authenticated, service_role;
COMMENT ON TABLE public.church_giving_settings IS
    'Private church-specific manual giving instructions. Public access is through the published church_giving_directory view only.';
-- ------------------------------------------------------------
-- 4. PUBLIC READ-ONLY GIVING DIRECTORY
-- ------------------------------------------------------------

CREATE VIEW public.church_giving_directory
WITH (security_barrier = true)
AS
SELECT
    s.church_id,
    c.name AS church_name,
    s.bank_name,
    s.account_name,
    s.account_number,
    s.branch,
    s.momo_name,
    s.momo_number,
    s.airtel_name,
    s.airtel_number
FROM public.church_giving_settings AS s
INNER JOIN public.churches AS c
    ON c.id = s.church_id
WHERE c.status = 'approved'
  AND s.is_published IS TRUE;
ALTER VIEW public.church_giving_directory OWNER TO postgres;
REVOKE ALL PRIVILEGES ON TABLE public.church_giving_directory
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.church_giving_directory
    TO anon, authenticated;
COMMENT ON VIEW public.church_giving_directory IS
    'Read-only public projection of published manual giving instructions for approved churches.';
-- ------------------------------------------------------------
-- 5. PRIVATE MANAGER READ RPC
-- ------------------------------------------------------------

CREATE FUNCTION public.get_church_giving_settings(
    p_church_id uuid
)
RETURNS TABLE (
    church_id uuid,
    bank_name text,
    account_name text,
    account_number text,
    branch text,
    momo_name text,
    momo_number text,
    airtel_name text,
    airtel_number text,
    is_published boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication is required.';
    END IF;

    IF p_church_id IS NULL THEN
        RAISE EXCEPTION 'A church ID is required.';
    END IF;

    IF NOT public.is_super_admin()
       AND NOT EXISTS (
            SELECT 1
            FROM public.profiles AS p
            INNER JOIN public.churches AS c
                ON c.id = p.church_id
            WHERE p.id = auth.uid()
              AND p.church_id = p_church_id
              AND p.role IN ('church_admin', 'finance')
              AND p.status = 'active'
              AND COALESCE(p.is_blocked, false) = false
              AND c.status = 'approved'
       ) THEN

        RAISE EXCEPTION
            'You are not authorised to view these church giving settings.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.churches AS c
        WHERE c.id = p_church_id
          AND c.status = 'approved'
    ) THEN
        RAISE EXCEPTION 'The selected church is not approved.';
    END IF;

    RETURN QUERY
    SELECT
        s.church_id,
        s.bank_name,
        s.account_name,
        s.account_number,
        s.branch,
        s.momo_name,
        s.momo_number,
        s.airtel_name,
        s.airtel_number,
        s.is_published
    FROM public.church_giving_settings AS s
    WHERE s.church_id = p_church_id;
END;
$function$;
ALTER FUNCTION public.get_church_giving_settings(uuid)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_church_giving_settings(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_church_giving_settings(uuid)
    TO authenticated;
-- ------------------------------------------------------------
-- 6. AUTHORISED CHURCH GIVING UPDATE RPC
-- ------------------------------------------------------------

CREATE FUNCTION public.save_church_giving_settings(
    p_church_id uuid,
    p_bank_name text,
    p_account_name text,
    p_account_number text,
    p_branch text,
    p_momo_name text,
    p_momo_number text,
    p_airtel_name text,
    p_airtel_number text,
    p_is_published boolean
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_bank_name text;
    v_account_name text;
    v_account_number text;
    v_branch text;
    v_momo_name text;
    v_momo_number text;
    v_airtel_name text;
    v_airtel_number text;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication is required.';
    END IF;

    IF p_church_id IS NULL THEN
        RAISE EXCEPTION 'A church ID is required.';
    END IF;

    IF p_is_published IS NULL THEN
        RAISE EXCEPTION 'Publication status is required.';
    END IF;

    IF NOT public.is_super_admin()
       AND NOT EXISTS (
            SELECT 1
            FROM public.profiles AS p
            INNER JOIN public.churches AS c
                ON c.id = p.church_id
            WHERE p.id = auth.uid()
              AND p.church_id = p_church_id
              AND p.role IN ('church_admin', 'finance')
              AND p.status = 'active'
              AND COALESCE(p.is_blocked, false) = false
              AND c.status = 'approved'
       ) THEN

        RAISE EXCEPTION
            'You are not authorised to manage giving details for this church.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.churches AS c
        WHERE c.id = p_church_id
          AND c.status = 'approved'
    ) THEN
        RAISE EXCEPTION 'The selected church is not approved.';
    END IF;

    v_bank_name := NULLIF(pg_catalog.btrim(p_bank_name), '');
    v_account_name := NULLIF(pg_catalog.btrim(p_account_name), '');
    v_account_number := NULLIF(pg_catalog.btrim(p_account_number), '');
    v_branch := NULLIF(pg_catalog.btrim(p_branch), '');
    v_momo_name := NULLIF(pg_catalog.btrim(p_momo_name), '');
    v_momo_number := NULLIF(pg_catalog.btrim(p_momo_number), '');
    v_airtel_name := NULLIF(pg_catalog.btrim(p_airtel_name), '');
    v_airtel_number := NULLIF(pg_catalog.btrim(p_airtel_number), '');

    -- Published instructions must contain at least one complete method.
    IF p_is_published IS TRUE
       AND NOT (
            (
                v_bank_name IS NOT NULL
                AND v_account_name IS NOT NULL
                AND v_account_number IS NOT NULL
            )
            OR (
                v_momo_name IS NOT NULL
                AND v_momo_number IS NOT NULL
            )
            OR (
                v_airtel_name IS NOT NULL
                AND v_airtel_number IS NOT NULL
            )
       ) THEN

        RAISE EXCEPTION
            'Add at least one complete bank or mobile-money payment method before publishing.';
    END IF;

    INSERT INTO public.church_giving_settings (
        church_id,
        bank_name,
        account_name,
        account_number,
        branch,
        momo_name,
        momo_number,
        airtel_name,
        airtel_number,
        is_published,
        updated_at
    )
    VALUES (
        p_church_id,
        v_bank_name,
        v_account_name,
        v_account_number,
        v_branch,
        v_momo_name,
        v_momo_number,
        v_airtel_name,
        v_airtel_number,
        p_is_published,
        pg_catalog.now()
    )
    ON CONFLICT (church_id)
    DO UPDATE SET
        bank_name = EXCLUDED.bank_name,
        account_name = EXCLUDED.account_name,
        account_number = EXCLUDED.account_number,
        branch = EXCLUDED.branch,
        momo_name = EXCLUDED.momo_name,
        momo_number = EXCLUDED.momo_number,
        airtel_name = EXCLUDED.airtel_name,
        airtel_number = EXCLUDED.airtel_number,
        is_published = EXCLUDED.is_published,
        updated_at = pg_catalog.now();
END;
$function$;
ALTER FUNCTION public.save_church_giving_settings(
    uuid, text, text, text, text, text, text, text, text, boolean
) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.save_church_giving_settings(
    uuid, text, text, text, text, text, text, text, text, boolean
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.save_church_giving_settings(
    uuid, text, text, text, text, text, text, text, text, boolean
) TO authenticated;
-- ------------------------------------------------------------
-- 7. END OF SECTION 05
-- ------------------------------------------------------------

COMMIT;
