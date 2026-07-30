-- Make location column optional in public.groups table
ALTER TABLE public.groups ALTER COLUMN location DROP NOT NULL;
