-- Update event RLS policies and functions to allow both 'admin' and 'super_admin' role tiers from profiles table

-- Drop existing event update/delete/insert policies if any
DROP POLICY IF EXISTS "Creator or church admin can update event." ON public.events;
DROP POLICY IF EXISTS "Creator or church admin can delete event." ON public.events;
DROP POLICY IF EXISTS "Users can create events for their church." ON public.events;

-- Create helper or inline policy checks supporting profiles role = 'admin' or 'super_admin'
CREATE POLICY "Admins and super_admins can create events" ON public.events
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'super_admin')
        )
    );

CREATE POLICY "Admins, super_admins, and creators can update events" ON public.events
    FOR UPDATE USING (
        auth.uid() = created_by OR
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'super_admin')
        )
    );

CREATE POLICY "Admins, super_admins, and creators can delete events" ON public.events
    FOR DELETE USING (
        auth.uid() = created_by OR
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'super_admin')
        )
    );

-- Also ensure event_invitations or similar tables permit admin/super_admin actions if needed
DO $$ 
BEGIN
    IF NOT EXISTS (SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'event_invitations') THEN
        CREATE TABLE public.event_invitations (
            id uuid DEFAULT public.gen_random_uuid() NOT NULL PRIMARY KEY,
            event_id uuid REFERENCES public.events(id) ON DELETE CASCADE NOT NULL,
            member_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
            created_at timestamp with time zone DEFAULT now()
        );
        ALTER TABLE public.event_invitations ENABLE ROW LEVEL SECURITY;
    END IF;
END $$;

DROP POLICY IF EXISTS "Authenticated users can view event invitations." ON public.event_invitations;
DROP POLICY IF EXISTS "Admins and super_admins can insert event invitations." ON public.event_invitations;

CREATE POLICY "Authenticated users can view event invitations." ON public.event_invitations
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Admins and super_admins can insert event invitations." ON public.event_invitations
    FOR INSERT WITH CHECK (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'super_admin')
        )
    );
