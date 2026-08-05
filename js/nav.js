// Central Navigation Script (`js/nav.js`) - Option 1: Scrollable Row
(function() {
    async function initScrollableNav() {
        const navbarContainer = document.getElementById('navbar');
        if (!navbarContainer) {
            return;
        }

        let isAdminOrLeader = false;
        try {
            let attempts = 0;
            while (!window.sbClient && attempts < 15) {
                await new Promise(r => setTimeout(r, 150));
                attempts++;
            }
            if (window.sbClient) {
                const { data: { user } } = await window.sbClient.auth.getUser();
                if (user) {
                    const { data: profile } = await window.sbClient
                        .from('profiles')
                        .select('role, church_id')
                        .eq('id', user.id)
                        .maybeSingle();
                    
                    const currentPath = window.location.pathname.split('/').pop() || 'feed.html';
                    const isJoinPage = currentPath === 'join-church.html' || currentPath === 'register-church.html';

                    if (profile && !profile.church_id && !isJoinPage && !currentPath.includes('login') && !currentPath.includes('signup')) {
                        window.location.replace('join-church.html');
                        return;
                    }

                    if (profile && (profile.role === 'admin' || profile.role === 'super_admin' || profile.role === 'leader')) {
                        isAdminOrLeader = true;
                    }
                }
            }
        } catch (err) {
            console.warn("Could not fetch user profile for admin check in navigation:", err);
        }

        const options = [
            { href: 'feed.html', label: 'My Feed' },
            { href: 'giving.html', label: 'Giving' },
            { href: 'sermons.html', label: 'Sermons' },
            { href: 'groups.html', label: 'Small Groups' },
            { href: 'prayer-wall.html', label: 'Prayer Wall' },
            { href: 'testimonies.html', label: 'Testimonies' },
            { href: 'inboxx.html', label: 'Inbox' },
            { href: 'events.html', label: 'Events' },
            { href: 'profile.html', label: 'Profile' }
        ];

        if (isAdminOrLeader) {
            options.push({ href: 'admin.html', label: '⚙️ Admin Panel' });
        }

        const currentFilename = window.location.pathname.split('/').pop() || 'feed.html';

        navbarContainer.innerHTML = `
            <nav class="bg-blue-600 sticky top-0 z-50 shadow-md" style="background-color: #2563eb !important; border-bottom: 1px solid #1d4ed8 !important; position: sticky; top: 0; z-index: 1000; box-shadow: 0 1px 3px rgba(0,0,0,0.1);">
                <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div class="flex justify-between items-center h-16">
                        <a href="feed.html" class="text-xl font-bold text-white hover:text-blue-200 flex-shrink-0 mr-4" style="color: #ffffff !important;">BelieversMeet</a>
                        <div class="nav-scrollable-row no-scrollbar flex items-center space-x-1 sm:space-x-3 py-2 px-4">
                            ${options.map(opt => {
                                const isActive = currentFilename === opt.href;
                                const activeClasses = isActive ? 'font-medium text-white bg-blue-700 px-2 py-1 rounded-md transition-colors' : 'font-medium text-white hover:text-blue-200 px-2 py-1 rounded-md transition-colors';
                                return `<a href="${opt.href}" class="text-xs sm:text-sm ${activeClasses}" style="color: #ffffff !important;">${opt.label}</a>`;
                            }).join('')}
                            <a href="#" onclick="if(window.sbClient) { window.sbClient.auth.signOut().then(() => window.location.href='login.html'); } else { window.location.href='login.html'; }" class="text-xs sm:text-sm font-medium text-red-200 hover:text-white px-2 py-1 rounded-md transition-colors flex-shrink-0" style="color: #fecaca !important;">Logout</a>
                        </div>
                    </div>
                </div>
            </nav>
        `;
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScrollableNav);
    } else {
        initScrollableNav();
    }
})();
