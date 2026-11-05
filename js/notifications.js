/**
 * js/notifications.js
 * In-App Notification System
 * - Real-time fetching from `notifications` table (id, user_id, title, message, is_read, created_at)
 * - Navbar Notification Bell UI with unread red indicator badge
 * - Dropdown menu with recent notifications and 'Mark all as read' button
 * - markAsRead(notificationId) and markAllAsRead() functions
 * - Global sendNotification(targetUserId, title, message) helper
 */

(function () {
    let sbClient = null;
    let currentUser = null;
    let notificationsChannel = null;

    async function updateNotificationCount() {
        if (!sbClient || !currentUser) return;
        try {
            const { count, error } = await sbClient
                .from('notifications')
                .select('*', { count: 'exact', head: true })
                .eq('is_read', false)
                .or(`user_id.eq.${currentUser.id},type.eq.broadcast`);

            if (error) {
                console.error('Error getting notification count:', error);
                return;
            }

            const unreadCount = count || 0;
            const badgeElements = document.querySelectorAll('#notification-badge, .notification-count, #notification-badge-count');
            badgeElements.forEach(el => {
                if (unreadCount > 0) {
                    const displayVal = unreadCount > 99 ? '99+' : unreadCount;
                    el.innerText = displayVal;
                    el.setAttribute('aria-label', `${unreadCount} unread notifications`);
                    el.classList.remove('hidden');
                } else {
                    el.classList.add('hidden');
                }
            });

            // Also support the numeric badge specifically if present or main #notification-badge
            const mainBadge = document.getElementById('notification-badge');
            if (mainBadge) {
                if (unreadCount > 0) {
                    const displayVal = unreadCount > 99 ? '99+' : unreadCount;
                    mainBadge.innerText = displayVal;
                    mainBadge.setAttribute('aria-label', `${unreadCount} unread notifications`);
                    mainBadge.classList.remove('hidden');
                } else {
                    mainBadge.classList.add('hidden');
                }
            }

            // Also support the dot indicator if present
            const badgeDot = document.getElementById('notification-badge-dot');
            if (badgeDot) {
                if (unreadCount > 0) {
                    badgeDot.classList.remove('hidden');
                } else {
                    badgeDot.classList.add('hidden');
                }
            }
        } catch (err) {
            console.error('Error in updateNotificationCount:', err);
        }
    }

    window.updateNotificationCount = updateNotificationCount;

    // Receive incoming video-call invitations on authenticated pages.
    function setupIncomingVideoCallSubscription() {
        if (!sbClient || !currentUser?.id) return;

        const userId = currentUser.id;
        const uuidPattern =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

        const processedInvitations = new Set();
        let channel = null;
        let queue = Promise.resolve();
        let pendingLoaded = false;

        async function handleIncomingInvitation(invitation) {
            if (
                !invitation ||
                !uuidPattern.test(invitation.id || '') ||
                invitation.recipient_id !== userId ||
                invitation.status !== 'ringing' ||
                processedInvitations.has(invitation.id)
            ) {
                return;
            }

            processedInvitations.add(invitation.id);

            try {
                // Ask PostgreSQL to decide whether the invitation
                // is still active. Do not rely on the browser clock.
                const { data: currentStatus, error: expiryError } =
                    await sbClient.rpc('expire_video_call_invitation', {
                        p_invitation_id: invitation.id
                    });

                if (expiryError) throw expiryError;
                if (currentStatus !== 'ringing') return;

                let callerName = 'a member';

                const { data: caller, error: callerError } = await sbClient
                    .from('profiles')
                    .select('full_name')
                    .eq('id', invitation.caller_id)
                    .maybeSingle();

                if (callerError) {
                    console.warn('Could not retrieve caller name:', callerError);
                } else {
                    callerName = caller?.full_name || callerName;
                }

                const accepted = window.confirm(
                    `Incoming video call from ${callerName}. Accept?`
                );

                const { data: responseStatus, error } = await sbClient.rpc(
                    'respond_to_video_call_invitation',
                    {
                        p_invitation_id: invitation.id,
                        p_action: accepted ? 'accepted' : 'declined'
                    }
                );

                if (error) throw error;

                if (accepted && responseStatus === 'accepted') {
                    window.location.assign(
                        `video-call.html?invitation=${encodeURIComponent(invitation.id)}`
                    );
                    return;
                }

                if (accepted) {
                    const messages = {
                        expired: 'This video-call invitation has expired.',
                        cancelled: 'This video-call invitation is no longer available.',
                        ended: 'This video call has already ended.'
                    };

                    window.alert(
                        messages[responseStatus] ||
                        'The video-call invitation could not be accepted.'
                    );
                }
            } catch (error) {
                processedInvitations.delete(invitation.id);
                console.error('Incoming video-call invitation failed:', error);
                window.alert(
                    error.message ||
                    'Could not process the incoming video-call invitation.'
                );
            }
        }

        function enqueueInvitation(invitation) {
            queue = queue.then(
                () => handleIncomingInvitation(invitation)
            );
        }

        async function loadPendingInvitations() {
            try {
                const { data, error } = await sbClient
                    .from('video_call_invitations')
                    .select('id, caller_id, recipient_id, status, created_at')
                    .eq('recipient_id', userId)
                    .eq('status', 'ringing')
                    .order('created_at', { ascending: false })
                    .limit(10);

                if (error) throw error;

                for (const invitation of data || []) {
                    enqueueInvitation(invitation);
                }
            } catch (error) {
                console.error('Could not load pending video-call invitations:', error);
            }
        }

        channel = sbClient
            .channel(`video-call-invitations-recipient-${userId}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'video_call_invitations',
                    filter: `recipient_id=eq.${userId}`
                },
                payload => enqueueInvitation(payload.new)
            )
            .subscribe(status => {
                if (status === 'SUBSCRIBED' && !pendingLoaded) {
                    pendingLoaded = true;
                    void loadPendingInvitations();
                }

                if (
                    status === 'CHANNEL_ERROR' ||
                    status === 'TIMED_OUT'
                ) {
                    console.error(
                        'Video-call invitation subscription status:',
                        status
                    );
                }
            });

        window.addEventListener('pagehide', () => {
            if (channel) void sbClient.removeChannel(channel);
        }, { once: true });

        console.log('Incoming video-call listener initialized.');
    }
    async function initInAppNotifications() {
        // Wait for Supabase client
        let attempts = 0;
        while (!window.sbClient && attempts < 20) {
            await new Promise(r => setTimeout(r, 150));
            attempts++;
        }
        sbClient = window.sbClient;
        if (!sbClient) return;

        try {
            const { data: { user } } = await sbClient.auth.getUser();
            if (!user) return;
            currentUser = user;
            setupIncomingVideoCallSubscription();

            // 1. Inject Notification Bell UI into nav bars if not already present
            injectNotificationBellUI();

            // 2. Fetch initial notifications & update count
            await loadNotifications();
            await updateNotificationCount();

            // 3. Setup real-time subscription for new notifications
            setupRealtimeSubscription();

        } catch (err) {
            console.error('Error initializing in-app notifications:', err);
        }
    }

    function injectNotificationBellUI() {
        // Prevent duplicate insertion
        if (document.getElementById('notification-bell-container')) return;

        // Try to find the right-side nav container (e.g. where user profile / logout button resides)
        // Usually headers have a flex container with profile.html link or logout button
        let targetContainer = null;

        // Strategy 1: Look for the right-side icons container (contains profile link or logout button)
        const logoutBtns = document.querySelectorAll('button[onclick*="logout"], a[href*="profile.html"], button[title*="Logout"]');
        for (const btn of logoutBtns) {
            const container = btn.closest('div');
            if (container && (container.classList.contains('flex') || container.classList.contains('items-center'))) {
                targetContainer = container;
                break;
            }
        }

        // Strategy 2: Fallback to theme toggles if any exist
        if (!targetContainer) {
            const themeToggles = document.querySelectorAll('button[onclick*="toggleTheme"], button[onclick*="window.toggleTheme"]');
            for (const toggleBtn of themeToggles) {
                const container = toggleBtn.closest('div');
                if (container) {
                    targetContainer = container;
                    break;
                }
            }
        }

        // Strategy 3: Fallback to header flex container right-end
        if (!targetContainer) {
            const headerFlex = document.querySelector('header .max-w-7xl, header .container, header div');
            if (headerFlex) {
                targetContainer = headerFlex.lastElementChild;
            }
        }

        if (!targetContainer) return;

        const bellWrapper = document.createElement('div');
        bellWrapper.id = 'notification-bell-container';
        bellWrapper.className = 'relative inline-block flex-shrink-0 ml-2 sm:ml-3';
        bellWrapper.innerHTML = `
            <button id="notification-bell-btn" onclick="toggleNotificationDropdown(event)"
                    class="relative p-2.5 rounded-xl bg-slate-800 dark:bg-slate-700 text-amber-400 dark:text-blue-300 hover:bg-slate-700 dark:hover:bg-slate-600 border border-slate-700 transition-all shadow-sm focus:outline-none flex items-center justify-center"
                    title="Notifications"
                    aria-label="Notifications">
                <i class="fas fa-bell text-lg"></i>
                <span id="notification-badge" class="absolute -top-1.5 -right-1.5 px-1.5 py-0.5 text-[10px] font-bold leading-none text-white bg-red-600 rounded-full border-2 border-white dark:border-gray-900 hidden shadow-md" aria-label="3 unread notifications"></span>
                <span id="notification-badge-dot" class="absolute -top-1 -right-1 w-3 h-3 bg-red-500 rounded-full border-2 border-white dark:border-gray-900 hidden"></span>
            </button>

            <!-- Dropdown / Slide-out panel -->
            <div id="notification-dropdown" class="hidden absolute right-0 mt-2 w-80 sm:w-96 bg-white dark:bg-gray-900 rounded-2xl shadow-2xl border border-gray-200 dark:border-gray-800 z-50 overflow-hidden transition-all duration-200 text-left">
                <div class="px-4 py-3 bg-gray-50 dark:bg-gray-800/80 border-b border-gray-200 dark:border-gray-800 flex justify-between items-center">
                    <h3 class="font-bold text-gray-900 dark:text-white text-sm flex items-center gap-2">
                        <i class="fas fa-bell text-blue-600"></i> Notifications
                    </h3>
                    <button onclick="markAllAsRead()" class="text-xs font-semibold text-blue-600 dark:text-blue-400 hover:underline">
                        Mark all as read
                    </button>
                </div>
                <div id="notification-list" class="max-h-96 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-800">
                    <div class="p-6 text-center text-sm text-gray-500 dark:text-gray-400">Loading notifications...</div>
                </div>
            </div>
        `;

        // Insert before logout button if present and a valid child of targetContainer, otherwise append
        const logoutBtn = targetContainer.querySelector('button[onclick*="logout"], button[title*="Logout"]');
        if (logoutBtn && logoutBtn.parentNode === targetContainer) {
            targetContainer.insertBefore(bellWrapper, logoutBtn);
        } else {
            targetContainer.appendChild(bellWrapper);
        }

        // Close dropdown when clicking outside
        document.addEventListener('click', (e) => {
            const dropdown = document.getElementById('notification-dropdown');
            const bellBtn = document.getElementById('notification-bell-btn');
            if (dropdown && !dropdown.classList.contains('hidden')) {
                if (!dropdown.contains(e.target) && !bellBtn.contains(e.target)) {
                    dropdown.classList.add('hidden');
                }
            }
        });
    }

    window.toggleNotificationDropdown = function(event) {
        if (event) event.stopPropagation();
        const dropdown = document.getElementById('notification-dropdown');
        if (dropdown) {
            dropdown.classList.toggle('hidden');
            if (!dropdown.classList.contains('hidden')) {
                loadNotifications();
            }
        }
    };

    window.loadNotifications = async function() {
        if (!sbClient || !currentUser) return [];

        let aggregated = [];

        try {
            // 1. Fetch user-specific notifications and general church-wide broadcasts
            const { data: sysNotifs, error: sysErr } = await sbClient
                .from('notifications')
                .select('*')
                .or(`user_id.eq.${currentUser.id},type.eq.broadcast`)
                .order('created_at', { ascending: false });

            if (!sysErr && sysNotifs) {
                aggregated.push(...sysNotifs);
            }

            // Also update live badge counter whenever notifications are loaded / fetched
            await updateNotificationCount();

            // 2. Fetch unread chat messages
            const { data: chatMsgs, error: chatErr } = await sbClient
                .from('messages')
                .select('id, content, created_at, sender_id')
                .eq('recipient_id', currentUser.id)
                .order('created_at', { ascending: false })
                .limit(10);

            if (!chatErr && chatMsgs && chatMsgs.length > 0) {
                chatMsgs.forEach(msg => {
                    aggregated.push({
                        id: 'chat-' + msg.id,
                        user_id: currentUser.id,
                        title: 'New Chat Message',
                        message: msg.content ? (msg.content.substring(0, 60) + (msg.content.length > 60 ? '...' : '')) : 'You received a new message.',
                        is_read: false,
                        created_at: msg.created_at,
                        type: 'chat'
                    });
                });
            }

            // 3. If user is admin/leader, check for pending ministry / prayer requests
            const { data: profile } = await sbClient
                .from('profiles')
                .select('role, church_id')
                .eq('id', currentUser.id)
                .maybeSingle();

            if (profile && (profile.role === 'admin' || profile.role === 'super_admin' || profile.role === 'super-admin')) {
                const churchId = profile.church_id;
                if (churchId) {
                    const { data: pendingConversions } = await sbClient
                        .from('conversion_requests')
                        .select('id, full_name, created_at')
                        .eq('church_id', churchId)
                        .eq('status', 'pending')
                        .limit(5);

                    if (pendingConversions && pendingConversions.length > 0) {
                        pendingConversions.forEach(c => {
                            aggregated.push({
                                id: 'conversion-' + c.id,
                                user_id: currentUser.id,
                                title: 'New Join / Conversion Request',
                                message: `${c.full_name || 'A believer'} submitted a conversion/join request.`,
                                is_read: false,
                                created_at: c.created_at,
                                type: 'ministry'
                            });
                        });
                    }

                    const { data: pendingPrayers } = await sbClient
                        .from('prayer_requests')
                        .select('id, full_name, created_at')
                        .eq('church_id', churchId)
                        .eq('status', 'pending')
                        .limit(5);

                    if (pendingPrayers && pendingPrayers.length > 0) {
                        pendingPrayers.forEach(p => {
                            aggregated.push({
                                id: 'prayer-' + p.id,
                                user_id: currentUser.id,
                                title: 'New Prayer Request',
                                message: `${p.full_name || 'Someone'} submitted a prayer request.`,
                                is_read: false,
                                created_at: p.created_at,
                                type: 'ministry'
                            });
                        });
                    }
                }
            }

            // 4. Check directory approvals for regular users
            const { data: myBiz } = await sbClient
                .from('business_directory')
                .select('id, business_name, status, is_approved, updated_at')
                .eq('user_id', currentUser.id)
                .limit(5);

            if (myBiz && myBiz.length > 0) {
                myBiz.forEach(b => {
                    const status = b.status || (b.is_approved ? 'approved' : 'pending');
                    if (status === 'approved' || status === 'rejected') {
                        aggregated.push({
                            id: 'biz-' + b.id,
                            user_id: currentUser.id,
                            title: `Business Listing ${status.toUpperCase()}`,
                            message: `Your business "${b.business_name}" status has been updated to ${status}.`,
                            is_read: true,
                            created_at: b.updated_at || new Date().toISOString(),
                            type: 'approval'
                        });
                    }
                });
            }

            // Sort aggregated by created_at descending
            aggregated.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

            renderNotificationsList(aggregated);
            return aggregated;
        } catch (err) {
            console.error('Error in loadNotifications:', err);
            renderNotificationsList([]);
            return [];
        } finally {
            // Ensure loading state is always cleared or handled gracefully
        }
    };

    window.fetchGlobalNotifications = window.loadNotifications;

    function renderNotificationsList(notifications) {
        const listContainer = document.getElementById('notification-list');
        const badgeDot = document.getElementById('notification-badge-dot');
        if (!listContainer) return;

        const unreadCount = notifications.filter(n => !n.is_read).length;

        // Update badge dot visibility
        if (badgeDot) {
            if (unreadCount > 0) {
                badgeDot.classList.remove('hidden');
            } else {
                badgeDot.classList.add('hidden');
            }
        }

        if (notifications.length === 0) {
            listContainer.innerHTML = `
                <div class="p-8 text-center text-gray-500 dark:text-gray-400 text-sm">
                    <i class="fas fa-bell-slash text-2xl mb-2 text-gray-400"></i>
                    <p>No notifications yet.</p>
                </div>
            `;
            return;
        }

        listContainer.innerHTML = notifications.map(n => {
            const timeAgo = formatTimeAgo(n.created_at);
            const targetLink = n.link ? n.link : '#';
            const readClass = n.is_read 
                ? 'bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-gray-800' 
                : 'bg-blue-50/70 dark:bg-blue-950/40 text-gray-900 dark:text-white font-semibold hover:bg-blue-100/70 dark:hover:bg-blue-900/40 border-l-4 border-blue-600';

            return `
                <a href="${targetLink}" onclick="handleNotificationClick(event, '${n.id}', '${targetLink}')" class="block p-4 transition-colors text-decoration-none ${readClass}" style="white-space: normal;">
                    <div class="flex justify-between items-start gap-2 mb-1">
                        <h4 class="font-semibold text-sm text-gray-900 dark:text-white">${escapeHtml(n.title)}</h4>
                        <span class="text-[10px] text-gray-400 whitespace-nowrap">${timeAgo}</span>
                    </div>
                    <p class="text-xs text-gray-600 dark:text-gray-300 leading-relaxed">${escapeHtml(n.message)}</p>
                    ${!n.is_read ? '<span class="inline-block mt-2 w-2 h-2 bg-blue-600 rounded-full"></span>' : ''}
                </a>
            `;
        }).join('');
    }

    // Keep track of ongoing markAsRead requests to avoid duplicate PATCH requests
    const activeMarkAsReadRequests = new Set();

    window.handleNotificationClick = async function(event, notificationId, targetLink) {
        try {
            await markAsRead(notificationId);
        } catch (err) {
            console.warn('Non-blocking error handling notification click markAsRead:', err);
        }

        if (!targetLink || targetLink === '#') return;

        if (targetLink.includes('#')) {
            const [pathPart, hashPart] = targetLink.split('#');
            const currentPath = window.location.pathname.split('/').pop() || 'index.html';
            const targetPage = pathPart ? pathPart.split('/').pop() : currentPath;

            if (!pathPart || targetPage === currentPath) {
                event.preventDefault();
                const targetElement = document.getElementById(hashPart);
                if (targetElement) {
                    targetElement.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    // Add subtle flash highlight effect
                    targetElement.classList.add('ring-4', 'ring-blue-400', 'transition-all', 'duration-500');
                    setTimeout(() => {
                        targetElement.classList.remove('ring-4', 'ring-blue-400');
                    }, 2000);
                } else {
                    console.warn(`Target element with id "${hashPart}" not found on page.`);
                }
            }
        }
    };

    window.markAsRead = async function(notificationId) {
        if (!sbClient) return;

        // Extract the raw UUID if a prefix was attached (e.g. 'prayer-1234-...')
        let cleanId = notificationId;
        const uuidMatch = notificationId.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        
        if (uuidMatch) {
            cleanId = uuidMatch[0];
        } else {
            console.warn('Invalid UUID format passed to markAsRead:', notificationId);
            return;
        }

        // Avoid duplicate PATCH requests if the same notification is clicked multiple times
        if (activeMarkAsReadRequests.has(cleanId)) {
            return;
        }
        activeMarkAsReadRequests.add(cleanId);

        try {
            // 1. Retrieve current session
            let { data: { session }, error: sessionError } = await sbClient.auth.getSession();

            // 2. If no session or session expired / expiring, try refreshing if refresh_token is available
            if (!session || sessionError) {
                if (sbClient.auth.refreshSession) {
                    try {
                        const { data: refreshData, error: refreshError } = await sbClient.auth.refreshSession();
                        if (!refreshError && refreshData && refreshData.session) {
                            session = refreshData.session;
                        }
                    } catch (refErr) {
                        console.warn('Session refresh attempt threw error:', refErr);
                    }
                }
            }

            // 3. Recheck session validity after refresh attempt
            if (!session) {
                console.warn('Session is missing or expired. Asking user to sign in again.');
                if (typeof window.showToast === 'function') {
                    window.showToast('Your session has expired. Please sign in again.', 'error');
                } else {
                    alert('Your session has expired. Please sign in again.');
                }
                return;
            }

            // 4. Perform the update using the authenticated client
            let { error } = await sbClient
                .from('notifications')
                .update({ is_read: true })
                .eq('id', cleanId);

            // 5. If update returns an authorization error (JWT expired / 401 / PGRST303), try one manual refresh and retry once
            if (error && (error.code === 'PGRST303' || error.status === 401 || (error.message && error.message.toLowerCase().includes('jwt')))) {
                console.warn('Encountered authorization error, attempting token refresh and single retry:', error);
                if (sbClient.auth.refreshSession) {
                    const { data: retryRefreshData, error: retryRefreshError } = await sbClient.auth.refreshSession();
                    if (!retryRefreshError && retryRefreshData && retryRefreshData.session) {
                        const retryRes = await sbClient
                            .from('notifications')
                            .update({ is_read: true })
                            .eq('id', cleanId);
                        error = retryRes.error;
                    }
                }
            }

            if (error) {
                console.error('Error marking notification as read after session validation/refresh:', error);
                if (error.code === 'PGRST303' || error.status === 401) {
                    if (typeof window.showToast === 'function') {
                        window.showToast('Authentication failed. Please sign in again.', 'error');
                    }
                }
                return;
            }

            // Refresh list and unread counts
            await loadNotifications();
        } catch (err) {
            console.error('Error in markAsRead:', err);
        } finally {
            activeMarkAsReadRequests.delete(cleanId);
        }
    };

    window.markAllAsRead = async function() {
        if (!sbClient || !currentUser) return;
        try {
            const { error } = await sbClient
                .from('notifications')
                .update({ is_read: true })
                .eq('user_id', currentUser.id)
                .eq('is_read', false);

            if (error) {
                console.error('Error marking all notifications as read:', error);
                return;
            }

            await loadNotifications();
        } catch (err) {
            console.error('Error in markAllAsRead:', err);
        }
    };

    function setupRealtimeSubscription() {
        if (!sbClient || !currentUser) return;
        if (notificationsChannel) {
            sbClient.removeChannel(notificationsChannel);
        }

        notificationsChannel = sbClient
            .channel('notifications')
            .on('postgres_changes', {
                event: 'INSERT',
                schema: 'public',
                table: 'notifications'
            }, payload => {
                if (payload.new && payload.new.user_id === currentUser.id) {
                    loadNotifications();
                    updateNotificationCount();
                }
            })
            .subscribe();
    }

    /**
     * Global Trigger Function: sendNotification
     * Inserts a new row into the notifications table.
     */
    window.sendNotification = async function(targetUserId, title, message) {
        let client = window.sbClient || sbClient;
        if (!client) {
            console.error('Supabase client not initialized for sendNotification');
            return { success: false, error: 'Supabase client not initialized' };
        }

        try {
            const { data, error } = await client
                .from('notifications')
                .insert([
                    {
                        user_id: targetUserId,
                        title: title,
                        message: message,
                        is_read: false
                    }
                ])
                .select();

            if (error) {
                console.error('Failed to send notification:', error);
                return { success: false, error };
            }

            return { success: true, data };
        } catch (err) {
            console.error('Exception in sendNotification:', err);
            return { success: false, error: err };
        }
    };

    function formatTimeAgo(dateString) {
        if (!dateString) return '';
        const date = new Date(dateString);
        const now = new Date();
        const seconds = Math.floor((now - date) / 1000);

        if (seconds < 60) return 'Just now';
        const minutes = Math.floor(seconds / 60);
        if (minutes < 60) return `${minutes}m ago`;
        const hours = Math.floor(minutes / 60);
        if (hours < 24) return `${hours}h ago`;
        const days = Math.floor(hours / 24);
        if (days < 7) return `${days}d ago`;
        return date.toLocaleDateString();
    }

    function escapeHtml(str) {
        if (!str) return '';
        return str
            .replace(/&/g, '&')
            .replace(/</g, '<')
            .replace(/>/g, '>')
            .replace(/"/g, '"')
            .replace(/'/g, '&#039;');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initInAppNotifications);
    } else {
        initInAppNotifications();
    }
})();
