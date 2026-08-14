-- Create storage bucket for music-uploads
INSERT INTO storage.buckets (id, name, public)
VALUES ('music-uploads', 'music-uploads', true)
ON CONFLICT (id) DO UPDATE SET public = true;

-- Policy to allow public read access to music-uploads
CREATE POLICY "Public Read Music Uploads"
ON storage.objects FOR SELECT
USING (bucket_id = 'music-uploads');

-- Policy to allow authenticated users / admins to upload music files
CREATE POLICY "Admin Insert Music Uploads"
ON storage.objects FOR INSERT
TO authenticated
WITH CHECK (bucket_id = 'music-uploads');

-- Policy to allow admins to delete music files
CREATE POLICY "Admin Delete Music Uploads"
ON storage.objects FOR DELETE
TO authenticated
USING (bucket_id = 'music-uploads');
