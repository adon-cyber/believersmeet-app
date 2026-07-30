// js/supabase.js
const SUPABASE_URL = 'https://tgwbhvutozgcmnthxhzo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRnd2JodnV0b3pnY21udGh4aHpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NTkwOTQsImV4cCI6MjA5NzQzNTA5NH0.4pDoAZU8nHxGyE8ad3DCfhJEQCPrWA148QERjtE_ooQ';

// Initialize the Supabase client once and attach globally to both window.supabaseClient and window.sbClient
if (!window.supabaseClient) {
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
        const { error } = await window.sbClient.auth.signOut();
        if (error) {
            console.error("Error signing out:", error.message);
        }
    } catch (err) {
        console.error("Unexpected error during logout:", err);
    } finally {
        window.location.href = 'login.html';
    }
}
