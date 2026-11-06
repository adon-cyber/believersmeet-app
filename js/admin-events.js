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

    const { data, error } = await window.sbClient.rpc(
        'invite_church_to_event',
        {
            p_event_id: eventId,
            p_target_church_id: targetChurchId
        }
    );

    if (error) {
        console.error('Church invitation failed:', error);
        alert('Failed to invite church: ' + error.message);
        return false;
    }

    if (data === false) {
        alert('This church is already invited.');
        return false;
    }

    alert('Church successfully invited to event!');
    await loadAdminEvents();
    return true;
}

async function inviteMember(memberId, eventId) {
    if (!memberId || !eventId) {
        alert('Please select a member and an event.');
        return false;
    }

    const { data, error } = await window.sbClient.rpc(
        'invite_member_to_event',
        {
            p_event_id: eventId,
            p_member_id: memberId
        }
    );

    if (error) {
        console.error('Member invitation failed:', error);
        alert('Failed to invite member: ' + error.message);
        return false;
    }

    alert('Member successfully invited!');
    await loadAdminEvents();
    return true;
}

async function fetchEventRegistrationsDetailed(eventId) {
    if (!eventId || !window.sbClient) return [];

    const { data, error } = await window.sbClient.rpc(
        'get_event_roster',
        { p_event_id: eventId }
    );

    if (error) {
        console.error('Authorised roster lookup failed:', error);
        throw error;
    }

    return data || [];
}

async function removeAttendeeRegistration(registrationId, eventId) {
    if (!confirm('Are you sure you want to remove this member from the event?')) {
        return;
    }

    const { error } = await window.sbClient.rpc(
        'remove_event_registration',
        { p_registration_id: registrationId }
    );

    if (error) {
        console.error('Registration removal failed:', error);
        alert('Failed to remove attendee: ' + error.message);
        return;
    }

    alert('Attendee successfully removed from event.');

    await openAttendeesModal(eventId);
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
                                <img src="${escapeHTML(att.avatar_url || 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=100&q=80')}" alt="Avatar" class="w-8 h-8 rounded-full object-cover border">
                                <span>${escapeHTML(att.full_name)}</span>
                            </td>
                            <td class="px-4 py-3 whitespace-nowrap text-sm text-gray-500">${escapeHTML(att.email)}</td>
                            <td class="px-4 py-3 whitespace-nowrap text-sm font-mono text-blue-600 font-bold">${escapeHTML(att.coupon_number)}</td>
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
    const container =
        document.getElementById('admin-events-list') ||
        document.getElementById('admin-events-container');

    if (!container) return;

    container.innerHTML =
        '<div class="text-center py-6 text-gray-500">Loading events...</div>';

    try {
        const { data: events, error: eventsError } =
            await window.sbClient.rpc('get_managed_events', {
                p_church_id: null
            });

        if (eventsError) throw eventsError;

        if (!events || events.length === 0) {
            container.innerHTML =
                '<div class="bg-white p-8 rounded-xl text-center text-gray-500">No events found.</div>';
            return;
        }

        const htmlParts = [];

        for (const evt of events) {
            const [
                statsResult,
                membersResult,
                churchesResult
            ] = await Promise.all([
                window.sbClient.rpc('get_event_registration_stats', {
                    p_event_ids: [evt.id]
                }),
                window.sbClient.rpc('get_event_invitable_members', {
                    p_event_id: evt.id
                }),
                window.sbClient.rpc('get_event_invitable_churches', {
                    p_event_id: evt.id
                })
            ]);

            if (statsResult.error) throw statsResult.error;
            if (membersResult.error) throw membersResult.error;
            if (churchesResult.error) throw churchesResult.error;

            const attendeeCount =
                Number(statsResult.data?.[0]?.registration_count || 0);

            const members = membersResult.data || [];
            const churches = churchesResult.data || [];
            const invitedIds = evt.invited_church_ids || [];

            const churchMap = {};
            churches.forEach(c => {
                churchMap[c.id] = c;
            });

            const invitedHtml = invitedIds.length === 0
                ? '<p class="text-sm text-gray-400 italic">No other churches invited.</p>'
                : invitedIds.map(id => {
                    const church = churchMap[id];
                    return `
                        <div class="flex items-center justify-between bg-white p-2.5 rounded-lg border border-gray-200 text-sm">
                            <span class="font-medium text-gray-800">
                                ${escapeHTML(church?.name || 'Unavailable church')}
                            </span>
                            <span class="text-xs bg-emerald-50 text-emerald-700 px-2 py-1 rounded">
                                Invited
                            </span>
                        </div>`;
                }).join('');

            const churchOptions = churches.map(c =>
                `<option value="${escapeHTML(c.id)}">${escapeHTML(c.name)}</option>`
            ).join('');

            const memberOptions = members.map(m =>
                `<option value="${escapeHTML(m.id)}">${escapeHTML(m.full_name || 'Member')}</option>`
            ).join('');

            const eventDate = evt.event_date
                ? new Date(evt.event_date).toLocaleString()
                : 'TBD';

            const host =
                churchMap[evt.church_id || evt.host_church_id]?.name ||
                'Primary Church';

            htmlParts.push(`
                <div class="bg-white rounded-2xl border border-gray-200 p-6 shadow-sm mb-6">
                    <div class="flex flex-col md:flex-row justify-between items-start gap-4 mb-4 border-b pb-4">
                        <div>
                            <h3 class="text-xl font-bold text-gray-900">
                                ${escapeHTML(evt.title)}
                            </h3>
                            <p class="text-sm text-gray-500">
                                ${escapeHTML(eventDate)}
                            </p>
                            ${evt.description ? `
                                <p class="text-sm text-gray-600 mt-1">
                                    ${escapeHTML(evt.description)}
                                </p>` : ''}
                        </div>

                        <div class="flex items-center gap-3">
                            <button
                                onclick="openAttendeesModal('${evt.id}')"
                                class="bg-blue-50 hover:bg-blue-100 text-blue-700 font-semibold py-2 px-4 rounded-xl border border-blue-200 text-xs">
                                View Attendees (${attendeeCount})
                            </button>
                            <div class="bg-gray-50 text-gray-700 text-xs px-3 py-2 rounded-xl border">
                                Host: ${escapeHTML(host)}
                            </div>
                        </div>
                    </div>

                    <div class="grid grid-cols-1 md:grid-cols-3 gap-6">
                        <div>
                            <h4 class="font-semibold text-gray-800 mb-3">
                                Invited Churches (${invitedIds.length})
                            </h4>
                            <div class="bg-gray-50 rounded-xl p-4 border max-h-48 overflow-y-auto space-y-2">
                                ${invitedHtml}
                            </div>
                        </div>

                        <div>
                            <h4 class="font-semibold text-gray-800 mb-3">
                                Invite Church
                            </h4>
                            <form onsubmit="handleChurchInviteSubmit(event, '${evt.id}')">
                                <select id="invite-church-select-${evt.id}"
                                    required class="w-full px-3 py-2 border rounded-lg text-sm bg-white">
                                    <option value="">Choose church...</option>
                                    ${churchOptions}
                                </select>
                                <button type="submit"
                                    class="w-full mt-3 bg-emerald-600 text-white py-2 px-4 rounded-lg text-sm">
                                    Invite Church
                                </button>
                            </form>
                        </div>

                        <div>
                            <h4 class="font-semibold text-gray-800 mb-3">
                                Invite Member
                            </h4>
                            <form onsubmit="handleInviteSubmit(event, '${evt.id}')">
                                <select id="invite-member-select-${evt.id}"
                                    required class="w-full px-3 py-2 border rounded-lg text-sm bg-white">
                                    <option value="">Choose member...</option>
                                    ${memberOptions}
                                </select>
                                <button type="submit"
                                    class="w-full mt-3 bg-blue-600 text-white py-2 px-4 rounded-lg text-sm">
                                    Invite Member
                                </button>
                            </form>
                        </div>
                    </div>
                </div>
            `);
        }

        container.innerHTML = htmlParts.join('');

    } catch (err) {
        console.error('Admin event loading failed:', err);
        container.innerHTML = `
            <div class="bg-red-50 p-6 rounded-xl text-red-600">
                Could not load authorised events: ${escapeHTML(err.message)}
            </div>`;
    }
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
