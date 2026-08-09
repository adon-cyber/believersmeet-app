(async function() {
    const client = window.supabaseClient || window.supabase;
    if (!client) {
        console.error("Supabase client not initialized.");
        return;
    }

    // Get current session/user
    const { data: { session }, error: sessionError } = await client.auth.getSession();
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
        window.location.href = 'login.html';
        return;
    }

    // 2. If user IS logged in, handle profile/church specific checks
    if (user) {
        // Prevent logged-in users from lingering on auth pages like login/signup
        if (currentPath.includes('login.html') || currentPath.includes('signup.html')) {
            window.location.href = 'index.html';
            return;
        }

        // Fetch user profile
        const { data: profile } = await client
            .from('profiles')
            .select('church_id, role')
            .eq('id', user.id)
            .single();

        const hasChurch = profile?.church_id;
        const isSuperAdmin = profile?.role === 'super_admin';

        // Allow join-church page if user doesn't have a church and is not a super_admin
        if (currentPath.includes('join-church.html')) {
            if (hasChurch || isSuperAdmin) {
                window.location.href = 'index.html';
                return;
            } else {
                document.body.style.display = 'block';
                return;
            }
        }

        // Allow register-church page
        if (currentPath.includes('register-church.html')) {
            document.body.style.display = 'block';
            return;
        }

        // If user does not have a church and is not super admin, redirect to join-church unless public or register-church
        if (!hasChurch && !isSuperAdmin && !isPublicPage) {
            window.location.href = 'join-church.html';
            return;
        }

        // 3. Subscription & Trial Enforcement (for church admins/members, skipping super_admins)
        if (hasChurch && !isSuperAdmin) {
            const { data: church } = await client
                .from('churches')
                .select('trial_ends_at, subscription_status')
                .eq('id', hasChurch)
                .single();

            if (church) {
                // If trial pending activation onboarding step
                if (church.subscription_status === 'pending_trial') {
                    if (!currentPath.includes('activate-trial.html')) {
                        window.location.href = 'activate-trial.html';
                        return;
                    }
                } else if (currentPath.includes('activate-trial.html')) {
                    // If already activated, don't stay on activation page
                    window.location.href = 'index.html';
                    return;
                }

                // Check for trial expiration
                if (church.trial_ends_at && church.subscription_status === 'trial') {
                    const now = new Date();
                    const trialEndsAt = new Date(church.trial_ends_at);

                    if (now > trialEndsAt) {
                        if (!currentPath.includes('subscription-expired.html')) {
                            window.location.href = 'subscription-expired.html';
                            return;
                        }
                    } else {
                        if (currentPath.includes('subscription-expired.html')) {
                            window.location.href = 'index.html';
                            return;
                        }
                    }
                }
            }
        }
    }

    // Show body if all checks pass and we haven't redirected
    if (document.body) {
        document.body.style.display = 'block';
    }
})();
