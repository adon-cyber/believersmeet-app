-- BelieversMeet Staging
-- Central church subscription access helpers.
-- This migration does not modify existing RLS policies yet.

CREATE OR REPLACE FUNCTION public.has_valid_church_subscription(
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
        AND (
            public.is_super_admin()
            OR EXISTS (
                SELECT 1
                FROM public.profiles AS p
                INNER JOIN public.churches AS c
                    ON c.id = p.church_id
                INNER JOIN public.church_subscriptions AS s
                    ON s.church_id = c.id
                WHERE p.id = (SELECT auth.uid())
                  AND p.church_id = p_church_id
                  AND p.status = 'active'
                  AND COALESCE(p.is_blocked, false) = false
                  AND c.status = 'approved'
                  AND (
                      (
                          s.status = 'trial'
                          AND s.trial_ends_at IS NOT NULL
                          AND pg_catalog.statement_timestamp()
                              <= s.trial_ends_at
                                 + pg_catalog.make_interval(
                                     days => s.grace_period_days
                                 )
                      )
                      OR
                      (
                          s.status IN ('active', 'past_due')
                          AND s.current_period_end IS NOT NULL
                          AND pg_catalog.statement_timestamp()
                              <= s.current_period_end
                                 + pg_catalog.make_interval(
                                     days => s.grace_period_days
                                 )
                      )
                      OR s.status = 'exempt'
                  )
            )
        );
$function$;


CREATE OR REPLACE FUNCTION public.current_user_can_access_church_features()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT
        public.is_super_admin()
        OR EXISTS (
            SELECT 1
            FROM public.profiles AS p
            WHERE p.id = (SELECT auth.uid())
              AND p.status = 'active'
              AND COALESCE(p.is_blocked, false) = false
              AND (
                  p.church_id IS NULL
                  OR public.has_valid_church_subscription(p.church_id)
              )
        );
$function$;


-- Only authenticated users can execute these access-check helpers.
REVOKE ALL ON FUNCTION
    public.has_valid_church_subscription(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION
    public.current_user_can_access_church_features()
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION
    public.has_valid_church_subscription(uuid)
    TO authenticated;

GRANT EXECUTE ON FUNCTION
    public.current_user_can_access_church_features()
    TO authenticated;
