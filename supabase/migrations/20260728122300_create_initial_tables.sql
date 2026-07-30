SET check_function_bodies = false;

CREATE EXTENSION IF NOT EXISTS \"uuid-ossp\" WITH SCHEMA public;

-- Create tables schema
CREATE OR REPLACE FUNCTION handle_updated_at() RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = NOW();
    RETURN NEW;
END;
$$ language 'plpgsql';

-- Users Table
CREATE TABLE public.users (
    id uuid REFERENCES auth.users ON DELETE CASCADE NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    email text UNIQUE NOT NULL,
        display_name text,
        is_admin boolean DEFAULT FALSE NOT NULL,
    church_id uuid
);

CREATE TRIGGER on_update_users_updated_at BEFORE UPDATE ON public.users FOR EACH ROW EXECUTE PROCEDURE handle_updated_at();

ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;


-- Churches Table
CREATE TABLE public.churches (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    name text UNIQUE NOT NULL,
    location text,
    admin_user_id uuid REFERENCES public.users (id) ON DELETE CASCADE NOT NULL
);

ALTER TABLE public.churches ADD CONSTRAINT fk_admin_user FOREIGN KEY (admin_user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE TRIGGER on_update_churches_updated_at BEFORE UPDATE ON public.churches FOR EACH ROW EXECUTE PROCEDURE handle_updated_at();

ALTER TABLE public.churches ENABLE ROW LEVEL SECURITY;


-- Events Table
CREATE TABLE public.events (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    title text NOT NULL,
    description text,
    event_date timestamp with time zone NOT NULL,
    church_id uuid REFERENCES public.churches (id) ON DELETE CASCADE NOT NULL,
    created_by uuid REFERENCES public.users (id) ON DELETE CASCADE NOT NULL
);

ALTER TABLE public.events ADD CONSTRAINT fk_church FOREIGN KEY (church_id) REFERENCES public.churches(id) ON DELETE CASCADE;
ALTER TABLE public.events ADD CONSTRAINT fk_created_by FOREIGN KEY (created_by) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE TRIGGER on_update_events_updated_at BEFORE UPDATE ON public.events FOR EACH ROW EXECUTE PROCEDURE handle_updated_at();

ALTER TABLE public.events ENABLE ROW LEVEL SECURITY;


-- Prayer Requests Table
CREATE TABLE public.prayer_requests (
    id uuid DEFAULT public.gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    request_text text NOT NULL,
    user_id uuid REFERENCES public.users (id) ON DELETE CASCADE NOT NULL,
    is_private boolean DEFAULT FALSE NOT NULL
);

ALTER TABLE public.prayer_requests ADD CONSTRAINT fk_user FOREIGN KEY (user_id) REFERENCES public.users(id) ON DELETE CASCADE;

CREATE TRIGGER on_update_prayer_requests_updated_at BEFORE UPDATE ON public.prayer_requests FOR EACH ROW EXECUTE PROCEDURE handle_updated_at();

ALTER TABLE public.prayer_requests ENABLE ROW LEVEL SECURITY;