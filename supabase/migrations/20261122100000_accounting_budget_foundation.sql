-- ============================================================================
-- BelieversMeet Accounting & Budgeting
-- Migration 005 (DRAFT): Budget foundation, constraints, read security, history
-- Target: STAGING ONLY
--
-- IMPORTANT:
--   * REVIEW DRAFT ONLY. Do not execute until reviewed and approved.
--   * Creates schema/security structures only; mutation RPCs are in Migration 006.
--   * Does not create 2027 accounting periods.
--   * No client table-write privileges are granted by this migration.
--
-- Reuses the existing Accounting settings, periods, accounts, funds,
-- departments, journals, journal lines, audit log, and financial permission
-- helpers. Budgets use the church's functional currency.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- 0. Fail-closed preflight
DO $preflight$
BEGIN
    IF CURRENT_USER <> 'postgres' THEN
        RAISE EXCEPTION
            'Budget migration preflight failed: execute this migration as postgres';
    END IF;

    IF pg_catalog.to_regclass('public.accounting_settings') IS NULL
       OR pg_catalog.to_regclass('public.accounting_periods') IS NULL
       OR pg_catalog.to_regclass('public.accounting_accounts') IS NULL
       OR pg_catalog.to_regclass('public.accounting_funds') IS NULL
       OR pg_catalog.to_regclass('public.accounting_departments') IS NULL
       OR pg_catalog.to_regclass('public.accounting_audit_log') IS NULL THEN
        RAISE EXCEPTION
            'Budget migration preflight failed: required Accounting migrations 001-003 are not installed';
    END IF;

    IF pg_catalog.to_regprocedure('public.has_church_financial_permission(uuid,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.assert_church_accounting_permission(uuid,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.accounting_prevent_audit_mutation()') IS NULL THEN
        RAISE EXCEPTION
            'Budget migration preflight failed: required financial permission/audit helper functions are missing';
    END IF;

    IF pg_catalog.to_regclass('public.accounting_budgets') IS NOT NULL
       OR pg_catalog.to_regclass('public.accounting_budget_lines') IS NOT NULL
       OR pg_catalog.to_regclass('public.accounting_budget_allocations') IS NOT NULL
       OR pg_catalog.to_regclass('public.accounting_budget_approvals') IS NOT NULL THEN
        RAISE EXCEPTION
            'Budget migration preflight failed: one or more budget tables already exist';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.accounting_audit_log'::regclass
          AND conname = 'accounting_audit_log_action_chk'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.accounting_audit_log'::regclass
          AND conname = 'accounting_audit_log_entity_chk'
    ) THEN
        RAISE EXCEPTION
            'Budget migration preflight failed: expected Accounting audit constraints were not found';
    END IF;

    IF pg_catalog.to_regprocedure('public.accounting_budget_set_updated_at()') IS NOT NULL THEN
        RAISE EXCEPTION
            'Budget migration preflight failed: accounting_budget_set_updated_at() already exists';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_policy
        WHERE polname IN (
            'accounting_budgets_financial_read',
            'accounting_budget_lines_financial_read',
            'accounting_budget_allocations_financial_read',
            'accounting_budget_approvals_financial_read'
        )
    ) THEN
        RAISE EXCEPTION
            'Budget migration preflight failed: one or more budget policy names are already in use';
    END IF;
END;
$preflight$;

-- 1. Budget header and version chain
CREATE TABLE public.accounting_budgets (
    id UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    budget_code TEXT NOT NULL,
    budget_name TEXT NOT NULL,
    fiscal_year_start DATE NOT NULL,
    fiscal_year_end DATE NOT NULL,
    functional_currency TEXT NOT NULL,
    revision_number INTEGER NOT NULL DEFAULT 1,
    parent_budget_id UUID,
    status TEXT NOT NULL DEFAULT 'draft',
    created_by UUID,
    submitted_by UUID,
    approved_by UUID,
    submitted_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),

    CONSTRAINT accounting_budgets_pkey PRIMARY KEY (id),
    CONSTRAINT accounting_budgets_church_id_id_uk UNIQUE (church_id, id),
    CONSTRAINT accounting_budgets_church_year_id_uk
        UNIQUE (church_id, fiscal_year_start, id),
    CONSTRAINT accounting_budgets_code_uk UNIQUE (church_id, budget_code),
    CONSTRAINT accounting_budgets_revision_uk
        UNIQUE (church_id, fiscal_year_start, revision_number),

    CONSTRAINT accounting_budgets_church_fk
        FOREIGN KEY (church_id)
        REFERENCES public.churches (id) ON DELETE RESTRICT,
    CONSTRAINT accounting_budgets_parent_fk
        FOREIGN KEY (church_id, fiscal_year_start, parent_budget_id)
        REFERENCES public.accounting_budgets (church_id, fiscal_year_start, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_budgets_created_by_fk
        FOREIGN KEY (created_by) REFERENCES auth.users (id) ON DELETE SET NULL,
    CONSTRAINT accounting_budgets_submitted_by_fk
        FOREIGN KEY (submitted_by) REFERENCES auth.users (id) ON DELETE SET NULL,
    CONSTRAINT accounting_budgets_approved_by_fk
        FOREIGN KEY (approved_by) REFERENCES auth.users (id) ON DELETE SET NULL,

    CONSTRAINT accounting_budgets_code_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(budget_code)) BETWEEN 1 AND 64),
    CONSTRAINT accounting_budgets_name_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(budget_name)) BETWEEN 1 AND 150),
    CONSTRAINT accounting_budgets_fiscal_dates_chk
        CHECK (
            pg_catalog.date_part('day', fiscal_year_start)::INTEGER = 1
            AND fiscal_year_end =
                ((fiscal_year_start + INTERVAL '1 year')::DATE - 1)
        ),
    CONSTRAINT accounting_budgets_currency_chk
        CHECK (functional_currency IN ('UGX', 'USD')),
    CONSTRAINT accounting_budgets_revision_number_chk
        CHECK (revision_number >= 1),
    CONSTRAINT accounting_budgets_parent_revision_chk
        CHECK (
            (revision_number = 1 AND parent_budget_id IS NULL)
            OR (revision_number > 1 AND parent_budget_id IS NOT NULL)
        ),
    CONSTRAINT accounting_budgets_no_self_parent_chk
        CHECK (parent_budget_id IS NULL OR parent_budget_id <> id),
    CONSTRAINT accounting_budgets_status_chk
        CHECK (status IN (
            'draft', 'submitted', 'returned', 'rejected',
            'approved', 'superseded', 'cancelled'
        )),
    CONSTRAINT accounting_budgets_submitted_state_chk
        CHECK (
            status NOT IN ('submitted', 'returned', 'rejected', 'approved', 'superseded')
            OR submitted_at IS NOT NULL
        ),
    CONSTRAINT accounting_budgets_approved_state_chk
        CHECK (
            status NOT IN ('approved', 'superseded')
            OR approved_at IS NOT NULL
        )
);

-- A church has one current approved version and one in-progress version for a
-- fiscal year. Historical rejected/cancelled/superseded versions are retained.
CREATE UNIQUE INDEX accounting_budgets_one_approved_per_year_uk
    ON public.accounting_budgets (church_id, fiscal_year_start)
    WHERE status = 'approved';

CREATE UNIQUE INDEX accounting_budgets_one_in_progress_per_year_uk
    ON public.accounting_budgets (church_id, fiscal_year_start)
    WHERE status IN ('draft', 'submitted', 'returned');

CREATE INDEX accounting_budgets_church_status_year_idx
    ON public.accounting_budgets (church_id, status, fiscal_year_start DESC);

-- 2. Budget lines: same-church account, fund, and optional department.
CREATE TABLE public.accounting_budget_lines (
    id UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    budget_id UUID NOT NULL,
    line_number INTEGER NOT NULL,
    account_id UUID NOT NULL,
    fund_id UUID NOT NULL,
    department_id UUID,
    line_description TEXT NOT NULL,
    created_by UUID,
    updated_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),

    CONSTRAINT accounting_budget_lines_pkey PRIMARY KEY (id),
    CONSTRAINT accounting_budget_lines_church_id_id_uk UNIQUE (church_id, id),
    CONSTRAINT accounting_budget_lines_church_budget_id_uk
        UNIQUE (church_id, budget_id, id),
    CONSTRAINT accounting_budget_lines_number_uk
        UNIQUE (church_id, budget_id, line_number),

    CONSTRAINT accounting_budget_lines_budget_fk
        FOREIGN KEY (church_id, budget_id)
        REFERENCES public.accounting_budgets (church_id, id) ON DELETE RESTRICT,
    CONSTRAINT accounting_budget_lines_account_fk
        FOREIGN KEY (church_id, account_id)
        REFERENCES public.accounting_accounts (church_id, id) ON DELETE RESTRICT,
    CONSTRAINT accounting_budget_lines_fund_fk
        FOREIGN KEY (church_id, fund_id)
        REFERENCES public.accounting_funds (church_id, id) ON DELETE RESTRICT,
    CONSTRAINT accounting_budget_lines_department_fk
        FOREIGN KEY (church_id, department_id)
        REFERENCES public.accounting_departments (church_id, id) ON DELETE RESTRICT,
    CONSTRAINT accounting_budget_lines_created_by_fk
        FOREIGN KEY (created_by) REFERENCES auth.users (id) ON DELETE SET NULL,
    CONSTRAINT accounting_budget_lines_updated_by_fk
        FOREIGN KEY (updated_by) REFERENCES auth.users (id) ON DELETE SET NULL,

    CONSTRAINT accounting_budget_lines_number_chk CHECK (line_number > 0),
    CONSTRAINT accounting_budget_lines_description_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(line_description)) BETWEEN 1 AND 300),
    CONSTRAINT accounting_budget_lines_department_sentinel_chk
        CHECK (
            department_id IS NULL
            OR department_id <> '00000000-0000-0000-0000-000000000000'::UUID
        )
);

-- NULL department is treated as one distinct dimension. The all-zero UUID is
-- reserved as the COALESCE sentinel and prohibited by the CHECK above.
CREATE UNIQUE INDEX accounting_budget_lines_dimension_uk
    ON public.accounting_budget_lines (
        church_id,
        budget_id,
        account_id,
        fund_id,
        COALESCE(department_id, '00000000-0000-0000-0000-000000000000'::UUID)
    );

CREATE INDEX accounting_budget_lines_budget_idx
    ON public.accounting_budget_lines (church_id, budget_id, line_number);

CREATE INDEX accounting_budget_lines_account_idx
    ON public.accounting_budget_lines (church_id, account_id, fund_id, department_id);

-- 3. Monthly allocations reference existing same-church monthly periods.
CREATE TABLE public.accounting_budget_allocations (
    id UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    budget_id UUID NOT NULL,
    budget_line_id UUID NOT NULL,
    accounting_period_id UUID NOT NULL,
    budgeted_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
    created_by UUID,
    updated_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),

    CONSTRAINT accounting_budget_allocations_pkey PRIMARY KEY (id),
    CONSTRAINT accounting_budget_allocations_church_id_id_uk UNIQUE (church_id, id),
    CONSTRAINT accounting_budget_allocations_line_period_uk
        UNIQUE (church_id, budget_line_id, accounting_period_id),

    CONSTRAINT accounting_budget_allocations_line_fk
        FOREIGN KEY (church_id, budget_id, budget_line_id)
        REFERENCES public.accounting_budget_lines (church_id, budget_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_budget_allocations_period_fk
        FOREIGN KEY (church_id, accounting_period_id)
        REFERENCES public.accounting_periods (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_budget_allocations_created_by_fk
        FOREIGN KEY (created_by) REFERENCES auth.users (id) ON DELETE SET NULL,
    CONSTRAINT accounting_budget_allocations_updated_by_fk
        FOREIGN KEY (updated_by) REFERENCES auth.users (id) ON DELETE SET NULL,

    CONSTRAINT accounting_budget_allocations_amount_chk
        CHECK (budgeted_amount >= 0),
    CONSTRAINT accounting_budget_allocations_finite_amount_chk
        CHECK (budgeted_amount::TEXT NOT IN ('NaN', 'Infinity', '-Infinity'))
);

CREATE INDEX accounting_budget_allocations_budget_period_idx
    ON public.accounting_budget_allocations (church_id, budget_id, accounting_period_id);

CREATE INDEX accounting_budget_allocations_period_idx
    ON public.accounting_budget_allocations (church_id, accounting_period_id);

-- 4. Immutable workflow decision history.
CREATE TABLE public.accounting_budget_approvals (
    id UUID NOT NULL DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    budget_id UUID NOT NULL,
    actor_user_id UUID,
    action TEXT NOT NULL,
    from_status TEXT,
    to_status TEXT NOT NULL,
    reason TEXT,
    metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),

    CONSTRAINT accounting_budget_approvals_pkey PRIMARY KEY (id),
    CONSTRAINT accounting_budget_approvals_church_id_id_uk UNIQUE (church_id, id),
    CONSTRAINT accounting_budget_approvals_budget_fk
        FOREIGN KEY (church_id, budget_id)
        REFERENCES public.accounting_budgets (church_id, id) ON DELETE RESTRICT,
    -- actor_user_id intentionally has no auth.users FK. This immutable
    -- history reference must survive user deletion without an FK-driven UPDATE.
    CONSTRAINT accounting_budget_approvals_action_chk
        CHECK (action IN (
            'submitted', 'returned', 'rejected',
            'approved', 'superseded', 'cancelled'
        )),
    CONSTRAINT accounting_budget_approvals_from_status_chk
        CHECK (
            from_status IS NULL
            OR from_status IN (
                'draft', 'submitted', 'returned', 'rejected',
                'approved', 'superseded', 'cancelled'
            )
        ),
    CONSTRAINT accounting_budget_approvals_to_status_chk
        CHECK (to_status IN (
            'draft', 'submitted', 'returned', 'rejected',
            'approved', 'superseded', 'cancelled'
        )),
    CONSTRAINT accounting_budget_approvals_reason_chk
        CHECK (
            reason IS NULL
            OR pg_catalog.length(pg_catalog.btrim(reason)) BETWEEN 1 AND 500
        ),
    CONSTRAINT accounting_budget_approvals_metadata_chk
        CHECK (pg_catalog.jsonb_typeof(metadata) = 'object'),
    CONSTRAINT accounting_budget_approvals_reason_required_chk
        CHECK (
            action NOT IN ('returned', 'rejected', 'cancelled')
            OR pg_catalog.length(pg_catalog.btrim(COALESCE(reason, ''))) BETWEEN 10 AND 500
        )
);

CREATE INDEX accounting_budget_approvals_budget_created_idx
    ON public.accounting_budget_approvals (church_id, budget_id, created_at DESC);

-- 5. Extend the existing append-only Accounting audit log for budget activity.
ALTER TABLE public.accounting_audit_log
    DROP CONSTRAINT accounting_audit_log_action_chk;

ALTER TABLE public.accounting_audit_log
    ADD CONSTRAINT accounting_audit_log_action_chk
    CHECK (action IN (
        -- Migration 003 setup/configuration actions.
        'initialized',
        'settings_updated',
        'department_created',
        'fund_created',
        'account_created',
        'fiscal_year_created',
        -- Preserve all Migration 004 journal/source-event actions.
        'journal_created',
        'journal_updated',
        'journal_submitted',
        'journal_approved',
        'journal_posted',
        'journal_reversal_requested',
        'journal_reversal_posted',
        'journal_voided',
        'giving_mapping_updated',
        'journal_approval_threshold_updated',
        'payment_event_recorded',
        'payment_event_review_required',
        'payment_event_no_journal_to_reverse',
        'journal_returned_to_draft',
        -- New budgeting actions.
        'budget_created',
        'budget_revision_created',
        'budget_line_created',
        'budget_line_updated',
        'budget_line_deleted',
        'budget_allocation_updated',
        'budget_submitted',
        'budget_returned',
        'budget_rejected',
        'budget_approved',
        'budget_superseded',
        'budget_cancelled'
    ));

ALTER TABLE public.accounting_audit_log
    DROP CONSTRAINT accounting_audit_log_entity_chk;

ALTER TABLE public.accounting_audit_log
    ADD CONSTRAINT accounting_audit_log_entity_chk
    CHECK (entity_type IN (
        -- Preserve Migration 003 and Migration 004 entity types.
        'church_setup',
        'accounting_settings',
        'department',
        'fund',
        'account',
        'accounting_period',
        'journal',
        'giving_category_mapping',
        'source_event',
        -- New budgeting entity types.
        'budget',
        'budget_line',
        'budget_allocation'
    ));

-- 6. Shared updated_at trigger helper for budget tables.
CREATE FUNCTION public.accounting_budget_set_updated_at()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
    NEW.updated_at := pg_catalog.clock_timestamp();
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.accounting_budget_set_updated_at() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accounting_budget_set_updated_at()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER accounting_budgets_set_updated_at
    BEFORE UPDATE ON public.accounting_budgets
    FOR EACH ROW EXECUTE FUNCTION public.accounting_budget_set_updated_at();

CREATE TRIGGER accounting_budget_lines_set_updated_at
    BEFORE UPDATE ON public.accounting_budget_lines
    FOR EACH ROW EXECUTE FUNCTION public.accounting_budget_set_updated_at();

CREATE TRIGGER accounting_budget_allocations_set_updated_at
    BEFORE UPDATE ON public.accounting_budget_allocations
    FOR EACH ROW EXECUTE FUNCTION public.accounting_budget_set_updated_at();

CREATE TRIGGER accounting_budget_approvals_append_only
    BEFORE UPDATE OR DELETE ON public.accounting_budget_approvals
    FOR EACH ROW EXECUTE FUNCTION public.accounting_prevent_audit_mutation();

-- Row-level triggers do not fire for TRUNCATE; protect the history table at
-- statement level as well.
CREATE TRIGGER accounting_budget_approvals_no_truncate
    BEFORE TRUNCATE ON public.accounting_budget_approvals
    FOR EACH STATEMENT EXECUTE FUNCTION public.accounting_prevent_audit_mutation();

-- 7. RLS, ownership, and least-privilege table grants.
ALTER TABLE public.accounting_budgets OWNER TO postgres;
ALTER TABLE public.accounting_budget_lines OWNER TO postgres;
ALTER TABLE public.accounting_budget_allocations OWNER TO postgres;
ALTER TABLE public.accounting_budget_approvals OWNER TO postgres;

ALTER TABLE public.accounting_budgets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_budgets FORCE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_budget_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_budget_lines FORCE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_budget_allocations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_budget_allocations FORCE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_budget_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.accounting_budget_approvals FORCE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.accounting_budgets
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.accounting_budget_lines
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.accounting_budget_allocations
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON TABLE public.accounting_budget_approvals
    FROM PUBLIC, anon, authenticated, service_role;

GRANT SELECT ON TABLE public.accounting_budgets TO authenticated;
GRANT SELECT ON TABLE public.accounting_budget_lines TO authenticated;
GRANT SELECT ON TABLE public.accounting_budget_allocations TO authenticated;
GRANT SELECT ON TABLE public.accounting_budget_approvals TO authenticated;

CREATE POLICY accounting_budgets_financial_read
    ON public.accounting_budgets
    FOR SELECT TO authenticated
    USING (
        public.has_church_financial_permission(
            church_id,
            'accounting.budgets.read'
        )
    );

CREATE POLICY accounting_budget_lines_financial_read
    ON public.accounting_budget_lines
    FOR SELECT TO authenticated
    USING (
        public.has_church_financial_permission(
            church_id,
            'accounting.budgets.read'
        )
    );

CREATE POLICY accounting_budget_allocations_financial_read
    ON public.accounting_budget_allocations
    FOR SELECT TO authenticated
    USING (
        public.has_church_financial_permission(
            church_id,
            'accounting.budgets.read'
        )
    );

CREATE POLICY accounting_budget_approvals_financial_read
    ON public.accounting_budget_approvals
    FOR SELECT TO authenticated
    USING (
        public.has_church_financial_permission(
            church_id,
            'accounting.budgets.read'
        )
    );

-- No client INSERT/UPDATE/DELETE/TRUNCATE privileges are granted. Reviewed
-- SECURITY DEFINER mutation RPCs will be introduced in Migration 006.

-- 8. Documentation.
COMMENT ON TABLE public.accounting_budgets IS
    'Church-scoped annual operating budgets. Each version is retained; one approved version is current for a church/fiscal year. Fiscal dates and functional currency are snapshots validated by secure RPCs.';

COMMENT ON TABLE public.accounting_budget_lines IS
    'Budget lines tied to same-church income or expense accounts, funds, and optional departments. Account type, activity, and direct-posting eligibility are validated by secure RPCs.';

COMMENT ON TABLE public.accounting_budget_allocations IS
    'Monthly budget amounts tied to existing same-church monthly accounting periods. Annual line totals are calculated from monthly allocations.';

COMMENT ON TABLE public.accounting_budget_approvals IS
    'Append-only workflow decision history for budget submission, return, rejection, approval, supersession, and cancellation. Visible to users with accounting.budgets.read.';

COMMENT ON COLUMN public.accounting_budgets.parent_budget_id IS
    'Previous version in the same church and fiscal year. New versions are created through a secure revision RPC; previous approved versions are retained as superseded.';

COMMENT ON COLUMN public.accounting_budget_allocations.budgeted_amount IS
    'Nonnegative monthly amount in the parent budget functional currency. UGX integer precision and USD two-decimal precision are validated by secure RPCs.';

COMMENT ON TABLE public.accounting_audit_log IS
    'Append-only church-scoped audit trail for accounting configuration, ledger activity, and budgeting actions. Reads require accounting.audit.read; writes are performed only through secure RPCs.';

COMMIT;

-- END DRAFT MIGRATION 005
