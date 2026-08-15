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

            // 1. Inject Notification Bell UI into nav bars if not already present
            injectNotificationBellUI();

            // 2. Fetch initial notifications
            await fetchAndRenderNotifications();

            // 3. Setup real-time subscription for new notifications
            setupRealtimeSubscription();

        } catch (err) {
            console.error('Error initializing in-app notifications:', err);
        }
    }

    function injectNotificationBellUI() {
        // Find all navbar flex containers or right-side buttons
        // We look for theme toggle buttons or logout links across navs
        const themeToggles = document.querySelectorAll('button[onclick*="toggleTheme"], button[onclick*="window.toggleTheme"]');
        
        themeToggles.forEach(toggleBtn => {
            const navContainer = toggleBtn.closest('div');
            if (!navContainer) return;

            // Check if notification container already exists here
            if (navContainer.querySelector('#notification-bell-container')) return;

            const bellWrapper = document.createElement('div');
            bellWrapper.id = 'notification-bell-container';
            bellWrapper.className = 'relative inline-block flex-shrink-0 ml-2 sm:ml-3';
            bellWrapper.innerHTML = `
                <button id="notification-bell-btn" onclick="toggleNotificationDropdown(event)" 
                        class="relative p-2.5 rounded-xl bg-slate-800 dark:bg-slate-700 text-amber-400 dark:text-blue-300 hover:bg-slate-700 dark:hover:bg-slate-600 border border-slate-700 transition-all shadow-sm focus:outline-none flex items-center justify-center"
                        title="Notifications"
                        aria-label="Notifications">
                    <i class="fas fa-bell text-lg"></i>
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

            // Insert before theme toggle or append
            navContainer.insertBefore(bellWrapper, toggleBtn);
        });

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
                fetchAndRenderNotifications();
            }
        }
    };

    async function fetchAndRenderNotifications() {
        if (!sbClient || !currentUser) return;
        try {
            const { data, error } = await sbClient
                .from('notifications')
                .select('*')
                .eq('user_id', currentUser.id)
                .order('created_at', { ascending: false })
                .limit(20);

            if (error) {
                console.error('Error fetching notifications:', error);
                return;
            }

            renderNotificationsList(data || []);
        } catch (err) {
            console.error('Error in fetchAndRenderNotifications:', err);
        }
    }

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
            const bgClass = n.is_read 
                ? 'bg-white dark:bg-gray-900 hover:bg-gray-50 dark:hover:bg-gray-800' 
                : 'bg-blue-50/70 dark:bg-blue-950/40 hover:bg-blue-100/70 dark:hover:bg-blue-900/40 border-l-4 border-blue-600';

            return `
                <div onclick="markAsRead('${n.id}')" class="p-4 cursor-pointer transition-colors ${bgClass}">
                    <div class="flex justify-between items-start gap-2">
                        <h4 class="font-semibold text-sm text-gray-900 dark:text-white">${escapeHtml(n.title)}</h4>
                        <span class="text-[10px] text-gray-400 whitespace-nowrap">${timeAgo}</span>
                    </div>
                    <p class="text-xs text-gray-600 dark:text-gray-300 mt-1 leading-relaxed">${escapeHtml(n.message)}</p>
                    ${!n.is_read ? '<span class="inline-block mt-2 w-2 h-2 bg-blue-600 rounded-full"></span>' : ''}
                </div>
            `;
        }).join('');
    }

    window.markAsRead = async function(notificationId) {
        if (!sbClient) return;
        try {
            const { error } = await sbClient
                .from('notifications')
                .update({ is_read: true })
                .eq('id', notificationId);

            if (error) {
                console.error('Error marking notification as read:', error);
                return;
            }

            // Refresh list
            await fetchAndRenderNotifications();
        } catch (err) {
            console.error('Error in markAsRead:', err);
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

            await fetchAndRenderNotifications();
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
            .channel('public:notifications:' + currentUser.id)
            .on('postgres_changes', {
                event: '*',
                schema: 'public',
                table: 'notifications',
                filter: `user_id=eq.${currentUser.id}`
            }, payload => {
                fetchAndRenderNotifications();
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
