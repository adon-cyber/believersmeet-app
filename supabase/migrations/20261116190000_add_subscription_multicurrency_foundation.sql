-- BelieversMeet Staging — Subscription Multi-Currency Foundation
-- Permanent migration. Apply to BelieversMeet-Staging only after review.
-- This migration is the schema and RPC foundation; it does not implement
-- invoice generation, subscription Pesapal checkout/IPN, renewals, or UI guards.
--
-- Supported launch currencies: UGX, KES, TZS, USD.
-- UGX is priced initially at 30,000 monthly + 150 per additional member.
-- KES, TZS and USD remain configured but disabled until prices are approved.
-- Existing church country is NOT guessed. Existing subscription currency is
-- copied to churches.billing_currency; unmatched legacy rows default to UGX.
-- Existing He Reigns subscription values/status/dates are not modified.
--
-- This migration does not generate invoices or implement Pesapal billing.
-- It adds a 7-argument registration RPC while retaining the existing
-- 5-argument RPC as a backward-compatible UGX wrapper. The frontend must be
-- updated to send all seven parameters before non-UGX applications are used.
-- The legacy wrapper intentionally leaves country_code NULL rather than guessing.
--
-- Amounts are stored as NUMERIC(18,2). UGX amounts are constrained to whole
-- shillings. Invoice base_fee/additional_member_fee are period snapshots:
-- for annual invoices the future invoice generator must snapshot 12 months
-- of the monthly fees before applying the 20% annual discount.

BEGIN;

-- ---------------------------------------------------------------------
-- 1. Church country and billing currency.
-- ---------------------------------------------------------------------

ALTER TABLE public.churches
    ADD COLUMN IF NOT EXISTS country_code text,
    ADD COLUMN IF NOT EXISTS billing_currency text;

-- Preserve the existing subscription currency where a subscription exists.
UPDATE public.churches AS c
   SET billing_currency = s.currency
  FROM public.church_subscriptions AS s
 WHERE s.church_id = c.id
   AND c.billing_currency IS NULL;

-- Legacy rows without a subscription currency retain the historical UGX
-- default. Country is deliberately left NULL; it must be collected/verified.
UPDATE public.churches
   SET billing_currency = 'UGX'
 WHERE billing_currency IS NULL;

ALTER TABLE public.churches
    ALTER COLUMN billing_currency SET DEFAULT 'UGX',
    ALTER COLUMN billing_currency SET NOT NULL;

ALTER TABLE public.churches
    DROP CONSTRAINT IF EXISTS churches_country_code_format_check,
    DROP CONSTRAINT IF EXISTS churches_billing_currency_check;

ALTER TABLE public.churches
    ADD CONSTRAINT churches_country_code_format_check
        CHECK (country_code IS NULL OR country_code ~ '^[A-Z]{2}$'),
    ADD CONSTRAINT churches_billing_currency_check
        CHECK (billing_currency IN ('UGX', 'KES', 'TZS', 'USD'));

-- ---------------------------------------------------------------------
-- 2. Currency-specific monthly pricing catalogue.
-- KES/TZS/USD deliberately remain disabled and unpriced.
-- ---------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.subscription_price_catalog (
    currency text PRIMARY KEY,
    monthly_base_fee numeric(18,2),
    monthly_additional_member_fee numeric(18,2),
    is_enabled boolean NOT NULL DEFAULT false,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT subscription_price_catalog_currency_check
        CHECK (currency IN ('UGX', 'KES', 'TZS', 'USD')),
    CONSTRAINT subscription_price_catalog_base_fee_check
        CHECK (monthly_base_fee IS NULL OR monthly_base_fee > 0),
    CONSTRAINT subscription_price_catalog_additional_fee_check
        CHECK (monthly_additional_member_fee IS NULL OR monthly_additional_member_fee >= 0),
    CONSTRAINT subscription_price_catalog_enabled_prices_check
        CHECK (
            NOT is_enabled
            OR (
                monthly_base_fee IS NOT NULL
                AND monthly_additional_member_fee IS NOT NULL
            )
        ),
    CONSTRAINT subscription_price_catalog_ugx_whole_amounts_check
        CHECK (
            currency <> 'UGX'
            OR (
                (monthly_base_fee IS NULL OR monthly_base_fee = trunc(monthly_base_fee))
                AND (monthly_additional_member_fee IS NULL
                     OR monthly_additional_member_fee = trunc(monthly_additional_member_fee))
            )
        )
);

ALTER TABLE public.subscription_price_catalog ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.subscription_price_catalog
    FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON TABLE public.subscription_price_catalog TO service_role;

INSERT INTO public.subscription_price_catalog (
    currency, monthly_base_fee, monthly_additional_member_fee, is_enabled
)
VALUES
    ('UGX', 30000, 150, true),
    ('KES', NULL, NULL, false),
    ('TZS', NULL, NULL, false),
    ('USD', NULL, NULL, false)
ON CONFLICT (currency) DO NOTHING;

COMMENT ON TABLE public.subscription_price_catalog IS
    'Approved monthly subscription prices by billing currency. Annual billing snapshots twelve monthly periods then applies the 20% annual discount.';
COMMENT ON COLUMN public.subscription_price_catalog.is_enabled IS
    'Only enabled currencies with configured prices may be used for new church approvals.';

-- ---------------------------------------------------------------------
-- 3. Decimal-capable amounts and supported-currency constraints.
-- ---------------------------------------------------------------------

-- Drop existing monetary checks before changing column types. PostgreSQL
-- recommends removing dependent checks first, then recreating them after
-- the type conversion.
ALTER TABLE public.church_subscriptions
    DROP CONSTRAINT IF EXISTS church_subscriptions_base_fee_check,
    DROP CONSTRAINT IF EXISTS church_subscriptions_additional_member_fee_check,
    DROP CONSTRAINT IF EXISTS church_subscriptions_currency_check,
    DROP CONSTRAINT IF EXISTS church_subscriptions_ugx_whole_amounts_check;

ALTER TABLE public.church_subscriptions
    ALTER COLUMN base_fee TYPE numeric(18,2) USING base_fee::numeric(18,2),
    ALTER COLUMN additional_member_fee TYPE numeric(18,2)
        USING additional_member_fee::numeric(18,2);

ALTER TABLE public.church_subscriptions
    ADD CONSTRAINT church_subscriptions_base_fee_check
        CHECK (base_fee >= 0),
    ADD CONSTRAINT church_subscriptions_additional_member_fee_check
        CHECK (additional_member_fee >= 0),
    ADD CONSTRAINT church_subscriptions_currency_check
        CHECK (currency IN ('UGX', 'KES', 'TZS', 'USD')),
    ADD CONSTRAINT church_subscriptions_ugx_whole_amounts_check
        CHECK (
            currency <> 'UGX'
            OR (
                base_fee = trunc(base_fee)
                AND additional_member_fee = trunc(additional_member_fee)
            )
        );

ALTER TABLE public.church_invoices
    DROP CONSTRAINT IF EXISTS church_invoices_base_fee_check,
    DROP CONSTRAINT IF EXISTS church_invoices_additional_member_fee_check,
    DROP CONSTRAINT IF EXISTS church_invoices_additional_members_amount_check,
    DROP CONSTRAINT IF EXISTS church_invoices_discount_amount_check,
    DROP CONSTRAINT IF EXISTS church_invoices_subtotal_amount_check,
    DROP CONSTRAINT IF EXISTS church_invoices_total_amount_check,
    DROP CONSTRAINT IF EXISTS church_invoices_currency_check,
    DROP CONSTRAINT IF EXISTS church_invoice_pricing_calculation_check,
    DROP CONSTRAINT IF EXISTS church_invoices_ugx_whole_amounts_check;

ALTER TABLE public.church_invoices
    ALTER COLUMN base_fee TYPE numeric(18,2) USING base_fee::numeric(18,2),
    ALTER COLUMN additional_member_fee TYPE numeric(18,2)
        USING additional_member_fee::numeric(18,2),
    ALTER COLUMN additional_members_amount TYPE numeric(18,2)
        USING additional_members_amount::numeric(18,2),
    ALTER COLUMN subtotal_amount TYPE numeric(18,2)
        USING subtotal_amount::numeric(18,2),
    ALTER COLUMN discount_amount TYPE numeric(18,2)
        USING discount_amount::numeric(18,2),
    ALTER COLUMN total_amount TYPE numeric(18,2)
        USING total_amount::numeric(18,2);

ALTER TABLE public.church_invoices
    ADD CONSTRAINT church_invoices_base_fee_check
        CHECK (base_fee >= 0),
    ADD CONSTRAINT church_invoices_additional_member_fee_check
        CHECK (additional_member_fee >= 0),
    ADD CONSTRAINT church_invoices_additional_members_amount_check
        CHECK (additional_members_amount >= 0),
    ADD CONSTRAINT church_invoices_discount_amount_check
        CHECK (discount_amount >= 0),
    ADD CONSTRAINT church_invoices_subtotal_amount_check
        CHECK (subtotal_amount >= 0),
    ADD CONSTRAINT church_invoices_total_amount_check
        CHECK (total_amount >= 0),
    ADD CONSTRAINT church_invoices_currency_check
        CHECK (currency IN ('UGX', 'KES', 'TZS', 'USD')),
    ADD CONSTRAINT church_invoice_pricing_calculation_check
        CHECK (
            additional_members = GREATEST(member_count - included_members, 0)
            AND additional_members_amount = round(additional_members * additional_member_fee, 2)
            AND subtotal_amount = round(base_fee + additional_members_amount, 2)
            AND discount_amount = CASE
                WHEN currency = 'UGX'
                    THEN round((subtotal_amount * discount_percentage) / 100.0)
                ELSE round((subtotal_amount * discount_percentage) / 100.0, 2)
            END
            AND total_amount = CASE
                WHEN currency = 'UGX'
                    THEN round(subtotal_amount - discount_amount)
                ELSE round(subtotal_amount - discount_amount, 2)
            END
        ),
    ADD CONSTRAINT church_invoices_ugx_whole_amounts_check
        CHECK (
            currency <> 'UGX'
            OR (
                base_fee = trunc(base_fee)
                AND additional_member_fee = trunc(additional_member_fee)
                AND additional_members_amount = trunc(additional_members_amount)
                AND subtotal_amount = trunc(subtotal_amount)
                AND discount_amount = trunc(discount_amount)
                AND total_amount = trunc(total_amount)
            )
        );

ALTER TABLE public.church_payments
    DROP CONSTRAINT IF EXISTS church_payments_amount_check,
    DROP CONSTRAINT IF EXISTS church_payments_currency_check,
    DROP CONSTRAINT IF EXISTS church_payments_ugx_whole_amount_check;

ALTER TABLE public.church_payments
    ALTER COLUMN amount TYPE numeric(18,2) USING amount::numeric(18,2);

ALTER TABLE public.church_payments
    ADD CONSTRAINT church_payments_amount_check
        CHECK (amount > 0),
    ADD CONSTRAINT church_payments_currency_check
        CHECK (currency IN ('UGX', 'KES', 'TZS', 'USD')),
    ADD CONSTRAINT church_payments_ugx_whole_amount_check
        CHECK (currency <> 'UGX' OR amount = trunc(amount));

-- ---------------------------------------------------------------------
-- 4. Referential integrity: invoice/subscription/payment must belong to
-- the same church and use the same currency.
-- ---------------------------------------------------------------------

DO $block$
BEGIN
    IF EXISTS (
        SELECT 1
          FROM public.church_invoices i
          JOIN public.church_subscriptions s ON s.id = i.subscription_id
         WHERE i.church_id IS DISTINCT FROM s.church_id
            OR i.currency IS DISTINCT FROM s.currency
    ) THEN
        RAISE EXCEPTION 'Existing invoice/subscription church or currency mismatch; reconcile before applying this migration.';
    END IF;

    IF EXISTS (
        SELECT 1
          FROM public.church_payments p
          JOIN public.church_invoices i ON i.id = p.invoice_id
         WHERE p.church_id IS DISTINCT FROM i.church_id
            OR p.currency IS DISTINCT FROM i.currency
    ) THEN
        RAISE EXCEPTION 'Existing payment/invoice church or currency mismatch; reconcile before applying this migration.';
    END IF;
END;
$block$;

ALTER TABLE public.church_subscriptions
    ADD CONSTRAINT church_subscriptions_id_church_currency_key
        UNIQUE (id, church_id, currency);

ALTER TABLE public.church_invoices
    DROP CONSTRAINT IF EXISTS church_invoices_subscription_id_fkey,
    ADD CONSTRAINT church_invoices_id_church_currency_key
        UNIQUE (id, church_id, currency),
    ADD CONSTRAINT church_invoices_subscription_church_currency_fkey
        FOREIGN KEY (subscription_id, church_id, currency)
        REFERENCES public.church_subscriptions (id, church_id, currency)
        ON DELETE RESTRICT;

ALTER TABLE public.church_payments
    DROP CONSTRAINT IF EXISTS church_payments_invoice_id_fkey,
    ADD CONSTRAINT church_payments_invoice_church_currency_fkey
        FOREIGN KEY (invoice_id, church_id, currency)
        REFERENCES public.church_invoices (id, church_id, currency)
        ON DELETE RESTRICT;

-- ---------------------------------------------------------------------
-- 5. Billable member count: all active, unblocked profiles count,
-- regardless of role. Keep execution owner-only for trusted billing RPCs.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_billable_member_count(p_church_id uuid)
RETURNS integer
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_count integer;
BEGIN
    IF p_church_id IS NULL THEN
        RAISE EXCEPTION 'Church ID is required';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.churches AS c WHERE c.id = p_church_id
    ) THEN
        RAISE EXCEPTION 'Church not found';
    END IF;

    SELECT COUNT(*)::integer
      INTO v_count
      FROM public.profiles AS p
     WHERE p.church_id = p_church_id
       AND p.status = 'active'
       AND COALESCE(p.is_blocked, false) = false;

    RETURN v_count;
END;
$function$;

REVOKE ALL ON FUNCTION public.get_billable_member_count(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------
-- 6. Multi-currency church application RPC.
-- The 7-argument version is used by the updated form. The existing
-- 5-argument signature remains as a backward-compatible UGX wrapper.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.submit_church_application(
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
    v_is_admin boolean;
    v_is_blocked boolean;
    v_status text;
    v_church_id uuid;
    v_join_code text;
    v_prefix text;
    v_country_code text := NULLIF(pg_catalog.upper(pg_catalog.btrim(COALESCE(p_country_code, ''))), '');
    v_billing_currency text := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_billing_currency, '')));
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Please sign in before submitting a church application.';
    END IF;

    IF p_name IS NULL OR pg_catalog.btrim(p_name) = '' THEN
        RAISE EXCEPTION 'Church name is required.';
    END IF;

    -- New registration forms must provide a country. The legacy five-argument
    -- wrapper intentionally passes NULL so existing cached clients can continue
    -- registering with UGX without inventing a country code.
    IF v_country_code IS NULL THEN
        IF v_billing_currency <> 'UGX' THEN
            RAISE EXCEPTION 'A country code is required for non-UGX registration.';
        END IF;
    ELSIF v_country_code !~ '^[A-Z]{2}$' THEN
        RAISE EXCEPTION 'A valid two-letter country code is required.';
    END IF;

    IF v_billing_currency NOT IN ('UGX', 'KES', 'TZS', 'USD') THEN
        RAISE EXCEPTION 'Unsupported billing currency. Choose UGX, KES, TZS or USD.';
    END IF;

    SELECT p.role, p.church_id, p.is_admin, p.is_blocked, p.status
      INTO v_profile_role, v_profile_church_id, v_is_admin, v_is_blocked, v_status
      FROM public.profiles AS p
     WHERE p.id = v_actor_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Your profile is not ready. Please try again after signing in.';
    END IF;

    IF v_profile_role IS DISTINCT FROM 'member'
       OR COALESCE(v_is_admin, false)
       OR COALESCE(v_is_blocked, false)
       OR v_status IS DISTINCT FROM 'active'
       OR v_profile_church_id IS NOT NULL THEN
        RAISE EXCEPTION 'This account is not eligible to submit a new church application.';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.churches AS c
         WHERE c.applicant_user_id = v_actor_id
           AND c.status IN ('pending', 'changes requested', 'approved')
    ) THEN
        RAISE EXCEPTION 'You already have a pending or approved church application.';
    END IF;

    v_prefix := pg_catalog.upper(
        pg_catalog.substr(
            pg_catalog.regexp_replace(p_name, '[^a-zA-Z0-9]', '', 'g'), 1, 4
        )
    );
    IF v_prefix = '' THEN
        v_prefix := 'CHUR';
    END IF;

    LOOP
        v_join_code := v_prefix || pg_catalog.upper(
            pg_catalog.substr(
                pg_catalog.md5(
                    pg_catalog.random()::text || pg_catalog.clock_timestamp()::text
                ), 1, 6
            )
        );
        EXIT WHEN NOT EXISTS (
            SELECT 1 FROM public.churches AS c WHERE c.join_code = v_join_code
        );
    END LOOP;

    INSERT INTO public.churches (
        name, location, address, join_code, applicant_user_id,
        subscription_status, trial_ends_at, logo_url, status,
        country_code, billing_currency
    )
    VALUES (
        pg_catalog.btrim(p_name),
        NULLIF(pg_catalog.btrim(COALESCE(p_location, '')), ''),
        NULLIF(pg_catalog.btrim(COALESCE(p_address, '')), ''),
        v_join_code,
        v_actor_id,
        'pending_trial',
        NULL,
        NULLIF(pg_catalog.btrim(COALESCE(p_logo_url, '')), ''),
        'pending',
        v_country_code,
        v_billing_currency
    )
    RETURNING id INTO v_church_id;

    INSERT INTO private.profile_church_link_authorizations (
        backend_pid, transaction_id, actor_id, target_profile_id, church_id
    )
    VALUES (
        pg_catalog.pg_backend_pid(),
        pg_catalog.txid_current(),
        v_actor_id,
        v_actor_id,
        v_church_id
    );

    UPDATE public.profiles
       SET church_id = v_church_id,
           position = NULLIF(pg_catalog.btrim(COALESCE(p_admin_position, '')), '')
     WHERE id = v_actor_id;

    RETURN QUERY SELECT v_church_id, v_join_code;
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_church_application(
    text, text, text, text, text, text, text
) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_church_application(
    text, text, text, text, text, text, text
) TO authenticated;

-- Preserve the previous RPC signature for already-cached clients. Legacy
-- callers submit UGX and leave country_code unknown rather than guessing.
CREATE OR REPLACE FUNCTION public.submit_church_application(
    p_name text,
    p_location text DEFAULT NULL::text,
    p_address text DEFAULT NULL::text,
    p_logo_url text DEFAULT NULL::text,
    p_admin_position text DEFAULT NULL::text
)
RETURNS TABLE(church_id uuid, join_code text)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    RETURN QUERY
    SELECT * FROM public.submit_church_application(
        p_name,
        p_location,
        p_address,
        p_logo_url,
        p_admin_position,
        NULL,
        'UGX'
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.submit_church_application(text, text, text, text, text)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.submit_church_application(text, text, text, text, text)
    TO authenticated;

-- ---------------------------------------------------------------------
-- 7. Church approval uses the selected currency's enabled price catalogue.
-- Retains live validation, Super Admin check, role assignment, 60-day trial,
-- 100 included profiles, 7-day grace, and is_internal_test=false.
-- ---------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.approve_church_application(p_church_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_status text;
    v_applicant_id uuid;
    v_applicant_church_id uuid;
    v_applicant_role text;
    v_applicant_status text;
    v_applicant_is_blocked boolean;
    v_trial_start timestamptz;
    v_trial_end timestamptz;
    v_billing_currency text;
    v_base_fee numeric(18,2);
    v_additional_member_fee numeric(18,2);
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION 'Unauthorized: Super Admin required.';
    END IF;

    SELECT c.status, c.applicant_user_id, c.billing_currency
      INTO v_status, v_applicant_id, v_billing_currency
      FROM public.churches AS c
     WHERE c.id = p_church_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Church registration request not found.';
    END IF;

    IF v_status IS NULL OR v_status NOT IN ('pending', 'changes requested') THEN
        RAISE EXCEPTION 'This church registration is not awaiting review.';
    END IF;

    IF v_applicant_id IS NULL THEN
        RAISE EXCEPTION 'This record has no registration applicant.';
    END IF;

    SELECT p.church_id, p.role, p.status, COALESCE(p.is_blocked, false)
      INTO v_applicant_church_id, v_applicant_role, v_applicant_status, v_applicant_is_blocked
      FROM public.profiles AS p
     WHERE p.id = v_applicant_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Registration applicant profile not found.';
    END IF;

    IF v_applicant_church_id IS DISTINCT FROM p_church_id THEN
        RAISE EXCEPTION 'The applicant is not linked to this church.';
    END IF;

    IF v_applicant_role IS DISTINCT FROM 'member' THEN
        RAISE EXCEPTION 'The registration applicant must have the member role before approval.';
    END IF;

    IF v_applicant_status IS DISTINCT FROM 'active'
       OR v_applicant_is_blocked IS DISTINCT FROM false THEN
        RAISE EXCEPTION 'The registration applicant must have an active, unblocked account.';
    END IF;

    SELECT pc.monthly_base_fee, pc.monthly_additional_member_fee
      INTO v_base_fee, v_additional_member_fee
      FROM public.subscription_price_catalog AS pc
     WHERE pc.currency = v_billing_currency
       AND pc.is_enabled = true;

    IF NOT FOUND THEN
        RAISE EXCEPTION
            'Subscription pricing is not configured for currency %. Configure an approved price before approving this church.',
            COALESCE(v_billing_currency, '(not selected)');
    END IF;

    PERFORM public.assign_profile_role(v_applicant_id, 'church_admin');

    v_trial_start := pg_catalog.clock_timestamp();
    v_trial_end := v_trial_start + INTERVAL '60 days';

    UPDATE public.churches
       SET status = 'approved',
           subscription_status = 'trial',
           trial_ends_at = v_trial_end,
           admin_feedback = NULL
     WHERE id = p_church_id;

    INSERT INTO public.church_subscriptions (
        church_id, plan_name, currency, base_fee, included_members,
        additional_member_fee, billing_interval, status, trial_starts_at,
        trial_ends_at, next_invoice_at, grace_period_days, is_internal_test
    )
    VALUES (
        p_church_id, 'standard', v_billing_currency, v_base_fee, 100,
        v_additional_member_fee, 'monthly', 'trial', v_trial_start,
        v_trial_end, v_trial_end, 7, false
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.approve_church_application(uuid)
    FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.approve_church_application(uuid)
    TO authenticated;

-- ---------------------------------------------------------------------
-- 8. Least-privilege server-side billing table access.
-- ---------------------------------------------------------------------

REVOKE ALL ON TABLE
    public.church_subscriptions,
    public.church_invoices,
    public.church_payments
FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT, INSERT, UPDATE ON TABLE
    public.church_subscriptions,
    public.church_invoices,
    public.church_payments
TO service_role;

-- Commit the reviewed subscription foundation changes.
COMMIT;

-- ---------------------------------------------------------------------
-- Post-apply verification checklist (run separately after approval):
-- 1. Price catalogue: UGX enabled at 30000/150; KES/TZS/USD disabled/unpriced.
-- 2. He Reigns subscription values, dates, currency and status unchanged.
-- 3. He Reigns get_billable_member_count() returns 2.
-- 4. New 7-argument registration RPC accepts country and currency.
-- 5. Legacy 5-argument registration RPC still routes to UGX.
-- 6. Approval rejects any currency without an enabled configured price.
-- 7. Billing FK constraints enforce same church and currency links.
-- 8. anon/authenticated have no direct billing table privileges.
-- 9. service_role has SELECT/INSERT/UPDATE but no DELETE on billing tables.
-- 10. Old function grants and Super Admin role checks remain correct.
