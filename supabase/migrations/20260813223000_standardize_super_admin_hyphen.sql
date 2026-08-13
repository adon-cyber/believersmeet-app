-- Migration to include both 'super_admin' and 'super-admin' in RLS policies and helper functions

CREATE OR REPLACE FUNCTION public.is_super_admin(user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  RETURN EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = user_id AND role IN ('super_admin', 'super-admin')
  );
END;
$$;

-- Update giving settings policy
DROP POLICY IF EXISTS "Allow admin and finance to update giving_settings" ON public.giving_settings;
CREATE POLICY "Allow admin and finance to update giving_settings"
    ON public.giving_settings FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM profiles
            where profiles.id = auth.uid()
            and profiles.role in ('admin', 'super_admin', 'super-admin', 'finance')
        )
    );

DROP POLICY IF EXISTS "Allow admin to insert giving_settings" ON public.giving_settings;
CREATE POLICY "Allow admin to insert giving_settings"
    ON public.giving_settings FOR INSERT
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM profiles
            where profiles.id = auth.uid()
            and profiles.role in ('admin', 'super_admin', 'super-admin', 'finance')
        )
    );

-- Update super_admin update profile policy
DROP POLICY IF EXISTS "Super admins can update any profile role" ON public.profiles;
CREATE POLICY "Super admins can update any profile role"
    ON public.profiles FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = auth.uid()
            AND p.role IN ('super_admin', 'super-admin')
        )
    );

-- Update secure RPC function to accept super-admin
CREATE OR REPLACE FUNCTION public.super_admin_update_user_role(target_user_id uuid, new_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Verify executing user is super_admin or super-admin
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role IN ('super_admin', 'super-admin')
  ) THEN
    RAISE EXCEPTION 'Access Denied: Only Super Administrators can update user roles.';
  END IF;

  -- Update role
  UPDATE public.profiles
  SET role = new_role, updated_at = now()
  WHERE id = target_user_id;
END;
$$;
