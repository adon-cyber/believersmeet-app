BEGIN;

ALTER TABLE public.announcements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS announcements_scoped_select ON public.announcements;
DROP POLICY IF EXISTS announcements_church_bulletin_insert ON public.announcements;
DROP POLICY IF EXISTS announcements_super_admin_broadcast_insert ON public.announcements;
DROP POLICY IF EXISTS announcements_church_bulletin_delete ON public.announcements;

-- Members see their own church bulletins and broadcasts intended for them.
-- Church managers see bulletins for churches they are authorized to manage.
CREATE POLICY announcements_scoped_select
ON public.announcements
FOR SELECT
TO authenticated
USING (
    (
        church_id IS NOT NULL
        AND (
            church_id = public.current_user_church_id()
            OR public.can_manage_church_content(church_id)
        )
    )
    OR (
        church_id IS NULL
        AND public.is_super_admin()
    )
    OR (
        church_id IS NULL
        AND target_type = 'all'
        AND EXISTS (
            SELECT 1
            FROM public.profiles AS p
            WHERE p.id = auth.uid()
              AND p.status = 'active'
              AND p.is_blocked IS FALSE
        )
    )
    OR (
        church_id IS NULL
        AND target_type = 'admins'
        AND EXISTS (
            SELECT 1
            FROM public.profiles AS p
            WHERE p.id = auth.uid()
              AND p.status = 'active'
              AND p.is_blocked IS FALSE
              AND p.role IN ('admin', 'church_admin', 'super_admin', 'super-admin')
        )
    )
    OR (
        church_id IS NULL
        AND target_type = 'church'
        AND target_id = public.current_user_church_id()
    )
);

-- Church managers can publish ordinary bulletins for their own church.
-- The app omits sender_id and relies on target_type's default of 'all'.
CREATE POLICY announcements_church_bulletin_insert
ON public.announcements
FOR INSERT
TO authenticated
WITH CHECK (
    church_id IS NOT NULL
    AND public.can_manage_church_content(church_id)
    AND target_type = 'all'
    AND target_id IS NULL
    AND sender_id IS NULL
);

-- Only the platform Super Admin can publish platform-wide broadcasts.
CREATE POLICY announcements_super_admin_broadcast_insert
ON public.announcements
FOR INSERT
TO authenticated
WITH CHECK (
    public.is_super_admin()
    AND sender_id = auth.uid()
    AND church_id IS NULL
    AND target_type IN ('all', 'admins', 'church')
    AND (
        (
            target_type IN ('all', 'admins')
            AND target_id IS NULL
        )
        OR (
            target_type = 'church'
            AND target_id IS NOT NULL
            AND public.is_approved_public_church(target_id)
        )
    )
);

-- Church managers can delete bulletins only within their authorized church.
CREATE POLICY announcements_church_bulletin_delete
ON public.announcements
FOR DELETE
TO authenticated
USING (
    church_id IS NOT NULL
    AND public.can_manage_church_content(church_id)
);

-- No anonymous access and no general UPDATE permission.
REVOKE ALL PRIVILEGES ON TABLE public.announcements
FROM PUBLIC, anon, authenticated;

GRANT SELECT ON TABLE public.announcements TO authenticated;
GRANT DELETE ON TABLE public.announcements TO authenticated;

-- Church Admin dashboard insert columns.
GRANT INSERT (title, content, pinned, church_id)
ON TABLE public.announcements TO authenticated;

-- Super Admin broadcast insert columns.
-- created_at is included because the current UI explicitly supplies it.
GRANT INSERT (title, content, sender_id, target_type, target_id, created_at)
ON TABLE public.announcements TO authenticated;

COMMIT;