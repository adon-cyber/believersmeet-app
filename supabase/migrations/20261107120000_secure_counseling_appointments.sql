-- BelieversMeet Staging
-- Secure counseling requests and restrict administration to the
-- active, unblocked church administrator of the request owner's church.
--
-- Members: insert their own Pending requests and view their own requests.
-- Church admins: view requests from their own approved church and update
--                 only the status to Approved or Declined.
-- Super Admin: no cross-user counseling access.
-- Anonymous and service_role: no direct table privileges.

CREATE OR REPLACE FUNCTION private.can_church_admin_manage_counseling(
    p_member_user_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT
        p_member_user_id IS NOT NULL
        AND auth.uid() IS NOT NULL
        AND EXISTS (
            SELECT 1
            FROM public.profiles AS admin_profile
            INNER JOIN public.churches AS admin_church
                ON admin_church.id = admin_profile.church_id
            INNER JOIN public.profiles AS member_profile
                ON member_profile.id = p_member_user_id
            WHERE admin_profile.id = auth.uid()
              AND admin_profile.role = 'church_admin'
              AND admin_profile.status = 'active'
              AND COALESCE(admin_profile.is_blocked, false) = false
              AND admin_profile.church_id IS NOT NULL
              AND admin_church.status = 'approved'
              AND member_profile.church_id = admin_profile.church_id
        );
$function$;
REVOKE ALL ON FUNCTION
    private.can_church_admin_manage_counseling(uuid)
FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION
    private.can_church_admin_manage_counseling(uuid)
TO authenticated;
ALTER TABLE public.counseling_appointments
    ENABLE ROW LEVEL SECURITY;
-- Remove the original broad policies and any previous versions of
-- the narrowly scoped policies so this migration is repeatable.
DROP POLICY IF EXISTS
    "Users can insert their own counseling appointments"
ON public.counseling_appointments;
DROP POLICY IF EXISTS
    "Users can view their own counseling appointments"
ON public.counseling_appointments;
DROP POLICY IF EXISTS
    "Admins can view all counseling appointments"
ON public.counseling_appointments;
DROP POLICY IF EXISTS
    "Admins can update counseling appointments status"
ON public.counseling_appointments;
DROP POLICY IF EXISTS counseling_appointments_select_own
ON public.counseling_appointments;
DROP POLICY IF EXISTS counseling_appointments_insert_own_pending
ON public.counseling_appointments;
DROP POLICY IF EXISTS counseling_appointments_church_admin_select
ON public.counseling_appointments;
DROP POLICY IF EXISTS counseling_appointments_church_admin_update_status
ON public.counseling_appointments;
-- Members can read only their own requests.
CREATE POLICY counseling_appointments_select_own
ON public.counseling_appointments
FOR SELECT
TO authenticated
USING (
    user_id = (SELECT auth.uid())
);
-- Members can submit only their own requests, initially Pending.
CREATE POLICY counseling_appointments_insert_own_pending
ON public.counseling_appointments
FOR INSERT
TO authenticated
WITH CHECK (
    user_id = (SELECT auth.uid())
    AND status = 'Pending'
);
-- Church admins can read requests belonging to members of their church.
CREATE POLICY counseling_appointments_church_admin_select
ON public.counseling_appointments
FOR SELECT
TO authenticated
USING (
    private.can_church_admin_manage_counseling(user_id)
);
-- Church admins can change status only for requests in their own church.
CREATE POLICY counseling_appointments_church_admin_update_status
ON public.counseling_appointments
FOR UPDATE
TO authenticated
USING (
    private.can_church_admin_manage_counseling(user_id)
)
WITH CHECK (
    private.can_church_admin_manage_counseling(user_id)
    AND status IN ('Approved', 'Declined')
);
-- Reset table-level privileges.
REVOKE ALL PRIVILEGES ON TABLE public.counseling_appointments
FROM PUBLIC, anon, authenticated, service_role;
-- Also remove any prior column-level privileges.
REVOKE SELECT (
    id, user_id, member_name, member_email,
    appointment_date, appointment_time, reason, status, created_at
)
ON TABLE public.counseling_appointments
FROM PUBLIC, anon, authenticated, service_role;
REVOKE INSERT (
    id, user_id, member_name, member_email,
    appointment_date, appointment_time, reason, status, created_at
)
ON TABLE public.counseling_appointments
FROM PUBLIC, anon, authenticated, service_role;
REVOKE UPDATE (
    id, user_id, member_name, member_email,
    appointment_date, appointment_time, reason, status, created_at
)
ON TABLE public.counseling_appointments
FROM PUBLIC, anon, authenticated, service_role;
REVOKE REFERENCES (
    id, user_id, member_name, member_email,
    appointment_date, appointment_time, reason, status, created_at
)
ON TABLE public.counseling_appointments
FROM PUBLIC, anon, authenticated, service_role;
-- Members and church admins need SELECT; authenticated members need INSERT.
GRANT SELECT, INSERT
ON TABLE public.counseling_appointments
TO authenticated;
-- Only the status column may be updated by authenticated users.
GRANT UPDATE (status)
ON TABLE public.counseling_appointments
TO authenticated;
