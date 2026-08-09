-- Ensure foreign keys exist with explicit names for violations and profiles
ALTER TABLE public.violations 
  DROP CONSTRAINT IF EXISTS fk_reporter,
  DROP CONSTRAINT IF EXISTS fk_reported_user;

ALTER TABLE public.violations
  ADD CONSTRAINT fk_reporter FOREIGN KEY (reporter_id) REFERENCES public.profiles(id) ON DELETE SET NULL,
  ADD CONSTRAINT fk_reported_user FOREIGN KEY (reported_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;

-- Force PostgREST to reload the schema cache
NOTIFY pgrst, 'reload schema';
