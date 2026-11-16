BEGIN;

ALTER TABLE public.churches
DROP CONSTRAINT IF EXISTS churches_country_currency_match_check;

ALTER TABLE public.churches
ADD CONSTRAINT churches_country_currency_match_check
CHECK (
    billing_currency IS NOT NULL
    AND CASE
        WHEN country_code IS NULL
            THEN billing_currency = 'UGX'
        WHEN country_code = 'UG'
            THEN billing_currency = 'UGX'
        WHEN country_code = 'KE'
            THEN billing_currency = 'KES'
        WHEN country_code = 'TZ'
            THEN billing_currency = 'TZS'
        ELSE
            country_code ~ '^[A-Z]{2}$'
            AND billing_currency = 'USD'
    END
);

COMMIT;