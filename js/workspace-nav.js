/* BelieversMeet Workspace Navigation v2
 * Shared blue/indigo shell for authenticated application pages.
 * Sidebar visibility is a user preference; page and database authorization remain authoritative.
 */
(function () {
    'use strict';

    const root = document.getElementById('navbar');
    if (!root) return;

    const SIDEBAR_PREF_KEY = 'bmWorkspaceSidebarHidden';
    const MOBILE_QUERY = '(max-width: 767px)';

    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);

    const safeImageUrl = value => {
        if (typeof value !== 'string' || !value.trim()) return '';
        try {
            const url = new URL(value, window.location.href);
            return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
        } catch (_) {
            return '';
        }
    };

    function currentFile() {
        return (window.location.pathname.split('/').pop() || 'feed.html').toLowerCase();
    }

    function isActiveProfile(profile) {
        return profile?.status === 'active' && profile?.is_blocked !== true;
    }

    function buildSections(profile, isPlatformAdmin, canManageChurchContent) {
        const role = String(profile?.role || '').trim().toLowerCase();
        const active = isActiveProfile(profile);
        // Preserve the roles already recognized by the shared legacy navigation.
        // These links are navigation only; destination pages/RPCs remain the access authority.
        const canSeeAdmin = isPlatformAdmin || (active && [
            'church_admin', 'admin', 'finance', 'super_admin', 'super-admin'
        ].includes(role));
        const canSeeAccounting = isPlatformAdmin || (active && [
            'finance', 'church_admin', 'admin'
        ].includes(role));

        const sections = [
            {
                label: 'Workspace', icon: 'fa-compass', open: true,
                items: [
                    { href: 'feed.html', label: 'Launchpad', icon: 'fa-house' },
                    ...(canSeeAdmin ? [{ href: 'church-dashboard.html', label: 'Dashboard', icon: 'fa-chart-line' }] : [])
                ]
            },
            {
                label: 'Church Community', icon: 'fa-users', open: true,
                items: [
                    { href: 'directory.html', label: 'People', icon: 'fa-user-group' },
                    { href: 'chat.html', label: 'Inbox', icon: 'fa-envelope' },
                    { href: 'groups.html', label: 'Groups', icon: 'fa-people-group' },
                    { href: 'events.html', label: 'Events', icon: 'fa-calendar-days' }
                ]
            },
            {
                label: 'Ministry', icon: 'fa-church', open: true,
                items: [
                    { href: 'sermons.html', label: 'Sermons & Media', icon: 'fa-book-bible' },
                    { href: 'programmes.html', label: 'Programmes', icon: 'fa-calendar-check' },
                    { href: 'prayer-wall.html', label: 'Prayer Wall', icon: 'fa-hands-praying' },
                    { href: 'testimonies.html', label: 'Testimonies', icon: 'fa-heart' },
                    { href: 'gallery.html', label: 'Gallery', icon: 'fa-images' },
                    { href: 'volunteer.html', label: 'Volunteer', icon: 'fa-handshake-angle' }
                ]
            },
            {
                label: 'Giving & Finance', icon: 'fa-wallet', open: false,
                items: [
                    { href: 'giving.html', label: 'Giving', icon: 'fa-hand-holding-heart' },
                    { href: 'giving-history.html', label: 'Giving History', icon: 'fa-receipt' },
                    ...(canSeeAccounting ? [{ href: 'accounting.html', label: 'Accounting', icon: 'fa-calculator' }] : []),
                    ...(canManageChurchContent ? [{ href: 'accounting-team.html', label: 'Accounting Team', icon: 'fa-people-arrows-left-right' }] : [])
                ]
            },
            {
                label: 'Resources', icon: 'fa-folder-open', open: false,
                items: [
                    { href: 'documents.html', label: 'File Manager', icon: 'fa-folder' },
                    { href: 'profile.html', label: 'My Profile', icon: 'fa-user-circle' },
                    { href: 'edit-profile.html', label: 'Edit Profile', icon: 'fa-user-pen' },
                    { href: 'settings.html', label: 'Settings', icon: 'fa-gear' }
                ]
            }
        ];

        if (canSeeAdmin || canManageChurchContent || isPlatformAdmin) {
            const adminItems = [];
            if (canSeeAdmin || canManageChurchContent) {
                adminItems.push(
                    { href: 'admin.html', label: 'Admin Panel', icon: 'fa-screwdriver-wrench' }
                );
            }
            if (canSeeAdmin) {
                adminItems.push({ href: 'admin-events.html', label: 'Event Management', icon: 'fa-calendar-plus' });
            }

            if (isPlatformAdmin) {
                adminItems.push({ href: 'super-admin.html', label: 'Super Admin', icon: 'fa-shield-halved' });
            }
            if (adminItems.length) {
                sections.push({ label: 'Administration', icon: 'fa-shield-halved', open: false, items: adminItems });
            }
        }

        return sections;
    }

    function iconLink(item, active) {
        return `
            <a class="bm-workspace-link${active ? ' is-active' : ''}"
               href="${escapeHtml(item.href)}"
               ${active ? 'aria-current="page"' : ''}
               title="${escapeHtml(item.label)}">
                <i class="fas ${escapeHtml(item.icon)}" aria-hidden="true"></i>
                <span class="bm-workspace-link-label">${escapeHtml(item.label)}</span>
            </a>`;
    }

    function sectionMarkup(section, file) {
        const items = section.items.map(item => {
            const targetFile = (item.href.split('?')[0] || '').toLowerCase();
            return iconLink(item, targetFile === file);
        }).join('');
        const activeInSection = section.items.some(item => (item.href.split('?')[0] || '').toLowerCase() === file);
        return `
            <details class="bm-workspace-section" ${section.open || activeInSection ? 'open' : ''}>
                <summary>
                    <i class="fas ${escapeHtml(section.icon)}" aria-hidden="true"></i>
                    <span>${escapeHtml(section.label)}</span>
                    <i class="fas fa-chevron-down bm-workspace-section-chevron" aria-hidden="true"></i>
                </summary>
                <div class="bm-workspace-section-items">${items}</div>
            </details>`;
    }

    function readSidebarPreference() {
        try {
            return window.localStorage.getItem(SIDEBAR_PREF_KEY) === 'true';
        } catch (_) {
            return false;
        }
    }

    function saveSidebarPreference(hidden) {
        try {
            window.localStorage.setItem(SIDEBAR_PREF_KEY, hidden ? 'true' : 'false');
        } catch (error) {
            console.warn('Workspace sidebar preference could not be saved.', error);
        }
    }

    function applySidebarState() {
        const toggle = document.getElementById('bm-workspace-sidebar-toggle');
        const overlay = document.getElementById('bm-workspace-sidebar-overlay');
        const isMobile = window.matchMedia(MOBILE_QUERY).matches;

        document.body.classList.remove('bm-workspace-mobile-open');
        if (overlay) overlay.setAttribute('tabindex', '-1');

        if (isMobile) {
            document.body.classList.remove('bm-workspace-sidebar-hidden');
            if (toggle) toggle.setAttribute('aria-expanded', 'false');
            return;
        }

        const hidden = readSidebarPreference();
        document.body.classList.toggle('bm-workspace-sidebar-hidden', hidden);
        if (toggle) {
            toggle.setAttribute('aria-expanded', String(!hidden));
            toggle.setAttribute('title', hidden ? 'Show navigation' : 'Hide navigation');
        }
    }

    async function performLogout(event) {
        if (event) event.preventDefault();
        const client = window.sbClient || window.supabaseClient;
        if (!client?.auth) {
            window.location.replace('login.html');
            return;
        }
        try {
            const { error } = await client.auth.signOut();
            if (error) throw error;
            window.location.replace('login.html');
        } catch (error) {
            console.error('BelieversMeet sign-out failed:', error);
            window.alert('We could not sign you out. Please try again.');
        }
    }

    function render(profile, isPlatformAdmin, canManageChurchContent) {
        const file = currentFile();
        const sections = buildSections(profile, isPlatformAdmin, canManageChurchContent);
        const shortcuts = [
            { href: 'feed.html', label: 'Home', icon: 'fa-house' },
            { href: 'sermons.html', label: 'Sermons', icon: 'fa-book-bible' },
            { href: 'directory.html', label: 'People', icon: 'fa-user-group' },
            { href: 'events.html', label: 'Events', icon: 'fa-bolt' }
        ];
        const allItems = sections.flatMap(section => section.items);
        const uniqueItems = allItems.filter((item, index) => allItems.findIndex(other => other.href === item.href) === index);
        const displayName = profile?.display_name || profile?.full_name || 'My Account';
        const avatar = safeImageUrl(profile?.avatar_url || profile?.profile_picture || '');
        const initial = String(displayName).trim().charAt(0).toUpperCase() || 'U';

        root.innerHTML = `
            <header class="bm-workspace-topbar" role="banner">
                <div class="bm-workspace-brand-area">
                    <button type="button" class="bm-workspace-icon-button bm-workspace-menu-toggle"
                            id="bm-workspace-sidebar-toggle" aria-label="Toggle navigation" aria-expanded="true" title="Hide navigation">
                        <i class="fas fa-bars" aria-hidden="true"></i>
                    </button>
                    <a class="bm-workspace-brand" href="feed.html" aria-label="BelieversMeet home">
                        <span class="bm-workspace-brand-mark">
                            <img id="church-logo-img" data-bm-church-logo src="images/BELIEVERS.LOGO.png" alt="BelieversMeet logo">
                            <span id="church-logo-placeholder" class="bm-workspace-logo-fallback" aria-hidden="true">BM</span>
                        </span>
                        <span>BelieversMeet</span>
                    </a>
                </div>

                <nav class="bm-workspace-shortcuts" aria-label="Quick navigation">
                    ${shortcuts.map(item => {
                        const active = item.href === file;
                        return `<a href="${escapeHtml(item.href)}" title="${escapeHtml(item.label)}" aria-label="${escapeHtml(item.label)}" ${active ? 'aria-current="page"' : ''} class="bm-workspace-shortcut${active ? ' is-active' : ''}"><i class="fas ${escapeHtml(item.icon)}" aria-hidden="true"></i></a>`;
                    }).join('')}
                </nav>

                <div class="bm-workspace-topbar-actions flex items-center">
                    <div class="bm-workspace-app-launcher-wrap">
                        <button type="button" id="bm-workspace-app-launcher-toggle" class="bm-workspace-icon-button"
                                aria-label="Open app launcher" aria-expanded="false" aria-controls="bm-workspace-app-launcher" title="All features">
                            <i class="fas fa-grip" aria-hidden="true"></i>
                        </button>
                        <div id="bm-workspace-app-launcher" class="bm-workspace-app-launcher" hidden>
                            <div class="bm-workspace-app-launcher-heading">Quick access</div>
                            <div class="bm-workspace-app-grid">
                                ${uniqueItems.map(item => `<a href="${escapeHtml(item.href)}" title="${escapeHtml(item.label)}"><i class="fas ${escapeHtml(item.icon)}" aria-hidden="true"></i><span>${escapeHtml(item.label)}</span></a>`).join('')}
                            </div>
                        </div>
                    </div>
                    <a href="chat.html" class="bm-workspace-icon-button" aria-label="Inbox" title="Inbox">
                        <i class="far fa-envelope" aria-hidden="true"></i>
                    </a>
                    <!-- Existing notifications.js inserts its bell before this hidden anchor. -->
                    <button type="button" class="bm-workspace-notification-anchor" title="Log out" aria-label="Log out" tabindex="-1" hidden></button>
                    <a href="profile.html" id="bm-workspace-profile-link" class="bm-workspace-avatar-link" aria-label="Open profile" title="${escapeHtml(displayName)}">
                        ${avatar ? `<img id="bm-workspace-user-avatar" src="${escapeHtml(avatar)}" alt="" referrerpolicy="no-referrer">` : `<span id="bm-workspace-user-initial">${escapeHtml(initial)}</span>`}
                    </a>
                </div>
            </header>

            <button type="button" id="bm-workspace-sidebar-overlay" class="bm-workspace-sidebar-overlay" aria-label="Close navigation" tabindex="-1"></button>
            <aside class="bm-workspace-sidebar" id="bm-workspace-sidebar" aria-label="Main navigation">
                <div class="bm-workspace-sidebar-scroll">
                    ${sections.map(section => sectionMarkup(section, file)).join('')}
                </div>
                <div class="bm-workspace-sidebar-footer">
                    <div class="bm-workspace-sidebar-brand-note">
                        <span class="bm-workspace-status-dot" aria-hidden="true"></span>
                        <span>BelieversMeet Workspace</span>
                    </div>
                    <button type="button" class="bm-workspace-side-logout" data-bm-workspace-logout title="Log out" aria-label="Log out">
                        <i class="fas fa-right-from-bracket" aria-hidden="true"></i>
                        <span>Log out</span>
                    </button>
                </div>
            </aside>`;

        // notifications.js can initialize in parallel with this async navigation.
        // If it found a legacy profile link before this shell rendered, move its bell
        // into the new top-bar actions rather than leaving it stranded in page content.
        const existingBell = document.getElementById('notification-bell-container');
        const topbarActions = root.querySelector('.bm-workspace-topbar-actions');
        const notificationAnchor = topbarActions?.querySelector('.bm-workspace-notification-anchor');
        if (existingBell && topbarActions && !topbarActions.contains(existingBell)) {
            topbarActions.insertBefore(existingBell, notificationAnchor || topbarActions.querySelector('#bm-workspace-profile-link') || null);
        }

        document.body.classList.add('bm-workspace-shell');
        bindInteractions();
        applySidebarState();

        // The branding loader may have run before the asynchronous shell rendered.
        // Refresh now so the authenticated church logo is applied after its image exists.
        if (window.BelieversMeetChurchBranding?.refresh) {
            void window.BelieversMeetChurchBranding.refresh(profile?.church_id || undefined);
        }
    }

    function bindInteractions() {
        const toggle = document.getElementById('bm-workspace-sidebar-toggle');
        const overlay = document.getElementById('bm-workspace-sidebar-overlay');
        const launcherToggle = document.getElementById('bm-workspace-app-launcher-toggle');
        const launcher = document.getElementById('bm-workspace-app-launcher');

        if (toggle) {
            toggle.addEventListener('click', () => {
                if (window.matchMedia(MOBILE_QUERY).matches) {
                    const open = document.body.classList.toggle('bm-workspace-mobile-open');
                    toggle.setAttribute('aria-expanded', String(open));
                    toggle.setAttribute('title', open ? 'Close navigation' : 'Open navigation');
                    if (overlay) overlay.setAttribute('tabindex', open ? '0' : '-1');
                } else {
                    const hidden = !document.body.classList.contains('bm-workspace-sidebar-hidden');
                    document.body.classList.toggle('bm-workspace-sidebar-hidden', hidden);
                    saveSidebarPreference(hidden);
                    toggle.setAttribute('aria-expanded', String(!hidden));
                    toggle.setAttribute('title', hidden ? 'Show navigation' : 'Hide navigation');
                }
            });
        }

        const closeMobileSidebar = () => {
            document.body.classList.remove('bm-workspace-mobile-open');
            if (overlay) overlay.setAttribute('tabindex', '-1');
            if (toggle) {
                toggle.setAttribute('aria-expanded', 'false');
                toggle.setAttribute('title', 'Open navigation');
            }
        };

        if (overlay) overlay.addEventListener('click', closeMobileSidebar);

        if (launcherToggle && launcher) {
            launcherToggle.addEventListener('click', event => {
                event.stopPropagation();
                const opening = launcher.hidden;
                launcher.hidden = !opening;
                launcherToggle.setAttribute('aria-expanded', String(opening));
            });
        }

        document.querySelectorAll('[data-bm-workspace-logout]').forEach(button => {
            button.addEventListener('click', performLogout);
        });

        document.addEventListener('click', event => {
            if (launcher && !launcher.hidden && !event.target.closest('.bm-workspace-app-launcher-wrap')) {
                launcher.hidden = true;
                launcherToggle?.setAttribute('aria-expanded', 'false');
            }
            if (window.matchMedia(MOBILE_QUERY).matches &&
                document.body.classList.contains('bm-workspace-mobile-open') &&
                event.target.closest('.bm-workspace-link')) {
                closeMobileSidebar();
            }
        });

        document.addEventListener('keydown', event => {
            if (event.key === 'Escape') {
                if (launcher && !launcher.hidden) {
                    launcher.hidden = true;
                    launcherToggle?.setAttribute('aria-expanded', 'false');
                    launcherToggle?.focus();
                }
                closeMobileSidebar();
            }
        });

        window.addEventListener('resize', applySidebarState);
    }

    async function initialize() {
        let profile = null;
        let isPlatformAdmin = false;
        let canManageChurchContent = false;

        try {
            let attempts = 0;
            while (!window.sbClient && attempts < 20) {
                await new Promise(resolve => setTimeout(resolve, 150));
                attempts++;
            }

            const client = window.sbClient || window.supabaseClient;
            if (client?.auth) {
                const { data: authData, error: authError } = await client.auth.getUser();
                if (authError) throw authError;
                const user = authData?.user;
                if (user) {
                    const [{ data: profileData, error: profileError }, { data: adminResult, error: adminError }] = await Promise.all([
                        client.from('profiles')
                            .select('role, church_id, status, is_blocked, display_name, full_name, avatar_url')
                            .eq('id', user.id)
                            .maybeSingle(),
                        client.rpc('is_super_admin')
                    ]);

                    if (profileError) console.warn('Workspace profile navigation data unavailable:', profileError);
                    profile = profileData || null;
                    if (adminError) console.warn('Platform administrator navigation check failed:', adminError);
                    isPlatformAdmin = !adminError && adminResult === true;

                    if (profile?.church_id && isActiveProfile(profile) && !isPlatformAdmin) {
                        const { data: managerResult, error: managerError } = await client.rpc(
                            'can_manage_church_content', { p_church_id: profile.church_id }
                        );
                        if (managerError) {
                            console.warn('Church-management navigation check failed:', managerError);
                        } else {
                            canManageChurchContent = managerResult === true;
                        }
                    } else {
                        canManageChurchContent = isPlatformAdmin;
                    }
                }
            }
        } catch (error) {
            console.warn('Workspace navigation initialized with restricted menu:', error);
        }

        render(profile, isPlatformAdmin, canManageChurchContent);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        void initialize();
    }
})();
