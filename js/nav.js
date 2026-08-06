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
            { href: 'feed.html', label: '🌍 Feed' },
            { href: 'giving.html', label: 'Giving' },
            { href: 'sermons.html', label: '🎙️ Sermons' },
            { href: 'groups.html', label: '🏡 Small Groups' },
            { href: 'prayer-wall.html', label: '🙏 Prayer Wall' },
            { href: 'testimonies.html', label: '🙌 Testimonies' },
            { href: 'inboxx.html', label: '✉️ Inbox' },
            { href: 'events.html', label: '📅 Events' },
            { href: 'profile.html', label: '👤 Profile' },
            { href: 'settings.html', label: 'Settings' }
        ];

        if (isAdminOrLeader) {
            options.push({ href: 'admin.html', label: '⚙️ Admin Panel' });
        }

        const currentFilename = window.location.pathname.split('/').pop() || 'feed.html';

        navbarContainer.innerHTML = `
            <nav class="bg-blue-600 shadow-md sticky top-0 z-50" style="background-color: #007bff !important;">
                <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div class="flex justify-between items-center h-16">
                        <div class="flex items-center space-x-3 flex-shrink-0 mr-4">
                            <a href="feed.html" class="text-xl font-bold text-white flex items-center" style="color: #ffffff !important;">
                                <img src="BELIEVERS.LOGO.png" alt="Logo" class="w-8 h-8 rounded-full object-cover mr-2 bg-white p-0.5"> BelieversMeet
                            </a>
                        </div>
                        <div class="nav-scrollable-row no-scrollbar flex items-center space-x-1 sm:space-x-3 py-2 px-2">
                            ${options.map(opt => {
                                const isActive = currentFilename === opt.href;
                                const activeClasses = isActive ? 'font-bold text-blue-600 bg-white px-3 py-1.5 rounded-md shadow-sm' : 'font-medium text-white hover:text-blue-200 px-3 py-1.5 rounded-md transition-colors';
                                return `<a href="${opt.href}" class="text-xs sm:text-sm ${activeClasses}" style="${isActive ? 'color: #007bff !important;' : 'color: #ffffff !important;'}">${opt.label}</a>`;
                            }).join('')}
                            <a href="#" onclick="if(window.sbClient) { window.sbClient.auth.signOut().then(() => window.location.href='login.html'); } else { window.location.href='login.html'; }" class="text-xs sm:text-sm font-medium text-red-200 hover:text-white px-3 py-1.5 rounded-md transition-colors flex-shrink-0" style="color: #fecaca !important;">Logout</a>
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
