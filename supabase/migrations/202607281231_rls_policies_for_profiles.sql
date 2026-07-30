-- Enable RLS on profiles
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;

-- Users can view their own profile
CREATE POLICY "Users can view their own profile."
    ON public.profiles FOR SELECT
    USING (auth.uid() = id);

-- Admins can view all profiles
CREATE POLICY "Admins can view all profiles."
    ON public.profiles FOR SELECT
    USING (public.is_admin());

-- Users can insert their own profile
CREATE POLICY "Users can insert their own profile."
    ON public.profiles FOR INSERT
    WITH CHECK (auth.uid() = id);

-- Admins can insert any profile
CREATE POLICY "Admins can insert any profile."
    ON public.profiles FOR INSERT
    USING (public.is_admin());

-- Users can update their own profile
CREATE POLICY "Users can update their own profile."
    ON public.profiles FOR UPDATE
    USING (auth.uid() = id);

-- Admins can update any profile
CREATE POLICY "Admins can update any profile."
    ON public.profiles FOR UPDATE
    USING (public.is_admin());

-- Users can delete their own profile
CREATE POLICY "Users can delete their own profile."
    ON public.profiles FOR DELETE
    USING (auth.uid() = id);

-- Admins can delete any profile
CREATE POLICY "Admins can delete any profile."
    ON public.profiles FOR DELETE
    USING (public.is_admin());