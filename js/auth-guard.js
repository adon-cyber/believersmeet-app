// Global robust logout helper
window.logoutUser = async function(e) {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
    try {
        const client = window.supabaseClient || window.supabase;
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

(async function() {
    try {
        const client = window.supabaseClient || window.supabase;
        if (!client) {
            console.error("Supabase client not initialized.");
            if (document.body) {
                document.body.style.display = 'block';
            }
            return;
        }

        // Wait for session to fully resolve or use getSession with safety timeout
        let session = null;
        let sessionError = null;
        try {
            const res = await client.auth.getSession();
            session = res.data?.session;
            sessionError = res.error;
        } catch (sessErr) {
            console.error("Session fetch exception:", sessErr);
        }

        if (sessionError) {
            console.error("Auth session error:", sessionError);
        }
        const user = session?.user;

        const currentPath = window.location.pathname;

        // Define pages that do not require an active session
        const publicPages = [
            '/', 
            '/index.html', 
            '/login.html', 
            '/signup.html', 
            '/register-church.html', 
            '/join-church.html', 
            '/subscription-expired.html',
            '/public-profile.html'
        ];

        const isPublicPage = publicPages.some(page => currentPath.endsWith(page)) || currentPath === '/' || currentPath === '';

        // 1. If user is NOT logged in and trying to access a protected page -> Redirect to login
        if (!user && !isPublicPage) {
            window.location.replace('login.html');
            return;
        }

        // 2. If user IS logged in, handle profile/church specific checks
        if (user) {
            // Prevent logged-in users from lingering on auth pages like login/signup
            if (currentPath.includes('login.html') || currentPath.includes('signup.html')) {
                window.location.replace('feed.html');
                return;
            }

            // Fetch user profile with fallback/safety
            let profile = null;
            try {
                const { data: profileData, error: profileError } = await client
                    .from('profiles')
                    .select('church_id, role')
                    .eq('id', user.id)
                    .single();
                
                if (profileError) {
                    console.warn("Profile fetch warning:", profileError);
                } else {
                    profile = profileData;
                }
            } catch (profileErr) {
                console.error("Exception fetching profile:", profileErr);
            }

            const hasChurch = profile?.church_id;
            const isSuperAdmin = profile?.role === 'super_admin';

            // Allow join-church page if user doesn't have a church and is not a super_admin
            if (currentPath.includes('join-church.html')) {
                if (hasChurch || isSuperAdmin) {
                    window.location.replace('feed.html');
                    return;
                } else {
                    if (document.body) document.body.style.display = 'block';
                    return;
                }
            }

            // Allow register-church page
            if (currentPath.includes('register-church.html')) {
                if (document.body) document.body.style.display = 'block';
                return;
            }

            // If user does not have a church and is not super admin, redirect to join-church unless public or register-church
            if (!hasChurch && !isSuperAdmin && !isPublicPage) {
                window.location.replace('join-church.html');
                return;
            }

            // 3. Subscription & Trial Enforcement (for church admins/members, skipping super_admins)
            if (hasChurch && !isSuperAdmin) {
                try {
                    // Check local storage cache first to avoid unnecessary blocking roundtrips or race conditions
                    let localStatus = localStorage.getItem('church_subscription_status');
                    let church = null;

                    if (localStatus === 'trial') {
                        church = { subscription_status: 'trial' };
                    } else {
                        const localChurchStr = localStorage.getItem('current_church');
                        if (localChurchStr) {
                            try {
                                const parsed = JSON.parse(localChurchStr);
                                if (parsed && parsed.subscription_status) {
                                    church = parsed;
                                    if (parsed.subscription_status === 'trial') {
                                        localStorage.setItem('church_subscription_status', 'trial');
                                    }
                                }
                            } catch (e) {
                                // ignore parse error
                            }
                        }
                    }

                    // If not found in local cache, fetch fresh un-cached profile/church from Supabase
                    if (!church) {
                        const { data: churchData, error: churchError } = await client
                            .from('churches')
                            .select('trial_ends_at, subscription_status')
                            .eq('id', hasChurch)
                            .single();

                        if (!churchError && churchData) {
                            church = churchData;
                            localStorage.setItem('current_church', JSON.stringify(churchData));
                            if (churchData.subscription_status) {
                                localStorage.setItem('church_subscription_status', churchData.subscription_status);
                            }
                        }
                    }

                    if (church) {
                        // If trial pending activation onboarding step
                        if (church.subscription_status === 'pending_trial') {
                            if (!currentPath.includes('activate-trial.html')) {
                                window.location.replace('activate-trial.html');
                                return;
                            }
                        } else if (currentPath.includes('activate-trial.html') && church.subscription_status === 'trial') {
                            // If already activated, don't stay on activation page
                            window.location.replace('feed.html');
                            return;
                        }

                        // Check for trial expiration
                        if (church.trial_ends_at && church.subscription_status === 'trial') {
                            const now = new Date();
                            const trialEndsAt = new Date(church.trial_ends_at);

                            if (now > trialEndsAt) {
                                if (!currentPath.includes('subscription-expired.html')) {
                                    window.location.replace('subscription-expired.html');
                                    return;
                                }
                            } else {
                                if (currentPath.includes('subscription-expired.html')) {
                                    window.location.replace('feed.html');
                                    return;
                                }
                            }
                        }
                    }
                } catch (churchErr) {
                    console.error("Exception checking church subscription:", churchErr);
                }
            }
        }

        // Show body if all checks pass and we haven't redirected
        if (document.body) {
            document.body.style.display = '';
        }
    } catch (err) {
        console.error("Auth guard error:", err);
        // Fallback safely to show body so the page never stays blank
        if (document.body) {
            document.body.style.display = '';
        }
    }
})();
