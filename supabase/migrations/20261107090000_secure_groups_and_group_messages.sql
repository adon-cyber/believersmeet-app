BEGIN;

-- ============================================================
-- 1. MEMBERSHIP APPROVAL STATUS
-- Existing memberships remain approved.
-- ============================================================

ALTER TABLE public.group_members
    ADD COLUMN status text NOT NULL DEFAULT 'approved';

ALTER TABLE public.group_members
    ADD CONSTRAINT group_members_status_check
    CHECK (status IN ('pending', 'approved', 'rejected'));

CREATE INDEX group_members_user_status_idx
    ON public.group_members (user_id, status);

CREATE INDEX group_members_group_status_idx
    ON public.group_members (group_id, status);


-- ============================================================
-- 2. GROUP MEMBERSHIP CHECK
-- SECURITY DEFINER avoids recursive RLS evaluation.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_approved_group_member(
    p_group_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM public.group_members AS gm
        INNER JOIN public.profiles AS p
            ON p.id = gm.user_id
        WHERE gm.group_id = p_group_id
          AND gm.user_id = auth.uid()
          AND gm.status = 'approved'
          AND p.status = 'active'
          AND COALESCE(p.is_blocked, false) = false
    );
$function$;


-- ============================================================
-- 3. JOIN A GROUP
-- Open groups approve immediately.
-- Locked groups create pending requests.
-- Existing approved memberships are never downgraded.
-- ============================================================

CREATE OR REPLACE FUNCTION public.join_group(
    p_group_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_user_id uuid := auth.uid();
    v_church_id uuid;
    v_allow_instant_join boolean;
    v_profile_church_id uuid;
    v_profile_status text;
    v_is_blocked boolean;
    v_result text;
BEGIN
    IF v_user_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    SELECT p.church_id, p.status, COALESCE(p.is_blocked, false)
      INTO v_profile_church_id, v_profile_status, v_is_blocked
    FROM public.profiles AS p
    WHERE p.id = v_user_id;

    IF NOT FOUND
       OR v_profile_status IS DISTINCT FROM 'active'
       OR v_is_blocked THEN
        RAISE EXCEPTION 'Your account is not eligible to join groups';
    END IF;

    SELECT g.church_id, g.allow_instant_join
      INTO v_church_id, v_allow_instant_join
    FROM public.groups AS g
    INNER JOIN public.churches AS c
        ON c.id = g.church_id
    WHERE g.id = p_group_id
      AND c.status = 'approved';

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Group not found or its church is not approved';
    END IF;

    IF v_profile_church_id IS NULL
       OR v_profile_church_id <> v_church_id THEN
        RAISE EXCEPTION 'You can only join groups in your own church';
    END IF;

    INSERT INTO public.group_members AS existing (group_id, user_id, status)
    VALUES (
        p_group_id,
        v_user_id,
        CASE WHEN v_allow_instant_join THEN 'approved' ELSE 'pending' END
    )
    ON CONFLICT (group_id, user_id)
    DO UPDATE SET status =
        CASE
            WHEN existing.status = 'approved'
                THEN 'approved'
            ELSE EXCLUDED.status
        END;

    SELECT gm.status
      INTO v_result
    FROM public.group_members AS gm
    WHERE gm.group_id = p_group_id
      AND gm.user_id = v_user_id;

    RETURN v_result;
END;
$function$;


-- ============================================================
-- 4. CHURCH MANAGER APPROVAL / REJECTION
-- ============================================================

CREATE OR REPLACE FUNCTION public.review_group_membership(
    p_group_id uuid,
    p_user_id uuid,
    p_decision text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_church_id uuid;
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication required';
    END IF;

    IF p_decision IS NULL OR p_decision NOT IN ('approved', 'rejected') THEN
        RAISE EXCEPTION 'Decision must be approved or rejected';
    END IF;

    SELECT g.church_id
      INTO v_church_id
    FROM public.groups AS g
    WHERE g.id = p_group_id;

    IF NOT FOUND
       OR NOT public.can_manage_church_content(v_church_id) THEN
        RAISE EXCEPTION 'You are not authorized to manage this group';
    END IF;

    UPDATE public.group_members AS gm
       SET status = p_decision
     WHERE gm.group_id = p_group_id
       AND gm.user_id = p_user_id
       AND gm.status = 'pending';

    RETURN FOUND;
END;
$function$;


-- ============================================================
-- 5. SAFE MEMBER ROSTER
-- Returns selected profile fields only.
-- Caller must be an approved member or authorized manager.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_group_member_roster(
    p_group_id uuid
)
RETURNS TABLE (
    user_id uuid,
    full_name text,
    display_name text,
    avatar_url text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_church_id uuid;
BEGIN
    SELECT g.church_id
      INTO v_church_id
    FROM public.groups AS g
    WHERE g.id = p_group_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Group not found';
    END IF;

    IF NOT public.is_approved_group_member(p_group_id)
       AND NOT public.can_manage_church_content(v_church_id) THEN
        RAISE EXCEPTION 'You are not authorized to view this group roster';
    END IF;

    RETURN QUERY
    SELECT
        p.id,
        p.full_name,
        p.display_name,
        p.avatar_url
    FROM public.group_members AS gm
    INNER JOIN public.profiles AS p
        ON p.id = gm.user_id
    WHERE gm.group_id = p_group_id
      AND gm.status = 'approved'
    ORDER BY COALESCE(p.display_name, p.full_name);
END;
$function$;


-- ============================================================
-- 5B. PENDING GROUP REQUESTS
-- Only authorized church managers can inspect applicants.
-- ============================================================

CREATE OR REPLACE FUNCTION public.get_pending_group_requests(
    p_group_id uuid
)
RETURNS TABLE (
    user_id uuid,
    full_name text,
    display_name text,
    avatar_url text,
    requested_at timestamptz
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_church_id uuid;
BEGIN
    SELECT g.church_id
      INTO v_church_id
    FROM public.groups AS g
    WHERE g.id = p_group_id;

    IF NOT FOUND
       OR NOT public.can_manage_church_content(v_church_id) THEN
        RAISE EXCEPTION 'You are not authorized to view pending requests';
    END IF;

    RETURN QUERY
    SELECT
        p.id,
        p.full_name,
        p.display_name,
        p.avatar_url,
        gm.created_at
    FROM public.group_members AS gm
    INNER JOIN public.profiles AS p
        ON p.id = gm.user_id
    WHERE gm.group_id = p_group_id
      AND gm.status = 'pending'
    ORDER BY gm.created_at ASC;
END;
$function$;

-- ============================================================
-- 6. GROUP TABLE RLS
-- Public group metadata is visible only for approved churches.
-- Management requires the existing church-management helper.
-- ============================================================

ALTER TABLE public.groups ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS groups_select_approved_church
    ON public.groups;
DROP POLICY IF EXISTS groups_insert_church_manager
    ON public.groups;
DROP POLICY IF EXISTS groups_update_church_manager
    ON public.groups;
DROP POLICY IF EXISTS groups_delete_church_manager
    ON public.groups;

CREATE POLICY groups_select_approved_church
ON public.groups
FOR SELECT
TO authenticated
USING (
    (
        EXISTS (
            SELECT 1
            FROM public.churches AS c
            WHERE c.id = groups.church_id
              AND c.status = 'approved'
        )
        AND EXISTS (
            SELECT 1
            FROM public.profiles AS p
            WHERE p.id = (SELECT auth.uid())
              AND p.church_id = groups.church_id
              AND p.status = 'active'
              AND COALESCE(p.is_blocked, false) = false
        )
    )
    OR public.can_manage_church_content(groups.church_id)
);

CREATE POLICY groups_insert_church_manager
ON public.groups
FOR INSERT
TO authenticated
WITH CHECK (
    public.can_manage_church_content(church_id)
    AND created_by = (SELECT auth.uid())
);

CREATE POLICY groups_update_church_manager
ON public.groups
FOR UPDATE
TO authenticated
USING (
    public.can_manage_church_content(church_id)
)
WITH CHECK (
    public.can_manage_church_content(church_id)
);

CREATE POLICY groups_delete_church_manager
ON public.groups
FOR DELETE
TO authenticated
USING (
    public.can_manage_church_content(church_id)
);


-- ============================================================
-- 7. GROUP MEMBERSHIP TABLE RLS
-- No direct client INSERT or UPDATE.
-- Joining and approval use the controlled RPCs above.
-- ============================================================

ALTER TABLE public.group_members ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS group_members_select_own
    ON public.group_members;
DROP POLICY IF EXISTS group_members_delete_own_or_manager
    ON public.group_members;

CREATE POLICY group_members_select_own
ON public.group_members
FOR SELECT
TO authenticated
USING (
    user_id = (SELECT auth.uid())
);

CREATE POLICY group_members_delete_own_or_manager
ON public.group_members
FOR DELETE
TO authenticated
USING (
    user_id = (SELECT auth.uid())
    OR EXISTS (
        SELECT 1
        FROM public.groups AS g
        WHERE g.id = group_members.group_id
          AND public.can_manage_church_content(g.church_id)
    )
);


-- ============================================================
-- 8. GROUP MESSAGE RLS
-- This migration deliberately does not authorize direct messages.
-- Direct-message policies require their own reviewed design.
-- ============================================================

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS group_messages_select_members
    ON public.messages;
DROP POLICY IF EXISTS group_messages_insert_members
    ON public.messages;

CREATE POLICY group_messages_select_members
ON public.messages
FOR SELECT
TO authenticated
USING (
    group_id IS NOT NULL
    AND (
        public.is_approved_group_member(group_id)
        OR EXISTS (
            SELECT 1
            FROM public.groups AS g
            WHERE g.id = messages.group_id
              AND public.can_manage_church_content(g.church_id)
        )
    )
);

CREATE POLICY group_messages_insert_members
ON public.messages
FOR INSERT
TO authenticated
WITH CHECK (
    group_id IS NOT NULL
    AND sender_id = (SELECT auth.uid())
    AND public.is_approved_group_member(group_id)
    AND EXISTS (
        SELECT 1
        FROM public.profiles AS p
        WHERE p.id = (SELECT auth.uid())
          AND p.status = 'active'
          AND COALESCE(p.is_blocked, false) = false
    )
);


-- ============================================================
-- 9. GROUP MESSAGE NOTIFICATIONS
-- The trigger inserts notifications as its trusted owner.
-- No client-side notification INSERT permission is granted.
-- ============================================================

CREATE OR REPLACE FUNCTION public.create_group_message_notification()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF NEW.group_id IS NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.notifications (
        user_id,
        title,
        message,
        type,
        is_read
    )
    SELECT
        gm.user_id,
        'New group message',
        'There is a new message in your group.',
        'group_message',
        false
    FROM public.group_members AS gm
    WHERE gm.group_id = NEW.group_id
      AND gm.status = 'approved'
      AND gm.user_id <> NEW.sender_id;

    RETURN NEW;
END;
$function$;

ALTER FUNCTION public.create_group_message_notification()
    OWNER TO postgres;

DROP TRIGGER IF EXISTS notify_group_message_members
    ON public.messages;

CREATE TRIGGER notify_group_message_members
AFTER INSERT ON public.messages
FOR EACH ROW
WHEN (NEW.group_id IS NOT NULL)
EXECUTE FUNCTION public.create_group_message_notification();


-- The existing direct-message notification trigger must not
-- create a null-recipient notification for group messages.
CREATE OR REPLACE FUNCTION public.create_notification_trigger()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO ''
AS $function$
BEGIN
    IF NEW.group_id IS NOT NULL THEN
        RETURN NEW;
    END IF;

    INSERT INTO public.notifications (
        user_id,
        message,
        type,
        is_read
    )
    VALUES (
        COALESCE(NEW.receiver_id, NEW.recipient_id),
        'You received a new message',
        'message',
        false
    );

    RETURN NEW;

EXCEPTION WHEN OTHERS THEN
    RETURN NEW;
END;
$function$;


-- ============================================================
-- 10. LEAST-PRIVILEGE GRANTS
-- ============================================================

REVOKE ALL ON TABLE public.groups
    FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE
    ON TABLE public.groups TO authenticated;
GRANT INSERT (name, church_id, location)
    ON TABLE public.groups TO authenticated;
GRANT UPDATE (
    name,
    location,
    meeting_time,
    leader_name,
    allow_instant_join
)
    ON TABLE public.groups TO authenticated;

REVOKE ALL ON TABLE public.group_members
    FROM PUBLIC, anon, authenticated;
GRANT SELECT, DELETE
    ON TABLE public.group_members TO authenticated;

REVOKE ALL ON TABLE public.messages
    FROM PUBLIC, anon, authenticated;
GRANT SELECT
    ON TABLE public.messages TO authenticated;
GRANT INSERT (sender_id, group_id, content)
    ON TABLE public.messages TO authenticated;

REVOKE ALL ON FUNCTION public.is_approved_group_member(uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.is_approved_group_member(uuid)
    TO authenticated;

REVOKE ALL ON FUNCTION public.join_group(uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.join_group(uuid)
    TO authenticated;

REVOKE ALL ON FUNCTION public.review_group_membership(uuid, uuid, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_group_membership(uuid, uuid, text)
    TO authenticated;

REVOKE ALL ON FUNCTION public.get_group_member_roster(uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_group_member_roster(uuid)
    TO authenticated;

REVOKE ALL ON FUNCTION public.create_group_message_notification()
    FROM PUBLIC, anon, authenticated;

REVOKE ALL ON FUNCTION public.get_pending_group_requests(uuid)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_pending_group_requests(uuid)
    TO authenticated;
COMMIT;
