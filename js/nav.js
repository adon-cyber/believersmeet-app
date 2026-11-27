// Central Navigation Script (`js/nav.js`) - Option 1: Scrollable Row
(function() {
    async function initScrollableNav() {
        const navbarContainer = document.getElementById('navbar');
        if (!navbarContainer) {
            return;
        }

        // Load the shared All Features design.
        const featuresStylesheetId = 'bm-all-features-stylesheet';
        if (!document.getElementById(featuresStylesheetId)) {
            const featuresStylesheet = document.createElement('link');
            featuresStylesheet.id = featuresStylesheetId;
            featuresStylesheet.rel = 'stylesheet';
            featuresStylesheet.href = 'css/all-features.css?v=20261122-v1';
            document.head.appendChild(featuresStylesheet);
        }
        let isSuperAdmin = false;
        let canAccessAdminPanel = false;
        let currentChurchId = null;
        try {
            let attempts = 0;
            while (!window.sbClient && attempts < 15) {
                await new Promise(r => setTimeout(r, 150));
                attempts++;
            }
            if (window.sbClient) {
                const { data: { user } } = await window.sbClient.auth.getUser();
                if (user) {
                    const { data: platformAdminResult, error: platformAdminError } =
                        await window.sbClient.rpc('is_super_admin');

                    if (platformAdminError) {
                        console.warn('Platform administrator navigation check failed:', platformAdminError);
                    } else {
                        isSuperAdmin = platformAdminResult === true;
                    }
                    const { data: profile } = await window.sbClient
                        .from('profiles')
                        .select('role, church_id, status, is_blocked')
                        .eq('id', user.id)
                        .maybeSingle();

                    const profileRole = profile && typeof profile.role === 'string'
                        ? profile.role.trim().toLowerCase()
                        : '';
                    const accountActive = profile?.status === 'active' && profile?.is_blocked !== true;
                    currentChurchId = profile?.church_id || null;

                    // Match the roles supported by admin.html. Church-level admin
                    // links require an active, unblocked profile. Platform-admin
                    // access comes only from the database allowlist RPC, never an email check.
                    canAccessAdminPanel = isSuperAdmin || (accountActive &&
                        ['church_admin', 'admin', 'finance', 'super_admin', 'super-admin'].includes(profileRole));
                }
            }
        } catch (err) {
            console.warn("Could not fetch user profile for admin check in navigation:", err);
        }

        const options = [
            { href: 'feed.html', label: 'Feed', icon: 'fa-newspaper' },
            { href: 'events.html', label: 'Events', icon: 'fa-calendar-alt' },
            { href: 'events.html?category=Singles%20Meetup', activeFile: 'events.html', label: 'Singles Corner', icon: 'fa-heart' },
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
        if (canAccessAdminPanel) {
            options.push({ href: 'admin.html', label: 'Admin Panel', icon: 'fa-cog' });
        }

        const currentFilename = window.location.pathname.split('/').pop() || 'feed.html';

        navbarContainer.innerHTML = `
            <nav class="sticky top-0 z-50 py-3 px-4 bg-slate-900/95 dark:bg-gray-900/95 backdrop-blur-md border-b border-slate-800 dark:border-gray-800 transition-colors duration-300 shadow-sm text-white bm-shared-nav" style="position: sticky; top: 0; z-index: 1000; width: 100%; background-color: #0f172a !important; border-bottom: 1px solid #1e293b !important;">
                <div class="max-w-7xl mx-auto px-2 sm:px-4 lg:px-6 bm-shared-nav-inner">
                    <div class="flex flex-col md:flex-row justify-between items-center py-2 gap-3">
                        <div class="flex items-center justify-between w-full md:w-auto gap-4">
                            <a href="feed.html" class="flex items-center gap-2 text-xl font-bold text-white hover:text-blue-400 dark:hover:text-blue-400 flex-shrink-0">
                                <img src="images/BELIEVERS.LOGO.png" data-bm-church-logo alt="BelieversMeet Logo" class="w-8 h-8 rounded-full object-cover border border-slate-700">
                                <span>BelieversMeet</span>
                            </a>
                            
                            <!-- All Features Dropdown Trigger Container -->
                            <div class="relative inline-block text-left" id="all-features-dropdown-container">
                                <button type="button" id="all-features-menu-btn" onclick="toggleAllFeaturesDropdown(event)" 
                                        class="inline-flex items-center gap-2 px-4 py-2 rounded-full text-xs sm:text-sm font-bold bg-indigo-900 hover:bg-indigo-800 text-white shadow-md transition-all cursor-pointer">
                                    <i class="fas fa-th-large"></i>
                                    <span>All Features</span>
                                    <svg class="w-4 h-4 ml-0.5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
                                </button>
                                
                                <!-- Dropdown Panel -->
                                <div id="all-features-dropdown-menu" class="bm-dropdown-menu">
                                    <div class="py-1 space-y-1">
                                        <div class="px-3 py-1.5 text-xs font-extrabold text-gray-400 dark:text-gray-500 uppercase tracking-wider">Member Navigation</div>
                                        ${options.map(opt => {
                                            const activeFile = opt.activeFile || opt.href.split('?')[0];
                                            const isActive = currentFilename === activeFile;
                                            const activeClasses = isActive 
                                                ? 'bg-blue-600 text-white font-bold shadow-sm' 
                                                : 'text-gray-700 dark:text-gray-200 hover:bg-blue-50 dark:hover:bg-gray-700 hover:text-blue-600 dark:hover:text-blue-400 font-medium';
                                            return `
                                                <a href="${opt.href}" ${isActive ? 'aria-current="page"' : ''} class="flex items-center gap-3 px-3 py-2 rounded-xl text-xs sm:text-sm transition-all ${activeClasses}">
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

        // Apply the authenticated member's church logo to the shared navigation.
        // The homepage and public church profile use their own explicit branding.
        const sharedBrandImage = navbarContainer.querySelector('[data-bm-church-logo]');
        if (sharedBrandImage) {
            sharedBrandImage.onerror = function () {
                this.onerror = null;
                this.src = 'images/BELIEVERS.LOGO.png';
            };
            if (currentChurchId && window.sbClient) {
                try {
                    const { data: church, error: churchError } = await window.sbClient
                        .from('churches')
                        .select('logo_url, name')
                        .eq('id', currentChurchId)
                        .maybeSingle();
                    if (!churchError && church?.logo_url) {
                        const logoUrl = new URL(church.logo_url, window.location.href);
                        if (['https:', 'http:'].includes(logoUrl.protocol)) {
                            sharedBrandImage.src = logoUrl.href;
                            sharedBrandImage.alt = `${church.name || 'Church'} logo`;
                        }
                    }
                } catch (error) {
                    console.warn('Church navigation logo unavailable; using BelieversMeet logo.', error);
                }
            }
        }

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
