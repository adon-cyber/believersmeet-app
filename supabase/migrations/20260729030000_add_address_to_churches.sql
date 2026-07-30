-- Add address column to churches table
ALTER TABLE public.churches ADD COLUMN IF NOT EXISTS address TEXT;
