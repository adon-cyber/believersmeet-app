// js/supabase.js
// SUPABASE_URL and SUPABASE_ANON_KEY are declared in js/supabase-config.js.
// Helper methods and wrappers for Supabase client.

// Initialize the Supabase client once and attach globally to both window.supabaseClient and window.sbClient
if (typeof supabase !== 'undefined' && !window.supabaseClient) {
    window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
}
window.sbClient = window.supabaseClient;
console.log("Supabase Client initialized via js/supabase.js.");

/**
 * Check active session and return the current user.
 * @returns {Promise<import('@supabase/supabase-js').User|null>}
 */
async function getCurrentUser() {
    try {
        if (!window.sbClient) return null;
        const { data: { session }, error } = await window.sbClient.auth.getSession();
        if (error) {
            console.error("Error getting session:", error.message);
            return null;
        }
        return session?.user || null;
    } catch (err) {
        console.error("Unexpected error in getCurrentUser:", err);
        return null;
    }
}

/**
 * Check active session; if unauthenticated, redirect to login.html.
 * @returns {Promise<import('@supabase/supabase-js').User|null>}
 */
async function requireAuth() {
    const user = await getCurrentUser();
    if (!user) {
        window.location.href = 'login.html';
    }
    return user;
}

/**
 * Clear session and redirect to login.html.
 */
async function logout() {
    try {
        if (window.sbClient) {
            const { error } = await window.sbClient.auth.signOut();
            if (error) {
                console.error("Error signing out:", error.message);
            }
        }
    } catch (err) {
        console.error("Unexpected error during logout:", err);
    } finally {
        window.location.href = 'login.html';
    }
}
