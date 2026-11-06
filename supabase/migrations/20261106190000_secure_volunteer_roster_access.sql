BEGIN;

-- =========================================================
-- 1. VOLUNTEER ROSTER POLICIES
-- =========================================================

ALTER TABLE public.volunteer_roster ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS volunteer_roster_anon_active_select
    ON public.volunteer_roster;
DROP POLICY IF EXISTS volunteer_roster_authenticated_select
    ON public.volunteer_roster;
DROP POLICY IF EXISTS volunteer_roster_manager_insert
    ON public.volunteer_roster;
DROP POLICY IF EXISTS volunteer_roster_manager_delete
    ON public.volunteer_roster;

CREATE POLICY volunteer_roster_anon_active_select
ON public.volunteer_roster
FOR SELECT TO anon
USING (
    church_id IS NOT NULL
    AND is_active IS TRUE
    AND public.is_approved_public_church(church_id)
);

CREATE POLICY volunteer_roster_authenticated_select
ON public.volunteer_roster
FOR SELECT TO authenticated
USING (
    church_id IS NOT NULL
    AND (
        (
            is_active IS TRUE
            AND public.is_approved_public_church(church_id)
        )
        OR public.can_manage_church_content(church_id)
    )
);

CREATE POLICY volunteer_roster_manager_insert
ON public.volunteer_roster
FOR INSERT TO authenticated
WITH CHECK (
    church_id IS NOT NULL
    AND public.can_manage_church_content(church_id)
);

CREATE POLICY volunteer_roster_manager_delete
ON public.volunteer_roster
FOR DELETE TO authenticated
USING (
    church_id IS NOT NULL
    AND public.can_manage_church_content(church_id)
);

-- =========================================================
-- 2. VOLUNTEER SIGNUP POLICIES
-- =========================================================

ALTER TABLE public.volunteer_signups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS volunteer_signups_own_select
    ON public.volunteer_signups;
DROP POLICY IF EXISTS volunteer_signups_manager_select
    ON public.volunteer_signups;
DROP POLICY IF EXISTS volunteer_signups_own_insert
    ON public.volunteer_signups;
DROP POLICY IF EXISTS volunteer_signups_own_delete
    ON public.volunteer_signups;

CREATE POLICY volunteer_signups_own_select
ON public.volunteer_signups
FOR SELECT TO authenticated
USING (user_id = auth.uid());

CREATE POLICY volunteer_signups_manager_select
ON public.volunteer_signups
FOR SELECT TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.volunteer_roster AS r
        WHERE r.id = volunteer_signups.slot_id
          AND public.can_manage_church_content(r.church_id)
    )
);

CREATE POLICY volunteer_signups_own_insert
ON public.volunteer_signups
FOR INSERT TO authenticated
WITH CHECK (
    user_id = auth.uid()
    AND slot_id IS NOT NULL
    AND (
        user_email IS NULL
        OR user_email = COALESCE(auth.jwt()->>'email', '')
    )
    AND EXISTS (
        SELECT 1
        FROM public.profiles AS p
        WHERE p.id = auth.uid()
          AND p.status = 'active'
          AND p.is_blocked IS FALSE
    )
    AND EXISTS (
        SELECT 1
        FROM public.volunteer_roster AS r
        WHERE r.id = volunteer_signups.slot_id
          AND r.is_active IS TRUE
          AND r.church_id IS NOT NULL
          AND public.is_approved_public_church(r.church_id)
    )
);

CREATE POLICY volunteer_signups_own_delete
ON public.volunteer_signups
FOR DELETE TO authenticated
USING (user_id = auth.uid());

-- =========================================================
-- 3. SECURITY-INVOKER PUBLIC ROSTER VIEW
-- =========================================================

CREATE OR REPLACE VIEW public.church_volunteer_roster
WITH (security_barrier = true, security_invoker = true)
AS
SELECT
    id,
    title,
    description,
    event_date,
    church_id,
    max_capacity,
    is_active
FROM public.volunteer_roster;

-- =========================================================
-- 4. MEMBER COUNT-ONLY SUMMARY FUNCTION
-- =========================================================

CREATE OR REPLACE FUNCTION public.get_volunteer_slot_summaries(
    p_slot_ids uuid[]
)
RETURNS TABLE (
    slot_id uuid,
    signup_count bigint,
    is_signed_up_by_me boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT
        r.id,
        COUNT(s.id),
        COALESCE(BOOL_OR(s.user_id = auth.uid()), FALSE)
    FROM public.volunteer_roster AS r
    LEFT JOIN public.volunteer_signups AS s
        ON s.slot_id = r.id
    WHERE auth.uid() IS NOT NULL
      AND EXISTS (
          SELECT 1
          FROM public.profiles AS p
          WHERE p.id = auth.uid()
            AND p.status = 'active'
            AND p.is_blocked IS FALSE
      )
      AND r.id = ANY(COALESCE(p_slot_ids, ARRAY[]::uuid[]))
      AND r.is_active IS TRUE
      AND r.church_id IS NOT NULL
      AND public.is_approved_public_church(r.church_id)
    GROUP BY r.id;
$function$;

-- =========================================================
-- 5. MANAGER-ONLY FULL ROSTER FUNCTION
-- =========================================================

CREATE OR REPLACE FUNCTION public.get_admin_volunteer_roster(
    p_church_id uuid
)
RETURNS TABLE (
    id uuid,
    title text,
    event_date date,
    description text,
    assigned_user_id uuid,
    created_at timestamptz,
    event_id uuid,
    church_id uuid,
    max_capacity integer,
    is_active boolean
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT
        r.id,
        r.title,
        r.event_date,
        r.description,
        r.assigned_user_id,
        r.created_at,
        r.event_id,
        r.church_id,
        r.max_capacity,
        r.is_active
    FROM public.volunteer_roster AS r
    WHERE (p_church_id IS NULL OR r.church_id = p_church_id)
      AND (
          (p_church_id IS NOT NULL AND public.can_manage_church_content(p_church_id))
          OR (p_church_id IS NULL AND public.is_super_admin())
      )
    ORDER BY r.event_date ASC;
$function$;

-- =========================================================
-- 6. MANAGER-ONLY SIGNUP DETAILS FOR A CHURCH
-- =========================================================

CREATE OR REPLACE FUNCTION public.get_admin_church_volunteer_signups(
    p_church_id uuid
)
RETURNS TABLE (
    id uuid,
    slot_id uuid,
    user_id uuid,
    full_name text,
    user_email text,
    phone text,
    created_at timestamptz,
    slot_title text,
    slot_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT
        s.id,
        s.slot_id,
        s.user_id,
        COALESCE(p.full_name, s.full_name, s.user_email, 'Volunteer'),
        COALESCE(p.email, s.user_email, s.email),
        COALESCE(p.phone, s.phone),
        s.created_at,
        COALESCE(s.slot_title, s.slot_name, r.title),
        COALESCE(s.slot_name, s.slot_title, r.title)
    FROM public.volunteer_signups AS s
    JOIN public.volunteer_roster AS r
        ON r.id = s.slot_id
    LEFT JOIN public.profiles AS p
        ON p.id = s.user_id
    WHERE (p_church_id IS NULL OR r.church_id = p_church_id)
      AND (
          (p_church_id IS NOT NULL AND public.can_manage_church_content(p_church_id))
          OR (p_church_id IS NULL AND public.is_super_admin())
      )
    ORDER BY s.created_at DESC;
$function$;

-- =========================================================
-- 7. MANAGER-ONLY SIGNUP DETAILS FOR ONE SLOT
-- =========================================================

CREATE OR REPLACE FUNCTION public.get_admin_slot_volunteer_signups(
    p_slot_id uuid
)
RETURNS TABLE (
    id uuid,
    slot_id uuid,
    user_id uuid,
    full_name text,
    user_email text,
    phone text,
    created_at timestamptz,
    slot_title text,
    slot_name text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT
        s.id,
        s.slot_id,
        s.user_id,
        COALESCE(p.full_name, s.full_name, s.user_email, 'Volunteer'),
        COALESCE(p.email, s.user_email, s.email),
        COALESCE(p.phone, s.phone),
        s.created_at,
        COALESCE(s.slot_title, s.slot_name, r.title),
        COALESCE(s.slot_name, s.slot_title, r.title)
    FROM public.volunteer_signups AS s
    JOIN public.volunteer_roster AS r
        ON r.id = s.slot_id
    LEFT JOIN public.profiles AS p
        ON p.id = s.user_id
    WHERE r.id = p_slot_id
      AND public.can_manage_church_content(r.church_id)
    ORDER BY s.created_at DESC;
$function$;

-- =========================================================
-- 8. TABLE AND VIEW PRIVILEGES
-- =========================================================

REVOKE ALL PRIVILEGES ON TABLE public.volunteer_roster
FROM PUBLIC, anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.volunteer_signups
FROM PUBLIC, anon, authenticated;

REVOKE ALL PRIVILEGES ON TABLE public.church_volunteer_roster
FROM PUBLIC, anon, authenticated;

-- Only safe slot columns are directly selectable.
GRANT SELECT (
    id,
    title,
    description,
    event_date,
    church_id,
    max_capacity,
    is_active
)
ON TABLE public.volunteer_roster TO anon, authenticated;

GRANT SELECT ON TABLE public.church_volunteer_roster
TO anon, authenticated;

-- Admin slot creation and deletion.
GRANT INSERT (
    title,
    event_date,
    description,
    church_id,
    max_capacity,
    is_active
)
ON TABLE public.volunteer_roster TO authenticated;

GRANT DELETE ON TABLE public.volunteer_roster TO authenticated;

-- Signups: RLS limits direct reads and deletes to own rows
-- or authorized church managers.
GRANT SELECT, DELETE ON TABLE public.volunteer_signups
TO authenticated;

GRANT INSERT (
    slot_id,
    user_id,
    full_name,
    user_email,
    slot_title,
    slot_name
)
ON TABLE public.volunteer_signups TO authenticated;

-- =========================================================
-- 9. FUNCTION EXECUTION PRIVILEGES
-- =========================================================

REVOKE ALL ON FUNCTION
    public.get_volunteer_slot_summaries(uuid[])
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
    public.get_admin_volunteer_roster(uuid)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
    public.get_admin_church_volunteer_signups(uuid)
FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION
    public.get_admin_slot_volunteer_signups(uuid)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.get_volunteer_slot_summaries(uuid[])
TO authenticated;

GRANT EXECUTE ON FUNCTION
    public.get_admin_volunteer_roster(uuid)
TO authenticated;

GRANT EXECUTE ON FUNCTION
    public.get_admin_church_volunteer_signups(uuid)
TO authenticated;

GRANT EXECUTE ON FUNCTION
    public.get_admin_slot_volunteer_signups(uuid)
TO authenticated;

COMMIT;