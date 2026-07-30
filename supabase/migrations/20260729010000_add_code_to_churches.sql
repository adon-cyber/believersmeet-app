-- Add code column to churches table
ALTER TABLE public.churches ADD COLUMN IF NOT EXISTS code TEXT UNIQUE;
