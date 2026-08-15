-- Add pesapal columns to donations table
alter table public.donations 
    add column if not exists pesapal_tracking_id text,
    add column if not exists currency text default 'KES',
    add column if not exists email text,
    add column if not exists description text;

-- Create index on pesapal_tracking_id for fast IPN lookup
create index if not exists idx_donations_pesapal_tracking_id on public.donations(pesapal_tracking_id);
