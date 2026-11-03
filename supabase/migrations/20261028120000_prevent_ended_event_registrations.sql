
-- Prevent registrations for ended events.
-- Scope: public.event_registrations only.

CREATE OR REPLACE FUNCTION public.check_event_active_before_registration()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public, pg_temp
AS $$
DECLARE
    target_event_date timestamptz;
    event_deadline timestamptz;
BEGIN
    -- Allow ordinary updates to existing registrations.
    IF TG_OP = 'UPDATE'
       AND OLD.event_id IS NOT DISTINCT FROM NEW.event_id THEN
        RETURN NEW;
    END IF;

    SELECT e.event_date
    INTO target_event_date
    FROM public.events AS e
    WHERE e.id = NEW.event_id;

    -- Let the foreign key reject a nonexistent event.
    IF NOT FOUND THEN
        RETURN NEW;
    END IF;

    -- Midnight UTC following the event's UTC calendar day.
    event_deadline :=
        (((target_event_date AT TIME ZONE 'UTC')::date + 1)::timestamp
          AT TIME ZONE 'UTC');

    IF clock_timestamp() >= event_deadline THEN
        RAISE EXCEPTION 'Registration closed: This event has ended.';
    END IF;

    RETURN NEW;
END;
$$;

ALTER FUNCTION public.check_event_active_before_registration()
    OWNER TO postgres;

REVOKE ALL ON FUNCTION
    public.check_event_active_before_registration()
    FROM PUBLIC;

DROP TRIGGER IF EXISTS tr_check_event_active_registration
    ON public.event_registrations;

CREATE TRIGGER tr_check_event_active_registration
    BEFORE INSERT OR UPDATE ON public.event_registrations
    FOR EACH ROW
    EXECUTE FUNCTION public.check_event_active_before_registration();
