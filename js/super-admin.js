/**
 * Super Admin Panel Script (`js/super-admin.js`)
 * Handles authentication checks for super_admin role, fetches profiles & churches,
 * allows role updates, trial extensions, account deletion, and live searching.
 */

function escapeHTML(str) {
    if (!str) return '';
    return str.toString().replace(/[&<>'"]/g, 
        tag => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[tag] || tag)
    );
}

let currentUserProfile = null;
let allUsersData = [];
let allChurchesMap = {}; // Maps church_id -> { name, trial_ends_at }

async function initSuperAdmin() {
    console.log("Initializing Developer Control Center...");

    // Wait for Supabase client initialization
    let attempts = 0;
    while (!window.sbClient && attempts < 20) {
        await new Promise(r => setTimeout(r, 200));
        attempts++;
    }

    if (!window.sbClient) {
        console.error("Supabase client engine initialization timed out.");
        alert("Failed to connect to Supabase backend configuration.");
        window.location.replace('login.html');
        return;
    }

    // Client-side route guard: Verify active session state using getSession()
    const { data: { session }, error: sessionError } = await window.sbClient.auth.getSession();
    if (sessionError || !session || !session.user || session.user.email !== 'adonstance@gmail.com') {
        console.warn("Unauthorized access or invalid session. Redirecting to login.");
        window.location.replace('login.html');
        return;
    }

    const user = session.user;

    // Fetch user profile to verify role
    const { data: profile, error: profileError } = await window.sbClient
        .from('profiles')
        .select('*')
        .eq('id', user.id)
        .maybeSingle();

    if (profileError || !profile) {
        console.error("Profile record not found.", profileError);
        window.location.replace('login.html');
        return;
    }

    currentUserProfile = profile;
    console.log("Authenticated user role:", currentUserProfile.role);

    // SECURITY CHECK: If role is NOT super_admin or email doesn't match, redirect away
    if (currentUserProfile.role !== 'super_admin' && user.email !== 'adonstance@gmail.com') {
        alert("Access Denied: The Developer Control Center requires Super Administrator privileges.");
        window.location.replace('index.html');
        return;
    }

    // If verified as super_admin, load all users and churches
    await loadAllUsersAndChurches();
    await loadPendingChurches();
    await loadViolationReports();
    populateChurchDropdowns();

    // Wire up search input filter
    const searchInput = document.getElementById('user-search-input');
    if (searchInput) {
        searchInput.addEventListener('input', (e) => {
            filterAndRenderUsers(e.target.value);
        });
    }
}

function toggleChurchSelect(value) {
    const container = document.getElementById('broadcast-church-container');
    if (container) {
        if (value === 'church') {
            container.classList.remove('hidden');
        } else {
            container.classList.add('hidden');
        }
    }
}

function populateChurchDropdowns() {
    const select = document.getElementById('broadcast-church-id');
    if (!select) return;
    select.innerHTML = '<option value="">Select Church...</option>';
    for (const [id, data] of Object.entries(allChurchesMap)) {
        select.innerHTML += `<option value="${escapeHTML(id)}">${escapeHTML(data.name)}</option>`;
    }
}

async function handleSendBroadcast(event) {
    event.preventDefault();
    const targetType = document.getElementById('broadcast-target-type').value;
    const selectedTargetId = document.getElementById('broadcast-church-id').value;
    const title = document.getElementById('broadcast-title').value;
    const content = document.getElementById('broadcast-content').value;

    if (targetType === 'church' && !selectedTargetId) {
        alert("Please select a target church.");
        return;
    }

    try {
        const { error } = await window.sbClient
            .from('announcements')
            .insert({
                title,
                content,
                sender_id: currentUserProfile.id,
                target_type: targetType,
                target_id: targetType === 'church' ? selectedTargetId : null,
                created_at: new Date()
            });

        if (error) throw error;

        showNotification("Announcement / Message broadcast successfully!", "success");
        const form = document.getElementById('broadcast-form');
        if (form) form.reset();
        toggleChurchSelect('all');
    } catch (err) {
        showNotification("Failed to broadcast message: " + err.message, "error");
    }
}

async function loadViolationReports() {
    const container = document.getElementById('violations-list-container');
    const tableTbody = document.getElementById('violations-table-tbody');
    
    if (container) container.innerHTML = `<div class="text-center py-6 text-gray-500 italic">Loading violation reports...</div>`;
    if (tableTbody) tableTbody.innerHTML = `<tr><td colspan="7" class="px-6 py-8 text-center text-gray-500 italic">Loading violation reports table...</td></tr>`;

    try {
        const { data: violations, error } = await window.sbClient
            .from('violations_view')
            .select('*')
            .order('created_at', { ascending: false });

        if (error) throw error;

        if (!violations || violations.length === 0) {
            if (container) container.innerHTML = `<div class="text-center py-8 text-gray-500 italic bg-gray-50 rounded-xl border border-dashed border-gray-200">No violation reports found. Platform is fully compliant.</div>`;
            if (tableTbody) tableTbody.innerHTML = `<tr><td colspan="7" class="px-6 py-8 text-center text-gray-500 italic">No violation reports found.</td></tr>`;
            return;
        }

        if (tableTbody) {
            tableTbody.innerHTML = violations.map(v => {
                const reportedName = v.offender_name || v.offender_email || 'Unknown User';
                const reporterName = v.reporter_name || v.reporter_email || 'Anonymous / System';
                const isBlocked = v.offender_is_blocked;
                const statusColor = v.status === 'pending' ? 'bg-red-100 text-red-800' : 'bg-green-100 text-green-800';
                const proofHtml = v.proof_url ? `<a href="${escapeHTML(v.proof_url)}" target="_blank" class="text-indigo-600 hover:text-indigo-900 font-semibold underline flex items-center gap-1">View Proof</a>` : `<span class="text-gray-400 italic">None</span>`;

                return `
                    <tr class="hover:bg-gray-50 transition-colors">
                        <td class="px-6 py-4 whitespace-nowrap text-xs text-gray-500">${new Date(v.created_at).toLocaleDateString()}</td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">${escapeHTML(reporterName)}</td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm font-bold text-red-600">${escapeHTML(reportedName)}</td>
                        <td class="px-6 py-4 text-sm text-gray-700">
                            <div class="font-semibold">${escapeHTML(v.reason)}</div>
                            ${v.details ? `<div class="text-xs text-gray-500 truncate max-w-xs">${escapeHTML(v.details)}</div>` : ''}
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-sm">${proofHtml}</td>
                        <td class="px-6 py-4 whitespace-nowrap">
                            <span class="px-2.5 py-1 inline-flex text-xs font-bold rounded-full ${statusColor}">${escapeHTML(v.status.toUpperCase())}</span>
                        </td>
                        <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                            <div class="flex items-center justify-end space-x-2">
                                <button onclick="updateViolationStatus('${v.id}', 'reviewed')" class="bg-gray-100 hover:bg-gray-200 text-gray-700 text-xs px-2.5 py-1.5 rounded-lg font-medium">Review</button>
                                ${isBlocked ? 
                                    `<button onclick="toggleBlockUser('${v.reported_user_id}', false)" class="bg-green-600 hover:bg-green-700 text-white text-xs px-2.5 py-1.5 rounded-lg font-semibold">Unblock</button>` :
                                    `<button onclick="toggleBlockUser('${v.reported_user_id}', true)" class="bg-red-600 hover:bg-red-700 text-white text-xs px-2.5 py-1.5 rounded-lg font-semibold">Block</button>`
                                }
                            </div>
                        </td>
                    </tr>
                `;
            }).join('');
        }
    } catch (err) {
        console.error("Failed to load violations:", err);
        if (container) container.innerHTML = `<div class="text-center py-6 text-red-500 text-sm">Failed to load violations: ${escapeHTML(err.message)}</div>`;
        if (tableTbody) tableTbody.innerHTML = `<tr><td colspan="7" class="px-6 py-6 text-center text-red-500 font-semibold">Error loading violations: ${escapeHTML(err.message)}</td></tr>`;
    }
}

async function updateViolationStatus(violationId, newStatus) {
    try {
        const { error } = await window.sbClient.from('violations').update({ status: newStatus }).eq('id', violationId);
        if (error) throw error;
        showNotification("Violation report status updated.", "success");
        await loadViolationReports();
    } catch (err) {
        showNotification("Failed to update status: " + err.message, "error");
    }
}

async function toggleBlockUser(targetUserId, blockStatus) {
    if (!targetUserId) return;
    if (!confirm(`Are you sure you want to ${blockStatus ? 'BLOCK' : 'UNBLOCK'} this user account?`)) return;

    try {
        const { error } = await window.sbClient.from('profiles').update({ is_blocked: blockStatus }).eq('id', targetUserId);
        if (error) throw error;
        showNotification(`User account successfully ${blockStatus ? 'blocked' : 'unblocked'}.`, "success");
        await loadAllUsersAndChurches();
        await loadViolationReports();
    } catch (err) {
        showNotification("Failed to update account status: " + err.message, "error");
    }
}

async function loadAllUsersAndChurches() {
    try {
        const tbody = document.getElementById('super-admin-users-tbody');
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-gray-500 italic">Loading database records securely...</td></tr>`;
        }

        // 1. Fetch all churches including trial information via Super Admin RPC
        const { data: churches, error: churchError } = await window.sbClient
            .rpc('super_admin_list_churches');

        if (!churchError && churches) {
            allChurchesMap = {};
            churches.forEach(c => {
                allChurchesMap[c.id] = {
                    name: c.name,
                    trial_ends_at: c.trial_ends_at
                };
            });
            document.getElementById('stat-total-churches').innerText = churches.length;
        } else {
            document.getElementById('stat-total-churches').innerText = '0';
        }

        // 2. Fetch all profiles from the database
        const { data: profiles, error: profilesError } = await window.sbClient
            .from('profiles')
            .select('*')
            .order('created_at', { ascending: false });

        if (profilesError) throw profilesError;

        allUsersData = profiles || [];
        document.getElementById('stat-total-users').innerText = allUsersData.length;
        const adminCount = allUsersData.filter(p => p.role === 'admin' || p.role === 'super_admin' || p.role === 'super-admin').length;
        document.getElementById('stat-total-admins').innerText = adminCount;

        renderUsersTable(allUsersData);

    } catch (err) {
        console.error("Error loading super admin data:", err);
    }
}

function renderUsersTable(users) {
    const tbody = document.getElementById('super-admin-users-tbody');
    if (!tbody) return;

    if (!users || users.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-gray-500 italic">No user profiles found in database.</td></tr>`;
        return;
    }

    tbody.innerHTML = users.map(user => {
        const churchData = user.church_id && allChurchesMap[user.church_id] ? allChurchesMap[user.church_id] : null;
        const churchName = churchData ? churchData.name : (user.church_id ? `ID: ${user.church_id.substring(0, 8)}...` : 'Independent / None');
        
        // Trial calculation info for church admins
        let trialHtml = '';
        if (user.church_id && churchData) {
            const trialEnd = churchData.trial_ends_at ? new Date(churchData.trial_ends_at) : null;
            const isTrialActive = trialEnd && trialEnd > new Date();
            const trialFormatted = trialEnd ? trialEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Not Set';
            
            trialHtml = `
                <div class="mt-1 text-xs flex items-center gap-1">
                    <span class="text-gray-500">Trial Ends:</span> 
                    <span class="font-semibold ${isTrialActive ? 'text-green-600' : 'text-red-600'}">${trialFormatted}</span>
                    <button onclick="extendChurchTrial('${user.church_id}')" class="ml-1 px-1.5 py-0.5 bg-indigo-50 hover:bg-indigo-100 text-indigo-700 rounded text-[10px] font-bold border border-indigo-200 transition" title="Extend Church Trial">
                        + Extend Trial
                    </button>
                    <a href="admin.html?church_id=${user.church_id}&tab=dashboard" 
                       class="text-xs bg-slate-800 hover:bg-slate-700 text-blue-400 border border-slate-700 px-3 py-1.5 rounded transition inline-flex items-center ml-3 shadow-sm">
                       ⚙️ Manage Dashboard
                    </a>
                </div>
            `;
        }

        const roleBadgeColor = (user.role === 'super_admin' || user.role === 'super-admin') ? 'bg-red-100 text-red-800 border border-red-300' : (user.role === 'admin' ? 'bg-purple-100 text-purple-800' : 'bg-green-100 text-green-800');
        
        return `
            <tr class="hover:bg-gray-50 transition-colors">
                <td class="px-6 py-4 whitespace-nowrap">
                    <div class="flex items-center space-x-3">
                        <div class="w-9 h-9 rounded-full bg-indigo-100 text-indigo-700 font-bold flex items-center justify-center text-sm flex-shrink-0">
                            ${escapeHTML((user.full_name || user.email || 'U').charAt(0).toUpperCase())}
                        </div>
                        <div>
                            <div class="text-sm font-bold text-gray-900">${escapeHTML(user.full_name || 'Unnamed Member')}</div>
                            <div class="text-xs text-gray-400">ID: ${escapeHTML(user.id.substring(0, 8))}...</div>
                        </div>
                    </div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">${escapeHTML(user.email || 'No email stored')}</td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-600">
                    <span class="px-2.5 py-1 bg-gray-100 text-gray-800 rounded-lg text-xs font-medium inline-block">
                        ${escapeHTML(churchName)}
                    </span>
                    ${trialHtml}
                </td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <span class="px-3 py-1 inline-flex text-xs leading-5 font-bold rounded-full ${roleBadgeColor}">
                        ${escapeHTML(user.role || 'user')}
                    </span>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div class="flex items-center justify-end space-x-2">
                        <select id="role-select-${user.id}" class="text-sm border border-gray-300 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:ring-2 focus:ring-indigo-500">
                           
<option value="member" ${user.role === 'member' ? 'selected' : ''}>Member</option>
<option value="pastor" ${user.role === 'pastor' ? 'selected' : ''}>Pastor</option>
<option value="finance" ${user.role === 'finance' ? 'selected' : ''}>Finance</option>
<option value="church_admin" ${user.role === 'church_admin' ? 'selected' : ''}>Church Admin</option>

                        </select>
                        <button onclick="updateUserRole('${user.id}')" class="bg-indigo-600 hover:bg-indigo-700 text-white text-xs px-3 py-2 rounded-lg font-semibold shadow transition">Update</button>
                        <button onclick="deleteUserAccount('${user.id}', '${escapeHTML(user.full_name || user.email || 'User')}')" class="bg-red-50 hover:bg-red-600 text-red-600 hover:text-white text-xs px-3 py-2 rounded-lg font-semibold border border-red-200 transition" title="Delete Account">
                            <i class="fas fa-trash-alt"></i>
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

async function extendChurchTrial(churchId) {
    const daysInput = prompt("Enter the number of days to extend this church's trial period (e.g., 30):", "30");
    if (!daysInput || isNaN(daysInput)) return;
    const daysToAdd = parseInt(daysInput, 10);

    try {
        const churchData = allChurchesMap[churchId];
        const currentEnd = churchData && churchData.trial_ends_at ? new Date(churchData.trial_ends_at) : new Date();
        const baseDate = currentEnd > new Date() ? currentEnd : new Date();
        
        const newTrialEndDate = new Date(baseDate.getTime() + (daysToAdd * 24 * 60 * 60 * 1000));

        const { error } = await window.sbClient.rpc('extend_church_trial', {
            p_church_id: churchId,
            p_new_expiry: newTrialEndDate.toISOString()
        });

        if (error) throw error;

        showNotification(`Church trial successfully extended by ${daysToAdd} days!`, "success");
        await loadAllUsersAndChurches();
    } catch (err) {
        showNotification("Failed to extend church trial: " + err.message, "error");
    }
}

function filterAndRenderUsers(query) {
    if (!query || query.trim() === '') {
        renderUsersTable(allUsersData);
        return;
    }
    const q = query.toLowerCase();
    const filtered = allUsersData.filter(u => 
        (u.full_name && u.full_name.toLowerCase().includes(q)) ||
        (u.email && u.email.toLowerCase().includes(q)) ||
        (u.role && u.role.toLowerCase().includes(q))
    );
    renderUsersTable(filtered);
}


async function updateUserRole(userId) {
    const selectEl = document.getElementById(`role-select-${userId}`);
    if (!selectEl) return;

    const newRole = selectEl.value;
    console.log("ROLE VALUE BEING SENT:", JSON.stringify(newRole));

    if (!confirm(`Are you sure you want to update this user's role to "${newRole}"?`)) {
        return;
    }

    selectEl.disabled = true;

    try {
        // Call the protected Super Admin RPC.
        const { error } = await window.sbClient.rpc(
            'super_admin_update_user_role',
            {
                target_user_id: userId,
                new_role: newRole
            }
        );

        // Never bypass the protected function with a direct table update.
        if (error) {
            throw error;
        }

        // Verify that the database actually saved the new role.
        const { data: updatedProfile, error: verifyError } =
            await window.sbClient
                .from('profiles')
                .select('role')
                .eq('id', userId)
                .maybeSingle();

        if (verifyError) {
            throw new Error(
                'Role update was submitted, but verification failed: ' +
                verifyError.message
            );
        }

        if (!updatedProfile) {
            throw new Error(
                'Could not find the updated user profile.'
            );
        }

        if (updatedProfile.role !== newRole) {
            throw new Error(
                `Role mismatch. Expected "${newRole}", but database returned "${updatedProfile.role}".`
            );
        }

        // Reload the dashboard only after confirming the database change.
        await loadAllUsersAndChurches();

        showNotification(
            'User role updated successfully!',
            'success'
        );

    } catch (err) {
        console.error('USER ROLE UPDATE ERROR:', err);

        showNotification(
            'Failed to update role: ' + err.message,
            'error'
        );

        // Restore the displayed roles from the database.
        await loadAllUsersAndChurches();

    } finally {
        // The element may have been replaced during the table reload.
        const currentSelect = document.getElementById(
            `role-select-${userId}`
        );

        if (currentSelect) {
            currentSelect.disabled = false;
        }
    }
}


async function deleteUserAccount(userId, userName) {
    if (userId === currentUserProfile.id) {
        alert("Security restriction: You cannot delete your own Super Administrator account.");
        return;
    }

    if (!confirm(`WARNING: Delete account for "${userName}"?`)) return;

    try {
        const { error: profileDelError } = await window.sbClient.from('profiles').delete().eq('id', userId);
        if (profileDelError) throw profileDelError;

        showNotification(`Account for "${userName}" deleted successfully.`, "success");
        await loadAllUsersAndChurches();
    } catch (err) {
        showNotification("Failed to delete account: " + err.message, "error");
    }
}

let pendingChurchesData = [];

async function loadPendingChurches() {
    const tbody = document.getElementById('super-admin-churches-tbody');
    const statBadge = document.getElementById('stat-pending-churches');
    if (tbody) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-gray-500 italic"><svg class="animate-spin h-6 w-6 text-amber-600 mx-auto mb-2" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24"><circle class="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" stroke-width="4"></circle><path class="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path></svg>Loading pending church applications...</td></tr>`;
    }

    try {
        const { data: churches, error } = await window.sbClient.rpc('list_church_applications');

        if (error) throw error;

        // Map RPC fields to standard view format:
        // application_id → church ID
        // church_name → church name
        // church_location → location
        // church_address → address
        // submitted_at → registration date
        // application_status → status
        // applicant_full_name and applicant_email → applicant details
        // admin_feedback → review feedback
        pendingChurchesData = (churches || []).map(c => ({
            id: c.application_id,
            name: c.church_name,
            location: c.church_location,
            address: c.church_address,
            created_at: c.submitted_at,
            status: c.application_status,
            applicant_full_name: c.applicant_full_name,
            applicant_email: c.applicant_email,
            admin_feedback: c.admin_feedback
        }));

        if (statBadge) statBadge.innerText = pendingChurchesData.length;

        renderPendingChurchesTable(pendingChurchesData);

        // Also fetch stats using RPC
        const { data: stats, error: statsError } = await window.sbClient.rpc('get_super_admin_church_stats');
        if (!statsError && stats) {
            if (stats.total_churches !== undefined) {
                const statChurchesEl = document.getElementById('stat-total-churches');
                if (statChurchesEl) statChurchesEl.innerText = stats.total_churches;
            }
            if (stats.pending_churches !== undefined) {
                if (statBadge) statBadge.innerText = stats.pending_churches;
            }
        }
    } catch (err) {
        console.error("Error loading pending churches:", err);
        if (tbody) {
            tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-red-500 font-semibold">Error loading church registrations: ${escapeHTML(err.message)}</td></tr>`;
        }
        if (statBadge) statBadge.innerText = '0';
    }
}

function renderPendingChurchesTable(churches) {
    const tbody = document.getElementById('super-admin-churches-tbody');
    if (!tbody) return;

    if (!churches || churches.length === 0) {
        tbody.innerHTML = `<tr><td colspan="5" class="px-6 py-8 text-center text-gray-500 italic bg-gray-50">No pending church registrations found. All churches are approved and active!</td></tr>`;
        return;
    }

    tbody.innerHTML = churches.map(church => {
        const dateStr = church.created_at ? new Date(church.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : 'Recent';
        const status = church.status || church.subscription_status || 'pending';
        const statusColor = status === 'approved' ? 'bg-green-100 text-green-800' : 'bg-amber-100 text-amber-800';
        const joinCode = church.join_code || church.code || 'Not Generated';

        return `
            <tr class="hover:bg-gray-50 transition-colors">
                <td class="px-6 py-4">
                    <div class="flex items-center space-x-3">
                        <div class="w-10 h-10 rounded-full bg-amber-100 text-amber-700 font-bold flex items-center justify-center text-base flex-shrink-0">
                            ⛪
                        </div>
                        <div>
                            <div class="text-sm font-bold text-gray-900">${escapeHTML(church.name)}</div>
                            <div class="text-xs text-gray-500">${escapeHTML(church.location || church.address || 'Location not specified')}</div>
                        </div>
                    </div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-sm text-gray-700">
                    <div class="font-medium">Church Leader / Admin</div>
                    <div class="text-xs text-gray-400">ID: ${escapeHTML((church.admin_user_id || church.id).substring(0, 8))}...</div>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-xs text-gray-500">${dateStr}</td>
                <td class="px-6 py-4 whitespace-nowrap">
                    <span class="px-2.5 py-1 inline-flex text-xs font-bold rounded-full ${statusColor}">${escapeHTML(status.toUpperCase())}</span>
                </td>
                <td class="px-6 py-4 whitespace-nowrap text-right text-sm font-medium">
                    <div class="flex items-center justify-end space-x-2">
                        <button onclick="openChurchReviewModal('${church.id}')" class="bg-indigo-50 hover:bg-indigo-100 text-indigo-700 text-xs px-3 py-2 rounded-lg font-semibold transition">
                            <i class="fas fa-eye mr-1"></i> Review
                        </button>
                        <button onclick="requestChangesChurchApplication('${church.id}')" class="bg-amber-50 hover:bg-amber-100 text-amber-700 text-xs px-3 py-2 rounded-lg font-semibold border border-amber-200 transition">
                            <i class="fas fa-edit mr-1"></i> Changes
                        </button>
                        <button onclick="approveChurchApplication('${church.id}')" class="bg-green-600 hover:bg-green-700 text-white text-xs px-3 py-2 rounded-lg font-semibold shadow transition">
                            <i class="fas fa-check mr-1"></i> Approve
                        </button>
                        <button onclick="rejectChurchApplication('${church.id}')" class="bg-red-50 hover:bg-red-600 text-red-600 hover:text-white text-xs px-3 py-2 rounded-lg font-semibold border border-red-200 transition">
                            <i class="fas fa-times mr-1"></i> Reject
                        </button>
                    </div>
                </td>
            </tr>
        `;
    }).join('');
}

async function openChurchReviewModal(churchId) {
    const church = pendingChurchesData.find(c => c.id === churchId) || allChurchesMap[churchId];
    if (!church) {
        alert("Church details not found in local state.");
        return;
    }

    // Create modal dynamically
    const existingModal = document.getElementById('church-review-modal');
    if (existingModal) existingModal.remove();

    let adminProfile = null;
    if (church.admin_user_id) {
        const { data: p } = await window.sbClient.from('profiles').select('*').eq('id', church.admin_user_id).maybeSingle();
        adminProfile = p;
    }

    const modal = document.createElement('div');
    modal.id = 'church-review-modal';
    modal.className = 'fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4';
    modal.innerHTML = `
        <div class="bg-white rounded-2xl shadow-2xl max-w-lg w-full overflow-hidden border border-gray-200 animate-fadeIn">
            <div class="bg-indigo-700 text-white px-6 py-4 flex justify-between items-center">
                <h3 class="text-lg font-bold flex items-center gap-2">
                    <i class="fas fa-church text-yellow-300"></i> Church Application Review
                </h3>
                <button onclick="document.getElementById('church-review-modal').remove()" class="text-indigo-200 hover:text-white text-xl font-bold">&times;</button>
            </div>
            <div class="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
                <div class="flex items-center space-x-4 pb-4 border-b border-gray-100">
                    <div class="w-14 h-14 rounded-2xl bg-indigo-50 text-indigo-700 font-bold flex items-center justify-center text-2xl flex-shrink-0">
                        ${church.logo_url ? `<img src="${escapeHTML(church.logo_url)}" class="w-full h-full object-cover rounded-2xl" />` : '⛪'}
                    </div>
                    <div>
                        <h4 class="text-xl font-bold text-gray-900">${escapeHTML(church.name)}</h4>
                        <p class="text-sm text-gray-500"><i class="fas fa-map-marker-alt mr-1 text-red-500"></i> ${escapeHTML(church.location || church.address || 'Not specified')}</p>
                    </div>
                </div>

                <div class="grid grid-cols-2 gap-4 bg-gray-50 p-4 rounded-xl text-sm">
                    <div>
                        <span class="block text-xs font-semibold text-gray-400 uppercase">Join Code / ID</span>
                        <span class="font-bold text-gray-800">${escapeHTML(church.join_code || church.code || 'Auto-generated on approval')}</span>
                    </div>
                    <div>
                        <span class="block text-xs font-semibold text-gray-400 uppercase">Registration Date</span>
                        <span class="font-bold text-gray-800">${church.created_at ? new Date(church.created_at).toLocaleDateString() : 'N/A'}</span>
                    </div>
                    <div>
                        <span class="block text-xs font-semibold text-gray-400 uppercase">Street Address</span>
                        <span class="font-bold text-gray-800">${escapeHTML(church.address || 'N/A')}</span>
                    </div>
                    <div>
                        <span class="block text-xs font-semibold text-gray-400 uppercase">Current Status</span>
                        <span class="font-bold text-amber-600">${escapeHTML((church.status || church.subscription_status || 'Pending').toUpperCase())}</span>
                    </div>
                </div>

                <div class="border-t border-gray-100 pt-3">
                    <h5 class="text-sm font-bold text-gray-900 mb-2 flex items-center gap-1.5"><i class="fas fa-user-shield text-purple-600"></i> Applicant Leader Information</h5>
                    <div class="bg-purple-50/50 p-4 rounded-xl text-sm space-y-1">
                        <p><strong>Name:</strong> ${escapeHTML(adminProfile?.full_name || 'Not linked / Unknown')} (${escapeHTML(adminProfile?.email || 'No email')})</p>
                        <p><strong>Role:</strong> <span class="px-2 py-0.5 bg-purple-100 text-purple-800 rounded text-xs font-bold">${escapeHTML(adminProfile?.role || 'admin')}</span></p>
                        <p><strong>User ID:</strong> <span class="font-mono text-xs text-gray-600">${escapeHTML(church.admin_user_id || 'N/A')}</span></p>
                    </div>
                </div>
            </div>
            <div class="bg-gray-50 px-6 py-4 border-t border-gray-200 flex justify-end space-x-3">
                <button onclick="document.getElementById('church-review-modal').remove()" class="px-4 py-2 bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-xl text-sm font-medium transition">Close</button>
                <button onclick="rejectChurchApplication('${church.id}'); document.getElementById('church-review-modal').remove();" class="px-4 py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-sm font-semibold transition">Reject Application</button>
                <button onclick="approveChurchApplication('${church.id}'); document.getElementById('church-review-modal').remove();" class="px-4 py-2 bg-green-600 hover:bg-green-700 text-white rounded-xl text-sm font-semibold transition shadow">Approve & Activate Church</button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
}

async function approveChurchApplication(churchId) {
    if (!confirm("Are you sure you want to approve this church? This will activate the church workspace, authorize the leader, and release the church join code.")) return;

    try {
        const { error } = await window.sbClient.rpc('approve_church_application', {
            p_church_id: churchId
        });

        if (error) throw error;

        showNotification("Church application approved successfully. Six-month trial activated.", "success");
        await loadPendingChurches();
        await loadAllUsersAndChurches();
    } catch (err) {
        showNotification("Failed to approve church application: " + err.message, "error");
    }
}

async function rejectChurchApplication(churchId) {
    const reason = prompt("Enter an optional reason for rejection (optional):", "Application requirements not fully met.");
    if (reason === null) return; // Cancelled

    try {
        const { error } = await window.sbClient.rpc('reject_church_application', {
            p_church_id: churchId,
            p_feedback: reason || null
        });

        if (error) throw error;

        showNotification("Church application rejected successfully.", "success");
        await loadPendingChurches();
        await loadAllUsersAndChurches();
    } catch (err) {
        showNotification("Failed to reject church application: " + err.message, "error");
    }
}

async function requestChangesChurchApplication(churchId) {
    const feedback = prompt("Enter feedback / changes requested for the applicant:", "Please update your church address and verification documents.");
    if (!feedback) return;

    try {
        const { error } = await window.sbClient.rpc('request_changes_church_application', {
            p_church_id: churchId,
            p_feedback: feedback
        });

        if (error) throw error;

        showNotification("Changes requested successfully. Applicant notified.", "success");
        await loadPendingChurches();
        await loadAllUsersAndChurches();
    } catch (err) {
        showNotification("Failed to request changes: " + err.message, "error");
    }
}
function showNotification(message, type = 'success') {
    const existing = document.getElementById('toast-notification');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'toast-notification';
    toast.className = `fixed bottom-5 right-5 z-50 px-6 py-3 rounded-xl shadow-xl text-white font-medium flex items-center space-x-2 transition-all duration-300 ${type === 'success' ? 'bg-indigo-600' : 'bg-red-600'}`;
    toast.innerHTML = `<span>${type === 'success' ? '✅' : '⚠️'}</span><span>${escapeHTML(message)}</span>`;
    
    document.body.appendChild(toast);
    setTimeout(() => {
        toast.classList.add('opacity-0', 'translate-y-2');
        setTimeout(() => toast.remove(), 300);
    }, 3500);
}

document.addEventListener('DOMContentLoaded', initSuperAdmin);