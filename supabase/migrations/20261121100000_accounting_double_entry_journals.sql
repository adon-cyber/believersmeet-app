-- BelieversMeet Accounting & Budgeting
-- Migration 004: Double-entry journals, approval/posting controls, and Pesapal source capture
-- Initial release supports UGX (0 decimal places) and USD (2 decimal places) only.
-- All provider-verified Pesapal reversals remain in manual reconciliation until
-- settlement/refund accounting is implemented. Unposted receipt journals are
-- voided to prevent posting, but their source events remain open for review.
-- DRAFT ONLY. Review and test against BelieversMeet-Staging before execution.
-- Do NOT run against Production.
--
-- Depends on installed Migrations 001-003, including:
--   accounting_settings / periods / departments / funds / accounts
--   church financial roles and permission functions
--   accounting_audit_log and its append-only protections
--   transactions (Pesapal checkout remains the payment source of truth)
--
-- This migration creates ledger structures and secure database RPCs. It does NOT
-- edit api/pesapal-ipn.js or api/pesapal-verify.js. Those endpoints must call
-- accounting_process_pesapal_transaction(...) after persisting a verified
-- COMPLETED or REVERSED status before the integration becomes active.
-- The trusted processor records first-verification timestamps and is idempotent.

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
    IF current_user <> 'postgres' THEN
        RAISE EXCEPTION 'Preflight failed: execute this migration as postgres';
    END IF;

    IF pg_catalog.to_regclass('public.accounting_settings') IS NULL
       OR pg_catalog.to_regclass('public.accounting_periods') IS NULL
       OR pg_catalog.to_regclass('public.accounting_departments') IS NULL
       OR pg_catalog.to_regclass('public.accounting_funds') IS NULL
       OR pg_catalog.to_regclass('public.accounting_accounts') IS NULL
       OR pg_catalog.to_regclass('public.accounting_audit_log') IS NULL
       OR pg_catalog.to_regclass('public.church_financial_roles') IS NULL
       OR pg_catalog.to_regclass('public.church_financial_role_permissions') IS NULL
       OR pg_catalog.to_regclass('public.transactions') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: required Migrations 001-003 tables or public.transactions are missing';
    END IF;

    IF pg_catalog.to_regprocedure('public.has_church_financial_permission(uuid,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.assert_church_accounting_permission(uuid,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.accounting_set_updated_at()') IS NULL
       OR pg_catalog.to_regprocedure('public.accounting_prevent_audit_mutation()') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: required accounting permission, timestamp, or audit functions are missing';
    END IF;

    FOR v_required IN
        SELECT * FROM (VALUES
            ('accounting_settings', 'church_id'),
            ('accounting_settings', 'functional_currency'),
            ('accounting_settings', 'timezone_name'),
            ('accounting_settings', 'setup_completed_at'),
            ('accounting_periods', 'id'),
            ('accounting_periods', 'church_id'),
            ('accounting_periods', 'start_date'),
            ('accounting_periods', 'end_date'),
            ('accounting_periods', 'status'),
            ('accounting_departments', 'id'),
            ('accounting_departments', 'church_id'),
            ('accounting_departments', 'is_active'),
            ('accounting_funds', 'id'),
            ('accounting_funds', 'church_id'),
            ('accounting_funds', 'is_active'),
            ('accounting_accounts', 'id'),
            ('accounting_accounts', 'church_id'),
            ('accounting_accounts', 'account_type'),
            ('accounting_accounts', 'allow_direct_posting'),
            ('accounting_accounts', 'is_active'),
            ('accounting_audit_log', 'church_id'),
            ('accounting_audit_log', 'actor_user_id'),
            ('accounting_audit_log', 'action'),
            ('accounting_audit_log', 'entity_type'),
            ('accounting_audit_log', 'entity_id'),
            ('accounting_audit_log', 'description'),
            ('accounting_audit_log', 'metadata'),
            ('transactions', 'id'),
            ('transactions', 'church_id'),
            ('transactions', 'merchant_reference'),
            ('transactions', 'amount'),
            ('transactions', 'currency'),
            ('transactions', 'payment_type'),
            ('transactions', 'payment_method'),
            ('transactions', 'status'),
            ('transactions', 'created_at'),
            ('transactions', 'updated_at')
        ) AS expected(table_name, column_name)
    LOOP
        IF NOT EXISTS (
            SELECT 1
            FROM information_schema.columns c
            WHERE c.table_schema = 'public'
              AND c.table_name = v_required.table_name
              AND c.column_name = v_required.column_name
        ) THEN
            RAISE EXCEPTION 'Preflight failed: required column public.%.% is missing',
                v_required.table_name, v_required.column_name;
        END IF;
    END LOOP;

    -- The Pesapal amount column is used with NUMERIC precision functions and
    -- must be decimal-capable. Fail closed rather than silently coercing an
    -- unexpected float, integer, or text schema at payment-capture time.
    IF NOT EXISTS (
        SELECT 1
        FROM information_schema.columns c
        WHERE c.table_schema = 'public'
          AND c.table_name = 'transactions'
          AND c.column_name = 'amount'
          AND c.data_type = 'numeric'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: public.transactions.amount must use PostgreSQL NUMERIC for UGX/USD validation';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'accounting_settings'
          AND column_name = 'journal_approval_threshold'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: accounting_settings.journal_approval_threshold already exists';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.accounting_settings
        WHERE functional_currency NOT IN ('UGX', 'USD')
    ) THEN
        RAISE EXCEPTION 'Preflight failed: one or more existing churches use a functional currency outside the Migration 004 UGX/USD release scope; resolve those settings before applying this migration';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS c
        JOIN pg_catalog.pg_attribute AS a
          ON a.attrelid = c.conrelid
         AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid = 'public.accounting_audit_log'::regclass
          AND c.contype = 'f'
          AND a.attname = 'actor_user_id'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: actor_user_id must remain a historical UUID without a foreign key, as defined by Migration 003';
    END IF;

    IF EXISTS (
        SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.accounting_settings'::regclass
          AND conname = 'accounting_settings_functional_currency_supported_chk'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: supported functional currency constraint already exists';
    END IF;

    IF pg_catalog.to_regclass('public.transactions_accounting_church_id_id_uk') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: transaction composite-key index name is already in use';
    END IF;

    IF pg_catalog.to_regclass('public.accounting_journals') IS NOT NULL
       OR pg_catalog.to_regclass('public.accounting_journal_lines') IS NOT NULL
       OR pg_catalog.to_regclass('public.accounting_giving_category_mappings') IS NOT NULL
       OR pg_catalog.to_regclass('public.accounting_source_events') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: one or more Migration 004 tables already exist';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'transactions'
          AND column_name IN ('pesapal_completed_at', 'pesapal_reversed_at')
    ) THEN
        RAISE EXCEPTION 'Preflight failed: one or more Pesapal accounting timestamp columns already exist';
    END IF;

    IF pg_catalog.to_regprocedure('public.accounting_capture_pesapal_status_timestamps()') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: Pesapal status timestamp trigger function already exists';
    END IF;

    IF pg_catalog.to_regprocedure('public.accounting_guard_functional_currency_settings()') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_mark_source_event_review(uuid,uuid,text,text,jsonb)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_return_journal_to_draft(uuid,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_void_unposted_reversal(uuid,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_prevent_ledger_truncate()') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_prevent_source_event_delete()') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: one or more Migration 004 support functions already exist';
    END IF;

    IF pg_catalog.to_regprocedure('public.accounting_create_journal(uuid,uuid,date,text,jsonb)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_update_draft_journal(uuid,uuid,date,text,jsonb)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_submit_journal(uuid)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_approve_journal(uuid)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_post_journal(uuid)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_reverse_journal(uuid,date,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.accounting_process_pesapal_transaction(uuid,numeric)') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: one or more Migration 004 functions already exist';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.church_financial_roles r
        JOIN public.church_financial_role_permissions rp ON rp.role_id = r.id
        WHERE r.role_code = 'financial_approver'
          AND r.is_active IS TRUE
          AND rp.permission_key = 'accounting.journals.read'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: active financial_approver role with accounting.journals.read is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.church_financial_roles r
        JOIN public.church_financial_role_permissions rp ON rp.role_id = r.id
        WHERE r.role_code = 'finance_administrator'
          AND r.is_active IS TRUE
          AND rp.permission_key = 'accounting.approvals.rules.manage'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: Finance Administrator approval-rules permission is missing';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM (VALUES
            ('finance_administrator', 'accounting.journals.create'),
            ('finance_administrator', 'accounting.journals.post'),
            ('finance_administrator', 'accounting.journals.reverse'),
            ('accountant', 'accounting.journals.create'),
            ('accountant', 'accounting.journals.post'),
            ('accountant', 'accounting.journals.reverse')
        ) AS required(role_code, permission_key)
        WHERE NOT EXISTS (
            SELECT 1
            FROM public.church_financial_roles r
            JOIN public.church_financial_role_permissions rp ON rp.role_id = r.id
            WHERE r.role_code = required.role_code
              AND r.is_active IS TRUE
              AND rp.permission_key = required.permission_key
        )
    ) THEN
        RAISE EXCEPTION 'Preflight failed: one or more Finance Administrator or Accountant journal permissions are missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.accounting_audit_log'::regclass
          AND conname = 'accounting_audit_log_action_chk'
    ) OR NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint
        WHERE conrelid = 'public.accounting_audit_log'::regclass
          AND conname = 'accounting_audit_log_entity_chk'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: expected accounting audit action/entity constraints were not found';
    END IF;
END;
$preflight$;

-- ---------------------------------------------------------------------------
-- 1. Approval default and permission seed
-- ---------------------------------------------------------------------------
-- PostgreSQL NUMERIC supports NaN (and, in unconstrained NUMERIC, infinities).
-- Explicit text checks reject these special values because PostgreSQL orders
-- NUMERIC NaN above ordinary numbers, so naive positive/balance checks are unsafe.
-- A zero threshold means every positive-value journal requires approval.
-- The threshold is expressed in the church's functional currency.
ALTER TABLE public.accounting_settings
    ADD COLUMN journal_approval_threshold NUMERIC(20,4) NOT NULL DEFAULT 0,
    ADD CONSTRAINT accounting_settings_journal_approval_threshold_chk
        CHECK (journal_approval_threshold >= 0),
    ADD CONSTRAINT accounting_settings_journal_approval_threshold_finite_chk
        CHECK (journal_approval_threshold::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')),
    ADD CONSTRAINT accounting_settings_functional_currency_supported_chk
        CHECK (functional_currency IN ('UGX', 'USD'));

-- Migration 003 intentionally leaves actor_user_id without an auth.users FK.
-- Preserve actor UUIDs as historical references so deleting an Auth user
-- does not mutate or erase the append-only audit history.

INSERT INTO public.church_financial_role_permissions
    (role_id, permission_key, permission_description)
SELECT
    r.id,
    'accounting.journals.approve',
    'Approve submitted accounting journals created by another user.'
FROM public.church_financial_roles r
WHERE r.role_code = 'financial_approver'
  AND r.is_active IS TRUE
ON CONFLICT (role_id, permission_key) DO NOTHING;

-- Capture the first server-verified Pesapal completion/reversal timestamp.
-- Also prevent a stale concurrent IPN/verification response from downgrading
-- COMPLETED or REVERSED transactions after another request has advanced them.
ALTER TABLE public.transactions
    ADD COLUMN pesapal_completed_at TIMESTAMPTZ,
    ADD COLUMN pesapal_reversed_at TIMESTAMPTZ;

CREATE FUNCTION public.accounting_capture_pesapal_status_timestamps()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
    IF pg_catalog.lower(COALESCE(OLD.payment_method, '')) = 'pesapal'
       OR pg_catalog.lower(COALESCE(NEW.payment_method, '')) = 'pesapal' THEN
        IF OLD.status = 'REVERSED' THEN
            NEW.status := 'REVERSED';
        ELSIF OLD.status = 'COMPLETED'
              AND NEW.status IS DISTINCT FROM 'COMPLETED'
              AND NEW.status IS DISTINCT FROM 'REVERSED' THEN
            NEW.status := 'COMPLETED';
        ELSIF OLD.status = 'FAILED' AND NEW.status = 'PENDING' THEN
            NEW.status := 'FAILED';
        END IF;

        -- New completions are timestamped at their first verified status update.
        IF NEW.status = 'COMPLETED' AND NEW.pesapal_completed_at IS NULL THEN
            NEW.pesapal_completed_at := pg_catalog.clock_timestamp();
        END IF;

        -- A legacy row may already be COMPLETED before this trigger exists and
        -- receive its first post-migration update directly as REVERSED. Preserve
        -- the best available prior timestamp as an estimate only. The source
        -- processor will keep that completion event in requires_review rather
        -- than auto-create a journal when the receipt capture is missing.
        IF OLD.status = 'COMPLETED'
           AND NEW.status = 'REVERSED'
           AND NEW.pesapal_completed_at IS NULL THEN
            NEW.pesapal_completed_at := COALESCE(
                OLD.updated_at,
                OLD.created_at,
                pg_catalog.clock_timestamp()
            );
        END IF;

        IF NEW.status = 'REVERSED' AND NEW.pesapal_reversed_at IS NULL THEN
            NEW.pesapal_reversed_at := pg_catalog.clock_timestamp();
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.accounting_capture_pesapal_status_timestamps() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accounting_capture_pesapal_status_timestamps()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER transactions_capture_pesapal_status_timestamps
    BEFORE UPDATE OF status ON public.transactions
    FOR EACH ROW EXECUTE FUNCTION public.accounting_capture_pesapal_status_timestamps();

-- Extend the existing append-only audit vocabulary. The existing trigger
-- continues to prevent UPDATE, DELETE, and TRUNCATE of audit rows.
-- Preserve the six verified Migration 003 audit action values and six verified
-- entity types, then extend those explicit allowlists with the new journal
-- and source-event vocabulary. These values were confirmed against Staging.
-- This migration intentionally uses explicit CHECK constraints.
ALTER TABLE public.accounting_audit_log
    DROP CONSTRAINT accounting_audit_log_action_chk,
    DROP CONSTRAINT accounting_audit_log_entity_chk;

ALTER TABLE public.accounting_audit_log
    ADD CONSTRAINT accounting_audit_log_action_chk
        CHECK (action IN (
            'initialized', 'settings_updated', 'department_created',
            'fund_created', 'account_created', 'fiscal_year_created',
            'journal_created', 'journal_updated', 'journal_submitted',
            'journal_approved', 'journal_posted', 'journal_reversal_requested',
            'journal_reversal_posted', 'journal_voided', 'giving_mapping_updated',
            'journal_approval_threshold_updated', 'payment_event_recorded',
            'payment_event_review_required', 'payment_event_no_journal_to_reverse',
            'journal_returned_to_draft'
        )),
    ADD CONSTRAINT accounting_audit_log_entity_chk
        CHECK (entity_type IN (
            'church_setup', 'accounting_settings', 'department', 'fund',
            'account', 'accounting_period', 'journal',
            'giving_category_mapping', 'source_event'
        ));

-- Composite transaction uniqueness allows a source-event FK to prove that
-- the transaction and accounting source event belong to the same church.
CREATE UNIQUE INDEX transactions_accounting_church_id_id_uk
    ON public.transactions (church_id, id);

-- ---------------------------------------------------------------------------
-- 2. Idempotent source events and church-specific giving mappings
-- ---------------------------------------------------------------------------
CREATE TABLE public.accounting_source_events (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'pesapal_transaction',
    source_transaction_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    source_event_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'requires_review',
    source_reference TEXT NOT NULL,
    source_amount NUMERIC(20,4) NOT NULL,
    source_currency TEXT NOT NULL,
    functional_currency TEXT,
    exchange_rate NUMERIC(20,10),
    functional_amount NUMERIC(20,4),
    error_message TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    processed_at TIMESTAMPTZ,

    CONSTRAINT accounting_source_events_church_fk
        FOREIGN KEY (church_id)
        REFERENCES public.churches (id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_source_events_transaction_fk
        FOREIGN KEY (church_id, source_transaction_id)
        REFERENCES public.transactions (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_source_events_church_id_id_uk
        UNIQUE (church_id, id),
    CONSTRAINT accounting_source_events_type_chk
        CHECK (source_type = 'pesapal_transaction'),
    CONSTRAINT accounting_source_events_event_chk
        CHECK (event_type IN ('payment_completed', 'payment_reversed')),
    CONSTRAINT accounting_source_events_status_chk
        CHECK (status IN (
            'journal_created',
            'journal_posted',
            'requires_review',
            'voided',
            'no_journal_to_reverse'
        )),
    CONSTRAINT accounting_source_events_reference_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(source_reference)) BETWEEN 1 AND 200),
    CONSTRAINT accounting_source_events_amount_chk
        CHECK (source_amount > 0),
    CONSTRAINT accounting_source_events_finite_amounts_chk
        CHECK (
            source_amount::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
            AND (exchange_rate IS NULL OR exchange_rate::TEXT NOT IN ('NaN', 'Infinity', '-Infinity'))
            AND (functional_amount IS NULL OR functional_amount::TEXT NOT IN ('NaN', 'Infinity', '-Infinity'))
        ),
    CONSTRAINT accounting_source_events_source_currency_chk
        CHECK (source_currency IN ('UGX', 'USD')),
    CONSTRAINT accounting_source_events_source_precision_chk
        CHECK (
            (source_currency = 'UGX' AND source_amount = pg_catalog.trunc(source_amount))
            OR (source_currency = 'USD' AND source_amount = pg_catalog.round(source_amount, 2))
        ),
    CONSTRAINT accounting_source_events_functional_currency_chk
        CHECK (functional_currency IS NULL OR functional_currency IN ('UGX', 'USD')),
    CONSTRAINT accounting_source_events_exchange_rate_chk
        CHECK (exchange_rate IS NULL OR (exchange_rate > 0 AND exchange_rate = pg_catalog.round(exchange_rate, 10))),
    CONSTRAINT accounting_source_events_functional_amount_chk
        CHECK (
            functional_amount IS NULL
            OR (
                functional_amount > 0
                AND functional_currency IS NOT NULL
                AND (
                    (functional_currency = 'UGX' AND functional_amount = pg_catalog.trunc(functional_amount))
                    OR (functional_currency = 'USD' AND functional_amount = pg_catalog.round(functional_amount, 2))
                )
            )
        ),
    CONSTRAINT accounting_source_events_error_chk
        CHECK (error_message IS NULL OR pg_catalog.length(error_message) <= 1000)
);

CREATE UNIQUE INDEX accounting_source_events_idempotency_uk
    ON public.accounting_source_events
       (church_id, source_type, source_transaction_id, event_type);

CREATE INDEX accounting_source_events_church_created_idx
    ON public.accounting_source_events (church_id, created_at DESC);

CREATE TABLE public.accounting_giving_category_mappings (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    giving_category TEXT NOT NULL,
    income_account_id UUID NOT NULL,
    clearing_account_id UUID NOT NULL,
    fund_id UUID NOT NULL,
    department_id UUID,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID,
    updated_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),

    CONSTRAINT accounting_giving_category_mappings_church_fk
        FOREIGN KEY (church_id)
        REFERENCES public.churches (id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_giving_category_mappings_income_account_fk
        FOREIGN KEY (church_id, income_account_id)
        REFERENCES public.accounting_accounts (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_giving_category_mappings_clearing_account_fk
        FOREIGN KEY (church_id, clearing_account_id)
        REFERENCES public.accounting_accounts (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_giving_category_mappings_fund_fk
        FOREIGN KEY (church_id, fund_id)
        REFERENCES public.accounting_funds (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_giving_category_mappings_department_fk
        FOREIGN KEY (church_id, department_id)
        REFERENCES public.accounting_departments (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_giving_category_mappings_church_id_id_uk
        UNIQUE (church_id, id),
    CONSTRAINT accounting_giving_category_mappings_category_uk
        UNIQUE (church_id, giving_category),
    CONSTRAINT accounting_giving_category_mappings_category_chk
        CHECK (giving_category IN (
            'Tithes',
            'Offerings',
            'Building Fund',
            'Missions & Outreach',
            'Special Seed'
        ))
);

CREATE INDEX accounting_giving_category_mappings_church_active_idx
    ON public.accounting_giving_category_mappings (church_id, is_active, giving_category);

-- ---------------------------------------------------------------------------
-- 3. Journal header and journal-line tables
-- ---------------------------------------------------------------------------
CREATE TABLE public.accounting_journals (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    journal_number TEXT NOT NULL,
    period_id UUID NOT NULL,
    journal_date DATE NOT NULL,
    description TEXT NOT NULL,
    functional_currency TEXT NOT NULL,
    source_type TEXT NOT NULL DEFAULT 'manual',
    source_event_id UUID,
    reversal_of_journal_id UUID,
    status TEXT NOT NULL DEFAULT 'draft',
    total_debits NUMERIC(20,4) NOT NULL DEFAULT 0,
    total_credits NUMERIC(20,4) NOT NULL DEFAULT 0,
    approval_required BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID,
    submitted_by UUID,
    approved_by UUID,
    posted_by UUID,
    reversed_by UUID,
    voided_by UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    submitted_at TIMESTAMPTZ,
    approved_at TIMESTAMPTZ,
    posted_at TIMESTAMPTZ,
    reversed_at TIMESTAMPTZ,
    voided_at TIMESTAMPTZ,
    void_reason TEXT,

    CONSTRAINT accounting_journals_church_fk
        FOREIGN KEY (church_id)
        REFERENCES public.churches (id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_journals_period_fk
        FOREIGN KEY (church_id, period_id)
        REFERENCES public.accounting_periods (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_journals_source_event_fk
        FOREIGN KEY (church_id, source_event_id)
        REFERENCES public.accounting_source_events (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_journals_reversal_fk
        FOREIGN KEY (church_id, reversal_of_journal_id)
        REFERENCES public.accounting_journals (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_journals_church_id_id_uk
        UNIQUE (church_id, id),
    CONSTRAINT accounting_journals_number_uk
        UNIQUE (church_id, journal_number),
    CONSTRAINT accounting_journals_number_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(journal_number)) BETWEEN 1 AND 64),
    CONSTRAINT accounting_journals_description_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(description)) BETWEEN 1 AND 500),
    CONSTRAINT accounting_journals_currency_chk
        CHECK (functional_currency IN ('UGX', 'USD')),
    CONSTRAINT accounting_journals_source_type_chk
        CHECK (source_type IN ('manual', 'pesapal_payment', 'pesapal_reversal', 'manual_reversal')),
    CONSTRAINT accounting_journals_status_chk
        CHECK (status IN ('draft', 'submitted', 'approved', 'posted', 'reversed', 'voided')),
    CONSTRAINT accounting_journals_totals_chk
        CHECK (total_debits >= 0 AND total_credits >= 0),
    CONSTRAINT accounting_journals_finite_totals_chk
        CHECK (
            total_debits::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
            AND total_credits::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
        ),
    CONSTRAINT accounting_journals_totals_currency_precision_chk
        CHECK (
            (functional_currency = 'UGX'
                AND total_debits = pg_catalog.trunc(total_debits)
                AND total_credits = pg_catalog.trunc(total_credits))
            OR (functional_currency = 'USD'
                AND total_debits = pg_catalog.round(total_debits, 2)
                AND total_credits = pg_catalog.round(total_credits, 2))
        ),
    CONSTRAINT accounting_journals_posted_state_chk
        CHECK (status NOT IN ('posted', 'reversed') OR posted_at IS NOT NULL),
    CONSTRAINT accounting_journals_reversed_state_chk
        CHECK (status <> 'reversed' OR reversed_at IS NOT NULL),
    CONSTRAINT accounting_journals_voided_state_chk
        CHECK (status <> 'voided' OR (voided_at IS NOT NULL AND pg_catalog.length(pg_catalog.btrim(COALESCE(void_reason, ''))) BETWEEN 5 AND 500)),
    CONSTRAINT accounting_journals_no_self_reversal_chk
        CHECK (reversal_of_journal_id IS NULL OR reversal_of_journal_id <> id)
);

CREATE UNIQUE INDEX accounting_journals_one_reversal_uk
    ON public.accounting_journals (church_id, reversal_of_journal_id)
    WHERE reversal_of_journal_id IS NOT NULL AND status <> 'voided';

CREATE UNIQUE INDEX accounting_journals_source_event_uk
    ON public.accounting_journals (church_id, source_event_id)
    WHERE source_event_id IS NOT NULL;

CREATE INDEX accounting_journals_church_period_date_idx
    ON public.accounting_journals (church_id, period_id, journal_date DESC);

CREATE INDEX accounting_journals_church_status_created_idx
    ON public.accounting_journals (church_id, status, created_at DESC);

CREATE TABLE public.accounting_journal_lines (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    journal_id UUID NOT NULL,
    line_number INTEGER NOT NULL,
    account_id UUID NOT NULL,
    fund_id UUID NOT NULL,
    department_id UUID,
    line_description TEXT,
    debit_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
    credit_amount NUMERIC(20,4) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),

    CONSTRAINT accounting_journal_lines_journal_fk
        FOREIGN KEY (church_id, journal_id)
        REFERENCES public.accounting_journals (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_journal_lines_account_fk
        FOREIGN KEY (church_id, account_id)
        REFERENCES public.accounting_accounts (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_journal_lines_fund_fk
        FOREIGN KEY (church_id, fund_id)
        REFERENCES public.accounting_funds (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_journal_lines_department_fk
        FOREIGN KEY (church_id, department_id)
        REFERENCES public.accounting_departments (church_id, id)
        ON DELETE RESTRICT,
    CONSTRAINT accounting_journal_lines_number_uk
        UNIQUE (church_id, journal_id, line_number),
    CONSTRAINT accounting_journal_lines_number_chk
        CHECK (line_number > 0),
    CONSTRAINT accounting_journal_lines_finite_amounts_chk
        CHECK (
            debit_amount::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
            AND credit_amount::TEXT NOT IN ('NaN', 'Infinity', '-Infinity')
        ),
    CONSTRAINT accounting_journal_lines_amount_chk
        CHECK (
            debit_amount >= 0
            AND credit_amount >= 0
            AND (
                (debit_amount > 0 AND credit_amount = 0)
                OR (credit_amount > 0 AND debit_amount = 0)
            )
        ),
    CONSTRAINT accounting_journal_lines_description_chk
        CHECK (line_description IS NULL OR pg_catalog.length(line_description) <= 500)
);

CREATE INDEX accounting_journal_lines_account_idx
    ON public.accounting_journal_lines (church_id, account_id, journal_id);

CREATE INDEX accounting_journal_lines_fund_idx
    ON public.accounting_journal_lines (church_id, fund_id, journal_id)
    WHERE fund_id IS NOT NULL;

-- Functional-currency and approval-threshold safeguards. A church may choose
-- UGX or USD before ledger activity, but may not change functional currency
-- after any journal or Pesapal source event exists.
CREATE FUNCTION public.accounting_guard_functional_currency_settings()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
    v_scale INTEGER;
BEGIN
    IF NEW.functional_currency NOT IN ('UGX', 'USD') THEN
        RAISE EXCEPTION 'Migration 004 supports UGX and USD functional currencies only' USING ERRCODE = '22023';
    END IF;

    IF NEW.journal_approval_threshold IS NULL
       OR NEW.journal_approval_threshold::TEXT IN ('NaN', 'Infinity', '-Infinity')
       OR NEW.journal_approval_threshold < 0 THEN
        RAISE EXCEPTION 'Journal approval threshold must be a finite, non-negative amount' USING ERRCODE = '22023';
    END IF;

    v_scale := CASE NEW.functional_currency WHEN 'UGX' THEN 0 WHEN 'USD' THEN 2 END;
    IF pg_catalog.round(NEW.journal_approval_threshold, v_scale) <> NEW.journal_approval_threshold THEN
        RAISE EXCEPTION 'Journal approval threshold exceeds the precision supported by %', NEW.functional_currency USING ERRCODE = '22023';
    END IF;

    IF TG_OP = 'UPDATE' THEN
        IF NEW.functional_currency IS DISTINCT FROM OLD.functional_currency
           AND (
               EXISTS (SELECT 1 FROM public.accounting_journals j WHERE j.church_id = NEW.church_id)
               OR EXISTS (SELECT 1 FROM public.accounting_source_events e WHERE e.church_id = NEW.church_id)
           ) THEN
            RAISE EXCEPTION 'Functional currency cannot be changed after accounting journal or payment source-event activity exists' USING ERRCODE = '55000';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.accounting_guard_functional_currency_settings() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accounting_guard_functional_currency_settings()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER accounting_settings_currency_guard
    BEFORE INSERT OR UPDATE ON public.accounting_settings
    FOR EACH ROW EXECUTE FUNCTION public.accounting_guard_functional_currency_settings();

-- Centralized review transition. A repeated callback with the same unresolved
-- issue updates the source event timestamp but does not append duplicate audit
-- rows. A materially different reason produces one new audit entry.
CREATE FUNCTION public.accounting_mark_source_event_review(
    p_church_id UUID,
    p_event_id UUID,
    p_error_message TEXT,
    p_description TEXT,
    p_metadata JSONB DEFAULT '{}'::JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_old_status TEXT;
    v_old_error TEXT;
    v_log BOOLEAN;
BEGIN
    IF p_church_id IS NULL OR p_event_id IS NULL
       OR pg_catalog.length(pg_catalog.btrim(COALESCE(p_error_message, ''))) NOT BETWEEN 1 AND 1000
       OR pg_catalog.length(pg_catalog.btrim(COALESCE(p_description, ''))) NOT BETWEEN 1 AND 500
       OR pg_catalog.jsonb_typeof(COALESCE(p_metadata, '{}'::JSONB)) <> 'object' THEN
        RAISE EXCEPTION 'Valid source-event review details are required' USING ERRCODE = '22023';
    END IF;

    SELECT e.status, e.error_message
      INTO v_old_status, v_old_error
      FROM public.accounting_source_events e
     WHERE e.church_id = p_church_id
       AND e.id = p_event_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Accounting source event was not found' USING ERRCODE = 'P0002';
    END IF;

    v_log := v_old_status IS DISTINCT FROM 'requires_review'
        OR v_old_error IS DISTINCT FROM p_error_message;

    UPDATE public.accounting_source_events
       SET status = 'requires_review',
           error_message = p_error_message,
           processed_at = pg_catalog.clock_timestamp()
     WHERE church_id = p_church_id AND id = p_event_id;

    IF v_log THEN
        INSERT INTO public.accounting_audit_log (
            church_id, actor_user_id, action, entity_type, entity_id,
            description, metadata
        ) VALUES (
            p_church_id, NULL, 'payment_event_review_required', 'source_event', p_event_id,
            p_description, COALESCE(p_metadata, '{}'::JSONB)
        );
    END IF;

    RETURN v_log;
END;
$function$;

ALTER FUNCTION public.accounting_mark_source_event_review(UUID, UUID, TEXT, TEXT, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accounting_mark_source_event_review(UUID, UUID, TEXT, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 4. Updated-at and immutability triggers
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.accounting_prevent_posted_journal_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'Accounting journals cannot be deleted; use a reversal or void workflow';
    END IF;

    IF OLD.status IN ('posted', 'reversed', 'voided') THEN
        IF OLD.status = 'posted'
           AND NEW.status = 'reversed'
           AND pg_catalog.current_setting('app.accounting_allow_reversal', TRUE) = 'on' THEN
            RETURN NEW;
        END IF;

        RAISE EXCEPTION 'Posted, reversed, or voided journals are immutable';
    END IF;

    RETURN NEW;
END;
$function$;

CREATE FUNCTION public.accounting_prevent_ledger_truncate()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
    RAISE EXCEPTION 'Accounting ledger and source-event history cannot be truncated';
END;
$function$;

CREATE FUNCTION public.accounting_prevent_source_event_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
    RAISE EXCEPTION 'Accounting source events cannot be deleted; preserve their idempotency history';
END;
$function$;

CREATE FUNCTION public.accounting_guard_journal_line_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
DECLARE
    v_old_status TEXT;
    v_new_status TEXT;
    v_currency TEXT;
    v_scale INTEGER;
BEGIN
    IF TG_OP IN ('UPDATE', 'DELETE') THEN
        SELECT j.status INTO v_old_status
          FROM public.accounting_journals j
         WHERE j.church_id = OLD.church_id
           AND j.id = OLD.journal_id
         FOR SHARE;

        IF NOT FOUND OR v_old_status <> 'draft' THEN
            RAISE EXCEPTION 'Journal lines cannot be removed or moved from a non-draft journal';
        END IF;
    END IF;

    IF TG_OP IN ('INSERT', 'UPDATE') THEN
        SELECT j.status, j.functional_currency
          INTO v_new_status, v_currency
          FROM public.accounting_journals j
         WHERE j.church_id = NEW.church_id
           AND j.id = NEW.journal_id
         FOR SHARE;

        IF NOT FOUND OR v_new_status <> 'draft' THEN
            RAISE EXCEPTION 'Journal lines may only be inserted or changed while the destination journal is a draft';
        END IF;

        v_scale := CASE v_currency WHEN 'UGX' THEN 0 WHEN 'USD' THEN 2 ELSE NULL END;
        IF v_scale IS NULL
           OR pg_catalog.round(NEW.debit_amount, v_scale) <> NEW.debit_amount
           OR pg_catalog.round(NEW.credit_amount, v_scale) <> NEW.credit_amount THEN
            RAISE EXCEPTION 'Journal line amounts exceed the supported precision for currency %', v_currency;
        END IF;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.accounting_prevent_posted_journal_mutation() OWNER TO postgres;
ALTER FUNCTION public.accounting_prevent_ledger_truncate() OWNER TO postgres;
ALTER FUNCTION public.accounting_prevent_source_event_delete() OWNER TO postgres;
ALTER FUNCTION public.accounting_guard_journal_line_mutation() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accounting_prevent_posted_journal_mutation() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_prevent_ledger_truncate() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_prevent_source_event_delete() FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_guard_journal_line_mutation() FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER accounting_journals_updated_at
    BEFORE UPDATE ON public.accounting_journals
    FOR EACH ROW EXECUTE FUNCTION public.accounting_set_updated_at();

CREATE TRIGGER accounting_journals_immutable_states
    BEFORE UPDATE OR DELETE ON public.accounting_journals
    FOR EACH ROW EXECUTE FUNCTION public.accounting_prevent_posted_journal_mutation();

CREATE TRIGGER accounting_journal_lines_guard_mutation
    BEFORE INSERT OR UPDATE OR DELETE ON public.accounting_journal_lines
    FOR EACH ROW EXECUTE FUNCTION public.accounting_guard_journal_line_mutation();

-- TRUNCATE bypasses row-level immutability triggers. Protect the ledger and
-- idempotency event history against accidental privileged truncation too.
CREATE TRIGGER accounting_journals_no_truncate
    BEFORE TRUNCATE ON public.accounting_journals
    FOR EACH STATEMENT EXECUTE FUNCTION public.accounting_prevent_ledger_truncate();

CREATE TRIGGER accounting_journal_lines_no_truncate
    BEFORE TRUNCATE ON public.accounting_journal_lines
    FOR EACH STATEMENT EXECUTE FUNCTION public.accounting_prevent_ledger_truncate();

CREATE TRIGGER accounting_source_events_no_truncate
    BEFORE TRUNCATE ON public.accounting_source_events
    FOR EACH STATEMENT EXECUTE FUNCTION public.accounting_prevent_ledger_truncate();

CREATE TRIGGER accounting_source_events_no_delete
    BEFORE DELETE ON public.accounting_source_events
    FOR EACH ROW EXECUTE FUNCTION public.accounting_prevent_source_event_delete();

CREATE TRIGGER accounting_giving_mappings_updated_at
    BEFORE UPDATE ON public.accounting_giving_category_mappings
    FOR EACH ROW EXECUTE FUNCTION public.accounting_set_updated_at();

-- ---------------------------------------------------------------------------
-- 5. RLS, grants, and table ownership
-- ---------------------------------------------------------------------------
DO $security$
DECLARE
    v_table TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'accounting_source_events',
        'accounting_giving_category_mappings',
        'accounting_journals',
        'accounting_journal_lines'
    ] LOOP
        EXECUTE pg_catalog.format('ALTER TABLE public.%I OWNER TO postgres', v_table);
        EXECUTE pg_catalog.format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', v_table);
        EXECUTE pg_catalog.format('ALTER TABLE public.%I FORCE ROW LEVEL SECURITY', v_table);
        EXECUTE pg_catalog.format(
            'REVOKE ALL ON TABLE public.%I FROM PUBLIC, anon, authenticated, service_role',
            v_table
        );
        EXECUTE pg_catalog.format('GRANT SELECT ON TABLE public.%I TO authenticated', v_table);
    END LOOP;
END;
$security$;

CREATE POLICY accounting_source_events_financial_read
    ON public.accounting_source_events
    FOR SELECT TO authenticated
    USING (public.has_church_financial_permission(church_id, 'accounting.journals.read'));

CREATE POLICY accounting_giving_mappings_financial_read
    ON public.accounting_giving_category_mappings
    FOR SELECT TO authenticated
    USING (public.has_church_financial_permission(church_id, 'accounting.settings.read'));

CREATE POLICY accounting_journals_financial_read
    ON public.accounting_journals
    FOR SELECT TO authenticated
    USING (public.has_church_financial_permission(church_id, 'accounting.journals.read'));

CREATE POLICY accounting_journal_lines_financial_read
    ON public.accounting_journal_lines
    FOR SELECT TO authenticated
    USING (
        EXISTS (
            SELECT 1
            FROM public.accounting_journals j
            WHERE j.church_id = accounting_journal_lines.church_id
              AND j.id = accounting_journal_lines.journal_id
              AND public.has_church_financial_permission(j.church_id, 'accounting.journals.read')
        )
    );

-- ---------------------------------------------------------------------------
-- 6. Internal journal-line replacement helper
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.accounting_replace_journal_lines(
    p_church_id UUID,
    p_journal_id UUID,
    p_lines JSONB
)
RETURNS TABLE(total_debits NUMERIC, total_credits NUMERIC, line_count INTEGER)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_line JSONB;
    v_account_id UUID;
    v_fund_id UUID;
    v_department_id UUID;
    -- Keep inputs unconstrained until precision has been checked. Declaring
    -- these as NUMERIC(20,4) would silently round values beyond four places
    -- before the UGX/USD validation below could reject them.
    v_debit NUMERIC;
    v_credit NUMERIC;
    v_line_description TEXT;
    v_account_active BOOLEAN;
    v_direct_posting BOOLEAN;
    v_fund_active BOOLEAN;
    v_department_active BOOLEAN;
    v_currency TEXT;
    v_currency_scale INTEGER;
    v_total_debits NUMERIC(20,4) := 0;
    v_total_credits NUMERIC(20,4) := 0;
    v_count INTEGER := 0;
BEGIN
    IF pg_catalog.jsonb_typeof(p_lines) IS DISTINCT FROM 'array'
       OR pg_catalog.jsonb_array_length(p_lines) NOT BETWEEN 2 AND 500 THEN
        RAISE EXCEPTION 'A journal must contain between 2 and 500 lines' USING ERRCODE = '22023';
    END IF;

    SELECT j.functional_currency
      INTO v_currency
      FROM public.accounting_journals j
     WHERE j.church_id = p_church_id
       AND j.id = p_journal_id
       AND j.status = 'draft'
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Draft journal was not found' USING ERRCODE = 'P0002';
    END IF;

    v_currency_scale := CASE v_currency WHEN 'UGX' THEN 0 ELSE 2 END;

    DELETE FROM public.accounting_journal_lines l
     WHERE l.church_id = p_church_id
       AND l.journal_id = p_journal_id;

    FOR v_line IN SELECT value FROM pg_catalog.jsonb_array_elements(p_lines) LOOP
        v_account_id := NULLIF(pg_catalog.btrim(v_line ->> 'account_id'), '')::UUID;
        v_fund_id := NULLIF(pg_catalog.btrim(v_line ->> 'fund_id'), '')::UUID;
        v_department_id := NULLIF(pg_catalog.btrim(v_line ->> 'department_id'), '')::UUID;
        v_debit := COALESCE(NULLIF(pg_catalog.btrim(v_line ->> 'debit_amount'), '')::NUMERIC, 0);
        v_credit := COALESCE(NULLIF(pg_catalog.btrim(v_line ->> 'credit_amount'), '')::NUMERIC, 0);
        v_line_description := NULLIF(pg_catalog.btrim(COALESCE(v_line ->> 'description', '')), '');

        IF v_account_id IS NULL
           OR v_fund_id IS NULL
           OR v_debit < 0
           OR v_credit < 0
           OR ((v_debit > 0) = (v_credit > 0)) THEN
            RAISE EXCEPTION 'Each journal line requires an account, fund, and exactly one positive debit or credit' USING ERRCODE = '22023';
        END IF;

        IF v_debit::TEXT IN ('NaN', 'Infinity', '-Infinity')
           OR v_credit::TEXT IN ('NaN', 'Infinity', '-Infinity') THEN
            RAISE EXCEPTION 'Journal debit and credit amounts must be finite numbers' USING ERRCODE = '22023';
        END IF;

        IF pg_catalog.round(v_debit, v_currency_scale) <> v_debit
           OR pg_catalog.round(v_credit, v_currency_scale) <> v_credit THEN
            RAISE EXCEPTION 'Journal amounts exceed the supported precision for currency %', v_currency USING ERRCODE = '22023';
        END IF;

        IF v_line_description IS NOT NULL AND pg_catalog.length(v_line_description) > 500 THEN
            RAISE EXCEPTION 'Journal line description cannot exceed 500 characters' USING ERRCODE = '22023';
        END IF;

        SELECT a.is_active, a.allow_direct_posting
          INTO v_account_active, v_direct_posting
          FROM public.accounting_accounts a
         WHERE a.church_id = p_church_id
           AND a.id = v_account_id
         FOR SHARE;

        IF NOT FOUND OR v_account_active IS NOT TRUE OR v_direct_posting IS NOT TRUE THEN
            RAISE EXCEPTION 'Every journal line must use an active, direct-posting account belonging to the same church' USING ERRCODE = '23514';
        END IF;

        IF v_fund_id IS NOT NULL THEN
            SELECT f.is_active INTO v_fund_active
            FROM public.accounting_funds f
            WHERE f.church_id = p_church_id AND f.id = v_fund_id
            FOR SHARE;
            IF NOT FOUND OR v_fund_active IS NOT TRUE THEN
                RAISE EXCEPTION 'Journal fund must be active and belong to the same church' USING ERRCODE = '23514';
            END IF;
        END IF;

        IF v_department_id IS NOT NULL THEN
            SELECT d.is_active INTO v_department_active
            FROM public.accounting_departments d
            WHERE d.church_id = p_church_id AND d.id = v_department_id
            FOR SHARE;
            IF NOT FOUND OR v_department_active IS NOT TRUE THEN
                RAISE EXCEPTION 'Journal department must be active and belong to the same church' USING ERRCODE = '23514';
            END IF;
        END IF;

        v_count := v_count + 1;
        v_total_debits := v_total_debits + v_debit;
        v_total_credits := v_total_credits + v_credit;

        INSERT INTO public.accounting_journal_lines (
            church_id, journal_id, line_number, account_id,
            fund_id, department_id, line_description,
            debit_amount, credit_amount
        ) VALUES (
            p_church_id, p_journal_id, v_count, v_account_id,
            v_fund_id, v_department_id, v_line_description,
            v_debit, v_credit
        );
    END LOOP;

    IF v_count < 2 OR v_total_debits <= 0 OR v_total_debits <> v_total_credits THEN
        RAISE EXCEPTION 'Journal is not balanced: total debits % must equal positive total credits %',
            v_total_debits, v_total_credits USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT l.fund_id
        FROM public.accounting_journal_lines l
        WHERE l.church_id = p_church_id AND l.journal_id = p_journal_id
        GROUP BY l.fund_id
        HAVING pg_catalog.sum(l.debit_amount) <> pg_catalog.sum(l.credit_amount)
    ) THEN
        RAISE EXCEPTION 'Each fund must balance independently; use due-to/due-from accounts for inter-fund transfers' USING ERRCODE = '23514';
    END IF;

    UPDATE public.accounting_journals
       SET total_debits = v_total_debits,
           total_credits = v_total_credits
     WHERE church_id = p_church_id AND id = p_journal_id;

    RETURN QUERY SELECT v_total_debits, v_total_credits, v_count;
END;
$function$;

ALTER FUNCTION public.accounting_replace_journal_lines(UUID, UUID, JSONB) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accounting_replace_journal_lines(UUID, UUID, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- 7. Manual journal creation and draft editing
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.accounting_create_journal(
    p_church_id UUID,
    p_period_id UUID,
    p_journal_date DATE,
    p_description TEXT,
    p_lines JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_currency TEXT;
    v_setup_completed_at TIMESTAMPTZ;
    v_period_start DATE;
    v_period_end DATE;
    v_period_status TEXT;
    v_prefix TEXT;
    v_next_number BIGINT;
    v_journal_number TEXT;
    v_journal_id UUID;
    v_totals RECORD;
BEGIN
    IF v_actor IS NULL OR p_church_id IS NULL OR p_period_id IS NULL OR p_journal_date IS NULL THEN
        RAISE EXCEPTION 'Authentication, church, period, and journal date are required' USING ERRCODE = '42501';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(p_church_id, 'accounting.journals.create');

    SELECT s.functional_currency, s.setup_completed_at
      INTO v_currency, v_setup_completed_at
      FROM public.accounting_settings s
     WHERE s.church_id = p_church_id
     FOR SHARE;

    IF NOT FOUND OR v_setup_completed_at IS NULL THEN
        RAISE EXCEPTION 'Church accounting must be initialized before journals can be created' USING ERRCODE = '55000';
    END IF;

    SELECT p.start_date, p.end_date, p.status
      INTO v_period_start, v_period_end, v_period_status
      FROM public.accounting_periods p
     WHERE p.church_id = p_church_id AND p.id = p_period_id
     FOR SHARE;

    IF NOT FOUND OR v_period_status <> 'open'
       OR p_journal_date < v_period_start OR p_journal_date > v_period_end THEN
        RAISE EXCEPTION 'Journal date must fall within an open accounting period belonging to this church' USING ERRCODE = '23514';
    END IF;

    IF pg_catalog.length(pg_catalog.btrim(COALESCE(p_description, ''))) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'Journal description must contain 1 to 500 characters' USING ERRCODE = '22023';
    END IF;

    v_prefix := 'GJ-' || pg_catalog.to_char(p_journal_date, 'YYYY') || '-';
    SELECT pg_catalog.count(*) + 1
      INTO v_next_number
      FROM public.accounting_journals j
     WHERE j.church_id = p_church_id
       AND j.journal_number LIKE v_prefix || '%';
    v_journal_number := v_prefix || pg_catalog.lpad(v_next_number::TEXT, 6, '0');

    INSERT INTO public.accounting_journals (
        church_id, journal_number, period_id, journal_date,
        description, functional_currency, source_type,
        status, approval_required, created_by
    ) VALUES (
        p_church_id, v_journal_number, p_period_id, p_journal_date,
        pg_catalog.btrim(p_description), v_currency, 'manual',
        'draft', TRUE, v_actor
    ) RETURNING id INTO v_journal_id;

    SELECT * INTO v_totals
      FROM public.accounting_replace_journal_lines(p_church_id, v_journal_id, p_lines);

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        p_church_id, v_actor, 'journal_created', 'journal', v_journal_id,
        'Draft journal created.',
        pg_catalog.jsonb_build_object(
            'journal_number', v_journal_number,
            'period_id', p_period_id,
            'journal_date', p_journal_date,
            'total_debits', v_totals.total_debits,
            'total_credits', v_totals.total_credits,
            'line_count', v_totals.line_count
        )
    );

    RETURN v_journal_id;
END;
$function$;

CREATE FUNCTION public.accounting_update_draft_journal(
    p_journal_id UUID,
    p_period_id UUID,
    p_journal_date DATE,
    p_description TEXT,
    p_lines JSONB
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_created_by UUID;
    v_status TEXT;
    v_period_start DATE;
    v_period_end DATE;
    v_period_status TEXT;
    v_totals RECORD;
BEGIN
    IF v_actor IS NULL OR p_journal_id IS NULL OR p_period_id IS NULL OR p_journal_date IS NULL THEN
        RAISE EXCEPTION 'Authentication, journal, period, and journal date are required' USING ERRCODE = '42501';
    END IF;

    SELECT j.church_id INTO v_church_id
    FROM public.accounting_journals j
    WHERE j.id = p_journal_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Journal was not found' USING ERRCODE = 'P0002'; END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.journals.create');

    SELECT j.created_by, j.status
      INTO v_created_by, v_status
      FROM public.accounting_journals j
     WHERE j.church_id = v_church_id AND j.id = p_journal_id
     FOR UPDATE;

    IF NOT FOUND OR v_status <> 'draft' OR v_created_by IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'Only the creator may edit their own draft journal' USING ERRCODE = '42501';
    END IF;

    SELECT p.start_date, p.end_date, p.status
      INTO v_period_start, v_period_end, v_period_status
      FROM public.accounting_periods p
     WHERE p.church_id = v_church_id AND p.id = p_period_id
     FOR SHARE;

    IF NOT FOUND OR v_period_status <> 'open'
       OR p_journal_date < v_period_start OR p_journal_date > v_period_end THEN
        RAISE EXCEPTION 'Journal date must fall within an open accounting period belonging to this church' USING ERRCODE = '23514';
    END IF;

    IF pg_catalog.length(pg_catalog.btrim(COALESCE(p_description, ''))) NOT BETWEEN 1 AND 500 THEN
        RAISE EXCEPTION 'Journal description must contain 1 to 500 characters' USING ERRCODE = '22023';
    END IF;

    UPDATE public.accounting_journals
       SET period_id = p_period_id,
           journal_date = p_journal_date,
           description = pg_catalog.btrim(p_description)
     WHERE church_id = v_church_id AND id = p_journal_id;

    SELECT * INTO v_totals
      FROM public.accounting_replace_journal_lines(v_church_id, p_journal_id, p_lines);

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'journal_updated', 'journal', p_journal_id,
        'Draft journal updated.',
        pg_catalog.jsonb_build_object(
            'period_id', p_period_id,
            'journal_date', p_journal_date,
            'total_debits', v_totals.total_debits,
            'total_credits', v_totals.total_credits,
            'line_count', v_totals.line_count
        )
    );

    RETURN p_journal_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 8. Submit, approve, post, and reverse RPCs
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.accounting_submit_journal(p_journal_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_created_by UUID;
    v_status TEXT;
    v_period_id UUID;
    v_journal_date DATE;
    v_period_status TEXT;
    v_start_date DATE;
    v_end_date DATE;
    v_threshold NUMERIC(20,4);
    v_debits NUMERIC(20,4);
    v_credits NUMERIC(20,4);
    v_actual_debits NUMERIC(20,4);
    v_actual_credits NUMERIC(20,4);
    v_line_count INTEGER;
    v_currency TEXT;
    v_requires_approval BOOLEAN;
BEGIN
    IF v_actor IS NULL OR p_journal_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and journal are required' USING ERRCODE = '42501';
    END IF;

    SELECT j.church_id INTO v_church_id FROM public.accounting_journals j WHERE j.id = p_journal_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Journal was not found' USING ERRCODE = 'P0002'; END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.journals.create');

    SELECT j.created_by, j.status, j.period_id, j.journal_date,
           j.total_debits, j.total_credits, j.functional_currency
      INTO v_created_by, v_status, v_period_id, v_journal_date,
           v_debits, v_credits, v_currency
      FROM public.accounting_journals j
     WHERE j.church_id = v_church_id AND j.id = p_journal_id
     FOR UPDATE;

    IF v_status <> 'draft' OR v_created_by IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'Only the creator may submit their own draft journal' USING ERRCODE = '42501';
    END IF;

    SELECT p.status, p.start_date, p.end_date
      INTO v_period_status, v_start_date, v_end_date
      FROM public.accounting_periods p
     WHERE p.church_id = v_church_id AND p.id = v_period_id
     FOR SHARE;

    IF NOT FOUND OR v_period_status <> 'open'
       OR v_journal_date < v_start_date OR v_journal_date > v_end_date THEN
        RAISE EXCEPTION 'Journal period is no longer open or does not contain the journal date' USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE(pg_catalog.sum(l.debit_amount), 0),
           COALESCE(pg_catalog.sum(l.credit_amount), 0),
           pg_catalog.count(*)::INTEGER
      INTO v_actual_debits, v_actual_credits, v_line_count
      FROM public.accounting_journal_lines l
     WHERE l.church_id = v_church_id AND l.journal_id = p_journal_id;

    IF v_line_count < 2 OR v_debits <= 0 OR v_debits <> v_credits
       OR v_actual_debits <> v_actual_credits
       OR v_actual_debits <> v_debits OR v_actual_credits <> v_credits THEN
        RAISE EXCEPTION 'Only a balanced journal with at least two matching debit/credit lines can be submitted' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT l.fund_id
        FROM public.accounting_journal_lines l
        WHERE l.church_id = v_church_id AND l.journal_id = p_journal_id
        GROUP BY l.fund_id
        HAVING pg_catalog.sum(l.debit_amount) <> pg_catalog.sum(l.credit_amount)
    ) THEN
        RAISE EXCEPTION 'Every fund represented in a journal must balance independently before submission' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.accounting_journal_lines l
        JOIN public.accounting_accounts a
          ON a.church_id = l.church_id AND a.id = l.account_id
        WHERE l.church_id = v_church_id AND l.journal_id = p_journal_id
          AND (a.is_active IS NOT TRUE OR a.allow_direct_posting IS NOT TRUE)
    ) THEN
        RAISE EXCEPTION 'All journal accounts must remain active and direct-postable before submission' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.accounting_journal_lines l
        LEFT JOIN public.accounting_funds f
          ON f.church_id = l.church_id AND f.id = l.fund_id
        WHERE l.church_id = v_church_id AND l.journal_id = p_journal_id
          AND l.fund_id IS NOT NULL AND (f.id IS NULL OR f.is_active IS NOT TRUE)
    ) OR EXISTS (
        SELECT 1
        FROM public.accounting_journal_lines l
        LEFT JOIN public.accounting_departments d
          ON d.church_id = l.church_id AND d.id = l.department_id
        WHERE l.church_id = v_church_id AND l.journal_id = p_journal_id
          AND l.department_id IS NOT NULL AND (d.id IS NULL OR d.is_active IS NOT TRUE)
    ) THEN
        RAISE EXCEPTION 'All journal funds and departments must remain active before submission' USING ERRCODE = '23514';
    END IF;

    SELECT s.journal_approval_threshold
      INTO v_threshold
      FROM public.accounting_settings s
     WHERE s.church_id = v_church_id
       AND s.functional_currency = v_currency
       AND s.setup_completed_at IS NOT NULL
     FOR SHARE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Initialized church accounting settings were not found' USING ERRCODE = '55000';
    END IF;

    v_requires_approval := v_debits >= v_threshold;

    UPDATE public.accounting_journals
       SET status = 'submitted',
           approval_required = v_requires_approval,
           submitted_by = v_actor,
           submitted_at = pg_catalog.clock_timestamp()
     WHERE church_id = v_church_id AND id = p_journal_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'journal_submitted', 'journal', p_journal_id,
        'Journal submitted for posting review.',
        pg_catalog.jsonb_build_object(
            'total_debits', v_debits,
            'functional_currency', v_currency,
            'approval_required', v_requires_approval,
            'approval_threshold', v_threshold
        )
    );
END;
$function$;

CREATE FUNCTION public.accounting_approve_journal(p_journal_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_created_by UUID;
    v_status TEXT;
    v_total NUMERIC(20,4);
BEGIN
    IF v_actor IS NULL OR p_journal_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and journal are required' USING ERRCODE = '42501';
    END IF;

    SELECT j.church_id INTO v_church_id FROM public.accounting_journals j WHERE j.id = p_journal_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Journal was not found' USING ERRCODE = 'P0002'; END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.journals.approve');

    SELECT j.created_by, j.status, j.total_debits
      INTO v_created_by, v_status, v_total
      FROM public.accounting_journals j
     WHERE j.church_id = v_church_id AND j.id = p_journal_id
     FOR UPDATE;

    IF v_status <> 'submitted' THEN
        RAISE EXCEPTION 'Only submitted journals can be approved' USING ERRCODE = '55000';
    END IF;

    IF v_created_by IS NOT NULL AND v_created_by = v_actor THEN
        RAISE EXCEPTION 'The journal creator cannot approve their own journal' USING ERRCODE = '42501';
    END IF;

    UPDATE public.accounting_journals
       SET status = 'approved',
           approved_by = v_actor,
           approved_at = pg_catalog.clock_timestamp()
     WHERE church_id = v_church_id AND id = p_journal_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'journal_approved', 'journal', p_journal_id,
        'Journal approved by an authorized independent approver.',
        pg_catalog.jsonb_build_object('total_debits', v_total)
    );
END;
$function$;

CREATE FUNCTION public.accounting_return_journal_to_draft(
    p_journal_id UUID,
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
    v_created_by UUID;
    v_status TEXT;
    v_source_type TEXT;
    v_source_event_id UUID;
BEGIN
    IF v_actor IS NULL OR p_journal_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and journal are required' USING ERRCODE = '42501';
    END IF;
    IF pg_catalog.length(pg_catalog.btrim(COALESCE(p_reason, ''))) NOT BETWEEN 10 AND 500 THEN
        RAISE EXCEPTION 'Return reason must contain between 10 and 500 characters' USING ERRCODE = '22023';
    END IF;

    SELECT j.church_id INTO v_church_id
      FROM public.accounting_journals j
     WHERE j.id = p_journal_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Journal was not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.journals.approve');

    SELECT j.created_by, j.status, j.source_type, j.source_event_id
      INTO v_created_by, v_status, v_source_type, v_source_event_id
      FROM public.accounting_journals j
     WHERE j.church_id = v_church_id AND j.id = p_journal_id
     FOR UPDATE;

    IF v_status <> 'submitted' OR v_source_type <> 'manual' OR v_source_event_id IS NOT NULL THEN
        RAISE EXCEPTION 'Only submitted manual journals can be returned to their creator' USING ERRCODE = '55000';
    END IF;
    IF v_created_by IS NULL OR v_created_by = v_actor THEN
        RAISE EXCEPTION 'Only an independent approver may return a manual journal to its creator' USING ERRCODE = '42501';
    END IF;

    UPDATE public.accounting_journals
       SET status = 'draft',
           submitted_by = NULL,
           submitted_at = NULL
     WHERE church_id = v_church_id AND id = p_journal_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'journal_returned_to_draft', 'journal', p_journal_id,
        'Submitted journal returned to its creator for correction.',
        pg_catalog.jsonb_build_object('reason', pg_catalog.btrim(p_reason), 'created_by', v_created_by)
    );
END;
$function$;

CREATE FUNCTION public.accounting_post_journal(p_journal_id UUID)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_status TEXT;
    v_period_id UUID;
    v_journal_date DATE;
    v_total_debits NUMERIC(20,4);
    v_total_credits NUMERIC(20,4);
    v_actual_debits NUMERIC(20,4);
    v_actual_credits NUMERIC(20,4);
    v_line_count INTEGER;
    v_approval_required BOOLEAN;
    v_approved_by UUID;
    v_created_by UUID;
    v_reversal_of UUID;
    v_source_event_id UUID;
    v_period_status TEXT;
    v_period_start DATE;
    v_period_end DATE;
    v_original_status TEXT;
BEGIN
    IF v_actor IS NULL OR p_journal_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and journal are required' USING ERRCODE = '42501';
    END IF;

    SELECT j.church_id INTO v_church_id FROM public.accounting_journals j WHERE j.id = p_journal_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Journal was not found' USING ERRCODE = 'P0002'; END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.journals.post');

    SELECT j.status, j.period_id, j.journal_date, j.total_debits,
           j.total_credits, j.approval_required, j.approved_by,
           j.created_by, j.reversal_of_journal_id, j.source_event_id
      INTO v_status, v_period_id, v_journal_date, v_total_debits,
           v_total_credits, v_approval_required, v_approved_by,
           v_created_by, v_reversal_of, v_source_event_id
      FROM public.accounting_journals j
     WHERE j.church_id = v_church_id AND j.id = p_journal_id
     FOR UPDATE;

    IF v_status NOT IN ('submitted', 'approved') THEN
        RAISE EXCEPTION 'Only submitted or approved journals can be posted' USING ERRCODE = '55000';
    END IF;

    SELECT COALESCE(pg_catalog.sum(l.debit_amount), 0),
           COALESCE(pg_catalog.sum(l.credit_amount), 0),
           pg_catalog.count(*)::INTEGER
      INTO v_actual_debits, v_actual_credits, v_line_count
      FROM public.accounting_journal_lines l
     WHERE l.church_id = v_church_id AND l.journal_id = p_journal_id;

    IF v_line_count < 2 OR v_total_debits <= 0 OR v_total_debits <> v_total_credits
       OR v_actual_debits <> v_actual_credits
       OR v_actual_debits <> v_total_debits OR v_actual_credits <> v_total_credits THEN
        RAISE EXCEPTION 'Journal is not balanced or its line totals do not match the journal header' USING ERRCODE = '23514';
    END IF;

    IF EXISTS (
        SELECT l.fund_id
        FROM public.accounting_journal_lines l
        WHERE l.church_id = v_church_id AND l.journal_id = p_journal_id
        GROUP BY l.fund_id
        HAVING pg_catalog.sum(l.debit_amount) <> pg_catalog.sum(l.credit_amount)
    ) THEN
        RAISE EXCEPTION 'Every fund represented in a journal must balance independently before posting' USING ERRCODE = '23514';
    END IF;

    IF v_approval_required IS TRUE AND (v_status <> 'approved' OR v_approved_by IS NULL) THEN
        RAISE EXCEPTION 'This journal requires independent approval before posting' USING ERRCODE = '42501';
    END IF;

    IF v_approved_by IS NOT NULL AND v_created_by IS NOT NULL
       AND v_approved_by = v_created_by THEN
        RAISE EXCEPTION 'Journal creator and approver must be different users' USING ERRCODE = '42501';
    END IF;

    SELECT p.status, p.start_date, p.end_date
      INTO v_period_status, v_period_start, v_period_end
      FROM public.accounting_periods p
     WHERE p.church_id = v_church_id AND p.id = v_period_id
     FOR UPDATE;

    IF NOT FOUND OR v_period_status <> 'open'
       OR v_journal_date < v_period_start OR v_journal_date > v_period_end THEN
        RAISE EXCEPTION 'Journal cannot post because its accounting period is not open or does not contain its date' USING ERRCODE = '23514';
    END IF;

    IF v_reversal_of IS NULL AND (
        EXISTS (
            SELECT 1
            FROM public.accounting_journal_lines l
            JOIN public.accounting_accounts a
              ON a.church_id = l.church_id AND a.id = l.account_id
            WHERE l.church_id = v_church_id AND l.journal_id = p_journal_id
              AND (a.is_active IS NOT TRUE OR a.allow_direct_posting IS NOT TRUE)
        ) OR EXISTS (
            SELECT 1
            FROM public.accounting_journal_lines l
            LEFT JOIN public.accounting_funds f
              ON f.church_id = l.church_id AND f.id = l.fund_id
            WHERE l.church_id = v_church_id AND l.journal_id = p_journal_id
              AND l.fund_id IS NOT NULL AND (f.id IS NULL OR f.is_active IS NOT TRUE)
        ) OR EXISTS (
            SELECT 1
            FROM public.accounting_journal_lines l
            LEFT JOIN public.accounting_departments d
              ON d.church_id = l.church_id AND d.id = l.department_id
            WHERE l.church_id = v_church_id AND l.journal_id = p_journal_id
              AND l.department_id IS NOT NULL AND (d.id IS NULL OR d.is_active IS NOT TRUE)
        )
    ) THEN
        RAISE EXCEPTION 'Journal contains an inactive, non-postable, or foreign accounting dimension' USING ERRCODE = '23514';
    END IF;

    IF v_reversal_of IS NOT NULL THEN
        SELECT j.status INTO v_original_status
        FROM public.accounting_journals j
        WHERE j.church_id = v_church_id AND j.id = v_reversal_of
        FOR UPDATE;
        IF NOT FOUND OR v_original_status <> 'posted' THEN
            RAISE EXCEPTION 'A reversal can only be posted while its original journal remains posted' USING ERRCODE = '23514';
        END IF;
    END IF;

    UPDATE public.accounting_journals
       SET status = 'posted',
           posted_by = v_actor,
           posted_at = pg_catalog.clock_timestamp()
     WHERE church_id = v_church_id AND id = p_journal_id;

    IF v_reversal_of IS NOT NULL THEN
        PERFORM pg_catalog.set_config('app.accounting_allow_reversal', 'on', TRUE);
        UPDATE public.accounting_journals
           SET status = 'reversed',
               reversed_by = v_actor,
               reversed_at = pg_catalog.clock_timestamp()
         WHERE church_id = v_church_id AND id = v_reversal_of;
        PERFORM pg_catalog.set_config('app.accounting_allow_reversal', 'off', TRUE);

        INSERT INTO public.accounting_audit_log (
            church_id, actor_user_id, action, entity_type, entity_id,
            description, metadata
        ) VALUES (
            v_church_id, v_actor, 'journal_reversal_posted', 'journal', v_reversal_of,
            'Reversal journal posted; original journal is now reversed.',
            pg_catalog.jsonb_build_object('reversal_journal_id', p_journal_id)
        );
    END IF;

    IF v_source_event_id IS NOT NULL THEN
        UPDATE public.accounting_source_events
           SET status = 'journal_posted',
               processed_at = pg_catalog.clock_timestamp(),
               error_message = NULL
         WHERE id = v_source_event_id
           AND status = 'journal_created';
    END IF;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'journal_posted', 'journal', p_journal_id,
        'Journal posted to the church accounting ledger.',
        pg_catalog.jsonb_build_object(
            'total_debits', v_total_debits,
            'total_credits', v_total_credits,
            'reversal_of_journal_id', v_reversal_of
        )
    );
END;
$function$;

CREATE FUNCTION public.accounting_reverse_journal(
    p_journal_id UUID,
    p_reversal_date DATE,
    p_reason TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_church_id UUID;
    v_original_status TEXT;
    v_original_number TEXT;
    v_period_id UUID;
    v_period_count INTEGER;
    v_currency TEXT;
    v_total NUMERIC(20,4);
    v_prefix TEXT;
    v_next_number BIGINT;
    v_reversal_number TEXT;
    v_reversal_id UUID;
BEGIN
    IF v_actor IS NULL OR p_journal_id IS NULL OR p_reversal_date IS NULL THEN
        RAISE EXCEPTION 'Authentication, journal, and reversal date are required' USING ERRCODE = '42501';
    END IF;
    IF pg_catalog.length(pg_catalog.btrim(COALESCE(p_reason, ''))) NOT BETWEEN 10 AND 500 THEN
        RAISE EXCEPTION 'Reversal reason must contain 10 to 500 characters' USING ERRCODE = '22023';
    END IF;

    SELECT j.church_id INTO v_church_id FROM public.accounting_journals j WHERE j.id = p_journal_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Original journal was not found' USING ERRCODE = 'P0002'; END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.journals.reverse');

    SELECT j.status, j.journal_number, j.functional_currency, j.total_debits
      INTO v_original_status, v_original_number, v_currency, v_total
      FROM public.accounting_journals j
     WHERE j.church_id = v_church_id AND j.id = p_journal_id
     FOR UPDATE;

    IF v_original_status <> 'posted' THEN
        RAISE EXCEPTION 'Only a posted journal can be reversed' USING ERRCODE = '55000';
    END IF;

    IF EXISTS (
        SELECT 1 FROM public.accounting_journals j
        WHERE j.church_id = v_church_id
          AND j.reversal_of_journal_id = p_journal_id
          AND j.status <> 'voided'
    ) THEN
        RAISE EXCEPTION 'A reversal journal already exists for this journal' USING ERRCODE = '23505';
    END IF;

    SELECT pg_catalog.count(*) INTO v_period_count
    FROM public.accounting_periods p
    WHERE p.church_id = v_church_id
      AND p.status = 'open'
      AND p.start_date <= p_reversal_date
      AND p.end_date >= p_reversal_date;

    IF v_period_count <> 1 THEN
        RAISE EXCEPTION 'Reversal date must fall in exactly one open accounting period' USING ERRCODE = '23514';
    END IF;

    SELECT p.id INTO v_period_id
    FROM public.accounting_periods p
    WHERE p.church_id = v_church_id
      AND p.status = 'open'
      AND p.start_date <= p_reversal_date
      AND p.end_date >= p_reversal_date
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'The selected reversal period was closed during the operation; retry in an open period' USING ERRCODE = '23514';
    END IF;

    PERFORM 1
    FROM public.accounting_settings s
    WHERE s.church_id = v_church_id AND s.setup_completed_at IS NOT NULL
    FOR SHARE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Initialized accounting settings were not found' USING ERRCODE = '55000'; END IF;

    v_prefix := 'RJ-' || pg_catalog.to_char(p_reversal_date, 'YYYY') || '-';
    SELECT pg_catalog.count(*) + 1 INTO v_next_number
    FROM public.accounting_journals j
    WHERE j.church_id = v_church_id AND j.journal_number LIKE v_prefix || '%';
    v_reversal_number := v_prefix || pg_catalog.lpad(v_next_number::TEXT, 6, '0');

    INSERT INTO public.accounting_journals (
        church_id, journal_number, period_id, journal_date, description,
        functional_currency, source_type, reversal_of_journal_id,
        status, total_debits, total_credits, approval_required, created_by
    ) VALUES (
        v_church_id, v_reversal_number, v_period_id, p_reversal_date,
        pg_catalog.left('Reversal of ' || v_original_number || ': ' || pg_catalog.btrim(p_reason), 500),
        v_currency, 'manual_reversal', p_journal_id,
        'draft', v_total, v_total, TRUE, v_actor
    ) RETURNING id INTO v_reversal_id;

    INSERT INTO public.accounting_journal_lines (
        church_id, journal_id, line_number, account_id,
        fund_id, department_id, line_description,
        debit_amount, credit_amount
    )
    SELECT
        l.church_id, v_reversal_id, l.line_number, l.account_id,
        l.fund_id, l.department_id,
        pg_catalog.left('Reversal: ' || COALESCE(l.line_description, 'Original journal line'), 500),
        l.credit_amount, l.debit_amount
    FROM public.accounting_journal_lines l
    WHERE l.church_id = v_church_id AND l.journal_id = p_journal_id
    ORDER BY l.line_number;

    UPDATE public.accounting_journals
       SET status = 'submitted',
           submitted_by = v_actor,
           submitted_at = pg_catalog.clock_timestamp()
     WHERE church_id = v_church_id AND id = v_reversal_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'journal_reversal_requested', 'journal', p_journal_id,
        'A reversing journal was created and submitted for independent approval.',
        pg_catalog.jsonb_build_object(
            'reversal_journal_id', v_reversal_id,
            'reversal_journal_number', v_reversal_number,
            'reversal_date', p_reversal_date,
            'reason', pg_catalog.btrim(p_reason)
        )
    );

    RETURN v_reversal_id;
END;
$function$;

-- An unposted reversal may be cancelled by its creator before approval/posting.
-- The original posted journal remains untouched; a corrected reversal can then
-- be created because the unique one-reversal index excludes voided reversals.
CREATE FUNCTION public.accounting_void_unposted_reversal(
    p_journal_id UUID,
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
    v_created_by UUID;
    v_reversal_of UUID;
    v_journal_number TEXT;
BEGIN
    IF v_actor IS NULL OR p_journal_id IS NULL THEN
        RAISE EXCEPTION 'Authentication and reversal journal are required' USING ERRCODE = '42501';
    END IF;

    IF pg_catalog.length(pg_catalog.btrim(COALESCE(p_reason, ''))) NOT BETWEEN 10 AND 500 THEN
        RAISE EXCEPTION 'Cancellation reason must contain 10 to 500 characters' USING ERRCODE = '22023';
    END IF;

    SELECT j.church_id INTO v_church_id
      FROM public.accounting_journals j
     WHERE j.id = p_journal_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Reversal journal was not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(v_church_id, 'accounting.journals.reverse');

    SELECT j.status, j.created_by, j.reversal_of_journal_id, j.journal_number
      INTO v_status, v_created_by, v_reversal_of, v_journal_number
      FROM public.accounting_journals j
     WHERE j.church_id = v_church_id AND j.id = p_journal_id
     FOR UPDATE;

    IF v_reversal_of IS NULL OR v_status NOT IN ('draft', 'submitted', 'approved') THEN
        RAISE EXCEPTION 'Only an unposted reversal journal may be cancelled' USING ERRCODE = '55000';
    END IF;

    IF v_created_by IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'Only the creator may cancel an unposted reversal journal' USING ERRCODE = '42501';
    END IF;

    UPDATE public.accounting_journals
       SET status = 'voided',
           voided_by = v_actor,
           voided_at = pg_catalog.clock_timestamp(),
           void_reason = pg_catalog.btrim(p_reason)
     WHERE church_id = v_church_id AND id = p_journal_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        v_church_id, v_actor, 'journal_voided', 'journal', p_journal_id,
        'Unposted reversal journal cancelled by its creator; original posted journal remains unchanged.',
        pg_catalog.jsonb_build_object(
            'journal_number', v_journal_number,
            'reversal_of_journal_id', v_reversal_of,
            'reason', pg_catalog.btrim(p_reason)
        )
    );
END;
$function$;

-- ---------------------------------------------------------------------------
-- 9. Approval threshold and giving-category mapping configuration RPCs
-- ---------------------------------------------------------------------------
CREATE FUNCTION public.accounting_update_journal_approval_threshold(
    p_church_id UUID,
    p_threshold NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_currency TEXT;
BEGIN
    IF p_threshold::TEXT IN ('NaN', 'Infinity', '-Infinity') THEN
        RAISE EXCEPTION 'Approval threshold must be a finite numeric amount' USING ERRCODE = '22023';
    END IF;

    IF v_actor IS NULL OR p_church_id IS NULL OR p_threshold IS NULL OR p_threshold < 0 THEN
        RAISE EXCEPTION 'Authentication, church, and a finite non-negative approval threshold are required' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(p_church_id, 'accounting.approvals.rules.manage');

    SELECT s.functional_currency INTO v_currency
    FROM public.accounting_settings s
    WHERE s.church_id = p_church_id AND s.setup_completed_at IS NOT NULL
    FOR UPDATE;

    IF NOT FOUND THEN RAISE EXCEPTION 'Church accounting must be initialized first' USING ERRCODE = '55000'; END IF;

    IF pg_catalog.round(p_threshold, CASE v_currency WHEN 'UGX' THEN 0 ELSE 2 END) <> p_threshold THEN
        RAISE EXCEPTION 'Approval threshold exceeds the precision supported by %', v_currency USING ERRCODE = '22023';
    END IF;

    UPDATE public.accounting_settings
       SET journal_approval_threshold = p_threshold
     WHERE church_id = p_church_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        p_church_id, v_actor, 'journal_approval_threshold_updated',
        'accounting_settings', p_church_id,
        'Journal approval threshold updated.',
        pg_catalog.jsonb_build_object('threshold', p_threshold, 'currency', v_currency)
    );
END;
$function$;

CREATE FUNCTION public.accounting_upsert_giving_category_mapping(
    p_church_id UUID,
    p_giving_category TEXT,
    p_income_account_id UUID,
    p_clearing_account_id UUID,
    p_fund_id UUID,
    p_department_id UUID DEFAULT NULL,
    p_is_active BOOLEAN DEFAULT TRUE
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor UUID := auth.uid();
    v_income_type TEXT;
    v_income_normal_balance TEXT;
    v_income_active BOOLEAN;
    v_income_direct BOOLEAN;
    v_clearing_type TEXT;
    v_clearing_normal_balance TEXT;
    v_clearing_active BOOLEAN;
    v_clearing_direct BOOLEAN;
    v_fund_active BOOLEAN;
    v_department_active BOOLEAN;
    v_mapping_id UUID;
BEGIN
    IF v_actor IS NULL OR p_church_id IS NULL OR p_income_account_id IS NULL
       OR p_clearing_account_id IS NULL OR p_fund_id IS NULL THEN
        RAISE EXCEPTION 'Authentication, church, income account, clearing account, and fund are required' USING ERRCODE = '42501';
    END IF;

    IF p_giving_category IS NULL
       OR p_giving_category NOT IN ('Tithes', 'Offerings', 'Building Fund', 'Missions & Outreach', 'Special Seed') THEN
        RAISE EXCEPTION 'Unsupported giving category' USING ERRCODE = '22023';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_church_id::TEXT, 0));
    PERFORM public.assert_church_accounting_permission(p_church_id, 'accounting.settings.manage');

    SELECT a.account_type, a.normal_balance, a.is_active, a.allow_direct_posting
      INTO v_income_type, v_income_normal_balance, v_income_active, v_income_direct
      FROM public.accounting_accounts a
     WHERE a.church_id = p_church_id AND a.id = p_income_account_id
     FOR SHARE;
    IF NOT FOUND OR v_income_type <> 'income' OR v_income_normal_balance <> 'credit'
       OR v_income_active IS NOT TRUE OR v_income_direct IS NOT TRUE THEN
        RAISE EXCEPTION 'Income mapping must target an active, direct-posting credit-normal income account in this church' USING ERRCODE = '23514';
    END IF;

    SELECT a.account_type, a.normal_balance, a.is_active, a.allow_direct_posting
      INTO v_clearing_type, v_clearing_normal_balance, v_clearing_active, v_clearing_direct
      FROM public.accounting_accounts a
     WHERE a.church_id = p_church_id AND a.id = p_clearing_account_id
     FOR SHARE;
    IF NOT FOUND OR v_clearing_type <> 'asset' OR v_clearing_normal_balance <> 'debit'
       OR v_clearing_active IS NOT TRUE OR v_clearing_direct IS NOT TRUE THEN
        RAISE EXCEPTION 'Clearing mapping must target an active, direct-posting debit-normal asset account in this church' USING ERRCODE = '23514';
    END IF;

    SELECT f.is_active INTO v_fund_active
    FROM public.accounting_funds f
    WHERE f.church_id = p_church_id AND f.id = p_fund_id
    FOR SHARE;
    IF NOT FOUND OR v_fund_active IS NOT TRUE THEN
        RAISE EXCEPTION 'Giving mapping fund must be active and belong to this church' USING ERRCODE = '23514';
    END IF;

    IF p_department_id IS NOT NULL THEN
        SELECT d.is_active INTO v_department_active
        FROM public.accounting_departments d
        WHERE d.church_id = p_church_id AND d.id = p_department_id
        FOR SHARE;
        IF NOT FOUND OR v_department_active IS NOT TRUE THEN
            RAISE EXCEPTION 'Giving mapping department must be active and belong to this church' USING ERRCODE = '23514';
        END IF;
    END IF;

    INSERT INTO public.accounting_giving_category_mappings (
        church_id, giving_category, income_account_id, clearing_account_id,
        fund_id, department_id, is_active, created_by, updated_by
    ) VALUES (
        p_church_id, p_giving_category, p_income_account_id, p_clearing_account_id,
        p_fund_id, p_department_id, COALESCE(p_is_active, TRUE), v_actor, v_actor
    )
    ON CONFLICT (church_id, giving_category) DO UPDATE
       SET income_account_id = EXCLUDED.income_account_id,
           clearing_account_id = EXCLUDED.clearing_account_id,
           fund_id = EXCLUDED.fund_id,
           department_id = EXCLUDED.department_id,
           is_active = EXCLUDED.is_active,
           updated_by = EXCLUDED.updated_by
    RETURNING id INTO v_mapping_id;

    INSERT INTO public.accounting_audit_log (
        church_id, actor_user_id, action, entity_type, entity_id,
        description, metadata
    ) VALUES (
        p_church_id, v_actor, 'giving_mapping_updated', 'giving_category_mapping', v_mapping_id,
        'Giving category accounting mapping created or updated.',
        pg_catalog.jsonb_build_object(
            'giving_category', p_giving_category,
            'income_account_id', p_income_account_id,
            'clearing_account_id', p_clearing_account_id,
            'fund_id', p_fund_id,
            'department_id', p_department_id,
            'is_active', COALESCE(p_is_active, TRUE)
        )
    );

    RETURN v_mapping_id;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 10. Trusted Pesapal transaction capture (service_role only)
-- ---------------------------------------------------------------------------
-- p_exchange_rate means functional-currency units per one source-currency unit
-- (for example, UGX per USD when the church functional currency is UGX).
CREATE FUNCTION public.accounting_process_pesapal_transaction(
    p_transaction_id UUID,
    p_exchange_rate NUMERIC DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_church_id UUID;
    v_transaction RECORD;
    v_event_type TEXT;
    v_event_id UUID;
    v_event_status TEXT;
    v_event_at TIMESTAMPTZ;
    v_completed_event_id UUID;
    v_existing_journal_id UUID;
    v_settings RECORD;
    v_mapping RECORD;
    v_transaction_date DATE;
    v_period_id UUID;
    v_period_count INTEGER;
    v_functional_currency TEXT;
    v_source_currency TEXT;
    v_rate NUMERIC(20,10);
    v_functional_amount NUMERIC(20,4);
    v_currency_scale INTEGER;
    v_journal_number TEXT;
    v_next_number BIGINT;
    v_prefix TEXT;
    v_journal_id UUID;
    v_original_journal RECORD;
    v_review_message TEXT;
BEGIN
    IF COALESCE(auth.role(), pg_catalog.current_setting('request.jwt.claim.role', TRUE), '')
       IS DISTINCT FROM 'service_role' THEN
        RAISE EXCEPTION 'Only the trusted server payment integration may capture Pesapal accounting events' USING ERRCODE = '42501';
    END IF;

    IF p_transaction_id IS NULL THEN
        RAISE EXCEPTION 'Transaction ID is required' USING ERRCODE = '22023';
    END IF;

    SELECT t.church_id INTO v_church_id
      FROM public.transactions t
     WHERE t.id = p_transaction_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Payment transaction was not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_church_id::TEXT, 0));

    SELECT t.id, t.church_id, t.merchant_reference, t.amount,
           COALESCE(pg_catalog.upper(t.currency), 'UGX') AS currency,
           t.payment_type, t.payment_method, t.status,
           t.pesapal_completed_at, t.pesapal_reversed_at
      INTO v_transaction
      FROM public.transactions t
     WHERE t.id = p_transaction_id
       AND t.church_id = v_church_id
     FOR UPDATE;

    IF NOT FOUND OR pg_catalog.lower(COALESCE(v_transaction.payment_method, '')) <> 'pesapal' THEN
        RAISE EXCEPTION 'Only an existing Pesapal transaction can be captured' USING ERRCODE = '23514';
    END IF;

    IF v_transaction.status NOT IN ('COMPLETED', 'REVERSED') THEN
        RAISE EXCEPTION 'Only verified COMPLETED or REVERSED transactions can create accounting source events' USING ERRCODE = '55000';
    END IF;

    v_event_type := CASE v_transaction.status
        WHEN 'COMPLETED' THEN 'payment_completed'
        ELSE 'payment_reversed'
    END;
    v_event_at := CASE v_event_type
        WHEN 'payment_completed' THEN v_transaction.pesapal_completed_at
        ELSE v_transaction.pesapal_reversed_at
    END;
    v_source_currency := v_transaction.currency;

    IF v_transaction.amount IS NULL
       OR v_transaction.amount::TEXT IN ('NaN', 'Infinity', '-Infinity')
       OR v_transaction.amount <= 0 THEN
        RAISE EXCEPTION 'Payment transaction amount must be a finite positive number' USING ERRCODE = '23514';
    END IF;
    IF v_source_currency NOT IN ('UGX', 'USD') THEN
        RAISE EXCEPTION 'Migration 004 accepts Pesapal source currencies UGX and USD only' USING ERRCODE = '22023';
    END IF;
    IF (v_source_currency = 'UGX' AND v_transaction.amount <> pg_catalog.trunc(v_transaction.amount))
       OR (v_source_currency = 'USD' AND v_transaction.amount <> pg_catalog.round(v_transaction.amount, 2)) THEN
        RAISE EXCEPTION 'Pesapal transaction amount exceeds the precision supported by %', v_source_currency USING ERRCODE = '23514';
    END IF;

    INSERT INTO public.accounting_source_events (
        church_id, source_type, source_transaction_id, event_type,
        source_event_at, status, source_reference, source_amount, source_currency
    ) VALUES (
        v_church_id, 'pesapal_transaction', p_transaction_id, v_event_type,
        v_event_at, 'requires_review', v_transaction.merchant_reference,
        v_transaction.amount, v_source_currency
    )
    ON CONFLICT (church_id, source_type, source_transaction_id, event_type) DO NOTHING;

    SELECT e.id, e.status, e.source_event_at
      INTO v_event_id, v_event_status, v_event_at
      FROM public.accounting_source_events e
     WHERE e.church_id = v_church_id
       AND e.source_type = 'pesapal_transaction'
       AND e.source_transaction_id = p_transaction_id
       AND e.event_type = v_event_type
     FOR UPDATE;

    IF v_event_status IN (
        'journal_created', 'journal_posted', 'voided', 'no_journal_to_reverse'
    ) THEN
        SELECT j.id INTO v_existing_journal_id
          FROM public.accounting_journals j
         WHERE j.church_id = v_church_id
           AND j.source_event_id = v_event_id;
        RETURN pg_catalog.jsonb_build_object(
            'event_id', v_event_id,
            'journal_id', v_existing_journal_id,
            'status', v_event_status,
            'idempotent_replay', TRUE
        );
    END IF;

    IF v_event_at IS NULL AND v_transaction.status = 'COMPLETED' THEN
        v_event_at := v_transaction.pesapal_completed_at;
    ELSIF v_event_at IS NULL THEN
        v_event_at := v_transaction.pesapal_reversed_at;
    END IF;

    IF v_event_at IS NOT NULL THEN
        UPDATE public.accounting_source_events
           SET source_event_at = COALESCE(source_event_at, v_event_at)
         WHERE church_id = v_church_id AND id = v_event_id;
        SELECT e.source_event_at INTO v_event_at
          FROM public.accounting_source_events e
         WHERE e.church_id = v_church_id AND e.id = v_event_id;
    END IF;

    IF v_event_at IS NULL THEN
        PERFORM public.accounting_mark_source_event_review(
            v_church_id, v_event_id,
            'No first-verified Pesapal status timestamp is available; manual accounting date review is required.',
            'Verified Pesapal transaction has no reliable first-verification timestamp.',
            pg_catalog.jsonb_build_object('merchant_reference', v_transaction.merchant_reference, 'event_type', v_event_type)
        );
        RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
    END IF;

    IF v_event_type = 'payment_completed' THEN
        SELECT s.functional_currency, s.timezone_name,
               s.journal_approval_threshold, s.setup_completed_at
          INTO v_settings
          FROM public.accounting_settings s
         WHERE s.church_id = v_church_id
         FOR SHARE;

        IF NOT FOUND OR v_settings.setup_completed_at IS NULL THEN
            PERFORM public.accounting_mark_source_event_review(
                v_church_id, v_event_id,
                'Church accounting has not been initialized.',
                'Verified Pesapal payment requires accounting setup.',
                pg_catalog.jsonb_build_object('merchant_reference', v_transaction.merchant_reference)
            );
            RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
        END IF;

        v_functional_currency := v_settings.functional_currency;
        IF v_functional_currency NOT IN ('UGX', 'USD') THEN
            PERFORM public.accounting_mark_source_event_review(
                v_church_id, v_event_id,
                'The church functional currency is outside the UGX/USD scope of Migration 004.',
                'Verified Pesapal payment requires manual currency review.',
                pg_catalog.jsonb_build_object('source_currency', v_source_currency, 'functional_currency', v_functional_currency)
            );
            RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
        END IF;

        SELECT m.income_account_id, m.clearing_account_id,
               m.fund_id, m.department_id
          INTO v_mapping
          FROM public.accounting_giving_category_mappings m
         WHERE m.church_id = v_church_id
           AND m.giving_category = v_transaction.payment_type
           AND m.is_active IS TRUE
         FOR SHARE;

        IF NOT FOUND THEN
            PERFORM public.accounting_mark_source_event_review(
                v_church_id, v_event_id,
                'No active giving-category accounting mapping exists.',
                'Verified Pesapal payment has no active accounting category mapping.',
                pg_catalog.jsonb_build_object('payment_type', v_transaction.payment_type)
            );
            RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
        END IF;

        IF NOT EXISTS (
            SELECT 1
              FROM public.accounting_accounts income_account
              JOIN public.accounting_accounts clearing_account
                ON clearing_account.church_id = income_account.church_id
              JOIN public.accounting_funds f
                ON f.church_id = income_account.church_id
             WHERE income_account.church_id = v_church_id
               AND income_account.id = v_mapping.income_account_id
               AND income_account.account_type = 'income'
               AND income_account.normal_balance = 'credit'
               AND income_account.is_active IS TRUE
               AND income_account.allow_direct_posting IS TRUE
               AND clearing_account.id = v_mapping.clearing_account_id
               AND clearing_account.account_type = 'asset'
               AND clearing_account.normal_balance = 'debit'
               AND clearing_account.is_active IS TRUE
               AND clearing_account.allow_direct_posting IS TRUE
               AND f.id = v_mapping.fund_id
               AND f.is_active IS TRUE
        ) OR (
            v_mapping.department_id IS NOT NULL
            AND NOT EXISTS (
                SELECT 1 FROM public.accounting_departments d
                 WHERE d.church_id = v_church_id
                   AND d.id = v_mapping.department_id
                   AND d.is_active IS TRUE
            )
        ) THEN
            PERFORM public.accounting_mark_source_event_review(
                v_church_id, v_event_id,
                'Giving mapping references an inactive, non-postable, or unsuitable accounting dimension.',
                'Verified Pesapal payment mapping failed live account/fund/department validation.',
                pg_catalog.jsonb_build_object('payment_type', v_transaction.payment_type)
            );
            RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
        END IF;

        IF v_source_currency = v_functional_currency THEN
            v_rate := 1;
        ELSE
            IF p_exchange_rate IS NOT NULL
               AND p_exchange_rate::TEXT IN ('NaN', 'Infinity', '-Infinity') THEN
                PERFORM public.accounting_mark_source_event_review(
                    v_church_id, v_event_id,
                    'A finite exchange rate is required for foreign-currency recognition.',
                    'Verified foreign-currency Pesapal payment supplied a non-finite exchange rate.',
                    pg_catalog.jsonb_build_object('source_currency', v_source_currency, 'functional_currency', v_functional_currency)
                );
                RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
            END IF;

            IF p_exchange_rate IS NULL OR p_exchange_rate <= 0
               OR pg_catalog.round(p_exchange_rate, 10) <> p_exchange_rate THEN
                PERFORM public.accounting_mark_source_event_review(
                    v_church_id, v_event_id,
                    'A positive exchange rate with at most ten decimal places is required for foreign-currency recognition.',
                    'Verified foreign-currency Pesapal payment requires an exchange rate.',
                    pg_catalog.jsonb_build_object('source_currency', v_source_currency, 'functional_currency', v_functional_currency)
                );
                RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
            END IF;
            v_rate := p_exchange_rate;
        END IF;

        v_currency_scale := CASE v_functional_currency WHEN 'UGX' THEN 0 WHEN 'USD' THEN 2 END;
        v_functional_amount := pg_catalog.round(v_transaction.amount * v_rate, v_currency_scale);
        IF v_functional_amount::TEXT IN ('NaN', 'Infinity', '-Infinity') THEN
            PERFORM public.accounting_mark_source_event_review(
                v_church_id, v_event_id,
                'Converted functional amount is not finite.',
                'Verified Pesapal payment produced a non-finite functional amount.',
                pg_catalog.jsonb_build_object('source_amount', v_transaction.amount, 'source_currency', v_source_currency, 'functional_currency', v_functional_currency, 'exchange_rate', v_rate)
            );
            RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
        END IF;

        IF v_functional_amount <= 0 THEN
            PERFORM public.accounting_mark_source_event_review(
                v_church_id, v_event_id,
                'Converted functional amount rounds to zero.',
                'Verified Pesapal payment could not be recognized because its converted amount rounds to zero.',
                pg_catalog.jsonb_build_object('source_amount', v_transaction.amount, 'source_currency', v_source_currency, 'functional_currency', v_functional_currency, 'exchange_rate', v_rate)
            );
            RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
        END IF;

        v_transaction_date := (v_event_at AT TIME ZONE v_settings.timezone_name)::DATE;
        SELECT pg_catalog.count(*) INTO v_period_count
          FROM public.accounting_periods p
         WHERE p.church_id = v_church_id
           AND p.status = 'open'
           AND p.start_date <= v_transaction_date
           AND p.end_date >= v_transaction_date;

        IF v_period_count <> 1 THEN
            PERFORM public.accounting_mark_source_event_review(
                v_church_id, v_event_id,
                'The transaction date does not belong to exactly one open accounting period.',
                'Verified Pesapal payment could not be assigned to one open accounting period.',
                pg_catalog.jsonb_build_object('transaction_date', v_transaction_date, 'matching_open_periods', v_period_count)
            );
            RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
        END IF;

        SELECT p.id INTO v_period_id
          FROM public.accounting_periods p
         WHERE p.church_id = v_church_id
           AND p.status = 'open'
           AND p.start_date <= v_transaction_date
           AND p.end_date >= v_transaction_date
         FOR UPDATE;

        IF NOT FOUND THEN
            PERFORM public.accounting_mark_source_event_review(
                v_church_id, v_event_id,
                'The matching accounting period closed during source-event processing.',
                'Verified Pesapal payment lost its open accounting period during processing.',
                pg_catalog.jsonb_build_object('transaction_date', v_transaction_date)
            );
            RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
        END IF;

        UPDATE public.accounting_source_events
           SET functional_currency = v_functional_currency,
               exchange_rate = v_rate,
               functional_amount = v_functional_amount,
               error_message = NULL
         WHERE church_id = v_church_id AND id = v_event_id;

        v_prefix := 'PJ-' || pg_catalog.to_char(v_transaction_date, 'YYYY') || '-';
        SELECT pg_catalog.count(*) + 1 INTO v_next_number
          FROM public.accounting_journals j
         WHERE j.church_id = v_church_id
           AND j.journal_number LIKE v_prefix || '%';
        v_journal_number := v_prefix || pg_catalog.lpad(v_next_number::TEXT, 6, '0');

        INSERT INTO public.accounting_journals (
            church_id, journal_number, period_id, journal_date, description,
            functional_currency, source_type, source_event_id,
            status, total_debits, total_credits, approval_required, created_by
        ) VALUES (
            v_church_id, v_journal_number, v_period_id, v_transaction_date,
            'Pesapal giving: ' || COALESCE(v_transaction.payment_type, 'Giving') || ' (' || v_transaction.merchant_reference || ')',
            v_functional_currency, 'pesapal_payment', v_event_id,
            'draft', v_functional_amount, v_functional_amount,
            v_functional_amount >= v_settings.journal_approval_threshold,
            NULL
        ) RETURNING id INTO v_journal_id;

        INSERT INTO public.accounting_journal_lines (
            church_id, journal_id, line_number, account_id,
            fund_id, department_id, line_description,
            debit_amount, credit_amount
        ) VALUES
        (
            v_church_id, v_journal_id, 1, v_mapping.clearing_account_id,
            v_mapping.fund_id, v_mapping.department_id,
            'Pesapal clearing for ' || v_transaction.merchant_reference,
            v_functional_amount, 0
        ),
        (
            v_church_id, v_journal_id, 2, v_mapping.income_account_id,
            v_mapping.fund_id, v_mapping.department_id,
            v_transaction.payment_type || ' income for ' || v_transaction.merchant_reference,
            0, v_functional_amount
        );

        UPDATE public.accounting_journals
           SET status = 'submitted',
               submitted_at = pg_catalog.clock_timestamp(),
               submitted_by = NULL
         WHERE church_id = v_church_id AND id = v_journal_id;

        UPDATE public.accounting_source_events
           SET status = 'journal_created',
               processed_at = pg_catalog.clock_timestamp(),
               error_message = NULL
         WHERE church_id = v_church_id AND id = v_event_id;

        INSERT INTO public.accounting_audit_log (
            church_id, actor_user_id, action, entity_type, entity_id,
            description, metadata
        ) VALUES (
            v_church_id, NULL, 'payment_event_recorded', 'source_event', v_event_id,
            'Verified Pesapal payment converted into a submitted draft ledger journal.',
            pg_catalog.jsonb_build_object(
                'journal_id', v_journal_id,
                'journal_number', v_journal_number,
                'transaction_id', p_transaction_id,
                'merchant_reference', v_transaction.merchant_reference,
                'source_amount', v_transaction.amount,
                'source_currency', v_source_currency,
                'functional_amount', v_functional_amount,
                'functional_currency', v_functional_currency,
                'exchange_rate', v_rate,
                'payment_type', v_transaction.payment_type
            )
        );

        RETURN pg_catalog.jsonb_build_object(
            'event_id', v_event_id,
            'journal_id', v_journal_id,
            'journal_number', v_journal_number,
            'status', 'journal_created',
            'approval_required', v_functional_amount >= v_settings.journal_approval_threshold,
            'idempotent_replay', FALSE
        );
    END IF;

    -- Any provider reversal requires settlement/refund reconciliation. If the
    -- receipt journal is not yet posted, void it to prevent later recognition,
    -- but keep both source events under review because settlement may already
    -- have occurred outside the accounting ledger. A posted journal is never
    -- automatically reversed in Migration 004.
    SELECT j.*
      INTO v_original_journal
      FROM public.accounting_source_events payment_event
      JOIN public.accounting_journals j
        ON j.church_id = payment_event.church_id
       AND j.source_event_id = payment_event.id
     WHERE payment_event.church_id = v_church_id
       AND payment_event.source_type = 'pesapal_transaction'
       AND payment_event.source_transaction_id = p_transaction_id
       AND payment_event.event_type = 'payment_completed'
     FOR UPDATE OF j;

    IF NOT FOUND THEN
        -- A missing receipt journal does not prove that the payment never
        -- completed, was never settled, or had no financial impact. This can
        -- happen when completion capture failed, callbacks arrived out of
        -- order, or a legacy transaction predates the timestamp columns.
        -- Preserve both provider events where the completion timestamp exists.
        IF v_transaction.pesapal_completed_at IS NOT NULL THEN
            INSERT INTO public.accounting_source_events (
                church_id, source_type, source_transaction_id, event_type,
                source_event_at, status, source_reference, source_amount,
                source_currency, error_message, processed_at
            ) VALUES (
                v_church_id, 'pesapal_transaction', p_transaction_id,
                'payment_completed', v_transaction.pesapal_completed_at,
                'requires_review', v_transaction.merchant_reference,
                v_transaction.amount, v_source_currency,
                'Completion was verified before reversal, but no receipt journal was captured; manual accounting reconciliation is required.',
                pg_catalog.clock_timestamp()
            )
            ON CONFLICT (church_id, source_type, source_transaction_id, event_type) DO NOTHING;

            SELECT e.id INTO v_completed_event_id
              FROM public.accounting_source_events e
             WHERE e.church_id = v_church_id
               AND e.source_type = 'pesapal_transaction'
               AND e.source_transaction_id = p_transaction_id
               AND e.event_type = 'payment_completed'
             FOR UPDATE;

            IF FOUND THEN
                PERFORM public.accounting_mark_source_event_review(
                    v_church_id, v_completed_event_id,
                    'Completion was verified before reversal, but no receipt journal exists. Confirm payment recognition and any settlement before resolving the completion event.',
                    'Previously completed Pesapal payment has no matching receipt journal and requires manual recognition review.',
                    pg_catalog.jsonb_build_object(
                        'merchant_reference', v_transaction.merchant_reference,
                        'transaction_id', p_transaction_id,
                        'pesapal_completed_at', v_transaction.pesapal_completed_at
                    )
                );
            END IF;
        END IF;

        -- Keep the reversal unresolved as well. The two events must not be
        -- silently closed merely because their receipt journal is missing.
        PERFORM public.accounting_mark_source_event_review(
            v_church_id, v_event_id,
            'No original receipt journal exists for this provider-verified reversal. Confirm whether the payment previously completed, was settled, or requires manual recognition before resolving this event.',
            'Provider-verified Pesapal reversal has no matching receipt journal and requires manual reconciliation.',
            pg_catalog.jsonb_build_object(
                'merchant_reference', v_transaction.merchant_reference,
                'transaction_id', p_transaction_id,
                'pesapal_completed_at', v_transaction.pesapal_completed_at,
                'pesapal_reversed_at', v_transaction.pesapal_reversed_at
            )
        );
        RETURN pg_catalog.jsonb_build_object(
            'event_id', v_event_id,
            'status', 'requires_review',
            'automatic_reversal', FALSE
        );
    END IF;

    IF v_original_journal.status IN ('draft', 'submitted', 'approved') THEN
        UPDATE public.accounting_journals
           SET status = 'voided',
               voided_by = NULL,
               voided_at = pg_catalog.clock_timestamp(),
               void_reason = 'Pesapal payment was verified as reversed before ledger posting; settlement/refund review remains required.'
         WHERE church_id = v_church_id AND id = v_original_journal.id;

        PERFORM public.accounting_mark_source_event_review(
            v_church_id, v_original_journal.source_event_id,
            'The unposted receipt journal was voided after provider reversal, but settlement may already have occurred. Reconcile bank/payment settlement and refund activity before closing the completed event.',
            'Unposted Pesapal receipt journal was voided; completion event remains open for settlement/refund review.',
            pg_catalog.jsonb_build_object(
                'journal_id', v_original_journal.id,
                'merchant_reference', v_transaction.merchant_reference
            )
        );

        PERFORM public.accounting_mark_source_event_review(
            v_church_id, v_event_id,
            'The provider reversed this payment before ledger posting. Confirm whether any funds were settled or refunded before resolving the reversal event.',
            'Pesapal reversal before ledger posting requires settlement/refund reconciliation.',
            pg_catalog.jsonb_build_object(
                'journal_id', v_original_journal.id,
                'merchant_reference', v_transaction.merchant_reference
            )
        );

        INSERT INTO public.accounting_audit_log (
            church_id, actor_user_id, action, entity_type, entity_id,
            description, metadata
        ) VALUES (
            v_church_id, NULL, 'journal_voided', 'journal', v_original_journal.id,
            'Unposted Pesapal receipt journal voided after provider-verified reversal; source events remain under manual settlement/refund review.',
            pg_catalog.jsonb_build_object('source_event_id', v_event_id, 'merchant_reference', v_transaction.merchant_reference)
        );

        RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'journal_id', v_original_journal.id, 'status', 'requires_review', 'journal_voided', TRUE);
    ELSIF v_original_journal.status = 'posted' THEN
        PERFORM public.accounting_mark_source_event_review(
            v_church_id, v_event_id,
            'Pesapal verified a reversal after the receipt journal was posted. Manual settlement/refund reconciliation and a separately approved reversing journal are required; automatic reversal is disabled in Migration 004.',
            'Posted Pesapal payment reversal requires manual settlement and refund accounting review.',
            pg_catalog.jsonb_build_object(
                'original_journal_id', v_original_journal.id,
                'original_journal_number', v_original_journal.journal_number,
                'merchant_reference', v_transaction.merchant_reference
            )
        );
        RETURN pg_catalog.jsonb_build_object(
            'event_id', v_event_id,
            'journal_id', v_original_journal.id,
            'status', 'requires_review',
            'automatic_reversal', FALSE
        );
    ELSIF v_original_journal.status = 'reversed' THEN
        PERFORM public.accounting_mark_source_event_review(
            v_church_id, v_event_id,
            'The receipt journal is already marked reversed. Reconcile the provider reversal against the existing reversing journal before closing this source event.',
            'Pesapal reversal requires reconciliation with an existing manual journal reversal.',
            pg_catalog.jsonb_build_object('original_journal_id', v_original_journal.id)
        );
        RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
    ELSE
        PERFORM public.accounting_mark_source_event_review(
            v_church_id, v_event_id,
            'The receipt journal was already voided, but settlement/refund activity cannot be inferred from the ledger. Verify provider and bank records before resolving this reversal.',
            'Pesapal reversal references an already-voided receipt journal and still requires settlement/refund review.',
            pg_catalog.jsonb_build_object(
                'original_journal_id', v_original_journal.id,
                'merchant_reference', v_transaction.merchant_reference
            )
        );
        RETURN pg_catalog.jsonb_build_object('event_id', v_event_id, 'status', 'requires_review');
    END IF;
END;
$function$;

-- ---------------------------------------------------------------------------
-- 11. Ownership, execution privileges, and documentation
-- ---------------------------------------------------------------------------
ALTER TABLE public.accounting_source_events OWNER TO postgres;
ALTER TABLE public.accounting_giving_category_mappings OWNER TO postgres;
ALTER TABLE public.accounting_journals OWNER TO postgres;
ALTER TABLE public.accounting_journal_lines OWNER TO postgres;

ALTER FUNCTION public.accounting_create_journal(UUID, UUID, DATE, TEXT, JSONB) OWNER TO postgres;
ALTER FUNCTION public.accounting_update_draft_journal(UUID, UUID, DATE, TEXT, JSONB) OWNER TO postgres;
ALTER FUNCTION public.accounting_submit_journal(UUID) OWNER TO postgres;
ALTER FUNCTION public.accounting_approve_journal(UUID) OWNER TO postgres;
ALTER FUNCTION public.accounting_return_journal_to_draft(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.accounting_void_unposted_reversal(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.accounting_post_journal(UUID) OWNER TO postgres;
ALTER FUNCTION public.accounting_reverse_journal(UUID, DATE, TEXT) OWNER TO postgres;
ALTER FUNCTION public.accounting_update_journal_approval_threshold(UUID, NUMERIC) OWNER TO postgres;
ALTER FUNCTION public.accounting_upsert_giving_category_mapping(UUID, TEXT, UUID, UUID, UUID, UUID, BOOLEAN) OWNER TO postgres;
ALTER FUNCTION public.accounting_process_pesapal_transaction(UUID, NUMERIC) OWNER TO postgres;

REVOKE ALL ON FUNCTION public.accounting_create_journal(UUID, UUID, DATE, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_update_draft_journal(UUID, UUID, DATE, TEXT, JSONB)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_submit_journal(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_approve_journal(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_return_journal_to_draft(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_void_unposted_reversal(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_post_journal(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_reverse_journal(UUID, DATE, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_update_journal_approval_threshold(UUID, NUMERIC)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_upsert_giving_category_mapping(UUID, TEXT, UUID, UUID, UUID, UUID, BOOLEAN)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_process_pesapal_transaction(UUID, NUMERIC)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.accounting_create_journal(UUID, UUID, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_update_draft_journal(UUID, UUID, DATE, TEXT, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_submit_journal(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_approve_journal(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_return_journal_to_draft(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_void_unposted_reversal(UUID, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_post_journal(UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_reverse_journal(UUID, DATE, TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_update_journal_approval_threshold(UUID, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_upsert_giving_category_mapping(UUID, TEXT, UUID, UUID, UUID, UUID, BOOLEAN) TO authenticated;
GRANT EXECUTE ON FUNCTION public.accounting_process_pesapal_transaction(UUID, NUMERIC) TO service_role;

COMMENT ON COLUMN public.accounting_audit_log.actor_user_id IS
    'Historical Auth user UUID retained without a foreign key so append-only audit rows are not mutated by user deletion.';
COMMENT ON TABLE public.accounting_journals IS
    'Church-scoped double-entry journal headers. Drafts are editable; submitted and approved journals are workflow-controlled; posted journals are immutable and corrected only by reversing journals. Ledger reports MUST include both posted and reversed statuses: a reversed original remains in the immutable ledger alongside its posted reversing journal.';
COMMENT ON COLUMN public.accounting_journals.status IS
    'reversed means a posted original has a separately posted reversing journal; the original lines remain in the ledger and must still be included in financial reports.';
COMMENT ON TABLE public.accounting_journal_lines IS
    'Church-scoped debit and credit lines. Every line requires an active fund, each fund must balance independently within a journal, accounts must allow direct posting, and department is optional.';
COMMENT ON TABLE public.accounting_giving_category_mappings IS
    'Church-configurable mappings from the five supported BelieversMeet giving categories to income, Pesapal clearing, fund, and optional department dimensions.';
COMMENT ON TABLE public.accounting_source_events IS
    'Idempotent source-event records for verified Pesapal transaction completions and reversals. source_event_at captures the first server-verified status timestamp used for accounting-period assignment. Every provider-verified reversal remains requires_review until settlement/refund reconciliation is completed in a later workflow; an unposted receipt journal is voided to prevent posting, while its source events remain open for review. A manual journal reversal alone does not close the provider review. A transaction remains the canonical payment record.';
COMMENT ON COLUMN public.accounting_source_events.exchange_rate IS
    'Functional-currency units per one source-currency unit (for example, UGX per USD when functional_currency is UGX).';
COMMENT ON CONSTRAINT accounting_settings_functional_currency_supported_chk ON public.accounting_settings IS
    'Migration 004 initial ledger release supports UGX and USD functional currencies only.';

COMMENT ON COLUMN public.transactions.pesapal_completed_at IS
    'First server-verified Pesapal COMPLETED timestamp. Legacy COMPLETED rows are stamped on their next verified update; if their first update is directly to REVERSED, the prior updated_at/created_at value is retained as an estimate and the source event requires manual review.';

COMMENT ON COLUMN public.transactions.pesapal_reversed_at IS
    'First post-Migration-004 server-verified Pesapal REVERSED update timestamp; legacy rows are stamped on their next verified status update.';

COMMENT ON COLUMN public.accounting_settings.journal_approval_threshold IS
    'Functional-currency threshold. Journals at or above the threshold require independent approval; with the zero default, every positive-value journal requires approval. The requirement is snapshotted at submission.';
COMMENT ON FUNCTION public.accounting_process_pesapal_transaction(UUID, NUMERIC) IS
    'Service-role-only function. Call after api/pesapal-ipn.js or api/pesapal-verify.js saves a verified COMPLETED or REVERSED transaction status. Repeated calls are idempotent.';

COMMIT;
