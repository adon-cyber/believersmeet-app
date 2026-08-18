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
                const imgItems = gallerySection.querySelectorAll('.gallery-item-hide');
                imgItems.forEach((item, index) => {
                    setTimeout(() => {
                        item.classList.remove('gallery-item-hide');
                        item.classList.add('gallery-item-show');
                    }, index * 120);
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
/**
 * Automatic download function for gallery photos and public church files.
 * Bypasses admin/verification checks entirely so any church member can download automatically.
 * 
 * @param {string} fileUrl - URL of the file/media to download.
 * @param {string} fileName - Suggested filename for download.
 */
window.handleSecureDownload = async function(fileUrl, fileName = 'church-download') {
  try {
    if (!fileUrl) {
      alert('File URL is not available.');
      return;
    }

    // Trigger direct browser download
    const response = await fetch(fileUrl);
    const blob = await response.blob();
    const blobUrl = window.URL.createObjectURL(blob);
    
    const a = document.createElement('a');
    a.style.display = 'none';
    a.href = blobUrl;
    a.download = fileName || 'church-download';
    document.body.appendChild(a);
    a.click();
    
    // Clean up
    window.URL.revokeObjectURL(blobUrl);
    document.body.removeChild(a);
  } catch (err) {
    console.error('Download error:', err);
    // Fallback: Open URL directly in new tab if blob fetch fails
    window.open(fileUrl, '_blank');
  }
};

// Alias for backwards compatibility with any other calls
window.verifyMemberDownloadAuth = async function() {
    return true;
};
window.downloadMediaFile = window.handleSecureDownload;
