-- Create migration for event_registrations RLS policies (user delete and admin delete)
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT FROM pg_tables WHERE schemaname = 'public' AND tablename = 'event_registrations'
    ) THEN
        CREATE TABLE public.event_registrations (
            id uuid DEFAULT public.gen_random_uuid() NOT NULL PRIMARY KEY,
            event_id uuid REFERENCES public.events(id) ON DELETE CASCADE NOT NULL,
            profile_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
            created_at timestamp with time zone DEFAULT now()
        );
    END IF;
END $$;

ALTER TABLE public.event_registrations ENABLE ROW LEVEL SECURITY;

-- Drop existing policies on event_registrations if any to prevent duplicates
DROP POLICY IF EXISTS "Users can view event registrations" ON public.event_registrations;
DROP POLICY IF EXISTS "Users can insert their own event registrations" ON public.event_registrations;
DROP POLICY IF EXISTS "Users can delete their own event registrations" ON public.event_registrations;
DROP POLICY IF EXISTS "Admins can delete any event registration" ON public.event_registrations;

-- SELECT policy
CREATE POLICY "Users can view event registrations" ON public.event_registrations
    FOR SELECT USING (auth.role() = 'authenticated');

-- INSERT policy
CREATE POLICY "Users can insert their own event registrations" ON public.event_registrations
    FOR INSERT WITH CHECK (auth.uid() = profile_id);

-- DELETE policy for users (opting out)
CREATE POLICY "Users can delete their own event registrations" ON public.event_registrations
    FOR DELETE USING (auth.uid() = profile_id);

-- DELETE policy for admins and super_admins
CREATE POLICY "Admins can delete any event registration" ON public.event_registrations
    FOR DELETE USING (
        EXISTS (
            SELECT 1 FROM public.profiles
            WHERE profiles.id = auth.uid()
            AND profiles.role IN ('admin', 'super_admin')
        )
    );
