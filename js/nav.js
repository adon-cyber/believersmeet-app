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
                    const isSuperAdmin = user.email === 'adonstance@gmail.com';
                    const { data: profile } = await window.sbClient
                        .from('profiles')
                        .select('role, church_id')
                        .eq('id', user.id)
                        .maybeSingle();
                    
                    const currentPath = window.location.pathname.split('/').pop() || 'feed.html';
                    const isJoinPage = currentPath === 'join-church.html' || currentPath === 'register-church.html';

                    if (!isSuperAdmin && profile && profile.role !== 'super_admin' && profile.role !== 'super-admin' && !profile.church_id && !isJoinPage && !currentPath.includes('login') && !currentPath.includes('signup')) {
                        window.location.replace('join-church.html');
                        return;
                    }

                    if (isSuperAdmin || (profile && (profile.role === 'admin' || profile.role === 'super_admin' || profile.role === 'super-admin' || profile.role === 'leader'))) {
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
            { href: 'volunteer.html', label: 'Volunteer Board' },
            { href: 'gallery.html', label: 'Gallery' },
            { href: 'profile.html', label: 'Profile' }
        ];

        if (isSuperAdmin) {
            options.push({ href: 'super-admin.html', label: '🛡️ Super Admin' });
        }
        if (isAdminOrLeader) {
            options.push({ href: 'admin.html', label: '⚙️ Admin Panel' });
        }

        const currentFilename = window.location.pathname.split('/').pop() || 'feed.html';

        navbarContainer.innerHTML = `
            <nav class="sticky top-0 z-50 py-3 px-4 bg-white/80 dark:bg-gray-900/80 backdrop-blur-md border-b border-gray-200 dark:border-gray-800 transition-colors duration-300" style="position: sticky; top: 0; z-index: 1000;">
                <div class="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
                    <div class="flex justify-between items-center h-16">
                        <a href="feed.html" class="text-xl font-bold text-gray-900 dark:text-white hover:text-blue-600 dark:hover:text-blue-400 flex-shrink-0 mr-4">BelieversMeet</a>
                        <div class="nav-scrollable-row no-scrollbar flex flex-wrap items-center justify-center gap-3 p-4">
                            ${options.map(opt => {
                                const isActive = currentFilename === opt.href;
                                const activeClasses = isActive 
                                    ? 'bg-blue-600 text-white shadow-md hover:bg-blue-700 hover:text-white' 
                                    : 'bg-white dark:bg-gray-800 text-gray-700 dark:text-gray-200 hover:bg-blue-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400';
                                return `<a href="${opt.href}" class="px-5 py-2.5 rounded-full text-sm font-semibold transition-all duration-300 ease-in-out shadow-sm hover:shadow-md hover:-translate-y-1 ${activeClasses}">${opt.label}</a>`;
                            }).join('')}
                            <button onclick="toggleTheme()" 
                                    class="p-2.5 rounded-full bg-slate-200 dark:bg-slate-800 text-slate-800 dark:text-slate-200 hover:bg-slate-300 dark:hover:bg-slate-700 transition-colors shadow-sm flex items-center justify-center flex-shrink-0"
                                    title="Toggle Light/Dark Mode"
                                    aria-label="Toggle Light/Dark Mode">
                                <!-- Sun Icon (shown in Dark Mode) -->
                                <svg class="w-5 h-5 hidden dark:block text-yellow-400" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M12 3v1m0 16v1m9-9h-1M4 12H3m15.364 6.364l-.707-.707M6.343 6.343l-.707-.707m12.728 0l-.707.707M6.343 17.657l-.707.707M16 12a4 4 0 11-8 0 4 4 0 018 0z"></path>
                                </svg>
                                <!-- Moon Icon (shown in Light Mode) -->
                                <svg class="w-5 h-5 block dark:hidden text-slate-700" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M20.354 15.354A9 9 0 018.646 3.646 9.003 9.003 0 0012 21a9.003 9.003 0 008.354-5.646z"></path>
                                </svg>
                            </button>
                            <a href="#" onclick="if(window.sbClient) { window.sbClient.auth.signOut().then(() => window.location.href='login.html'); } else { window.location.href='login.html'; }" class="px-5 py-2.5 rounded-full text-sm font-semibold transition-all duration-300 ease-in-out shadow-sm hover:shadow-md hover:-translate-y-1 bg-white dark:bg-gray-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-gray-700 flex-shrink-0">Logout</a>
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
