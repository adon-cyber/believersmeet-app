-- Add invited_church_ids array and host_church_id alias/column if needed to public.events
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS invited_church_ids uuid[] DEFAULT '{}'::uuid[];

-- Ensure host_church_id is present or alias church_id if required. The user prompt mentions:
-- "updates the invited_church_ids array in the events table for a specific event."
-- "filters events based on the logged-in user's church_id against the event's host_church_id and invited_church_ids array."
-- Let's add host_church_id column (or generate/sync it with church_id) to be fully robust and clear.
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS host_church_id uuid REFERENCES public.churches(id) ON DELETE CASCADE;

-- Backfill host_church_id from church_id if it's null
UPDATE public.events SET host_church_id = church_id WHERE host_church_id IS NULL;
