// Central Navigation Script (`js/nav.js`) - Option 1: Scrollable Row
(function() {
    async function initScrollableNav() {
        const navbarContainer = document.getElementById('navbar');
        if (!navbarContainer) {
            return;
        }

        let isSuperAdmin = false;
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
                    isSuperAdmin = user.email === 'adonstance@gmail.com';
                    const { data: profile } = await window.sbClient
                        .from('profiles')
                        .select('role, church_id')
                        .eq('id', user.id)
                        .maybeSingle();
                    
                    const currentPath = window.location.pathname.split('/').pop() || 'feed.html';
                    const isJoinPage = currentPath === 'join-church.html' || currentPath === 'register-church.html';

                    if (
                        !isSuperAdmin &&
                        profile &&
                        profile.role !== 'super_admin' &&
                        profile.role !== 'super-admin' &&
                        !profile.church_id &&
                        !isJoinPage &&
                        !currentPath.includes('login') &&
                        !currentPath.includes('signup') &&
                        !currentPath.includes('giving.html') &&
                        !currentPath.includes('public-church.html')
                    ) {
                        window.location.replace('join-church.html');
                        return;
                    }

                    if (isSuperAdmin || (profile && (
                        profile.role === 'church_admin' ||
                        profile.role === 'admin' ||
                        profile.role === 'super_admin' ||
                        profile.role === 'super-admin' ||
                        profile.role === 'leader'
                    ))) {
                        isAdminOrLeader = true;
                    }
                }
            }
        } catch (err) {
            console.warn("Could not fetch user profile for admin check in navigation:", err);
        }

        const options = [
            { href: 'feed.html', label: 'Feed', icon: 'fa-newspaper' },
            { href: 'events.html', label: 'Events', icon: 'fa-calendar-alt' },
            { href: 'groups.html', label: 'Groups', icon: 'fa-users' },
            { href: 'sermons.html', label: 'Sermons', icon: 'fa-bible' },
            { href: 'giving.html', label: 'Giving', icon: 'fa-hand-holding-heart' },
            { href: 'chat.html', label: 'Messages', icon: 'fa-comments' },
            { href: 'directory.html', label: 'Directory', icon: 'fa-address-book' },
            { href: 'prayer-wall.html', label: 'Prayer Wall', icon: 'fa-pray' },
            { href: 'testimonies.html', label: 'Testimonies', icon: 'fa-heart' },
            { href: 'volunteer.html', label: 'Volunteer', icon: 'fa-hands-helping' },
            { href: 'gallery.html', label: 'Gallery', icon: 'fa-images' },
            { href: 'profile.html', label: 'My Profile', icon: 'fa-user' }
        ];

        if (isSuperAdmin) {
            options.push({ href: 'super-admin.html', label: 'Super Admin', icon: 'fa-shield-alt' });
        }
        if (isAdminOrLeader) {
            options.push({ href: 'admin.html', label: 'Admin Panel', icon: 'fa-cog' });
        }

        const currentFilename = window.location.pathname.split('/').pop() || 'feed.html';

        navbarContainer.innerHTML = `
            <style>
                /* All Features Dropdown Styles */
                .bm-dropdown-menu {
                    display: none;
                    position: absolute;
                    top: calc(100% + 0.5rem);
                    left: 0;
                    min-width: 260px;
                    background-color: white;
                    border-radius: 1rem;
                    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
                    border: 1px solid #e5e7eb;
                    z-index: 99999;
                    padding: 0.5rem;
                }
                .dark .bm-dropdown-menu {
                    background-color: #1f2937;
                    border-color: #374151;
                    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.5);
                }
                .bm-dropdown-menu.show {
                    display: block;
                    animation: bmDropdownFade 0.15s ease-out forwards;
                }
                @keyframes bmDropdownFade {
                    from { opacity: 0; transform: translateY(-8px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @media (max-width: 768px) {
                    .bm-dropdown-menu {
                        left: auto;
                        right: 0;
                        max-width: 90vw;
                        width: 280px;
                    }
                }
            </style>
            <nav class="sticky top-0 z-50 py-3 px-4 bg-slate-900/95 dark:bg-gray-900/95 backdrop-blur-md border-b border-slate-800 dark:border-gray-800 transition-colors duration-300 shadow-sm text-white" style="position: sticky; top: 0; z-index: 1000; width: 100%; background-color: #0f172a !important; border-bottom: 1px solid #1e293b !important;">
                <div class="max-w-7xl mx-auto px-2 sm:px-4 lg:px-6">
                    <div class="flex flex-col md:flex-row justify-between items-center py-2 gap-3">
                        <div class="flex items-center justify-between w-full md:w-auto gap-4">
                            <a href="feed.html" class="flex items-center gap-2 text-xl font-bold text-white hover:text-blue-400 dark:hover:text-blue-400 flex-shrink-0">
                                <img src="images/BELIEVERS.LOGO.png" alt="BelieversMeet Logo" class="w-8 h-8 rounded-full object-cover border border-slate-700">
                                <span>BelieversMeet</span>
                            </a>
                            
                            <!-- All Features Dropdown Trigger Container -->
                            <div class="relative inline-block text-left" id="all-features-dropdown-container">
                                <button type="button" id="all-features-menu-btn" onclick="toggleAllFeaturesDropdown(event)" 
                                        class="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs sm:text-sm font-bold bg-indigo-900 hover:bg-indigo-800 text-white shadow-md transition-all cursor-pointer">
                                    <span>☰</span>
                                    <span>All Features</span>
                                    <svg class="w-4 h-4 ml-0.5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                                </button>
                                
                                <!-- Dropdown Panel -->
                                <div id="all-features-dropdown-menu" class="bm-dropdown-menu">
                                    <div class="py-1 max-h-[75vh] overflow-y-auto no-scrollbar space-y-1">
                                        <div class="px-3 py-1.5 text-xs font-extrabold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Member Navigation</div>
                                        ${options.map(opt => {
                                            const isActive = currentFilename === opt.href;
                                            const activeClasses = isActive 
                                                ? 'bg-blue-600 text-white font-bold shadow-sm' 
                                                : 'text-gray-700 dark:text-gray-200 hover:bg-blue-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400 font-medium';
                                            return `
                                                <a href="${opt.href}" class="flex items-center gap-3 px-3 py-2 rounded-xl text-xs sm:text-sm transition-all ${activeClasses}">
                                                    <i class="fas ${opt.icon || 'fa-circle'} w-4 text-center pointer-events-none"></i>
                                                    <span class="pointer-events-none">${opt.label}</span>
                                                </a>
                                            `;
                                        }).join('')}
                                    </div>
                                </div>
                            </div>
                        </div>

                        <div class="flex items-center gap-2 py-1 px-1">
                            <button onclick="if(window.sbClient) { window.sbClient.auth.signOut().then(() => window.location.href='login.html'); } else { window.location.href='login.html'; }" 
                                    class="p-2 rounded-full bg-white dark:bg-gray-800 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-gray-700 transition-colors shadow-sm flex items-center justify-center flex-shrink-0 cursor-pointer border border-gray-100 dark:border-gray-700"
                                    title="Log out"
                                    aria-label="Log out">
                                <svg class="w-4 h-4 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
                                    <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1"></path>
                                </svg>
                            </button>
                        </div>
                    </div>
                </div>
            </nav>
        `;

        // Global Dropdown Handlers
        window.toggleAllFeaturesDropdown = function(event) {
            if (event) event.stopPropagation();
            const menu = document.getElementById('all-features-dropdown-menu');
            if (menu) {
                menu.classList.toggle('show');
            }
        };

        // Close dropdown on outside click or Escape key
        document.addEventListener('click', function(e) {
            const container = document.getElementById('all-features-dropdown-container');
            const menu = document.getElementById('all-features-dropdown-menu');
            if (container && menu && !container.contains(e.target)) {
                menu.classList.remove('show');
            }
        });

        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                const menu = document.getElementById('all-features-dropdown-menu');
                if (menu) {
                    menu.classList.remove('show');
                }
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initScrollableNav);
    } else {
        initScrollableNav();
    }
})();
