-- Seed sample profiles for testing database queries and discovery features in BelieversMeet
-- Note: These reference sample UUIDs matching auth.users or can be upserted when users exist.

INSERT INTO public.profiles (id, full_name, role, home_cell, favorite_scripture, bio, is_verified, avatar_url)
VALUES 
    ('11111111-1111-1111-1111-111111111111', 'Pastor David Kimani', 'admin', 'Grace Center', 'Romans 8:28', 'Serving the flock and passionate about teaching the Word of God.', TRUE, 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150'),
    ('22222222-2222-2222-2222-222222222222', 'Sarah Wanjiku', 'member', 'Bethany Cell', 'Philippians 4:13', 'Loves worship ministry, youth mentorship, and fellowship prayer nights.', TRUE, 'https://images.unsplash.com/photo-1517841905240-472988babdf9?w=150'),
    ('33333333-3333-3333-3333-333333333333', 'Michael Omondi', 'member', 'Grace Center', 'Psalm 23:1-3', 'Software engineer by day, fervent prayer warrior and cell group leader by grace.', FALSE, 'https://images.unsplash.com/photo-1507003211169-0a1dd7228f2d?w=150'),
    ('44444444-4444-4444-4444-444444444444', 'Esther Mutua', 'member', 'Hillcrest Fellowship', 'Proverbs 3:5-6', 'Passionate about intercession, missions, and community outreach.', TRUE, 'https://images.unsplash.com/photo-1494790108377-be9c29b29330?w=150'),
    ('55555555-5555-5555-5555-555555555555', 'Daniel Kiprono', 'member', 'Bethany Cell', 'Joshua 1:9', 'Enjoying fellowship, studying scripture deeply, and encouraging youth.', FALSE, 'https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150')
ON CONFLICT (id) DO UPDATE 
SET 
    full_name = EXCLUDED.full_name,
    role = EXCLUDED.role,
    home_cell = EXCLUDED.home_cell,
    favorite_scripture = EXCLUDED.favorite_scripture,
    bio = EXCLUDED.bio,
    is_verified = EXCLUDED.is_verified,
    avatar_url = EXCLUDED.avatar_url;
