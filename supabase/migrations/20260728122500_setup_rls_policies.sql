SET check_function_bodies = false;

-- RLS for public.users
CREATE POLICY "Users can view their own profile." ON public.users FOR SELECT USING (auth.uid() = id);
CREATE POLICY "Admins can view all user profiles." ON public.users FOR SELECT USING (public.is_admin());
CREATE POLICY "Users can update their own profile." ON public.users FOR UPDATE USING (auth.uid() = id);
CREATE POLICY "Admins can update any profile." ON public.users FOR UPDATE USING (public.is_admin());

-- RLS for public.churches
CREATE POLICY "All authenticated users can view churches." ON public.churches FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can create a church." ON public.churches FOR INSERT WITH CHECK (auth.uid() = admin_user_id);
CREATE POLICY "Admin of church can update their church." ON public.churches FOR UPDATE USING (auth.uid() = admin_user_id);
CREATE POLICY "Admin of church can delete their church." ON public.churches FOR DELETE USING (auth.uid() = admin_user_id);

-- RLS for public.events
CREATE POLICY "All authenticated users can view events." ON public.events FOR SELECT USING (auth.role() = 'authenticated');
CREATE POLICY "Users can create events for their church." ON public.events FOR INSERT WITH CHECK (auth.uid() = created_by AND EXISTS (SELECT 1 FROM public.churches WHERE id = church_id AND admin_user_id = auth.uid())); -- Only users who are admin of the church can create events
CREATE POLICY "Creator or church admin can update event." ON public.events FOR UPDATE USING (auth.uid() = created_by OR EXISTS (SELECT 1 FROM public.churches WHERE id = church_id AND admin_user_id = auth.uid()));
CREATE POLICY "Creator or church admin can delete event." ON public.events FOR DELETE USING (auth.uid() = created_by OR EXISTS (SELECT 1 FROM public.churches WHERE id = church_id AND admin_user_id = auth.uid()));

-- RLS for public.prayer_requests
CREATE POLICY "Users can view their own prayer requests." ON public.prayer_requests FOR SELECT USING (auth.uid() = user_id);
CREATE POLICY "Authenticated users can view public prayer requests." ON public.prayer_requests FOR SELECT USING (is_private = FALSE AND auth.role() = 'authenticated');
CREATE POLICY "Authenticated users can create prayer requests." ON public.prayer_requests FOR INSERT WITH CHECK (auth.uid() = user_id);
CREATE POLICY "Creator can update their own prayer request." ON public.prayer_requests FOR UPDATE USING (auth.uid() = user_id);
CREATE POLICY "Creator can delete their own prayer request." ON public.prayer_requests FOR DELETE USING (auth.uid() = user_id);
