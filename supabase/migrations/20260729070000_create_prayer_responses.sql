-- Create prayer_responses table for responses to prayer requests
CREATE TABLE IF NOT EXISTS public.prayer_responses (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    prayer_request_id uuid REFERENCES public.prayer_requests(id) ON DELETE CASCADE NOT NULL,
    user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE NOT NULL,
    response_text text NOT NULL
);

-- Enable RLS on prayer_responses
ALTER TABLE public.prayer_responses ENABLE ROW LEVEL SECURITY;

-- Policies for prayer_responses
CREATE POLICY "Authenticated users can view prayer responses." ON public.prayer_responses 
    FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "Authenticated users can create prayer responses." ON public.prayer_responses 
    FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own prayer responses." ON public.prayer_responses 
    FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete their own prayer responses." ON public.prayer_responses 
    FOR DELETE USING (auth.uid() = user_id);
