-- BelieversMeet Staging
-- Church-admin-only transaction access.
-- Super Admin and ordinary members receive no direct access.

CREATE OR REPLACE FUNCTION public.can_church_admin_view_transactions(
    p_church_id uuid
)
RETURNS boolean
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
            JOIN public.churches AS c
              ON c.id = p.church_id
            WHERE p.id = auth.uid()
              AND p.church_id = p_church_id
              AND p.role = 'church_admin'
              AND p.status = 'active'
              AND p.is_blocked IS FALSE
              AND c.status = 'approved'
        );
$function$;
-- Only authenticated users need to evaluate this access check.
REVOKE ALL ON FUNCTION public.can_church_admin_view_transactions(uuid)
FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_church_admin_view_transactions(uuid)
TO authenticated, service_role;
ALTER TABLE public.transactions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS transactions_church_admin_read
ON public.transactions;
CREATE POLICY transactions_church_admin_read
ON public.transactions
FOR SELECT
TO authenticated
USING (
    public.can_church_admin_view_transactions(church_id)
);
-- Browser clients may read only rows permitted by the policy.
REVOKE ALL ON TABLE public.transactions FROM PUBLIC, anon;
REVOKE ALL ON TABLE public.transactions FROM authenticated;
GRANT SELECT ON TABLE public.transactions TO authenticated;
-- Payment processing remains server-side.
REVOKE ALL ON TABLE public.transactions FROM service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.transactions TO service_role;
