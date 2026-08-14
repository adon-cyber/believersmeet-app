/**
 * js/feed.js - Community Fellowship Feed Script
 */

let loggedInUser = null;
let currentUserProfile = null; 
let cachedPosts = []; 
let activeFilter = 'All';
let discoveryProfiles = [];
let currentDiscoveryIndex = 0;

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
        const avatarUrl = profile.avatar_url || `https://ui-avatars.com/api/?name=${encodeURIComponent(profile.full_name || 'Believer')}&background=2563eb&color=fff`;

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

        let buttonHTML = `<button onclick="handleConnectProfile('${profile.id}', '${escapeHTML(profile.full_name || 'Believer')}')" class="flex-1 sm:flex-initial px-6 py-2 bg-blue-600 text-white hover:bg-blue-700 font-bold rounded-lg text-xs transition shadow">🤝 Connect</button>`;
        if (connectionState === 'pending') {
            buttonHTML = `<button disabled class="flex-1 sm:flex-initial px-6 py-2 bg-gray-400 text-white font-bold rounded-lg text-xs cursor-not-allowed shadow-none">⏳ Pending</button>`;
        } else if (connectionState === 'accepted') {
            buttonHTML = `<button disabled class="flex-1 sm:flex-initial px-6 py-2 bg-green-600 text-white font-bold rounded-lg text-xs cursor-not-allowed shadow-none">✓ Connected</button>`;
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

async function handleConnectProfile(recipientId, targetName) {
    if (!loggedInUser) return;

    if (recipientId === loggedInUser.id) {
        alert("You cannot send a connection request to yourself.");
        return;
    }

    try {
        const { data: existing } = await window.sbClient
            .from('connections')
            .select('*')
            .or(`and(requester_id.eq.${loggedInUser.id},recipient_id.eq.${recipientId}),and(requester_id.eq.${recipientId},recipient_id.eq.${loggedInUser.id})`);

        if (existing && existing.length > 0) {
            alert("A connection or request already exists with this user.");
            currentDiscoveryIndex++;
            renderCurrentDiscoveryCard();
            return;
        }

        const { error: insertError } = await window.sbClient
            .from('connections')
            .insert([
                { requester_id: loggedInUser.id, recipient_id: recipientId, status: 'pending' }
            ]);

        if (insertError) {
            if (insertError.code === '23505') {
                alert("Connection request already sent!");
            } else {
                console.error("Connection error:", insertError.message);
                alert("Could not send connection request: " + insertError.message);
            }
        } else {
            alert("Connection request sent successfully!");
        }
    } catch (err) {
        console.error("Unexpected error during connection:", err);
        if (err.code === '23505' || (err.message && err.message.includes('unique constraint'))) {
            alert("Connection request already sent!");
        }
    } finally {
        currentDiscoveryIndex++;
        renderCurrentDiscoveryCard();
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
        fetchAndRenderWidgetVerse('John 3:16').catch(err => console.error("Bible error:", err))
    ]);

    initTimelineRealtimeSync(); 
    
    const postForm = document.getElementById('post-composition-form');
    if (postForm) {
        postForm.addEventListener('submit', handleOutboundPostSubmit);
    }
    
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
    try {
        const { data: photos, error } = await window.sbClient
            .from('gallery_images')
            .select('*')
            .order('created_at', { ascending: false })
            .limit(10);

        if (!error && photos) {
            renderFeedGallerySection(photos);
        } else {
            console.error("Error loading feed gallery:", error?.message);
            if (container) {
                container.innerHTML = '<p class="col-span-full text-center text-xs text-red-500 py-4">Unable to load gallery memories</p>';
            }
        }
    } catch (err) {
        console.error("Exception loading feed gallery:", err);
        if (container) {
            container.innerHTML = '<p class="col-span-full text-center text-xs text-red-500 py-4">Unable to load gallery memories</p>';
        }
    }
}

function renderFeedGallerySection(photos) {
    const container = document.getElementById('feed-gallery-container');
    if (!container) return;

    if (!photos || photos.length === 0) {
        container.innerHTML = '<p class="col-span-full text-center text-xs text-gray-500 py-4">No gallery photos uploaded yet.</p>';
        return;
    }

    container.innerHTML = photos.map(photo => `
        <a href="gallery.html" class="block group relative aspect-square bg-gray-100 rounded-lg overflow-hidden shadow-sm border border-gray-200">
            <img src="${escapeHTML(photo.image_url)}" alt="${escapeHTML(photo.caption || 'Church Memory')}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300">
            <div class="absolute inset-0 bg-black bg-opacity-0 group-hover:bg-opacity-30 transition flex items-end p-2">
                <p class="text-white text-xs opacity-0 group-hover:opacity-100 transition truncate">${escapeHTML(photo.caption || '')}</p>
            </div>
        </a>
    `).join('');
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

async function fetchAndRenderWidgetVerse(reference) {
    const container = document.getElementById('bible-widget-container');
    if (!container) return;

    container.innerHTML = `
        <div class="flex items-center justify-center py-4 space-x-2">
            <div class="w-5 h-5 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin"></div>
            <span class="text-xs text-gray-500 font-medium">Fetching ${escapeHTML(reference)}...</span>
        </div>
    `;

    try {
        const res = await fetch(`https://bible-api.com/${encodeURIComponent(reference)}`);
        if (!res.ok) {
            throw new Error('Scripture reference not found');
        }
        const data = await res.json();
        
        let passageText = '';
        let officialRef = data.reference || reference;
        let translationName = data.translation_name || 'World English Bible';

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
            translation: translationName
        };

        container.innerHTML = `
            <div class="space-y-2">
                <div class="flex items-center justify-between">
                    <h4 class="text-xs font-bold text-indigo-700">${escapeHTML(officialRef)} <span class="text-[10px] text-gray-500 font-normal">(${escapeHTML(translationName)})</span></h4>
                </div>
                <p class="text-xs text-gray-800 leading-relaxed italic">"${escapeHTML(passageText)}"</p>
            </div>
        `;
    } catch (err) {
        console.error("Bible widget lookup error:", err);
        container.innerHTML = `
            <div class="py-2 text-center">
                <p class="text-xs text-red-600 font-semibold">No scripture loaded</p>
            </div>
        `;
    }
}

function lookupWidgetScripture() {
    const input = document.getElementById('bible-search-input');
    if (!input) return;
    const ref = input.value.trim();
    if (!ref) {
        alert("Please enter a scripture reference (e.g. John 3:16).");
        return;
    }
    fetchAndRenderWidgetVerse(ref);
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
