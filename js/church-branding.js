/* BelieversMeet shared church branding.
 * Reads the church_id from the authenticated user's profile (never localStorage).
 * Public homepage and public-church.html intentionally use their own branding.
 */
(function () {
    'use strict';

    const DEFAULT_LOGO = 'images/BELIEVERS.LOGO.png';
    let refreshPromise = null;

    function safeHttpUrl(value) {
        if (typeof value !== 'string' || !value.trim()) return null;
        try {
            const parsed = new URL(value, window.location.href);
            if (!['https:', 'http:'].includes(parsed.protocol)) return null;
            if (parsed.username || parsed.password) return null;
            return parsed.href;
        } catch (_) {
            return null;
        }
    }

    function setFallbackVisible(img, visible) {
        const fallback = img?.parentElement?.querySelector('.bm-workspace-logo-fallback');
        if (fallback) fallback.classList.toggle('is-visible', !!visible);
    }

    function setImages(url, churchName) {
        document.querySelectorAll('img[data-bm-church-logo]').forEach((img) => {
            const candidate = safeHttpUrl(url) || DEFAULT_LOGO;
            img.classList.remove('bm-logo-image-failed');
            img.dataset.bmOriginalSrc = candidate;
            img.dataset.bmFallbackAttempted = 'false';
            setFallbackVisible(img, false);

            img.onload = function () {
                this.classList.remove('bm-logo-image-failed');
                setFallbackVisible(this, false);
            };
            img.onerror = function () {
                if (this.dataset.bmFallbackAttempted !== 'true' && this.dataset.bmOriginalSrc !== DEFAULT_LOGO) {
                    this.dataset.bmFallbackAttempted = 'true';
                    this.alt = 'BelieversMeet logo';
                    this.src = DEFAULT_LOGO;
                    return;
                }
                this.classList.add('bm-logo-image-failed');
                this.alt = '';
                setFallbackVisible(this, true);
            };

            img.alt = churchName ? `${churchName} logo` : 'BelieversMeet logo';
            img.src = candidate;
        });
    }

    async function refresh(explicitChurchId) {
        if (refreshPromise) return refreshPromise;
        refreshPromise = (async () => {
            const images = document.querySelectorAll('img[data-bm-church-logo]');
            if (!images.length) return;
            setImages(DEFAULT_LOGO, null);

            const client = window.sbClient || window.supabaseClient;
            if (!client?.auth) return;

            let churchId = explicitChurchId || null;
            if (!churchId) {
                const { data: authData, error: authError } = await client.auth.getUser();
                if (authError || !authData?.user) return;
                const { data: profile, error: profileError } = await client
                    .from('profiles')
                    .select('church_id')
                    .eq('id', authData.user.id)
                    .maybeSingle();
                if (profileError || !profile?.church_id) return;
                churchId = profile.church_id;
            }

            const { data: church, error } = await client
                .from('churches')
                .select('name, logo_url')
                .eq('id', churchId)
                .maybeSingle();
            if (error || !church) return;
            const logoUrl = safeHttpUrl(church.logo_url);
            if (logoUrl) setImages(logoUrl, church.name || null);
        })().catch((error) => {
            console.warn('Church branding could not be loaded; using BelieversMeet fallback.', error);
        }).finally(() => {
            refreshPromise = null;
        });
        return refreshPromise;
    }

    window.BelieversMeetChurchBranding = { refresh, setImages };
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void refresh(), { once: true });
    } else {
        void refresh();
    }
})();
