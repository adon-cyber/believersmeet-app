BEGIN;

ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS notifications_select_own ON public.notifications;
DROP POLICY IF EXISTS notifications_update_own ON public.notifications;

CREATE POLICY notifications_select_own
ON public.notifications
FOR SELECT
TO authenticated
USING (user_id = (SELECT auth.uid()));

CREATE POLICY notifications_update_own
ON public.notifications
FOR UPDATE
TO authenticated
USING (user_id = (SELECT auth.uid()))
WITH CHECK (user_id = (SELECT auth.uid()));

REVOKE ALL ON TABLE public.notifications FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.notifications TO authenticated;
GRANT UPDATE (is_read) ON TABLE public.notifications TO authenticated;

COMMIT;
