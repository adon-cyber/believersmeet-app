// utils.js
async function blockUser(targetUserId) {
    // We get the current user session directly here instead of relying on a global variable
    const { data: { user } } = await window.sbClient.auth.getUser();
    if (!user) return;
    
    const { error } = await window.sbClient
        .from('blocks')
        .insert([{ blocker_id: user.id, blocked_id: targetUserId }]);

    if (error) {
        alert("Could not block user: " + error.message);
    } else {
        alert("User blocked successfully.");
        // Instead of a full reload, we can call a render function if it exists
        if (typeof fetchAndRenderWallTimeline === 'function') {
            fetchAndRenderWallTimeline();
        } else {
            location.reload(); // Fallback
        }
    }
}