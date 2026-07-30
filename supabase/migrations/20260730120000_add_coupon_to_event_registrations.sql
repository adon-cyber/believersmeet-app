-- Create migration to add coupon and payment fields to event_registrations table
ALTER TABLE public.event_registrations 
ADD COLUMN IF NOT EXISTS coupon_number text UNIQUE,
ADD COLUMN IF NOT EXISTS amount_paid numeric(10,2) DEFAULT 0.00,
ADD COLUMN IF NOT EXISTS is_free boolean DEFAULT false,
ADD COLUMN IF NOT EXISTS attendee_name text,
ADD COLUMN IF NOT EXISTS attendee_email text;

-- Create index on coupon_number for fast lookup
CREATE INDEX IF NOT EXISTS idx_event_registrations_coupon ON public.event_registrations(coupon_number);
