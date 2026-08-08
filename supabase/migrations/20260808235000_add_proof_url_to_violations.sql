-- Add proof_url column to violations table if not exists
alter table public.violations add column if not exists proof_url text;
