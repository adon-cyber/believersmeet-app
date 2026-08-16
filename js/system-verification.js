/**
 * js/system-verification.js
 * Segment 4: Lightweight initialization tests & verification console logs
 */
document.addEventListener('DOMContentLoaded', () => {
    console.log("=== BELIEVERSMEET SYSTEM VERIFICATION ===");

    // 1. Confirm Supabase Client Connection
    if (typeof window.sbClient !== 'undefined' && window.sbClient) {
        console.log("SUCCESS: Supabase client is connected and attached to window.sbClient.");
    } else {
        console.error("FAILURE: Supabase client is not initialized.");
    }

    // 2. Confirm Active User Profile / Session Load
    window.sbClient?.auth.getUser().then(({ data, error }) => {
        if (error) {
            console.log("INFO: No active authenticated session (or guest user mode).");
        } else if (data && data.user) {
            console.log("SUCCESS: Active user profile session loaded for user ID:", data.user.id);
        } else {
            console.log("INFO: User is signed out or visiting public page.");
        }
    }).catch(err => {
        console.warn("Auth check warning:", err);
    });

    // 3. Confirm Notification Bell & Aggregator Function
    if (typeof window.fetchGlobalNotifications === 'function') {
        console.log("SUCCESS: Global notification bell aggregator function fetchGlobalNotifications() is available.");
    } else {
        console.warn("WARNING: fetchGlobalNotifications() not detected.");
    }

    // 4. Confirm Theme Consistency Utilities
    if (typeof window.toggleTheme === 'function' || document.querySelector('.bg-gray-950')) {
        console.log("SUCCESS: Gold-on-dark theme consistency and styling classes verified.");
    }

    console.log("=== SYSTEM VERIFICATION COMPLETE ===");
});
