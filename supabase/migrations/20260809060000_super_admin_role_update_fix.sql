-- Create migration to ensure super_admin can update user roles on public.profiles and provide secure RPC if needed
CREATE POLICY "Super admins can update any profile role"
    ON public.profiles FOR UPDATE
    USING (
        EXISTS (
            SELECT 1 FROM public.profiles p
            WHERE p.id = auth.uid()
            AND p.role = 'super_admin'
        )
    );

-- Create secure RPC function to update user roles bypassing potential RLS recursion issues
CREATE OR REPLACE FUNCTION public.super_admin_update_user_role(target_user_id uuid, new_role text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  -- Verify executing user is super_admin
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles
    WHERE id = auth.uid() AND role = 'super_admin'
  ) THEN
    RAISE EXCEPTION 'Access denied: Super Administrator privileges required.';
  END IF;

  -- Update role
  UPDATE public.profiles
  SET role = new_role, updated_at = now()
  WHERE id = target_user_id;
END;
$$;
