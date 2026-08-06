-- Create gallery_images table
create table if not exists public.gallery_images (
    id uuid default gen_random_uuid() primary key,
    image_url text not null,
    caption text,
    church_id uuid references public.churches(id) on delete cascade,
    uploader_name text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Enable RLS
alter table public.gallery_images enable row level security;

-- Policies for gallery_images
create policy "Authenticated users can view gallery images"
    on public.gallery_images for select
    to authenticated
    using (true);

create policy "Admins can insert gallery images"
    on public.gallery_images for insert
    to authenticated
    with check (true);

create policy "Admins can delete gallery images"
    on public.gallery_images for delete
    to authenticated
    using (true);
