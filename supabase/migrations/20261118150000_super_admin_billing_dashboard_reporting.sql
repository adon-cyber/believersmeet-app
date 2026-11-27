BEGIN;

-- ============================================================
-- BELIEVERSMEET STAGING
-- Super Admin Billing Dashboard - Read-only Reporting RPCs
--
-- No direct billing-table grants.
-- No billing-table RLS or policy changes.
-- No payment processing or subscription mutations.
-- ============================================================


-- 1. Billing summary grouped by record type, status, currency
--    and internal-test flag. Amounts are never mixed across
--    currencies.

CREATE OR REPLACE FUNCTION public.super_admin_get_billing_dashboard_summary()
RETURNS TABLE (
    record_type text,
    status text,
    currency text,
    is_internal_test boolean,
    record_count bigint,
    total_amount numeric
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Access denied: Super Admin privileges required';
    END IF;

    RETURN QUERY

    SELECT
        'subscriptions'::text,
        s.status,
        s.currency,
        s.is_internal_test,
        COUNT(*)::bigint,
        NULL::numeric
    FROM public.church_subscriptions AS s
    GROUP BY
        s.status,
        s.currency,
        s.is_internal_test

    UNION ALL

    SELECT
        'invoices'::text,
        i.status,
        i.currency,
        s.is_internal_test,
        COUNT(*)::bigint,
        SUM(i.total_amount)
    FROM public.church_invoices AS i
    INNER JOIN public.church_subscriptions AS s
        ON s.id = i.subscription_id
    GROUP BY
        i.status,
        i.currency,
        s.is_internal_test

    UNION ALL

    SELECT
        'payments'::text,
        p.status,
        p.currency,
        s.is_internal_test,
        COUNT(*)::bigint,
        SUM(p.amount)
    FROM public.church_payments AS p
    INNER JOIN public.church_invoices AS i
        ON i.id = p.invoice_id
    INNER JOIN public.church_subscriptions AS s
        ON s.id = i.subscription_id
    GROUP BY
        p.status,
        p.currency,
        s.is_internal_test

    ORDER BY 1, 2, 3, 4;
END;
$function$;


-- 2. Subscription listing.
--    Maximum 200 records per request.

CREATE OR REPLACE FUNCTION public.super_admin_list_subscription_dashboard(
    p_limit integer DEFAULT 100
)
RETURNS TABLE (
    subscription_id uuid,
    church_id uuid,
    church_name text,
    plan_name text,
    currency text,
    base_fee numeric,
    included_members integer,
    additional_member_fee numeric,
    billing_interval text,
    subscription_status text,
    trial_starts_at timestamptz,
    trial_ends_at timestamptz,
    current_period_start timestamptz,
    current_period_end timestamptz,
    next_invoice_at timestamptz,
    grace_period_days integer,
    is_internal_test boolean,
    created_at timestamptz,
    updated_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_limit integer :=
        LEAST(GREATEST(COALESCE(p_limit, 100), 1), 200);
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Access denied: Super Admin privileges required';
    END IF;

    RETURN QUERY
    SELECT
        s.id,
        s.church_id,
        c.name,
        s.plan_name,
        s.currency,
        s.base_fee,
        s.included_members,
        s.additional_member_fee,
        s.billing_interval,
        s.status,
        s.trial_starts_at,
        s.trial_ends_at,
        s.current_period_start,
        s.current_period_end,
        s.next_invoice_at,
        s.grace_period_days,
        s.is_internal_test,
        s.created_at,
        s.updated_at
    FROM public.church_subscriptions AS s
    INNER JOIN public.churches AS c
        ON c.id = s.church_id
    ORDER BY
        s.updated_at DESC,
        s.created_at DESC
    LIMIT v_limit;
END;
$function$;


-- 3. Invoice listing.
--    Includes original pricing, discount and grace snapshots.
--    Maximum 200 records per request.

CREATE OR REPLACE FUNCTION public.super_admin_list_billing_invoices(
    p_limit integer DEFAULT 50
)
RETURNS TABLE (
    invoice_id uuid,
    church_id uuid,
    church_name text,
    subscription_id uuid,
    invoice_number text,
    currency text,
    billing_interval text,
    billing_period_start timestamptz,
    billing_period_end timestamptz,
    member_count integer,
    included_members integer,
    additional_members integer,
    subtotal_amount numeric,
    discount_percentage numeric,
    discount_amount numeric,
    total_amount numeric,
    invoice_status text,
    issued_at timestamptz,
    due_at timestamptz,
    paid_at timestamptz,
    grace_period_days_snapshot integer,
    grace_expires_at timestamptz,
    is_internal_test boolean,
    created_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_limit integer :=
        LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Access denied: Super Admin privileges required';
    END IF;

    RETURN QUERY
    SELECT
        i.id,
        i.church_id,
        c.name,
        i.subscription_id,
        i.invoice_number,
        i.currency,
        i.billing_interval,
        i.billing_period_start,
        i.billing_period_end,
        i.member_count,
        i.included_members,
        i.additional_members,
        i.subtotal_amount,
        i.discount_percentage,
        i.discount_amount,
        i.total_amount,
        i.status,
        i.issued_at,
        i.due_at,
        i.paid_at,
        i.grace_period_days_snapshot,
        i.grace_expires_at,
        s.is_internal_test,
        i.created_at
    FROM public.church_invoices AS i
    INNER JOIN public.churches AS c
        ON c.id = i.church_id
    INNER JOIN public.church_subscriptions AS s
        ON s.id = i.subscription_id
    ORDER BY
        COALESCE(i.issued_at, i.created_at) DESC,
        i.created_at DESC
    LIMIT v_limit;
END;
$function$;


-- 4. Payment listing.
--    Deliberately excludes provider order IDs and transaction IDs.
--    Includes verification status and provider status.
--    Maximum 200 records per request.

CREATE OR REPLACE FUNCTION public.super_admin_list_billing_payments(
    p_limit integer DEFAULT 50
)
RETURNS TABLE (
    payment_id uuid,
    church_id uuid,
    church_name text,
    invoice_id uuid,
    invoice_number text,
    provider text,
    payment_method text,
    provider_status text,
    currency text,
    amount numeric,
    payment_status text,
    verified_at timestamptz,
    created_at timestamptz,
    updated_at timestamptz,
    is_internal_test boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_limit integer :=
        LEAST(GREATEST(COALESCE(p_limit, 50), 1), 200);
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Access denied: Super Admin privileges required';
    END IF;

    RETURN QUERY
    SELECT
        p.id,
        p.church_id,
        c.name,
        p.invoice_id,
        i.invoice_number,
        p.provider,
        p.payment_method,
        p.provider_status,
        p.currency,
        p.amount,
        p.status,
        p.verified_at,
        p.created_at,
        p.updated_at,
        s.is_internal_test
    FROM public.church_payments AS p
    INNER JOIN public.church_invoices AS i
        ON i.id = p.invoice_id
    INNER JOIN public.churches AS c
        ON c.id = p.church_id
    INNER JOIN public.church_subscriptions AS s
        ON s.id = i.subscription_id
    ORDER BY
        p.created_at DESC
    LIMIT v_limit;
END;
$function$;


-- ============================================================
-- Explicit function ownership and least-privilege execution.
-- Only authenticated users can call these functions, and every
-- function independently verifies Super Admin authorization.
-- ============================================================

ALTER FUNCTION public.super_admin_get_billing_dashboard_summary()
    OWNER TO postgres;

ALTER FUNCTION public.super_admin_list_subscription_dashboard(integer)
    OWNER TO postgres;

ALTER FUNCTION public.super_admin_list_billing_invoices(integer)
    OWNER TO postgres;

ALTER FUNCTION public.super_admin_list_billing_payments(integer)
    OWNER TO postgres;


REVOKE ALL ON FUNCTION
    public.super_admin_get_billing_dashboard_summary()
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
    public.super_admin_list_subscription_dashboard(integer)
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
    public.super_admin_list_billing_invoices(integer)
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
    public.super_admin_list_billing_payments(integer)
    FROM PUBLIC, anon, authenticated, service_role;


GRANT EXECUTE ON FUNCTION
    public.super_admin_get_billing_dashboard_summary()
    TO authenticated;

GRANT EXECUTE ON FUNCTION
    public.super_admin_list_subscription_dashboard(integer)
    TO authenticated;

GRANT EXECUTE ON FUNCTION
    public.super_admin_list_billing_invoices(integer)
    TO authenticated;

GRANT EXECUTE ON FUNCTION
    public.super_admin_list_billing_payments(integer)
    TO authenticated;


COMMIT;