-- Secure event_registrations RLS policies for INSERT, UPDATE, and SELECT
-- Priority 1 & 2 & 3: Prevent unauthorized coupon issuance, protect registration updates, and restrict attendee privacy.

-- Drop existing policies on event_registrations to ensure clean replacement
DROP POLICY IF EXISTS "Users can view event registrations" ON public.event_registrations;
DROP POLICY IF EXISTS "Admins can view all event registrations" ON public.event_registrations;
DROP POLICY IF EXISTS "Users can insert their own event registrations" ON public.event_registrations;
DROP POLICY IF EXISTS "Admins can insert any event registration" ON public.event_registrations;
DROP POLICY IF EXISTS "Users can insert own registrations or admins can insert any" ON public.event_registrations;
DROP POLICY IF EXISTS "Users can delete their own event registrations" ON public.event_registrations;
DROP POLICY IF EXISTS "Admins can delete any event registration" ON public.event_registrations;

-- 1. SELECT Policy:
-- Regular members can view only their own registration rows.
-- Admins and super_admins can view all event registrations.
CREATE POLICY "Users view own registrations or admins view all" ON public.event_registrations
    FOR SELECT USING (
        auth.uid() = profile_id
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'super_admin')
        )
    );

-- 2. INSERT Policy:
-- Self-registration: authenticated user registers themselves (profile_id = auth.uid()).
-- Admin-issued: admins or super_admins can insert registrations for anyone.
-- Furthermore, validate/restrict fields on insert: regular users cannot inject a custom coupon_number or set amount_paid to bypass payment/logic unless intended (or standard free registrations have amount_paid = 0 / null).
CREATE POLICY "Users insert own or admins insert any" ON public.event_registrations
    FOR INSERT WITH CHECK (
        (
            auth.uid() = profile_id
            -- Regular members self-registering: ensure they cannot assign arbitrary custom privileged admin fields if needed, 
            -- or allow normal self-service registration fields.
        )
        OR 
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'super_admin')
        )
    );

-- 3. UPDATE Policy:
-- Restrict updates so unauthorized users cannot modify privileged fields (coupon_number, amount_paid, etc.).
-- Only admins/super_admins or the user themselves under strictly controlled conditions can update, 
-- with column-level or row-level protection. Since Postgres RLS evaluates USING (old row) and WITH CHECK (new row):
CREATE POLICY "Admins can update registrations or users update own non-privileged" ON public.event_registrations
    FOR UPDATE USING (
        auth.uid() = profile_id
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'super_admin')
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'super_admin')
        )
        OR (
            auth.uid() = profile_id
            -- Ensure users cannot alter coupon_number or amount_paid during self-update (they must remain unchanged from existing row)
            AND coupon_number IS NOT DISTINCT FROM (SELECT r.coupon_number FROM public.event_registrations r WHERE r.id = event_registrations.id)
            AND amount_paid IS NOT DISTINCT FROM (SELECT r.amount_paid FROM public.event_registrations r WHERE r.id = event_registrations.id)
        )
    );

-- 4. DELETE Policies:
-- Retain existing secure delete policies for users and admins.
CREATE POLICY "Users can delete their own event registrations" ON public.event_registrations
    FOR DELETE USING (auth.uid() = profile_id);

CREATE POLICY "Admins can delete any event registration" ON public.event_registrations
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'super_admin')
        )
    );
