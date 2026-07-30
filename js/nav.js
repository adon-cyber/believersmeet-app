// Central Dropdown Navigation Script (`js/nav.js`)
(function() {
    async function initDropdownNav() {
        // 1. Locate #navbar container
        const navbarContainer = document.getElementById('navbar');
        if (!navbarContainer) {
            console.error("Critical Error: Element with id 'navbar' not found in document body.");
            return;
        }

        // 2. Determine user role from Supabase if available to conditionally add Admin Panel
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

        // 3. Define all project files as selectable options
        const options = [
            { href: 'feed.html', label: '🌍 Feed' },
            { href: 'groups.html', label: '🏡 Small Groups' },
            { href: 'sermons.html', label: '🎙️ Sermons' },
            { href: 'testimonies.html', label: '🙌 Testimonies' },
            { href: 'events.html', label: '📅 Events' },
            { href: 'prayer-wall.html', label: '🙏 Prayer Wall' },
            { href: 'inbox.html', label: '✉️ Messages' },
            { href: 'profile.html', label: '👤 My Profile' }
        ];

        if (isAdminOrLeader) {
            options.push({ href: 'admin.html', label: '⚙️ Admin Panel' });
        }

        // Read current page pathname to set as active/selected
        const currentFilename = window.location.pathname.split('/').pop() || 'feed.html';

        // Render the clear navigation dropdown box
        navbarContainer.innerHTML = `
            <div style="background: #007bff; border-bottom: 1px solid #0056b3; padding: 12px 20px; display: flex; align-items: center; justify-content: space-between; font-family: system-ui, -apple-system, sans-serif; box-shadow: 0 1px 3px rgba(0,0,0,0.1); margin-bottom: 20px;">
                <div style="display: flex; align-items: center; gap: 10px;">
                    <img src="BELIEVERS.LOGO.png" alt="Church Logo" style="height: 32px; width: 32px; object-fit: contain; border-radius: 50%; background: white; padding: 2px;" />
                    <span style="font-weight: 700; color: #ffffff; font-size: 16px;">BelieversMeet</span>
                </div>
                <div style="display: flex; align-items: center; gap: 12px;">
                    <label for="central-nav-select" style="font-size: 13px; font-weight: 600; color: #ffffff;">Navigation:</label>
                    <select id="central-nav-select" style="padding: 8px 12px; border-radius: 6px; border: 1px solid #cbd5e1; background-color: #ffffff; color: #1e293b; font-size: 14px; font-weight: 500; outline: none; cursor: pointer; transition: border-color 0.2s;">
                        <option value="" disabled>-- Select Page --</option>
                        ${options.map(opt => `<option value="${opt.href}" ${currentFilename === opt.href ? 'selected' : ''}>${opt.label}</option>`).join('')}
                    </select>
                </div>
            </div>
        `;

        // 4 & 5. Attach change event listener so selecting any file immediately redirects
        const selectEl = document.getElementById('central-nav-select');
        if (selectEl) {
            selectEl.addEventListener('change', (e) => {
                const selectedValue = e.target.value;
                if (selectedValue) {
                    window.location.href = selectedValue;
                }
            });
        }
    }

    // Run initialization on DOMContentLoaded or immediately if already loaded
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initDropdownNav);
    } else {
        initDropdownNav();
    }
})();
