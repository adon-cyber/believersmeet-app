-- Add dynamic church location and schedule columns to the profiles table
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS sunday_service_time TEXT,
    ADD COLUMN IF NOT EXISTS midweek_service_time TEXT,
    ADD COLUMN IF NOT EXISTS physical_address TEXT,
    ADD COLUMN IF NOT EXISTS map_embed_url TEXT;
