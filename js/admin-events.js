document.addEventListener('DOMContentLoaded', async () => {
    if (!window.sbClient) {
        console.error('Supabase client not initialized');
        return;
    }
    await loadAdminEvents();
});

async function inviteMember(memberId, eventId) {
    if (!memberId || !eventId) {
        alert('Please select a member and an event.');
        return;
    }

    const { data, error } = await window.sbClient
        .from('event_invitations')
        .insert([{ event_id: eventId, member_id: memberId }]);

    if (error) {
        console.error('Error inviting member:', error);
        alert('Failed to invite member: ' + error.message);
        return false;
    }

    alert('Member successfully invited!');
    await loadAdminEvents();
    return true;
}

async function fetchAttendees(eventId) {
    const { data, error } = await window.sbClient
        .from('event_invitations')
        .select('*, profiles(full_name, email)')
        .eq('event_id', eventId);

    if (error) {
        console.error('Error fetching attendees:', error);
        return [];
    }
    return data || [];
}

async function loadAdminEvents() {
    const container = document.getElementById('admin-events-container');
    if (!container) return;

    // Fetch all events
    const { data: events, error: eventsError } = await window.sbClient
        .from('events')
        .select('*')
        .order('event_date', { ascending: true });

    if (eventsError) {
        container.innerHTML = `<div class="bg-white p-8 rounded-xl border border-gray-200 text-center text-red-500 shadow-sm">Error loading events: ${escapeHtml(eventsError.message)}</div>`;
        return;
    }

    if (!events || events.length === 0) {
        container.innerHTML = `<div class="bg-white p-8 rounded-xl border border-gray-200 text-center text-gray-500 shadow-sm"><p>No events found.</p></div>`;
        return;
    }

    // Fetch all profiles for the select dropdown
    const { data: profiles, error: profilesError } = await window.sbClient
        .from('profiles')
        .select('id, full_name, email')
        .order('full_name', { ascending: true });

    const profilesList = profiles || [];

    let html = '';
    for (const evt of events) {
        const attendees = await fetchAttendees(evt.id);
        const eventDate = evt.event_date ? new Date(evt.event_date).toLocaleString() : 'TBD';

        html += `
        <div class="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4 border-b pb-4">
                <div>
                    <h3 class="text-xl font-bold text-gray-900">${escapeHtml(evt.title)}</h3>
                    <p class="text-sm text-gray-500"><i class="fas fa-calendar-alt mr-1 text-blue-600"></i> ${escapeHtml(eventDate)}</p>
                    ${evt.description ? `<p class="text-sm text-gray-600 mt-1">${escapeHtml(evt.description)}</p>` : ''}
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-2 gap-6">
                <!-- Current Attendees Section -->
                <div>
                    <h4 class="text-md font-semibold text-gray-800 mb-3 flex items-center gap-2">
                        <i class="fas fa-users text-blue-600"></i> Current Attendees (${attendees.length})
                    </h4>
                    <div class="bg-gray-50 rounded-xl p-4 border border-gray-100 max-h-48 overflow-y-auto space-y-2">
                        ${attendees.length === 0 ? '<p class="text-sm text-gray-400 italic">No attendees invited yet.</p>' : 
                            attendees.map(att => {
                                const profile = att.profiles || {};
                                return `
                                <div class="flex items-center justify-between bg-white p-2.5 rounded-lg border border-gray-200 text-sm">
                                    <div>
                                        <p class="font-medium text-gray-800">${escapeHtml(profile.full_name || 'Unknown Member')}</p>
                                        <p class="text-xs text-gray-500">${escapeHtml(profile.email || '')}</p>
                                    </div>
                                    <span class="text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded font-medium">Invited</span>
                                </div>`;
                            }).join('')
                        }
                    </div>
                </div>

                <!-- Invite Member Form -->
                <div>
                    <h4 class="text-md font-semibold text-gray-800 mb-3 flex items-center gap-2">
                        <i class="fas fa-user-plus text-blue-600"></i> Invite Member
                    </h4>
                    <form onsubmit="handleInviteSubmit(event, '${evt.id}')" class="space-y-3">
                        <div>
                            <label class="block text-xs font-medium text-gray-700 mb-1">Select Member</label>
                            <select id="invite-member-select-${evt.id}" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm bg-white">
                                <option value="">Choose member...</option>
                                ${profilesList.map(p => `<option value="${p.id}">${escapeHtml(p.full_name || p.email || p.id)}</option>`).join('')}
                            </select>
                        </div>
                        <button type="submit" class="w-full bg-blue-600 hover:bg-blue-700 text-white font-semibold py-2 px-4 rounded-lg shadow text-sm transition-all flex items-center justify-center gap-2">
                            <i class="fas fa-paper-plane"></i> Invite Member
                        </button>
                    </form>
                </div>
            </div>
        </div>`;
    }

    container.innerHTML = html;
}

async function handleInviteSubmit(event, eventId) {
    event.preventDefault();
    const select = document.getElementById(`invite-member-select-${eventId}`);
    if (!select) return;
    const memberId = select.value;
    await inviteMember(memberId, eventId);
}
