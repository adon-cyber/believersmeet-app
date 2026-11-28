BEGIN;

CREATE OR REPLACE FUNCTION public.update_church_profile(
    p_church_id uuid,
    p_name text,
    p_location text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_name text := pg_catalog.btrim(COALESCE(p_name, ''));
    v_location text := NULLIF(pg_catalog.btrim(COALESCE(p_location, '')), '');
BEGIN
    IF auth.uid() IS NULL THEN
        RAISE EXCEPTION 'Authentication is required'
            USING ERRCODE = '42501';
    END IF;

    IF p_church_id IS NULL THEN
        RAISE EXCEPTION 'Church identifier is required'
            USING ERRCODE = '22023';
    END IF;

    IF v_name = '' THEN
        RAISE EXCEPTION 'Church name cannot be empty'
            USING ERRCODE = '22023';
    END IF;

    IF pg_catalog.char_length(v_name) > 160 THEN
        RAISE EXCEPTION 'Church name cannot exceed 160 characters'
            USING ERRCODE = '22023';
    END IF;

    IF v_location IS NOT NULL
       AND pg_catalog.char_length(v_location) > 255 THEN
        RAISE EXCEPTION 'Church location cannot exceed 255 characters'
            USING ERRCODE = '22023';
    END IF;

    IF NOT public.can_manage_church_content(p_church_id) THEN
        RAISE EXCEPTION
            'You are not authorized to update this church profile'
            USING ERRCODE = '42501';
    END IF;

    UPDATE public.churches AS c
       SET name = v_name,
           location = v_location
     WHERE c.id = p_church_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Church not found'
            USING ERRCODE = 'P0002';
    END IF;

    RETURN TRUE;
END;
$function$;

REVOKE ALL ON FUNCTION
    public.update_church_profile(uuid, text, text)
FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION
    public.update_church_profile(uuid, text, text)
TO authenticated;

COMMENT ON FUNCTION
    public.update_church_profile(uuid, text, text)
IS 'Updates only a church name and location after verifying church-management authorization.';

COMMIT;
