-- Add logo_url column to churches table
ALTER TABLE public.churches ADD COLUMN IF NOT EXISTS logo_url text;
