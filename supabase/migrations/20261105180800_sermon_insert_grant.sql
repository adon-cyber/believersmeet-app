BEGIN;
DO $preflight$
BEGIN
    IF NOT EXISTS (
        SELECT 1
        FROM pg_catalog.pg_policies
        WHERE schemaname = 'public'
          AND tablename = 'sermons'
          AND policyname = 'sermons_authenticated_insert_managed'
          AND cmd = 'INSERT'
    ) THEN
        RAISE EXCEPTION
            'Preflight failed: expected Section 02 sermons INSERT policy is missing.';
    END IF;
END;
$preflight$;
GRANT INSERT (
    church_id,
    title,
    media_url,
    video_url,
    audio_url,
    thumbnail_url,
    category,
    media_type,
    preacher,
    description,
    created_at
)
ON TABLE public.sermons
TO authenticated;
DO $verification$
BEGIN
    IF NOT has_column_privilege(
        'authenticated',
        'public.sermons',
        'church_id',
        'INSERT'
    ) THEN
        RAISE EXCEPTION 'Sermons INSERT column grant verification failed.';
    END IF;
END;
$verification$;
COMMIT;
