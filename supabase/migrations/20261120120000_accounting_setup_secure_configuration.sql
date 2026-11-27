-- BelieversMeet Accounting & Budgeting
-- Migration 003: Initial church setup and secure accounting configuration
-- Revised v4 draft. Apply only after reviewed Migrations 001 and 002 are installed
-- on BelieversMeet-Staging and their post-install checks have passed.
--
-- Creates a one-time initialization workflow, a starter chart of accounts,
-- one default unrestricted fund, monthly periods for the current fiscal year,
-- church-scoped configuration RPCs, read-only RLS access, and an audit log.
-- It does not create ledger journals, expenses, budgets, or payment integrations.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- ---------------------------------------------------------------------------
-- 0. Fail-closed preflight
-- ---------------------------------------------------------------------------
DO $preflight$
BEGIN
    IF current_user <> 'postgres' THEN
        RAISE EXCEPTION 'Preflight failed: execute this migration as postgres';
    END IF;

    IF pg_catalog.to_regclass('public.accounting_settings') IS NULL
       OR pg_catalog.to_regclass('public.accounting_periods') IS NULL
       OR pg_catalog.to_regclass('public.accounting_departments') IS NULL
       OR pg_catalog.to_regclass('public.accounting_funds') IS NULL
       OR pg_catalog.to_regclass('public.accounting_accounts') IS NULL
       OR pg_catalog.to_regclass('public.church_financial_roles') IS NULL
       OR pg_catalog.to_regclass('public.church_financial_role_permissions') IS NULL
       OR pg_catalog.to_regclass('public.church_financial_user_roles') IS NULL
       OR pg_catalog.to_regclass('public.church_financial_role_audit') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: Migrations 001 and 002 must be installed first';
    END IF;

    IF pg_catalog.to_regprocedure('public.has_church_financial_permission(uuid,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.can_manage_church_financial_roles(uuid)') IS NULL
       OR pg_catalog.to_regprocedure('public.assign_church_financial_role(uuid,uuid,text,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.revoke_church_financial_role(uuid,text)') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: required financial permission functions are missing';
    END IF;

    IF pg_catalog.to_regclass('public.accounting_audit_log') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: public.accounting_audit_log already exists';
    END IF;

    IF pg_catalog.to_regprocedure('public.accounting_prevent_audit_mutation()') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.assert_church_accounting_permission(uuid,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.initialize_church_accounting(uuid,text,text,smallint)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.create_next_church_accounting_fiscal_year(uuid)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.update_church_accounting_settings(uuid,text,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.create_accounting_department(uuid,text,text,text,uuid)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.create_accounting_fund(uuid,text,text,text,text,text,text,date)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.create_accounting_account(uuid,text,text,text,text,uuid,text,boolean)') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: one or more Migration 003 functions already exist';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'accounting_settings'
          AND column_name IN ('setup_completed_at', 'setup_completed_by')
    ) THEN
        RAISE EXCEPTION 'Preflight failed: setup completion columns already exist';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.church_financial_role_permissions rp
        JOIN public.church_financial_roles r ON r.id = rp.role_id
        WHERE r.role_code = 'finance_administrator'
          AND rp.permission_key = 'accounting.settings.manage'
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.church_financial_role_permissions rp
        JOIN public.church_financial_roles r ON r.id = rp.role_id
        WHERE r.role_code = 'finance_administrator'
          AND rp.permission_key = 'accounting.periods.manage'
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.church_financial_role_permissions rp
        JOIN public.church_financial_roles r ON r.id = rp.role_id
        WHERE r.role_code = 'finance_administrator'
          AND rp.permission_key = 'accounting.departments.manage'
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.church_financial_role_permissions rp
        JOIN public.church_financial_roles r ON r.id = rp.role_id
        WHERE r.role_code = 'finance_administrator'
          AND rp.permission_key = 'accounting.funds.manage'
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.church_financial_role_permissions rp
        JOIN public.church_financial_roles r ON r.id = rp.role_id
        WHERE r.role_code = 'finance_administrator'
          AND rp.permission_key = 'accounting.accounts.manage'
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.church_financial_role_permissions rp
        JOIN public.church_financial_roles r ON r.id = rp.role_id
        WHERE r.role_code = 'finance_administrator'
          AND rp.permission_key = 'accounting.settings.read'
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.church_financial_role_permissions rp
        JOIN public.church_financial_roles r ON r.id = rp.role_id
        WHERE r.role_code = 'finance_administrator'
          AND rp.permission_key = 'accounting.periods.read'
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.church_financial_role_permissions rp
        JOIN public.church_financial_roles r ON r.id = rp.role_id
        WHERE r.role_code = 'finance_administrator'
          AND rp.permission_key = 'accounting.departments.read'
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.church_financial_role_permissions rp
        JOIN public.church_financial_roles r ON r.id = rp.role_id
        WHERE r.role_code = 'finance_administrator'
          AND rp.permission_key = 'accounting.funds.read'
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.church_financial_role_permissions rp
        JOIN public.church_financial_roles r ON r.id = rp.role_id
        WHERE r.role_code = 'finance_administrator'
          AND rp.permission_key = 'accounting.accounts.read'
    ) OR NOT EXISTS (
        SELECT 1
        FROM public.church_financial_role_permissions rp
        JOIN public.church_financial_roles r ON r.id = rp.role_id
        WHERE r.role_code = 'finance_administrator'
          AND rp.permission_key = 'accounting.audit.read'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: Finance Administrator configuration permissions are incomplete';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_policies
        WHERE schemaname = 'public'
          AND policyname IN (
              'accounting_settings_financial_read',
              'accounting_periods_financial_read',
              'accounting_departments_financial_read',
              'accounting_funds_financial_read',
              'accounting_accounts_financial_read',
              'accounting_audit_log_financial_read'
          )
    ) THEN
        RAISE EXCEPTION 'Preflight failed: one or more Migration 003 RLS policy names are already in use';
    END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. Track completion of one-time church accounting initialization
-- ---------------------------------------------------------------------------
ALTER TABLE public.accounting_settings
    ADD COLUMN setup_completed_at TIMESTAMPTZ,
    ADD COLUMN setup_completed_by UUID;

ALTER TABLE public.accounting_settings
    ADD CONSTRAINT accounting_settings_setup_completed_by_fk
        FOREIGN KEY (setup_completed_by)
        REFERENCES auth.users (id)
        ON DELETE SET NULL,
    ADD CONSTRAINT accounting_settings_setup_state_chk
        CHECK (setup_completed_at IS NOT NULL OR setup_completed_by IS NULL);

-- ---------------------------------------------------------------------------
-- 2. Append-only configuration/setup audit log
-- ---------------------------------------------------------------------------
CREATE TABLE public.accounting_audit_log (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    actor_user_id UUID,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id UUID,
    description TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),

    CONSTRAINT accounting_audit_log_church_fk
        FOREIGN KEY (church_id)
        REFERENCES public.churches (id)
        ON DELETE RESTRICT,
    -- actor_user_id intentionally has no auth.users FK. This immutable audit
    -- reference must survive account deletion without an FK-driven UPDATE
    -- that would conflict with the append-only mutation trigger.
    CONSTRAINT accounting_audit_log_action_chk
        CHECK (action IN (
            'initialized',
            'settings_updated',
            'department_created',
            'fund_created',
            'account_created',
            'fiscal_year_created'
        )),
    CONSTRAINT accounting_audit_log_entity_chk
        CHECK (entity_type IN (
            'church_setup',
            'accounting_settings',
            'department',
            'fund',
            'account',
            'accounting_period'
        )),
    CONSTRAINT accounting_audit_log_description_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(description)) > 0),
    CONSTRAINT accounting_audit_log_metadata_chk
        CHECK (pg_catalog.jsonb_typeof(metadata) = 'object')
);

CREATE INDEX accounting_audit_log_church_created_idx
    ON public.accounting_audit_log (church_id, created_at DESC);

CREATE INDEX accounting_audit_log_entity_idx
    ON public.accounting_audit_log (church_id, entity_type, entity_id, created_at DESC);

ALTER TABLE public.accounting_audit_log OWNER TO postgres;

-- Prevent accidental UPDATE/DELETE even from future privileged maintenance
-- code. Corrections to audit records must be represented by new audit events.
CREATE FUNCTION public.accounting_prevent_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
    RAISE EXCEPTION 'Accounting audit records are append-only';
END;
$function$;

ALTER FUNCTION public.accounting_prevent_audit_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accounting_prevent_audit_mutation()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER accounting_audit_log_append_only
    BEFORE UPDATE OR DELETE ON public.accounting_audit_log
    FOR EACH ROW
    EXECUTE FUNCTION public.accounting_prevent_audit_mutation();

-- Row-level triggers do not fire for TRUNCATE, so protect that operation
-- separately with a statement-level trigger.
CREATE TRIGGER accounting_audit_log_no_truncate
    BEFORE TRUNCATE ON public.accounting_audit_log
    FOR EACH STATEMENT
    EXECUTE FUNCTION public.accounting_prevent_audit_mutation();

-- Shared authorization guard for configuration RPCs. It is deliberately
-- internal to SECURITY DEFINER functions: callers cannot invoke it directly.
-- Lock order is per-church advisory lock first, then profile/church rows.
CREATE FUNCTION public.assert_church_accounting_permission(
    p_church_id UUID,
    p_permission_key TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id UUID := auth.uid();
BEGIN
    IF v_actor_id IS NULL OR p_church_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and church are required' USING ERRCODE = '42501';
    END IF;

    IF pg_catalog.length(pg_catalog.btrim(COALESCE(p_permission_key, ''))) = 0
       OR NOT public.has_church_financial_permission(p_church_id, p_permission_key) THEN
        RAISE EXCEPTION 'Required church financial permission is not active' USING ERRCODE = '42501';
    END IF;

    PERFORM 1
    FROM public.profiles AS p
    JOIN public.churches AS c
      ON c.id = p.church_id
    WHERE p.id = v_actor_id
      AND p.church_id = p_church_id
      AND p.status = 'active'
      AND p.is_blocked IS FALSE
      AND c.status = 'approved'
    FOR SHARE OF p, c;

    IF NOT FOUND
       OR NOT public.has_church_financial_permission(p_church_id, p_permission_key) THEN
        RAISE EXCEPTION 'Church membership or financial authorization changed during the operation' USING ERRCODE = '42501';
    END IF;
END;
$function$;

ALTER FUNCTION public.assert_church_accounting_permission(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assert_church_accounting_permission(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Read-only RLS access to setup/configuration tables
-- ---------------------------------------------------------------------------
DO $security$
DECLARE
    v_table TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'accounting_settings',
        'accounting_periods',
        'accounting_departments',
        'accounting_funds',
        'accounting_accounts',
        'accounting_audit_log'
    ] LOOP
        EXECUTE pg_catalog.format(
            'ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table
        );
        EXECUTE pg_catalog.format(
            'ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table
        );
        EXECUTE pg_catalog.format(
            'REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',
            v_table
        );
        EXECUTE pg_catalog.format(
            'GRANT SELECT ON TABLE public.%I TO authenticated', v_table
        );
    END LOOP;
END;
$security$;

CREATE POLICY accounting_settings_financial_read
    ON public.accounting_settings
    FOR SELECT TO authenticated
    USING (
        public.has_church_financial_permission(
            church_id,
            'accounting.settings.read'
        )
    );

CREATE POLICY accounting_periods_financial_read
    ON public.accounting_periods
    FOR SELECT TO authenticated
    USING (
        public.has_church_financial_permission(
            church_id,
            'accounting.periods.read'
        )
    );

CREATE POLICY accounting_departments_financial_read
    ON public.accounting_departments
    FOR SELECT TO authenticated
    USING (
        public.has_church_financial_permission(
            church_id,
            'accounting.departments.read'
        )
    );

CREATE POLICY accounting_funds_financial_read
    ON public.accounting_funds
    FOR SELECT TO authenticated
    USING (
        public.has_church_financial_permission(
            church_id,
            'accounting.funds.read'
        )
    );

CREATE POLICY accounting_accounts_financial_read
    ON public.accounting_accounts
    FOR SELECT TO authenticated
    USING (
        public.has_church_financial_permission(
            church_id,
            'accounting.accounts.read'
        )
    );

CREATE POLICY accounting_audit_log_financial_read
    ON public.accounting_audit_log
    FOR SELECT TO authenticated
    USING (
        public.has_church_financial_permission(
            church_id,
            'accounting.audit.read'
        )
    );

-- No client INSERT/UPDATE/DELETE/TRUNCATE privileges are granted on these
-- tables. All mutations are performed through reviewed SECURITY DEFINER RPCs.

-- ---------------------------------------------------------------------------
-- 4. One-time church accounting initialization
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.initialize_church_accounting(
    p_church_id UUID,
    p_functional_currency TEXT DEFAULT 'UGX',
    p_timezone_name TEXT DEFAULT 'Africa/Kampala',
    p_fiscal_year_start_month SMALLINT DEFAULT 1
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id UUID := auth.uid();
    v_currency TEXT := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_functional_currency, '')));
    v_timezone TEXT := pg_catalog.btrim(COALESCE(p_timezone_name, ''));
    v_fiscal_month SMALLINT := p_fiscal_year_start_month;
    v_local_today DATE;
    v_fiscal_year_start_year INTEGER;
    v_fiscal_year_start DATE;
    v_month_start DATE;
    v_next_month_start DATE;
    v_month_offset INTEGER;
    v_period_count INTEGER := 0;
    v_account_count INTEGER := 0;
    v_default_fund_id UUID;
    v_parent_account_id UUID;
    v_created_account_id UUID;
    v_seed RECORD;
    v_initialized_at TIMESTAMPTZ;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    IF p_church_id IS NULL THEN
        RAISE EXCEPTION 'Church is required' USING ERRCODE = '22023';
    END IF;

    IF v_currency !~ '^[A-Z]{3}$' THEN
        RAISE EXCEPTION 'Functional currency must be a three-letter uppercase currency code' USING ERRCODE = '22023';
    END IF;

    IF v_timezone = ''
       OR NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_timezone_names tz
            WHERE tz.name = v_timezone
       ) THEN
        RAISE EXCEPTION 'A valid PostgreSQL timezone name is required' USING ERRCODE = '22023';
    END IF;

    IF v_fiscal_month IS NULL OR v_fiscal_month NOT BETWEEN 1 AND 12 THEN
        RAISE EXCEPTION 'Fiscal year start month must be between 1 and 12' USING ERRCODE = '22023';
    END IF;

    -- Use the same per-church advisory lock convention as Migration 002.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_church_id::TEXT, 0)
    );

    -- Recheck authorization after the lock and hold the actor's membership
    -- and church rows stable until this transaction commits.
    PERFORM public.assert_church_accounting_permission(
        p_church_id,
        'accounting.settings.manage'
    );

    -- Refuse any pre-existing/partial configuration. The setup is atomic:
    -- callers must not silently merge a partially configured church.
    IF EXISTS (
        SELECT 1 FROM public.accounting_settings WHERE church_id = p_church_id
    ) OR EXISTS (
        SELECT 1 FROM public.accounting_periods WHERE church_id = p_church_id
    ) OR EXISTS (
        SELECT 1 FROM public.accounting_departments WHERE church_id = p_church_id
    ) OR EXISTS (
        SELECT 1 FROM public.accounting_funds WHERE church_id = p_church_id
    ) OR EXISTS (
        SELECT 1 FROM public.accounting_accounts WHERE church_id = p_church_id
    ) THEN
        RAISE EXCEPTION 'Accounting configuration already exists or is incomplete; use the reviewed recovery process instead of reinitializing' USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.accounting_settings (
        church_id,
        functional_currency,
        timezone_name,
        fiscal_year_start_month
    )
    VALUES (
        p_church_id,
        v_currency,
        v_timezone,
        v_fiscal_month
    );

    INSERT INTO public.accounting_funds (
        church_id,
        fund_code,
        fund_name,
        fund_type,
        is_default,
        is_active
    )
    VALUES (
        p_church_id,
        'UNRESTRICTED',
        'Unrestricted General Fund',
        'unrestricted',
        TRUE,
        TRUE
    )
    RETURNING id INTO v_default_fund_id;

    -- Starter chart of accounts. Group accounts are non-postable. Churches
    -- can add their actual bank/mobile-money subaccounts through secure RPCs.
    FOR v_seed IN
        SELECT *
        FROM (
            VALUES
                (10, '1000', 'Assets', 'asset', 'debit', NULL::TEXT, FALSE),
                (20, '1100', 'Cash and Cash Equivalents', 'asset', 'debit', '1000', FALSE),
                (30, '1110', 'Cash on Hand', 'asset', 'debit', '1100', TRUE),
                (40, '1120', 'Bank Accounts', 'asset', 'debit', '1100', FALSE),
                (50, '1130', 'Mobile Money Accounts', 'asset', 'debit', '1100', FALSE),
                (60, '1200', 'Receivables', 'asset', 'debit', '1000', FALSE),
                (70, '1210', 'Accounts Receivable', 'asset', 'debit', '1200', TRUE),

                (80, '2000', 'Liabilities', 'liability', 'credit', NULL::TEXT, FALSE),
                (90, '2100', 'Current Liabilities', 'liability', 'credit', '2000', FALSE),
                (100, '2110', 'Accounts Payable', 'liability', 'credit', '2100', TRUE),
                (110, '2120', 'Accrued Expenses Payable', 'liability', 'credit', '2100', TRUE),
                (120, '2200', 'Other Liabilities', 'liability', 'credit', '2000', FALSE),
                (130, '2210', 'Deferred Income', 'liability', 'credit', '2200', TRUE),

                (140, '3000', 'Net Assets', 'net_assets', 'credit', NULL::TEXT, FALSE),
                (150, '3100', 'Net Assets Without Donor Restrictions', 'net_assets', 'credit', '3000', TRUE),
                (160, '3200', 'Net Assets With Donor Restrictions', 'net_assets', 'credit', '3000', TRUE),
                (170, '3300', 'Board-Designated Net Assets', 'net_assets', 'credit', '3000', TRUE),

                (180, '4000', 'Income', 'income', 'credit', NULL::TEXT, FALSE),
                (190, '4100', 'Tithes', 'income', 'credit', '4000', TRUE),
                (200, '4200', 'Offerings', 'income', 'credit', '4000', TRUE),
                (210, '4300', 'Donations and Gifts', 'income', 'credit', '4000', TRUE),
                (220, '4400', 'Other Income', 'income', 'credit', '4000', TRUE),

                (230, '5000', 'Expenses', 'expense', 'debit', NULL::TEXT, FALSE),
                (240, '5100', 'Staff and Ministry Personnel Costs', 'expense', 'debit', '5000', TRUE),
                (250, '5200', 'Ministry Programmes', 'expense', 'debit', '5000', FALSE),
                (260, '5210', 'Worship and Music Ministry', 'expense', 'debit', '5200', TRUE),
                (270, '5220', 'Youth and Children Ministry', 'expense', 'debit', '5200', TRUE),
                (280, '5230', 'Missions and Outreach', 'expense', 'debit', '5200', TRUE),
                (290, '5300', 'Facilities and Operations', 'expense', 'debit', '5000', FALSE),
                (300, '5310', 'Utilities', 'expense', 'debit', '5300', TRUE),
                (310, '5320', 'Building and Maintenance', 'expense', 'debit', '5300', TRUE),
                (320, '5400', 'Administration and Office', 'expense', 'debit', '5000', TRUE),
                (330, '5500', 'Benevolence and Community Care', 'expense', 'debit', '5000', TRUE),
                (340, '5600', 'Depreciation', 'expense', 'debit', '5000', TRUE)
        ) AS seed(
            sort_order,
            account_code,
            account_name,
            account_type,
            normal_balance,
            parent_account_code,
            allow_direct_posting
        )
        ORDER BY sort_order
    LOOP
        v_parent_account_id := NULL;

        IF v_seed.parent_account_code IS NOT NULL THEN
            SELECT a.id
              INTO v_parent_account_id
              FROM public.accounting_accounts AS a
             WHERE a.church_id = p_church_id
               AND a.account_code = v_seed.parent_account_code;

            IF v_parent_account_id IS NULL THEN
                RAISE EXCEPTION 'Starter chart parent account % was not created', v_seed.parent_account_code;
            END IF;
        END IF;

        INSERT INTO public.accounting_accounts (
            church_id,
            account_code,
            account_name,
            account_type,
            normal_balance,
            parent_account_id,
            description,
            allow_direct_posting,
            is_system_account,
            is_active
        )
        VALUES (
            p_church_id,
            v_seed.account_code,
            v_seed.account_name,
            v_seed.account_type,
            v_seed.normal_balance,
            v_parent_account_id,
            'BelieversMeet standard starter chart of accounts.',
            v_seed.allow_direct_posting,
            TRUE,
            TRUE
        )
        RETURNING id INTO v_created_account_id;

        v_account_count := v_account_count + 1;
    END LOOP;

    -- Create the twelve monthly posting periods for the fiscal year that
    -- contains today's date in the church's configured timezone.
    v_local_today := (pg_catalog.clock_timestamp() AT TIME ZONE v_timezone)::DATE;
    v_fiscal_year_start_year := pg_catalog.date_part('year', v_local_today)::INTEGER;

    IF pg_catalog.date_part('month', v_local_today)::INTEGER < v_fiscal_month THEN
        v_fiscal_year_start_year := v_fiscal_year_start_year - 1;
    END IF;

    v_fiscal_year_start := pg_catalog.make_date(
        v_fiscal_year_start_year,
        v_fiscal_month,
        1
    );

    FOR v_month_offset IN 0..11 LOOP
        v_month_start := (
            v_fiscal_year_start
            + pg_catalog.make_interval(months => v_month_offset)
        )::DATE;

        v_next_month_start := (
            v_fiscal_year_start
            + pg_catalog.make_interval(months => v_month_offset + 1)
        )::DATE;

        INSERT INTO public.accounting_periods (
            church_id,
            period_code,
            period_name,
            period_type,
            start_date,
            end_date,
            status
        )
        VALUES (
            p_church_id,
            pg_catalog.to_char(v_month_start, 'YYYY-MM'),
            pg_catalog.to_char(v_month_start, 'FMMonth YYYY'),
            'monthly',
            v_month_start,
            v_next_month_start - 1,
            'open'
        );

        v_period_count := v_period_count + 1;
    END LOOP;

    v_initialized_at := pg_catalog.clock_timestamp();

    UPDATE public.accounting_settings
       SET setup_completed_at = v_initialized_at,
           setup_completed_by = v_actor_id
     WHERE church_id = p_church_id;

    INSERT INTO public.accounting_audit_log (
        church_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        description,
        metadata
    )
    VALUES (
        p_church_id,
        v_actor_id,
        'initialized',
        'church_setup',
        p_church_id,
        'Church accounting environment initialized.',
        pg_catalog.jsonb_build_object(
            'functional_currency', v_currency,
            'timezone_name', v_timezone,
            'fiscal_year_start_month', v_fiscal_month,
            'fiscal_year_start', v_fiscal_year_start,
            'fiscal_year_end', (v_fiscal_year_start + pg_catalog.make_interval(months => 12))::DATE - 1,
            'default_fund_id', v_default_fund_id,
            'accounts_created', v_account_count,
            'periods_created', v_period_count
        )
    );

    RETURN pg_catalog.jsonb_build_object(
        'church_id', p_church_id,
        'initialized', TRUE,
        'initialized_at', v_initialized_at,
        'functional_currency', v_currency,
        'timezone_name', v_timezone,
        'fiscal_year_start_month', v_fiscal_month,
        'fiscal_year_start', v_fiscal_year_start,
        'fiscal_year_end', (v_fiscal_year_start + pg_catalog.make_interval(months => 12))::DATE - 1,
        'default_fund_id', v_default_fund_id,
        'accounts_created', v_account_count,
        'periods_created', v_period_count
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Create the next monthly fiscal-year periods when needed
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.create_next_church_accounting_fiscal_year(
    p_church_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id UUID := auth.uid();
    v_fiscal_month SMALLINT;
    v_timezone TEXT;
    v_setup_completed_at TIMESTAMPTZ;
    v_last_period_end DATE;
    v_next_fiscal_start DATE;
    v_next_fiscal_end DATE;
    v_next_month_start DATE;
    v_following_month_start DATE;
    v_month_offset INTEGER;
    v_period_count INTEGER := 0;
    v_local_today DATE;
    v_current_fiscal_year_start_year INTEGER;
    v_current_fiscal_year_start DATE;
    v_latest_allowed_fiscal_start DATE;
BEGIN
    IF v_actor_id IS NULL OR p_church_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and church are required' USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_church_financial_permission(
        p_church_id,
        'accounting.periods.manage'
    ) THEN
        RAISE EXCEPTION 'You are not authorized to create accounting periods' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_church_id::TEXT, 0)
    );

    PERFORM public.assert_church_accounting_permission(
        p_church_id,
        'accounting.periods.manage'
    );

    SELECT
        s.fiscal_year_start_month,
        s.timezone_name,
        s.setup_completed_at
    INTO
        v_fiscal_month,
        v_timezone,
        v_setup_completed_at
    FROM public.accounting_settings AS s
    WHERE s.church_id = p_church_id
    FOR UPDATE;

    IF NOT FOUND OR v_setup_completed_at IS NULL THEN
        RAISE EXCEPTION 'Accounting must be initialized before creating another fiscal year' USING ERRCODE = '55000';
    END IF;

    SELECT pg_catalog.max(p.end_date)
      INTO v_last_period_end
      FROM public.accounting_periods AS p
     WHERE p.church_id = p_church_id;

    IF v_last_period_end IS NULL THEN
        RAISE EXCEPTION 'No existing accounting periods were found' USING ERRCODE = '55000';
    END IF;

    v_next_fiscal_start := v_last_period_end + 1;
    v_next_fiscal_end := (
        v_next_fiscal_start + pg_catalog.make_interval(months => 12)
    )::DATE - 1;

    IF pg_catalog.date_part('day', v_next_fiscal_start)::INTEGER <> 1
       OR pg_catalog.date_part('month', v_next_fiscal_start)::INTEGER <> v_fiscal_month THEN
        RAISE EXCEPTION 'The existing accounting periods do not end at a fiscal-year boundary; manual review is required' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.accounting_periods AS p
        WHERE p.church_id = p_church_id
          AND p.start_date <= v_next_fiscal_end
          AND p.end_date >= v_next_fiscal_start
    ) THEN
        RAISE EXCEPTION 'An existing accounting period overlaps the next fiscal year; manual review is required' USING ERRCODE = '23505';
    END IF;

    v_local_today := (pg_catalog.clock_timestamp() AT TIME ZONE v_timezone)::DATE;
    v_current_fiscal_year_start_year := pg_catalog.date_part('year', v_local_today)::INTEGER;

    IF pg_catalog.date_part('month', v_local_today)::INTEGER < v_fiscal_month THEN
        v_current_fiscal_year_start_year := v_current_fiscal_year_start_year - 1;
    END IF;

    v_current_fiscal_year_start := pg_catalog.make_date(
        v_current_fiscal_year_start_year,
        v_fiscal_month,
        1
    );
    v_latest_allowed_fiscal_start := (
        v_current_fiscal_year_start
        + pg_catalog.make_interval(months => 12)
    )::DATE;

    IF v_next_fiscal_start > v_latest_allowed_fiscal_start THEN
        RAISE EXCEPTION 'Only the next fiscal year may be generated in advance' USING ERRCODE = '22023';
    END IF;

    FOR v_month_offset IN 0..11 LOOP
        v_next_month_start := (
            v_next_fiscal_start
            + pg_catalog.make_interval(months => v_month_offset)
        )::DATE;

        v_following_month_start := (
            v_next_fiscal_start
            + pg_catalog.make_interval(months => v_month_offset + 1)
        )::DATE;

        INSERT INTO public.accounting_periods (
            church_id,
            period_code,
            period_name,
            period_type,
            start_date,
            end_date,
            status
        )
        VALUES (
            p_church_id,
            pg_catalog.to_char(v_next_month_start, 'YYYY-MM'),
            pg_catalog.to_char(v_next_month_start, 'FMMonth YYYY'),
            'monthly',
            v_next_month_start,
            v_following_month_start - 1,
            'open'
        );

        v_period_count := v_period_count + 1;
    END LOOP;

    INSERT INTO public.accounting_audit_log (
        church_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        description,
        metadata
    )
    VALUES (
        p_church_id,
        v_actor_id,
        'fiscal_year_created',
        'accounting_period',
        NULL,
        'Next church fiscal year monthly periods created.',
        pg_catalog.jsonb_build_object(
            'fiscal_year_start', v_next_fiscal_start,
            'fiscal_year_end', (v_next_fiscal_start + pg_catalog.make_interval(months => 12))::DATE - 1,
            'periods_created', v_period_count,
            'requested_on', v_local_today
        )
    );

    RETURN pg_catalog.jsonb_build_object(
        'church_id', p_church_id,
        'fiscal_year_start', v_next_fiscal_start,
        'fiscal_year_end', (v_next_fiscal_start + pg_catalog.make_interval(months => 12))::DATE - 1,
        'periods_created', v_period_count
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Update limited accounting settings
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.update_church_accounting_settings(
    p_church_id UUID,
    p_functional_currency TEXT,
    p_timezone_name TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id UUID := auth.uid();
    v_currency TEXT := pg_catalog.upper(pg_catalog.btrim(COALESCE(p_functional_currency, '')));
    v_timezone TEXT := pg_catalog.btrim(COALESCE(p_timezone_name, ''));
    v_old_currency TEXT;
    v_old_timezone TEXT;
BEGIN
    IF v_actor_id IS NULL OR p_church_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and church are required' USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_church_financial_permission(
        p_church_id,
        'accounting.settings.manage'
    ) THEN
        RAISE EXCEPTION 'You are not authorized to manage accounting settings' USING ERRCODE = '42501';
    END IF;

    IF v_currency !~ '^[A-Z]{3}$' THEN
        RAISE EXCEPTION 'Functional currency must be a three-letter uppercase currency code' USING ERRCODE = '22023';
    END IF;

    IF v_timezone = ''
       OR NOT EXISTS (
            SELECT 1
            FROM pg_catalog.pg_timezone_names tz
            WHERE tz.name = v_timezone
       ) THEN
        RAISE EXCEPTION 'A valid PostgreSQL timezone name is required' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_church_id::TEXT, 0)
    );

    PERFORM public.assert_church_accounting_permission(
        p_church_id,
        'accounting.settings.manage'
    );

    SELECT s.functional_currency, s.timezone_name
      INTO v_old_currency, v_old_timezone
      FROM public.accounting_settings AS s
     WHERE s.church_id = p_church_id
       AND s.setup_completed_at IS NOT NULL
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Initialized accounting settings were not found' USING ERRCODE = 'P0002';
    END IF;

    -- Functional currency is fixed once the church accounting environment is
    -- initialized. Changing it after journals exist would require a separately
    -- designed currency-transition and ledger-translation process; a settings
    -- RPC must never silently reinterpret historical balances.
    IF v_currency IS DISTINCT FROM v_old_currency THEN
        RAISE EXCEPTION
            'Functional currency cannot be changed after accounting initialization; a separately reviewed currency-transition process is required'
            USING ERRCODE = '55000';
    END IF;

    IF v_old_timezone = v_timezone THEN
        RETURN TRUE;
    END IF;

    UPDATE public.accounting_settings
       SET timezone_name = v_timezone
     WHERE church_id = p_church_id;

    INSERT INTO public.accounting_audit_log (
        church_id,
        actor_user_id,
        action,
        entity_type,
        entity_id,
        description,
        metadata
    )
    VALUES (
        p_church_id,
        v_actor_id,
        'settings_updated',
        'accounting_settings',
        p_church_id,
        'Church accounting currency and/or timezone updated.',
        pg_catalog.jsonb_build_object(
            'old_functional_currency', v_old_currency,
            'new_functional_currency', v_currency,
            'old_timezone_name', v_old_timezone,
            'new_timezone_name', v_timezone
        )
    );

    RETURN TRUE;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Create a church department or ministry
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.create_accounting_department(
    p_church_id UUID,
    p_department_code TEXT,
    p_department_name TEXT,
    p_description TEXT,
    p_parent_department_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id UUID := auth.uid();
    v_department_id UUID;
    v_code TEXT := NULLIF(pg_catalog.btrim(COALESCE(p_department_code, '')), '');
    v_name TEXT := pg_catalog.btrim(COALESCE(p_department_name, ''));
    v_description TEXT := NULLIF(pg_catalog.btrim(COALESCE(p_description, '')), '');
BEGIN
    IF v_actor_id IS NULL OR p_church_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and church are required' USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_church_financial_permission(
        p_church_id,
        'accounting.departments.manage'
    ) THEN
        RAISE EXCEPTION 'You are not authorized to manage accounting departments' USING ERRCODE = '42501';
    END IF;

    IF pg_catalog.length(v_name) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'Department name must contain between 1 and 120 characters' USING ERRCODE = '22023';
    END IF;

    IF v_code IS NOT NULL AND pg_catalog.length(v_code) > 32 THEN
        RAISE EXCEPTION 'Department code cannot exceed 32 characters' USING ERRCODE = '22023';
    END IF;

    IF v_description IS NOT NULL AND pg_catalog.length(v_description) > 1000 THEN
        RAISE EXCEPTION 'Department description cannot exceed 1000 characters' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_church_id::TEXT, 0)
    );

    PERFORM public.assert_church_accounting_permission(
        p_church_id,
        'accounting.departments.manage'
    );

    IF NOT EXISTS (
        SELECT 1
        FROM public.accounting_settings s
        WHERE s.church_id = p_church_id
          AND s.setup_completed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Initialize church accounting before creating departments' USING ERRCODE = '55000';
    END IF;

    IF p_parent_department_id IS NOT NULL
       AND NOT EXISTS (
            SELECT 1
            FROM public.accounting_departments d
            WHERE d.id = p_parent_department_id
              AND d.church_id = p_church_id
              AND d.is_active IS TRUE
       ) THEN
        RAISE EXCEPTION 'Parent department must be active and belong to the same church' USING ERRCODE = '23503';
    END IF;

    INSERT INTO public.accounting_departments (
        church_id,
        department_code,
        department_name,
        description,
        parent_department_id
    )
    VALUES (
        p_church_id,
        v_code,
        v_name,
        v_description,
        p_parent_department_id
    )
    RETURNING id INTO v_department_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id, description, metadata
    )
    VALUES (
        p_church_id,
        v_actor_id,
        'department_created',
        'department',
        v_department_id,
        'Accounting department created.',
        pg_catalog.jsonb_build_object(
            'department_code', v_code,
            'department_name', v_name,
            'parent_department_id', p_parent_department_id
        )
    );

    RETURN v_department_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Create an additional church fund (default fund is created by initializer)
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.create_accounting_fund(
    p_church_id UUID,
    p_fund_code TEXT,
    p_fund_name TEXT,
    p_fund_type TEXT,
    p_restriction_description TEXT,
    p_restriction_reference TEXT,
    p_designation_authority TEXT,
    p_designation_date DATE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id UUID := auth.uid();
    v_fund_id UUID;
    v_code TEXT := pg_catalog.btrim(COALESCE(p_fund_code, ''));
    v_name TEXT := pg_catalog.btrim(COALESCE(p_fund_name, ''));
    v_type TEXT := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_fund_type, '')));
    v_restriction_description TEXT := NULLIF(pg_catalog.btrim(COALESCE(p_restriction_description, '')), '');
    v_restriction_reference TEXT := NULLIF(pg_catalog.btrim(COALESCE(p_restriction_reference, '')), '');
    v_designation_authority TEXT := NULLIF(pg_catalog.btrim(COALESCE(p_designation_authority, '')), '');
BEGIN
    IF v_actor_id IS NULL OR p_church_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and church are required' USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_church_financial_permission(
        p_church_id,
        'accounting.funds.manage'
    ) THEN
        RAISE EXCEPTION 'You are not authorized to manage church funds' USING ERRCODE = '42501';
    END IF;

    IF pg_catalog.length(v_code) NOT BETWEEN 1 AND 32
       OR pg_catalog.length(v_name) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'Fund code must be 1-32 characters and fund name 1-120 characters' USING ERRCODE = '22023';
    END IF;

    IF v_type NOT IN ('unrestricted', 'donor_restricted', 'board_designated') THEN
        RAISE EXCEPTION 'Unsupported fund type' USING ERRCODE = '22023';
    END IF;

    IF v_type = 'donor_restricted'
       AND v_restriction_description IS NULL THEN
        RAISE EXCEPTION 'Donor-restricted funds require a restriction description' USING ERRCODE = '22023';
    END IF;

    IF (v_restriction_description IS NOT NULL AND pg_catalog.length(v_restriction_description) > 1000)
       OR (v_restriction_reference IS NOT NULL AND pg_catalog.length(v_restriction_reference) > 200)
       OR (v_designation_authority IS NOT NULL AND pg_catalog.length(v_designation_authority) > 250) THEN
        RAISE EXCEPTION 'Fund restriction/designation details exceed the permitted length' USING ERRCODE = '22023';
    END IF;

    IF v_type = 'board_designated'
       AND (v_designation_authority IS NULL OR p_designation_date IS NULL) THEN
        RAISE EXCEPTION 'Board-designated funds require designation authority and date' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_church_id::TEXT, 0)
    );

    PERFORM public.assert_church_accounting_permission(
        p_church_id,
        'accounting.funds.manage'
    );

    IF NOT EXISTS (
        SELECT 1
        FROM public.accounting_settings s
        WHERE s.church_id = p_church_id
          AND s.setup_completed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Initialize church accounting before creating funds' USING ERRCODE = '55000';
    END IF;

    INSERT INTO public.accounting_funds (
        church_id,
        fund_code,
        fund_name,
        fund_type,
        restriction_description,
        restriction_reference,
        designation_authority,
        designation_date,
        is_default,
        is_active
    )
    VALUES (
        p_church_id,
        v_code,
        v_name,
        v_type,
        v_restriction_description,
        v_restriction_reference,
        v_designation_authority,
        p_designation_date,
        FALSE,
        TRUE
    )
    RETURNING id INTO v_fund_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id, description, metadata
    )
    VALUES (
        p_church_id,
        v_actor_id,
        'fund_created',
        'fund',
        v_fund_id,
        'Accounting fund created.',
        pg_catalog.jsonb_build_object(
            'fund_code', v_code,
            'fund_name', v_name,
            'fund_type', v_type,
            'restriction_reference', v_restriction_reference,
            'designation_authority', v_designation_authority,
            'designation_date', p_designation_date
        )
    );

    RETURN v_fund_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Create a church account. Updates/deactivation are handled in a later
-- reviewed configuration migration with usage checks against posted journals.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.create_accounting_account(
    p_church_id UUID,
    p_account_code TEXT,
    p_account_name TEXT,
    p_account_type TEXT,
    p_normal_balance TEXT,
    p_parent_account_id UUID,
    p_description TEXT,
    p_allow_direct_posting BOOLEAN
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id UUID := auth.uid();
    v_account_id UUID;
    v_code TEXT := pg_catalog.btrim(COALESCE(p_account_code, ''));
    v_name TEXT := pg_catalog.btrim(COALESCE(p_account_name, ''));
    v_type TEXT := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_account_type, '')));
    v_normal_balance TEXT := pg_catalog.lower(pg_catalog.btrim(COALESCE(p_normal_balance, '')));
    v_description TEXT := NULLIF(pg_catalog.btrim(COALESCE(p_description, '')), '');
    v_parent_type TEXT;
    v_parent_allow_direct_posting BOOLEAN;
BEGIN
    IF v_actor_id IS NULL OR p_church_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and church are required' USING ERRCODE = '42501';
    END IF;

    IF NOT public.has_church_financial_permission(
        p_church_id,
        'accounting.accounts.manage'
    ) THEN
        RAISE EXCEPTION 'You are not authorized to manage the chart of accounts' USING ERRCODE = '42501';
    END IF;

    IF pg_catalog.length(v_code) NOT BETWEEN 1 AND 32
       OR pg_catalog.length(v_name) NOT BETWEEN 1 AND 120 THEN
        RAISE EXCEPTION 'Account code must be 1-32 characters and account name 1-120 characters' USING ERRCODE = '22023';
    END IF;

    IF v_type NOT IN ('asset', 'liability', 'net_assets', 'income', 'expense') THEN
        RAISE EXCEPTION 'Unsupported account type' USING ERRCODE = '22023';
    END IF;

    -- Account type and normal balance are related but not identical:
    -- contra accounts (for example, accumulated depreciation) legitimately
    -- use the opposite normal balance for their account type.
    IF v_normal_balance NOT IN ('debit', 'credit') THEN
        RAISE EXCEPTION 'Normal balance must be debit or credit' USING ERRCODE = '22023';
    END IF;

    IF v_description IS NOT NULL AND pg_catalog.length(v_description) > 1000 THEN
        RAISE EXCEPTION 'Account description cannot exceed 1000 characters' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_church_id::TEXT, 0)
    );

    PERFORM public.assert_church_accounting_permission(
        p_church_id,
        'accounting.accounts.manage'
    );

    IF NOT EXISTS (
        SELECT 1
        FROM public.accounting_settings s
        WHERE s.church_id = p_church_id
          AND s.setup_completed_at IS NOT NULL
    ) THEN
        RAISE EXCEPTION 'Initialize church accounting before creating accounts' USING ERRCODE = '55000';
    END IF;

    IF p_parent_account_id IS NOT NULL THEN
        SELECT a.account_type, a.allow_direct_posting
          INTO v_parent_type, v_parent_allow_direct_posting
          FROM public.accounting_accounts AS a
         WHERE a.id = p_parent_account_id
           AND a.church_id = p_church_id
           AND a.is_active IS TRUE
         FOR SHARE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Parent account must be active and belong to the same church' USING ERRCODE = '23503';
        END IF;

        IF v_parent_type <> v_type
           OR v_parent_allow_direct_posting IS TRUE THEN
            RAISE EXCEPTION 'Parent account must be a non-postable account of the same account type' USING ERRCODE = '23514';
        END IF;
    END IF;

    INSERT INTO public.accounting_accounts (
        church_id,
        account_code,
        account_name,
        account_type,
        normal_balance,
        parent_account_id,
        description,
        allow_direct_posting,
        is_system_account,
        is_active
    )
    VALUES (
        p_church_id,
        v_code,
        v_name,
        v_type,
        v_normal_balance,
        p_parent_account_id,
        v_description,
        COALESCE(p_allow_direct_posting, TRUE),
        FALSE,
        TRUE
    )
    RETURNING id INTO v_account_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id, description, metadata
    )
    VALUES (
        p_church_id,
        v_actor_id,
        'account_created',
        'account',
        v_account_id,
        'Chart of accounts entry created.',
        pg_catalog.jsonb_build_object(
            'account_code', v_code,
            'account_name', v_name,
            'account_type', v_type,
            'normal_balance', v_normal_balance,
            'parent_account_id', p_parent_account_id,
            'allow_direct_posting', COALESCE(p_allow_direct_posting, TRUE)
        )
    );

    RETURN v_account_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 10. Ownership, RLS/grants, and function execution privileges
-- ---------------------------------------------------------------------------
ALTER TABLE public.accounting_settings OWNER TO postgres;
ALTER TABLE public.accounting_periods OWNER TO postgres;
ALTER TABLE public.accounting_departments OWNER TO postgres;
ALTER TABLE public.accounting_funds OWNER TO postgres;
ALTER TABLE public.accounting_accounts OWNER TO postgres;

ALTER FUNCTION public.assert_church_accounting_permission(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.initialize_church_accounting(UUID, TEXT, TEXT, SMALLINT) OWNER TO postgres;
ALTER FUNCTION public.create_next_church_accounting_fiscal_year(UUID) OWNER TO postgres;
ALTER FUNCTION public.update_church_accounting_settings(UUID, TEXT, TEXT) OWNER TO postgres;
ALTER FUNCTION public.create_accounting_department(UUID, TEXT, TEXT, TEXT, UUID) OWNER TO postgres;
ALTER FUNCTION public.create_accounting_fund(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE) OWNER TO postgres;
ALTER FUNCTION public.create_accounting_account(UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, BOOLEAN) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.assert_church_accounting_permission(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.initialize_church_accounting(UUID, TEXT, TEXT, SMALLINT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_next_church_accounting_fiscal_year(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.update_church_accounting_settings(UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_accounting_department(UUID, TEXT, TEXT, TEXT, UUID)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_accounting_fund(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.create_accounting_account(UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.initialize_church_accounting(UUID, TEXT, TEXT, SMALLINT)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_next_church_accounting_fiscal_year(UUID)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.update_church_accounting_settings(UUID, TEXT, TEXT)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_accounting_department(UUID, TEXT, TEXT, TEXT, UUID)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_accounting_fund(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.create_accounting_account(UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, BOOLEAN)
    TO authenticated;

COMMENT ON FUNCTION public.assert_church_accounting_permission(UUID, TEXT) IS
    'Internal authorization guard for accounting SECURITY DEFINER RPCs. Acquires a stable share lock on the authenticated users church profile and church row, then rechecks the requested church-scoped financial permission.';
COMMENT ON TABLE public.accounting_audit_log IS
    'Append-only church-scoped audit trail for accounting initialization and configuration changes. Read access requires accounting.audit.read; writes are only performed by secure RPCs.';
COMMENT ON COLUMN public.accounting_audit_log.actor_user_id IS
    'Historical auth user UUID of the actor. Intentionally not a foreign key so immutable audit history survives account deletion.';
COMMENT ON FUNCTION public.initialize_church_accounting(UUID, TEXT, TEXT, SMALLINT) IS
    'Initializes one approved church exactly once with accounting settings, a default unrestricted fund, a starter chart of accounts, and twelve monthly periods for the fiscal year containing the current local date.';
COMMENT ON FUNCTION public.create_next_church_accounting_fiscal_year(UUID) IS
    'Creates the next twelve monthly periods after the existing fiscal-year boundary, with church-scoped authorization and an audit event.';
COMMENT ON FUNCTION public.update_church_accounting_settings(UUID, TEXT, TEXT) IS
    'Updates the timezone for an initialized church. Functional currency is fixed at initialization; changing it requires a separately reviewed currency-transition and ledger-translation process. Fiscal-year start month is immutable after setup.';
COMMENT ON FUNCTION public.create_accounting_department(UUID, TEXT, TEXT, TEXT, UUID) IS
    'Creates a church-owned accounting department. Parent department must be active and belong to the same church.';
COMMENT ON FUNCTION public.create_accounting_fund(UUID, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, DATE) IS
    'Creates a non-default unrestricted, donor-restricted, or board-designated fund with required restriction/designation evidence.';
COMMENT ON FUNCTION public.create_accounting_account(UUID, TEXT, TEXT, TEXT, TEXT, UUID, TEXT, BOOLEAN) IS
    'Creates a church-owned chart-of-accounts entry. Normal balance may be debit or credit independently of account type to support contra accounts; parent must be same-church, active, non-postable, and have the same account type.';

COMMIT;
