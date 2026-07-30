// js/auth-guard.js
(async function() {
    // Skip guard if we are on public entry pages
    const path = window.location.pathname;
    const publicPages = ['login.html', 'signup.html', 'join-church.html', 'register-church.html', 'forgot-password.html', 'reset-password.html', 'index.html', 'setup.html'];
    const isPublic = publicPages.some(page => path.endsWith(page) || path === '/' || path === '');
    if (isPublic) {
        return;
    }

    // Helper to wait for Supabase client
    async function waitForSupabase() {
        let attempts = 0;
        while (!window.sbClient && attempts < 50) {
            await new Promise(r => setTimeout(r, 50));
            attempts++;
        }
        return window.sbClient;
    }

    const sb = await waitForSupabase();
    if (!sb) {
        // If supabase client fails to load, fail safe by redirecting to login
        window.location.replace('login.html');
        return;
    }

    try {
        // 1. Check authenticated user session
        const { data: { session }, error: sessionError } = await sb.auth.getSession();
        if (sessionError || !session || !session.user) {
            window.location.replace('login.html');
            return;
        }

        const user = session.user;

        // 2. Check localStorage cache for church_id
        let churchId = localStorage.getItem('church_id');

        // 3. If missing from localStorage, query Supabase profiles table
        if (!churchId) {
            const { data: profile, error: profileError } = await sb
                .from('profiles')
                .select('church_id, role')
                .eq('id', user.id)
                .maybeSingle();

            if (profileError || !profile || !profile.church_id) {
                // If user is admin/church, maybe they registered a church but need setup/register page
                if (profile && (profile.role === 'admin' || profile.role === 'super_admin')) {
                    // Let admins pass or redirect to register/dashboard if needed, but per instructions missing church_id redirects to entry page
                    // Wait, let's check if they have a church registered or if role is admin. Actually prompt says:
                    // "If the Church ID is missing, or invalid, immediately redirect the user to the Church ID entry page (e.g., window.location.href = 'church-entry.html';)."
                    // Here our entry page is join-church.html (or register-church.html for admins).
                    if (profile.role === 'admin') {
                        window.location.replace('register-church.html');
                    } else {
                        window.location.replace('join-church.html');
                    }
                    return;
                } else {
                    window.location.replace('join-church.html');
                    return;
                }
            }

            churchId = profile.church_id;
            localStorage.setItem('church_id', churchId);
        }

        // 4. Validate churchId against churches table to ensure it's valid and exists
        const { data: church, error: churchError } = await sb
            .from('churches')
            .select('id')
            .eq('id', churchId)
            .maybeSingle();

        if (churchError || !church) {
            localStorage.removeItem('church_id');
            window.location.replace('join-church.html');
            return;
        }

        // Successfully validated church ID session
    } catch (err) {
        console.error("Auth guard error:", err);
        window.location.replace('login.html');
    }
})();
