/**
 * js/notifications.js
 * Real-time unread messages notification logic using Supabase.
 */

(function () {
  async function initNotifications() {
    // Wait for supabase client to be available
    if (typeof window.supabase === 'undefined' && typeof window.supabaseClient === 'undefined') {
      setTimeout(initNotifications, 500);
      return;
    }

    const client = window.supabaseClient || window.supabase;
    if (!client) return;

    try {
      const { data: { user }, error } = await client.auth.getUser();
      if (error || !user) return;

      const userId = user.id;

      // Function to fetch and update unread count
      async function updateUnreadCount() {
        try {
          const { count, error: countError } = await client
            .from('messages')
            .select('*', { count: 'exact', head: true })
            .eq('recipient_id', userId)
            .eq('is_read', false);

          if (!countError) {
            updateBadgeUI(count || 0);
          }
        } catch (err) {
          console.error('Error fetching unread count:', err);
        }
      }

      function updateBadgeUI(count) {
        // Find all inbox links and update/inject badge
        const inboxLinks = document.querySelectorAll('a[href="chat.html"], a[href="./chat.html"]');
        inboxLinks.forEach(link => {
          let badge = link.querySelector('.notification-badge');
          if (count > 0) {
            if (!badge) {
              badge = document.createElement('span');
              badge.className = 'notification-badge';
              badge.style.cssText = 'background-color: red; color: white; border-radius: 50%; padding: 2px 6px; font-size: 10px; margin-left: 5px; vertical-align: middle; font-weight: bold;';
              link.appendChild(badge);
            }
            badge.textContent = count > 99 ? '99+' : count;
          } else {
            if (badge) {
              badge.remove();
            }
          }
        });
      }

      // Initial fetch
      await updateUnreadCount();

      // Setup realtime subscription for messages table
      client
        .channel('public:messages')
        .on('postgres_changes', {
          event: '*',
          schema: 'public',
          table: 'messages',
          filter: `recipient_id=eq.${userId}`
        }, payload => {
          updateUnreadCount();
        })
        .subscribe();

    } catch (err) {
      console.error('Error initializing notifications:', err);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNotifications);
  } else {
    initNotifications();
  }
})();
