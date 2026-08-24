-- Add live stream configuration columns to churches table
ALTER TABLE public.churches
    ADD COLUMN IF NOT EXISTS live_stream_id TEXT,
    ADD COLUMN IF NOT EXISTS is_live BOOLEAN DEFAULT FALSE;
