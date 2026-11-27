-- BelieversMeet Accounting & Budgeting
-- Church Admin-controlled financial role assignment and access management.
-- Apply only after the church financial roles foundation (Migration 002) exists.
-- This migration does not assign roles or change existing active assignments.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $preflight$
BEGIN
    IF current_user <> 'postgres' THEN
        RAISE EXCEPTION 'Preflight failed: execute this migration as postgres';
    END IF;

    IF pg_catalog.to_regclass('public.profiles') IS NULL
       OR pg_catalog.to_regclass('public.churches') IS NULL
       OR pg_catalog.to_regclass('public.church_financial_roles') IS NULL
       OR pg_catalog.to_regclass('public.church_financial_role_permissions') IS NULL
       OR pg_catalog.to_regclass('public.church_financial_user_roles') IS NULL
       OR pg_catalog.to_regclass('public.church_financial_role_audit') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: install the church financial role foundation before this migration';
    END IF;

    IF pg_catalog.to_regprocedure('public.has_church_financial_permission(uuid,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.can_manage_church_financial_roles(uuid)') IS NULL
       OR pg_catalog.to_regprocedure('public.assign_church_financial_role(uuid,uuid,text,text)') IS NULL
       OR pg_catalog.to_regprocedure('public.revoke_church_financial_role(uuid,text)') IS NULL THEN
        RAISE EXCEPTION 'Preflight failed: required church financial role functions are missing';
    END IF;

    IF pg_catalog.to_regprocedure('public.get_church_financial_role_management_data(uuid)') IS NOT NULL THEN
        RAISE EXCEPTION 'Preflight failed: the financial role management roster function already exists';
    END IF;

    IF NOT EXISTS (
        SELECT 1 FROM public.church_financial_roles
        WHERE role_code = 'finance_administrator' AND is_active IS TRUE
    ) OR NOT EXISTS (
        SELECT 1 FROM public.church_financial_roles
        WHERE role_code = 'treasurer' AND is_active IS TRUE
    ) OR NOT EXISTS (
        SELECT 1 FROM public.church_financial_roles
        WHERE role_code = 'accountant' AND is_active IS TRUE
    ) OR NOT EXISTS (
        SELECT 1 FROM public.church_financial_roles
        WHERE role_code = 'budget_manager' AND is_active IS TRUE
    ) OR NOT EXISTS (
        SELECT 1 FROM public.church_financial_roles
        WHERE role_code = 'financial_approver' AND is_active IS TRUE
    ) OR NOT EXISTS (
        SELECT 1 FROM public.church_financial_roles
        WHERE role_code = 'financial_viewer' AND is_active IS TRUE
    ) THEN
        RAISE EXCEPTION 'Preflight failed: one or more standard church financial roles are missing or inactive';
    END IF;
END;
$preflight$;

-- 1. The active, unblocked Church Admin of the same approved church is the
--    sole authority for assigning and revoking financial roles.
--    Finance Administrator remains an operational finance role, not an
--    access-management role. Platform Super Admin status is not a bypass.
CREATE OR REPLACE FUNCTION public.can_manage_church_financial_roles(
    p_church_id UUID
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
        AND EXISTS (
            SELECT 1
            FROM public.profiles AS p
            JOIN public.churches AS c ON c.id = p.church_id
            WHERE p.id = auth.uid()
              AND p.church_id = p_church_id
              AND p.role = 'church_admin'
              AND p.status = 'active'
              AND p.is_blocked IS FALSE
              AND c.status = 'approved'
        );
$function$;

ALTER FUNCTION public.can_manage_church_financial_roles(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_manage_church_financial_roles(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_church_financial_roles(UUID)
    TO authenticated;

-- The assignment and revocation RPCs already call this helper. Changing the
-- helper therefore changes both operations to Church Admin-only without
-- granting direct table-write permissions or bypassing their audit trail.

-- 2. Allow the Church Admin to inspect role assignments and the role audit.
--    Existing read-only permissions for Finance roles are preserved.
DROP POLICY IF EXISTS church_financial_user_roles_self_or_manager_read
    ON public.church_financial_user_roles;
CREATE POLICY church_financial_user_roles_self_or_manager_read
    ON public.church_financial_user_roles
    FOR SELECT TO authenticated
    USING (
        user_id = auth.uid()
        OR public.can_manage_church_financial_roles(church_id)
        OR public.has_church_financial_permission(church_id, 'accounting.roles.read')
    );

DROP POLICY IF EXISTS church_financial_role_audit_authorized_read
    ON public.church_financial_role_audit;
CREATE POLICY church_financial_role_audit_authorized_read
    ON public.church_financial_role_audit
    FOR SELECT TO authenticated
    USING (
        public.can_manage_church_financial_roles(church_id)
        OR public.has_church_financial_permission(church_id, 'accounting.audit.read')
    );

-- 3. Remove the old role-management permission from Finance Administrator.
--    This makes the authority boundary clear even to permission catalogue
--    consumers: Finance Administrators cannot grant or revoke staff access.
DELETE FROM public.church_financial_role_permissions AS rp
USING public.church_financial_roles AS r
WHERE r.id = rp.role_id
  AND r.role_code = 'finance_administrator'
  AND rp.permission_key = 'accounting.roles.manage';

-- Clarify the operational responsibilities in the role catalogue.
UPDATE public.church_financial_roles
SET description = 'Leads accounting operations and configuration: chart of accounts, funds, departments, accounting periods, financial settings, and financial oversight. Does not assign or revoke staff financial roles; that authority belongs to the Church Admin.'
WHERE role_code = 'finance_administrator';

UPDATE public.church_financial_roles
SET description = 'Oversees cash and bank activity, reviews reconciliations, monitors treasury balances, and handles delegated financial approvals. Cannot assign or revoke staff financial roles.'
WHERE role_code = 'treasurer';

UPDATE public.church_financial_roles
SET description = 'Maintains accounting records, prepares journals, records transactions, and manages authorized accounting entries and supplier bills. Cannot assign or revoke staff financial roles.'
WHERE role_code = 'accountant';

UPDATE public.church_financial_roles
SET description = 'Prepares and revises church and departmental budgets, maintains allocations, monitors budget performance, and submits budgets for review. Cannot approve their own submitted budgets or assign staff financial roles.'
WHERE role_code = 'budget_manager';

UPDATE public.church_financial_roles
SET description = 'Independently reviews and approves eligible budgets, expenses, and supplier bills within delegated approval rules. Cannot assign or revoke staff financial roles.'
WHERE role_code = 'financial_approver';

UPDATE public.church_financial_roles
SET description = 'Read-only access to permitted accounting information, budgets, and financial reports. Cannot create, edit, approve, or post financial records and cannot assign staff roles.'
WHERE role_code = 'financial_viewer';

-- 4. Church Admin-only roster RPC for the role-management screen.
--    It returns only active, unblocked members of the authenticated admin's
--    own approved church, with their active financial-role assignments.
CREATE OR REPLACE FUNCTION public.get_church_financial_role_management_data(
    p_church_id UUID
)
RETURNS TABLE (
    profile_id UUID,
    full_name TEXT,
    profile_role TEXT,
    assignment_id UUID,
    financial_role_code TEXT,
    financial_role_name TEXT,
    financial_role_description TEXT,
    granted_by UUID,
    granted_at TIMESTAMPTZ,
    grant_reason TEXT
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF p_church_id IS NULL
       OR NOT public.can_manage_church_financial_roles(p_church_id) THEN
        RAISE EXCEPTION 'Only the active Church Admin of this approved church may view its financial role roster'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        p.id,
        p.full_name::TEXT,
        p.role::TEXT,
        ur.id,
        r.role_code,
        r.display_name,
        r.description,
        ur.granted_by,
        ur.granted_at,
        ur.grant_reason
    FROM public.profiles AS p
    JOIN public.churches AS c
      ON c.id = p.church_id
    LEFT JOIN public.church_financial_user_roles AS ur
      ON ur.church_id = p.church_id
     AND ur.user_id = p.id
     AND ur.revoked_at IS NULL
    LEFT JOIN public.church_financial_roles AS r
      ON r.id = ur.role_id
     AND r.is_active IS TRUE
    WHERE p.church_id = p_church_id
      AND p.status = 'active'
      AND p.is_blocked IS FALSE
      AND c.status = 'approved'
    ORDER BY p.full_name NULLS LAST, r.display_name NULLS LAST;
END;
$function$;

ALTER FUNCTION public.get_church_financial_role_management_data(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.get_church_financial_role_management_data(UUID)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_church_financial_role_management_data(UUID)
    TO authenticated;

COMMENT ON FUNCTION public.can_manage_church_financial_roles(UUID) IS
    'Returns true only for the active, unblocked Church Admin of the specified approved church. Financial role holders and platform Super Admin status do not grant role-management authority.';
COMMENT ON FUNCTION public.get_church_financial_role_management_data(UUID) IS
    'Returns active, unblocked members and their active financial role assignments for the authenticated Church Admin of that approved church.';
COMMENT ON FUNCTION public.assign_church_financial_role(UUID, UUID, TEXT, TEXT) IS
    'Assigns a financial role through a mandatory reason and audit event. Only the active Church Admin of the same approved church may assign roles; self-assignment remains prohibited.';
COMMENT ON FUNCTION public.revoke_church_financial_role(UUID, TEXT) IS
    'Revokes a financial role through a mandatory reason and audit event. Only the active Church Admin of that approved church may revoke roles.';

COMMIT;
