SET check_function_bodies = false;

CREATE FUNCTION public.is_admin() RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER AS $$
BEGIN
  RETURN EXISTS(SELECT 1 FROM public.users WHERE id = auth.uid() AND is_admin = TRUE);
END;
$$;