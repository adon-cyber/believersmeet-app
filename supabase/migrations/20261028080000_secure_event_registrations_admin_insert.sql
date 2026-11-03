-- Add secure server-side admin check for inserting event registrations & coupons
DROP POLICY IF EXISTS "Admins can insert any event registration" ON public.event_registrations;
DROP POLICY IF EXISTS "Users can insert their own event registrations" ON public.event_registrations;

-- Allow users to register themselves, OR admins/super_admins to issue registrations/coupons for anyone
CREATE POLICY "Users can insert own registrations or admins can insert any" ON public.event_registrations
    FOR INSERT WITH CHECK (
        auth.uid() = profile_id
        OR EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'super_admin')
        )
    );
