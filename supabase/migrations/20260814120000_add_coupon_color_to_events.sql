-- Add coupon_color column to events table
ALTER TABLE public.events ADD COLUMN IF NOT EXISTS coupon_color text DEFAULT '#2563eb';
