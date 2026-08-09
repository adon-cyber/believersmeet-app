(async function() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) return window.location.href = 'login.html';

  const { data: profile } = await supabase
    .from('profiles')
    .select('church_id, role')
    .eq('id', session.user.id)
    .single();

  const isSuperAdmin = profile?.role === 'super_admin';
  const hasChurch = profile?.church_id;

  // If on join-church page and already has a church, send them to index
  if (window.location.pathname.includes('join-church.html')) {
    if (hasChurch || isSuperAdmin) window.location.href = 'index.html';
    else document.body.style.display = 'block';
    return;
  }

  // If on a protected page and has NO church, send them to join
  if (!hasChurch && !isSuperAdmin) {
    window.location.href = 'join-church.html';
  } else {
    document.body.style.display = 'block';
  }
})();
