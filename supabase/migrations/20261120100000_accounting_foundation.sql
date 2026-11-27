-- BelieversMeet Accounting & Budgeting
-- Migration 001: Accounting foundation
-- Draft only: review before execution on BelieversMeet-Staging.
-- Creates core church-scoped configuration tables. No ledger or budget
-- transactions are created in this migration.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Fail closed if the existing BelieversMeet ownership tables are unavailable
-- or do not expose the expected UUID identifiers.
DO $preflight$
BEGIN
    IF pg_catalog.to_regclass('public.churches') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: public.churches does not exist';
    END IF;

    IF pg_catalog.to_regclass('public.profiles') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: public.profiles does not exist';
    END IF;

    IF pg_catalog.to_regclass('auth.users') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: auth.users does not exist';
    END IF;

    IF pg_catalog.to_regprocedure('public.accounting_set_updated_at()') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: public.accounting_set_updated_at() already exists';
    END IF;

    IF pg_catalog.to_regclass('public.accounting_settings') IS NOT NULL
       OR pg_catalog.to_regclass('public.accounting_periods') IS NOT NULL
       OR pg_catalog.to_regclass('public.accounting_departments') IS NOT NULL
       OR pg_catalog.to_regclass('public.accounting_funds') IS NOT NULL
       OR pg_catalog.to_regclass('public.accounting_accounts') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: one or more accounting foundation relations already exist';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'churches'
          AND column_name = 'id'
          AND udt_name = 'uuid'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: public.churches.id is not UUID';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'profiles'
          AND column_name = 'id'
          AND udt_name = 'uuid'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: public.profiles.id is not UUID';
    END IF;
END;
$preflight$;

-- 1. One accounting configuration row per church.
CREATE TABLE public.accounting_settings (
    church_id UUID PRIMARY KEY,
    functional_currency TEXT NOT NULL DEFAULT 'UGX',
    timezone_name TEXT NOT NULL DEFAULT 'Africa/Kampala',
    fiscal_year_start_month SMALLINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

    CONSTRAINT accounting_settings_church_fk
        FOREIGN KEY (church_id)
        REFERENCES public.churches (id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_settings_currency_chk
        CHECK (functional_currency ~ '^[A-Z]{3}$'),
    CONSTRAINT accounting_settings_timezone_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(timezone_name)) > 0),
    CONSTRAINT accounting_settings_fiscal_month_chk
        CHECK (fiscal_year_start_month BETWEEN 1 AND 12)
);

-- 2. Accounting periods. Posting/overlap rules will be enforced by the
-- secure posting and period-management RPCs in a later migration.
CREATE TABLE public.accounting_periods (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    period_code TEXT NOT NULL,
    period_name TEXT NOT NULL,
    period_type TEXT NOT NULL,
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    status TEXT NOT NULL DEFAULT 'open',
    closed_at TIMESTAMPTZ,
    closed_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

    CONSTRAINT accounting_periods_church_fk
        FOREIGN KEY (church_id)
        REFERENCES public.churches (id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_periods_closed_by_fk
        FOREIGN KEY (closed_by)
        REFERENCES auth.users (id)
        ON DELETE SET NULL,
    CONSTRAINT accounting_periods_church_id_id_uk
        UNIQUE (church_id, id),
    CONSTRAINT accounting_periods_code_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(period_code)) > 0),
    CONSTRAINT accounting_periods_name_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(period_name)) > 0),
    CONSTRAINT accounting_periods_type_chk
        CHECK (period_type IN ('monthly', 'quarterly', 'annual', 'adjustment')),
    CONSTRAINT accounting_periods_dates_chk
        CHECK (end_date >= start_date),
    CONSTRAINT accounting_periods_status_chk
        CHECK (status IN ('open', 'closed', 'locked')),
    CONSTRAINT accounting_periods_close_state_chk
        CHECK (
            (status = 'open' AND closed_at IS NULL AND closed_by IS NULL)
            OR (status IN ('closed', 'locked') AND closed_at IS NOT NULL)
        )
);

CREATE UNIQUE INDEX accounting_periods_code_uk
    ON public.accounting_periods (church_id, (pg_catalog.lower(period_code)));

CREATE INDEX accounting_periods_church_dates_idx
    ON public.accounting_periods (church_id, start_date, end_date);

-- 3. Church departments and ministry units.
CREATE TABLE public.accounting_departments (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    department_code TEXT,
    department_name TEXT NOT NULL,
    description TEXT,
    parent_department_id UUID,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

    CONSTRAINT accounting_departments_church_fk
        FOREIGN KEY (church_id)
        REFERENCES public.churches (id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_departments_church_id_id_uk
        UNIQUE (church_id, id),
    CONSTRAINT accounting_departments_parent_fk
        FOREIGN KEY (church_id, parent_department_id)
        REFERENCES public.accounting_departments (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_departments_name_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(department_name)) > 0),
    CONSTRAINT accounting_departments_code_chk
        CHECK (
            department_code IS NULL
            OR pg_catalog.length(pg_catalog.btrim(department_code)) > 0
        ),
    CONSTRAINT accounting_departments_no_self_parent_chk
        CHECK (parent_department_id IS NULL OR parent_department_id <> id)
);

CREATE UNIQUE INDEX accounting_departments_code_uk
    ON public.accounting_departments (church_id, (pg_catalog.lower(department_code)))
    WHERE department_code IS NOT NULL;

CREATE UNIQUE INDEX accounting_departments_name_uk
    ON public.accounting_departments (church_id, pg_catalog.lower(department_name));

CREATE INDEX accounting_departments_parent_idx
    ON public.accounting_departments (church_id, parent_department_id);

-- 4. Church funds. Board-designated funds are tracked separately from
-- donor-restricted funds; an internal designation is not a donor restriction.
CREATE TABLE public.accounting_funds (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    fund_code TEXT NOT NULL,
    fund_name TEXT NOT NULL,
    fund_type TEXT NOT NULL,
    restriction_description TEXT,
    restriction_reference TEXT,
    designation_authority TEXT,
    designation_date DATE,
    is_default BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

    CONSTRAINT accounting_funds_church_fk
        FOREIGN KEY (church_id)
        REFERENCES public.churches (id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_funds_church_id_id_uk
        UNIQUE (church_id, id),
    CONSTRAINT accounting_funds_code_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(fund_code)) > 0),
    CONSTRAINT accounting_funds_name_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(fund_name)) > 0),
    CONSTRAINT accounting_funds_type_chk
        CHECK (fund_type IN ('unrestricted', 'donor_restricted', 'board_designated')),
    CONSTRAINT accounting_funds_restriction_chk
        CHECK (
            fund_type <> 'donor_restricted'
            OR pg_catalog.length(pg_catalog.btrim(COALESCE(restriction_description, ''))) > 0
        ),
    CONSTRAINT accounting_funds_designation_chk
        CHECK (
            fund_type <> 'board_designated'
            OR (
                pg_catalog.length(pg_catalog.btrim(COALESCE(designation_authority, ''))) > 0
                AND designation_date IS NOT NULL
            )
        ),
    CONSTRAINT accounting_funds_default_type_chk
        CHECK (NOT is_default OR fund_type = 'unrestricted')
);

CREATE UNIQUE INDEX accounting_funds_code_uk
    ON public.accounting_funds (church_id, (pg_catalog.lower(fund_code)));

CREATE UNIQUE INDEX accounting_funds_name_uk
    ON public.accounting_funds (church_id, pg_catalog.lower(fund_name));

CREATE UNIQUE INDEX accounting_funds_one_default_per_church_uk
    ON public.accounting_funds (church_id)
    WHERE is_default IS TRUE;

-- 5. Church-specific chart of accounts.
CREATE TABLE public.accounting_accounts (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    account_code TEXT NOT NULL,
    account_name TEXT NOT NULL,
    account_type TEXT NOT NULL,
    normal_balance TEXT NOT NULL,
    parent_account_id UUID,
    description TEXT,
    allow_direct_posting BOOLEAN NOT NULL DEFAULT TRUE,
    is_system_account BOOLEAN NOT NULL DEFAULT FALSE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

    CONSTRAINT accounting_accounts_church_fk
        FOREIGN KEY (church_id)
        REFERENCES public.churches (id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_accounts_church_id_id_uk
        UNIQUE (church_id, id),
    CONSTRAINT accounting_accounts_parent_fk
        FOREIGN KEY (church_id, parent_account_id)
        REFERENCES public.accounting_accounts (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_accounts_code_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(account_code)) > 0),
    CONSTRAINT accounting_accounts_name_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(account_name)) > 0),
    CONSTRAINT accounting_accounts_type_chk
        CHECK (account_type IN ('asset', 'liability', 'net_assets', 'income', 'expense')),
    CONSTRAINT accounting_accounts_normal_balance_chk
        CHECK (normal_balance IN ('debit', 'credit')),
    CONSTRAINT accounting_accounts_no_self_parent_chk
        CHECK (parent_account_id IS NULL OR parent_account_id <> id)
);

CREATE UNIQUE INDEX accounting_accounts_code_uk
    ON public.accounting_accounts (church_id, (pg_catalog.lower(account_code)));

CREATE INDEX accounting_accounts_church_type_idx
    ON public.accounting_accounts (church_id, account_type, account_code);

CREATE INDEX accounting_accounts_parent_idx
    ON public.accounting_accounts (church_id, parent_account_id);

-- Keep ownership stable for future SECURITY DEFINER RPCs. This migration is
-- intended to be executed by the Staging postgres database owner.
ALTER TABLE public.accounting_settings OWNER TO postgres;
ALTER TABLE public.accounting_periods OWNER TO postgres;
ALTER TABLE public.accounting_departments OWNER TO postgres;
ALTER TABLE public.accounting_funds OWNER TO postgres;
ALTER TABLE public.accounting_accounts OWNER TO postgres;

-- Maintain updated_at for configuration edits performed by later secure RPCs.
CREATE FUNCTION public.accounting_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
    NEW.updated_at := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.accounting_set_updated_at() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accounting_set_updated_at()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER accounting_settings_set_updated_at
    BEFORE UPDATE ON public.accounting_settings
    FOR EACH ROW EXECUTE FUNCTION public.accounting_set_updated_at();

CREATE TRIGGER accounting_periods_set_updated_at
    BEFORE UPDATE ON public.accounting_periods
    FOR EACH ROW EXECUTE FUNCTION public.accounting_set_updated_at();

CREATE TRIGGER accounting_departments_set_updated_at
    BEFORE UPDATE ON public.accounting_departments
    FOR EACH ROW EXECUTE FUNCTION public.accounting_set_updated_at();

CREATE TRIGGER accounting_funds_set_updated_at
    BEFORE UPDATE ON public.accounting_funds
    FOR EACH ROW EXECUTE FUNCTION public.accounting_set_updated_at();

CREATE TRIGGER accounting_accounts_set_updated_at
    BEFORE UPDATE ON public.accounting_accounts
    FOR EACH ROW EXECUTE FUNCTION public.accounting_set_updated_at();

-- Lock all foundation tables until the dedicated financial permission and
-- secure-RPC migrations explicitly grant the minimum required access.
DO $security$
DECLARE
    v_table TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'accounting_settings',
        'accounting_periods',
        'accounting_departments',
        'accounting_funds',
        'accounting_accounts'
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
    END LOOP;
END;
$security$;

COMMENT ON TABLE public.accounting_settings IS
    'Per-church accounting configuration. Currency format is constrained here; secure RPCs must validate timezone_name against pg_catalog.pg_timezone_names. Client access is intentionally closed until financial permissions and secure RPCs are installed.';
COMMENT ON TABLE public.accounting_periods IS
    'Church accounting periods. Period overlap, calendar semantics and posting-state transitions must be enforced by secure accounting RPCs using per-church serialization.';
COMMENT ON TABLE public.accounting_departments IS
    'Church-owned departments and ministry units. Composite parent relationship prevents cross-church links; cycle prevention must be enforced by secure hierarchy-management RPCs.';
COMMENT ON TABLE public.accounting_funds IS
    'Church-owned funds. Donor-restricted funds are distinguished from internal board-designated funds.';
COMMENT ON TABLE public.accounting_accounts IS
    'Church-specific chart of accounts using asset, liability, net_assets, income and expense account types. Secure RPCs must prevent hierarchy cycles and direct posting to non-postable parent accounts.';

COMMIT;
