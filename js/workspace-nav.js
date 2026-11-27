/* BelieversMeet Workspace Navigation v1
 * Shared white/grey application shell for authenticated pages.
 * Navigation visibility is a convenience only; database/RPC authorization remains authoritative.
 */
(function () {
    'use strict';

    const root = document.getElementById('navbar');
    if (!root) return;

    const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[char]);

    const safeImageUrl = value => {
        if (typeof value !== 'string' || !value.trim()) return '';
        try {
            const url = new URL(value, window.location.href);
            return ['https:', 'http:'].includes(url.protocol) ? url.href : '';
        } catch (_) {
            return '';
        }
    };

    function currentFile() {
        return (window.location.pathname.split('/').pop() || 'feed.html').toLowerCase();
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

    function buildSections(profile, isPlatformAdmin) {
        const role = String(profile?.role || '').trim().toLowerCase();
        const active = profile?.status === 'active' && profile?.is_blocked !== true;
        const churchAdmin = active && ['church_admin', 'admin'].includes(role);
        const canSeeAdmin = isPlatformAdmin || churchAdmin;
        const canSeeAccounting = isPlatformAdmin || (active && ['finance', 'church_admin', 'admin'].includes(role));

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
                    ...(canSeeAccounting ? [
                        { href: 'accounting.html', label: 'Accounting', icon: 'fa-calculator' },
                        { href: 'accounting-team.html', label: 'Accounting Team', icon: 'fa-people-arrows-left-right' }
                    ] : [])
                ]
            },
            {
                label: 'Resources', icon: 'fa-folder-open', open: false,
                items: [
                    { href: 'documents.html', label: 'File Manager', icon: 'fa-folder' },
                    { href: 'profile.html', label: 'My Profile', icon: 'fa-user-circle' },
                    { href: 'settings.html', label: 'Settings', icon: 'fa-gear' }
                ]
            }
        ];

        if (canSeeAdmin || isPlatformAdmin) {
            sections.push({
                label: 'Administration', icon: 'fa-shield-halved', open: false,
                items: [
                    ...(canSeeAdmin ? [{ href: 'admin.html', label: 'Admin Panel', icon: 'fa-screwdriver-wrench' }] : []),
                    ...(isPlatformAdmin ? [{ href: 'super-admin.html', label: 'Super Admin', icon: 'fa-shield-halved' }] : [])
                ]
            });
        }

        return sections;
    }

    function render(profile, isPlatformAdmin) {
        const file = currentFile();
        const sections = buildSections(profile, isPlatformAdmin);
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
                            id="bm-workspace-sidebar-toggle" aria-label="Toggle navigation" aria-expanded="true" title="Toggle navigation">
                        <i class="fas fa-bars" aria-hidden="true"></i>
                    </button>
                    <a class="bm-workspace-brand" href="feed.html" aria-label="BelieversMeet home">
                        <span class="bm-workspace-brand-mark">
                            <img id="church-logo-img" data-bm-church-logo src="images/BELIEVERS.LOGO.png" alt="BelieversMeet logo">
                            <span id="church-logo-placeholder" class="hidden">BM</span>
                        </span>
                        <span>BelieversMeet</span>
                    </a>
                </div>

                <nav class="bm-workspace-shortcuts" aria-label="Quick navigation">
                    ${shortcuts.map(item => {
                        const active = item.href === file;
                        return `<a href="${item.href}" title="${item.label}" aria-label="${item.label}" ${active ? 'aria-current="page"' : ''} class="bm-workspace-shortcut${active ? ' is-active' : ''}"><i class="fas ${item.icon}" aria-hidden="true"></i></a>`;
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
                    <!-- Hidden logout hook lets the existing notifications module place its bell here. -->
                    <button type="button" class="hidden" onclick="logoutUser(event)" title="Log out" aria-label="Log out" tabindex="-1"></button>
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
                    <button type="button" class="bm-workspace-side-logout" onclick="logoutUser(event)" title="Log out" aria-label="Log out">
                        <i class="fas fa-right-from-bracket" aria-hidden="true"></i>
                        <span>Log out</span>
                    </button>
                </div>
            </aside>`;

        bindInteractions();
        document.body.classList.add('bm-workspace-shell');
    }

    function bindInteractions() {
        const toggle = document.getElementById('bm-workspace-sidebar-toggle');
        const overlay = document.getElementById('bm-workspace-sidebar-overlay');
        const launcherToggle = document.getElementById('bm-workspace-app-launcher-toggle');
        const launcher = document.getElementById('bm-workspace-app-launcher');

        const closeMobileSidebar = () => {
            document.body.classList.remove('bm-workspace-mobile-open');
            if (overlay) overlay.setAttribute('tabindex', '-1');
            if (toggle) {
                const isMobile = window.matchMedia('(max-width: 767px)').matches;
                const expanded = isMobile ? false : !document.body.classList.contains('bm-workspace-sidebar-collapsed');
                toggle.setAttribute('aria-expanded', String(expanded));
            }
        };

        if (toggle) {
            toggle.setAttribute('aria-expanded', String(!window.matchMedia('(max-width: 767px)').matches));
            toggle.addEventListener('click', () => {
                if (window.matchMedia('(max-width: 767px)').matches) {
                    const open = document.body.classList.toggle('bm-workspace-mobile-open');
                    toggle.setAttribute('aria-expanded', String(open));
                    if (overlay) overlay.setAttribute('tabindex', open ? '0' : '-1');
                } else {
                    const collapsed = document.body.classList.toggle('bm-workspace-sidebar-collapsed');
                    toggle.setAttribute('aria-expanded', String(!collapsed));
                }
            });
        }

        if (overlay) overlay.addEventListener('click', closeMobileSidebar);

        if (launcherToggle && launcher) {
            launcherToggle.addEventListener('click', event => {
                event.stopPropagation();
                const opening = launcher.hidden;
                launcher.hidden = !opening;
                launcherToggle.setAttribute('aria-expanded', String(opening));
            });
        }

        document.addEventListener('click', event => {
            if (launcher && !launcher.hidden && !event.target.closest('.bm-workspace-app-launcher-wrap')) {
                launcher.hidden = true;
                launcherToggle?.setAttribute('aria-expanded', 'false');
            }
            if (window.matchMedia('(max-width: 767px)').matches &&
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

        window.addEventListener('resize', () => {
            if (window.matchMedia('(max-width: 767px)').matches) {
                document.body.classList.remove('bm-workspace-sidebar-collapsed');
            } else {
                closeMobileSidebar();
            }
        });
    }

    async function initialize() {
        let profile = null;
        let isPlatformAdmin = false;
        try {
            let attempts = 0;
            while (!window.sbClient && attempts < 20) {
                await new Promise(resolve => setTimeout(resolve, 150));
                attempts++;
            }

            if (window.sbClient) {
                const { data: authData, error: authError } = await window.sbClient.auth.getUser();
                if (authError) throw authError;
                const user = authData?.user;
                if (user) {
                    const [{ data: profileData, error: profileError }, { data: adminResult, error: adminError }] = await Promise.all([
                        window.sbClient.from('profiles').select('*').eq('id', user.id).maybeSingle(),
                        window.sbClient.rpc('is_super_admin')
                    ]);
                    if (profileError) console.warn('Workspace profile navigation data unavailable:', profileError);
                    profile = profileData || null;
                    if (adminError) console.warn('Platform administrator navigation check failed:', adminError);
                    isPlatformAdmin = !adminError && adminResult === true;
                }
            }
        } catch (error) {
            console.warn('Workspace navigation initialized with restricted menu:', error);
        }

        render(profile, isPlatformAdmin);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initialize, { once: true });
    } else {
        void initialize();
    }
})();
