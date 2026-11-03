/**
 * BelieversMeet Emergency Navigation Fallback Component
 * Updated to act as a shared dropdown toggle instead of navigating away.
 * If `#all-features-menu-btn` is present on the page from `js/nav.js`, this script remains dormant.
 */
(function() {
    async function initEmergencyDropdownNav() {
        // If navbar script already rendered the All Features dropdown button, do nothing
        if (document.getElementById('all-features-menu-btn') || document.getElementById('emergency-nav-fallback-btn')) {
            return;
        }

        const currentPath = window.location.pathname.toLowerCase();
        if (currentPath.endsWith('member-menu.html') || currentPath.endsWith('login.html') || currentPath.endsWith('signup.html')) {
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
                        .select('role')
                        .eq('id', user.id)
                        .maybeSingle();

                    if (isSuperAdmin || (profile && (profile.role === 'admin' || profile.role === 'super_admin' || profile.role === 'super-admin' || profile.role === 'leader'))) {
                        isAdminOrLeader = true;
                    }
                }
            }
        } catch (err) {
            console.warn("Could not fetch user profile for emergency nav admin check:", err);
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

        const currentFilename = window.location.pathname.split('/').pop() || 'feed.html';

        // Create style injection for high z-index, dropdown panel, and floating button
        const styleId = 'emergency-nav-fallback-style';
        if (!document.getElementById(styleId)) {
            const style = document.createElement('style');
            style.id = styleId;
            style.textContent = `
                #emergency-nav-fallback-container {
                    position: fixed;
                    top: 1rem;
                    left: 1rem;
                    z-index: 99999;
                }
                #emergency-nav-fallback-btn {
                    display: inline-flex;
                    align-items: center;
                    gap: 0.5rem;
                    background-color: #312e81;
                    color: #ffffff;
                    padding: 0.625rem 1rem;
                    font-size: 0.875rem;
                    font-weight: 600;
                    border-radius: 9999px;
                    box-shadow: 0 10px 25px -3px rgba(0, 0, 0, 0.3);
                    border: 1px solid rgba(255, 255, 255, 0.2);
                    transition: all 0.2s ease-in-out;
                    cursor: pointer;
                }
                #emergency-nav-fallback-btn:hover {
                    background-color: #1e1b4b;
                    transform: scale(1.05);
                }
                .bm-emergency-dropdown-menu {
                    display: none;
                    position: absolute;
                    top: calc(100% + 0.5rem);
                    left: 0;
                    min-width: 260px;
                    background-color: white;
                    border-radius: 1rem;
                    box-shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.2), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
                    border: 1px solid #e5e7eb;
                    z-index: 99999;
                    padding: 0.5rem;
                }
                .dark .bm-emergency-dropdown-menu {
                    background-color: #1f2937;
                    border-color: #374151;
                }
                .bm-emergency-dropdown-menu.show {
                    display: block;
                    animation: bmEmergencyFade 0.15s ease-out forwards;
                }
                @keyframes bmEmergencyFade {
                    from { opacity: 0; transform: translateY(-8px); }
                    to { opacity: 1; transform: translateY(0); }
                }
                @media (max-width: 640px) {
                    #emergency-nav-fallback-container {
                        top: 0.75rem;
                        left: 0.75rem;
                    }
                    #emergency-nav-fallback-btn {
                        padding: 0.5rem 0.875rem;
                        font-size: 0.8125rem;
                    }
                    .bm-emergency-dropdown-menu {
                        left: 0;
                        max-width: 90vw;
                        width: 280px;
                    }
                }
            `;
            document.head.appendChild(style);
        }

        const container = document.createElement('div');
        container.id = 'emergency-nav-fallback-container';
        container.innerHTML = `
            <button type="button" id="emergency-nav-fallback-btn" onclick="toggleEmergencyDropdown(event)" aria-label="BelieversMeet Navigation Menu">
                <span>☰</span>
                <span>BelieversMeet</span>
                <svg class="w-4 h-4 ml-0.5 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"></path></svg>
            </button>
            <div id="emergency-dropdown-menu" class="bm-emergency-dropdown-menu">
                <div class="py-1 max-h-[75vh] overflow-y-auto space-y-1">
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
        `;

        document.body.appendChild(container);

        window.toggleEmergencyDropdown = function(event) {
            if (event) event.stopPropagation();
            const menu = document.getElementById('emergency-dropdown-menu');
            if (menu) {
                menu.classList.toggle('show');
            }
        };

        document.addEventListener('click', function(e) {
            const cont = document.getElementById('emergency-nav-fallback-container');
            const menu = document.getElementById('emergency-dropdown-menu');
            if (cont && menu && !cont.contains(e.target)) {
                menu.classList.remove('show');
            }
        });

        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape') {
                const menu = document.getElementById('emergency-dropdown-menu');
                if (menu) {
                    menu.classList.remove('show');
                }
            }
        });
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initEmergencyDropdownNav);
    } else {
        initEmergencyDropdownNav();
    }
})();
