BEGIN;

ALTER TABLE public.conversion_requests ENABLE ROW LEVEL SECURITY;

-- Remove obsolete or previously named policies.
DROP POLICY IF EXISTS "Anyone can insert conversion requests." ON public.conversion_requests;
DROP POLICY IF EXISTS "Church admins can view conversion requests for their church." ON public.conversion_requests;
DROP POLICY IF EXISTS "Church admins can update conversion requests for their church." ON public.conversion_requests;
DROP POLICY IF EXISTS conversion_requests_public_insert ON public.conversion_requests;
DROP POLICY IF EXISTS conversion_requests_church_admin_select ON public.conversion_requests;
DROP POLICY IF EXISTS conversion_requests_church_admin_update ON public.conversion_requests;

-- Public submission: approved churches only, with consent and pending status.
CREATE POLICY conversion_requests_public_insert
ON public.conversion_requests
FOR INSERT
TO anon, authenticated
WITH CHECK (
    church_id IS NOT NULL
    AND public.is_approved_public_church(church_id)
    AND consent_given IS TRUE
    AND status = 'pending'
);

-- Church Admins see only their own church; Super Admins retain global access.
CREATE POLICY conversion_requests_church_admin_select
ON public.conversion_requests
FOR SELECT
TO authenticated
USING (
    public.can_manage_church_content(church_id)
);

-- Status changes must remain within an authorized church.
CREATE POLICY conversion_requests_church_admin_update
ON public.conversion_requests
FOR UPDATE
TO authenticated
USING (
    public.can_manage_church_content(church_id)
)
WITH CHECK (
    public.can_manage_church_content(church_id)
);

-- Remove broad privileges and grant only the operations needed.
REVOKE ALL PRIVILEGES ON TABLE public.conversion_requests
FROM PUBLIC, anon, authenticated;

GRANT INSERT (
    church_id,
    full_name,
    phone_number,
    email,
    prayer_request,
    category,
    contact_method,
    contact_detail,
    consent_given,
    consent_timestamp,
    status
)
ON public.conversion_requests TO anon, authenticated;

GRANT SELECT
ON public.conversion_requests TO authenticated;

GRANT UPDATE (status)
ON public.conversion_requests TO authenticated;

COMMIT;
