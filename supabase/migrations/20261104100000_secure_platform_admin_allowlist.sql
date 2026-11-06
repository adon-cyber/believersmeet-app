BEGIN;

-- Establish the database-local platform administrator allowlist.
CREATE SCHEMA IF NOT EXISTS private;

-- Do not expose the private schema to browser-facing roles.
REVOKE ALL ON SCHEMA private
    FROM PUBLIC, anon, authenticated;

CREATE TABLE IF NOT EXISTS private.platform_admins (
    user_id uuid PRIMARY KEY
        REFERENCES auth.users(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT pg_catalog.now()
);

ALTER TABLE private.platform_admins ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE private.platform_admins
    FROM PUBLIC, anon, authenticated, service_role;

-- Preserve the designated Super Admin already identified
-- in the existing role-protection migration.
DO $migration$
DECLARE
    v_designated_admin_id CONSTANT uuid :=
        '45e7b5df-8f08-4cc7-9356-35e405618329';
    v_designated_admin_email CONSTANT text :=
        'adonstance@gmail.com';
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM auth.users
        WHERE id = v_designated_admin_id
          AND lower(email) = lower(v_designated_admin_email)
    ) THEN
        RAISE EXCEPTION
            'Designated Super Admin Auth identity mismatch or account missing for UUID %. Expected email %. Allowlist migration stopped.',
            v_designated_admin_id,
            v_designated_admin_email;
    END IF;

    INSERT INTO private.platform_admins (user_id)
    VALUES (v_designated_admin_id)
    ON CONFLICT (user_id) DO NOTHING;
END;
$migration$;

-- Internal helper. Not executable by browser-facing roles.
CREATE OR REPLACE FUNCTION public.is_platform_admin(p_user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM private.platform_admins AS pa
        WHERE pa.user_id = p_user_id
    );
$function$;

REVOKE ALL ON FUNCTION public.is_platform_admin(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

-- Zero-argument identity helper used by the application.
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM private.platform_admins AS pa
        WHERE pa.user_id = auth.uid()
    );
$function$;

-- Preserve the existing argument name for PostgREST compatibility.
-- $1 must equal the authenticated caller and exist in the allowlist.
CREATE OR REPLACE FUNCTION public.is_super_admin(user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT
        $1 IS NOT NULL
        AND $1 = auth.uid()
        AND EXISTS (
            SELECT 1
            FROM private.platform_admins AS pa
            WHERE pa.user_id = $1
        );
$function$;

REVOKE ALL ON FUNCTION public.is_super_admin()
    FROM PUBLIC, anon, authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_super_admin(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.is_super_admin()
    TO authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.is_super_admin(uuid)
    TO authenticated, service_role;



-- ============================================================
-- Unify legacy is_admin checks with the private platform
-- administrator allowlist. Keep both historical signatures.
-- The legacy users.is_admin data is not modified.
-- ============================================================

CREATE OR REPLACE FUNCTION public.is_admin()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT EXISTS (
        SELECT 1
        FROM private.platform_admins AS pa
        WHERE pa.user_id = auth.uid()
    );
$function$;


CREATE OR REPLACE FUNCTION public.is_admin(user_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO ''
AS $function$
    SELECT
        $1 IS NOT NULL
        AND $1 = auth.uid()
        AND EXISTS (
            SELECT 1
            FROM private.platform_admins AS pa
            WHERE pa.user_id = $1
        );
$function$;


REVOKE ALL ON FUNCTION public.is_admin()
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.is_admin()
    TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.is_admin(uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.is_admin(uuid)
    TO authenticated, service_role;


-- Defense in depth: prevent ordinary users from changing the
-- obsolete public.users.is_admin flag.
CREATE OR REPLACE FUNCTION public.prevent_legacy_users_admin_flag_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
BEGIN
    IF auth.role() = 'service_role' THEN
        RETURN NEW;
    END IF;

    IF OLD.is_admin IS DISTINCT FROM NEW.is_admin
        AND NOT public.is_super_admin()
    THEN
        RAISE EXCEPTION
            'Only an allowlisted platform administrator can change the legacy admin flag.';
    END IF;

    RETURN NEW;
END;
$function$;


REVOKE ALL ON FUNCTION public.prevent_legacy_users_admin_flag_change()
    FROM PUBLIC, anon, authenticated, service_role;

DROP TRIGGER IF EXISTS tr_prevent_legacy_users_admin_flag_change
    ON public.users;

CREATE TRIGGER tr_prevent_legacy_users_admin_flag_change
    BEFORE UPDATE OF is_admin ON public.users
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_legacy_users_admin_flag_change();

-- ============================================================
-- Harden all profile role-management paths.
-- Platform-level authority comes only from the private allowlist.
-- ============================================================

CREATE OR REPLACE FUNCTION public.assign_profile_role(
    target_user_id uuid,
    new_role text,
    target_church_id uuid DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_caller_id uuid := auth.uid();
    v_caller_role text;
    v_caller_church_id uuid;
    v_target_role text;
    v_target_church_id uuid;
    v_new_role text := pg_catalog.lower(pg_catalog.btrim(new_role));
    v_is_platform_admin boolean := false;
BEGIN
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Authentication required.';
    END IF;

    IF v_new_role IS NULL OR v_new_role NOT IN (
        'member',
        'pastor',
        'finance',
        'church_admin',
        'admin'
    ) THEN
        RAISE EXCEPTION 'Unsupported role assignment.';
    END IF;

    v_is_platform_admin := public.is_super_admin();

    SELECT
        pg_catalog.lower(pg_catalog.btrim(p.role)),
        p.church_id
    INTO v_caller_role, v_caller_church_id
    FROM public.profiles AS p
    WHERE p.id = v_caller_id;

    SELECT
        pg_catalog.lower(pg_catalog.btrim(p.role)),
        p.church_id
    INTO v_target_role, v_target_church_id
    FROM public.profiles AS p
    WHERE p.id = target_user_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Target user profile not found.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM private.platform_admins AS pa
        WHERE pa.user_id = target_user_id
    ) THEN
        RAISE EXCEPTION
            'Platform administrator accounts cannot be changed through role assignment.';
    END IF;

    IF v_new_role IN ('super_admin', 'super-admin') THEN
        RAISE EXCEPTION
            'Platform administrator status cannot be assigned through this function.';
    END IF;

    IF v_target_role IN ('super_admin', 'super-admin')
        AND NOT v_is_platform_admin
    THEN
        RAISE EXCEPTION
            'Only an allowlisted platform administrator can modify legacy Super Admin role labels.';
    END IF;

    IF v_is_platform_admin THEN
        UPDATE public.profiles AS p
        SET
            role = v_new_role,
            church_id = COALESCE(target_church_id, p.church_id),
            updated_at = pg_catalog.now()
        WHERE p.id = target_user_id;

        RETURN;
    END IF;

    IF v_caller_role IN ('admin', 'church_admin') THEN

        IF v_new_role IN ('admin', 'church_admin') THEN
            RAISE EXCEPTION
                'Church administrators cannot appoint another church administrator.';
        END IF;

        IF target_user_id = v_caller_id THEN
            RAISE EXCEPTION
                'Church administrators cannot modify their own role.';
        END IF;

        IF v_target_role IN ('admin', 'church_admin') THEN
            RAISE EXCEPTION
                'Only a platform administrator can modify church administrator accounts.';
        END IF;

        IF v_caller_church_id IS NULL
            OR v_target_church_id IS DISTINCT FROM v_caller_church_id
            OR (
                target_church_id IS NOT NULL
                AND target_church_id IS DISTINCT FROM v_caller_church_id
            )
        THEN
            RAISE EXCEPTION
                'Church administrators can only manage users within their own church.';
        END IF;

        UPDATE public.profiles
        SET
            role = v_new_role,
            updated_at = pg_catalog.now()
        WHERE id = target_user_id;

        RETURN;
    END IF;

    RAISE EXCEPTION 'Access denied: insufficient privileges to assign roles.';
END;
$function$;


CREATE OR REPLACE FUNCTION public.super_admin_update_user_role(
    target_user_id uuid,
    new_role text
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_new_role text := pg_catalog.lower(pg_catalog.btrim(new_role));
BEGIN
    IF NOT public.is_super_admin() THEN
        RAISE EXCEPTION
            'Access denied: platform administrator privileges required.';
    END IF;

    IF target_user_id IS NULL THEN
        RAISE EXCEPTION 'Target user ID is required.';
    END IF;

    IF v_new_role IS NULL OR v_new_role NOT IN (
        'member',
        'pastor',
        'finance',
        'church_admin'
    ) THEN
        RAISE EXCEPTION 'Unsupported role assignment.';
    END IF;

    IF EXISTS (
        SELECT 1
        FROM private.platform_admins AS pa
        WHERE pa.user_id = target_user_id
    ) THEN
        RAISE EXCEPTION
            'Platform administrator accounts cannot be changed through this role-update function.';
    END IF;

    IF NOT EXISTS (
        SELECT 1
        FROM public.profiles AS p
        WHERE p.id = target_user_id
    ) THEN
        RAISE EXCEPTION 'Target user profile not found.';
    END IF;

    UPDATE public.profiles
    SET
        role = v_new_role,
        updated_at = pg_catalog.now()
    WHERE id = target_user_id;
END;
$function$;


-- Protect administrative role changes even when someone attempts
-- to update profiles directly instead of using the protected RPCs.
CREATE OR REPLACE FUNCTION public.prevent_admin_role_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_caller_id uuid := auth.uid();
    v_is_platform_admin boolean := false;
BEGIN
    IF auth.role() = 'service_role' THEN
        RETURN NEW;
    END IF;

    IF OLD.role IS DISTINCT FROM NEW.role THEN

        v_is_platform_admin := public.is_super_admin();

        -- Protect the identity of every allowlisted administrator.
        IF EXISTS (
            SELECT 1
            FROM private.platform_admins AS pa
            WHERE pa.user_id IN (OLD.id, NEW.id)
        ) THEN
            RAISE EXCEPTION
                'Allowlisted platform administrator profile roles cannot be changed through a profile update.';
        END IF;

        -- The ordinary role-update paths must never create
        -- a platform Super Admin identity or label.
        IF NEW.role IN ('super_admin', 'super-admin') THEN
            RAISE EXCEPTION
                'Platform administrator status can only be granted through a controlled allowlist operation.';
        END IF;

        IF (
            OLD.role IN ('admin', 'church_admin', 'super_admin', 'super-admin')
            OR NEW.role IN ('admin', 'church_admin', 'super_admin', 'super-admin')
        ) AND NOT v_is_platform_admin THEN
            RAISE EXCEPTION
                'Unauthorized: only an allowlisted platform administrator can change administrative roles.';
        END IF;

        IF v_caller_id = NEW.id AND NOT v_is_platform_admin THEN
            RAISE EXCEPTION
                'Users cannot modify their own role.';
        END IF;
    END IF;

    RETURN NEW;
END;
$function$;


-- Explicitly restrict execution of the role-management functions.
REVOKE ALL ON FUNCTION public.assign_profile_role(uuid, text, uuid)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.assign_profile_role(uuid, text, uuid)
    TO authenticated;

REVOKE ALL ON FUNCTION public.super_admin_update_user_role(uuid, text)
    FROM PUBLIC, anon, authenticated, service_role;

GRANT EXECUTE ON FUNCTION public.super_admin_update_user_role(uuid, text)
    TO authenticated;

REVOKE ALL ON FUNCTION public.prevent_admin_role_change()
    FROM PUBLIC, anon, authenticated, service_role;


-- ============================================================
-- Replace legacy profile-role Super Admin RLS checks.
-- Preserve existing admin and finance permissions.
-- ============================================================

DROP POLICY IF EXISTS "Super admins can update any profile role"
    ON public.profiles;

CREATE POLICY "Allowlisted platform admins can update any profile role"
    ON public.profiles
    FOR UPDATE
    TO authenticated
    USING (public.is_super_admin())
    WITH CHECK (public.is_super_admin());


DROP POLICY IF EXISTS "Allow admin and finance to update giving_settings"
    ON public.giving_settings;

CREATE POLICY "Allow admin and finance to update giving_settings"
    ON public.giving_settings
    FOR UPDATE
    TO authenticated
    USING (
        public.is_super_admin()
        OR EXISTS (
            SELECT 1
            FROM public.profiles AS p
            WHERE p.id = auth.uid()
              AND p.role IN ('admin', 'finance')
        )
    )
    WITH CHECK (
        public.is_super_admin()
        OR EXISTS (
            SELECT 1
            FROM public.profiles AS p
            WHERE p.id = auth.uid()
              AND p.role IN ('admin', 'finance')
        )
    );


DROP POLICY IF EXISTS "Allow admin to insert giving_settings"
    ON public.giving_settings;

CREATE POLICY "Allow admin to insert giving_settings"
    ON public.giving_settings
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.is_super_admin()
        OR EXISTS (
            SELECT 1
            FROM public.profiles AS p
            WHERE p.id = auth.uid()
              AND p.role IN ('admin', 'finance')
        )
    );


DROP POLICY IF EXISTS "Admins and super_admins can create events"
    ON public.events;

CREATE POLICY "Admins and super_admins can create events"
    ON public.events
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.is_super_admin()
        OR EXISTS (
            SELECT 1
            FROM public.profiles AS p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
        )
    );


DROP POLICY IF EXISTS "Admins, super_admins, and creators can update events"
    ON public.events;

CREATE POLICY "Admins, super_admins, and creators can update events"
    ON public.events
    FOR UPDATE
    TO authenticated
    USING (
        auth.uid() = created_by
        OR public.is_super_admin()
        OR EXISTS (
            SELECT 1
            FROM public.profiles AS p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
        )
    )
    WITH CHECK (
        auth.uid() = created_by
        OR public.is_super_admin()
        OR EXISTS (
            SELECT 1
            FROM public.profiles AS p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
        )
    );


DROP POLICY IF EXISTS "Admins, super_admins, and creators can delete events"
    ON public.events;

CREATE POLICY "Admins, super_admins, and creators can delete events"
    ON public.events
    FOR DELETE
    TO authenticated
    USING (
        auth.uid() = created_by
        OR public.is_super_admin()
        OR EXISTS (
            SELECT 1
            FROM public.profiles AS p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
        )
    );


DROP POLICY IF EXISTS "Admins and super_admins can insert event invitations."
    ON public.event_invitations;

CREATE POLICY "Admins and super_admins can insert event invitations."
    ON public.event_invitations
    FOR INSERT
    TO authenticated
    WITH CHECK (
        public.is_super_admin()
        OR EXISTS (
            SELECT 1
            FROM public.profiles AS p
            WHERE p.id = auth.uid()
              AND p.role = 'admin'
        )
    );

COMMIT;