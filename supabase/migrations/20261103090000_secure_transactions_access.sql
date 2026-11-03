BEGIN;

-- Remove all direct database privileges from browser-facing roles.
-- This also revokes their existing column-level privileges.
REVOKE ALL PRIVILEGES
ON TABLE public.transactions
FROM PUBLIC, anon, authenticated;

-- Authenticated users may read rows only where an RLS policy permits.
GRANT SELECT
ON TABLE public.transactions
TO authenticated;

-- Remove the old permissive transaction policies.
DROP POLICY IF EXISTS "Users can insert transactions"
ON public.transactions;

DROP POLICY IF EXISTS "Finance staff can update transactions"
ON public.transactions;

DROP POLICY IF EXISTS "Finance staff can view all transactions"
ON public.transactions;

DROP POLICY IF EXISTS "Users can view their own transactions"
ON public.transactions;

-- Members see their own transactions.
-- Finance and church admins see their own church's transactions,
-- including guest donations.
-- Super Admin can see transactions across all churches.
CREATE POLICY "Read permitted church transactions"
ON public.transactions
FOR SELECT
TO authenticated
USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (
        SELECT 1
        FROM public.profiles AS p
        WHERE p.id = (SELECT auth.uid())
          AND (
              p.role = 'super_admin'
              OR (
                  p.role IN ('church_admin', 'finance')
                  AND p.church_id = transactions.church_id
              )
          )
    )
);

COMMIT;
