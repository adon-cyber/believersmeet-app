-- BelieversMeet Staging: secure prayer requests and responses
-- REVIEW DRAFT ONLY. Do not run until the accompanying frontend changes are reviewed.
-- Scope: same approved church; private requests visible only to owner / authorised church admin.

BEGIN;

-- Public visitor requests should be prayer requests, not testimonies, by default.
ALTER TABLE public.prayer_requests
    ALTER COLUMN is_testimony SET DEFAULT false;
ALTER TABLE public.prayer_requests
    ALTER COLUMN status SET DEFAULT 'pending';

-- Remove broad/default application-role table privileges before adding narrow grants.
REVOKE ALL ON TABLE public.prayer_requests FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.prayer_responses FROM PUBLIC, anon, authenticated;

-- Authenticated users can read only non-contact prayer fields.
GRANT SELECT (
    id,
    user_id,
    church_id,
    content,
    created_at,
    prayers_count,
    is_private,
    is_testimony,
    title,
    request_text,
    message,
    prayer_request,
    details,
    description,
    full_name,
    name,
    status
) ON TABLE public.prayer_requests TO authenticated;

-- Members can create their own prayer requests / testimonies.
GRANT INSERT (
    user_id,
    church_id,
    content,
    is_private,
    is_testimony,
    title,
    status
) ON TABLE public.prayer_requests TO authenticated;

-- A request owner can only change the testimony flag (mark as answered).
GRANT UPDATE (is_testimony) ON TABLE public.prayer_requests TO authenticated;

-- Public visitors can submit only the limited fields used by the public church form.
-- They cannot set user_id, status, is_private, or is_testimony.
GRANT INSERT (
    church_id,
    full_name,
    contact_info,
    prayer_request
) ON TABLE public.prayer_requests TO anon;

-- Responses expose no guest contact fields.
GRANT SELECT (
    id,
    prayer_request_id,
    user_id,
    response_text,
    created_at,
    parent_id
) ON TABLE public.prayer_responses TO authenticated;

GRANT INSERT (
    prayer_request_id,
    user_id,
    response_text,
    parent_id
) ON TABLE public.prayer_responses TO authenticated;

-- Backend service role retains administrative access for trusted server-side operations.
GRANT ALL ON TABLE public.prayer_requests TO service_role;
GRANT ALL ON TABLE public.prayer_responses TO service_role;

ALTER TABLE public.prayer_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.prayer_responses ENABLE ROW LEVEL SECURITY;

-- Remove only these migration-owned policy names to keep reruns predictable.
DROP POLICY IF EXISTS prayer_requests_scoped_select ON public.prayer_requests;
DROP POLICY IF EXISTS prayer_requests_member_insert ON public.prayer_requests;
DROP POLICY IF EXISTS prayer_requests_owner_mark_answered ON public.prayer_requests;
DROP POLICY IF EXISTS prayer_requests_anon_public_insert ON public.prayer_requests;
DROP POLICY IF EXISTS prayer_responses_parent_scoped_select ON public.prayer_responses;
DROP POLICY IF EXISTS prayer_responses_member_insert ON public.prayer_responses;

-- A member can see their own rows, including private/pending ones.
-- Church admins / platform admins can see rows for churches they are authorised to manage.
-- Other members see only non-private, approved requests in their own approved church.
CREATE POLICY prayer_requests_scoped_select
ON public.prayer_requests
FOR SELECT
TO authenticated
USING (
    user_id = (SELECT auth.uid())
    OR (
        church_id IS NOT NULL
        AND public.can_manage_church_content(church_id)
    )
    OR (
        church_id IS NOT NULL
        AND COALESCE(is_private, false) = false
        AND status IN ('approved', 'contacted')
        AND public.can_access_feed_church(church_id::text)
    )
);

-- Members may create their own church-linked prayer requests (pending),
-- or testimonies (approved immediately, matching the existing testimony UX).
CREATE POLICY prayer_requests_member_insert
ON public.prayer_requests
FOR INSERT
TO authenticated
WITH CHECK (
    user_id = (SELECT auth.uid())
    AND church_id IS NOT NULL
    AND church_id = public.current_user_church_id()
    AND public.can_access_feed_church(church_id::text)
    AND (
        (COALESCE(is_testimony, false) = false AND status = 'pending')
        OR (is_testimony IS TRUE AND status = 'approved')
    )
);

-- The owner may mark their own prayer request as a testimony/answered prayer.
-- Column-level UPDATE permission prevents changing owner, church, content, or status.
CREATE POLICY prayer_requests_owner_mark_answered
ON public.prayer_requests
FOR UPDATE
TO authenticated
USING (
    user_id = (SELECT auth.uid())
    AND COALESCE(is_testimony, false) = false
)
WITH CHECK (
    user_id = (SELECT auth.uid())
    AND is_testimony IS TRUE
);

-- Anonymous public-church submissions are restricted to approved churches and
-- are always private to the moderation queue until approved by that church.
CREATE POLICY prayer_requests_anon_public_insert
ON public.prayer_requests
FOR INSERT
TO anon
WITH CHECK (
    user_id IS NULL
    AND church_id IS NOT NULL
    AND public.is_approved_public_church(church_id)
    AND COALESCE(is_private, false) = false
    AND COALESCE(is_testimony, false) = false
    AND status = 'pending'
    AND NULLIF(btrim(COALESCE(full_name, '')), '') IS NOT NULL
    AND NULLIF(btrim(COALESCE(prayer_request, '')), '') IS NOT NULL
);

-- A response is visible only when its parent prayer request is visible.
CREATE POLICY prayer_responses_parent_scoped_select
ON public.prayer_responses
FOR SELECT
TO authenticated
USING (
    EXISTS (
        SELECT 1
        FROM public.prayer_requests AS pr
        WHERE pr.id = prayer_responses.prayer_request_id
    )
);

-- Authenticated members can respond only as themselves and only to a visible
-- parent request. Threaded replies must belong to the same prayer request.
CREATE POLICY prayer_responses_member_insert
ON public.prayer_responses
FOR INSERT
TO authenticated
WITH CHECK (
    user_id = (SELECT auth.uid())
    AND EXISTS (
        SELECT 1
        FROM public.prayer_requests AS pr
        WHERE pr.id = prayer_responses.prayer_request_id
    )
    AND (
        prayer_responses.parent_id IS NULL
        OR EXISTS (
            SELECT 1
            FROM public.prayer_responses AS parent_response
            WHERE parent_response.id = prayer_responses.parent_id
              AND parent_response.prayer_request_id = prayer_responses.prayer_request_id
        )
    )
);

-- Admin-only moderation RPC. Contact details are returned here, never through
-- ordinary member SELECT permissions on prayer_requests.
CREATE OR REPLACE FUNCTION public.get_church_prayer_moderation(p_church_id uuid)
RETURNS TABLE (
    id uuid,
    created_at timestamp with time zone,
    full_name text,
    email text,
    phone text,
    contact_info text,
    content text,
    prayer_request text,
    request_text text,
    message text,
    details text,
    status text,
    is_private boolean,
    is_testimony boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF p_church_id IS NULL
       OR NOT public.can_manage_church_content(p_church_id) THEN
        RAISE EXCEPTION 'Not authorised to manage prayer requests for this church'
            USING ERRCODE = '42501';
    END IF;

    RETURN QUERY
    SELECT
        pr.id,
        pr.created_at,
        COALESCE(
            NULLIF(pr.full_name, ''),
            NULLIF(pr.name, ''),
            prof.full_name,
            'Anonymous Guest'
        )::text,
        pr.email,
        pr.phone,
        pr.contact_info,
        pr.content,
        pr.prayer_request,
        pr.request_text,
        pr.message,
        pr.details,
        pr.status,
        pr.is_private,
        pr.is_testimony
    FROM public.prayer_requests AS pr
    LEFT JOIN public.profiles AS prof
        ON prof.id = pr.user_id
    WHERE pr.church_id = p_church_id
      AND (
          pr.status = 'pending'
          OR pr.status IS NULL
          OR pr.status = ''
      )
    ORDER BY pr.created_at DESC NULLS LAST;
END;
$function$;

-- Admin-only status update RPC. The caller cannot choose another church's row.
CREATE OR REPLACE FUNCTION public.update_church_prayer_request_status(
    p_request_id uuid,
    p_new_status text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_church_id uuid;
BEGIN
    IF p_new_status IS NULL
       OR p_new_status NOT IN ('approved', 'rejected', 'contacted') THEN
        RAISE EXCEPTION 'Invalid prayer request status'
            USING ERRCODE = '22023';
    END IF;

    SELECT pr.church_id
      INTO v_church_id
      FROM public.prayer_requests AS pr
     WHERE pr.id = p_request_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Prayer request not found'
            USING ERRCODE = 'P0002';
    END IF;

    IF v_church_id IS NULL
       OR NOT public.can_manage_church_content(v_church_id) THEN
        RAISE EXCEPTION 'Not authorised to moderate this prayer request'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.prayer_requests
       SET status = p_new_status
     WHERE id = p_request_id;
END;
$function$;

-- Small admin notification RPC; it returns no guest contact details.
CREATE OR REPLACE FUNCTION public.get_church_pending_prayer_notifications()
RETURNS TABLE (
    id uuid,
    full_name text,
    created_at timestamp with time zone
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_church_id uuid;
BEGIN
    v_church_id := public.current_user_church_id();

    IF v_church_id IS NULL
       OR NOT public.can_manage_church_content(v_church_id) THEN
        RETURN;
    END IF;

    RETURN QUERY
    SELECT
        pr.id,
        COALESCE(
            NULLIF(pr.full_name, ''),
            NULLIF(pr.name, ''),
            prof.full_name,
            'Someone'
        )::text,
        pr.created_at
    FROM public.prayer_requests AS pr
    LEFT JOIN public.profiles AS prof
        ON prof.id = pr.user_id
    WHERE pr.church_id = v_church_id
      AND (
          pr.status = 'pending'
          OR pr.status IS NULL
          OR pr.status = ''
      )
    ORDER BY pr.created_at DESC NULLS LAST
    LIMIT 5;
END;
$function$;

-- SECURITY DEFINER RPCs are executable only by authenticated users;
-- each function performs its own church-specific authorisation check.
REVOKE ALL ON FUNCTION public.get_church_prayer_moderation(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_church_prayer_moderation(uuid) TO authenticated;

REVOKE ALL ON FUNCTION public.update_church_prayer_request_status(uuid, text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.update_church_prayer_request_status(uuid, text) TO authenticated;

REVOKE ALL ON FUNCTION public.get_church_pending_prayer_notifications() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_church_pending_prayer_notifications() TO authenticated;

-- Support church moderation and parent-response lookups.
CREATE INDEX IF NOT EXISTS prayer_requests_church_status_created_idx
    ON public.prayer_requests (church_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS prayer_responses_request_created_idx
    ON public.prayer_responses (prayer_request_id, created_at);

COMMIT;
