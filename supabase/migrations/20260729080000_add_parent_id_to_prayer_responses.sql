-- Add parent_id column to prayer_responses table for threaded replies
ALTER TABLE public.prayer_responses ADD COLUMN IF NOT EXISTS parent_id uuid REFERENCES public.prayer_responses(id) ON DELETE CASCADE;
