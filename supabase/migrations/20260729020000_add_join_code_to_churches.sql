-- Add join_code column to churches table
ALTER TABLE public.churches ADD COLUMN IF NOT EXISTS join_code TEXT UNIQUE;
