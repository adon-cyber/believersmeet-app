(async function() {
  const client = window.supabaseClient || window.supabase;
  if (!client || !client.auth) {
    console.error("Supabase client is not initialized.");
    return;
  }

  const { data: { session } } = await client.auth.getSession();
  if (!session) return window.location.href = 'login.html';

  const { data: profile } = await client
    .from('profiles')
    .select('church_id, role')
    .eq('id', session.user.id)
    .single();

  const isSuperAdmin = profile?.role === 'super_admin';
  const hasChurch = profile?.church_id;

  if (window.location.pathname.includes('join-church.html')) {
    if (hasChurch || isSuperAdmin) window.location.href = 'index.html';
    else document.body.style.display = 'block';
    return;
  }

  if (!hasChurch && !isSuperAdmin) {
    window.location.href = 'join-church.html';
  } else {
    document.body.style.display = 'block';
  }
})();
