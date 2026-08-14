document.addEventListener('DOMContentLoaded', async () => {
    if (!window.sbClient) {
        console.error('Supabase client not initialized');
        return;
    }
    await loadAdminEvents();
});

async function inviteChurchToEvent(eventId, targetChurchId) {
    if (!eventId || !targetChurchId) {
        alert('Please select an event and a target church.');
        return false;
    }

    const { data: eventData, error: fetchError } = await window.sbClient
        .from('events')
        .select('invited_church_ids')
        .eq('id', eventId)
        .single();

    if (fetchError) {
        console.error('Error fetching event:', fetchError);
        alert('Failed to fetch event details: ' + fetchError.message);
        return false;
    }

    let invitedIds = eventData.invited_church_ids || [];
    if (!invitedIds.includes(targetChurchId)) {
        invitedIds.push(targetChurchId);
    } else {
        alert('This church is already invited to this event.');
        return false;
    }

    const { error: updateError } = await window.sbClient
        .from('events')
        .update({ invited_church_ids: invitedIds })
        .eq('id', eventId);

    if (updateError) {
        console.error('Error inviting church:', updateError);
        alert('Failed to invite church: ' + updateError.message);
        return false;
    }

    alert('Church successfully invited to event!');
    await loadAdminEvents();
    return true;
}

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

async function fetchEventRegistrationsDetailed(eventId) {
    // Step 1: Fetch registrations for this event including registration id, profile_id, attendee details, etc.
    const { data: registrations, error: regError } = await window.sbClient
        .from('event_registrations')
        .select('id, profile_id, attendee_name, attendee_email, coupon_number, amount_paid, is_free, photo_url, created_at')
        .eq('event_id', eventId);

    if (regError) {
        console.error("Error fetching registrations:", regError);
        return [];
    }

    if (!registrations || registrations.length === 0) {
        return [];
    }

    // Collect profile IDs
    const profileIds = registrations.map(r => r.profile_id).filter(Boolean);

    // Step 2: Fetch profiles for these profile IDs
    let profilesMap = {};
    if (profileIds.length > 0) {
        const { data: profiles, error: profError } = await window.sbClient
            .from('profiles')
            .select('id, full_name, email, avatar_url')
            .in('id', profileIds);

        if (!profError && profiles) {
            profiles.forEach(p => {
                profilesMap[p.id] = p;
            });
        }
    }

    // Merge registration info with profile info
    return registrations.map(reg => {
        const profile = profilesMap[reg.profile_id] || {};
        return {
            registration_id: reg.id,
            profile_id: reg.profile_id,
            full_name: reg.attendee_name || profile.full_name || 'Valued Attendee',
            email: reg.attendee_email || profile.email || 'N/A',
            avatar_url: reg.photo_url || profile.avatar_url || null,
            coupon_number: reg.coupon_number || 'N/A',
            amount_paid: reg.amount_paid || 0,
            is_free: reg.is_free,
            created_at: reg.created_at
        };
    });
}

async function removeAttendeeRegistration(registrationId, eventId) {
    if (!confirm('Are you sure you want to remove this member from the event?')) {
        return;
    }

    const { error } = await window.sbClient
        .from('event_registrations')
        .delete()
        .eq('id', registrationId);

    if (error) {
        console.error('Error removing attendee registration:', error);
        alert('Failed to remove attendee: ' + error.message);
        return;
    }

    alert('Attendee successfully removed from event.');
    // Refresh admin modal or event list
    openAttendeesModal(eventId);
    await loadAdminEvents();
}

async function openAttendeesModal(eventId) {
    let modal = document.getElementById('admin-attendees-modal');
    if (!modal) {
        modal = document.createElement('div');
        modal.id = 'admin-attendees-modal';
        modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black bg-opacity-50 p-4';
        document.body.appendChild(modal);
    }

    modal.innerHTML = `
        <div class="bg-white rounded-2xl max-w-2xl w-full p-6 shadow-2xl relative max-h-[90vh] flex flex-col">
            <div class="flex justify-between items-center mb-4 border-b pb-3">
                <h3 class="text-xl font-bold text-gray-900 flex items-center gap-2">
                    <i class="fas fa-users text-blue-600"></i> Event Attendees Management
                </h3>
                <button onclick="document.getElementById('admin-attendees-modal').remove()" class="text-gray-400 hover:text-gray-600 text-2xl font-bold">&times;</button>
            </div>
            <div id="admin-attendees-modal-content" class="overflow-y-auto flex-grow space-y-3 pr-1">
                <div class="text-center py-8 text-gray-400 italic">Loading attendee list...</div>
            </div>
        </div>
    `;

    const attendeesListContainer = document.getElementById('admin-attendees-modal-content');
    const attendees = await fetchEventRegistrationsDetailed(eventId);

    if (attendees.length === 0) {
        attendeesListContainer.innerHTML = '<div class="text-center py-8 text-gray-500 italic">No attendees registered for this event yet.</div>';
        return;
    }

    attendeesListContainer.innerHTML = `
        <div class="overflow-x-auto">
            <table class="min-w-full divide-y divide-gray-200">
                <thead class="bg-gray-50">
                    <tr>
                        <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Attendee</th>
                        <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Email</th>
                        <th class="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase tracking-wider">Coupon</th>
                        <th class="px-4 py-3 text-right text-xs font-semibold text-gray-500 uppercase tracking-wider">Action</th>
                    </tr>
                </thead>
                <tbody class="bg-white divide-y divide-gray-200">
                    ${attendees.map(att => `
                        <tr>
                            <td class="px-4 py-3 whitespace-nowrap text-sm font-medium text-gray-900 flex items-center gap-3">
                                <img src="${escapeHtml(att.avatar_url || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=100&q=80')}" alt="Avatar" class="w-8 h-8 rounded-full object-cover border">
                                <span>${escapeHtml(att.full_name)}</span>
                            </td>
                            <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500">${escapeHtml(att.email)}</td>
                            <td class="px-4 py-3 whitespace-nowrap text-sm font-mono text-blue-600 font-bold">${escapeHtml(att.coupon_number)}</td>
                            <td class="px-4 py-3 whitespace-nowrap text-right text-sm font-medium">
                                <button onclick="removeAttendeeRegistration('${att.registration_id}', '${eventId}')" class="bg-red-50 hover:bg-red-100 text-red-600 px-3 py-1.5 rounded-lg text-xs font-semibold transition border border-red-200 flex items-center gap-1 ml-auto">
                                    <i class="fas fa-trash-alt"></i> Remove
                                </button>
                            </td>
                        </tr>
                    `).join('')}
                </tbody>
            </table>
        </div>
    `;
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

    // Fetch all profiles for member invites
    const { data: profiles } = await window.sbClient
        .from('profiles')
        .select('id, full_name, email')
        .order('full_name', { ascending: true });

    const profilesList = profiles || [];

    // Fetch all churches for church code search/invites
    const { data: churches } = await window.sbClient
        .from('churches')
        .select('id, name, code, join_code')
        .order('name', { ascending: true });

    const churchesList = churches || [];
    const churchesMap = {};
    churchesList.forEach(c => { churchesMap[c.id] = c; });

    let html = '';
    for (const evt of events) {
        const attendees = await fetchEventRegistrationsDetailed(evt.id);
        const eventDate = evt.event_date ? new Date(evt.event_date).toLocaleString() : 'TBD';
        const invitedChurchIds = evt.invited_church_ids || [];

        html += `
        <div class="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm mb-6">
            <div class="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 mb-4 border-b pb-4">
                <div>
                    <h3 class="text-xl font-bold text-gray-900">${escapeHtml(evt.title)}</h3>
                    <p class="text-sm text-gray-500"><i class="fas fa-calendar-alt mr-1 text-blue-600"></i> ${escapeHtml(eventDate)}</p>
                    ${evt.description ? `<p class="text-sm text-gray-600 mt-1">${escapeHtml(evt.description)}</p>` : ''}
                </div>
                <div class="flex items-center gap-3">
                    <button onclick="openAttendeesModal('${evt.id}')" class="bg-blue-50 hover:bg-blue-100 text-blue-700 font-semibold py-2 px-4 rounded-xl border border-blue-200 text-xs transition flex items-center gap-2 shadow-sm">
                        <i class="fas fa-users"></i> View Attendees (${attendees.length})
                    </button>
                    <div class="bg-gray-50 text-gray-700 text-xs font-semibold px-3 py-2 rounded-xl border border-gray-200">
                        Host: ${escapeHtml(churchesMap[evt.church_id || evt.host_church_id]?.name || 'Primary Church')}
                    </div>
                </div>
            </div>

            <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                <!-- Current Invited Churches Section -->
                <div>
                    <h4 class="text-md font-semibold text-gray-800 mb-3 flex items-center gap-2">
                        <i class="fas fa-church text-blue-600"></i> Invited Churches (${invitedChurchIds.length})
                    </h4>
                    <div class="bg-gray-50 rounded-xl p-4 border border-gray-100 max-h-48 overflow-y-auto space-y-2">
                        ${invitedChurchIds.length === 0 ? '<p class="text-sm text-gray-400 italic">No other churches invited.</p>' :
                            invitedChurchIds.map(cId => {
                                const church = churchesMap[cId];
                                return `
                                <div class="flex items-center justify-between bg-white p-2.5 rounded-lg border border-gray-200 text-sm">
                                    <div>
                                        <p class="font-medium text-gray-800">${escapeHtml(church ? church.name : 'Church ID: ' + cId.substring(0,8))}</p>
                                        <p class="text-xs text-gray-500">Code: ${escapeHtml(church?.code || church?.join_code || 'N/A')}</p>
                                    </div>
                                    <span class="text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded font-medium">Invited</span>
                                </div>`;
                            }).join('')
                        }
                    </div>
                </div>

                <!-- Invite Church Form -->
                <div>
                    <h4 class="text-md font-semibold text-gray-800 mb-3 flex items-center gap-2">
                        <i class="fas fa-paper-plane text-blue-600"></i> Invite Church
                    </h4>
                    <form onsubmit="handleChurchInviteSubmit(event, '${evt.id}')" class="space-y-3">
                        <div>
                            <label class="block text-xs font-medium text-gray-700 mb-1">Search/Select Church (Code or Name)</label>
                            <select id="invite-church-select-${evt.id}" required class="w-full px-3 py-2 border border-gray-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm bg-white">
                                <option value="">Choose church code...</option>
                                ${churchesList.map(c => `<option value="${c.id}">${escapeHtml(c.name)} (${escapeHtml(c.code || c.join_code || 'No Code')})</option>`).join('')}
                            </select>
                        </div>
                        <button type="submit" class="w-full bg-emerald-600 hover:bg-emerald-700 text-white font-semibold py-2 px-4 rounded-lg shadow text-sm transition-all flex items-center justify-center gap-2">
                            <i class="fas fa-paper-plane"></i> Invite Church
                        </button>
                    </form>
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

async function handleChurchInviteSubmit(event, eventId) {
    event.preventDefault();
    const select = document.getElementById(`invite-church-select-${eventId}`);
    if (!select) return;
    const targetChurchId = select.value;
    await inviteChurchToEvent(eventId, targetChurchId);
}

async function handleInviteSubmit(event, eventId) {
    event.preventDefault();
    const select = document.getElementById(`invite-member-select-${eventId}`);
    if (!select) return;
    const memberId = select.value;
    await inviteMember(memberId, eventId);
}
