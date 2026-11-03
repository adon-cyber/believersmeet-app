BEGIN;

ALTER TABLE public.transactions
ADD COLUMN IF NOT EXISTS payer_country text;

DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.transactions'::regclass
          AND conname = 'transactions_payer_country_format_check'
    ) THEN
        ALTER TABLE public.transactions
        ADD CONSTRAINT transactions_payer_country_format_check
        CHECK (
            payer_country IS NULL
            OR payer_country ~ '^[A-Z]{2}$'
        );
    END IF;
END $$;

COMMIT;
