// public-church.js - Public Church Profile logic allowing anonymous visitors

document.getElementById('current-year').textContent = new Date().getFullYear();

// Extract churchId or churchCode from URL parameters, e.g. public-church.html?id=xxx or public-church.html?code=yyy
const urlParams = new URLSearchParams(window.location.search);
const churchIdParam = urlParams.get('id');
const churchCodeParam = urlParams.get('code');

let currentChurchId = null;

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
        await fetchChurchActivities();
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
    const churchName = church.name || 'Our Church';
    const address = church.address || church.location || 'Location not specified';
    const logoUrl = church.logo_url || 'images/BELIEVERS.LOGO.png';

    document.title = `${churchName} | BelieversMeet`;
    document.getElementById('church-name').textContent = churchName;
    document.getElementById('header-church-name').textContent = churchName;
    document.getElementById('church-address').innerHTML = `<i class="fas fa-location-dot mr-2 text-blue-400"></i> ${escapeHTML(address)}`;
    
    const logoEl = document.getElementById('church-logo');
    if (logoEl && church.logo_url) {
        logoEl.src = church.logo_url;
    }
}

async function fetchChurchActivities() {
    const container = document.getElementById('activities-container');
    
    // We can query events / programs associated with this church
    let activitiesQuery = publicSupabase.from('events').select('*');
    if (currentChurchId) {
        activitiesQuery = activitiesQuery.or(`church_id.eq.${currentChurchId},host_church_id.eq.${currentChurchId}`);
    }

    const { data: events, error } = await activitiesQuery.order('event_date', { ascending: true }).limit(6);

    if (error || !events || events.length === 0) {
        // Fallback: Check if there's a programmes or activities table
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
            <div class="col-span-full bg-white rounded-2xl p-12 text-center border border-gray-100 shadow-sm space-y-3">
                <div class="w-16 h-16 bg-blue-50 text-blue-600 rounded-full flex items-center justify-center mx-auto text-2xl">
                    <i class="fas fa-calendar-days"></i>
                </div>
                <h3 class="text-lg font-bold text-gray-900">No active programs right now</h3>
                <p class="text-sm text-gray-500 max-w-md mx-auto">Check back soon for upcoming worship services, bible studies, and community gatherings!</p>
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
        const imageUrl = item.image_url || item.photo_url || 'images/meet2.jpg';

        return `
            <div class="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col hover:shadow-md transition-shadow">
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
                        <h3 class="text-xl font-bold text-gray-900">${escapeHTML(title)}</h3>
                        <p class="text-sm text-gray-600 line-clamp-3">${escapeHTML(description)}</p>
                    </div>
                    <div class="pt-4 border-t border-gray-100 flex items-center justify-between text-xs text-gray-500">
                        <span><i class="fas fa-users mr-1"></i> Open to All</span>
                        <span class="font-medium text-blue-600">Read-Only</span>
                    </div>
                </div>
            </div>
        `;
    }).join('');
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
        const email = document.getElementById('email').value.trim();
        const prayerRequest = document.getElementById('prayer-request').value.trim();
        const submitBtn = document.getElementById('submit-btn');

        if (!fullName || !phoneNumber) {
            alert("Please fill in your full name and phone number.");
            return;
        }

        submitBtn.disabled = true;
        submitBtn.innerHTML = `<i class="fas fa-spinner fa-spin mr-2"></i> Submitting...`;

        try {
            const { error } = await publicSupabase.from('conversion_requests').insert({
                church_id: currentChurchId,
                full_name: fullName,
                phone_number: phoneNumber,
                email: email || null,
                prayer_request: prayerRequest || null,
                status: 'pending'
            });

            if (error) throw error;

            // Show success message and hide form
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

// Run initialization
initPublicChurch();
