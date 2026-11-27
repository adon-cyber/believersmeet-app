-- ============================================================
-- BELIEVERSMEET STAGING RLS - SECTION 03
-- RSVP privacy, ownership and integrity
--
-- TARGET:
--   public.rsvps
--
-- DRAFT ONLY. DO NOT EXECUTE YET.
-- Merge into the reviewed, ordered Staging security package.
--
-- SECURITY MODEL:
--   - Authenticated users can read only their own RSVP rows.
--   - Users can insert only their own RSVP for an approved church
--     programme, provided their profile is active and unblocked.
--   - Users can delete only their own RSVP.
--   - No public attendee list or attendee-count access is granted.
--   - Duplicate programme/user RSVP pairs are prohibited.
-- ============================================================

BEGIN;
-- ------------------------------------------------------------
-- 1. FAIL-CLOSED PREFLIGHT
-- ------------------------------------------------------------

DO $preflight$
BEGIN
    IF current_user <> 'postgres' THEN
        RAISE EXCEPTION
            'Preflight failed: this section must be reviewed/applied as postgres.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_roles
        WHERE rolname = 'service_role'
    ) THEN
        RAISE EXCEPTION 'Preflight failed: service_role database role is missing.';
    END IF;

    IF to_regclass('public.rsvps') IS NULL
       OR to_regclass('public.programmes') IS NULL
       OR to_regclass('public.churches') IS NULL
       OR to_regclass('public.profiles') IS NULL THEN
        RAISE EXCEPTION
            'Preflight failed: required RSVP, programme, church, or profile table is missing.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_class AS c
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'rsvps'
          AND c.relrowsecurity
    ) THEN
        RAISE EXCEPTION
            'Preflight failed: RLS is not enabled on public.rsvps.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_policy AS p
        JOIN pg_class AS c ON c.oid = p.polrelid
        JOIN pg_namespace AS n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public'
          AND c.relname = 'rsvps'
    ) THEN
        RAISE EXCEPTION
            'Preflight failed: existing RSVP policies must be reviewed before proceeding.';
    END IF;

    IF to_regprocedure('public.can_rsvp_to_programme(uuid)') IS NOT NULL THEN
        RAISE EXCEPTION
            'Preflight failed: can_rsvp_to_programme(uuid) already exists.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.rsvps'::regclass
          AND conname = 'rsvps_programme_id_fkey'
          AND contype = 'f'
    ) THEN
        RAISE EXCEPTION
            'Preflight failed: expected RSVP programme foreign key is missing.';
    END IF;

    -- Verify the named foreign key targets programmes(id).
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_constraint AS fk
        WHERE fk.conrelid = 'public.rsvps'::regclass
          AND fk.conname = 'rsvps_programme_id_fkey'
          AND fk.contype = 'f'
          AND fk.confrelid = 'public.programmes'::regclass
          AND pg_catalog.cardinality(fk.conkey) = 1
          AND pg_catalog.cardinality(fk.confkey) = 1
          AND EXISTS (
              SELECT 1
              FROM pg_catalog.unnest(fk.conkey) AS source_key(attnum)
              JOIN pg_catalog.pg_attribute AS source_column
                ON source_column.attrelid = fk.conrelid
               AND source_column.attnum = source_key.attnum
              WHERE source_column.attname = 'programme_id'
                AND source_column.attisdropped IS FALSE
          )
          AND EXISTS (
              SELECT 1
              FROM pg_catalog.unnest(fk.confkey) AS target_key(attnum)
              JOIN pg_catalog.pg_attribute AS target_column
                ON target_column.attrelid = fk.confrelid
               AND target_column.attnum = target_key.attnum
              WHERE target_column.attname = 'id'
                AND target_column.attisdropped IS FALSE
          )
    ) THEN
        RAISE EXCEPTION 'Preflight failed: RSVP programme foreign key does not reference programmes(id).';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.rsvps
        WHERE programme_id IS NULL
           OR user_id IS NULL
    ) THEN
        RAISE EXCEPTION
            'Preflight failed: RSVP rows contain NULL programme_id or user_id. Review data before enforcing NOT NULL.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM public.rsvps
        GROUP BY programme_id, user_id
        HAVING count(*) > 1
    ) THEN
        RAISE EXCEPTION
            'Preflight failed: duplicate programme/user RSVP pairs exist. Resolve duplicates before adding uniqueness.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM pg_constraint
        WHERE conrelid = 'public.rsvps'::regclass
          AND conname = 'rsvps_programme_user_unique'
    ) THEN
        RAISE EXCEPTION
            'Preflight failed: RSVP uniqueness constraint name already exists.';
    END IF;
END;
$preflight$;
-- ------------------------------------------------------------
-- 2. ENFORCE REQUIRED RSVP OWNERSHIP
-- ------------------------------------------------------------

ALTER TABLE public.rsvps
    ALTER COLUMN programme_id SET NOT NULL,
    ALTER COLUMN user_id SET NOT NULL;
ALTER TABLE public.rsvps
    ADD CONSTRAINT rsvps_programme_user_unique
    UNIQUE (programme_id, user_id);
-- ------------------------------------------------------------
-- 3. CASCADE RSVP CLEANUP WHEN A PROGRAMME IS DELETED
-- ------------------------------------------------------------

ALTER TABLE public.rsvps
    DROP CONSTRAINT rsvps_programme_id_fkey;
ALTER TABLE public.rsvps
    ADD CONSTRAINT rsvps_programme_id_fkey
    FOREIGN KEY (programme_id)
    REFERENCES public.programmes(id)
    ON DELETE CASCADE;
-- ------------------------------------------------------------
-- 4. AUTHORIZATION HELPER
--    Check the programme's church and the caller's profile.
--    SECURITY DEFINER avoids depending on browser SELECT access
--    to profiles or churches from inside the policy.
-- ------------------------------------------------------------

CREATE FUNCTION public.can_rsvp_to_programme(
    p_programme_id uuid
)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT
        p_programme_id IS NOT NULL
        AND auth.uid() IS NOT NULL
        AND EXISTS (
            SELECT 1
            FROM public.programmes AS p
            JOIN public.churches AS c
              ON c.id = p.church_id
            JOIN public.profiles AS pr
              ON pr.id = auth.uid()
            WHERE p.id = p_programme_id
              AND c.status = 'approved'
              AND pr.status = 'active'
              AND pr.is_blocked IS FALSE
        );
$function$;
ALTER FUNCTION public.can_rsvp_to_programme(uuid)
    OWNER TO postgres;
REVOKE ALL ON FUNCTION public.can_rsvp_to_programme(uuid)
    FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.can_rsvp_to_programme(uuid)
    TO authenticated;
-- ------------------------------------------------------------
-- 5. MINIMUM TABLE AND COLUMN PRIVILEGES
--    Preserve service_role privileges.
-- ------------------------------------------------------------

REVOKE ALL PRIVILEGES ON TABLE public.rsvps
    FROM PUBLIC, anon, authenticated;
REVOKE ALL PRIVILEGES (
    id,
    programme_id,
    user_id,
    status
) ON TABLE public.rsvps
    FROM PUBLIC, anon, authenticated;
-- Explicit backend access. Never expose service_role credentials in browser code.
GRANT ALL PRIVILEGES ON TABLE public.rsvps TO service_role;
-- The page reads programme_id and filters by its own user_id.
-- RLS below ensures the caller sees only rows owned by auth.uid().
GRANT SELECT (
    programme_id,
    user_id
) ON TABLE public.rsvps TO authenticated;
-- The page inserts only programme_id and its authenticated user_id.
-- status uses the database default ('attending').
GRANT INSERT (
    programme_id,
    user_id
) ON TABLE public.rsvps TO authenticated;
-- Cancellation is permitted only through the own-row DELETE policy.
GRANT DELETE ON TABLE public.rsvps TO authenticated;
-- ------------------------------------------------------------
-- 6. OWN-ROW SELECT POLICY
-- ------------------------------------------------------------

CREATE POLICY rsvps_select_own
ON public.rsvps
FOR SELECT
TO authenticated
USING (
    user_id = auth.uid()
);
-- ------------------------------------------------------------
-- 7. OWN-ROW INSERT POLICY
-- ------------------------------------------------------------

CREATE POLICY rsvps_insert_own_approved_programme
ON public.rsvps
FOR INSERT
TO authenticated
WITH CHECK (
    user_id = auth.uid()
    AND public.can_rsvp_to_programme(programme_id)
);
-- ------------------------------------------------------------
-- 8. OWN-ROW DELETE POLICY
-- ------------------------------------------------------------

CREATE POLICY rsvps_delete_own
ON public.rsvps
FOR DELETE
TO authenticated
USING (
    user_id = auth.uid()
);
-- ------------------------------------------------------------
-- 9. END OF SECTION 03
--
-- Deliberately NOT granted:
--   - anon access
--   - public attendee-list access
--   - RSVP UPDATE access
--   - attendee-count access
--
-- The application currently displays only the user's own
-- RSVP status, not other attendees or a public count.
--
-- This file has not been executed or live-tested.
-- ------------------------------------------------------------

COMMIT;
