-- Add department column to messages table if not exists and update RLS policies for finance department access

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS department TEXT DEFAULT 'general';

-- Update RLS policies on messages table to ensure finance / admin roles can select and insert finance messages
DROP POLICY IF EXISTS "Enable read access for message participants" ON public.messages;
DROP POLICY IF EXISTS "Enable insert access for authenticated users" ON public.messages;

CREATE POLICY "Enable read access for message participants and finance" ON public.messages
    FOR SELECT
    USING (
        auth.uid() = sender_id OR 
        auth.uid() = receiver_id OR 
        auth.uid() = recipient_id OR
        (
            department = 'finance' AND 
            EXISTS (
                SELECT 1 FROM public.profiles 
                WHERE profiles.id = auth.uid() 
                AND (profiles.role = 'finance' OR profiles.role = 'admin' OR profiles.role = 'super_admin')
            )
        )
    );

CREATE POLICY "Enable insert access for authenticated users" ON public.messages
    FOR INSERT
    WITH CHECK (auth.uid() = sender_id);

CREATE POLICY "Enable update access for message participants" ON public.messages
    FOR UPDATE
    USING (auth.uid() = receiver_id OR auth.uid() = recipient_id OR auth.uid() = sender_id);
