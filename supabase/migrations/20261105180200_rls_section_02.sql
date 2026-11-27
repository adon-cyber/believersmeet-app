-- ============================================================
-- BELIEVERSMEET STAGING RLS - SECTION 02
-- Public church content
--
-- TARGET TABLES:
--   public.programmes
--   public.sermons
--   public.gallery_images
--   public.church_leaders
--
-- DRAFT ONLY. DO NOT EXECUTE YET.
--
-- Merge into the reviewed, ordered Staging RLS/grants package.
-- Do not run as a standalone production migration.
--
-- Deliberately excluded:
--   public.rsvps          (separate privacy and RSVP design)
--   public.announcements (global broadcast audience needs review)
--   Storage object policies (separate design)
-- ============================================================

BEGIN;
-- ------------------------------------------------------------
-- 1. FAIL-CLOSED PREFLIGHT
-- ------------------------------------------------------------

DO $preflight$
BEGIN
    IF current_user <> 'postgres' THEN
        RAISE EXCEPTION
            'Preflight failed: this section must be reviewed/applied as postgres.';
    END IF;

    IF to_regclass('public.programmes') IS NULL
       OR to_regclass('public.sermons') IS NULL
       OR to_regclass('public.gallery_images') IS NULL
       OR to_regclass('public.church_leaders') IS NULL THEN
        RAISE EXCEPTION
            'Preflight failed: one or more Foundation v4 content tables are missing.';
    END IF;

    IF to_regclass('public.churches') IS NULL
       OR to_regclass('public.profiles') IS NULL
       OR to_regclass('private.platform_admins') IS NULL THEN
        RAISE EXCEPTION
            'Preflight failed: required church, profile, or allowlist object is missing.';
    END IF;

    IF to_regprocedure('public.is_super_admin()') IS NULL THEN
        RAISE EXCEPTION
            'Preflight failed: public.is_super_admin() is missing.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
       OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
        RAISE EXCEPTION
            'Preflight failed: expected Supabase database roles are missing.';
    END IF;

    IF (
        SELECT count(*)
        FROM pg_class AS c
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN (
              'programmes',
              'sermons',
              'gallery_images',
              'church_leaders'
          )
          AND c.relrowsecurity
    ) <> 4 THEN
        RAISE EXCEPTION
            'Preflight failed: RLS must already be enabled on all four tables.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_policy AS p
        JOIN pg_class AS c ON c.oid = p.polrelid
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname IN (
              'programmes',
              'sermons',
              'gallery_images',
              'church_leaders'
          )
    ) THEN
        RAISE EXCEPTION
            'Preflight failed: existing policies were found. Review and reconcile them first.';
    END IF;

    IF to_regprocedure('public.is_approved_public_church(uuid)') IS NOT NULL
       OR to_regprocedure('public.can_manage_church_content(uuid)') IS NOT NULL THEN
        RAISE EXCEPTION
            'Preflight failed: one or more Section 02 helper functions already exist. Review before replacement.';
    END IF;
END;
$preflight$;
-- ------------------------------------------------------------
-- 2. SECURITY-DEFINER HELPERS
-- ------------------------------------------------------------

-- Public content is readable only when its church is approved.
-- This helper exposes only a boolean result.

CREATE FUNCTION public.is_approved_public_church(
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
        AND EXISTS (
            SELECT 1
            FROM public.churches AS c
            WHERE c.id = p_church_id
              AND c.status = 'approved'
        );
$function$;
ALTER FUNCTION public.is_approved_public_church(uuid)
    OWNER TO postgres;
-- Content management:
--   1. Allowlisted Platform Admin may manage church content.
--   2. Church Admin must be active, unblocked, attached to the
--      exact church, and that church must be approved.
--   3. NULL church IDs are never accepted.

CREATE FUNCTION public.can_manage_church_content(
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
        AND (
            public.is_super_admin()
            OR EXISTS (
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
            )
        );
$function$;
ALTER FUNCTION public.can_manage_church_content(uuid)
    OWNER TO postgres;
-- Do not leave default PUBLIC function execution enabled.

REVOKE ALL ON FUNCTION public.is_approved_public_church(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.is_approved_public_church(uuid)
    TO anon, authenticated;
REVOKE ALL ON FUNCTION public.can_manage_church_content(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_manage_church_content(uuid)
    TO authenticated;
-- ------------------------------------------------------------
-- 3. RESET BROWSER-ROLE TABLE AND COLUMN PRIVILEGES
--    Preserve privileged backend access for service_role.
-- ------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE public.programmes
    FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES (
    id, church_id, title, programme_date, description,
    start_time, bible_link, created_at, day_of_week,
    end_time, schedule_text, location, venue
) ON TABLE public.programmes
    FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.sermons
    FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES (
    id, title, preacher, audio_url, church_id, created_at,
    church_name, category, media_type, media_url, video_url,
    thumbnail_url, description
) ON TABLE public.sermons
    FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.gallery_images
    FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES (
    id, created_at, image_url, caption,
    church_id, uploaded_by, uploader_name
) ON TABLE public.gallery_images
    FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES ON TABLE public.church_leaders
    FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES (
    id, church_id, name, role, bio, image_url, created_at
) ON TABLE public.church_leaders
    FROM PUBLIC, anon, authenticated;
-- Backend service role retains its privileged access.
-- Never expose its credentials to browser code.

GRANT ALL PRIVILEGES ON TABLE public.programmes TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.sermons TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.gallery_images TO service_role;
GRANT ALL PRIVILEGES ON TABLE public.church_leaders TO service_role;
-- ------------------------------------------------------------
-- 4. SELECT PRIVILEGES
-- ------------------------------------------------------------

GRANT SELECT ON TABLE public.programmes
    TO anon, authenticated;
GRANT SELECT ON TABLE public.sermons
    TO anon, authenticated;
GRANT SELECT (created_at, image_url, caption, church_id, uploader_name) ON TABLE public.gallery_images TO anon, authenticated;
GRANT SELECT ON TABLE public.church_leaders
    TO anon, authenticated;
-- ------------------------------------------------------------
-- 5. MINIMUM INSERT PRIVILEGES
-- ------------------------------------------------------------

-- Fields used by admin.html and church-dashboard.html.
-- programme_date and created_at use database defaults unless
-- a later, reviewed UI change explicitly supplies them.

GRANT INSERT (
    church_id,
    title,
    description,
    location,
    day_of_week,
    start_time,
    end_time,
    schedule_text
) ON TABLE public.programmes TO authenticated;
-- Union of the fields used by the reviewed sermon insert paths.
-- church_name is deliberately excluded because these payloads
-- do not supply it.

GRANT INSERT (
    title,
    preacher,
    audio_url,
    church_id,
    category,
    media_type,
    media_url,
    video_url,
    thumbnail_url,
    description,
    created_at
) ON TABLE public.sermons TO authenticated;
-- Both reviewed gallery insert paths omit uploaded_by.

GRANT INSERT (
    image_url,
    caption,
    church_id,
    uploader_name
) ON TABLE public.gallery_images TO authenticated;
GRANT INSERT (
    church_id,
    name,
    role,
    bio,
    image_url
) ON TABLE public.church_leaders TO authenticated;
-- Delete is used by the reviewed programme and leader interfaces.
GRANT DELETE ON TABLE public.programmes TO authenticated;
GRANT DELETE ON TABLE public.church_leaders TO authenticated;
-- ------------------------------------------------------------
-- 6. PUBLIC READ POLICIES
--    Anonymous and authenticated visitors see approved churches.
-- ------------------------------------------------------------

CREATE POLICY programmes_public_read_approved
ON public.programmes
FOR SELECT
TO anon, authenticated
USING (
    public.is_approved_public_church(church_id)
);
CREATE POLICY sermons_public_read_approved
ON public.sermons
FOR SELECT
TO anon, authenticated
USING (
    public.is_approved_public_church(church_id)
);
CREATE POLICY gallery_images_public_read_approved
ON public.gallery_images
FOR SELECT
TO anon, authenticated
USING (
    public.is_approved_public_church(church_id)
);
CREATE POLICY church_leaders_public_read_approved
ON public.church_leaders
FOR SELECT
TO anon, authenticated
USING (
    public.is_approved_public_church(church_id)
);
-- ------------------------------------------------------------
-- 7. AUTHENTICATED MANAGER READ POLICIES
--    Allow Platform Admin to inspect content of pending churches.
--    Church Admin access remains restricted by the helper.
-- ------------------------------------------------------------

CREATE POLICY programmes_authenticated_read_managed
ON public.programmes
FOR SELECT
TO authenticated
USING (
    public.can_manage_church_content(church_id)
);
CREATE POLICY sermons_authenticated_read_managed
ON public.sermons
FOR SELECT
TO authenticated
USING (
    public.can_manage_church_content(church_id)
);
CREATE POLICY gallery_images_authenticated_read_managed
ON public.gallery_images
FOR SELECT
TO authenticated
USING (
    public.can_manage_church_content(church_id)
);
CREATE POLICY church_leaders_authenticated_read_managed
ON public.church_leaders
FOR SELECT
TO authenticated
USING (
    public.can_manage_church_content(church_id)
);
-- ------------------------------------------------------------
-- 8. INSERT POLICIES
-- ------------------------------------------------------------

CREATE POLICY programmes_authenticated_insert_managed
ON public.programmes
FOR INSERT
TO authenticated
WITH CHECK (
    public.can_manage_church_content(church_id)
);
CREATE POLICY sermons_authenticated_insert_managed
ON public.sermons
FOR INSERT
TO authenticated
WITH CHECK (
    public.can_manage_church_content(church_id)
);
CREATE POLICY gallery_images_authenticated_insert_managed
ON public.gallery_images
FOR INSERT
TO authenticated
WITH CHECK (
    public.can_manage_church_content(church_id)
);
CREATE POLICY church_leaders_authenticated_insert_managed
ON public.church_leaders
FOR INSERT
TO authenticated
WITH CHECK (
    public.can_manage_church_content(church_id)
);
-- ------------------------------------------------------------
-- 9. DELETE POLICIES
-- ------------------------------------------------------------

CREATE POLICY programmes_authenticated_delete_managed
ON public.programmes
FOR DELETE
TO authenticated
USING (
    public.can_manage_church_content(church_id)
);
CREATE POLICY church_leaders_authenticated_delete_managed
ON public.church_leaders
FOR DELETE
TO authenticated
USING (
    public.can_manage_church_content(church_id)
);
-- ------------------------------------------------------------
-- 10. END OF SECTION 02
--
-- Not covered here:
--   - RSVP access, attendee privacy, and uniqueness
--   - Storage policies for music-uploads and other buckets
--   - Announcement audience and moderation rules
--   - Broader application RLS and grants
--
-- This file has not been executed or live-tested.
-- ------------------------------------------------------------

COMMIT;
