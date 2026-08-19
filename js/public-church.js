// public-church.js - Public Church Profile logic allowing anonymous visitors

document.getElementById('current-year').textContent = new Date().getFullYear();

// Helper guard function for image URLs
const isValidImageUrl = (url) => typeof url === 'string' && url.trim().startsWith('http') && !url.includes('@');

// Extract churchId or churchCode from URL parameters, e.g. public-church.html?id=xxx or public-church.html?code=yyy
const urlParams = new URLSearchParams(window.location.search);
const churchIdParam = urlParams.get('id');
const churchCodeParam = urlParams.get('code');

let currentChurchId = null;
let currentPesapalPaymentLink = null;
let currentFetchedVerse = {
    reference: 'John 3:16',
    text: 'For God so loved the world, that he gave his only begotten Son, that whosoever believeth in him should not perish, but have everlasting life.',
    translation: 'WEB',
    version: 'web'
};

// Initialize Supabase Client with public anon key for anonymous access
let publicSupabase = null;

async function initPublicChurch() {
    try {
        // Ensure supabase configuration is loaded
        if (typeof supabase !== 'undefined' && window.SUPABASE_URL && window.SUPABASE_ANON_KEY) {
            publicSupabase = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);
        } else if (window.sbClient) {
            publicSupabase = window.sbClient;
        } else {
            console.error("Supabase configuration not found.");
            document.getElementById('church-name').textContent = "Configuration Error";
            return;
        }

        await fetchChurchDetails();
        await loadPublicProgrammes(currentChurchId);
        await fetchChurchActivities();
        await renderLeadershipTeam();
        await fetchFellowshipGallery();

        // 3. Initialization: trigger default verse when public-church.html first loads
        await fetchAndRenderWidgetVerse('John 3:16');

        // Initialize gallery and leadership entrance animations
        if (typeof window.initAnimatedGallery === 'function') {
            window.initAnimatedGallery('gallery-section');
        } else if (typeof initGalleryAnimation === 'function') {
            initGalleryAnimation();
        }
        initLeadershipAnimation();
    } catch (err) {
        console.error("Error initializing public church profile:", err);
        document.getElementById('church-name').textContent = "Church Profile Not Found";
    }
}

async function fetchChurchDetails() {
    let query = publicSupabase.from('churches').select('*');

    if (churchIdParam) {
        query = query.eq('id', churchIdParam);
    } else if (churchCodeParam) {
        query = query.eq('code', churchCodeParam);
    } else {
        // Default to the first church if no query param is provided
        const { data: defaultChurches, error: defErr } = await query.limit(1);
        if (defErr || !defaultChurches || defaultChurches.length === 0) {
            throw new Error("No church found.");
        }
        renderChurch(defaultChurches[0]);
        return;
    }

    const { data, error } = await query.maybeSingle();
    if (error || !data) {
        // Try fallback to search by join_code if code failed
        if (churchCodeParam) {
            const { data: altData } = await publicSupabase.from('churches').select('*').eq('join_code', churchCodeParam).maybeSingle();
            if (altData) {
                renderChurch(altData);
                return;
            }
        }
        throw new Error("Church profile not found.");
    }

    renderChurch(data);
}

function renderChurch(church) {
    currentChurchId = church.id;
    currentPesapalPaymentLink = church.pesapal_payment_link || church.pesapal_link || null;
    const churchName = church.name || 'Our Church';
    const address = church.address || church.location || 'Location not specified';
    const logoUrl = church.logo_url || 'images/BELIEVERS.LOGO.png';

    document.title = `${churchName} | BelieversMeet`;
    document.getElementById('church-name').textContent = churchName;
    document.getElementById('header-church-name').textContent = churchName;
    document.getElementById('church-address').innerHTML = `<i class="fas fa-location-dot mr-2 text-blue-200"></i> ${escapeHTML(address)}`;
    
    const logoEl = document.getElementById('church-logo');
    if (logoEl) {
        const finalLogoUrl = isValidImageUrl(church.logo_url) ? church.logo_url : 'images/BELIEVERS.LOGO.png';
        logoEl.src = finalLogoUrl;
    }

    // Inject and Conditionally Render Direct Giving Details (Bank & Mobile Money)
    const bankNameEl = document.getElementById('bank-name');
    const bankAccountNameEl = document.getElementById('bank-account-name');
    const bankAccountNumberEl = document.getElementById('bank-account-number');
    const bankDetailsCard = document.getElementById('bank-details-card');

    const momoProviderEl = document.getElementById('momo-provider');
    const momoNumberEl = document.getElementById('momo-number');
    const momoNameEl = document.getElementById('momo-name');
    const momoDetailsCard = document.getElementById('momo-details-card');
    const directGivingDivider = document.getElementById('direct-giving-divider');

    const bankName = church.bank_name;
    const bankAccountName = church.account_name;
    const bankAccountNumber = church.account_number;

    const momoProvider = church.momo_provider;
    const momoNumber = church.momo_number;
    const momoRegisteredName = church.momo_registered_name;

    let hasBank = false;
    let hasMomo = false;

    if (bankName || bankAccountName || bankAccountNumber) {
        if (bankNameEl) bankNameEl.textContent = bankName || 'Not specified';
        if (bankAccountNameEl) bankAccountNameEl.textContent = bankAccountName || 'Not specified';
        if (bankAccountNumberEl) bankAccountNumberEl.textContent = bankAccountNumber || 'Not specified';
        if (bankDetailsCard) bankDetailsCard.classList.remove('hidden');
        hasBank = true;
    } else {
        if (bankDetailsCard) bankDetailsCard.classList.add('hidden');
    }

    if (momoProvider || momoNumber || momoRegisteredName) {
        if (momoProviderEl) momoProviderEl.textContent = momoProvider || 'Not specified';
        if (momoNumberEl) momoNumberEl.textContent = momoNumber || 'Not specified';
        if (momoNameEl) momoNameEl.textContent = momoRegisteredName || 'Not specified';
        if (momoDetailsCard) momoDetailsCard.classList.remove('hidden');
        hasMomo = true;
    } else {
        if (momoDetailsCard) momoDetailsCard.classList.add('hidden');
    }

    if (!hasBank && !hasMomo) {
        if (directGivingDivider) directGivingDivider.classList.add('hidden');
    } else {
        if (directGivingDivider) directGivingDivider.classList.remove('hidden');
    }

    // Dynamic Plan a Visit Section Updates:
    const planVisitAddressEl = document.getElementById('plan-visit-address');
    if (planVisitAddressEl) {
        planVisitAddressEl.textContent = address;
    }

    const getDirectionsBtn = document.getElementById('get-directions-btn');
    if (getDirectionsBtn) {
        getDirectionsBtn.href = `https://maps.google.com/?q=${encodeURIComponent(address)}`;
    }

    if (church.physical_address) {
        const baseUrl = "https://maps.google.com/maps?q=";
        const urlParams = "&t=&z=15&ie=UTF8&iwloc=&output=embed";
        const mapSrc = baseUrl + encodeURIComponent(church.physical_address) + urlParams;
        
        const mapIframe = document.getElementById("church-map-iframe");
        if (mapIframe) {
            mapIframe.src = mapSrc;
            mapIframe.style.display = "block";
        }
    } else {
        const mapIframe = document.getElementById("church-map-iframe");
        if (mapIframe) {
            mapIframe.style.display = "none";
        }
    }

    if (church.service_times && Array.isArray(church.service_times)) {
        const scheduleContainer = document.getElementById('service-schedule-container');
        if (scheduleContainer) {
            scheduleContainer.innerHTML = church.service_times.map(service => `
                <div class="bg-white rounded-xl p-4 border border-slate-200 shadow-sm flex items-start space-x-3">
                    <div class="w-8 h-8 bg-blue-50 text-blue-600 rounded-lg flex items-center justify-center font-bold text-sm shrink-0 mt-0.5 border border-blue-100">
                        <i class="fas fa-calendar-day"></i>
                    </div>
                    <div class="flex-1">
                        <h4 class="font-bold text-slate-900 text-sm">${escapeHTML(service.title || service.name || 'Worship Service')}</h4>
                        <p class="text-xs text-slate-600 mt-0.5">${escapeHTML(service.time || service.schedule || '')}</p>
                    </div>
                </div>
            `).join('');
        }
    }
}

async function fetchChurchActivities() {
    const container = document.getElementById('activities-container');
    
    let activitiesQuery = publicSupabase.from('events').select('*');
    if (currentChurchId) {
        activitiesQuery = activitiesQuery.or(`church_id.eq.${currentChurchId},host_church_id.eq.${currentChurchId}`);
    }

    const { data: events, error } = await activitiesQuery.order('event_date', { ascending: true }).limit(6);

    if (error || !events || events.length === 0) {
        try {
            const { data: progs } = await publicSupabase.from('programmes').select('*').eq('church_id', currentChurchId);
            if (progs && progs.length > 0) {
                renderActivities(progs);
                return;
            }
        } catch (e) {
            // ignore
        }

        container.innerHTML = `
            <div class="col-span-full bg-white rounded-2xl p-12 text-center border border-slate-200 shadow-sm space-y-3">
                <div class="w-16 h-16 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto text-2xl border border-blue-100">
                    <i class="fas fa-calendar-days"></i>
                </div>
                <h3 class="text-lg font-bold text-slate-900">No active programs right now</h3>
                <p class="text-sm text-slate-500 max-w-md mx-auto">Check back soon for upcoming worship services, bible studies, and community gatherings!</p>
            </div>
        `;
        return;
    }

    renderActivities(events);
}

function renderActivities(items) {
    const container = document.getElementById('activities-container');
    container.innerHTML = items.map(item => {
        const title = item.title || item.name || 'Church Program';
        const description = item.description || 'Join us for this uplifting church activity.';
        const dateStr = item.event_date ? new Date(item.event_date).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : (item.time || 'Weekly Fellowship');
        const imageUrl = isValidImageUrl(item.image_url) ? item.image_url : (isValidImageUrl(item.photo_url) ? item.photo_url : 'assets/images/default-placeholder.png');

        return `
            <div class="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden flex flex-col hover:shadow-md transition-shadow">
                <div class="h-48 overflow-hidden relative">
                    <img src="${imageUrl}" alt="${escapeHTML(title)}" class="w-full h-full object-cover">
                    <div class="absolute top-3 right-3 bg-blue-600 text-white text-xs font-semibold px-3 py-1 rounded-full shadow">
                        Activity
                    </div>
                </div>
                <div class="p-6 flex-1 flex flex-col justify-between space-y-4">
                    <div class="space-y-2">
                        <div class="text-xs font-semibold text-blue-600 flex items-center">
                            <i class="fas fa-clock mr-1.5"></i> ${escapeHTML(dateStr)}
                        </div>
                        <h3 class="text-xl font-bold text-slate-900">${escapeHTML(title)}</h3>
                        <p class="text-sm text-slate-600 line-clamp-3">${escapeHTML(description)}</p>
                    </div>
                    <div class="pt-4 border-t border-slate-100 flex items-center justify-between text-xs text-slate-500">
                        <span><i class="fas fa-users mr-1"></i> Open to All</span>
                        <span class="font-medium text-blue-600">Read-Only</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

async function fetchAndRenderWidgetVerse(query) {
    const container = document.getElementById('bible-widget-container');
    if (!container) return;

    const versionSelect = document.getElementById('bible-version');
    const version = versionSelect ? versionSelect.value : 'web';

    container.innerHTML = `
        <div class="flex items-center justify-center py-4 space-x-2">
            <div class="w-5 h-5 border-2 border-blue-600 border-t-transparent rounded-full animate-spin"></div>
            <span class="text-xs text-slate-500 font-medium">Looking up "${escapeHTML(query)}" (${version.toUpperCase()})...</span>
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
                        <h4 class="text-xs font-bold text-blue-700">${escapeHTML(officialRef)} <span class="text-[10px] text-slate-500 font-normal">(${escapeHTML(translationName)})</span></h4>
                    </div>
                    <p class="text-xs text-slate-800 leading-relaxed italic">"${escapeHTML(passageText)}"</p>
                </div>
            `;
        } else {
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
                                <h4 class="text-xs font-bold text-blue-700">Search result: <span class="text-blue-600">"${escapeHTML(ref)}"</span> <span class="text-[10px] text-slate-500 font-normal">(${version.toUpperCase()})</span></h4>
                            </div>
                            <p class="text-xs text-slate-800 leading-relaxed italic">"${escapeHTML(text)}"</p>
                            ${results.length > 1 ? `<p class="text-[10px] text-slate-500 italic mt-1">Showing top result out of ${results.length} matches.</p>` : ''}
                        </div>
                    `;
                } else {
                    container.innerHTML = `
                        <div class="py-2 text-center">
                            <p class="text-xs text-slate-600 font-semibold">No scripture results found for '${escapeHTML(trimmedQuery)}'. Try searching by verse reference (e.g., 'John 3:16').</p>
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

// Handle 'Get Converted' Form Submission
const conversionForm = document.getElementById('conversion-form');
if (conversionForm) {
    conversionForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!currentChurchId) {
            alert("Church identification error. Please reload the page.");
            return;
        }

        const fullName = document.getElementById('full-name').value.trim();
        const phoneNumber = document.getElementById('phone-number').value.trim();
        const email = document.getElementById('email') ? document.getElementById('email').value.trim() : '';
        const churchNameEl = document.getElementById('church-name');
        const churchName = churchNameEl ? churchNameEl.textContent.trim() : '';
        const prayerRequest = document.getElementById('prayer-request') ? document.getElementById('prayer-request').value.trim() : '';
        const submitBtn = document.getElementById('submit-btn');

        if (!fullName || !phoneNumber) {
            alert("Please fill in your full name and phone number.");
            return;
        }

        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Submitting...`;

        try {
            const payload = {
                church_id: currentChurchId,
                full_name: fullName,
                phone: phoneNumber,
                email: email || null,
                prayer_request: prayerRequest || null,
                status: 'pending'
            };

            const { error } = await publicSupabase.from('church_join_requests').insert([payload]);

            if (error) throw error;

            // Insert public notification for church join request
            const publicJoinNotificationPayload = {
                user_id: null,
                church_id: null,
                title: 'New Public Church Request',
                message: `New join request received from ${fullName || 'a guest'}.`,
                type: 'church_join',
                is_read: false
            };
            await publicSupabase.from('notifications').insert([publicJoinNotificationPayload]);

            console.log('Successfully submitted join request to church_join_requests:', payload);
            if (typeof showNotification === 'function') {
                showNotification('Your join request has been sent successfully!', 'success');
            } else {
                alert('Your join request has been sent successfully!');
            }

            document.getElementById('success-message').classList.remove('hidden');
            conversionForm.reset();
            conversionForm.classList.add('hidden');
        } catch (err) {
            console.error("Submission error:", err);
            alert("Failed to submit request: " + (err.message || 'Please try again later.'));
            submitBtn.disabled = false;
            submitBtn.innerHTML = `<span>Submit Request</span> <i class="fas fa-paper-plane"></i>`;
        }
    });
}

// Handle 'Need Prayer?' Form Submission
const prayerForm = document.getElementById('prayer-form');
if (prayerForm) {
    prayerForm.addEventListener('submit', async (e) => {
        e.preventDefault();

        if (!currentChurchId) {
            alert("Church identification error. Please reload the page.");
            return;
        }

        const fullName = document.getElementById('prayer-full-name').value.trim();
        const contactInfo = document.getElementById('prayer-contact-info').value.trim();
        const prayerRequestText = document.getElementById('prayer-request-text').value.trim();
        const prayerSubmitBtn = document.getElementById('prayer-submit-btn');

        if (!fullName || !prayerRequestText) {
            alert("Please fill in your name and your prayer request.");
            return;
        }

        prayerSubmitBtn.disabled = true;
        prayerSubmitBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Submitting...`;

        try {
            const { error } = await publicSupabase.from('prayer_requests').insert({
                church_id: currentChurchId,
                full_name: fullName,
                contact_info: contactInfo || null,
                prayer_request: prayerRequestText,
                status: 'pending'
            });

            if (error) throw error;

            // Insert public notification for prayer request
            const publicPrayerNotificationPayload = {
                user_id: null,
                church_id: null,
                title: 'New Public Prayer Request',
                message: `New prayer request received from ${fullName || 'a guest'}.`,
                type: 'public_request',
                is_read: false
            };
            await publicSupabase.from('notifications').insert([publicPrayerNotificationPayload]);

            console.log('Successfully submitted request:', { type: 'prayer_request', church_id: currentChurchId, full_name: fullName });
            if (typeof showNotification === 'function') {
                showNotification('Prayer request successfully submitted!', 'success');
            } else {
                alert('Prayer request successfully submitted!');
            }

            document.getElementById('prayer-success-message').classList.remove('hidden');
            prayerForm.reset();
            prayerForm.classList.add('hidden');
        } catch (err) {
            console.error("Prayer request submission error:", err);
            alert("Failed to submit prayer request: " + (err.message || 'Please try again later.'));
            prayerSubmitBtn.disabled = false;
            prayerSubmitBtn.innerHTML = `<i class="fas fa-hands-praying mr-1"></i><span>Submit Prayer Request</span>`;
        }
    });
}

// Handle Online Giving via Pesapal
function handleOnlineGiving() {
    if (currentPesapalPaymentLink && currentPesapalPaymentLink.trim() !== '') {
        if (confirm("You are about to proceed to the secure Pesapal checkout to support the ministry. Would you like to continue?")) {
            window.location.href = currentPesapalPaymentLink;
        }
    } else {
        alert("Online giving is currently being set up for this ministry. Please check back soon!");
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const pesapalBtn = document.getElementById('pesapal-giving-btn');
    if (pesapalBtn) {
        pesapalBtn.addEventListener('click', (e) => {
            e.preventDefault();
            handleOnlineGiving();
        });
    }
});

function escapeHTML(str) {
    if (!str) return '';
    return str.replace(/[&<>'"]/g, tag => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        "'": '&#39;',
        '"': '&quot;'
    }[tag] || tag));
}

// Fetch and render Moments of Fellowship gallery images from database
async function fetchFellowshipGallery() {
    const gridContainer = document.getElementById('fellowship-gallery-grid');
    if (!gridContainer) return;

    if (!currentChurchId) {
        gridContainer.innerHTML = `
            <div class="col-span-full py-12 text-center text-slate-500">
                <i class="fas fa-exclamation-circle text-3xl mb-2 text-blue-600"></i>
                <p class="text-sm">Church identification required to load gallery photos.</p>
            </div>
        `;
        return;
    }

    try {
        let photos = [];
        
        const { data, error } = await publicSupabase
            .from('gallery_images')
            .select('*')
            .eq('church_id', currentChurchId)
            .order('created_at', { ascending: false });

        if (!error && data) {
            photos = data;
        } else {
            const { data: mediaData, error: mediaErr } = await publicSupabase
                .from('gallery_media')
                .select('*')
                .eq('church_id', currentChurchId)
                .order('created_at', { ascending: false });
            if (!mediaErr && mediaData) {
                photos = mediaData;
            }
        }

        if (!photos || photos.length === 0) {
            gridContainer.innerHTML = `
                <div class="col-span-full py-16 text-center text-slate-500 space-y-3">
                    <div class="w-16 h-16 bg-blue-50 border border-blue-100 text-blue-600 rounded-full flex items-center justify-center mx-auto text-2xl">
                        <i class="fas fa-images"></i>
                    </div>
                    <h3 class="text-base font-bold text-slate-900">No Fellowship Photos Yet</h3>
                    <p class="text-xs text-slate-500 max-w-sm mx-auto">Church admin has not published any moments of fellowship to this gallery yet.</p>
                </div>
            `;
            return;
        }

        gridContainer.innerHTML = photos.map(photo => {
            const rawUrl = photo.image_url || photo.url || '';
            const imageUrl = isValidImageUrl(rawUrl) ? rawUrl : 'assets/images/default-placeholder.png';
            const caption = photo.caption || photo.title || 'Fellowship Moment';
            const uploader = photo.uploader_name || 'Church Admin';
            const dateStr = photo.created_at ? new Date(photo.created_at).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

            return `
                <div class="gallery-item-hide group">
                    <div class="relative overflow-hidden h-64 bg-slate-100 rounded-2xl shadow-sm border border-slate-200 group-hover:scale-105 group-hover:shadow-lg group-hover:shadow-blue-100 transition-all duration-300">
                        <img src="${escapeHTML(imageUrl)}" alt="${escapeHTML(caption)}" class="w-full h-full object-cover rounded-t-2xl group-hover:scale-105 transition-transform duration-500">
                        <div class="absolute inset-0 bg-gradient-to-t from-slate-950/70 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity duration-300 flex items-end p-4">
                            <span class="text-white text-xs font-medium"><i class="fas fa-heart text-blue-400 mr-1.5"></i> ${escapeHTML(caption)}</span>
                        </div>
                    </div>
                    <div class="p-4 flex items-center justify-between bg-white mt-2 rounded-2xl border border-slate-100 shadow-sm">
                        <div>
                            <h4 class="font-bold text-slate-900 text-sm truncate max-w-[200px]">${escapeHTML(caption)}</h4>
                            <p class="text-[11px] text-slate-500">By ${escapeHTML(uploader)} ${dateStr ? '• ' + dateStr : ''}</p>
                        </div>
                        <span class="text-[10px] text-blue-700 font-semibold bg-blue-50 border border-blue-200 px-2.5 py-1 rounded-full">Official</span>
                    </div>
                </div>
            `;
        }).join('');

    } catch (err) {
        console.error("Error fetching fellowship gallery:", err);
        gridContainer.innerHTML = `
            <div class="col-span-full py-12 text-center text-red-500">
                <i class="fas fa-exclamation-triangle text-2xl mb-2"></i>
                <p class="text-xs">Failed to load gallery photos. Please try again later.</p>
            </div>
        `;
    } finally {
        if (typeof window.initAnimatedGallery === 'function') {
            window.initAnimatedGallery('gallery-section');
        }
    }
}

// Render Leadership Team from church_leaders table with fallback
async function renderLeadershipTeam() {
    const container = document.getElementById('leadership-container');
    if (!container) return;

    let leaders = [];
    if (publicSupabase && currentChurchId) {
        try {
            const { data, error } = await publicSupabase
                .from('church_leaders')
                .select('*')
                .eq('church_id', currentChurchId)
                .order('created_at', { ascending: true });

            if (!error && data && data.length > 0) {
                leaders = data;
            }
        } catch (err) {
            console.log("church_leaders table might not exist yet or query failed:", err);
        }
    }

    if (!leaders || leaders.length === 0) {
        leaders = [
            {
                name: 'Pastor David Anderson',
                role: 'Senior Pastor',
                bio: 'Dedicated to preaching the uncompromised Word of God and guiding our community in fervent prayer, love, and discipleship.',
                image_url: 'images/meet2.jpg'
            },
            {
                name: 'Pastor Sarah Williams',
                role: 'Associate Pastor & Worship Director',
                bio: 'Passionate about ushering congregations into the glorious presence of God through heartfelt worship and community fellowship.',
                image_url: 'images/adon-73308cbf.jpg'
            },
            {
                name: 'Elder Michael Johnson',
                role: 'Director of Outreach & Pastoral Care',
                bio: 'Committed to serving families, comforting the brokenhearted, and expanding our reach into the local neighborhood with Christ’s love.',
                image_url: 'images/roo-background.jpg.png'
            }
        ];
    }

    container.innerHTML = leaders.map(leader => {
        const name = leader.name || leader.full_name || 'Church Leader';
        const role = leader.role || leader.title || 'Pastor / Minister';
        const bio = leader.bio || leader.description || 'Serving faithfully to build up the body of Christ in grace and truth.';
        const rawLeaderUrl = leader.image_url || leader.photo_url || '';
        const imageUrl = isValidImageUrl(rawLeaderUrl) ? rawLeaderUrl : 'assets/images/default-placeholder.png';

        return `
            <div class="gallery-item-hide group bg-white border border-slate-200 rounded-2xl p-6 text-center shadow-sm space-y-4 flex flex-col items-center hover:scale-105 hover:shadow-lg hover:shadow-blue-100 transition-all duration-300">
                <div class="w-32 h-32 mx-auto rounded-full overflow-hidden border-2 border-blue-200 shadow-sm group-hover:scale-105 transition-transform duration-500">
                    <img src="${imageUrl}" alt="${escapeHTML(name)}" class="w-full h-full object-cover">
                </div>
                <div class="space-y-1">
                    <h3 class="text-lg font-bold text-slate-900 tracking-wide">${escapeHTML(name)}</h3>
                    <p class="text-xs font-semibold text-blue-600 uppercase tracking-widest">${escapeHTML(role)}</p>
                </div>
                <p class="text-xs text-slate-600 leading-relaxed max-w-xs mx-auto">${escapeHTML(bio)}</p>
            </div>
        `;
    }).join('');

    if (typeof window.initAnimatedGallery === 'function') {
        window.initAnimatedGallery('leadership-section');
    }
}

// Initialize Leadership Fade-in Animation on Scroll
function initLeadershipAnimation() {
    const leadershipSection = document.getElementById('leadership-section');
    if (!leadershipSection) return;

    const observer = new IntersectionObserver((entries, observerInstance) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                leadershipSection.classList.remove('opacity-0', 'translate-y-10');
                leadershipSection.classList.add('opacity-100', 'translate-y-0');
                observerInstance.unobserve(entry.target);
            }
        });
    }, {
        threshold: 0.1
    });

    observer.observe(leadershipSection);
}

// Run initialization
initPublicChurch();

async function loadPublicProgrammes(churchId) {
  const container = document.getElementById('public-service-schedule');
  if (!container) return;

  container.innerHTML = '<div class="text-center p-3 text-muted"><div class="spinner-border spinner-border-sm me-2"></div>Loading service schedule...</div>';

  try {
    // Build query - filter by church_id if available
    let query = publicSupabase.from('programmes').select('*').order('created_at', { ascending: true });
    if (churchId) {
      query = query.eq('church_id', churchId);
    }

    const { data: programmes, error } = await query;
    if (error) throw error;

    console.log('Fetched public programmes:', programmes);

    if (!programmes || programmes.length === 0) {
      container.innerHTML = `
        <div class="text-center text-muted p-4 border rounded bg-light">
          <p class="mb-0">No active service schedules published yet for this church.</p>
        </div>
      `;
      return;
    }

    // Render live programs
    let html = '<div class="d-flex flex-column gap-3">';
    programmes.forEach(prog => {
      const title = prog.title || prog.name || 'Worship Service';
      const scheduleDisplay = prog.schedule_text || 
        (prog.day_of_week ? `${prog.day_of_week} • ${prog.time || prog.start_time || ''}` : prog.time || (prog.day ? `${prog.day} • ${prog.start_time && prog.end_time ? `${prog.start_time} - ${prog.end_time}` : (prog.start_time || '')}` : 'Schedule TBA'));
      const location = prog.location || prog.venue || '';
      const description = prog.description || '';

      html += `
        <div class="p-3 bg-white rounded shadow-sm border d-flex align-items-center gap-3">
          <div class="p-3 bg-primary bg-opacity-10 text-primary rounded-circle">
            🗓
          </div>
          <div>
            <h6 class="fw-bold mb-1 text-dark">${escapeHTML(title)}</h6>
            <p class="small text-muted mb-0">
              <span>🗓 ${escapeHTML(scheduleDisplay)}</span>
              ${location ? ` • <span>${escapeHTML(location)}</span>` : ''}
            </p>
            ${description ? `<small class="text-secondary d-block mt-1">${escapeHTML(description)}</small>` : ''}
          </div>
        </div>
      `;
    });
    html += '</div>';
    container.innerHTML = html;

  } catch (err) {
    console.error('Error fetching public programmes:', err);
    container.innerHTML = `<div class="alert alert-warning small py-2">Could not load schedule: ${err.message}</div>`;
  }
}

