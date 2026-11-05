// Global robust logout helper
window.logoutUser = async function(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    try {
        const client = window.sbClient || window.supabaseClient || window.supabase;
        if (client && client.auth) {
            await client.auth.signOut();
        }
    } catch (err) {
        console.error("Signout error:", err);
    }
    try {
        localStorage.clear();
        sessionStorage.clear();
    } catch (e) {}
    window.location.replace('login.html');
};

// Robust hash watcher that handles asynchronously rendered elements from Supabase
function handleUrlHashOnLoad() {
  if (!window.location.hash) return;
  
  const targetHash = window.location.hash; // e.g., "#messages-section"
  let attempts = 0;
  const maxAttempts = 25; // Try for up to 5 seconds while Supabase finishes loading
  
  const checkAndActivate = setInterval(() => {
    attempts++;
    const targetElement = document.querySelector(targetHash);
    
    if (targetElement) {
      clearInterval(checkAndActivate);
      
      // 1. Look for a tab trigger pointing to this element or its parent pane
      let tabTrigger = document.querySelector(`[data-bs-target="${targetHash}"], [href="${targetHash}"]`);
      
      if (!tabTrigger) {
        const parentPane = targetElement.closest('.tab-pane');
        if (parentPane) {
          tabTrigger = document.querySelector(`[data-bs-target="#${parentPane.id}"], [href="#${parentPane.id}"]`);
        }
      }

      // 2. Activate the Bootstrap tab if found
      if (tabTrigger) {
        if (typeof bootstrap !== 'undefined' && bootstrap.Tab) {
          bootstrap.Tab.getOrCreateInstance(tabTrigger).show();
        } else {
          tabTrigger.click();
        }
      }

      // 3. Scroll to the element and highlight it nicely
      setTimeout(() => {
        targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
        targetElement.classList.add('border', 'border-primary', 'shadow-lg');
        setTimeout(() => {
          targetElement.classList.remove('border', 'border-primary', 'shadow-lg');
        }, 2000);
      }, 150);
      
    } else if (attempts >= maxAttempts) {
      clearInterval(checkAndActivate);
      console.warn(`Hash target element '${targetHash}' did not appear in DOM after multiple attempts.`);
    }
  }, 200); // Check every 200ms until the element renders
}

// Trigger on full page load and when the hash changes dynamically
window.addEventListener('load', handleUrlHashOnLoad);
window.addEventListener('hashchange', handleUrlHashOnLoad);

(async () => {
    // 1. Wait for Supabase to initialize
    let retries = 0;
    while (!window.sbClient && retries < 20) { 
        await new Promise(r => setTimeout(r, 100)); 
        retries++; 
    }
   if (!window.sbClient) {
    const currentPath = window.location.pathname.toLowerCase();

    const isGuestAccessiblePage =
        currentPath.endsWith('giving.html') ||
        currentPath.endsWith('public-church.html');

    console.warn("Supabase client initialization timed out.");

    if (isGuestAccessiblePage && document.body) {
        document.body.style.display = '';
    }

    return;
}

    // 2. Allow Supabase time to parse URL hash tokens from email links
    if (window.location.hash.includes('access_token')) {
        await new Promise(r => setTimeout(r, 500)); 
    }

    // 3. Identify current page
    const currentPath = window.location.pathname.toLowerCase();

    const isTrialPage = currentPath.includes('trial'); 
const isPublicPage =
    currentPath.endsWith('index.html') ||
    currentPath.endsWith('login.html') ||
    currentPath.endsWith('signup.html') ||
    currentPath.endsWith('giving.html') ||
    currentPath.endsWith('public-church.html') ||
    currentPath === '/' ||
    currentPath === '';

const isAuthEntryPage =
    currentPath.endsWith('index.html') ||
    currentPath.endsWith('login.html') ||
    currentPath.endsWith('signup.html') ||
    currentPath === '/' ||
    currentPath === '';
    // 4. Get Session Safely
    const { data: { session } } = await window.sbClient.auth.getSession();

    // 5. Strict Role-Based Routing Logic
    if (session) {
        // User IS logged in
        // Fetch user profile to determine if they are an admin
        const { data: profile } = await window.sbClient
            .from('profiles')
            .select('*')
            .eq('id', session.user.id)
            .maybeSingle();
            
        // Determine administrator routing from the canonical profile role.
        const profileRole = profile && typeof profile.role === 'string'
            ? profile.role.trim().toLowerCase()
            : '';

        // Platform Super Admin status must come from the database allowlist.
        let isPlatformAdmin = false;

        try {
            const { data: platformAdminResult, error: platformAdminError } =
                await window.sbClient.rpc('is_super_admin');

            if (platformAdminError) throw platformAdminError;
            isPlatformAdmin = platformAdminResult === true;
        } catch (err) {
            console.warn('Platform administrator check failed (failing closed):', err);
        }

        const isAdmin = Boolean(profile) && (
            ['admin', 'church_admin'].includes(profileRole) ||
            isPlatformAdmin
        );

        if (isAuthEntryPage) {
            // Logged in users shouldn't be on index/login.
            if (isAdmin) {
                if (!profile.church_id) {
                    console.error("Admin user is missing church_id.");
                } else {
                    try {
                        const { data: churches, error: churchError } = await window.sbClient
                            .rpc('get_my_church_subscription');

                        const church = churches && churches.length > 0 ? churches[0] : null;

                        if (churchError) {
                            console.error("Error fetching church subscription status:", churchError);
                        } else if (!church) {
                            console.error("Associated church record not found for church_id:", profile.church_id);
                        } else {
                            const status = church.subscription_status;
                            const trialEndsAt = church.trial_ends_at ? new Date(church.trial_ends_at) : null;
                            const now = new Date();

                            // Determine if trial is expired
                            const isTrialExpired = trialEndsAt && trialEndsAt < now;

                            if (status === 'pending_trial') {
                                if (!currentPath.endsWith('activate-trial.html')) {
                                    window.location.replace('activate-trial.html');
                                    return;
                                }
                            } else if (status === 'trial') {
                                if (isTrialExpired) {
                                    if (!currentPath.endsWith('subscription-expired.html')) {
                                        window.location.replace('subscription-expired.html');
                                        return;
                                    }
                                } else {
                                    if (!currentPath.endsWith('admin.html')) {
                                        window.location.replace('admin.html');
                                        return;
                                    }
                                }
                            } else if (status === 'active' || status === 'paid') {
                                if (!currentPath.endsWith('admin.html')) {
                                    window.location.replace('admin.html');
                                    return;
                                }
                            } else {
                                // Fallback for unrecognized status or if no specific match
                                console.warn("Unrecognized church subscription status:", status);
                            }
                        }
                    } catch (err) {
                        console.error("Unexpected error in admin subscription check:", err);
                    }
                }

                // Fallback default redirect if subscription check didn't redirect
                if (!currentPath.endsWith('admin.html') && !currentPath.endsWith('activate-trial.html') && !currentPath.endsWith('subscription-expired.html')) {
                    window.location.replace('admin.html');
                }
            } else {
                window.location.replace('feed.html'); // Route normal members to feed
            }
        } else if (isTrialPage && !isAdmin) {
            // Kick NON-ADMINS out of the trial page immediately
            window.location.replace('feed.html');
        }
    } else {
        // User is NOT logged in
        if (!isPublicPage && !isTrialPage) {
            window.location.replace('index.html');
        }
    }

    if (document.body) {
        document.body.style.display = '';
    }
})();
