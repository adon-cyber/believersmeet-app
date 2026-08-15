-- Add Pesapal multi-tenant settings columns to churches table
ALTER TABLE public.churches
    ADD COLUMN IF NOT EXISTS pesapal_consumer_key TEXT,
    ADD COLUMN IF NOT EXISTS pesapal_consumer_secret TEXT,
    ADD COLUMN IF NOT EXISTS pesapal_ipn_id TEXT,
    ADD COLUMN IF NOT EXISTS pesapal_env TEXT DEFAULT 'sandbox';
