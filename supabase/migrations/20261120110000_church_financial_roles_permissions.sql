-- BelieversMeet Accounting & Budgeting
-- Migration 002: Church-scoped financial roles and permissions
-- Draft only: review before execution on BelieversMeet-Staging.
-- Revised v4: consistent lock ordering, constrained sole-member self-bootstrap,
-- bootstrap recovery, and automatic role revocation on eligibility changes.
-- This migration does not grant the legacy profiles.role = 'finance' any
-- implicit accounting permissions. It introduces explicit church-level roles.

BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Fail closed if the accounting foundation or expected authorization columns
-- are missing, or if any object name is already in use.
DO $preflight$
BEGIN
    IF current_user <> 'postgres' THEN
        RAISE EXCEPTION 'Preflight failed: execute this migration as postgres';
    END IF;

    IF pg_catalog.to_regclass('public.churches') IS NULL
       OR pg_catalog.to_regclass('public.profiles') IS NULL
       OR pg_catalog.to_regclass('public.accounting_settings') IS NULL
       OR pg_catalog.to_regclass('public.accounting_periods') IS NULL
       OR pg_catalog.to_regclass('public.accounting_departments') IS NULL
       OR pg_catalog.to_regclass('public.accounting_funds') IS NULL
       OR pg_catalog.to_regclass('public.accounting_accounts') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: required church, profile, or accounting foundation tables are missing';
    END IF;

    IF pg_catalog.to_regclass('public.church_financial_roles') IS NOT NULL
       OR pg_catalog.to_regclass('public.church_financial_role_permissions') IS NOT NULL
       OR pg_catalog.to_regclass('public.church_financial_user_roles') IS NOT NULL
       OR pg_catalog.to_regclass('public.church_financial_role_audit') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: one or more financial role tables already exist';
    END IF;

    IF pg_catalog.to_regprocedure('public.has_church_financial_permission(uuid,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.can_manage_church_financial_roles(uuid)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.assign_church_financial_role(uuid,uuid,text,text)') IS NOT NULL
       OR pg_catalog.to_regprocedure('public.revoke_church_financial_role(uuid,text)') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: one or more financial role functions already exist';
    END IF;

    IF pg_catalog.to_regprocedure('public.accounting_revoke_financial_roles_on_eligibility_change()') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: the financial eligibility trigger function already exists';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_catalog.pg_trigger
        WHERE NOT tgisinternal
          AND tgname IN (
              'church_financial_roles_profile_eligibility_update',
              'church_financial_roles_profile_delete',
              'church_financial_roles_church_approval_update'
          )
    ) THEN
        RAISE EXCEPTION 'Preflight failed: one or more financial eligibility trigger names are already in use';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'profiles'
          AND column_name = 'church_id' AND udt_name = 'uuid'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'profiles'
          AND column_name = 'status'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'profiles'
          AND column_name = 'is_blocked'
    ) OR NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'profiles'
          AND column_name = 'role'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: public.profiles is missing required church membership or account status columns';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'churches'
          AND column_name = 'status'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: public.churches.status is missing';
    END IF;
END;
$preflight$;

-- 1. Global, system-defined catalogue of financial roles.
-- Role definitions are shared; assignments remain church-scoped.
CREATE TABLE public.church_financial_roles (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    role_code TEXT NOT NULL,
    display_name TEXT NOT NULL,
    description TEXT NOT NULL,
    is_system_role BOOLEAN NOT NULL DEFAULT TRUE,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

    CONSTRAINT church_financial_roles_code_uk UNIQUE (role_code),
    CONSTRAINT church_financial_roles_code_chk
        CHECK (role_code ~ '^[a-z][a-z0-9_]*$'),
    CONSTRAINT church_financial_roles_name_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(display_name)) > 0),
    CONSTRAINT church_financial_roles_description_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(description)) > 0)
);

-- 2. Permission catalogue mapped to each standardized financial role.
CREATE TABLE public.church_financial_role_permissions (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    role_id UUID NOT NULL,
    permission_key TEXT NOT NULL,
    permission_description TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.now(),

    CONSTRAINT church_financial_role_permissions_role_fk
        FOREIGN KEY (role_id)
        REFERENCES public.church_financial_roles (id)
        ON DELETE RESTRICT,
    CONSTRAINT church_financial_role_permissions_role_key_uk
        UNIQUE (role_id, permission_key),
    CONSTRAINT church_financial_role_permissions_key_chk
        CHECK (permission_key ~ '^accounting\.[a-z0-9_.]+$'),
    CONSTRAINT church_financial_role_permissions_description_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(permission_description)) > 0)
);

-- 3. Church-specific user role assignments. A revoked assignment is retained
-- as history; active assignments are unique per church, user, and role.
CREATE TABLE public.church_financial_user_roles (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    user_id UUID,
    role_id UUID NOT NULL,
    granted_by UUID,
    grant_reason TEXT NOT NULL,
    granted_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    revoked_at TIMESTAMPTZ,
    revoked_by UUID,
    revocation_reason TEXT,

    CONSTRAINT church_financial_user_roles_church_fk
        FOREIGN KEY (church_id)
        REFERENCES public.churches (id)
        ON DELETE RESTRICT,
    CONSTRAINT church_financial_user_roles_user_fk
        FOREIGN KEY (user_id)
        REFERENCES public.profiles (id)
        ON DELETE SET NULL,
    CONSTRAINT church_financial_user_roles_role_fk
        FOREIGN KEY (role_id)
        REFERENCES public.church_financial_roles (id)
        ON DELETE RESTRICT,
    CONSTRAINT church_financial_user_roles_granted_by_fk
        FOREIGN KEY (granted_by)
        REFERENCES auth.users (id)
        ON DELETE SET NULL,
    CONSTRAINT church_financial_user_roles_revoked_by_fk
        FOREIGN KEY (revoked_by)
        REFERENCES auth.users (id)
        ON DELETE SET NULL,
    CONSTRAINT church_financial_user_roles_church_id_id_uk
        UNIQUE (church_id, id),
    CONSTRAINT church_financial_user_roles_grant_reason_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(grant_reason)) BETWEEN 10 AND 500),
    CONSTRAINT church_financial_user_roles_active_user_chk
        CHECK (revoked_at IS NOT NULL OR user_id IS NOT NULL),
    CONSTRAINT church_financial_user_roles_revocation_chk
        CHECK (
            (revoked_at IS NULL AND revoked_by IS NULL AND revocation_reason IS NULL)
            OR (
                revoked_at IS NOT NULL
                AND pg_catalog.length(pg_catalog.btrim(COALESCE(revocation_reason, ''))) BETWEEN 10 AND 500
            )
        )
);

CREATE UNIQUE INDEX church_financial_user_roles_active_uk
    ON public.church_financial_user_roles (church_id, user_id, role_id)
    WHERE revoked_at IS NULL;

CREATE INDEX church_financial_user_roles_user_idx
    ON public.church_financial_user_roles (user_id, church_id)
    WHERE revoked_at IS NULL;

CREATE INDEX church_financial_user_roles_church_role_idx
    ON public.church_financial_user_roles (church_id, role_id)
    WHERE revoked_at IS NULL;

-- 4. Append-only audit trail for financial role assignment changes.
CREATE TABLE public.church_financial_role_audit (
    id UUID PRIMARY KEY DEFAULT pg_catalog.gen_random_uuid(),
    church_id UUID NOT NULL,
    assignment_id UUID,
    role_id UUID NOT NULL,
    target_user_id UUID,
    actor_user_id UUID,
    action TEXT NOT NULL,
    reason TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT pg_catalog.clock_timestamp(),
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

    CONSTRAINT church_financial_role_audit_church_fk
        FOREIGN KEY (church_id)
        REFERENCES public.churches (id)
        ON DELETE RESTRICT,
    CONSTRAINT church_financial_role_audit_assignment_fk
        FOREIGN KEY (assignment_id)
        REFERENCES public.church_financial_user_roles (id)
        ON DELETE SET NULL,
    CONSTRAINT church_financial_role_audit_role_fk
        FOREIGN KEY (role_id)
        REFERENCES public.church_financial_roles (id)
        ON DELETE RESTRICT,
    CONSTRAINT church_financial_role_audit_target_fk
        FOREIGN KEY (target_user_id)
        REFERENCES auth.users (id)
        ON DELETE SET NULL,
    CONSTRAINT church_financial_role_audit_actor_fk
        FOREIGN KEY (actor_user_id)
        REFERENCES auth.users (id)
        ON DELETE SET NULL,
    CONSTRAINT church_financial_role_audit_action_chk
        CHECK (action IN ('assigned', 'revoked')),
    CONSTRAINT church_financial_role_audit_reason_chk
        CHECK (pg_catalog.length(pg_catalog.btrim(reason)) BETWEEN 10 AND 500),
    CONSTRAINT church_financial_role_audit_metadata_chk
        CHECK (pg_catalog.jsonb_typeof(metadata) = 'object')
);

CREATE INDEX church_financial_role_audit_church_created_idx
    ON public.church_financial_role_audit (church_id, created_at DESC);

CREATE INDEX church_financial_role_audit_target_idx
    ON public.church_financial_role_audit (target_user_id, created_at DESC);

-- 5. Seed standardized roles. The legacy profiles.role = 'finance' is not
-- mapped automatically to any of these roles.
INSERT INTO public.church_financial_roles
    (role_code, display_name, description)
VALUES
    ('finance_administrator', 'Finance Administrator',
     'Manages church financial configuration, financial roles, controls, and overall financial oversight.'),
    ('treasurer', 'Treasurer',
     'Oversees treasury activity, cash and bank reconciliation, and delegated financial approvals.'),
    ('accountant', 'Accountant',
     'Maintains accounting records, prepares journals, manages bills, and performs authorized posting.'),
    ('budget_manager', 'Budget Manager',
     'Prepares, maintains, and monitors church-wide and departmental budgets.'),
    ('financial_approver', 'Financial Approver',
     'Reviews and approves eligible expenses, bills, and budgets within delegated approval rules.'),
    ('financial_viewer', 'Financial Viewer',
     'Views financial information and reports without creating or changing financial records.');

-- 6. Seed role-to-permission mappings. Approval thresholds, separation of
-- duties, and transaction-specific checks are enforced by later workflow RPCs.
WITH permission_seed(role_code, permission_key, permission_description) AS (
    VALUES
    -- Finance Administrator
    ('finance_administrator', 'accounting.roles.read', 'View financial role assignments.'),
    ('finance_administrator', 'accounting.roles.manage', 'Assign and revoke church financial roles.'),
    ('finance_administrator', 'accounting.settings.read', 'View accounting settings.'),
    ('finance_administrator', 'accounting.settings.manage', 'Manage accounting settings.'),
    ('finance_administrator', 'accounting.periods.read', 'View accounting periods.'),
    ('finance_administrator', 'accounting.periods.manage', 'Create, close, and lock accounting periods.'),
    ('finance_administrator', 'accounting.departments.read', 'View financial departments.'),
    ('finance_administrator', 'accounting.departments.manage', 'Manage financial departments.'),
    ('finance_administrator', 'accounting.funds.read', 'View church funds.'),
    ('finance_administrator', 'accounting.funds.manage', 'Manage church funds and restriction metadata.'),
    ('finance_administrator', 'accounting.accounts.read', 'View the chart of accounts.'),
    ('finance_administrator', 'accounting.accounts.manage', 'Manage the chart of accounts.'),
    ('finance_administrator', 'accounting.journals.read', 'View accounting journals.'),
    ('finance_administrator', 'accounting.journals.create', 'Create draft accounting journals.'),
    ('finance_administrator', 'accounting.journals.post', 'Post validated accounting journals.'),
    ('finance_administrator', 'accounting.journals.reverse', 'Create authorized journal reversals.'),
    ('finance_administrator', 'accounting.expenses.read', 'View expense requests and records.'),
    ('finance_administrator', 'accounting.expenses.create', 'Create expense requests.'),
    ('finance_administrator', 'accounting.expenses.submit', 'Submit expense requests for approval.'),
    ('finance_administrator', 'accounting.expenses.approve', 'Approve eligible expense requests.'),
    ('finance_administrator', 'accounting.bills.read', 'View supplier bills.'),
    ('finance_administrator', 'accounting.bills.manage', 'Create and manage supplier bills and bill payments.'),
    ('finance_administrator', 'accounting.bills.approve', 'Approve eligible supplier bills.'),
    ('finance_administrator', 'accounting.budgets.read', 'View church budgets.'),
    ('finance_administrator', 'accounting.budgets.manage', 'Prepare and revise church budgets.'),
    ('finance_administrator', 'accounting.budgets.submit', 'Submit budgets for approval.'),
    ('finance_administrator', 'accounting.budgets.approve', 'Approve eligible budgets.'),
    ('finance_administrator', 'accounting.approvals.rules.read', 'View financial approval rules.'),
    ('finance_administrator', 'accounting.approvals.rules.manage', 'Configure financial approval rules.'),
    ('finance_administrator', 'accounting.reconciliation.read', 'View bank and cash reconciliations.'),
    ('finance_administrator', 'accounting.reconciliation.manage', 'Prepare and complete bank and cash reconciliations.'),
    ('finance_administrator', 'accounting.reports.read', 'View church financial reports.'),
    ('finance_administrator', 'accounting.audit.read', 'View financial audit history.'),

    -- Treasurer
    ('treasurer', 'accounting.roles.read', 'View financial role assignments.'),
    ('treasurer', 'accounting.settings.read', 'View accounting settings.'),
    ('treasurer', 'accounting.periods.read', 'View accounting periods.'),
    ('treasurer', 'accounting.departments.read', 'View financial departments.'),
    ('treasurer', 'accounting.funds.read', 'View church funds.'),
    ('treasurer', 'accounting.accounts.read', 'View the chart of accounts.'),
    ('treasurer', 'accounting.journals.read', 'View accounting journals.'),
    ('treasurer', 'accounting.expenses.read', 'View expense requests and records.'),
    ('treasurer', 'accounting.expenses.approve', 'Approve eligible expense requests.'),
    ('treasurer', 'accounting.bills.read', 'View supplier bills.'),
    ('treasurer', 'accounting.bills.approve', 'Approve eligible supplier bills.'),
    ('treasurer', 'accounting.budgets.read', 'View church budgets.'),
    ('treasurer', 'accounting.budgets.approve', 'Approve eligible budgets.'),
    ('treasurer', 'accounting.approvals.rules.read', 'View financial approval rules.'),
    ('treasurer', 'accounting.reconciliation.read', 'View bank and cash reconciliations.'),
    ('treasurer', 'accounting.reconciliation.manage', 'Prepare and complete bank and cash reconciliations.'),
    ('treasurer', 'accounting.reports.read', 'View church financial reports.'),
    ('treasurer', 'accounting.audit.read', 'View financial audit history.'),

    -- Accountant
    ('accountant', 'accounting.settings.read', 'View accounting settings.'),
    ('accountant', 'accounting.periods.read', 'View accounting periods.'),
    ('accountant', 'accounting.departments.read', 'View financial departments.'),
    ('accountant', 'accounting.funds.read', 'View church funds.'),
    ('accountant', 'accounting.accounts.read', 'View the chart of accounts.'),
    ('accountant', 'accounting.accounts.manage', 'Manage the chart of accounts.'),
    ('accountant', 'accounting.journals.read', 'View accounting journals.'),
    ('accountant', 'accounting.journals.create', 'Create draft accounting journals.'),
    ('accountant', 'accounting.journals.post', 'Post validated accounting journals.'),
    ('accountant', 'accounting.journals.reverse', 'Create authorized journal reversals.'),
    ('accountant', 'accounting.expenses.read', 'View expense requests and records.'),
    ('accountant', 'accounting.expenses.create', 'Create expense requests.'),
    ('accountant', 'accounting.expenses.submit', 'Submit expense requests for approval.'),
    ('accountant', 'accounting.bills.read', 'View supplier bills.'),
    ('accountant', 'accounting.bills.manage', 'Create and manage supplier bills and bill payments.'),
    ('accountant', 'accounting.budgets.read', 'View church budgets.'),
    ('accountant', 'accounting.reconciliation.read', 'View bank and cash reconciliations.'),
    ('accountant', 'accounting.reports.read', 'View church financial reports.'),

    -- Budget Manager
    ('budget_manager', 'accounting.periods.read', 'View accounting periods.'),
    ('budget_manager', 'accounting.departments.read', 'View financial departments.'),
    ('budget_manager', 'accounting.funds.read', 'View church funds.'),
    ('budget_manager', 'accounting.accounts.read', 'View the chart of accounts.'),
    ('budget_manager', 'accounting.expenses.read', 'View expense requests for budget monitoring.'),
    ('budget_manager', 'accounting.budgets.read', 'View church budgets.'),
    ('budget_manager', 'accounting.budgets.manage', 'Prepare and revise church budgets.'),
    ('budget_manager', 'accounting.budgets.submit', 'Submit budgets for approval.'),
    ('budget_manager', 'accounting.reports.read', 'View church financial reports.'),

    -- Financial Approver
    ('financial_approver', 'accounting.periods.read', 'View accounting periods.'),
    ('financial_approver', 'accounting.departments.read', 'View financial departments.'),
    ('financial_approver', 'accounting.funds.read', 'View church funds.'),
    ('financial_approver', 'accounting.accounts.read', 'View the chart of accounts.'),
    ('financial_approver', 'accounting.journals.read', 'View accounting journals.'),
    ('financial_approver', 'accounting.expenses.read', 'View expense requests and records.'),
    ('financial_approver', 'accounting.expenses.approve', 'Approve eligible expense requests.'),
    ('financial_approver', 'accounting.bills.read', 'View supplier bills.'),
    ('financial_approver', 'accounting.bills.approve', 'Approve eligible supplier bills.'),
    ('financial_approver', 'accounting.budgets.read', 'View church budgets.'),
    ('financial_approver', 'accounting.budgets.approve', 'Approve eligible budgets.'),
    ('financial_approver', 'accounting.reports.read', 'View church financial reports.'),

    -- Financial Viewer
    ('financial_viewer', 'accounting.settings.read', 'View accounting settings.'),
    ('financial_viewer', 'accounting.periods.read', 'View accounting periods.'),
    ('financial_viewer', 'accounting.departments.read', 'View financial departments.'),
    ('financial_viewer', 'accounting.funds.read', 'View church funds.'),
    ('financial_viewer', 'accounting.accounts.read', 'View the chart of accounts.'),
    ('financial_viewer', 'accounting.journals.read', 'View accounting journals.'),
    ('financial_viewer', 'accounting.expenses.read', 'View expense records.'),
    ('financial_viewer', 'accounting.bills.read', 'View supplier bills.'),
    ('financial_viewer', 'accounting.budgets.read', 'View church budgets.'),
    ('financial_viewer', 'accounting.reconciliation.read', 'View reconciliation reports.'),
    ('financial_viewer', 'accounting.reports.read', 'View church financial reports.')
)
INSERT INTO public.church_financial_role_permissions
    (role_id, permission_key, permission_description)
SELECT
    r.id,
    s.permission_key,
    s.permission_description
FROM permission_seed AS s
JOIN public.church_financial_roles AS r
    ON r.role_code = s.role_code;

-- 7. Automatically revoke financial roles when a user's church membership,
-- account eligibility, or church approval is removed. This prevents dormant
-- assignments from becoming effective again if a user later rejoins or is reactivated.
CREATE FUNCTION public.accounting_revoke_financial_roles_on_eligibility_change()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id UUID := auth.uid();
    v_target_user_id UUID;
    v_church_id UUID;
    v_reason TEXT;
    v_metadata JSONB := '{}'::jsonb;
BEGIN
    IF TG_TABLE_NAME = 'profiles' AND TG_OP = 'DELETE' THEN
        v_target_user_id := OLD.id;
        v_reason := 'Automatically revoked because the user profile was deleted.';
        v_metadata := pg_catalog.jsonb_build_object(
            'source_trigger', 'profile_deleted',
            'deleted_profile_id', OLD.id,
            'church_id', OLD.church_id
        );

    ELSIF TG_TABLE_NAME = 'profiles' AND TG_OP = 'UPDATE' THEN
        IF NEW.church_id IS NOT DISTINCT FROM OLD.church_id
           AND NEW.status IS NOT DISTINCT FROM OLD.status
           AND NEW.is_blocked IS NOT DISTINCT FROM OLD.is_blocked THEN
            RETURN NEW;
        END IF;

        -- Revoke when membership changes or the resulting profile is not
        -- unambiguously active and unblocked. Re-enabling never restores roles.
        IF NEW.church_id IS DISTINCT FROM OLD.church_id THEN
            v_reason := 'Automatically revoked because the user church membership changed.';
        ELSIF NEW.status IS DISTINCT FROM 'active' THEN
            v_reason := 'Automatically revoked because the user account is not active.';
        ELSIF NEW.is_blocked IS DISTINCT FROM FALSE THEN
            v_reason := 'Automatically revoked because the user account is blocked or ineligible.';
        ELSE
            RETURN NEW;
        END IF;

        v_target_user_id := NEW.id;
        v_metadata := pg_catalog.jsonb_build_object(
            'source_trigger', 'profile_eligibility_changed',
            'old_church_id', OLD.church_id,
            'new_church_id', NEW.church_id,
            'old_status', OLD.status,
            'new_status', NEW.status,
            'old_is_blocked', OLD.is_blocked,
            'new_is_blocked', NEW.is_blocked
        );

    ELSIF TG_TABLE_NAME = 'churches' AND TG_OP = 'UPDATE' THEN
        IF OLD.status IS DISTINCT FROM 'approved'
           OR NEW.status IS NOT DISTINCT FROM 'approved' THEN
            RETURN NEW;
        END IF;

        v_church_id := NEW.id;
        v_reason := 'Automatically revoked because the church is no longer approved.';
        v_metadata := pg_catalog.jsonb_build_object(
            'source_trigger', 'church_approval_status_changed',
            'old_status', OLD.status,
            'new_status', NEW.status
        );
    ELSE
        RAISE EXCEPTION 'Unsupported financial eligibility trigger operation';
    END IF;

    WITH revoked AS (
        UPDATE public.church_financial_user_roles AS ur
           SET revoked_at = pg_catalog.clock_timestamp(),
               revoked_by = v_actor_id,
               revocation_reason = v_reason
         WHERE ur.revoked_at IS NULL
           AND (
               (v_target_user_id IS NOT NULL AND ur.user_id = v_target_user_id)
               OR (v_church_id IS NOT NULL AND ur.church_id = v_church_id)
           )
        RETURNING ur.church_id, ur.id, ur.role_id, ur.user_id
    )
    INSERT INTO public.church_financial_role_audit (
        church_id,
        assignment_id,
        role_id,
        target_user_id,
        actor_user_id,
        action,
        reason,
        metadata
    )
    SELECT
        revoked.church_id,
        revoked.id,
        revoked.role_id,
        CASE
            WHEN v_metadata ->> 'source_trigger' = 'profile_deleted' THEN NULL
            ELSE revoked.user_id
        END,
        v_actor_id,
        'revoked',
        v_reason,
        v_metadata
    FROM revoked;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.accounting_revoke_financial_roles_on_eligibility_change() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.accounting_revoke_financial_roles_on_eligibility_change()
    FROM PUBLIC, anon, authenticated, service_role;

CREATE TRIGGER church_financial_roles_profile_eligibility_update
    AFTER UPDATE OF church_id, status, is_blocked ON public.profiles
    FOR EACH ROW
    WHEN (
        OLD.church_id IS DISTINCT FROM NEW.church_id
        OR OLD.status IS DISTINCT FROM NEW.status
        OR OLD.is_blocked IS DISTINCT FROM NEW.is_blocked
    )
    EXECUTE FUNCTION public.accounting_revoke_financial_roles_on_eligibility_change();

-- BEFORE DELETE runs before the assignment FK's ON DELETE SET NULL action,
-- allowing the active-assignment check to remain valid and preserving history.
CREATE TRIGGER church_financial_roles_profile_delete
    BEFORE DELETE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.accounting_revoke_financial_roles_on_eligibility_change();

CREATE TRIGGER church_financial_roles_church_approval_update
    AFTER UPDATE OF status ON public.churches
    FOR EACH ROW
    WHEN (OLD.status = 'approved' AND NEW.status IS DISTINCT FROM 'approved')
    EXECUTE FUNCTION public.accounting_revoke_financial_roles_on_eligibility_change();

-- 8. Central permission check. It deliberately has no Super Admin bypass:
-- platform status alone never grants access to church financial information.
CREATE FUNCTION public.has_church_financial_permission(
    p_church_id UUID,
    p_permission_key TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT
        p_church_id IS NOT NULL
        AND auth.uid() IS NOT NULL
        AND pg_catalog.length(pg_catalog.btrim(COALESCE(p_permission_key, ''))) > 0
        AND EXISTS (
            SELECT 1
            FROM public.profiles AS p
            JOIN public.churches AS c
              ON c.id = p.church_id
            JOIN public.church_financial_user_roles AS ur
              ON ur.church_id = p.church_id
             AND ur.user_id = p.id
            JOIN public.church_financial_roles AS r
              ON r.id = ur.role_id
            JOIN public.church_financial_role_permissions AS rp
              ON rp.role_id = r.id
            WHERE p.id = auth.uid()
              AND p.church_id = p_church_id
              AND p.status = 'active'
              AND p.is_blocked IS FALSE
              AND c.status = 'approved'
              AND ur.revoked_at IS NULL
              AND r.is_active IS TRUE
              AND rp.permission_key = pg_catalog.btrim(p_permission_key)
        );
$function$;

-- 9. Role-management check. Initial bootstrap is handled only by the
-- assignment RPC below; it is intentionally not a general permission bypass.
CREATE FUNCTION public.can_manage_church_financial_roles(
    p_church_id UUID
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT public.has_church_financial_permission(
        p_church_id,
        'accounting.roles.manage'
    );
$function$;

-- 10. Assign a financial role. A current active church_admin may bootstrap
-- exactly the first Finance Administrator for the church. Thereafter only
-- a user with accounting.roles.manage may assign roles.
CREATE FUNCTION public.assign_church_financial_role(
    p_church_id UUID,
    p_user_id UUID,
    p_role_code TEXT,
    p_reason TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id UUID := auth.uid();
    v_role_id UUID;
    v_assignment_id UUID;
    v_reason TEXT := pg_catalog.btrim(COALESCE(p_reason, ''));
    v_can_manage BOOLEAN := FALSE;
    v_can_bootstrap BOOLEAN := FALSE;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    IF p_church_id IS NULL OR p_user_id IS NULL OR p_role_code IS NULL THEN
        RAISE EXCEPTION 'Church, target user, and role are required' USING ERRCODE = '22023';
    END IF;

    IF pg_catalog.length(v_reason) NOT BETWEEN 10 AND 500 THEN
        RAISE EXCEPTION 'Reason must contain between 10 and 500 characters' USING ERRCODE = '22023';
    END IF;

    -- Serialize assignment/bootstrap operations within the church.
    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(p_church_id::TEXT, 0)
    );

    -- Lock the actor's church membership and church row before authorization,
    -- so eligibility cannot change midway through this role-management action.
    PERFORM 1
      FROM public.profiles AS actor_profile
      JOIN public.churches AS actor_church
        ON actor_church.id = actor_profile.church_id
     WHERE actor_profile.id = v_actor_id
       AND actor_profile.church_id = p_church_id
       AND actor_profile.status = 'active'
       AND actor_profile.is_blocked IS FALSE
       AND actor_church.status = 'approved'
     FOR UPDATE OF actor_profile, actor_church;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'The acting user must be active, unblocked, and belong to this approved church' USING ERRCODE = '42501';
    END IF;

    -- Lock the target membership and church row. A concurrent membership or
    -- church-status change must finish before assignment eligibility is checked.
    PERFORM 1
      FROM public.profiles AS target_profile
      JOIN public.churches AS target_church
        ON target_church.id = target_profile.church_id
     WHERE target_profile.id = p_user_id
       AND target_profile.church_id = p_church_id
       AND target_profile.status = 'active'
       AND target_profile.is_blocked IS FALSE
       AND target_church.status = 'approved'
     FOR UPDATE OF target_profile, target_church;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target user must be active, unblocked, and belong to this approved church' USING ERRCODE = '42501';
    END IF;

    SELECT r.id
      INTO v_role_id
      FROM public.church_financial_roles AS r
     WHERE r.role_code = pg_catalog.btrim(p_role_code)
       AND r.is_active IS TRUE;

    IF v_role_id IS NULL THEN
        RAISE EXCEPTION 'Unknown or inactive church financial role' USING ERRCODE = '22023';
    END IF;

    v_can_manage := public.can_manage_church_financial_roles(p_church_id);

    IF NOT v_can_manage THEN
        SELECT EXISTS (
            SELECT 1
            FROM public.profiles AS actor_profile
            JOIN public.churches AS actor_church
              ON actor_church.id = actor_profile.church_id
            WHERE actor_profile.id = v_actor_id
              AND actor_profile.church_id = p_church_id
              AND actor_profile.role = 'church_admin'
              AND actor_profile.status = 'active'
              AND actor_profile.is_blocked IS FALSE
              AND actor_church.status = 'approved'
              AND pg_catalog.btrim(p_role_code) = 'finance_administrator'
              AND NOT EXISTS (
                  SELECT 1
                  FROM public.church_financial_user_roles AS existing_assignment
                  JOIN public.church_financial_roles AS existing_role
                    ON existing_role.id = existing_assignment.role_id
                  JOIN public.profiles AS existing_admin_profile
                    ON existing_admin_profile.id = existing_assignment.user_id
                   AND existing_admin_profile.church_id = existing_assignment.church_id
                  JOIN public.churches AS existing_admin_church
                    ON existing_admin_church.id = existing_assignment.church_id
                  WHERE existing_assignment.church_id = p_church_id
                    AND existing_assignment.revoked_at IS NULL
                    AND existing_role.role_code = 'finance_administrator'
                    AND existing_role.is_active IS TRUE
                    AND existing_admin_profile.status = 'active'
                    AND existing_admin_profile.is_blocked IS FALSE
                    AND existing_admin_church.status = 'approved'
              )
        ) INTO v_can_bootstrap;

        IF NOT v_can_bootstrap THEN
            RAISE EXCEPTION 'You are not authorized to assign financial roles for this church' USING ERRCODE = '42501';
        END IF;
    END IF;

    -- Self-assignment is prohibited after bootstrap. During initial setup,
    -- a church_admin may bootstrap themselves as the first Finance
    -- Administrator only when no other active, unblocked church member is
    -- available to receive the role. This exception is still fully audited.
    IF p_user_id = v_actor_id THEN
        IF NOT v_can_bootstrap THEN
            RAISE EXCEPTION 'You cannot assign a financial role to yourself' USING ERRCODE = '42501';
        END IF;

        IF EXISTS (
            SELECT 1
            FROM public.profiles AS other_profile
            WHERE other_profile.church_id = p_church_id
              AND other_profile.id <> v_actor_id
              AND other_profile.status = 'active'
              AND other_profile.is_blocked IS FALSE
        ) THEN
            RAISE EXCEPTION 'Assign the first Finance Administrator to another eligible church member. Self-bootstrap is allowed only when you are the only active, unblocked member.' USING ERRCODE = '42501';
        END IF;
    END IF;

    INSERT INTO public.church_financial_user_roles (
        church_id,
        user_id,
        role_id,
        granted_by,
        grant_reason
    )
    VALUES (
        p_church_id,
        p_user_id,
        v_role_id,
        v_actor_id,
        v_reason
    )
    ON CONFLICT (church_id, user_id, role_id)
        WHERE revoked_at IS NULL
    DO NOTHING
    RETURNING id INTO v_assignment_id;

    IF v_assignment_id IS NULL THEN
        RAISE EXCEPTION 'This user already has this active financial role' USING ERRCODE = '23505';
    END IF;

    INSERT INTO public.church_financial_role_audit (
        church_id,
        assignment_id,
        role_id,
        target_user_id,
        actor_user_id,
        action,
        reason,
        metadata
    )
    VALUES (
        p_church_id,
        v_assignment_id,
        v_role_id,
        p_user_id,
        v_actor_id,
        'assigned',
        v_reason,
        pg_catalog.jsonb_build_object('role_code', pg_catalog.btrim(p_role_code))
    );

    RETURN v_assignment_id;
END;
$function$;

-- 11. Revoke a role assignment. The assignment remains in the audit history.
CREATE FUNCTION public.revoke_church_financial_role(
    p_assignment_id UUID,
    p_reason TEXT
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor_id UUID := auth.uid();
    v_church_id UUID;
    v_locked_church_id UUID;
    v_user_id UUID;
    v_role_id UUID;
    v_role_code TEXT;
    v_reason TEXT := pg_catalog.btrim(COALESCE(p_reason, ''));
    v_active_finance_admins BIGINT;
BEGIN
    IF v_actor_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    IF p_assignment_id IS NULL THEN
        RAISE EXCEPTION 'Assignment is required' USING ERRCODE = '22023';
    END IF;

    IF pg_catalog.length(v_reason) NOT BETWEEN 10 AND 500 THEN
        RAISE EXCEPTION 'Reason must contain between 10 and 500 characters' USING ERRCODE = '22023';
    END IF;

    -- Read church_id without locking the assignment row, then take the same
    -- per-church advisory lock used by assignment operations.
    SELECT ur.church_id
      INTO v_church_id
      FROM public.church_financial_user_roles AS ur
     WHERE ur.id = p_assignment_id;

    IF v_church_id IS NULL THEN
        RAISE EXCEPTION 'Financial role assignment not found' USING ERRCODE = 'P0002';
    END IF;

    PERFORM pg_catalog.pg_advisory_xact_lock(
        pg_catalog.hashtextextended(v_church_id::TEXT, 0)
    );

    -- Lock actor membership before locking the assignment row. This matches
    -- the profile-trigger ordering and avoids role/profile update deadlocks.
    PERFORM 1
      FROM public.profiles AS actor_profile
      JOIN public.churches AS actor_church
        ON actor_church.id = actor_profile.church_id
     WHERE actor_profile.id = v_actor_id
       AND actor_profile.church_id = v_church_id
       AND actor_profile.status = 'active'
       AND actor_profile.is_blocked IS FALSE
       AND actor_church.status = 'approved'
     FOR UPDATE OF actor_profile, actor_church;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'The acting user must be active, unblocked, and belong to this approved church' USING ERRCODE = '42501';
    END IF;

    SELECT
        ur.church_id,
        ur.user_id,
        ur.role_id,
        r.role_code
    INTO
        v_locked_church_id,
        v_user_id,
        v_role_id,
        v_role_code
    FROM public.church_financial_user_roles AS ur
    JOIN public.church_financial_roles AS r
      ON r.id = ur.role_id
    WHERE ur.id = p_assignment_id
      AND ur.revoked_at IS NULL
    FOR UPDATE OF ur;

    IF NOT FOUND OR v_locked_church_id IS NULL THEN
        RAISE EXCEPTION 'Active financial role assignment not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_locked_church_id <> v_church_id THEN
        RAISE EXCEPTION 'Financial role assignment church changed during revocation' USING ERRCODE = '40001';
    END IF;

    IF NOT public.can_manage_church_financial_roles(v_church_id) THEN
        RAISE EXCEPTION 'You are not authorized to revoke financial roles for this church' USING ERRCODE = '42501';
    END IF;

    -- Keep at least one effective Finance Administrator. If the church's
    -- only administrator becomes ineligible, profile/church triggers revoke
    -- the stale assignment and the church_admin bootstrap path can recover.
    IF v_role_code = 'finance_administrator' THEN
        SELECT pg_catalog.count(*)
          INTO v_active_finance_admins
          FROM public.church_financial_user_roles AS ur
          JOIN public.church_financial_roles AS r
            ON r.id = ur.role_id
          JOIN public.profiles AS p
            ON p.id = ur.user_id
           AND p.church_id = ur.church_id
          JOIN public.churches AS c
            ON c.id = ur.church_id
         WHERE ur.church_id = v_church_id
           AND ur.revoked_at IS NULL
           AND r.role_code = 'finance_administrator'
           AND r.is_active IS TRUE
           AND p.status = 'active'
           AND p.is_blocked IS FALSE
           AND c.status = 'approved';

        IF v_active_finance_admins <= 1 THEN
            RAISE EXCEPTION 'Cannot revoke the last active Finance Administrator. Assign a replacement first.' USING ERRCODE = '23514';
        END IF;
    END IF;

    UPDATE public.church_financial_user_roles
       SET revoked_at = pg_catalog.clock_timestamp(),
           revoked_by = v_actor_id,
           revocation_reason = v_reason
     WHERE id = p_assignment_id
       AND revoked_at IS NULL;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Financial role assignment was already revoked' USING ERRCODE = '40001';
    END IF;

    INSERT INTO public.church_financial_role_audit (
        church_id,
        assignment_id,
        role_id,
        target_user_id,
        actor_user_id,
        action,
        reason,
        metadata
    )
    VALUES (
        v_church_id,
        p_assignment_id,
        v_role_id,
        v_user_id,
        v_actor_id,
        'revoked',
        v_reason,
        pg_catalog.jsonb_build_object('role_code', v_role_code)
    );

    RETURN p_assignment_id;
END;
$function$;

-- Explicit ownership for tables and SECURITY DEFINER routines.
ALTER TABLE public.church_financial_roles OWNER TO postgres;
ALTER TABLE public.church_financial_role_permissions OWNER TO postgres;
ALTER TABLE public.church_financial_user_roles OWNER TO postgres;
ALTER TABLE public.church_financial_role_audit OWNER TO postgres;

ALTER FUNCTION public.has_church_financial_permission(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.can_manage_church_financial_roles(UUID) OWNER TO postgres;
ALTER FUNCTION public.assign_church_financial_role(UUID, UUID, TEXT, TEXT) OWNER TO postgres;
ALTER FUNCTION public.revoke_church_financial_role(UUID, TEXT) OWNER TO postgres;
ALTER FUNCTION public.accounting_revoke_financial_roles_on_eligibility_change() OWNER TO postgres;

-- Lock all role tables by default. Only catalog reads and narrowly scoped
-- role/audit reads are exposed directly; writes occur through the RPCs.
DO $security$
DECLARE
    v_table TEXT;
BEGIN
    FOREACH v_table IN ARRAY ARRAY[
        'church_financial_roles',
        'church_financial_role_permissions',
        'church_financial_user_roles',
        'church_financial_role_audit'
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

-- Grant SELECT only. RLS determines which church-specific records are visible.
GRANT SELECT ON TABLE
    public.church_financial_roles,
    public.church_financial_role_permissions,
    public.church_financial_user_roles,
    public.church_financial_role_audit
TO authenticated;

CREATE POLICY church_financial_roles_authenticated_read
    ON public.church_financial_roles
    FOR SELECT TO authenticated
    USING (is_active IS TRUE);

CREATE POLICY church_financial_role_permissions_authenticated_read
    ON public.church_financial_role_permissions
    FOR SELECT TO authenticated
    USING (TRUE);

CREATE POLICY church_financial_user_roles_self_or_manager_read
    ON public.church_financial_user_roles
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR public.has_church_financial_permission(church_id, 'accounting.roles.read')
    );

CREATE POLICY church_financial_role_audit_authorized_read
    ON public.church_financial_role_audit
    FOR SELECT TO authenticated
    USING (
        public.has_church_financial_permission(church_id, 'accounting.audit.read')
    );

-- No direct INSERT/UPDATE/DELETE grants or policies are provided to clients.
REVOKE ALL ON FUNCTION public.has_church_financial_permission(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.can_manage_church_financial_roles(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.assign_church_financial_role(UUID, UUID, TEXT, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.revoke_church_financial_role(UUID, TEXT)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public.accounting_revoke_financial_roles_on_eligibility_change()
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.has_church_financial_permission(UUID, TEXT)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.can_manage_church_financial_roles(UUID)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.assign_church_financial_role(UUID, UUID, TEXT, TEXT)
    TO authenticated;
GRANT EXECUTE ON FUNCTION public.revoke_church_financial_role(UUID, TEXT)
    TO authenticated;

COMMENT ON TABLE public.church_financial_roles IS
    'Global catalogue of standardized financial roles. Church-specific membership is stored separately in church_financial_user_roles.';
COMMENT ON TABLE public.church_financial_role_permissions IS
    'Global mapping of standardized financial roles to permission keys. Changes require a reviewed database migration.';
COMMENT ON TABLE public.church_financial_user_roles IS
    'Church-scoped financial role assignments. Client writes are prohibited; assign and revoke through secure RPCs.';
COMMENT ON TABLE public.church_financial_role_audit IS
    'Audit history for financial role assignment and revocation. Client writes are prohibited.';
COMMENT ON FUNCTION public.has_church_financial_permission(UUID, TEXT) IS
    'Returns true only for the authenticated active, unblocked user affiliated with the specified approved church and holding an active role mapped to the requested permission. Platform Super Admin status grants no implicit access.';
COMMENT ON FUNCTION public.assign_church_financial_role(UUID, UUID, TEXT, TEXT) IS
    'Assigns a standard financial role within one approved church. A church_admin may bootstrap only the first Finance Administrator; subsequent assignments require accounting.roles.manage.';
COMMENT ON FUNCTION public.revoke_church_financial_role(UUID, TEXT) IS
    'Revokes a church financial role assignment with a mandatory reason and immutable audit event.';
COMMENT ON FUNCTION public.accounting_revoke_financial_roles_on_eligibility_change() IS
    'Automatically revokes and audits church financial role assignments when a profile leaves its church, becomes inactive or blocked, is deleted, or its church loses approved status.';

COMMIT;
