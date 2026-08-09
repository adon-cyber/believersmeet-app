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

  if (hasChurch && !isSuperAdmin) {
    const { data: church, error: churchError } = await client
      .from('churches')
      .select('trial_ends_at, subscription_status')
      .eq('id', hasChurch)
      .single();

    if (church) {
      // If church is in pending_trial status, redirect to activate-trial.html
      if (church.subscription_status === 'pending_trial') {
        if (!window.location.pathname.includes('activate-trial.html')) {
          return window.location.href = 'activate-trial.html';
        }
      } else if (window.location.pathname.includes('activate-trial.html')) {
        return window.location.href = 'index.html';
      }

      const now = new Date();
      const trialEndsAt = church.trial_ends_at ? new Date(church.trial_ends_at) : null;
      
      // If trial is expired and they haven't paid/upgraded
      if (trialEndsAt && now > trialEndsAt && church.subscription_status === 'trial') {
        // Allow them to see the expired page, prevent infinite loop
        if (!window.location.pathname.includes('subscription-expired.html')) {
          return window.location.href = 'subscription-expired.html';
        }
      } else {
        // If they are on the expired page but shouldn't be, send them to index
        if (window.location.pathname.includes('subscription-expired.html')) {
          return window.location.href = 'index.html';
        }
      }
    }
  } else {
    if (window.location.pathname.includes('subscription-expired.html') || window.location.pathname.includes('activate-trial.html')) {
      return window.location.href = 'index.html';
    }
  }

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
