// js/app-utils.js - Shared utilities for animations and member media downloads

/**
 * Initializes the cascading gallery entrance animation using IntersectionObserver.
 * Target container should have id="gallery-section" (or pass a selector) and items should have class="gallery-img-item".
 */
window.initAnimatedGallery = function(sectionId = 'gallery-section') {
    const gallerySection = document.getElementById(sectionId);
    if (!gallerySection) return;

    const observer = new IntersectionObserver((entries, observerInstance) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                const imgItems = gallerySection.querySelectorAll('.gallery-img-item');
                imgItems.forEach((item, index) => {
                    setTimeout(() => {
                        item.classList.remove('opacity-0', 'translate-y-10');
                        item.classList.add('opacity-100', 'translate-y-0');
                    }, index * 150);
                });
                observerInstance.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.1
    });

    observer.observe(gallerySection);
};

/**
 * Checks whether the current user is logged in and whether they are a confirmed church member.
 * For Church Admin / User dashboards, restricts media downloads to authenticated members only.
 * 
 * @param {boolean} requireChurchMember - If true, explicitly checks profile data to confirm 'church member' role (User Dashboard).
 * @returns {Promise<boolean>} - True if download is authorized, false otherwise.
 */
window.verifyMemberDownloadAuth = async function(requireChurchMember = true) {
    try {
        if (typeof window.sbClient === 'undefined' || !window.sbClient) {
            alert("Authentication client not initialized.");
            return false;
        }

        const { data: { session }, error: sessionError } = await window.sbClient.auth.getSession();
        if (sessionError || !session || !session.user) {
            alert("You must be an approved church member to download teachings.");
            return false;
        }

        if (requireChurchMember) {
            const userId = session.user.id;
            const { data: profile, error: profileError } = await window.sbClient
                .from('profiles')
                .select('role, church_id, status, membership_status')
                .eq('id', userId)
                .maybeSingle();

            if (profileError || !profile) {
                alert("You must be an approved church member to download teachings.");
                return false;
            }

            const role = (profile.role || '').toLowerCase();
            const membershipStatus = (profile.membership_status || profile.status || '').toLowerCase();
            
            const isAuthorizedMember = role.includes('member') || 
                                       role.includes('admin') || 
                                       role.includes('leader') ||
                                       membershipStatus === 'member' ||
                                       membershipStatus === 'active' ||
                                       profile.church_id != null;

            if (!isAuthorizedMember) {
                alert("You must be an approved church member to download teachings.");
                return false;
            }
        }

        return true;
    } catch (err) {
        console.error("Authorization verification error:", err);
        alert("You must be an approved church member to download teachings.");
        return false;
    }
};

/**
 * Handles media item download with authorization check.
 * 
 * @param {string} mediaUrl - URL of the file/media to download.
 * @param {string} filename - Suggested filename for download.
 * @param {boolean} requireChurchMember - Whether church member role check is mandatory.
 */
window.handleSecureDownload = async function(mediaUrl, filename = 'church-media', requireChurchMember = true) {
    const isAuthorized = await window.verifyMemberDownloadAuth(requireChurchMember);
    if (!isAuthorized) return;

    if (!mediaUrl) {
        alert("Media file URL not available for download.");
        return;
    }

    try {
        const response = await fetch(mediaUrl);
        const blob = await response.blob();
        const blobUrl = window.URL.createObjectURL(blob);
        
        const a = document.createElement('a');
        a.href = blobUrl;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        window.URL.revokeObjectURL(blobUrl);
    } catch (err) {
        console.error("Download execution error, falling back to direct link:", err);
        const a = document.createElement('a');
        a.href = mediaUrl;
        a.target = '_blank';
        a.download = filename;
        a.click();
    }
};
