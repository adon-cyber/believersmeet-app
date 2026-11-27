-- ============================================================================
-- BelieversMeet Accounting & Budgeting
-- Migration 006 (DRAFT): Secure budget workflow and budget-vs-actual reporting
-- Target: STAGING ONLY
--
-- IMPORTANT:
--   * REVIEW DRAFT ONLY. Do not execute until Migration 005 and this file have
--     both been reviewed against the live Staging schema.
--   * Requires Migrations 001-004 and reviewed/installed Migration 005.
--   * Does not create or modify fiscal periods. A Finance Administrator must
--     create next-year monthly periods through the existing secure RPC first.
--   * Client writes remain limited to these SECURITY DEFINER RPCs. No direct
--     INSERT/UPDATE/DELETE grants are added to budget tables.
--
-- Workflow:
--   draft -> submitted -> returned -> submitted -> approved
--                     -> rejected
--   A new revision is copied from an approved or rejected version. Approval of
--   a new revision supersedes the previous approved version without deleting it.
--   A submitter cannot approve, return, or reject their own submission.
--
-- Reporting:
--   Actuals include BOTH posted and reversed journals. A reversed original
--   remains in the ledger; its separately posted reversing journal offsets it.
--   Income actual = credits - debits; expense actual = debits - credits.
-- ============================================================================

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '120s';

-- ---------------------------------------------------------------------------
-- 0. Fail-closed preflight
-- ---------------------------------------------------------------------------
DO $preflight$
DECLARE
    v_required RECORD;
BEGIN
    IF CURRENT_USER <> 'postgres' THEN
        RAISE EXCEPTION 'Budget workflow preflight failed: execute as postgres';
    END IF;

    IF pg_catalog.to_regprocedure('public.has_church_financial_permission(uuid,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.assert_church_accounting_permission(uuid,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.accounting_prevent_audit_mutation()') IS NULL THEN
        RAISE EXCEPTION 'Budget workflow preflight failed: required permission/audit helpers are missing';
    END IF;

    IF pg_catalog.to_regclass('public.accounting_budgets') IS NULL
       OR pg_catalog.to_regclass('public.accounting_budget_lines') IS NULL
       OR pg_catalog.to_regclass('public.accounting_budget_allocations') IS NULL
       OR pg_catalog.to_regclass('public.accounting_budget_approvals') IS NULL
       OR pg_catalog.to_regclass('public.accounting_settings') IS NULL
       OR pg_catalog.to_regclass('public.accounting_periods') IS NULL
       OR pg_catalog.to_regclass('public.accounting_accounts') IS NULL
       OR pg_catalog.to_regclass('public.accounting_funds') IS NULL
       OR pg_catalog.to_regclass('public.accounting_departments') IS NULL
       OR pg_catalog.to_regclass('public.accounting_journals') IS NULL
       OR pg_catalog.to_regclass('public.accounting_journal_lines') IS NULL
       OR pg_catalog.to_regclass('public.accounting_audit_log') IS NULL
       OR pg_catalog.to_regclass('public.church_financial_role_permissions') IS NULL
       OR pg_catalog.to_regclass('public.church_financial_roles') IS NULL THEN
        RAISE EXCEPTION 'Budget workflow preflight failed: migrations 001-005 are not fully installed';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (VALUES
            ('accounting_budgets', 'church_id'),
            ('accounting_budgets', 'fiscal_year_start'),
            ('accounting_budgets', 'fiscal_year_end'),
            ('accounting_budgets', 'functional_currency'),
            ('accounting_budgets', 'revision_number'),
            ('accounting_budgets', 'parent_budget_id'),
            ('accounting_budgets', 'status'),
            ('accounting_budgets', 'created_by'),
            ('accounting_budgets', 'submitted_by'),
            ('accounting_budget_lines', 'budget_id'),
            ('accounting_budget_lines', 'account_id'),
            ('accounting_budget_lines', 'fund_id'),
            ('accounting_budget_lines', 'department_id'),
            ('accounting_budget_allocations', 'budget_line_id'),
            ('accounting_budget_allocations', 'accounting_period_id'),
            ('accounting_budget_allocations', 'budgeted_amount'),
            ('accounting_budget_approvals', 'action'),
            ('accounting_budget_approvals', 'from_status'),
            ('accounting_budget_approvals', 'to_status'),
            ('accounting_settings', 'functional_currency'),
            ('accounting_settings', 'fiscal_year_start_month'),
            ('accounting_settings', 'setup_completed_at'),
            ('accounting_periods', 'period_type'),
            ('accounting_periods', 'start_date'),
            ('accounting_periods', 'end_date'),
            ('accounting_accounts', 'account_type'),
            ('accounting_accounts', 'allow_direct_posting'),
            ('accounting_accounts', 'is_active'),
            ('accounting_funds', 'is_active'),
            ('accounting_departments', 'is_active'),
            ('accounting_journals', 'period_id'),
            ('accounting_journals', 'status'),
            ('accounting_journal_lines', 'account_id'),
            ('accounting_journal_lines', 'fund_id'),
            ('accounting_journal_lines', 'department_id'),
            ('accounting_journal_lines', 'debit_amount'),
            ('accounting_journal_lines', 'credit_amount')
        ) AS expected(table_name, column_name)
        WHERE NOT EXISTS (
            SELECT 1
            FROM information_schema.columns c
            WHERE c.table_schema = 'public'
              AND c.table_name = expected.table_name
              AND c.column_name = expected.column_name
        )
    ) THEN
        RAISE EXCEPTION 'Budget workflow preflight failed: one or more required columns are missing';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (VALUES
            ('accounting_budgets'),
            ('accounting_budget_lines'),
            ('accounting_budget_allocations'),
            ('accounting_budget_approvals')
        ) AS expected(table_name)
        JOIN pg_catalog.pg_class c
          ON c.oid = pg_catalog.to_regclass('public.' || expected.table_name)
        WHERE c.relrowsecurity IS NOT TRUE OR c.relforcerowsecurity IS NOT TRUE
    ) THEN
        RAISE EXCEPTION 'Budget workflow preflight failed: all four budget tables must have RLS enabled and forced';
    END IF;

    FOR v_required IN
        SELECT * FROM (VALUES
            ('finance_administrator', 'accounting.budgets.read'),
            ('finance_administrator', 'accounting.budgets.manage'),
            ('finance_administrator', 'accounting.budgets.submit'),
            ('finance_administrator', 'accounting.budgets.approve'),
            ('budget_manager', 'accounting.budgets.read'),
            ('budget_manager', 'accounting.budgets.manage'),
            ('budget_manager', 'accounting.budgets.submit'),
            ('treasurer', 'accounting.budgets.read'),
            ('treasurer', 'accounting.budgets.approve'),
            ('accountant', 'accounting.budgets.read'),
            ('financial_approver', 'accounting.budgets.read'),
            ('financial_approver', 'accounting.budgets.approve'),
            ('financial_viewer', 'accounting.budgets.read')
        ) AS required(role_code, permission_key)
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM public.church_financial_roles r
            JOIN public.church_financial_role_permissions rp ON rp.role_id = r.id
            WHERE r.role_code = v_required.role_code
              AND rp.permission_key = v_required.permission_key
        ) THEN
            RAISE EXCEPTION 'Budget workflow preflight failed: missing permission mapping %.%',
                v_required.role_code, v_required.permission_key;
        END IF;
    END LOOP;

    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_trigger t
        WHERE NOT t.tgisinternal
          AND t.tgname IN (
              'accounting_budget_guard_settings_change',
              'accounting_budget_guard_period_calendar_change'
          )
    ) THEN
        RAISE EXCEPTION 'Budget workflow preflight failed: one or more Migration 006 trigger names are already in use';
    END IF;

    IF pg_catalog.to_regprocedure('public.accounting_budget_guard_settings_change()') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_budget_guard_period_calendar_change()') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_budget_validate_year(uuid,date,date,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_budget_validate_line(uuid,uuid,uuid,uuid)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_budget_assert_complete(uuid)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_budget_review_decision(uuid,text,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_create_budget(uuid,text,date)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_create_budget_revision(uuid,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_save_budget_line(uuid,uuid,integer,uuid,uuid,uuid,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_delete_budget_line(uuid)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_set_budget_allocation(uuid,uuid,numeric)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_submit_budget(uuid)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_return_budget(uuid,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_reject_budget(uuid,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_approve_budget(uuid)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_cancel_budget(uuid,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_budget_vs_actual(uuid,uuid)') IS NOT NULL THEN
        RAISE EXCEPTION 'Budget workflow preflight failed: one or more Migration 006 function names are already in use';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.accounting_audit_log'::regclass
          AND conname = 'accounting_audit_log_action_chk'
          AND pg_catalog.pg_get_constraintdef(oid) LIKE '%budget_created%'
    ) OR NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.accounting_audit_log'::regclass
          AND conname = 'accounting_audit_log_entity_chk'
          AND pg_catalog.pg_get_constraintdef(oid) LIKE '%budget_line%'
    ) THEN
        RAISE EXCEPTION 'Budget workflow preflight failed: Migration 005 budget audit allowlists are not installed';
    END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. Protect the fiscal/currency configuration and period calendar used by
--    existing budgets. Status changes (e.g. open -> closed) remain permitted.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.accounting_budget_guard_settings_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
    IF (NEW.functional_currency IS DISTINCT FROM OLD.functional_currency
        OR NEW.fiscal_year_start_month IS DISTINCT FROM OLD.fiscal_year_start_month)
       AND EXISTS (
           SELECT 1
           FROM public.accounting_budgets b
           WHERE b.church_id = OLD.church_id
       ) THEN
        RAISE EXCEPTION 'Functional currency and fiscal-year start month cannot change after a church budget has been created' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$function$;

CREATE FUNCTION public.accounting_budget_guard_period_calendar_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
    IF (NEW.period_type IS DISTINCT FROM OLD.period_type
        OR NEW.start_date IS DISTINCT FROM OLD.start_date
        OR NEW.end_date IS DISTINCT FROM OLD.end_date)
       AND EXISTS (
           SELECT 1
           FROM public.accounting_budgets b
           WHERE b.church_id = OLD.church_id
             AND (
                 (b.fiscal_year_start <= OLD.end_date AND b.fiscal_year_end >= OLD.start_date)
                 OR (b.fiscal_year_start <= NEW.end_date AND b.fiscal_year_end >= NEW.start_date)
             )
       ) THEN
        RAISE EXCEPTION 'Accounting period type and calendar dates cannot change while a budget exists for the affected fiscal year' USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.accounting_budget_guard_settings_change() OWNER TO postgres;
ALTER FUNCTION public.accounting_budget_guard_period_calendar_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accounting_budget_guard_settings_change() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_budget_guard_period_calendar_change() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER accounting_budget_guard_settings_change
    BEFORE UPDATE OF functional_currency, fiscal_year_start_month
    ON public.accounting_settings
    FOR EACH ROW EXECUTE FUNCTION public.accounting_budget_guard_settings_change();

CREATE TRIGGER accounting_budget_guard_period_calendar_change
    BEFORE UPDATE OF period_type, start_date, end_date
    ON public.accounting_periods
    FOR EACH ROW EXECUTE FUNCTION public.accounting_budget_guard_period_calendar_change();

-- ---------------------------------------------------------------------------
-- 2. Internal validators. These are callable only by owner-executed RPCs.
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.accounting_budget_validate_year(
    p_church_id UUID,
    p_fiscal_year_start DATE,
    p_fiscal_year_end DATE,
    p_currency TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_currency TEXT;
    v_fiscal_month SMALLINT;
    v_setup_completed_at TIMESTAMPTZ;
    v_month_start DATE;
    v_month_end DATE;
    v_period_count INTEGER;
    v_offset INTEGER;
BEGIN
    SELECT s.functional_currency, s.fiscal_year_start_month, s.setup_completed_at
      INTO v_currency, v_fiscal_month, v_setup_completed_at
      FROM public.accounting_settings s
     WHERE s.church_id = p_church_id
     FOR SHARE;

    IF NOT FOUND OR v_setup_completed_at IS NULL THEN
        RAISE EXCEPTION 'Church accounting must be initialized before budgeting' USING ERRCODE = '55000';
    END IF;

    IF p_fiscal_year_start IS NULL
       OR pg_catalog.date_part('day', p_fiscal_year_start)::INTEGER <> 1
       OR pg_catalog.date_part('month', p_fiscal_year_start)::INTEGER <> v_fiscal_month
       OR p_fiscal_year_end <> ((p_fiscal_year_start + INTERVAL '1 year')::DATE - 1) THEN
        RAISE EXCEPTION 'Budget fiscal dates must describe one complete fiscal year matching the church settings' USING ERRCODE = '23514';
    END IF;

    IF p_currency IS DISTINCT FROM v_currency THEN
        RAISE EXCEPTION 'Budget currency must equal the church functional currency (%)', v_currency USING ERRCODE = '23514';
    END IF;

    -- Lock the period calendar rows until this transaction commits. This keeps
    -- a concurrent period edit from invalidating the year while a budget is
    -- being created, submitted, or approved.
    PERFORM 1
    FROM public.accounting_periods p
    WHERE p.church_id = p_church_id
      AND p.start_date <= p_fiscal_year_end
      AND p.end_date >= p_fiscal_year_start
    FOR SHARE;

    FOR v_offset IN 0..11 LOOP
        v_month_start := (p_fiscal_year_start + pg_catalog.make_interval(months => v_offset))::DATE;
        v_month_end := ((v_month_start + INTERVAL '1 month')::DATE - 1);

        SELECT pg_catalog.count(*)::INTEGER
          INTO v_period_count
          FROM public.accounting_periods p
         WHERE p.church_id = p_church_id
           AND p.period_type = 'monthly'
           AND p.start_date = v_month_start
           AND p.end_date = v_month_end;

        IF v_period_count <> 1 THEN
            RAISE EXCEPTION 'Budgeting requires exactly one monthly accounting period for % through %; found %',
                v_month_start, v_month_end, v_period_count USING ERRCODE = '23514';
        END IF;
    END LOOP;
END;
$function$;

CREATE FUNCTION public.accounting_budget_validate_line(
    p_church_id UUID,
    p_account_id UUID,
    p_fund_id UUID,
    p_department_id UUID
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_account_type TEXT;
    v_account_active BOOLEAN;
    v_direct_posting BOOLEAN;
    v_fund_active BOOLEAN;
    v_department_active BOOLEAN;
BEGIN
    SELECT a.account_type, a.is_active, a.allow_direct_posting
      INTO v_account_type, v_account_active, v_direct_posting
      FROM public.accounting_accounts a
     WHERE a.church_id = p_church_id
       AND a.id = p_account_id
     FOR SHARE;

    IF NOT FOUND
       OR v_account_type NOT IN ('income', 'expense')
       OR v_account_active IS NOT TRUE
       OR v_direct_posting IS NOT TRUE THEN
        RAISE EXCEPTION 'Budget lines must use an active, direct-posting income or expense account belonging to this church' USING ERRCODE = '23514';
    END IF;

    SELECT f.is_active
      INTO v_fund_active
      FROM public.accounting_funds f
     WHERE f.church_id = p_church_id
       AND f.id = p_fund_id
     FOR SHARE;

    IF NOT FOUND OR v_fund_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Budget lines must use an active fund belonging to this church' USING ERRCODE = '23514';
    END IF;

    IF p_department_id IS NOT NULL THEN
        SELECT d.is_active
          INTO v_department_active
          FROM public.accounting_departments d
         WHERE d.church_id = p_church_id
           AND d.id = p_department_id
         FOR SHARE;

        IF NOT FOUND OR v_department_active IS NOT TRUE THEN
            RAISE EXCEPTION 'Budget lines must use an active department belonging to this church' USING ERRCODE = '23514';
        END IF;
    END IF;
END;
$function$;

CREATE FUNCTION public.accounting_budget_assert_complete(p_budget_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_church_id UUID;
    v_fiscal_start DATE;
    v_fiscal_end DATE;
    v_currency TEXT;
    v_line RECORD;
BEGIN
    SELECT b.church_id, b.fiscal_year_start, b.fiscal_year_end, b.functional_currency
      INTO v_church_id, v_fiscal_start, v_fiscal_end, v_currency
      FROM public.accounting_budgets b
     WHERE b.id = p_budget_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Budget was not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM public.accounting_budget_validate_year(
        v_church_id, v_fiscal_start, v_fiscal_end, v_currency
    );

    FOR v_line IN
        SELECT l.account_id, l.fund_id, l.department_id
        FROM public.accounting_budget_lines l
        WHERE l.church_id = v_church_id
          AND l.budget_id = p_budget_id
    LOOP
        PERFORM public.accounting_budget_validate_line(
            v_church_id, v_line.account_id, v_line.fund_id, v_line.department_id
        );
    END LOOP;

    IF NOT EXISTS (
        SELECT 1 FROM public.accounting_budget_lines l
        WHERE l.church_id = v_church_id AND l.budget_id = p_budget_id
    ) THEN
        RAISE EXCEPTION 'A budget must contain at least one line before submission' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.accounting_budget_lines l
        LEFT JOIN public.accounting_budget_allocations a
          ON a.church_id = l.church_id
         AND a.budget_id = l.budget_id
         AND a.budget_line_id = l.id
        LEFT JOIN public.accounting_periods p
          ON p.church_id = a.church_id
         AND p.id = a.accounting_period_id
        WHERE l.church_id = v_church_id
          AND l.budget_id = p_budget_id
        GROUP BY l.id
        HAVING pg_catalog.count(a.id) <> 12
            OR pg_catalog.count(a.id) FILTER (
                WHERE p.period_type = 'monthly'
                  AND p.start_date = pg_catalog.date_trunc('month', p.start_date)::DATE
                  AND p.end_date = ((p.start_date + INTERVAL '1 month')::DATE - 1)
                  AND p.start_date >= v_fiscal_start
                  AND p.end_date <= v_fiscal_end
            ) <> 12
    ) THEN
        RAISE EXCEPTION 'Every budget line must have one allocation for each of the 12 monthly accounting periods' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.accounting_budget_lines l
        JOIN public.accounting_budget_allocations a
          ON a.church_id = l.church_id
         AND a.budget_id = l.budget_id
         AND a.budget_line_id = l.id
        WHERE l.church_id = v_church_id
          AND l.budget_id = p_budget_id
          AND (
              a.budgeted_amount < 0
              OR a.budgeted_amount::TEXT IN ('NaN', 'Infinity', '-Infinity')
              OR pg_catalog.round(
                    a.budgeted_amount,
                    CASE v_currency WHEN 'UGX' THEN 0 ELSE 2 END
                 ) <> a.budgeted_amount
          )
    ) THEN
        RAISE EXCEPTION 'Budget allocations must be finite, nonnegative, and use the supported precision for %', v_currency USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.accounting_budget_lines l
        WHERE l.church_id = v_church_id
          AND l.budget_id = p_budget_id
          AND (
              NOT EXISTS (
                  SELECT 1 FROM public.accounting_accounts a
                  WHERE a.church_id = l.church_id
                    AND a.id = l.account_id
                    AND a.account_type IN ('income', 'expense')
                    AND a.is_active IS TRUE
                    AND a.allow_direct_posting IS TRUE
              )
              OR NOT EXISTS (
                  SELECT 1 FROM public.accounting_funds f
                  WHERE f.church_id = l.church_id
                    AND f.id = l.fund_id
                    AND f.is_active IS TRUE
              )
              OR (
                  l.department_id IS NOT NULL
                  AND NOT EXISTS (
                      SELECT 1 FROM public.accounting_departments d
                      WHERE d.church_id = l.church_id
                        AND d.id = l.department_id
                        AND d.is_active IS TRUE
                  )
              )
          )
    ) THEN
        RAISE EXCEPTION 'All budget accounts, funds, and departments must still be active and eligible at submission/approval' USING ERRCODE = '23514';
    END IF;
END;
$function$;

CREATE FUNCTION public.accounting_budget_review_decision(
    p_budget_id UUID,
    p_to_status TEXT,
    p_reason TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_status TEXT;
    v_submitted_by UUID;
BEGIN
    IF v_actor IS NULL OR p_budget_id IS NULL
       OR p_to_status IS NULL
       OR p_to_status NOT IN ('returned', 'rejected') THEN
        RAISE EXCEPTION 'Authentication, budget, and a valid review decision are required' USING ERRCODE = '42501';
    END IF;

    IF pg_catalog.length(pg_catalog.btrim(COALESCE(p_reason, ''))) NOT BETWEEN 10 AND 500 THEN
        RAISE EXCEPTION 'A review reason of 10 to 500 characters is required' USING ERRCODE = '22023';
    END IF;

    SELECT b.church_id INTO v_church_id
      FROM public.accounting_budgets b
     WHERE b.id = p_budget_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Budget was not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.budgets.approve');

    SELECT b.status, b.submitted_by
      INTO v_status, v_submitted_by
      FROM public.accounting_budgets b
     WHERE b.church_id = v_church_id
       AND b.id = p_budget_id
     FOR UPDATE;

    IF v_status <> 'submitted' THEN
        RAISE EXCEPTION 'Only submitted budgets can be returned or rejected' USING ERRCODE = '55000';
    END IF;

    IF v_submitted_by IS NULL OR v_submitted_by = v_actor THEN
        RAISE EXCEPTION 'The budget submitter cannot review their own submission' USING ERRCODE = '42501';
    END IF;

    UPDATE public.accounting_budgets
       SET status = p_to_status
     WHERE church_id = v_church_id AND id = p_budget_id;

    INSERT INTO public.accounting_budget_approvals (
        church_id, budget_id, actor_user_id, action,
        from_status, to_status, reason
    ) VALUES (
        v_church_id, p_budget_id, v_actor, p_to_status,
        'submitted', p_to_status, pg_catalog.btrim(p_reason)
    );

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor,
        CASE p_to_status WHEN 'returned' THEN 'budget_returned' ELSE 'budget_rejected' END,
        'budget', p_budget_id,
        CASE p_to_status WHEN 'returned' THEN 'Budget returned for revision.' ELSE 'Budget rejected.' END,
        pg_catalog.jsonb_build_object('reason', pg_catalog.btrim(p_reason))
    );
END;
$function$;

-- Internal helper ACLs: no client may call validators or transition helper.
ALTER FUNCTION public.accounting_budget_validate_year(UUID, DATE, DATE, TEXT) OWNER TO postgres;
ALTER FUNCTION public.accounting_budget_validate_line(UUID, UUID, UUID, UUID) OWNER TO postgres;
ALTER FUNCTION public.accounting_budget_assert_complete(UUID) OWNER TO postgres;
ALTER FUNCTION public.accounting_budget_review_decision(UUID, TEXT, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accounting_budget_validate_year(UUID, DATE, DATE, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_budget_validate_line(UUID, UUID, UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_budget_assert_complete(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_budget_review_decision(UUID, TEXT, TEXT) FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 3. Create initial budget and create a full copy as a new revision
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.accounting_create_budget(
    p_church_id UUID,
    p_budget_name TEXT,
    p_fiscal_year_start DATE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_currency TEXT;
    v_fiscal_end DATE;
    v_budget_id UUID;
    v_budget_code TEXT;
BEGIN
    IF v_actor IS NULL OR p_church_id IS NULL OR p_fiscal_year_start IS NULL THEN
        RAISE EXCEPTION 'Authentication, church, and fiscal-year start are required' USING ERRCODE = '42501';
    END IF;

    IF pg_catalog.length(pg_catalog.btrim(COALESCE(p_budget_name, ''))) NOT BETWEEN 1 AND 150 THEN
        RAISE EXCEPTION 'Budget name must contain 1 to 150 characters' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(p_church_id, 'accounting.budgets.manage');

    SELECT s.functional_currency
      INTO v_currency
      FROM public.accounting_settings s
     WHERE s.church_id = p_church_id
       AND s.setup_completed_at IS NOT NULL
     FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Church accounting has not been initialized' USING ERRCODE = '55000';
    END IF;

    v_fiscal_end := ((p_fiscal_year_start + INTERVAL '1 year')::DATE - 1);
    PERFORM public.accounting_budget_validate_year(
        p_church_id, p_fiscal_year_start, v_fiscal_end, v_currency
    );

    IF EXISTS (
        SELECT 1 FROM public.accounting_budgets b
        WHERE b.church_id = p_church_id
          AND b.fiscal_year_start = p_fiscal_year_start
    ) THEN
        RAISE EXCEPTION 'A budget version already exists for this fiscal year. Create a revision from the relevant existing version.' USING ERRCODE = '23505';
    END IF;

    v_budget_code := 'BUD-' || pg_catalog.to_char(p_fiscal_year_start, 'YYYY');

    INSERT INTO public.accounting_budgets (
        church_id, budget_code, budget_name,
        fiscal_year_start, fiscal_year_end, functional_currency,
        revision_number, parent_budget_id, status, created_by
    ) VALUES (
        p_church_id, v_budget_code, pg_catalog.btrim(p_budget_name),
        p_fiscal_year_start, v_fiscal_end, v_currency,
        1, NULL, 'draft', v_actor
    ) RETURNING id INTO v_budget_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        p_church_id, v_actor, 'budget_created', 'budget', v_budget_id,
        'Initial annual budget created.',
        pg_catalog.jsonb_build_object(
            'budget_code', v_budget_code,
            'fiscal_year_start', p_fiscal_year_start,
            'fiscal_year_end', v_fiscal_end,
            'functional_currency', v_currency
        )
    );

    RETURN v_budget_id;
END;
$function$;

CREATE FUNCTION public.accounting_create_budget_revision(
    p_source_budget_id UUID,
    p_budget_name TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_fiscal_start DATE;
    v_fiscal_end DATE;
    v_currency TEXT;
    v_source_status TEXT;
    v_source_name TEXT;
    v_source_revision INTEGER;
    v_revision INTEGER;
    v_new_budget_id UUID;
    v_budget_code TEXT;
BEGIN
    IF v_actor IS NULL OR p_source_budget_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and source budget are required' USING ERRCODE = '42501';
    END IF;

    SELECT b.church_id INTO v_church_id
      FROM public.accounting_budgets b
     WHERE b.id = p_source_budget_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Source budget was not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.budgets.manage');

    SELECT b.fiscal_year_start, b.fiscal_year_end, b.functional_currency,
           b.status, b.budget_name, b.revision_number
      INTO v_fiscal_start, v_fiscal_end, v_currency, v_source_status, v_source_name, v_source_revision
      FROM public.accounting_budgets b
     WHERE b.church_id = v_church_id
       AND b.id = p_source_budget_id
     FOR UPDATE;

    IF v_source_status NOT IN ('approved', 'rejected', 'cancelled') THEN
        RAISE EXCEPTION 'A revision may be created only from an approved, rejected, or cancelled budget version' USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.accounting_budgets b
        WHERE b.church_id = v_church_id
          AND b.fiscal_year_start = v_fiscal_start
          AND b.revision_number > v_source_revision
    ) THEN
        RAISE EXCEPTION 'A new revision must be copied from the latest budget version to preserve a linear revision history' USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.accounting_budgets b
        WHERE b.church_id = v_church_id
          AND b.fiscal_year_start = v_fiscal_start
          AND b.status IN ('draft', 'submitted', 'returned')
    ) THEN
        RAISE EXCEPTION 'An in-progress budget version already exists for this fiscal year' USING ERRCODE = '23505';
    END IF;

    PERFORM public.accounting_budget_validate_year(
        v_church_id, v_fiscal_start, v_fiscal_end, v_currency
    );

    SELECT COALESCE(pg_catalog.max(b.revision_number), 0) + 1
      INTO v_revision
      FROM public.accounting_budgets b
     WHERE b.church_id = v_church_id
       AND b.fiscal_year_start = v_fiscal_start;

    v_budget_code := 'BUD-' || pg_catalog.to_char(v_fiscal_start, 'YYYY')
                     || '-R' || pg_catalog.lpad(v_revision::TEXT, 2, '0');

    INSERT INTO public.accounting_budgets (
        church_id, budget_code, budget_name,
        fiscal_year_start, fiscal_year_end, functional_currency,
        revision_number, parent_budget_id, status, created_by
    ) VALUES (
        v_church_id, v_budget_code,
        COALESCE(
            NULLIF(pg_catalog.btrim(COALESCE(p_budget_name, '')), ''),
            v_source_name
        ),
        v_fiscal_start, v_fiscal_end, v_currency,
        v_revision, p_source_budget_id, 'draft', v_actor
    ) RETURNING id INTO v_new_budget_id;

    WITH copied_lines AS (
        INSERT INTO public.accounting_budget_lines (
            church_id, budget_id, line_number, account_id, fund_id,
            department_id, line_description, created_by, updated_by
        )
        SELECT
            l.church_id, v_new_budget_id, l.line_number, l.account_id, l.fund_id,
            l.department_id, l.line_description, v_actor, v_actor
        FROM public.accounting_budget_lines l
        WHERE l.church_id = v_church_id
          AND l.budget_id = p_source_budget_id
        RETURNING id, line_number
    ), line_map AS (
        SELECT old_l.id AS old_line_id, new_l.id AS new_line_id
        FROM public.accounting_budget_lines old_l
        JOIN copied_lines new_l ON new_l.line_number = old_l.line_number
        WHERE old_l.church_id = v_church_id
          AND old_l.budget_id = p_source_budget_id
    )
    INSERT INTO public.accounting_budget_allocations (
        church_id, budget_id, budget_line_id, accounting_period_id,
        budgeted_amount, created_by, updated_by
    )
    SELECT
        a.church_id, v_new_budget_id, m.new_line_id, a.accounting_period_id,
        a.budgeted_amount, v_actor, v_actor
    FROM public.accounting_budget_allocations a
    JOIN line_map m ON m.old_line_id = a.budget_line_id
    WHERE a.church_id = v_church_id
      AND a.budget_id = p_source_budget_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'budget_revision_created', 'budget', v_new_budget_id,
        'New budget revision copied from an earlier version.',
        pg_catalog.jsonb_build_object(
            'source_budget_id', p_source_budget_id,
            'revision_number', v_revision,
            'budget_code', v_budget_code
        )
    );

    RETURN v_new_budget_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 4. Draft/returned budget line and monthly allocation maintenance
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.accounting_save_budget_line(
    p_budget_id UUID,
    p_line_id UUID,
    p_line_number INTEGER,
    p_account_id UUID,
    p_fund_id UUID,
    p_department_id UUID,
    p_line_description TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_status TEXT;
    v_line_id UUID;
    v_old_line_number INTEGER;
BEGIN
    IF v_actor IS NULL OR p_budget_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and budget are required' USING ERRCODE = '42501';
    END IF;

    IF p_line_number IS NULL OR p_line_number <= 0
       OR pg_catalog.length(pg_catalog.btrim(COALESCE(p_line_description, ''))) NOT BETWEEN 1 AND 300
       OR p_account_id IS NULL OR p_fund_id IS NULL THEN
        RAISE EXCEPTION 'Line number, account, fund, and a 1-to-300 character description are required' USING ERRCODE = '22023';
    END IF;

    SELECT b.church_id INTO v_church_id
      FROM public.accounting_budgets b
     WHERE b.id = p_budget_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Budget was not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.budgets.manage');

    SELECT b.status
      INTO v_status
      FROM public.accounting_budgets b
     WHERE b.church_id = v_church_id AND b.id = p_budget_id
     FOR UPDATE;

    IF v_status NOT IN ('draft', 'returned') THEN
        RAISE EXCEPTION 'Only draft or returned budgets can be edited' USING ERRCODE = '55000';
    END IF;

    PERFORM public.accounting_budget_validate_line(
        v_church_id, p_account_id, p_fund_id, p_department_id
    );

    IF p_line_id IS NULL THEN
        INSERT INTO public.accounting_budget_lines (
            church_id, budget_id, line_number, account_id, fund_id,
            department_id, line_description, created_by, updated_by
        ) VALUES (
            v_church_id, p_budget_id, p_line_number, p_account_id, p_fund_id,
            p_department_id, pg_catalog.btrim(p_line_description), v_actor, v_actor
        ) RETURNING id INTO v_line_id;

        INSERT INTO public.accounting_audit_log (
            church_id, actor_user_id, action, entity_type, entity_id,
            description, metadata
        ) VALUES (
            v_church_id, v_actor, 'budget_line_created', 'budget_line', v_line_id,
            'Budget line created.',
            pg_catalog.jsonb_build_object('budget_id', p_budget_id, 'line_number', p_line_number)
        );
    ELSE
        SELECT l.id, l.line_number
          INTO v_line_id, v_old_line_number
          FROM public.accounting_budget_lines l
         WHERE l.church_id = v_church_id
           AND l.budget_id = p_budget_id
           AND l.id = p_line_id
         FOR UPDATE;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Budget line was not found in this budget' USING ERRCODE = 'P0002';
        END IF;

        UPDATE public.accounting_budget_lines
           SET line_number = p_line_number,
               account_id = p_account_id,
               fund_id = p_fund_id,
               department_id = p_department_id,
               line_description = pg_catalog.btrim(p_line_description),
               updated_by = v_actor
         WHERE church_id = v_church_id AND id = v_line_id;

        INSERT INTO public.accounting_audit_log (
            church_id, actor_user_id, action, entity_type, entity_id,
            description, metadata
        ) VALUES (
            v_church_id, v_actor, 'budget_line_updated', 'budget_line', v_line_id,
            'Budget line updated.',
            pg_catalog.jsonb_build_object(
                'budget_id', p_budget_id,
                'old_line_number', v_old_line_number,
                'new_line_number', p_line_number
            )
        );
    END IF;

    RETURN v_line_id;
END;
$function$;

CREATE FUNCTION public.accounting_delete_budget_line(p_line_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_budget_id UUID;
    v_status TEXT;
    v_line_number INTEGER;
BEGIN
    IF v_actor IS NULL OR p_line_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and budget line are required' USING ERRCODE = '42501';
    END IF;

    SELECT l.church_id, l.budget_id INTO v_church_id, v_budget_id
      FROM public.accounting_budget_lines l
     WHERE l.id = p_line_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Budget line was not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.budgets.manage');

    SELECT b.status INTO v_status
      FROM public.accounting_budgets b
     WHERE b.church_id = v_church_id AND b.id = v_budget_id
     FOR UPDATE;

    IF v_status NOT IN ('draft', 'returned') THEN
        RAISE EXCEPTION 'Only draft or returned budgets can be edited' USING ERRCODE = '55000';
    END IF;

    SELECT l.line_number INTO v_line_number
      FROM public.accounting_budget_lines l
     WHERE l.church_id = v_church_id AND l.id = p_line_id
     FOR UPDATE;

    DELETE FROM public.accounting_budget_allocations a
     WHERE a.church_id = v_church_id AND a.budget_line_id = p_line_id;

    DELETE FROM public.accounting_budget_lines l
     WHERE l.church_id = v_church_id AND l.id = p_line_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'budget_line_deleted', 'budget_line', p_line_id,
        'Budget line and its monthly allocations deleted from an editable draft.',
        pg_catalog.jsonb_build_object('budget_id', v_budget_id, 'line_number', v_line_number)
    );
END;
$function$;

CREATE FUNCTION public.accounting_set_budget_allocation(
    p_budget_line_id UUID,
    p_accounting_period_id UUID,
    p_budgeted_amount NUMERIC
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_budget_id UUID;
    v_fiscal_start DATE;
    v_fiscal_end DATE;
    v_currency TEXT;
    v_status TEXT;
    v_scale INTEGER;
    v_allocation_id UUID;
    v_period_start DATE;
    v_period_end DATE;
    v_period_type TEXT;
    v_month_start DATE;
BEGIN
    IF v_actor IS NULL OR p_budget_line_id IS NULL OR p_accounting_period_id IS NULL THEN
        RAISE EXCEPTION 'Authentication, budget line, and accounting period are required' USING ERRCODE = '42501';
    END IF;

    IF p_budgeted_amount IS NULL
       OR p_budgeted_amount::TEXT IN ('NaN', 'Infinity', '-Infinity')
       OR p_budgeted_amount < 0 THEN
        RAISE EXCEPTION 'Budget allocation must be a finite, nonnegative amount' USING ERRCODE = '22023';
    END IF;

    SELECT l.church_id, l.budget_id INTO v_church_id, v_budget_id
      FROM public.accounting_budget_lines l
     WHERE l.id = p_budget_line_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Budget line was not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.budgets.manage');

    SELECT b.fiscal_year_start, b.fiscal_year_end, b.functional_currency, b.status
      INTO v_fiscal_start, v_fiscal_end, v_currency, v_status
      FROM public.accounting_budgets b
     WHERE b.church_id = v_church_id AND b.id = v_budget_id
     FOR UPDATE;

    IF v_status NOT IN ('draft', 'returned') THEN
        RAISE EXCEPTION 'Only draft or returned budgets can be edited' USING ERRCODE = '55000';
    END IF;

    v_scale := CASE v_currency WHEN 'UGX' THEN 0 WHEN 'USD' THEN 2 ELSE NULL END;
    IF v_scale IS NULL OR pg_catalog.round(p_budgeted_amount, v_scale) <> p_budgeted_amount THEN
        RAISE EXCEPTION 'Budget allocation precision is invalid for currency %', v_currency USING ERRCODE = '22023';
    END IF;

    SELECT p.start_date, p.end_date, p.period_type
      INTO v_period_start, v_period_end, v_period_type
      FROM public.accounting_periods p
     WHERE p.church_id = v_church_id
       AND p.id = p_accounting_period_id
     FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Accounting period was not found in this church' USING ERRCODE = 'P0002';
    END IF;

    v_month_start := pg_catalog.date_trunc('month', v_period_start)::DATE;

    IF v_period_type <> 'monthly'
       OR v_period_start <> v_month_start
       OR v_period_end <> ((v_month_start + INTERVAL '1 month')::DATE - 1)
       OR v_period_start < v_fiscal_start OR v_period_end > v_fiscal_end THEN
        RAISE EXCEPTION 'Allocation must reference an exact calendar-month period within the budget fiscal year' USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.accounting_budget_allocations (
        church_id, budget_id, budget_line_id, accounting_period_id,
        budgeted_amount, created_by, updated_by
    ) VALUES (
        v_church_id, v_budget_id, p_budget_line_id, p_accounting_period_id,
        p_budgeted_amount, v_actor, v_actor
    )
    ON CONFLICT (church_id, budget_line_id, accounting_period_id)
    DO UPDATE SET
        budgeted_amount = EXCLUDED.budgeted_amount,
        updated_by = v_actor
    RETURNING id INTO v_allocation_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'budget_allocation_updated', 'budget_allocation', v_allocation_id,
        'Monthly budget allocation saved.',
        pg_catalog.jsonb_build_object(
            'budget_id', v_budget_id,
            'budget_line_id', p_budget_line_id,
            'accounting_period_id', p_accounting_period_id,
            'budgeted_amount', p_budgeted_amount,
            'functional_currency', v_currency
        )
    );

    RETURN v_allocation_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 5. Submission and approval workflow
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.accounting_submit_budget(p_budget_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_status TEXT;
BEGIN
    IF v_actor IS NULL OR p_budget_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and budget are required' USING ERRCODE = '42501';
    END IF;

    SELECT b.church_id INTO v_church_id
      FROM public.accounting_budgets b
     WHERE b.id = p_budget_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Budget was not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.budgets.submit');

    SELECT b.status INTO v_status
      FROM public.accounting_budgets b
     WHERE b.church_id = v_church_id AND b.id = p_budget_id
     FOR UPDATE;

    IF v_status NOT IN ('draft', 'returned') THEN
        RAISE EXCEPTION 'Only draft or returned budgets can be submitted' USING ERRCODE = '55000';
    END IF;

    PERFORM public.accounting_budget_assert_complete(p_budget_id);

    UPDATE public.accounting_budgets
       SET status = 'submitted',
           submitted_by = v_actor,
           submitted_at = pg_catalog.clock_timestamp()
     WHERE church_id = v_church_id AND id = p_budget_id;

    INSERT INTO public.accounting_budget_approvals (
        church_id, budget_id, actor_user_id, action,
        from_status, to_status
    ) VALUES (
        v_church_id, p_budget_id, v_actor, 'submitted',
        v_status, 'submitted'
    );

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'budget_submitted', 'budget', p_budget_id,
        'Complete annual budget submitted for independent approval.',
        pg_catalog.jsonb_build_object('previous_status', v_status)
    );
END;
$function$;

CREATE FUNCTION public.accounting_return_budget(p_budget_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    PERFORM public.accounting_budget_review_decision(p_budget_id, 'returned', p_reason);
END;
$function$;

CREATE FUNCTION public.accounting_reject_budget(p_budget_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    PERFORM public.accounting_budget_review_decision(p_budget_id, 'rejected', p_reason);
END;
$function$;

CREATE FUNCTION public.accounting_approve_budget(p_budget_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_fiscal_start DATE;
    v_submitted_by UUID;
    v_status TEXT;
    v_previous_approved_id UUID;
BEGIN
    IF v_actor IS NULL OR p_budget_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and budget are required' USING ERRCODE = '42501';
    END IF;

    SELECT b.church_id INTO v_church_id
      FROM public.accounting_budgets b
     WHERE b.id = p_budget_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Budget was not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.budgets.approve');

    SELECT b.fiscal_year_start, b.status, b.submitted_by
      INTO v_fiscal_start, v_status, v_submitted_by
      FROM public.accounting_budgets b
     WHERE b.church_id = v_church_id AND b.id = p_budget_id
     FOR UPDATE;

    IF v_status <> 'submitted' THEN
        RAISE EXCEPTION 'Only submitted budgets can be approved' USING ERRCODE = '55000';
    END IF;

    IF v_submitted_by IS NULL OR v_submitted_by = v_actor THEN
        RAISE EXCEPTION 'The budget submitter cannot approve their own submission' USING ERRCODE = '42501';
    END IF;

    PERFORM public.accounting_budget_assert_complete(p_budget_id);

    SELECT b.id INTO v_previous_approved_id
      FROM public.accounting_budgets b
     WHERE b.church_id = v_church_id
       AND b.fiscal_year_start = v_fiscal_start
       AND b.status = 'approved'
       AND b.id <> p_budget_id
     FOR UPDATE;

    IF v_previous_approved_id IS NOT NULL THEN
        UPDATE public.accounting_budgets
           SET status = 'superseded'
         WHERE church_id = v_church_id AND id = v_previous_approved_id;

        INSERT INTO public.accounting_budget_approvals (
            church_id, budget_id, actor_user_id, action,
            from_status, to_status
        ) VALUES (
            v_church_id, v_previous_approved_id, v_actor, 'superseded',
            'approved', 'superseded'
        );

        INSERT INTO public.accounting_audit_log (
            church_id, actor_user_id, action, entity_type, entity_id,
            description, metadata
        ) VALUES (
            v_church_id, v_actor, 'budget_superseded', 'budget', v_previous_approved_id,
            'Previously approved budget version superseded by a newly approved revision.',
            pg_catalog.jsonb_build_object('replacement_budget_id', p_budget_id)
        );
    END IF;

    UPDATE public.accounting_budgets
       SET status = 'approved',
           approved_by = v_actor,
           approved_at = pg_catalog.clock_timestamp()
     WHERE church_id = v_church_id AND id = p_budget_id;

    INSERT INTO public.accounting_budget_approvals (
        church_id, budget_id, actor_user_id, action,
        from_status, to_status
    ) VALUES (
        v_church_id, p_budget_id, v_actor, 'approved',
        'submitted', 'approved'
    );

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'budget_approved', 'budget', p_budget_id,
        'Budget approved by an independent authorized approver.',
        pg_catalog.jsonb_build_object('superseded_budget_id', v_previous_approved_id)
    );
END;
$function$;

CREATE FUNCTION public.accounting_cancel_budget(p_budget_id UUID, p_reason TEXT)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_status TEXT;
BEGIN
    IF v_actor IS NULL OR p_budget_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and budget are required' USING ERRCODE = '42501';
    END IF;

    IF pg_catalog.length(pg_catalog.btrim(COALESCE(p_reason, ''))) NOT BETWEEN 10 AND 500 THEN
        RAISE EXCEPTION 'A cancellation reason of 10 to 500 characters is required' USING ERRCODE = '22023';
    END IF;

    SELECT b.church_id INTO v_church_id
      FROM public.accounting_budgets b
     WHERE b.id = p_budget_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Budget was not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.budgets.manage');

    SELECT b.status INTO v_status
      FROM public.accounting_budgets b
     WHERE b.church_id = v_church_id AND b.id = p_budget_id
     FOR UPDATE;

    IF v_status NOT IN ('draft', 'returned') THEN
        RAISE EXCEPTION 'Only draft or returned budgets may be cancelled' USING ERRCODE = '55000';
    END IF;

    UPDATE public.accounting_budgets
       SET status = 'cancelled'
     WHERE church_id = v_church_id AND id = p_budget_id;

    INSERT INTO public.accounting_budget_approvals (
        church_id, budget_id, actor_user_id, action,
        from_status, to_status, reason
    ) VALUES (
        v_church_id, p_budget_id, v_actor, 'cancelled',
        v_status, 'cancelled', pg_catalog.btrim(p_reason)
    );

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'budget_cancelled', 'budget', p_budget_id,
        'Editable budget version cancelled.',
        pg_catalog.jsonb_build_object('reason', pg_catalog.btrim(p_reason))
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 6. Monthly budget-versus-actual report
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.accounting_budget_vs_actual(
    p_budget_id UUID,
    p_accounting_period_id UUID DEFAULT NULL
)
RETURNS TABLE (
    budget_id UUID,
    budget_line_id UUID,
    line_number INTEGER,
    account_id UUID,
    account_code TEXT,
    account_name TEXT,
    account_type TEXT,
    fund_id UUID,
    fund_name TEXT,
    department_id UUID,
    department_name TEXT,
    accounting_period_id UUID,
    period_name TEXT,
    period_start DATE,
    period_end DATE,
    budgeted_amount NUMERIC,
    actual_amount NUMERIC,
    variance_amount NUMERIC
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_church_id UUID;
    v_fiscal_start DATE;
    v_fiscal_end DATE;
BEGIN
    IF auth.uid() IS NULL OR p_budget_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and budget are required' USING ERRCODE = '42501';
    END IF;

    SELECT b.church_id, b.fiscal_year_start, b.fiscal_year_end
      INTO v_church_id, v_fiscal_start, v_fiscal_end
      FROM public.accounting_budgets b
     WHERE b.id = p_budget_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Budget was not found' USING ERRCODE = 'P0002';
    END IF;

    IF NOT public.has_church_financial_permission(v_church_id, 'accounting.budgets.read') THEN
        RAISE EXCEPTION 'Budget read permission is required' USING ERRCODE = '42501';
    END IF;

    IF p_accounting_period_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM public.accounting_periods p
        WHERE p.church_id = v_church_id
          AND p.id = p_accounting_period_id
          AND p.period_type = 'monthly'
          AND p.start_date = pg_catalog.date_trunc('month', p.start_date)::DATE
          AND p.end_date = ((p.start_date + INTERVAL '1 month')::DATE - 1)
          AND p.start_date >= v_fiscal_start
          AND p.end_date <= v_fiscal_end
          AND EXISTS (
              SELECT 1
              FROM public.accounting_budget_allocations ba
              WHERE ba.church_id = v_church_id
                AND ba.budget_id = p_budget_id
                AND ba.accounting_period_id = p.id
          )
    ) THEN
        RAISE EXCEPTION 'Requested accounting period is not one of this budget fiscal year''s allocated monthly periods' USING ERRCODE = '22023';
    END IF;

    RETURN QUERY
    SELECT
        b.id,
        l.id,
        l.line_number,
        a.id,
        a.account_code,
        a.account_name,
        a.account_type,
        f.id,
        f.fund_name,
        d.id,
        d.department_name,
        p.id,
        p.period_name,
        p.start_date,
        p.end_date,
        ba.budgeted_amount::NUMERIC,
        COALESCE(actuals.actual_amount, 0)::NUMERIC,
        (COALESCE(actuals.actual_amount, 0) - ba.budgeted_amount)::NUMERIC
    FROM public.accounting_budgets b
    JOIN public.accounting_budget_lines l
      ON l.church_id = b.church_id AND l.budget_id = b.id
    JOIN public.accounting_accounts a
      ON a.church_id = l.church_id AND a.id = l.account_id
    JOIN public.accounting_funds f
      ON f.church_id = l.church_id AND f.id = l.fund_id
    LEFT JOIN public.accounting_departments d
      ON d.church_id = l.church_id AND d.id = l.department_id
    JOIN public.accounting_budget_allocations ba
      ON ba.church_id = l.church_id
     AND ba.budget_id = l.budget_id
     AND ba.budget_line_id = l.id
    JOIN public.accounting_periods p
      ON p.church_id = ba.church_id
     AND p.id = ba.accounting_period_id
    LEFT JOIN LATERAL (
        SELECT pg_catalog.sum(
            CASE a.account_type
                WHEN 'income' THEN jl.credit_amount - jl.debit_amount
                WHEN 'expense' THEN jl.debit_amount - jl.credit_amount
                ELSE 0
            END
        ) AS actual_amount
        FROM public.accounting_journal_lines jl
        JOIN public.accounting_journals j
          ON j.church_id = jl.church_id
         AND j.id = jl.journal_id
        WHERE jl.church_id = l.church_id
          AND jl.account_id = l.account_id
          AND jl.fund_id = l.fund_id
          AND jl.department_id IS NOT DISTINCT FROM l.department_id
          AND j.period_id = ba.accounting_period_id
          AND j.status IN ('posted', 'reversed')
    ) actuals ON TRUE
    WHERE b.id = p_budget_id
      AND (p_accounting_period_id IS NULL OR p.id = p_accounting_period_id)
    ORDER BY l.line_number, p.start_date;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 7. Ownership, function ACLs, and documentation
-- ---------------------------------------------------------------------------
ALTER FUNCTION public.accounting_create_budget(UUID, TEXT, DATE) OWNER TO postgres;
ALTER FUNCTION public.accounting_create_budget_revision(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.accounting_save_budget_line(UUID, UUID, INTEGER, UUID, UUID, UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.accounting_delete_budget_line(UUID) OWNER TO postgres;
ALTER FUNCTION public.accounting_set_budget_allocation(UUID, UUID, NUMERIC) OWNER TO postgres;
ALTER FUNCTION public.accounting_submit_budget(UUID) OWNER TO postgres;
ALTER FUNCTION public.accounting_return_budget(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.accounting_reject_budget(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.accounting_approve_budget(UUID) OWNER TO postgres;
ALTER FUNCTION public.accounting_cancel_budget(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.accounting_budget_vs_actual(UUID, UUID) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.accounting_create_budget(UUID, TEXT, DATE) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_create_budget_revision(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_save_budget_line(UUID, UUID, INTEGER, UUID, UUID, UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_delete_budget_line(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_set_budget_allocation(UUID, UUID, NUMERIC) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_submit_budget(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_return_budget(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_reject_budget(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_approve_budget(UUID) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_cancel_budget(UUID, TEXT) FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_budget_vs_actual(UUID, UUID) FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.accounting_create_budget(UUID, TEXT, DATE) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_create_budget_revision(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_save_budget_line(UUID, UUID, INTEGER, UUID, UUID, UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_delete_budget_line(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_set_budget_allocation(UUID, UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_submit_budget(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_return_budget(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_reject_budget(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_approve_budget(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_cancel_budget(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_budget_vs_actual(UUID, UUID) TO authenticated;

COMMENT ON FUNCTION public.accounting_create_budget(UUID, TEXT, DATE) IS
    'Creates a first annual church budget in the functional currency after verifying the fiscal-year definition and all 12 monthly periods.';
COMMENT ON FUNCTION public.accounting_create_budget_revision(UUID, TEXT) IS
    'Creates a new retained budget revision copied from the latest approved, rejected, or cancelled version, including all monthly allocations; revision history remains linear.';
COMMENT ON FUNCTION public.accounting_save_budget_line(UUID, UUID, INTEGER, UUID, UUID, UUID, TEXT) IS
    'Creates or updates one budget line in a draft or returned budget, validating same-church active income/expense account, fund, and optional department.';
COMMENT ON FUNCTION public.accounting_set_budget_allocation(UUID, UUID, NUMERIC) IS
    'Upserts one monthly allocation in the budget functional currency with UGX integer or USD two-decimal precision.';
COMMENT ON FUNCTION public.accounting_submit_budget(UUID) IS
    'Submits a complete 12-month budget for approval. Every line must have all twelve monthly allocation rows.';
COMMENT ON FUNCTION public.accounting_approve_budget(UUID) IS
    'Approves only a submitted budget from a different user; any previously approved version for the same church and fiscal year is retained as superseded.';
COMMENT ON FUNCTION public.accounting_budget_vs_actual(UUID, UUID) IS
    'Returns monthly budget versus actual by account, fund, and department. Actuals include posted and reversed journals so posted reversing entries offset their reversed originals.';

COMMIT;

-- END DRAFT MIGRATION 006
