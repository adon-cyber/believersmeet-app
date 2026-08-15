-- Create important_documents table
CREATE TABLE IF NOT EXISTS public.important_documents (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    title TEXT NOT NULL,
    description TEXT,
    file_url TEXT NOT NULL,
    uploaded_by UUID REFERENCES auth.users(id) ON DELETE SET NULL,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT timezone('utc'::text, now()) NOT NULL
);

-- Enable RLS on important_documents
ALTER TABLE public.important_documents ENABLE ROW LEVEL SECURITY;

-- Policies for important_documents
DROP POLICY IF EXISTS "Allow public read access to important_documents" ON public.important_documents;
CREATE POLICY "Allow public read access to important_documents"
    ON public.important_documents FOR SELECT
    USING (true);

DROP POLICY IF EXISTS "Allow admin insert important_documents" ON public.important_documents;
CREATE POLICY "Allow admin insert important_documents"
    ON public.important_documents FOR INSERT
    TO authenticated
    WITH CHECK (true);

DROP POLICY IF EXISTS "Allow admin delete important_documents" ON public.important_documents;
CREATE POLICY "Allow admin delete important_documents"
    ON public.important_documents FOR DELETE
    TO authenticated
    USING (true);

-- Create storage bucket for documents
INSERT INTO storage.buckets (id, name, public)
VALUES ('documents', 'documents', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Storage policies for documents bucket
DROP POLICY IF EXISTS "Public Read Documents" ON storage.objects;
CREATE POLICY "Public Read Documents"
ON storage.objects FOR SELECT
USING (bucket_id = 'documents');

DROP POLICY IF EXISTS "Admin Insert Documents" ON storage.objects;
CREATE POLICY "Admin Insert Documents"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'documents');

DROP POLICY IF EXISTS "Admin Delete Documents" ON storage.objects;
CREATE POLICY "Admin Delete Documents"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'documents');
