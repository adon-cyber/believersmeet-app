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

        // 1. Fetch all churches including trial information
        const { data: churches, error: churchError } = await window.sbClient
            .from('churches')
            .select('id, name, trial_ends_at');

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
                            <option value="user" ${user.role === 'user' ? 'selected' : ''}>User</option>
                            <option value="admin" ${user.role === 'admin' ? 'selected' : ''}>Admin</option>
                            <option value="super-admin" ${user.role === 'super-admin' || user.role === 'super_admin' ? 'selected' : ''}>Super Admin</option>
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

        const { error } = await window.sbClient
            .from('churches')
            .update({ trial_ends_at: newTrialEndDate.toISOString() })
            .eq('id', churchId);

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

    if (!confirm(`Are you sure you want to update this user's role to "${newRole}"?`)) return;

    try {
        const { error } = await window.sbClient.rpc('super_admin_update_user_role', {
            target_user_id: userId,
            new_role: newRole
        });

        if (error) {
            const { error: updateError } = await window.sbClient.from('profiles').update({ role: newRole }).eq('id', userId);
            if (updateError) throw updateError;
        }

        showNotification("User role updated successfully!", "success");
        await loadAllUsersAndChurches();
    } catch (err) {
        showNotification("Failed to update role: " + err.message, "error");
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