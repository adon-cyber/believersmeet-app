-- Migration: create public.church_directory view safely
CREATE OR REPLACE VIEW public.church_directory AS
SELECT 
    id,
    name,
    code,
    join_code,
    location,
    address,
    physical_address,
    description,
    logo_url,
    service_times,
    bank_name,
    account_name,
    account_number,
    momo_provider,
    momo_number,
    momo_registered_name,
    pesapal_payment_link,
    pesapal_link,
    live_stream_id,
    is_live,
    status,
    subscription_status,
    created_at
FROM public.churches
WHERE coalesce(status, subscription_status, 'approved') = 'approved';

-- Grant select on view to anon and authenticated roles
GRANT SELECT ON public.church_directory TO anon, authenticated;
