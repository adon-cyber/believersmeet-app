-- Add photo_url column to event_registrations table
ALTER TABLE public.event_registrations 
ADD COLUMN IF NOT EXISTS photo_url text;
