/**
 * js/feed.js - Community Fellowship Feed Script
 */

let loggedInUser = null;
let currentUserProfile = null; 
let cachedPosts = []; 
let activeFilter = 'All';
let discoveryProfiles = [];
let currentDiscoveryIndex = 0;

// Helper guard function for image URLs
const isValidImageUrl = (url) => typeof url === 'string' && url.trim().startsWith('http') && !url.includes('@');

// Utility function to sanitize strings and prevent XSS
function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

document.addEventListener('DOMContentLoaded', () => {
    enforceLoginAndLoad().catch(err => console.error("Initialization error:", err));
    setTimeout(loadChurchProgrammes, 300); // Slight delay ensures DB client is ready
});

async function loadDiscoveryProfiles() {
    if (!currentUserProfile) return;
    
    try {
        let query = window.sbClient
            .from('profiles')
            .select('*')
            .neq('id', loggedInUser.id);

        if (currentUserProfile.church_id && currentUserProfile.church_id !== 'global-fellowship') {
            query = query.eq('church_id', currentUserProfile.church_id);
        }

        const { data, error } = await query;
        if (error) {
            console.error("Error loading discovery profiles:", error.message);
            const container = document.getElementById('discovery-card-container');
            if (container) {
                container.innerHTML = '<p class="text-red-500 text-sm py-4">Unable to load fellowship profiles.</p>';
            }
            return;
        }

        discoveryProfiles = data || [];
        
        // Populate home cell dropdown dynamically
        const cellSelect = document.getElementById('discovery-filter-cell');
        if (cellSelect) {
            const uniqueCells = [...new Set(discoveryProfiles.map(p => p.home_cell).filter(Boolean))];
            cellSelect.innerHTML = '<option value="All">🏡 All Home Cells</option>' + uniqueCells.map(c => `<option value="${escapeHTML(c)}">${escapeHTML(c)}</option>`).join('');
        }

        currentDiscoveryIndex = 0;
        renderCurrentDiscoveryCard();
    } catch (err) {
        console.error("Exception in loadDiscoveryProfiles:", err);
        const container = document.getElementById('discovery-card-container');
        if (container) {
            container.innerHTML = '<p class="text-red-500 text-sm py-4">Unable to load fellowship profiles.</p>';
        }
    }
}

function applyDiscoveryFilters() {
    currentDiscoveryIndex = 0;
    renderCurrentDiscoveryCard();
}

function getFilteredDiscoveryProfiles() {
    const cellFilterEl = document.getElementById('discovery-filter-cell');
    const roleFilterEl = document.getElementById('discovery-filter-role');
    const cellFilter = cellFilterEl ? cellFilterEl.value : 'All';
    const roleFilter = roleFilterEl ? roleFilterEl.value : 'All';

    return discoveryProfiles.filter(p => {
        const matchCell = cellFilter === 'All' || p.home_cell === cellFilter;
        const matchRole = roleFilter === 'All' || p.role === roleFilter;
        return matchCell && matchRole;
    });
}

async function renderCurrentDiscoveryCard() {
    const container = document.getElementById('discovery-card-container');
    if (!container) return;

    try {
        const filtered = getFilteredDiscoveryProfiles();

        if (filtered.length === 0 || currentDiscoveryIndex >= filtered.length) {
            container.innerHTML = `
                <div class="text-center py-10 px-4">
                    <div class="text-3xl mb-2">🌿</div>
                    <h4 class="text-base font-bold text-gray-800">No More Profiles to Discover</h4>
                    <p class="text-xs text-gray-500 mt-1 mb-4">You have viewed all available believers matching your filters.</p>
                    <button onclick="currentDiscoveryIndex=0; renderCurrentDiscoveryCard();" class="px-4 py-2 bg-blue-50 text-blue-700 text-xs font-bold rounded-lg hover:bg-blue-100 transition">Restart Discovery</button>
                </div>
            `;
            return;
        }

        const profile = filtered[currentDiscoveryIndex];
        const rawAvatarUrl = profile.avatar_url || '';
        const avatarUrl = isValidImageUrl(rawAvatarUrl) ? rawAvatarUrl : `https://ui-avatars.com/api/?name=${encodeURIComponent(profile.full_name || 'Believer')}&background=2563eb&color=fff`;

        // Check if connection already exists between loggedInUser and profile
        let connectionState = 'none';
        try {
            const { data: connData } = await window.sbClient
                .from('connections')
                .select('*')
                .or(`and(requester_id.eq.${loggedInUser.id},recipient_id.eq.${profile.id}),and(requester_id.eq.${profile.id},recipient_id.eq.${loggedInUser.id})`)
                .maybeSingle();
            
            if (connData) {
                if (connData.status === 'accepted') {
                    connectionState = 'accepted';
                } else if (connData.status === 'pending') {
                    connectionState = 'pending';
                }
            }
        } catch (e) {
            console.error("Error checking connection status for card:", e);
        }

        let buttonHTML = `<button onclick="sendFriendRequest('${profile.id}', this)" class="flex-1 sm:flex-initial px-6 py-2 bg-blue-600 text-white hover:bg-blue-700 font-bold rounded-xl text-xs transition shadow-sm flex items-center justify-center gap-1.5">🤝 Connect</button>`;
        if (connectionState === 'pending') {
            buttonHTML = `<button disabled class="flex-1 sm:flex-initial px-3.5 py-1.5 rounded-xl bg-slate-800/80 text-amber-400/90 border border-amber-500/30 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-not-allowed opacity-90 shadow-sm">⏳ Request Pending</button>`;
        } else if (connectionState === 'accepted') {
            buttonHTML = `<button disabled class="flex-1 sm:flex-initial px-6 py-2 bg-green-600 text-white font-bold rounded-lg text-xs cursor-not-allowed shadow-none flex items-center justify-center gap-1.5">✓ Connected</button>`;
        }

        container.innerHTML = `
            <div class="w-full bg-white rounded-xl border border-gray-100 shadow-sm p-5 flex flex-col sm:flex-row gap-5 items-center">
                <img src="${avatarUrl}" alt="Profile Photo" class="w-24 h-24 sm:w-32 sm:h-32 rounded-full object-cover border-4 border-blue-50 shadow-inner flex-shrink-0">
                <div class="flex-1 text-center sm:text-left">
                    <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-1 mb-2">
                        <h4 class="text-lg font-bold text-gray-900">${escapeHTML(profile.full_name || 'Believer')}</h4>
                        <span class="inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${profile.role === 'admin' ? 'bg-blue-100 text-blue-800' : 'bg-blue-100 text-blue-800'}">${profile.role === 'admin' ? 'Leadership' : 'Fellowship Member'}</span>
                    </div>

                    ${profile.home_cell ? `<p class="text-xs text-gray-600 mb-2 flex items-center justify-center sm:justify-start gap-1">🏡 Cell: <strong class="text-gray-800">${escapeHTML(profile.home_cell)}</strong></p>` : ''}
                    
                    <p class="text-xs text-gray-700 mb-3 italic line-clamp-2">"${escapeHTML(profile.bio || 'Seeking fellowship and spiritual growth in the body of Christ.')}"</p>

                    ${profile.favorite_scripture ? `<div class="p-2 bg-blue-50 rounded-lg border-l-2 border-blue-500 text-xs text-blue-900 mb-4 text-left">📖 "${escapeHTML(profile.favorite_scripture)}"</div>` : ''}

                    <div class="flex items-center justify-center sm:justify-start gap-3">
                        <button onclick="handlePassProfile('${profile.id}')" class="flex-1 sm:flex-initial px-5 py-2 bg-gray-100 text-gray-700 hover:bg-gray-200 font-bold rounded-lg text-xs transition shadow-sm">
                            ✕ Pass
                        </button>
                        ${buttonHTML}
                    </div>
                </div>
            </div>
        `;
    } catch (err) {
        console.error("Error rendering discovery card:", err);
        container.innerHTML = '<p class="text-red-500 text-sm py-4">Unable to render profile.</p>';
    }
}

async function handlePassProfile(targetUserId) {
    currentDiscoveryIndex++;
    renderCurrentDiscoveryCard();
}

async function sendFriendRequest(receiverId, buttonElement) {
    if (!buttonElement) {
        console.error("Button element not passed to sendFriendRequest");
        return;
    }

    // Preserve original content in case of error
    const originalHtml = buttonElement.innerHTML;
    const originalClass = buttonElement.className;

    // 1. Immediately update UI to Pending state
    buttonElement.disabled = true;
    buttonElement.innerHTML = `<span>⏳ Request Pending</span>`;
    buttonElement.className = "px-3.5 py-1.5 rounded-xl bg-slate-800/80 text-amber-400/90 border border-amber-500/30 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-not-allowed opacity-90 transition-all shadow-sm";

    // 2. Perform Supabase database insert
    const client = window.sbClient || window.supabase;
    const { data: { user } } = await client.auth.getUser();

    if (!user) {
        buttonElement.disabled = false;
        buttonElement.innerHTML = originalHtml;
        buttonElement.className = originalClass;
        alert('Please log in to send friend requests.');
        return;
    }

    const { error } = await client
        .from('connections')
        .insert([
            { requester_id: user.id, recipient_id: receiverId, status: 'pending' }
        ]);

    if (error) {
        console.error('Connection request failed:', error);
        // Check if error is duplicate key violation (code '23505' or message contains 'duplicate key')
        if (error.code === '23505' || (error.message && error.message.includes('duplicate key'))) {
            // Keep button in disabled pending state as requested or friendly alert
            buttonElement.disabled = true;
            buttonElement.innerHTML = `<span>⏳ Request Pending</span>`;
            buttonElement.className = "px-3.5 py-1.5 rounded-xl bg-slate-800/80 text-amber-400/90 border border-amber-500/30 text-xs font-semibold flex items-center justify-center gap-1.5 cursor-not-allowed opacity-90 transition-all shadow-sm";
            alert('You have already sent a request to this member!');
        } else {
            // Revert UI if any other error
            buttonElement.disabled = false;
            buttonElement.innerHTML = originalHtml;
            buttonElement.className = originalClass;
            alert('Error sending request: ' + error.message);
        }
    }
}

async function enforceLoginAndLoad() {
    let attempts = 0;
    while (!window.sbClient && attempts < 15) { await new Promise(r => setTimeout(r, 200)); attempts++; }
    if (!window.sbClient) {
        console.error("Supabase client failed to initialize.");
        return;
    }
    
    const { data: { user } } = await window.sbClient.auth.getUser();
    if (!user) { window.location.replace('login.html'); return; }
    loggedInUser = user;

    const { data: profile, error: profileError } = await window.sbClient
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

    if (profileError) {
        console.error("Profile payload retrieval error:", profileError.message);
    }

    if (profile) {
        currentUserProfile = profile;
        const adminNavLink = document.getElementById('admin-nav-link');
        if (adminNavLink && (profile.role === 'admin' || profile.role === 'super_admin')) {
            adminNavLink.style.display = 'inline-block';
        }
        const ministryRequestsNavTab = document.getElementById('ministry-requests-nav-tab');
        if (ministryRequestsNavTab) {
            ministryRequestsNavTab.remove();
        }
        const ministrySection = document.getElementById('ministry-requests-section');
        if (ministrySection) {
            ministrySection.remove();
        }
        if (profile.role === 'admin' || profile.role === 'super_admin' || profile.role === 'super-admin') {
            const leadershipSection = document.getElementById('manage-leadership-section');
            if (leadershipSection) {
                leadershipSection.classList.remove('hidden');
                const leadershipForm = document.getElementById('admin-leadership-upload-form');
                if (leadershipForm) {
                    leadershipForm.addEventListener('submit', handleAdminLeadershipUpload);
                }
                fetchAdminLeadership(profile.church_id);
            }
        }
        const shareProfileBtn = document.getElementById('share-church-profile-btn');
        if (shareProfileBtn && (profile.role === 'admin' || profile.role === 'super_admin' || profile.role === 'super-admin')) {
            shareProfileBtn.classList.remove('hidden');
        }

        // Show Admin Upload form within the gallery section if user is admin / super_admin / leader
        const adminGalleryUploadWrapper = document.getElementById('admin-gallery-upload-wrapper');
        if (adminGalleryUploadWrapper && (profile.role === 'admin' || profile.role === 'super_admin' || profile.role === 'super-admin' || profile.role === 'leader')) {
            adminGalleryUploadWrapper.classList.remove('hidden');
            const uploadForm = document.getElementById('admin-gallery-upload-form');
            if (uploadForm) {
                uploadForm.addEventListener('submit', handleAdminGalleryUpload);
            }
        }
    } else {
        console.warn("Public profile row missing. Utilizing safe global fallback.");
        currentUserProfile = {
            id: user.id,
            role: 'user',
            church_id: 'global-fellowship',
            full_name: user.email ? user.email.split('@')[0] : 'A Believer'
        };
    }

    // Decouple all widget initializations using Promise.allSettled and independent try...catch blocks
    await Promise.allSettled([
        loadAnnouncements().catch(err => console.error("Bulletins error:", err)),
        loadFeedGallery().catch(err => console.error("Gallery error:", err)),
        fetchAndRenderWallTimeline().catch(err => console.error("Feed error:", err)),
        loadDiscoveryProfiles().catch(err => console.error("Fellowship error:", err)),
        loadMusicPlaylist().catch(err => console.error("Music error:", err)),
        fetchAndRenderWidgetVerse('John 3:16').catch(err => console.error("Bible error:", err)),
        // 4. Load Daily Scripture & Personal Reflections (VOTD)
        loadDailyVerseAndReflections().catch(err => console.error("VOTD error:", err)),
        loadChurchProgrammes().catch(err => console.error("Programmes error:", err)),
        loadCommunityNeeds('All').catch(err => console.error("Community Needs error:", err))
    ]);

    initTimelineRealtimeSync(); 
    
    const postForm = document.getElementById('post-composition-form');
    if (postForm) {
        postForm.addEventListener('submit', handleOutboundPostSubmit);
    }
    
    // Conditional rendering of Private Leadership Inbox widget based on user role
    const inboxContainer = document.getElementById('leadership-inbox-widget-container');
    if (inboxContainer && currentUserProfile) {
        const isAdmin = currentUserProfile.role === 'admin' || currentUserProfile.role === 'super_admin' || currentUserProfile.role === 'super-admin';
        if (isAdmin) {
            inboxContainer.innerHTML = `
                <h4 class="text-lg font-bold text-blue-600 mb-3">✉️ Private Leadership Inbox</h4>
                <div class="text-center py-4">
                    <p class="text-sm font-medium text-gray-700 mb-3">You are logged in as an Administrator.</p>
                    <a href="chat.html" class="inline-block w-full py-2 px-4 bg-blue-600 text-white rounded-lg text-sm font-bold text-center hover:bg-blue-700 transition shadow">View Leadership Inbox</a>
                </div>
            `;
        } else {
            // Render standard member form
            inboxContainer.innerHTML = `
                <h4 class="text-lg font-bold text-blue-600 mb-3">✉️ Private Leadership Inbox</h4>
                <form id="leadership-inbox-form">
                    <textarea id="inbox-message-text" rows="3" placeholder="Send a private message to the Church Admin panel..." required class="w-full p-2.5 mb-3 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-500 outline-none resize-y"></textarea>
                    <button type="submit" class="w-full py-2 px-4 bg-blue-600 text-white rounded-lg text-sm font-bold hover:bg-blue-700 transition shadow">Send Secure Inquiry</button>
                </form>
            `;
            
            const inboxForm = document.getElementById('leadership-inbox-form');
            if (inboxForm) {
                inboxForm.addEventListener('submit', async (e) => {
                    e.preventDefault();
                    if (!currentUserProfile) return;
                    const textInput = document.getElementById('inbox-message-text');
                    if (!textInput) return;
                    const { error } = await window.sbClient.from('inbox').insert([{
                        sender_name: currentUserProfile.full_name,
                        message: textInput.value,
                        church_id: currentUserProfile.church_id
                    }]);
                    if (!error) {
                        alert("Inquiry successfully delivered to leadership dashboards!");
                        textInput.value = '';
                    } else {
                        alert("Error sending message: " + error.message);
                    }
                });
            }
        }
    }

    const bodyEl = document.body;
    if (bodyEl) {
        bodyEl.style.display = 'flex';
    }
}

// --- TIMELINE FEED REALTIME CHANNEL ---
function initTimelineRealtimeSync() {
    if (!currentUserProfile || !window.sbClient) return;

    try {
        window.sbClient
            .channel('interactive-timeline-channel')
            .on('postgres_changes', { event: '*', schema: 'public', table: 'posts' }, () => {
                fetchAndRenderWallTimeline();
            })
            .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'comments' }, () => {
                fetchAndRenderWallTimeline();
            })
            .subscribe((status) => {
                console.log("Timeline Core Sync Status:", status);
            });
    } catch (err) {
        console.error("Realtime subscription error:", err);
    }
}

// --- FEED GALLERY MEMORIES ---
async function loadFeedGallery() {
    const container = document.getElementById('feed-gallery-container');
    if (!container) return;

    if (!currentUserProfile || !currentUserProfile.church_id) {
        container.innerHTML = '<p class="col-span-full text-center text-xs text-gray-500 py-4">Account pending church assignment...</p>';
        return;
    }

    try {
        let query = window.sbClient
            .from('gallery_images')
            .select('*');

        if (currentUserProfile.church_id !== 'global-fellowship') {
            query = query.eq('church_id', currentUserProfile.church_id);
        }

        const { data: photos, error } = await query
            .order('created_at', { ascending: false })
            .limit(10);

        if (!error && photos) {
            renderFeedGallerySection(photos);
        } else {
            console.error("Error loading feed gallery:", error?.message);
            container.innerHTML = '<p class="col-span-full text-center text-xs text-red-500 py-4">Unable to load gallery memories</p>';
        }
    } catch (err) {
        console.error("Exception loading feed gallery:", err);
        container.innerHTML = '<p class="col-span-full text-center text-xs text-red-500 py-4">Unable to load gallery memories</p>';
    }
}

function renderFeedGallerySection(photos) {
    const container = document.getElementById('feed-gallery-container');
    if (!container) return;

    if (!photos || photos.length === 0) {
        container.innerHTML = '<p class="col-span-full text-center text-xs text-gray-500 py-4">No gallery photos uploaded yet.</p>';
        return;
    }

    container.innerHTML = photos.map(photo => {
        const rawImageUrl = photo.image_url || '';
        const safeImageUrl = isValidImageUrl(rawImageUrl) ? rawImageUrl : 'assets/images/default-placeholder.png';
        const isVideo = safeImageUrl && (safeImageUrl.endsWith('.mp4') || safeImageUrl.endsWith('.webm') || safeImageUrl.includes('video'));
        return `
        <div class="gallery-item-hide group block relative aspect-square bg-gray-100 rounded-xl overflow-hidden shadow-sm border border-gray-200 hover:scale-105 hover:shadow-lg hover:shadow-blue-100 transition-all duration-300">
            ${isVideo ? `
                <video src="${escapeHTML(safeImageUrl)}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" preload="metadata"></video>
                <div class="absolute inset-0 flex items-center justify-center pointer-events-none">
                    <div class="w-10 h-10 bg-black/60 rounded-full flex items-center justify-center text-white shadow-lg">
                        <svg class="w-5 h-5 translate-x-0.5" fill="currentColor" viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg>
                    </div>
                </div>
            ` : `
                <img src="${escapeHTML(safeImageUrl)}" alt="${escapeHTML(photo.caption || 'Church Memory')}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300">
            `}
            <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition flex items-end p-2 justify-between">
                <p class="text-white text-xs opacity-0 group-hover:opacity-100 transition truncate">${escapeHTML(photo.caption || '')}</p>
                <button onclick="handleSecureDownload('${escapeHTML(safeImageUrl)}', 'gallery-memory.jpg', true)" class="absolute bottom-2 right-2 w-7 h-7 bg-white/90 hover:bg-white text-blue-600 rounded-full shadow flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity" title="Download Item">
                    <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4"></path></svg>
                </button>
            </div>
        </div>
    `;
    }).join('');

    // Trigger animation strictly after injecting DOM elements
    setTimeout(() => {
        if (typeof window.initAnimatedGallery === 'function') {
            window.initAnimatedGallery('gallery-section');
        }
    }, 50);
}

async function handleAdminGalleryUpload(e) {
    e.preventDefault();
    if (!currentUserProfile || !currentUserProfile.church_id) {
        alert("Admin profile or church ID missing.");
        return;
    }

    const fileInput = document.getElementById('gallery-file-input');
    const captionInput = document.getElementById('gallery-caption-input');
    const submitBtn = document.getElementById('gallery-upload-submit-btn');

    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        alert("Please select a file to upload.");
        return;
    }

    const file = fileInput.files[0];
    const caption = captionInput ? captionInput.value : 'Church Memory';
    const originalBtnText = submitBtn.innerHTML;

    try {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading...';
        }

        const fileExt = file.name.split('.').pop();
        const randStr = Math.random().toString(36).substring(2, 8);
        const fileName = `${currentUserProfile.church_id}/${Date.now()}_${randStr}.${fileExt}`;
        const bucketName = 'music-uploads'; // Approved public bucket used across the app

        const { data: uploadData, error: uploadError } = await window.sbClient.storage
            .from(bucketName)
            .upload(fileName, file, { upsert: true });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = window.sbClient.storage
            .from(bucketName)
            .getPublicUrl(fileName);

        if (!publicUrl) throw new Error("Could not retrieve public URL for uploaded file.");

        const { error: insertError } = await window.sbClient
            .from('gallery_images')
            .insert([{
                image_url: publicUrl,
                caption: caption,
                church_id: currentUserProfile.church_id,
                uploader_name: currentUserProfile.full_name || 'Church Admin'
            }]);

        if (insertError) throw insertError;

        alert("Gallery media successfully uploaded and published!");
        if (fileInput) fileInput.value = '';
        if (captionInput) captionInput.value = '';

        // Reload gallery
        await loadFeedGallery();

    } catch (err) {
        console.error("Gallery upload error:", err);
        alert("Error uploading media: " + (err.message || err));
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
    }
}

// --- TIMELINE FEED & BULLETIN HANDLERS ---
async function loadAnnouncements() {
    const container = document.getElementById('announcements-container');
    if (!container) return;

    if (!currentUserProfile || !currentUserProfile.church_id) {
        container.innerHTML = '<p class="text-gray-500 text-xs">Account pending assignment...</p>';
        return;
    }

    try {
        const { data, error } = await window.sbClient
            .from('announcements')
            .select('*')
            .eq('church_id', currentUserProfile.church_id) 
            .order('pinned', { ascending: false }) 
            .order('created_at', { ascending: false });

        if (error) { 
            container.innerHTML = "<p class='text-red-500 text-xs'>Unable to load bulletins.</p>"; 
            return; 
        }

        container.innerHTML = data && data.length > 0 ? data.map(ann => `
            <div class="p-3 bg-gray-50 border border-gray-200 rounded-lg">
                <h4 class="font-bold text-gray-800 text-xs">${ann.pinned ? '📌 ' : ''}${escapeHTML(ann.title)}</h4>
                <p class="text-xs text-gray-600 mt-1">${escapeHTML(ann.content)}</p>
            </div>
        `).join('') : '<p class="text-gray-500 text-xs">No bulletins posted yet.</p>';
    } catch (err) {
        console.error("Error loading announcements:", err);
        container.innerHTML = "<p class='text-red-500 text-xs'>Unable to load bulletins.</p>";
    }
}

async function fetchAndRenderWallTimeline() {
    const stream = document.getElementById('feed-wall-stream');
    if (!currentUserProfile || !currentUserProfile.church_id) return;
    
    try {
        let query = window.sbClient
            .from('posts')
            .select('*, profiles:user_id(full_name), comments(id, content, profiles:user_id(full_name))');

        if (currentUserProfile.church_id !== 'global-fellowship') {
            query = query.eq('church_id', currentUserProfile.church_id);
        }

        const { data: posts, error } = await query.order('created_at', { ascending: false });

        if (error) {
            console.error("Error fetching wall timeline:", error.message);
            if (stream) {
                stream.innerHTML = '<p class="text-center text-red-500 text-sm py-8">Unable to load feed posts</p>';
            }
            return;
        }

        if (posts) {
            cachedPosts = posts; 
            renderDataToStream(); 
        }
    } catch (err) {
        console.error("Exception fetching wall timeline:", err);
        if (stream) {
            stream.innerHTML = '<p class="text-center text-red-500 text-sm py-8">Unable to load feed posts</p>';
        }
    }
}

function renderDataToStream() {
    const stream = document.getElementById('feed-wall-stream');
    if (!stream) return;

    const targetPosts = activeFilter === 'All' ? cachedPosts : cachedPosts.filter(p => p.category === activeFilter);

    if (targetPosts.length === 0) {
        stream.innerHTML = `<p class="text-center text-gray-500 text-sm py-8">No posts found under "${activeFilter}" yet.</p>`;
        return;
    }

    stream.innerHTML = targetPosts.map(post => {
        const rawCategory = post.category || 'Encouragement';
        let badgeClass = 'bg-blue-100 text-blue-800 border-blue-200';
        if (rawCategory === 'Prayer Request') {
            badgeClass = 'bg-pink-100 text-pink-800 border-pink-200';
        } else if (rawCategory === 'Testimony') {
            badgeClass = 'bg-amber-100 text-amber-800 border-amber-200';
        }

        const commentsHTML = post.comments && post.comments.length > 0 
            ? post.comments.map(c => `
                <div class="bg-white p-2.5 rounded-lg border border-gray-200 mb-2 text-sm shadow-sm">
                    <div class="font-bold text-gray-700 text-xs">${escapeHTML(c.profiles?.full_name || 'A Believer')}</div>
                    <div class="text-gray-800 mt-0.5">${escapeHTML(c.content)}</div>
                </div>
            `).join('') 
            : '<p class="text-xs text-gray-400 mb-2">No reflections shared yet.</p>';

        return `
            <div class="bg-white p-6 rounded-xl border border-gray-200 shadow-sm relative">
                <div class="flex justify-between items-center text-sm text-gray-500 mb-3">
                    <strong class="text-gray-900 font-semibold">${escapeHTML(post.profiles?.full_name || 'A Believer')}</strong>
                </div>
                
                <span class="inline-block px-3 py-1 rounded-full text-xs font-bold border mb-3 ${badgeClass}">${escapeHTML(rawCategory)}</span>
                <div class="text-gray-800 text-base leading-relaxed whitespace-pre-wrap mb-4">${linkifyBibleReferences(escapeHTML(post.content))}</div>
                
                ${post.bible_link ? `<div class="mb-3"><a href="${escapeHTML(post.bible_link)}" target="_blank" class="text-blue-600 hover:text-blue-700 font-bold text-sm inline-flex items-center gap-1">📖 Read Scripture</a></div>` : ''}
                
                <div>
                    <button class="bg-blue-50 text-blue-800 border border-blue-200 px-3.5 py-1.5 rounded-full text-xs font-bold inline-flex items-center gap-1 hover:bg-blue-100 transition transform active:scale-95 mb-3" onclick="handleAmenSubmit('${post.id}')">
                        🙏 Amen <span>(${post.amen_count || 0})</span>
                    </button>
                </div>

                <div class="border-t border-gray-100 pt-3 mt-3 bg-gray-50 -mx-6 -mb-6 p-4 rounded-b-xl">
                    <div class="comments-list-wrapper mb-3">
                        ${commentsHTML}
                    </div>
                    <form onsubmit="handleInlineCommentSubmit(event, '${post.id}')" class="flex gap-2">
                        <input type="text" id="comment-input-${post.id}" placeholder="Write a reflection..." required class="flex-1 px-3 py-1.5 rounded-lg border border-gray-300 text-sm focus:ring-2 focus:ring-blue-500 outline-none">
                        <button type="submit" class="px-3.5 py-1.5 bg-blue-600 text-white text-sm font-semibold rounded-lg hover:bg-blue-700 transition">Reply</button>
                    </form>
                </div>
            </div>
        `;
    }).join('');
}

function filterTimeline(category, buttonElement) {
    activeFilter = category;
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('bg-blue-600', 'text-white', 'active');
        btn.classList.add('bg-gray-100', 'text-gray-700');
    });
    if (buttonElement) {
        buttonElement.classList.remove('bg-gray-100', 'text-gray-700');
        buttonElement.classList.add('bg-blue-600', 'text-white', 'active');
    }
    renderDataToStream();
}

async function handleAmenSubmit(postId) {
    const currentPost = cachedPosts.find(p => p.id === postId);
    const currentCount = currentPost ? (currentPost.amen_count || 0) : 0;
    const { error } = await window.sbClient.from('posts').update({ amen_count: currentCount + 1 }).eq('id', postId);
    if (error) alert("Error saving Amen: " + error.message);
}

async function handleOutboundPostSubmit(e) {
    e.preventDefault();
    if (!currentUserProfile) return;

    const rawTextEl = document.getElementById('post-raw-text');
    const bibleLinkEl = document.getElementById('bible-link-input');
    const categoryEl = document.getElementById('post-category-input');

    const { error } = await window.sbClient.from('posts').insert([{ 
        content: rawTextEl ? rawTextEl.value : '',
        user_id: loggedInUser.id,
        bible_link: bibleLinkEl ? bibleLinkEl.value : '',
        category: categoryEl ? categoryEl.value : 'Encouragement',
        church_id: currentUserProfile.church_id 
    }]);
    
    if (!error) { 
        if (rawTextEl) rawTextEl.value = ''; 
        if (bibleLinkEl) bibleLinkEl.value = ''; 
        fetchAndRenderWallTimeline();
    } else {
        alert("Error publishing post: " + error.message);
    }
}

async function handleInlineCommentSubmit(e, postId) {
    e.preventDefault();
    const commentInputField = document.getElementById(`comment-input-${postId}`);
    if (!commentInputField) return;
    const content = commentInputField.value;
    
    const { error } = await window.sbClient.from('comments').insert([{ post_id: postId, user_id: loggedInUser.id, content }]);
    if (!error) {
        commentInputField.value = '';
        fetchAndRenderWallTimeline();
    } else {
        alert("Error saving reflection: " + error.message);
    }
}

// --- MUSIC PLAYLIST LOGIC ---
let playlistTracks = [];
let currentTrackIndex = 0;
let isPlaying = false;

async function loadMusicPlaylist() {
    const container = document.getElementById('music-playlist-container');
    if (!container) return;

    if (!currentUserProfile || !currentUserProfile.church_id) {
        container.innerHTML = '<div class="text-sm text-gray-500 italic">Unable to load tracks</div>';
        return;
    }

    try {
        let query = window.sbClient
            .from('worship_songs')
            .select('*');

        if (currentUserProfile.church_id !== 'global-fellowship') {
            query = query.eq('church_id', currentUserProfile.church_id);
        }

        const { data, error } = await query.order('created_at', { ascending: false });

        if (error || !data || data.length === 0) {
            console.warn("Worship songs table empty or unavailable. Using fallback sample tracks.");
            playlistTracks = [
                { id: 'fallback-1', title: 'Amazing Grace (Worship)', artist: 'Believers Ensemble', audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
                { id: 'fallback-2', title: 'Great Is Thy Faithfulness', artist: 'Grace Sanctuary', audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3' }
            ];
        } else {
            playlistTracks = data;
        }

        renderPlaylistUI();
    } catch (err) {
        console.error("Exception loading worship songs:", err);
        playlistTracks = [
            { id: 'fallback-1', title: 'Amazing Grace (Worship)', artist: 'Believers Ensemble', audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3' },
            { id: 'fallback-2', title: 'Great Is Thy Faithfulness', artist: 'Grace Sanctuary', audio_url: 'https://www.soundhelix.com/examples/mp3/SoundHelix-Song-2.mp3' }
        ];
        renderPlaylistUI();
    }
}

function renderPlaylistUI() {
    const container = document.getElementById('music-playlist-container');
    if (!container) return;

    if (!playlistTracks || playlistTracks.length === 0) {
        container.innerHTML = '<div class="text-sm text-gray-500 italic">Unable to load tracks</div>';
        return;
    }

    container.innerHTML = playlistTracks.map((track, index) => {
        const isCurrent = index === currentTrackIndex;
        return `
            <div class="flex items-center justify-between p-3 rounded-lg border ${isCurrent ? 'bg-indigo-50 border-indigo-200' : 'bg-gray-50 border-gray-100 hover:bg-gray-100'} transition cursor-pointer" onclick="playTrack(${index})">
                <div class="flex items-center gap-3 min-w-0">
                    <button class="w-8 h-8 rounded-full ${isCurrent && isPlaying ? 'bg-indigo-600 text-white' : 'bg-indigo-100 text-indigo-600'} flex items-center justify-center text-xs flex-shrink-0">
                        <i class="fas ${isCurrent && isPlaying ? 'fa-pause' : 'fa-play'}"></i>
                    </button>
                    <div class="min-w-0">
                        <p class="text-xs font-bold text-gray-900 truncate">${escapeHTML(track.title)}</p>
                        <p class="text-[10px] text-gray-500 truncate">${escapeHTML(track.artist)}</p>
                    </div>
                </div>
                <div class="flex items-center gap-2">
                    ${isCurrent ? '<span class="text-[10px] font-bold text-indigo-600 uppercase tracking-wider animate-pulse flex-shrink-0">Playing</span>' : ''}
                    <a href="${track.audio_url}" download target="_blank" onclick="event.stopPropagation();" class="w-7 h-7 rounded-full bg-gray-100 hover:bg-gray-200 text-gray-600 flex items-center justify-center text-xs flex-shrink-0" title="Download Song">
                        <i class="fas fa-download"></i>
                    </a>
                </div>
            </div>
        `;
    }).join('');
}

function playTrack(index) {
    const audio = document.getElementById('global-audio-player');
    if (!audio) return;

    if (currentTrackIndex === index && isPlaying) {
        audio.pause();
        isPlaying = false;
        renderPlaylistUI();
        return;
    }

    currentTrackIndex = index;
    const track = playlistTracks[currentTrackIndex];
    if (!track) return;

    audio.src = track.audio_url;
    audio.play().then(() => {
        isPlaying = true;
        renderPlaylistUI();
    }).catch(err => {
        console.error("Audio playback error:", err);
        isPlaying = false;
        renderPlaylistUI();
    });

    audio.onended = () => {
        if (currentTrackIndex < playlistTracks.length - 1) {
            playTrack(currentTrackIndex + 1);
        } else {
            currentTrackIndex = 0;
            playTrack(0);
        }
    };
}

// --- BIBLE & VERSE READER WIDGET LOGIC ---
let currentFetchedVerse = {
    reference: 'John 3:16',
    text: 'For God so loved the world, that he gave his one and only Son, that whoever believes in him should not perish, but have eternal life.'
};

// Standard reference check regex: e.g., "John 3:16", "1 John 3:16-18", "Psalm 23", "Genesis 1:1"
const STANDARD_REF_REGEX = /^\s*((?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d+)(?::(\d+)(?:[–-](\d+))?)?\s*$/i;

async function fetchAndRenderWidgetVerse(query) {
    const container = document.getElementById('bible-widget-container');
    if (!container) return;

    const versionSelect = document.getElementById('bible-version');
    const version = versionSelect ? versionSelect.value : 'web';

    container.innerHTML = `
        <div class="flex items-center justify-center py-4 space-x-2">
            <div class="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
            <span class="text-xs text-gray-500 font-medium">Looking up "${escapeHTML(query)}" (${version.toUpperCase()})...</span>
        </div>
    `;

    const trimmedQuery = query.trim();
    const isReference = /[a-z]+\s*\d+/i.test(trimmedQuery);

    try {
        if (isReference) {
            const url = `https://bible-api.com/${encodeURIComponent(trimmedQuery)}?translation=${version}`;
            const res = await fetch(url);
            if (!res.ok) throw new Error('Scripture reference not found');
            const data = await res.json();
            
            let passageText = '';
            let officialRef = data.reference || trimmedQuery;
            let translationName = data.translation_name || version.toUpperCase();

            if (data.verses && data.verses.length > 0) {
                passageText = data.verses.map(v => `${v.verse}. ${v.text.trim()}`).join(' ');
            } else if (data.text) {
                passageText = data.text.trim();
            } else {
                throw new Error('Scripture reference not found');
            }

            currentFetchedVerse = {
                reference: officialRef,
                text: passageText,
                translation: translationName,
                version: version
            };

            container.innerHTML = `
                <div class="space-y-2">
                    <div class="flex items-center justify-between">
                        <h4 class="text-xs font-bold text-indigo-700">${escapeHTML(officialRef)} <span class="text-[10px] text-gray-500 font-normal">(${escapeHTML(translationName)})</span></h4>
                    </div>
                    <p class="text-xs text-gray-800 leading-relaxed italic">"${escapeHTML(passageText)}"</p>
                </div>
            `;
        } else {
            // Keyword Search using Bolls Life API POST request
            try {
                const response = await fetch('https://bolls.life/search/', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify({
                        search: trimmedQuery,
                        translations: [version.toUpperCase()]
                    })
                });

                if (!response.ok) {
                    throw new Error('Keyword search failed');
                }

                const data = await response.json();
                const results = data.results || (Array.isArray(data) ? data : []);

                if (results.length > 0) {
                    const topResult = results[0];
                    const ref = topResult.reference || `${topResult.book_name || ''} ${topResult.chapter || ''}:${topResult.verse || ''}`.trim();
                    const text = topResult.text ? topResult.text.replace(/<[^>]*>/g, '').trim() : '';

                    currentFetchedVerse = {
                        reference: ref,
                        text: text,
                        translation: `${version.toUpperCase()} (Bolls Life)`,
                        version: version
                    };

                    container.innerHTML = `
                        <div class="space-y-2">
                            <div class="flex items-center justify-between">
                                <h4 class="text-xs font-bold text-indigo-700">Search result: <span class="text-emerald-700">"${escapeHTML(ref)}"</span> <span class="text-[10px] text-gray-500 font-normal">(${version.toUpperCase()})</span></h4>
                            </div>
                            <p class="text-xs text-gray-800 leading-relaxed italic">"${escapeHTML(text)}"</p>
                            ${results.length > 1 ? `<p class="text-[10px] text-gray-500 italic mt-1">Showing top result out of ${results.length} matches.</p>` : ''}
                        </div>
                    `;
                } else {
                    container.innerHTML = `
                        <div class="py-2 text-center">
                            <p class="text-xs text-gray-600 font-semibold">No scripture results found for '${escapeHTML(trimmedQuery)}'. Try searching by verse reference (e.g., 'John 3:16').</p>
                        </div>
                    `;
                }
            } catch (searchErr) {
                console.error("Keyword search error:", searchErr);
                container.innerHTML = `
                    <div class="py-2 text-center">
                        <p class="text-xs text-red-600 font-semibold">No scripture results found for '${escapeHTML(trimmedQuery)}'. Try searching by verse reference (e.g., 'John 3:16').</p>
                    </div>
                `;
            }
        }
    } catch (err) {
        console.error("Bible widget lookup error:", err);
        container.innerHTML = `
            <div class="py-2 text-center">
                <p class="text-xs text-red-600 font-semibold">No matching scripture found for '${escapeHTML(trimmedQuery)}'. Try searching by verse reference like 'John 3:16'</p>
            </div>
        `;
    }
}

function handleBibleVersionChange() {
    // Automatically re-fetch the current query when translation changes
    const input = document.getElementById('bible-search-input');
    const query = (input && input.value.trim()) ? input.value.trim() : (currentFetchedVerse ? currentFetchedVerse.reference : 'John 3:16');
    if (input && !input.value.trim()) {
        input.value = query;
    }
    fetchAndRenderWidgetVerse(query);
}

function lookupWidgetScripture() {
    const input = document.getElementById('bible-search-input');
    if (!input) return;
    const ref = input.value.trim();
    if (!ref) {
        alert("Please enter a scripture reference or keyword (e.g. John 3:16 or grace).");
        return;
    }
    fetchAndRenderWidgetVerse(ref);
}

function navigateWidgetVerse(direction) {
    const match = currentFetchedVerse.reference.match(/^((?:[1-3]\s+)?[A-Za-z]+(?:\s+[A-Za-z]+)*)\s+(\d+)(?::(\d+))?/);
    if (!match) {
        // If current reference format isn't simple book chapter:verse, fallback to default or prompt
        fetchAndRenderWidgetVerse('John 3:16');
        return;
    }

    const book = match[1];
    const chapter = parseInt(match[2], 10);
    let verse = match[3] ? parseInt(match[3], 10) : 1;

    verse += direction;
    if (verse < 1) verse = 1;

    const newRef = `${book} ${chapter}:${verse}`;
    const input = document.getElementById('bible-search-input');
    if (input) input.value = newRef;

    fetchAndRenderWidgetVerse(newRef);
}

function shareVerseToFeed() {
    const postRawText = document.getElementById('post-raw-text');
    const postCategoryInput = document.getElementById('post-category-input');
    
    if (!postRawText) return;

    const shareText = `📖 ${currentFetchedVerse.reference}:\n"${currentFetchedVerse.text}"\n\nShared via Daily Scripture & Bible Reader ✨`;
    postRawText.value = shareText;

    if (postCategoryInput) {
        postCategoryInput.value = 'Encouragement';
    }

    postRawText.scrollIntoView({ behavior: 'smooth', block: 'center' });
    postRawText.focus();
}

async function shareChurchProfile() {
    let churchId = currentUserProfile?.church_id;
    
    if (!churchId || churchId === 'global-fellowship') {
        try {
            const { data: churchData } = await window.sbClient.from('churches').select('id').limit(1).maybeSingle();
            if (churchData) {
                churchId = churchData.id;
            }
        } catch (e) {
            console.error("Error finding church ID for sharing:", e);
        }
    }

    const publicUrl = window.location.origin + '/public-church.html' + (churchId ? `?id=${churchId}` : '');
    
    try {
        await navigator.clipboard.writeText(publicUrl);
        alert("Public link copied to clipboard! You can now share this on WhatsApp, Facebook, etc.");
    } catch (err) {
        const textArea = document.createElement("textarea");
        textArea.value = publicUrl;
        document.body.appendChild(textArea);
        textArea.select();
        try {
            document.execCommand('copy');
            alert("Public link copied to clipboard! You can now share this on WhatsApp, Facebook, etc.");
        } catch (fallbackErr) {
            alert("Copy failed. Here is your public link: " + publicUrl);
        }
        document.body.removeChild(textArea);
    }
}

async function fetchMinistryRequests() {
    if (!currentUserProfile || !currentUserProfile.church_id) return;
    const churchId = currentUserProfile.church_id;

    const conversionTbody = document.getElementById('conversion-requests-tbody');
    const prayerTbody = document.getElementById('prayer-requests-tbody');

    if (conversionTbody) {
        conversionTbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-gray-400 italic">Loading conversion requests...</td></tr>`;
    }
    if (prayerTbody) {
        prayerTbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-gray-400 italic">Loading prayer requests...</td></tr>`;
    }

    try {
        // 1. Fetch Conversion Requests
        const { data: conversionData, error: conversionError } = await window.sbClient
            .from('conversion_requests')
            .select('*')
            .eq('church_id', churchId)
            .order('created_at', { ascending: false });

        if (conversionError) throw conversionError;

        if (conversionTbody) {
            // Filter pending or null status submissions
            const pendingConversions = (conversionData || []).filter(req => req.status === 'pending' || req.status === null || req.status === undefined || req.status === '');
            
            if (pendingConversions.length === 0) {
                conversionTbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-gray-400 italic">No pending conversion requests at this time.</td></tr>`;
            } else {
                conversionTbody.innerHTML = pendingConversions.map(req => {
                    const dateStr = req.created_at ? new Date(req.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A';
                    
                    const postContent = req.content || req.prayer_request || req.message || req.details || req.testimony || 'No content provided';
                    const authorName = req.full_name || req.name || req.display_name || req.contact_info || (req.profiles ? req.profiles.full_name : 'Anonymous Guest');
                    const contact = req.email || req.phone || req.contact_info || 'No contact provided';

                    const statusBadge = (req.status === 'pending' || req.status === null || req.status === undefined || req.status === '')
                        ? '<span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-amber-100 text-amber-800">Pending</span>'
                        : (req.status === 'contacted' || req.status === 'approved' 
                            ? '<span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-800">Approved</span>' 
                            : '<span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-red-100 text-red-800">Rejected</span>');

                    return `
                        <tr class="hover:bg-gray-50 transition-colors border-b border-gray-100">
                            <td class="py-3 px-4 text-xs text-gray-500 whitespace-nowrap">${dateStr}</td>
                            <td class="py-3 px-4 font-semibold text-gray-900">${escapeHTML(authorName)}</td>
                            <td class="py-3 px-4 text-xs text-blue-600">
                                <div>${escapeHTML(contact)}</div>
                                ${req.phone ? `<div>📞 ${escapeHTML(req.phone)}</div>` : ''}
                                ${req.email ? `<div>✉️ ${escapeHTML(req.email)}</div>` : ''}
                            </td>
                            <td class="py-3 px-4 text-xs text-gray-700 max-w-xs truncate" title="${escapeHTML(postContent)}">${escapeHTML(postContent)}</td>
                            <td class="py-3 px-4 text-center whitespace-nowrap">
                                <div class="flex items-center justify-center gap-2">
                                    ${statusBadge}
                                    <button onclick="updateMinistryRequestStatus('conversion_requests', '${req.id}', 'approved')" class="px-2.5 py-1 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded shadow transition" title="Approve">Approve</button>
                                    <button onclick="updateMinistryRequestStatus('conversion_requests', '${req.id}', 'rejected')" class="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded shadow transition" title="Reject">Reject</button>
                                </div>
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        }

        // 2. Fetch Prayer Requests (avoid hard inner joins, query pending explicitly or filter in memory)
        const { data: prayerData, error: prayerError } = await window.sbClient
            .from('prayer_requests')
            .select('*')
            .eq('church_id', churchId)
            .order('created_at', { ascending: false });

        if (prayerError) throw prayerError;

        if (prayerTbody) {
            const pendingPrayers = (prayerData || []).filter(req => req.status === 'pending' || req.status === null || req.status === undefined || req.status === '');

            if (pendingPrayers.length === 0) {
                prayerTbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-gray-400 italic">No pending prayer requests at this time.</td></tr>`;
            } else {
                prayerTbody.innerHTML = pendingPrayers.map(req => {
                    const dateStr = req.created_at ? new Date(req.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'N/A';
                    
                    const postContent = req.content || req.prayer_request || req.message || req.details || req.testimony || 'No content provided';
                    const authorName = req.full_name || req.name || req.display_name || req.contact_info || (req.profiles ? req.profiles.full_name : 'Anonymous Guest');
                    const contact = req.email || req.phone || req.contact_info || 'No contact provided';

                    const statusBadge = (req.status === 'pending' || req.status === null || req.status === undefined || req.status === '')
                        ? '<span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-purple-100 text-purple-800">Pending</span>'
                        : (req.status === 'approved' || req.status === 'contacted'
                            ? '<span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-green-100 text-green-800">Approved</span>'
                            : '<span class="px-2 py-0.5 text-xs font-semibold rounded-full bg-red-100 text-red-800">Rejected</span>');

                    return `
                        <tr class="hover:bg-gray-50 transition-colors border-b border-gray-100">
                            <td class="py-3 px-4 text-xs text-gray-500 whitespace-nowrap">${dateStr}</td>
                            <td class="py-3 px-4 font-semibold text-gray-900">${escapeHTML(authorName)}</td>
                            <td class="py-3 px-4 text-xs text-blue-600">
                                <div>${escapeHTML(contact)}</div>
                                ${req.phone ? `<div>📞 ${escapeHTML(req.phone)}</div>` : ''}
                                ${req.email ? `<div>✉️ ${escapeHTML(req.email)}</div>` : ''}
                            </td>
                            <td class="py-3 px-4 text-xs text-gray-700 max-w-xs truncate" title="${escapeHTML(postContent)}">${escapeHTML(postContent)}</td>
                            <td class="py-3 px-4 text-center whitespace-nowrap">
                                <div class="flex items-center justify-center gap-2">
                                    ${statusBadge}
                                    <button onclick="updateMinistryRequestStatus('prayer_requests', '${req.id}', 'approved')" class="px-2.5 py-1 bg-green-600 hover:bg-green-700 text-white text-xs font-bold rounded shadow transition" title="Approve">Approve</button>
                                    <button onclick="updateMinistryRequestStatus('prayer_requests', '${req.id}', 'rejected')" class="px-2.5 py-1 bg-red-600 hover:bg-red-700 text-white text-xs font-bold rounded shadow transition" title="Reject">Reject</button>
                                </div>
                            </td>
                        </tr>
                    `;
                }).join('');
            }
        }

    } catch (err) {
        console.error("Error fetching ministry requests:", err);
        if (conversionTbody) conversionTbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-red-500 text-xs">Error loading conversion requests: ${escapeHTML(err.message)}</td></tr>`;
        if (prayerTbody) prayerTbody.innerHTML = `<tr><td colspan="5" class="py-8 text-center text-red-500 text-xs">Error loading prayer requests: ${escapeHTML(err.message)}</td></tr>`;
    }
}

async function updateMinistryRequestStatus(tableName, recordId, newStatus) {
    try {
        const { error } = await window.sbClient
            .from(tableName)
            .update({ status: newStatus })
            .eq('id', recordId);

        if (error) throw error;

        if (typeof showNotification === 'function') {
            showNotification('Request status updated successfully!', 'success');
        }
        fetchMinistryRequests();
    } catch (err) {
        console.error("Error updating request status:", err);
        alert('Failed to update status: ' + err.message);
    }
}

// ---------------------------------------------------------------------------
// MANAGE LEADERSHIP TEAM (ADMIN CONTROLS)
// ---------------------------------------------------------------------------

async function handleAdminLeadershipUpload(e) {
    e.preventDefault();
    if (!currentUserProfile || !currentUserProfile.church_id) {
        alert("Admin profile or church ID missing.");
        return;
    }

    const nameInput = document.getElementById('leader-name-input');
    const roleInput = document.getElementById('leader-role-input');
    const bioInput = document.getElementById('leader-bio-input');
    const fileInput = document.getElementById('leader-photo-input');
    const submitBtn = document.getElementById('leader-submit-btn');

    if (!fileInput || !fileInput.files || fileInput.files.length === 0) {
        alert("Please select a profile photo.");
        return;
    }

    const file = fileInput.files[0];
    const name = nameInput ? nameInput.value.trim() : '';
    const role = roleInput ? roleInput.value.trim() : '';
    const bio = bioInput ? bioInput.value.trim() : '';
    const originalBtnText = submitBtn ? submitBtn.innerHTML : '';

    try {
        if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Uploading & Adding Leader...';
        }

        const fileExt = file.name.split('.').pop();
        const randStr = Math.random().toString(36).substring(2, 8);
        const fileName = `${currentUserProfile.church_id}/leader_${Date.now()}_${randStr}.${fileExt}`;
        const bucketName = 'music-uploads'; // Approved public bucket used across the app

        const { error: uploadError } = await window.sbClient.storage
            .from(bucketName)
            .upload(fileName, file, { upsert: true });

        if (uploadError) throw uploadError;

        const { data: { publicUrl } } = window.sbClient.storage
            .from(bucketName)
            .getPublicUrl(fileName);

        if (!publicUrl) throw new Error("Could not retrieve public URL for uploaded photo.");

        const { error: insertError } = await window.sbClient
            .from('church_leaders')
            .insert([{
                church_id: currentUserProfile.church_id,
                name: name,
                role: role,
                bio: bio,
                image_url: publicUrl
            }]);

        if (insertError) throw insertError;

        if (typeof showNotification === 'function') {
            showNotification('Church leader successfully added!', 'success');
        } else {
            alert('Church leader successfully added!');
        }

        if (nameInput) nameInput.value = '';
        if (roleInput) roleInput.value = '';
        if (bioInput) bioInput.value = '';
        if (fileInput) fileInput.value = '';

        await fetchAdminLeadership(currentUserProfile.church_id);

    } catch (err) {
        console.error("Leadership upload error:", err);
        alert("Error adding leader: " + (err.message || err));
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.innerHTML = originalBtnText;
        }
    }
}

async function fetchAdminLeadership(churchId) {
    const gridContainer = document.getElementById('admin-leadership-grid');
    if (!gridContainer) return;

    if (!churchId) {
        gridContainer.innerHTML = `<p class="col-span-full text-center text-slate-400 text-sm py-4 italic">No church ID specified.</p>`;
        return;
    }

    try {
        const { data, error } = await window.sbClient
            .from('church_leaders')
            .select('*')
            .eq('church_id', churchId)
            .order('created_at', { ascending: true });

        if (error) {
            // If table doesn't exist yet, display helpful notice
            if (error.code === '42P01' || error.message.includes('does not exist')) {
                gridContainer.innerHTML = `<p class="col-span-full text-center text-amber-400 text-xs py-4">Notice: 'church_leaders' table needs to be initialized in Supabase.</p>`;
                return;
            }
            throw error;
        }

        if (!data || data.length === 0) {
            gridContainer.innerHTML = `<p class="col-span-full text-center text-slate-400 text-sm py-4 italic">No leaders added yet. Fill out the form above to add your first church leader.</p>`;
            return;
        }

        gridContainer.innerHTML = data.map(leader => {
            const name = leader.name || leader.full_name || 'Church Leader';
            const role = leader.role || leader.title || 'Pastor / Minister';
            const bio = leader.bio || leader.description || 'Serving faithfully in Christ.';
            const imageUrl = leader.image_url || leader.photo_url || 'images/meet2.jpg';

            return `
                <div class="bg-slate-800 border border-yellow-500/30 rounded-xl p-5 text-center shadow-lg space-y-3 flex flex-col items-center relative group">
                    <button onclick="removeChurchLeader('${leader.id}')" class="absolute top-3 right-3 w-8 h-8 bg-red-600 hover:bg-red-700 text-white rounded-full flex items-center justify-center text-xs shadow-md transition" title="Remove Leader">
                        <i class="fas fa-trash-alt"></i>
                    </button>
                    <div class="w-24 h-24 mx-auto rounded-full overflow-hidden border-2 border-yellow-500/50 shadow">
                        <img src="${imageUrl}" alt="${escapeHTML(name)}" class="w-full h-full object-cover">
                    </div>
                    <div class="space-y-0.5">
                        <h4 class="text-base font-bold text-white tracking-wide">${escapeHTML(name)}</h4>
                        <p class="text-xs font-semibold text-yellow-400 uppercase tracking-widest">${escapeHTML(role)}</p>
                    </div>
                    <p class="text-xs text-slate-300 leading-relaxed max-w-xs">${escapeHTML(bio)}</p>
                </div>
            `;
        }).join('');

    } catch (err) {
        console.error("Error fetching admin leadership:", err);
        gridContainer.innerHTML = `<p class="col-span-full text-center text-red-400 text-xs py-4">Error loading leaders: ${escapeHTML(err.message)}</p>`;
    }
}

async function removeChurchLeader(leaderId) {
    if (!confirm("Are you sure you want to remove this leader from your church leadership team?")) return;

    try {
        const { error } = await window.sbClient
            .from('church_leaders')
            .delete()
            .eq('id', leaderId);

        if (error) throw error;

        if (typeof showNotification === 'function') {
            showNotification('Church leader removed successfully.', 'success');
        } else {
            alert('Church leader removed successfully.');
        }

        if (currentUserProfile && currentUserProfile.church_id) {
            await fetchAdminLeadership(currentUserProfile.church_id);
        }
    } catch (err) {
        console.error("Error removing leader:", err);
        alert('Failed to remove leader: ' + err.message);
    }
}

async function loadChurchProgrammes() {
  const container = document.getElementById('church-programmes-feed');
  if (!container) return;

  const db = typeof window.sbClient !== 'undefined' ? window.sbClient : (typeof getDbClient === 'function' ? getDbClient() : window.supabase);
  if (!db) return;

  try {
    const currentChurchId = (typeof currentUserProfile !== 'undefined' && currentUserProfile && currentUserProfile.church_id) ? currentUserProfile.church_id : null;

    let query = db
      .from('events') 
      .select('*')
      .gte('event_date', new Date().toISOString())
      .order('event_date', { ascending: true })
      .limit(5);

    if (currentChurchId && currentChurchId !== 'global-fellowship') {
      query = query.eq('church_id', currentChurchId);
    }

    let { data: programmes, error } = await query;

    // If no events found with church_id or category, try fallback query without church filter or fetch general events
    if (error || !programmes || programmes.length === 0) {
      const fallbackQuery = db
        .from('events')
        .select('*')
        .gte('event_date', new Date().toISOString())
        .order('event_date', { ascending: true })
        .limit(5);
      const fallbackRes = await fallbackQuery;
      programmes = fallbackRes.data || [];
    }

    if (!programmes || programmes.length === 0) {
      container.innerHTML = `
        <div class="bg-white p-6 rounded-xl border border-gray-200 shadow-sm text-center">
          <p class="text-gray-500 text-sm py-2">No upcoming church programmes at the moment. Check back soon!</p>
        </div>`;
      return;
    }

    let html = '<div class="space-y-4">';
    programmes.forEach(item => {
      const title = item.title || item.name || 'Church Programme';
      const category = item.category || 'Church Event';
      const description = item.description || item.details || '';
      const dateVal = item.event_date || item.date || '';
      
      let dateFormatted = '';
      if (dateVal) {
        try {
          const d = new Date(dateVal);
          dateFormatted = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) + ' • ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
        } catch (e) {
          dateFormatted = dateVal;
        }
      }

      const location = item.location || item.venue || 'Main Sanctuary';

      html += `
        <div class="bg-white p-5 rounded-xl border border-gray-200 shadow-sm flex flex-col justify-between space-y-3 hover:shadow-md transition">
          <div>
            <div class="flex items-center justify-between mb-2">
              <span class="px-2.5 py-0.5 bg-blue-100 text-blue-800 rounded-full text-xs font-bold">${escapeHTML(category)}</span>
              <span class="text-xs font-semibold text-gray-500">🕒 ${escapeHTML(dateFormatted || 'Time TBA')}</span>
            </div>
            <h4 class="text-base font-bold text-gray-900 mb-1">${escapeHTML(title)}</h4>
            <p class="text-xs text-gray-600 mb-2">📍 <strong>${escapeHTML(location)}</strong></p>
            ${description ? `<p class="text-xs text-gray-700 leading-relaxed">${escapeHTML(description)}</p>` : ''}
          </div>
          <div class="flex justify-end pt-2 border-t border-gray-100">
            <a href="events.html" class="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-lg text-xs transition shadow-sm inline-flex items-center gap-1.5">
              <span>📅</span> RSVP / Details
            </a>
          </div>
        </div>
      `;
    });
    html += '</div>';
    container.innerHTML = html;

  } catch (err) {
    console.error('Error fetching church programmes:', err);
    container.innerHTML = `<div class="bg-white p-5 rounded-xl border border-red-200 text-center"><p class="text-red-500 text-xs">Failed to load programmes: ${escapeHTML(err.message)}</p></div>`;
  }
}

window.optOutEvent = async function(eventId) {
  try {
    const db = typeof getDbClient === 'function' ? getDbClient() : (window.sbClient || window.supabase);
    if (!db) return alert("Database client not found.");
    
    const { data: { user } } = await db.auth.getUser();
    if (!user) return alert("Please log in first.");

    if (!confirm("Are you sure you want to opt out of this event?")) return;

    const { error } = await db
      .from('event_registrations')
      .delete()
      .eq('event_id', eventId)
      .eq('profile_id', user.id);

    if (error) throw error;
    
    alert("You have successfully opted out.");
    
    if (typeof loadEvents === 'function') loadEvents();
    if (typeof loadChurchProgrammes === 'function') loadChurchProgrammes();
  } catch (err) {
    console.error('Error opting out:', err);
    alert("Failed to opt out. Please try again.");
  }
};

// --- Daily Scripture & Personal Reflections (VOTD & Reflections) ---

let currentVotdData = {
    reference: 'Philippians 4:6-7',
    text: 'Do not be anxious about anything, but in every situation, by prayer and petition, with thanksgiving, present your requests to God. And the peace of God, which transcends all understanding, will guard your hearts and your minds in Christ Jesus.'
};

async function loadDailyVerseAndReflections() {
    const cardContentEl = document.getElementById('votd-card-content');
    if (!cardContentEl) return;

    try {
        const res = await fetch('https://labs.bible.org/api/?passage=votd&type=json');
        if (!res.ok) throw new Error('Failed to fetch verse of the day');
        const data = await res.json();

        if (data && data.length > 0) {
            const v = data[0];
            const bookName = v.bookname || v.book || 'John';
            const chapterNum = v.chapter || '3';
            const verseNum = v.verse || '16';
            const textVal = v.text ? v.text.replace(/<[^>]*>/g, '').trim() : '';

            currentVotdData = {
                reference: `${bookName} ${chapterNum}:${verseNum}`,
                text: textVal
            };
        }
    } catch (err) {
        console.warn("Could not fetch labs.bible.org votd, using default verse:", err);
    }

    renderVotdCard();
    loadPastJournalEntries();
}

function renderVotdCard() {
    const cardContentEl = document.getElementById('votd-card-content');
    if (!cardContentEl) return;

    cardContentEl.innerHTML = `
        <div class="space-y-2">
            <div class="flex items-center justify-between">
                <h4 class="text-xs font-bold text-indigo-700 uppercase tracking-wide">📖 ${escapeHTML(currentVotdData.reference)}</h4>
                <span class="text-[10px] text-gray-400">Verse of the Day</span>
            </div>
            <p class="text-xs sm:text-sm text-gray-800 leading-relaxed italic">"${escapeHTML(currentVotdData.text)}"</p>
        </div>
    `;
}

function toggleReflectionModal() {
    const container = document.getElementById('reflection-box-container');
    if (!container) return;
    container.classList.toggle('hidden');
    if (!container.classList.contains('hidden')) {
        const textarea = document.getElementById('reflection-note-textarea');
        if (textarea) textarea.focus();
    }
}

function togglePastJournalEntries() {
    const container = document.getElementById('past-journal-container');
    const chevron = document.getElementById('journal-chevron');
    if (!container) return;

    container.classList.toggle('hidden');
    if (chevron) {
        chevron.classList.toggle('rotate-180');
    }

    if (!container.classList.contains('hidden')) {
        loadPastJournalEntries();
    }
}

async function saveReflection() {
    const textarea = document.getElementById('reflection-note-textarea');
    const saveBtn = document.getElementById('save-reflection-btn');
    if (!textarea) return;

    const noteText = textarea.value.trim();
    if (!noteText) {
        alert("Please write your personal reflection before saving.");
        return;
    }

    const db = typeof getDbClient === 'function' ? getDbClient() : (window.sbClient || window.supabase);
    if (!db) {
        alert("Database client not available.");
        return;
    }

    try {
        if (saveBtn) {
            saveBtn.disabled = true;
            saveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> Saving...';
        }

        const { data: { user } } = await db.auth.getUser();
        if (!user) {
            alert("Please log in to save journal reflections.");
            window.location.href = 'login.html';
            return;
        }

        const payload = {
            user_id: user.id,
            verse_reference: currentVotdData.reference,
            verse_text: currentVotdData.text,
            note: noteText
        };

        const { error } = await db
            .from('user_reflections')
            .insert([payload]);

        if (error) throw error;

        // Clear textarea & collapse
        textarea.value = '';
        const reflectionBox = document.getElementById('reflection-box-container');
        if (reflectionBox) reflectionBox.classList.add('hidden');

        // Show quick success toast message
        if (typeof showNotification === 'function') {
            showNotification('✍️ Reflection successfully saved to your journal!', 'success');
        } else {
            alert('✍️ Reflection successfully saved to your journal!');
        }

        // Reload past entries
        await loadPastJournalEntries();

        // Ensure past journal drawer is visible so the user sees their new entry
        const journalContainer = document.getElementById('past-journal-container');
        if (journalContainer && journalContainer.classList.contains('hidden')) {
            togglePastJournalEntries();
        }

    } catch (err) {
        console.error("Error saving reflection:", err);
        alert('Failed to save reflection: ' + err.message);
    } finally {
        if (saveBtn) {
            saveBtn.disabled = false;
            saveBtn.innerHTML = '<i class="fas fa-save"></i> Save Reflection';
        }
    }
}

async function loadPastJournalEntries() {
    const listContainer = document.getElementById('past-journal-list');
    if (!listContainer) return;

    const db = typeof getDbClient === 'function' ? getDbClient() : (window.sbClient || window.supabase);
    if (!db) return;

    try {
        const { data: { user } } = await db.auth.getUser();
        if (!user) {
            listContainer.innerHTML = '<p class="text-xs text-gray-500 italic py-2">Please log in to view past journal entries.</p>';
            return;
        }

        const { data, error } = await db
            .from('user_reflections')
            .select('*')
            .eq('user_id', user.id)
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!data || data.length === 0) {
            listContainer.innerHTML = '<p class="text-xs text-gray-500 italic py-2">No past journal entries yet. Reflect on today\'s verse to start journaling!</p>';
            return;
        }

        let html = '';
        data.forEach(entry => {
            let dateStr = '';
            try {
                dateStr = new Date(entry.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
            } catch (e) {
                dateStr = entry.created_at;
            }

            html += `
                <div class="p-3 bg-white border border-indigo-100 rounded-xl shadow-sm space-y-1.5">
                    <div class="flex items-center justify-between">
                        <span class="text-xs font-bold text-indigo-700">📖 ${escapeHTML(entry.verse_reference)}</span>
                        <span class="text-[10px] text-gray-400">${escapeHTML(dateStr)}</span>
                    </div>
                    <p class="text-[11px] text-gray-600 italic">"${escapeHTML(entry.verse_text)}"</p>
                    <div class="pt-1.5 border-t border-gray-100 mt-1">
                        <p class="text-xs text-gray-800 font-medium whitespace-pre-line">💬 ${escapeHTML(entry.note)}</p>
                    </div>
                </div>
            `;
        });

        listContainer.innerHTML = html;

    } catch (err) {
        console.error("Error loading past journal entries:", err);
        listContainer.innerHTML = '<p class="text-xs text-red-500 italic py-2">Failed to load past journal entries.</p>';
    }
}

// --- FELLOWSHIP NEEDS & RIDE-SHARE BOARD LOGIC ---

async function loadCommunityNeeds(categoryFilter = 'All') {
    const container = document.getElementById('community-needs-list');
    if (!container) return;

    container.innerHTML = '<p class="col-span-full text-center text-gray-400 text-sm py-8">Loading community needs board...</p>';

    const db = typeof getDbClient === 'function' ? getDbClient() : (window.sbClient || window.supabase);
    if (!db) {
        container.innerHTML = '<p class="col-span-full text-center text-red-500 text-sm py-8">Database client not available.</p>';
        return;
    }

    try {
        let query = db
            .from('community_needs')
            .select('*')
            .eq('status', 'open');

        if (currentUserProfile && currentUserProfile.church_id && currentUserProfile.church_id !== 'global-fellowship') {
            query = query.eq('church_id', currentUserProfile.church_id);
        }

        const { data, error } = await query.order('created_at', { ascending: false });

        if (error) throw error;

        let needs = data || [];
        if (categoryFilter !== 'All') {
            needs = needs.filter(n => n.category === categoryFilter);
        }

        if (needs.length === 0) {
            container.innerHTML = `<p class="text-center text-muted py-4">No open requests right now. Be the first to post!</p>`;
            return;
        }

        let html = '';
        needs.forEach(item => {
            let dateStr = '';
            try {
                dateStr = new Date(item.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
            } catch (e) {
                dateStr = item.created_at;
            }

            let badgeBg = 'bg-blue-100 text-blue-800 border-blue-200';
            if (item.category === 'Ride Share') badgeBg = 'bg-emerald-100 text-emerald-800 border-emerald-200';
            else if (item.category === 'Meal Train') badgeBg = 'bg-amber-100 text-amber-800 border-amber-200';
            else if (item.category === 'Volunteer') badgeBg = 'bg-purple-100 text-purple-800 border-purple-200';

            const isOwner = loggedInUser && item.user_id === loggedInUser.id;
            const contactId = `contact-box-${item.id}`;
            const authorName = item.profiles?.full_name || 'Church Member';

            html += `
                <div class="bg-white p-5 rounded-xl border border-gray-200 shadow-sm flex flex-col justify-between space-y-3">
                    <div>
                        <div class="flex items-center justify-between mb-2">
                            <span class="px-2.5 py-0.5 rounded-full text-xs font-bold border ${badgeBg}">${escapeHTML(item.category || 'General')}</span>
                            <span class="text-[10px] text-gray-400">${escapeHTML(dateStr)}</span>
                        </div>
                        <h4 class="text-base font-bold text-gray-900 mb-1">${escapeHTML(item.title)}</h4>
                        <p class="text-xs text-gray-600 leading-relaxed mb-3">${escapeHTML(item.description || '')}</p>
                        <p class="text-[11px] text-gray-500 italic">Posted by: <strong>${escapeHTML(authorName)}</strong></p>
                    </div>

                    <div id="${contactId}" class="hidden p-2.5 bg-blue-50 border border-blue-100 rounded-lg text-xs text-blue-900 mb-2">
                        <strong>📞 Contact Info:</strong> ${escapeHTML(item.contact_info)}
                    </div>

                    <div class="flex items-center justify-between pt-2 border-t border-gray-100 gap-2">
                        <button type="button" onclick="toggleCommunityNeedContact('${contactId}')" class="px-3.5 py-1.5 bg-blue-50 text-blue-700 hover:bg-blue-100 font-bold rounded-lg text-xs transition flex items-center gap-1">
                            <span>🤝</span> Offer Help / Contact
                        </button>
                        ${isOwner ? `
                            <button type="button" onclick="markCommunityNeedFulfilled('${item.id}')" class="px-3.5 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white font-bold rounded-lg text-xs transition shadow-sm">
                                Mark as Fulfilled
                            </button>
                        ` : ''}
                    </div>
                </div>
            `;
        });

        container.innerHTML = html;

    } catch (err) {
        console.error("Error loading community needs:", err);
        container.innerHTML = '<p class="col-span-full text-center text-red-500 text-sm py-8">Failed to load community needs board.</p>';
    }
}

function filterCommunityNeeds(category, buttonElement) {
    document.querySelectorAll('.needs-filter-btn').forEach(btn => {
        btn.classList.remove('bg-blue-600', 'text-white');
        btn.classList.add('bg-gray-100', 'text-gray-700');
    });
    if (buttonElement) {
        buttonElement.classList.remove('bg-gray-100', 'text-gray-700');
        buttonElement.classList.add('bg-blue-600', 'text-white');
    }
    loadCommunityNeeds(category);
}

function toggleCommunityNeedContact(contactId) {
    const el = document.getElementById(contactId);
    if (el) {
        el.classList.toggle('hidden');
    }
}

function openCommunityNeedModal() {
    const modal = document.getElementById('communityNeedModal');
    if (modal) modal.classList.remove('hidden');
}

function closeCommunityNeedModal() {
    const modal = document.getElementById('communityNeedModal');
    if (modal) modal.classList.add('hidden');
}

async function submitCommunityNeed(event) {
    event.preventDefault();
    const submitBtn = document.getElementById('needSubmitBtn');
    if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Publishing...';
    }

    const db = typeof getDbClient === 'function' ? getDbClient() : (window.sbClient || window.supabase);
    if (!db) {
        alert("Database client not available.");
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Publish Need';
        }
        return;
    }

    try {
        const { data: { user } } = await db.auth.getUser();
        if (!user) {
            alert("Please log in to post a need or offer a ride.");
            window.location.href = 'login.html';
            return;
        }

        const categoryValue = document.getElementById('needCategory').value;
        const titleValue = document.getElementById('needTitle').value.trim();
        const descriptionValue = document.getElementById('needDescription').value.trim();
        const contactValue = document.getElementById('needContactInfo').value.trim();
        const currentChurchId = currentUserProfile && currentUserProfile.church_id ? currentUserProfile.church_id : null;

        if (!categoryValue || !titleValue || !contactValue) {
            alert("Please fill out all required fields.");
            if (submitBtn) {
                submitBtn.disabled = false;
                submitBtn.textContent = 'Publish Need';
            }
            return;
        }

        const payload = {
            user_id: user.id,
            church_id: currentChurchId, // pass active church id from state/session
            category: categoryValue,
            title: titleValue,
            description: descriptionValue,
            contact_info: contactValue,
            status: 'open'
        };

        const { data, error } = await db.from('community_needs').insert([payload]);

        if (error) throw error;

        closeCommunityNeedModal();
        document.getElementById('communityNeedForm').reset();

        if (typeof showNotification === 'function') {
            showNotification('🤝 Community need successfully published!', 'success');
        } else {
            alert('🤝 Community need successfully published!');
        }

        await loadCommunityNeeds('All');

    } catch (err) {
        console.error("Error submitting community need:", err);
        alert('Failed to publish community need: ' + err.message);
    } finally {
        if (submitBtn) {
            submitBtn.disabled = false;
            submitBtn.textContent = 'Publish Need';
        }
    }
}

async function markCommunityNeedFulfilled(needId) {
    if (!confirm("Are you sure you want to mark this request as fulfilled?")) return;

    const db = typeof getDbClient === 'function' ? getDbClient() : (window.sbClient || window.supabase);
    if (!db) return;

    try {
        const { error } = await db
            .from('community_needs')
            .update({ status: 'fulfilled' })
            .eq('id', needId);

        if (error) throw error;

        if (typeof showNotification === 'function') {
            showNotification('Request marked as fulfilled!', 'success');
        } else {
            alert('Request marked as fulfilled!');
        }

        await loadCommunityNeeds('All');
    } catch (err) {
        console.error("Error updating need status:", err);
        alert('Failed to update status: ' + err.message);
    }
}

window.switchPageView = function(selected) {
  // Map dropdown values to their HTML container IDs
  const sectionMapping = {
    votd: 'section-votd',
    needs: 'section-needs',
    programmes: 'section-programmes',
    directory: 'section-directory',
    posts: 'section-posts',
    gallery: 'section-gallery',
    discovery: 'section-discovery'
  };

  Object.keys(sectionMapping).forEach(key => {
    const el = document.getElementById(sectionMapping[key]);
    if (el) {
      if (selected === 'all' || selected === key) {
        // Show
        el.style.display = 'block';
        el.classList.remove('d-none', 'hidden');
      } else {
        // Hide
        el.style.display = 'none';
        el.classList.add('d-none', 'hidden');
      }
    }
  });
};

window.switchFeedView = window.switchPageView;




