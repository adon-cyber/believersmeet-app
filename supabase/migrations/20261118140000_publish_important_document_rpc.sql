BEGIN;

DO $preflight$
BEGIN
    IF current_user <> 'postgres' THEN
        RAISE EXCEPTION 'Run this migration as postgres in the Staging SQL Editor';
    END IF;

    IF to_regclass('public.important_documents') IS NULL THEN
        RAISE EXCEPTION 'Required table public.important_documents does not exist';
    END IF;

    IF to_regclass('storage.objects') IS NULL THEN
        RAISE EXCEPTION 'Required table storage.objects does not exist';
    END IF;

    IF to_regprocedure('public.can_manage_important_documents(uuid)') IS NULL THEN
        RAISE EXCEPTION 'Required authorization helper public.can_manage_important_documents(uuid) does not exist';
    END IF;
END
$preflight$;

CREATE OR REPLACE FUNCTION public.publish_important_document(p_document_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO ''
AS $function$
DECLARE
    v_actor uuid := auth.uid();
    v_church_id uuid;
    v_uploaded_by uuid;
    v_file_path text;
    v_is_published boolean;
BEGIN
    IF v_actor IS NULL THEN
        RAISE EXCEPTION 'Authentication is required to publish a document';
    END IF;

    SELECT d.church_id, d.uploaded_by, d.file_path, d.is_published
      INTO v_church_id, v_uploaded_by, v_file_path, v_is_published
      FROM public.important_documents AS d
     WHERE d.id = p_document_id
     FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Document not found';
    END IF;

    IF v_uploaded_by IS DISTINCT FROM v_actor THEN
        RAISE EXCEPTION 'Only the document uploader may publish this document';
    END IF;

    IF NOT COALESCE(public.can_manage_important_documents(v_church_id), false) THEN
        RAISE EXCEPTION 'You are not authorized to publish documents for this church';
    END IF;

    IF v_file_path IS NULL OR v_file_path = '' THEN
        RAISE EXCEPTION 'Document file path is missing';
    END IF;

    IF NOT EXISTS (
        SELECT 1
          FROM storage.objects AS so
         WHERE so.bucket_id = 'documents'
           AND so.name = v_file_path
    ) THEN
        RAISE EXCEPTION 'The private Storage file must be uploaded before the document can be published';
    END IF;

    IF NOT COALESCE(v_is_published, false) THEN
        UPDATE public.important_documents
           SET is_published = true
         WHERE id = p_document_id;
    END IF;
END;
$function$;

ALTER FUNCTION public.publish_important_document(uuid) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.publish_important_document(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.publish_important_document(uuid) TO authenticated;

COMMIT;
