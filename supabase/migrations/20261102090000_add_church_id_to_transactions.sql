
BEGIN;

-- Add the receiving church to every transaction.
ALTER TABLE public.transactions
ADD COLUMN IF NOT EXISTS church_id uuid;

-- Stop safely if existing records cannot be assigned.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM public.transactions
        WHERE church_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Transactions contain records without church_id. Migration stopped.';
    END IF;

    -- Establish the church relationship.
    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.transactions'::regclass
          AND conname = 'transactions_church_id_fkey'
    ) THEN
        ALTER TABLE public.transactions
        ADD CONSTRAINT transactions_church_id_fkey
        FOREIGN KEY (church_id)
        REFERENCES public.churches(id)
        ON DELETE RESTRICT;
    END IF;
END $$;

-- Every new financial transaction must belong to a church.
ALTER TABLE public.transactions
ALTER COLUMN church_id SET NOT NULL;

-- Support efficient church-specific financial reporting.
CREATE INDEX IF NOT EXISTS
idx_transactions_church_id_created_at
ON public.transactions (church_id, created_at DESC);

COMMIT;
