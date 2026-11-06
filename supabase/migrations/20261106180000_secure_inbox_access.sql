BEGIN;

ALTER TABLE public.inbox ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS inbox_church_admin_select ON public.inbox;
DROP POLICY IF EXISTS inbox_member_insert ON public.inbox;

-- Only the platform Super Admin or the authorized Church Admin
-- for the inquiry's approved church can read inbox records.
CREATE POLICY inbox_church_admin_select
ON public.inbox
FOR SELECT
TO authenticated
USING (
    public.is_super_admin()
    OR (
        church_id IS NOT NULL
        AND church_id = public.current_user_church_id()::text
        AND public.is_current_user_church_admin()
        AND public.is_approved_public_church(public.current_user_church_id())
    )
);

-- An authenticated user can submit an inquiry only to their own
-- approved church, using the name stored on their own profile.
CREATE POLICY inbox_member_insert
ON public.inbox
FOR INSERT
TO authenticated
WITH CHECK (
    church_id IS NOT NULL
    AND public.current_user_church_id() IS NOT NULL
    AND church_id = public.current_user_church_id()::text
    AND public.is_approved_public_church(public.current_user_church_id())
    AND sender_name IS NOT DISTINCT FROM (
        SELECT p.full_name
        FROM public.profiles AS p
        WHERE p.id = auth.uid()
    )
);

-- No anonymous access, and no authenticated UPDATE or DELETE.
REVOKE ALL PRIVILEGES ON TABLE public.inbox
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.inbox TO authenticated;

GRANT INSERT (sender_name, message, church_id)
ON TABLE public.inbox TO authenticated;

-- Required for automatic BIGSERIAL id generation on inserts.
REVOKE ALL PRIVILEGES ON SEQUENCE public.inbox_id_seq
FROM PUBLIC, anon, authenticated;

GRANT USAGE ON SEQUENCE public.inbox_id_seq TO authenticated;

COMMIT;