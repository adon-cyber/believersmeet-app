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
                    const isSuperAdmin = user.email === 'adoniakasango@gmail.com';
                    const { data: profile } = await window.sbClient
                        .from('profiles')
                        .select('role, church_id')
                        .eq('id', user.id)
                        .maybeSingle();
                    
                    const currentPath = window.location.pathname.split('/').pop() || 'feed.html';
                    const isJoinPage = currentPath === 'join-church.html' || currentPath === 'register-church.html';

                    if (!isSuperAdmin && profile && profile.role !== 'super_admin' && !profile.church_id && !isJoinPage && !currentPath.includes('login') && !currentPath.includes('signup')) {
                        window.location.replace('join-church.html');
                        return;
                    }

                    if (isSuperAdmin || (profile && (profile.role === 'admin' || profile.role === 'super_admin' || profile.role === 'leader'))) {
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
            { href: 'gallery.html', label: 'Gallery' },
            { href: 'profile.html', label: 'Profile' }
        ];

        if (isAdminOrLeader) {
            options.push({ href: 'admin.html', label: '⚙️ Admin Panel' });
        }

        const currentFilename = window.location.pathname.split('/').pop() || 'feed.html';

        navbarContainer.innerHTML = `
            <nav class="sticky top-0 z-50 py-3 px-4" style="position: sticky; top: 0; z-index: 1000;">
                <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div class="flex justify-between items-center h-16">
                        <a href="feed.html" class="text-xl font-bold text-gray-900 hover:text-blue-600 flex-shrink-0 mr-4">BelieversMeet</a>
                        <div class="nav-scrollable-row no-scrollbar flex flex-wrap items-center justify-center gap-3 p-4">
                            ${options.map(opt => {
                                const isActive = currentFilename === opt.href;
                                const activeClasses = isActive 
                                    ? 'bg-blue-600 text-white shadow-md hover:bg-blue-700 hover:text-white' 
                                    : 'bg-white text-gray-700 hover:bg-blue-50 hover:text-blue-600';
                                return `<a href="${opt.href}" class="px-5 py-2.5 rounded-full text-sm font-semibold transition-all duration-300 ease-in-out shadow-sm hover:shadow-md hover:-translate-y-1 ${activeClasses}">${opt.label}</a>`;
                            }).join('')}
                            <a href="#" onclick="if(window.sbClient) { window.sbClient.auth.signOut().then(() => window.location.href='login.html'); } else { window.location.href='login.html'; }" class="px-5 py-2.5 rounded-full text-sm font-semibold transition-all duration-300 ease-in-out shadow-sm hover:shadow-md hover:-translate-y-1 bg-white text-red-600 hover:bg-red-50 flex-shrink-0">Logout</a>
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
