-- Create profiles table
CREATE TABLE public.profiles (
    id uuid REFERENCES public.users(id) ON DELETE CASCADE NOT NULL PRIMARY KEY,
    full_name text NOT NULL,
    church_id uuid,
    role text NOT NULL,
    is_verified boolean DEFAULT FALSE
);