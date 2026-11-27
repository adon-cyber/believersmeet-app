/*
 * BelieversMeet Accounting - Budget Workspace
 * Read operations use church-scoped RLS. All mutations use the installed
 * SECURITY DEFINER accounting budget RPCs; this module performs no direct writes.
 */
(() => {
    'use strict';

    const panel = document.getElementById('budget-workspace');
    if (!panel) return;

    const $ = (id) => document.getElementById(id);
    const state = {
        client: null,
        user: null,
        churchId: null,
        permissions: {},
        settings: null,
        currencyMeta: null,
        periods: [],
        eligibleFiscalYears: [],
        accounts: [],
        funds: [],
        departments: [],
        budgets: [],
        selectedBudget: null,
        lines: [],
        allocations: [],
        approvals: [],
        actualRows: [],
        loading: false
    };

    const PERMISSIONS = [
        'accounting.budgets.read',
        'accounting.budgets.manage',
        'accounting.budgets.submit',
        'accounting.budgets.approve',
        'accounting.accounts.read',
        'accounting.funds.read',
        'accounting.departments.read',
        'accounting.departments.manage',
        'accounting.periods.read',
        'accounting.settings.read',
        'accounting.currencies.read'
    ];

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    function hasPermission(key) {
        return state.permissions[key] === true;
    }

    function formatMoney(value, currency) {
        const amount = Number(value || 0);
        const code = /^[A-Z]{3}$/.test(String(currency || '').toUpperCase()) ? String(currency).toUpperCase() : null;
        if (!Number.isFinite(amount) || !code) return '—';
        if (state.currencyMeta) return state.currencyMeta.format(amount, code);
        return `${amount.toLocaleString()} ${code} (precision metadata unavailable)`;
    }

    function currencyStep(currency) {
        if (!state.currencyMeta) return '1';
        return state.currencyMeta.step(currency);
    }

    function formatDate(value) {
        if (!value) return '—';
        const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
        return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, {
            day: 'numeric', month: 'short', year: 'numeric'
        }).format(date);
    }

    function moneyInput(value, currency = state.selectedBudget?.functional_currency) {
        const amount = Number(value || 0);
        if (!Number.isFinite(amount)) return '0';
        const precision = state.currencyMeta ? state.currencyMeta.minorUnit(currency) : 0;
        return amount.toFixed(precision);
    }

    function setMessage(message, kind = 'info') {
        const target = $('budget-message');
        if (!target) return;
        if (!message) {
            target.className = 'hidden';
            target.textContent = '';
            return;
        }
        const classes = kind === 'error'
            ? 'border-rose-800 bg-rose-950/30 text-rose-200'
            : kind === 'success'
                ? 'border-emerald-800 bg-emerald-950/25 text-emerald-200'
                : kind === 'warning'
                    ? 'border-amber-800 bg-amber-950/25 text-amber-100'
                    : 'border-blue-800 bg-blue-950/25 text-blue-100';
        target.className = `mb-4 rounded-lg border px-3 py-2 text-sm ${classes}`;
        target.textContent = message;
    }

    function setBusy(busy) {
        state.loading = busy;
        panel.querySelectorAll('button').forEach((button) => {
            if (button.dataset.allowDuringBusy) return;
            if (busy) {
                button.dataset.disabledBeforeBusy = button.disabled ? 'true' : 'false';
                button.disabled = true;
            } else {
                button.disabled = button.dataset.disabledBeforeBusy === 'true' || button.dataset.permissionDisabled === 'true';
                delete button.dataset.disabledBeforeBusy;
            }
        });
        const indicator = $('budget-busy');
        if (indicator) indicator.classList.toggle('hidden', !busy);
    }

    async function waitForSupabaseClient() {
        for (let attempt = 0; attempt < 40; attempt += 1) {
            const client = window.sbClient || window.supabaseClient;
            if (client?.auth && typeof client.from === 'function') return client;
            await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
        throw new Error('Supabase did not initialize. Check js/supabase-config.js.');
    }

    async function authorize() {
        state.client = await waitForSupabaseClient();
        const { data: authData, error: authError } = await state.client.auth.getUser();
        if (authError || !authData?.user) throw new Error('Your session could not be verified. Please sign in again.');
        state.user = authData.user;

        const { data: profile, error: profileError } = await state.client
            .from('profiles').select('id, church_id').eq('id', state.user.id).maybeSingle();
        if (profileError) throw new Error(`Could not verify your church profile: ${profileError.message}`);
        if (!profile) throw new Error('Your BelieversMeet profile is unavailable.');

        const { data: superAdmin, error: superAdminError } = await state.client.rpc('is_super_admin');
        const verifiedSuperAdmin = !superAdminError && superAdmin === true;
        const requestedChurchId = new URLSearchParams(window.location.search).get('church_id');
        state.churchId = requestedChurchId && verifiedSuperAdmin ? requestedChurchId : profile.church_id;
        if (!state.churchId) throw new Error('Your account has no church context for the Finance workspace.');

        const results = await Promise.all(PERMISSIONS.map(async (permissionKey) => {
            const { data, error } = await state.client.rpc('has_church_financial_permission', {
                p_church_id: state.churchId,
                p_permission_key: permissionKey
            });
            if (error) throw new Error(`Finance permission check failed (${permissionKey}): ${error.message}`);
            return [permissionKey, data === true];
        }));
        state.permissions = Object.fromEntries(results);

        if (!hasPermission('accounting.budgets.read')) {
            throw new Error('You do not have the Finance permission to view budgets for this church.');
        }
    }

    function deriveEligibleFiscalYears(periods, fiscalStartMonth) {
        const monthly = periods.filter((period) => {
            const startValue = String(period.start_date || '');
            const endValue = String(period.end_date || '');
            if (!/^\d{4}-\d{2}-01$/.test(startValue)) return false;
            const start = new Date(`${startValue}T00:00:00Z`);
            const last = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 0));
            const expectedEnd = `${last.getUTCFullYear()}-${String(last.getUTCMonth() + 1).padStart(2, '0')}-${String(last.getUTCDate()).padStart(2, '0')}`;
            return endValue === expectedEnd;
        });
        const groups = new Map();
        monthly.forEach((period) => {
            const date = String(period.start_date || '');
            if (!/^\d{4}-\d{2}-01$/.test(date)) return;
            const month = Number(date.slice(5, 7));
            if (month !== Number(fiscalStartMonth)) return;
            const key = date;
            groups.set(key, monthly.filter((candidate) => {
                const start = new Date(`${date}T00:00:00Z`);
                const candidateStart = new Date(`${candidate.start_date}T00:00:00Z`);
                const offset = (candidateStart.getUTCFullYear() - start.getUTCFullYear()) * 12
                    + candidateStart.getUTCMonth() - start.getUTCMonth();
                return offset >= 0 && offset < 12;
            }));
        });

        const result = [];
        for (const [startDate, rows] of groups.entries()) {
            const byMonth = new Map(rows.map((row) => [row.start_date, row]));
            if (byMonth.size !== 12) continue;
            const start = new Date(`${startDate}T00:00:00Z`);
            let valid = true;
            const ordered = [];
            for (let offset = 0; offset < 12; offset += 1) {
                const monthDate = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + offset, 1));
                const key = `${monthDate.getUTCFullYear()}-${String(monthDate.getUTCMonth() + 1).padStart(2, '0')}-01`;
                const period = byMonth.get(key);
                if (!period) { valid = false; break; }
                const end = new Date(Date.UTC(monthDate.getUTCFullYear(), monthDate.getUTCMonth() + 1, 0));
                const expectedEnd = `${end.getUTCFullYear()}-${String(end.getUTCMonth() + 1).padStart(2, '0')}-${String(end.getUTCDate()).padStart(2, '0')}`;
                if (period.end_date !== expectedEnd) { valid = false; break; }
                ordered.push(period);
            }
            if (valid) {
                result.push({
                    startDate,
                    endDate: ordered[11].end_date,
                    label: `${start.getUTCFullYear()}`,
                    periods: ordered
                });
            }
        }
        return result.sort((a, b) => b.startDate.localeCompare(a.startDate));
    }

    async function loadLookups() {
        const requests = await Promise.all([
            hasPermission('accounting.settings.read')
                ? state.client.from('accounting_settings')
                    .select('functional_currency, fiscal_year_start_month, timezone_name')
                    .eq('church_id', state.churchId).maybeSingle()
                : Promise.resolve({ data: null, error: null }),
            state.client.from('accounting_periods')
                .select('id, period_code, period_name, period_type, start_date, end_date, status')
                .eq('church_id', state.churchId).order('start_date', { ascending: true }),
            state.client.from('accounting_accounts')
                .select('id, account_code, account_name, account_type, normal_balance, is_active')
                .eq('church_id', state.churchId).eq('is_active', true).order('account_code', { ascending: true }),
            state.client.from('accounting_funds')
                .select('id, fund_code, fund_name, fund_type, is_active')
                .eq('church_id', state.churchId).eq('is_active', true).order('fund_code', { ascending: true }),
            state.client.from('accounting_departments')
                .select('id, department_code, department_name, parent_department_id, is_active')
                .eq('church_id', state.churchId).eq('is_active', true).order('department_name', { ascending: true })
        ]);

        const [settingsResult, periodsResult, accountsResult, fundsResult, departmentsResult] = requests;
        state.settings = settingsResult.data || null;
        state.currencyMeta = null;
        if (hasPermission('accounting.currencies.read') && window.BelieversMeetAccountingCurrency?.loadForChurch) {
            state.currencyMeta = await window.BelieversMeetAccountingCurrency.loadForChurch({
                client: state.client, churchId: state.churchId
            });
        }
        state.periods = periodsResult.error ? [] : (periodsResult.data || []);
        state.accounts = accountsResult.error ? [] : (accountsResult.data || []);
        state.funds = fundsResult.error ? [] : (fundsResult.data || []);
        state.departments = departmentsResult.error ? [] : (departmentsResult.data || []);
        state.eligibleFiscalYears = deriveEligibleFiscalYears(
            state.periods,
            state.settings?.fiscal_year_start_month || 1
        );

        const lookupWarnings = [];
        if (periodsResult.error) lookupWarnings.push('accounting periods');
        if (settingsResult.error) lookupWarnings.push('accounting settings');
        if (accountsResult.error) lookupWarnings.push('account list');
        if (fundsResult.error) lookupWarnings.push('fund list');
        if (departmentsResult.error) lookupWarnings.push('department list');
        if (lookupWarnings.length) {
            setMessage(`Some budget selectors are unavailable (${lookupWarnings.join(', ')}). Check your assigned read permissions.`, 'warning');
        }
    }

    async function loadBudgets(keepSelection = true) {
        const previousId = keepSelection ? state.selectedBudget?.id : null;
        const { data, error } = await state.client.from('accounting_budgets')
            .select('id, budget_code, budget_name, fiscal_year_start, fiscal_year_end, functional_currency, revision_number, parent_budget_id, status, created_by, submitted_by, approved_by, submitted_at, approved_at, created_at, updated_at')
            .eq('church_id', state.churchId)
            .order('fiscal_year_start', { ascending: false })
            .order('revision_number', { ascending: false });
        if (error) throw new Error(`Budgets could not be loaded: ${error.message}`);
        state.budgets = data || [];
        const selected = state.budgets.find((budget) => budget.id === previousId)
            || state.budgets[0] || null;
        if (selected) await loadBudgetDetails(selected.id);
        else {
            state.selectedBudget = null;
            state.lines = [];
            state.allocations = [];
            state.approvals = [];
            state.actualRows = [];
            render();
        }
    }

    async function loadBudgetDetails(budgetId) {
        const budget = state.budgets.find((item) => item.id === budgetId);
        if (!budget) throw new Error('The selected budget is no longer available.');
        state.selectedBudget = budget;
        state.actualRows = [];

        const [linesResult, allocationsResult, approvalsResult] = await Promise.all([
            state.client.from('accounting_budget_lines')
                .select('id, line_number, account_id, fund_id, department_id, line_description, created_at, updated_at')
                .eq('church_id', state.churchId).eq('budget_id', budgetId)
                .order('line_number', { ascending: true }),
            state.client.from('accounting_budget_allocations')
                .select('id, budget_id, budget_line_id, accounting_period_id, budgeted_amount')
                .eq('church_id', state.churchId).eq('budget_id', budgetId),
            state.client.from('accounting_budget_approvals')
                .select('id, actor_user_id, action, from_status, to_status, reason, created_at')
                .eq('church_id', state.churchId).eq('budget_id', budgetId)
                .order('created_at', { ascending: false }).limit(20)
        ]);

        if (linesResult.error) throw new Error(`Budget lines could not be loaded: ${linesResult.error.message}`);
        if (allocationsResult.error) throw new Error(`Budget allocations could not be loaded: ${allocationsResult.error.message}`);
        state.lines = linesResult.data || [];
        state.allocations = allocationsResult.data || [];
        state.approvals = approvalsResult.error ? [] : (approvalsResult.data || []);
        render();
    }

    function budgetPeriods() {
        if (!state.selectedBudget) return [];
        return state.periods.filter((period) =>
            period.start_date >= state.selectedBudget.fiscal_year_start &&
            period.end_date <= state.selectedBudget.fiscal_year_end
        ).sort((a, b) => a.start_date.localeCompare(b.start_date));
    }

    function budgetTotalForLine(lineId) {
        return state.allocations
            .filter((allocation) => allocation.budget_line_id === lineId)
            .reduce((sum, allocation) => sum + Number(allocation.budgeted_amount || 0), 0);
    }

    function budgetStatusClass(status) {
        const value = String(status || '').toLowerCase();
        if (value === 'approved') return 'border-emerald-800 bg-emerald-950/40 text-emerald-300';
        if (value === 'submitted') return 'border-amber-800 bg-amber-950/40 text-amber-200';
        if (value === 'rejected' || value === 'cancelled') return 'border-rose-900 bg-rose-950/40 text-rose-200';
        if (value === 'returned') return 'border-orange-800 bg-orange-950/40 text-orange-200';
        if (value === 'superseded') return 'border-slate-700 bg-slate-800 text-slate-400';
        return 'border-blue-800 bg-blue-950/40 text-blue-200';
    }

    function statusBadge(status) {
        return `<span class="inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${budgetStatusClass(status)}">${escapeHtml(String(status || 'unknown').replaceAll('_', ' '))}</span>`;
    }

    function renderDepartmentManager() {
        const canRead = hasPermission('accounting.departments.read');
        const canManage = hasPermission('accounting.departments.manage');

        if (!canRead && !canManage) return '';

        const parentOptions = state.departments.map((department) =>
            `<option value="${escapeHtml(department.id)}">${escapeHtml(department.department_name)}</option>`
        ).join('');

        const departmentList = state.departments.length
            ? `<div class="flex flex-wrap gap-2">${state.departments.map((department) => `
                <span class="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">
                    ${escapeHtml(department.department_code ? `${department.department_code} · ` : '')}${escapeHtml(department.department_name)}
                </span>
            `).join('')}</div>`
            : '<p class="text-xs text-slate-500">No departments have been created for this church yet.</p>';

        const createForm = canManage ? `
            <form id="accounting-department-create-form" class="grid grid-cols-1 gap-3 md:col-span-2 md:grid-cols-2">
                <label class="block text-xs font-semibold text-slate-300">Department name
                    <input name="department_name" required maxlength="120" placeholder="e.g. Youth Ministry" class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                </label>
                <label class="block text-xs font-semibold text-slate-300">Department code (optional)
                    <input name="department_code" maxlength="32" placeholder="e.g. YTH" class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                </label>
                <label class="block text-xs font-semibold text-slate-300">Parent department (optional)
                    <select name="parent_department_id" class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                        <option value="">No parent</option>${parentOptions}
                    </select>
                </label>
                <label class="block text-xs font-semibold text-slate-300">Description (optional)
                    <input name="description" maxlength="1000" placeholder="Department responsibilities" class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                </label>
                <div class="md:col-span-2">
                    <button type="submit" class="rounded-lg border border-blue-700 px-3 py-2 text-xs font-semibold text-blue-200 hover:bg-blue-950/50">Create department</button>
                </div>
            </form>
        ` : `
            <p class="text-xs text-slate-500">
                You can view and select departments. Department creation is restricted to authorized Finance Administrators.
            </p>
        `;

        return `
            <details class="rounded-xl border border-slate-700 bg-slate-900/40 p-4">
                <summary class="cursor-pointer text-sm font-semibold text-white">
                    Financial departments (${state.departments.length})
                </summary>
                <div class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                    <div class="md:col-span-2">
                        ${departmentList}
                    </div>
                    ${createForm}
                </div>
            </details>`;
    }

    function renderCreateForm() {
        if (!hasPermission('accounting.budgets.manage')) return '';
        const options = state.eligibleFiscalYears.map((year) =>
            `<option value="${escapeHtml(year.startDate)}">${escapeHtml(year.label)} (${escapeHtml(formatDate(year.startDate))} – ${escapeHtml(formatDate(year.endDate))})</option>`
        ).join('');
        return `
            <form id="budget-create-form" class="grid grid-cols-1 gap-3 rounded-xl border border-slate-700 bg-slate-900/60 p-4 md:grid-cols-[1.5fr_1fr_auto] md:items-end">
                <label class="block text-xs font-semibold text-slate-300">New budget name
                    <input id="new-budget-name" name="budget_name" maxlength="150" required placeholder="e.g. Annual Ministry Budget" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500">
                </label>
                <label class="block text-xs font-semibold text-slate-300">Available fiscal year
                    <select id="new-budget-year" name="fiscal_year_start" required ${options ? '' : 'disabled'} class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500">
                        ${options || '<option value="">No complete 12-month period set</option>'}
                    </select>
                </label>
                <button type="submit" ${options ? '' : 'disabled'} class="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:cursor-not-allowed disabled:opacity-50">Create budget</button>
                ${options ? '' : '<p class="text-xs leading-5 text-amber-200 md:col-span-3">A budget can only be created when the church has a complete set of 12 monthly accounting periods for the selected fiscal year. No periods will be created automatically here.</p>'}
            </form>`;
    }

    function renderBudgetSelector() {
        if (!state.budgets.length) {
            return '<div class="rounded-xl border border-dashed border-slate-700 p-5 text-sm text-slate-400">No budgets have been created for this church yet.</div>';
        }
        return `
            <label class="block text-xs font-semibold text-slate-300">Select budget
                <select id="budget-select" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white outline-none focus:border-blue-500">
                    ${state.budgets.map((budget) => `<option value="${escapeHtml(budget.id)}" ${state.selectedBudget?.id === budget.id ? 'selected' : ''}>${escapeHtml(budget.budget_name)} · FY ${escapeHtml(String(budget.fiscal_year_start).slice(0, 4))} · Rev ${escapeHtml(budget.revision_number)} · ${escapeHtml(budget.status)}</option>`).join('')}
                </select>
            </label>`;
    }

    function renderLineEditor(line) {
        const canEdit = Boolean(state.currencyMeta) && hasPermission('accounting.budgets.manage') && ['draft', 'returned'].includes(state.selectedBudget.status);
        const account = state.accounts.find((item) => item.id === line.account_id);
        const fund = state.funds.find((item) => item.id === line.fund_id);
        const department = state.departments.find((item) => item.id === line.department_id);
        const periods = budgetPeriods();
        const lineAllocations = periods.map((period) => {
            const allocation = state.allocations.find((item) =>
                item.budget_line_id === line.id && item.accounting_period_id === period.id
            );
            const amount = allocation ? allocation.budgeted_amount : '';
            return `<tr class="border-t border-slate-800">
                <td class="py-2 pr-3 text-slate-300">${escapeHtml(period.period_name || period.period_code)}</td>
                <td class="py-2 pr-3 text-slate-500">${escapeHtml(formatDate(period.start_date))}</td>
                <td class="py-2 pr-3">
                    ${canEdit ? `<input type="number" min="0" step="${escapeHtml(currencyStep(state.selectedBudget.functional_currency))}" inputmode="decimal" data-allocation-input="${escapeHtml(line.id)}:${escapeHtml(period.id)}" value="${escapeHtml(amount)}" placeholder="0" class="w-36 rounded-md border border-slate-700 bg-slate-950 px-2.5 py-1.5 text-right text-sm text-white">` : `<span class="text-sm tabular-nums text-slate-200">${escapeHtml(formatMoney(amount || 0, state.selectedBudget.functional_currency))}</span>`}
                </td>
                <td class="py-2 text-right">${canEdit ? `<button type="button" data-action="save-allocation" data-line-id="${escapeHtml(line.id)}" data-period-id="${escapeHtml(period.id)}" class="rounded-md border border-slate-700 px-2.5 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-800">Save</button>` : ''}</td>
            </tr>`;
        }).join('');

        return `
            <article class="rounded-xl border border-slate-700 bg-slate-900/50 p-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <div class="min-w-0">
                        <p class="text-xs font-semibold uppercase tracking-wider text-slate-500">Line ${escapeHtml(line.line_number)}</p>
                        <h4 class="mt-1 font-semibold text-white">${escapeHtml(account ? `${account.account_code} · ${account.account_name}` : 'Account unavailable')}</h4>
                        <p class="mt-1 text-xs text-slate-400">${escapeHtml(line.line_description)} · ${escapeHtml(fund?.fund_name || 'Fund unavailable')}${department ? ` · ${escapeHtml(department.department_name)}` : ''}</p>
                    </div>
                    <div class="text-right">
                        <p class="text-xs text-slate-500">Annual allocation</p>
                        <p class="font-semibold tabular-nums text-white">${escapeHtml(formatMoney(budgetTotalForLine(line.id), state.selectedBudget.functional_currency))}</p>
                        ${canEdit ? `<button type="button" data-action="delete-line" data-line-id="${escapeHtml(line.id)}" class="mt-2 text-xs font-semibold text-rose-300 hover:text-rose-200">Delete line</button>` : ''}
                    </div>
                </div>
                ${canEdit ? `
                    <details class="mt-4 border-t border-slate-800 pt-3">
                        <summary class="cursor-pointer text-sm font-semibold text-blue-300">Edit line details</summary>
                        <form data-line-form="${escapeHtml(line.id)}" class="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                            ${renderAccountSelect(`line-account-${line.id}`, line.account_id)}
                            ${renderFundSelect(`line-fund-${line.id}`, line.fund_id)}
                            ${renderDepartmentSelect(`line-department-${line.id}`, line.department_id)}
                            <label class="block text-xs font-semibold text-slate-300">Line description
                                <input name="line_description" required maxlength="300" value="${escapeHtml(line.line_description)}" class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                            </label>
                            <div class="md:col-span-2"><button type="submit" class="rounded-lg border border-blue-700 px-3 py-2 text-xs font-semibold text-blue-200 hover:bg-blue-950/50">Save line details</button></div>
                        </form>
                    </details>` : ''}
                <details class="mt-4 border-t border-slate-800 pt-3" open>
                    <summary class="cursor-pointer text-sm font-semibold text-slate-200">Monthly allocations (${periods.length} periods)</summary>
                    ${periods.length ? `<div class="mt-3 overflow-x-auto"><table class="w-full min-w-[560px] text-sm"><thead><tr class="text-left text-xs uppercase tracking-wide text-slate-500"><th class="pb-2 pr-3">Period</th><th class="pb-2 pr-3">Start</th><th class="pb-2 pr-3">Budgeted amount</th><th class="pb-2 text-right">Action</th></tr></thead><tbody>${lineAllocations}</tbody></table></div>` : '<p class="mt-3 text-sm text-amber-200">No accounting periods match this budget year.</p>'}
                </details>
            </article>`;
    }

    function renderAccountSelect(id, selectedId = '') {
        const options = state.accounts
            .filter((account) => ['income', 'expense'].includes(String(account.account_type).toLowerCase()))
            .map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === selectedId ? 'selected' : ''}>${escapeHtml(account.account_code)} · ${escapeHtml(account.account_name)} (${escapeHtml(account.account_type)})</option>`).join('');
        return `<label class="block text-xs font-semibold text-slate-300">Income / expense account
            <select id="${escapeHtml(id)}" name="account_id" required class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"><option value="">Choose account</option>${options}</select>
        </label>`;
    }

    function renderFundSelect(id, selectedId = '') {
        const options = state.funds.map((fund) => `<option value="${escapeHtml(fund.id)}" ${fund.id === selectedId ? 'selected' : ''}>${escapeHtml(fund.fund_code)} · ${escapeHtml(fund.fund_name)}</option>`).join('');
        return `<label class="block text-xs font-semibold text-slate-300">Fund
            <select id="${escapeHtml(id)}" name="fund_id" required class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"><option value="">Choose fund</option>${options}</select>
        </label>`;
    }

    function renderDepartmentSelect(id, selectedId = '') {
        const options = state.departments.map((department) => `<option value="${escapeHtml(department.id)}" ${department.id === selectedId ? 'selected' : ''}>${escapeHtml(department.department_code ? `${department.department_code} · ` : '')}${escapeHtml(department.department_name)}</option>`).join('');
        return `<label class="block text-xs font-semibold text-slate-300">Department (optional)
            <select id="${escapeHtml(id)}" name="department_id" class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white"><option value="">No department</option>${options}</select>
        </label>`;
    }

    function renderNewLineForm() {
        if (!hasPermission('accounting.budgets.manage') || !['draft', 'returned'].includes(state.selectedBudget.status)) return '';
        if (!state.accounts.length || !state.funds.length) {
            return '<p class="rounded-lg border border-amber-800 bg-amber-950/20 p-3 text-sm text-amber-100">Active account and fund lists are required before adding budget lines. Check your Finance read permissions.</p>';
        }
        const nextLineNumber = state.lines.reduce((maximum, line) => Math.max(maximum, Number(line.line_number) || 0), 0) + 1;
        return `
            <details class="rounded-xl border border-dashed border-blue-700/70 bg-blue-950/10 p-4">
                <summary class="cursor-pointer text-sm font-semibold text-blue-200">Add a budget line</summary>
                <form id="budget-new-line-form" class="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
                    <input type="hidden" name="line_number" value="${nextLineNumber}">
                    ${renderAccountSelect('new-line-account')}
                    ${renderFundSelect('new-line-fund')}
                    ${renderDepartmentSelect('new-line-department')}
                    <label class="block text-xs font-semibold text-slate-300">Line description
                        <input name="line_description" required maxlength="300" placeholder="Describe the planned income or expense" class="mt-1 w-full rounded-md border border-slate-700 bg-slate-950 px-3 py-2 text-sm text-white">
                    </label>
                    <div class="md:col-span-2"><button type="submit" class="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500">Save budget line</button></div>
                </form>
            </details>`;
    }

    function renderWorkflowActions() {
        const budget = state.selectedBudget;
        if (!budget) return '';
        const status = String(budget.status).toLowerCase();
        const buttons = [];
        if (['draft', 'returned'].includes(status) && hasPermission('accounting.budgets.submit')) {
            buttons.push('<button type="button" data-action="submit-budget" class="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-500">Submit for approval</button>');
        }
        if (status === 'submitted' && hasPermission('accounting.budgets.approve') && budget.submitted_by !== state.user?.id) {
            buttons.push('<button type="button" data-action="approve-budget" class="rounded-lg bg-emerald-600 px-3 py-2 text-xs font-semibold text-white hover:bg-emerald-500">Approve</button>');
            buttons.push('<button type="button" data-action="return-budget" class="rounded-lg border border-amber-700 px-3 py-2 text-xs font-semibold text-amber-200 hover:bg-amber-950/40">Return for changes</button>');
            buttons.push('<button type="button" data-action="reject-budget" class="rounded-lg border border-rose-800 px-3 py-2 text-xs font-semibold text-rose-200 hover:bg-rose-950/40">Reject</button>');
        }
        if (['draft', 'returned', 'submitted'].includes(status) && hasPermission('accounting.budgets.manage')) {
            buttons.push('<button type="button" data-action="cancel-budget" class="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800">Cancel budget</button>');
        }
        if (status === 'approved' && hasPermission('accounting.budgets.manage')) {
            buttons.push('<button type="button" data-action="create-revision" class="rounded-lg border border-blue-700 px-3 py-2 text-xs font-semibold text-blue-200 hover:bg-blue-950/40">Create revision</button>');
        }
        return buttons.length ? `<div class="flex flex-wrap gap-2">${buttons.join('')}</div>` : '<p class="text-xs text-slate-500">No workflow actions are available for your assigned permissions and this budget status.</p>';
    }

    function renderHistory() {
        if (!state.approvals.length) return '<p class="text-sm text-slate-500">No workflow decisions have been recorded yet.</p>';
        return `<div class="overflow-x-auto"><table class="w-full min-w-[520px] text-sm"><thead><tr class="text-left text-xs uppercase tracking-wide text-slate-500"><th class="pb-2 pr-3">Date</th><th class="pb-2 pr-3">Action</th><th class="pb-2 pr-3">Status</th><th class="pb-2">Reason</th></tr></thead><tbody>${state.approvals.map((approval) => `<tr class="border-t border-slate-800"><td class="py-2 pr-3 text-slate-400">${escapeHtml(formatDate(approval.created_at))}</td><td class="py-2 pr-3 text-slate-200">${escapeHtml(approval.action)}</td><td class="py-2 pr-3">${statusBadge(approval.to_status)}</td><td class="py-2 text-slate-400">${escapeHtml(approval.reason || '—')}</td></tr>`).join('')}</tbody></table></div>`;
    }

    function renderActuals() {
        if (!state.actualRows.length) return '<p class="text-sm text-slate-500">Choose “Load budget vs actual” to retrieve the report. Actuals are calculated by the accounting RPC from posted ledger activity.</p>';
        return `<div class="overflow-x-auto"><table class="w-full min-w-[720px] text-sm"><thead><tr class="text-left text-xs uppercase tracking-wide text-slate-500"><th class="pb-2 pr-3">Period</th><th class="pb-2 pr-3">Account</th><th class="pb-2 pr-3">Fund</th><th class="pb-2 pr-3">Department</th><th class="pb-2 pr-3 text-right">Budget</th><th class="pb-2 pr-3 text-right">Actual</th><th class="pb-2 text-right">Variance</th></tr></thead><tbody>${state.actualRows.map((row) => `<tr class="border-t border-slate-800"><td class="py-2 pr-3 text-slate-300">${escapeHtml(row.period_name || formatDate(row.period_start))}</td><td class="py-2 pr-3 text-slate-300">${escapeHtml(`${row.account_code || ''} ${row.account_name || ''}`.trim())}</td><td class="py-2 pr-3 text-slate-400">${escapeHtml(row.fund_name || '—')}</td><td class="py-2 pr-3 text-slate-400">${escapeHtml(row.department_name || '—')}</td><td class="py-2 pr-3 text-right tabular-nums text-slate-300">${escapeHtml(formatMoney(row.budgeted_amount, state.selectedBudget.functional_currency))}</td><td class="py-2 pr-3 text-right tabular-nums text-slate-300">${escapeHtml(formatMoney(row.actual_amount, state.selectedBudget.functional_currency))}</td><td class="py-2 text-right tabular-nums ${Number(row.variance_amount) < 0 ? 'text-rose-300' : 'text-emerald-300'}">${escapeHtml(formatMoney(row.variance_amount, state.selectedBudget.functional_currency))}</td></tr>`).join('')}</tbody></table></div>`;
    }

    function renderSelectedBudget() {
        const budget = state.selectedBudget;
        if (!budget) return '';
        const canEdit = Boolean(state.currencyMeta) && hasPermission('accounting.budgets.manage') && ['draft', 'returned'].includes(budget.status);
        return `
            <section class="space-y-4">
                <div class="flex flex-col justify-between gap-3 rounded-xl border border-slate-700 bg-slate-900/60 p-4 sm:flex-row sm:items-start">
                    <div>
                        <div class="flex flex-wrap items-center gap-2"><h3 class="text-lg font-bold text-white">${escapeHtml(budget.budget_name)}</h3>${statusBadge(budget.status)}</div>
                        <p class="mt-1 text-xs text-slate-400">${escapeHtml(budget.budget_code)} · ${escapeHtml(formatDate(budget.fiscal_year_start))} – ${escapeHtml(formatDate(budget.fiscal_year_end))} · Revision ${escapeHtml(budget.revision_number)}</p>
                        <p class="mt-1 text-xs text-slate-500">Currency: ${escapeHtml(budget.functional_currency)}</p>
                    </div>
                    <div class="text-left sm:text-right"><p class="text-xs text-slate-500">Total annual budget</p><p class="mt-1 text-xl font-bold tabular-nums text-white">${escapeHtml(formatMoney(state.lines.reduce((sum, line) => sum + budgetTotalForLine(line.id), 0), budget.functional_currency))}</p></div>
                </div>
                ${renderWorkflowActions()}
                ${canEdit ? renderNewLineForm() : ''}
                <div class="space-y-3">
                    <div class="flex items-center justify-between gap-3"><h4 class="font-semibold text-white">Budget lines</h4><span class="text-xs text-slate-500">${state.lines.length} line(s)</span></div>
                    ${state.lines.length ? state.lines.map(renderLineEditor).join('') : '<p class="rounded-lg border border-dashed border-slate-700 p-5 text-sm text-slate-400">No budget lines have been added yet.</p>'}
                </div>
                <section class="rounded-xl border border-slate-700 bg-slate-900/40 p-4">
                    <div class="flex flex-wrap items-center justify-between gap-3"><div><h4 class="font-semibold text-white">Budget vs actual</h4><p class="mt-1 text-xs text-slate-500">Compares monthly allocations with posted accounting activity.</p></div><button type="button" data-action="load-actuals" class="rounded-lg border border-slate-600 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800">Load budget vs actual</button></div>
                    <div class="mt-3">${renderActuals()}</div>
                </section>
                <section class="rounded-xl border border-slate-700 bg-slate-900/40 p-4">
                    <h4 class="mb-3 font-semibold text-white">Approval history</h4>${renderHistory()}
                </section>
            </section>`;
    }

    function render() {
        const currency = state.settings?.functional_currency || 'Unavailable';
        panel.innerHTML = `
            <div class="space-y-4">
                <div class="flex flex-wrap items-start justify-between gap-3">
                    <div><p class="bm-kicker">Planning workspace</p><h2 class="mt-1 text-lg font-bold text-white">Budgets & forecasts</h2><p class="mt-1 text-xs text-slate-500">Prepare annual budgets, allocate monthly amounts and follow the approval trail.</p></div>
                    <span class="rounded-full border border-slate-700 px-3 py-1 text-xs font-semibold text-slate-400">${escapeHtml(currency)} · ${state.budgets.length} budget(s)</span>
                </div>
                <div id="budget-message" class="hidden" role="status" aria-live="polite"></div>
                <div id="budget-busy" class="hidden text-xs text-blue-200">Saving / loading budget data…</div>
                ${renderDepartmentManager()}
                ${renderCreateForm()}
                <div class="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto] md:items-end">
                    <div>${renderBudgetSelector()}</div>
                    <button type="button" data-action="refresh-budgets" class="rounded-lg border border-slate-700 px-3 py-2.5 text-xs font-semibold text-slate-200 hover:bg-slate-800">Refresh budgets</button>
                </div>
                ${renderSelectedBudget()}
            </div>`;
    }

    async function rpc(name, args) {
        const { data, error } = await state.client.rpc(name, args);
        if (error) throw new Error(error.message || `${name} failed`);
        return data;
    }

    async function withBusy(task, successMessage) {
        if (state.loading) return;
        setBusy(true);
        try {
            await task();
            if (successMessage) setMessage(successMessage, 'success');
        } catch (error) {
            console.error('Budget workspace:', error);
            setMessage(error.message || 'The budget operation could not be completed.', 'error');
        } finally {
            setBusy(false);
        }
    }

    async function refreshSelected() {
        await loadBudgets(true);
    }

    function formValue(form, name) {
        return String(new FormData(form).get(name) || '').trim();
    }

    async function createDepartment(form) {
        if (!hasPermission('accounting.departments.manage')) throw new Error('You do not have permission to create departments.');
        const name = formValue(form, 'department_name');
        const code = formValue(form, 'department_code') || null;
        const description = formValue(form, 'description') || null;
        const parentId = formValue(form, 'parent_department_id') || null;
        if (!name) throw new Error('Enter a department name.');
        await rpc('create_accounting_department', {
            p_church_id: state.churchId,
            p_department_name: name,
            p_department_code: code,
            p_description: description,
            p_parent_department_id: parentId
        });
        await loadLookups();
        render();
    }

    async function createBudget(form) {
        if (!hasPermission('accounting.budgets.manage')) throw new Error('You do not have permission to create budgets.');
        const name = formValue(form, 'budget_name');
        const startDate = formValue(form, 'fiscal_year_start');
        if (!name || !startDate) throw new Error('Enter a budget name and select a fiscal year.');
        const budgetId = await rpc('accounting_create_budget', {
            p_church_id: state.churchId,
            p_budget_name: name,
            p_fiscal_year_start: startDate
        });
        await loadBudgets(false);
        if (budgetId) await loadBudgetDetails(budgetId);
    }

    async function saveLine(form, lineId = null) {
        if (!hasPermission('accounting.budgets.manage')) throw new Error('You do not have permission to edit budget lines.');
        const accountId = formValue(form, 'account_id');
        const fundId = formValue(form, 'fund_id');
        const departmentId = formValue(form, 'department_id') || null;
        const description = formValue(form, 'line_description');
        const lineNumber = lineId
            ? Number(state.lines.find((line) => line.id === lineId)?.line_number)
            : Number(formValue(form, 'line_number'));
        if (!accountId || !fundId || !description || !Number.isInteger(lineNumber) || lineNumber < 1) {
            throw new Error('Choose an account and fund, and enter a valid line description.');
        }
        await rpc('accounting_save_budget_line', {
            p_budget_id: state.selectedBudget.id,
            p_line_id: lineId,
            p_line_number: lineNumber,
            p_account_id: accountId,
            p_fund_id: fundId,
            p_department_id: departmentId || null,
            p_line_description: description
        });
        await loadBudgetDetails(state.selectedBudget.id);
    }

    async function saveAllocation(lineId, periodId) {
        if (!hasPermission('accounting.budgets.manage')) throw new Error('You do not have permission to change allocations.');
        const input = panel.querySelector(`[data-allocation-input="${CSS.escape(`${lineId}:${periodId}`)}"]`);
        if (!input || input.value.trim() === '') throw new Error('Enter a monthly budget amount. Use 0 when no amount is planned.');
        if (!state.currencyMeta || !state.selectedBudget?.functional_currency) {
            throw new Error('The ISO currency precision catalogue is unavailable. Budget editing is disabled until precision metadata can be loaded.');
        }
        const amount = state.currencyMeta.parseAmount(input.value, state.selectedBudget.functional_currency, 'Monthly budget allocation');
        await rpc('accounting_set_budget_allocation', {
            p_budget_line_id: lineId,
            p_accounting_period_id: periodId,
            p_budgeted_amount: amount
        });
        await loadBudgetDetails(state.selectedBudget.id);
    }

    async function workflowAction(action) {
        const budgetId = state.selectedBudget?.id;
        if (!budgetId) throw new Error('Select a budget first.');
        const reasonActions = {
            'return-budget': ['accounting_return_budget', 'Return this budget for changes? Enter a reason (10–500 characters):'],
            'reject-budget': ['accounting_reject_budget', 'Reject this budget? Enter a reason (10–500 characters):'],
            'cancel-budget': ['accounting_cancel_budget', 'Cancel this budget? Enter a reason (10–500 characters):']
        };
        if (action === 'submit-budget') {
            if (!hasPermission('accounting.budgets.submit')) throw new Error('You do not have permission to submit budgets.');
            if (!window.confirm('Submit this budget for approval? The budget must have a complete monthly allocation for every line.')) return;
            await rpc('accounting_submit_budget', { p_budget_id: budgetId });
        } else if (action === 'approve-budget') {
            if (!hasPermission('accounting.budgets.approve')) throw new Error('You do not have permission to approve budgets.');
            if (!window.confirm('Approve this budget? You cannot approve your own submission.')) return;
            await rpc('accounting_approve_budget', { p_budget_id: budgetId });
        } else if (reasonActions[action]) {
            if (action === 'cancel-budget' && !hasPermission('accounting.budgets.manage')) throw new Error('You do not have permission to cancel budgets.');
            if (action !== 'cancel-budget' && !hasPermission('accounting.budgets.approve')) throw new Error('You do not have permission to review budgets.');
            const [functionName, promptText] = reasonActions[action];
            const reason = window.prompt(promptText);
            if (reason === null) return;
            if (reason.trim().length < 10 || reason.trim().length > 500) throw new Error('Enter a reason between 10 and 500 characters.');
            await rpc(functionName, { p_budget_id: budgetId, p_reason: reason.trim() });
        } else if (action === 'create-revision') {
            if (!hasPermission('accounting.budgets.manage')) throw new Error('You do not have permission to create revisions.');
            const name = window.prompt('Revision name (leave blank to keep the existing budget name):', state.selectedBudget.budget_name);
            if (name === null) return;
            const revisionId = await rpc('accounting_create_budget_revision', {
                p_source_budget_id: budgetId,
                p_budget_name: name.trim() || null
            });
            await loadBudgets(false);
            if (revisionId) await loadBudgetDetails(revisionId);
            return;
        }
        await loadBudgets(true);
    }

    async function loadActuals() {
        if (!state.selectedBudget) throw new Error('Select a budget first.');
        const rows = await rpc('accounting_budget_vs_actual', {
            p_budget_id: state.selectedBudget.id,
            p_accounting_period_id: null
        });
        state.actualRows = Array.isArray(rows) ? rows : [];
        render();
        if (!state.actualRows.length) setMessage('No budget-versus-actual rows were returned. Add complete monthly allocations and post ledger activity to populate this report.', 'info');
    }

    panel.addEventListener('change', (event) => {
        if (event.target.id === 'budget-select') {
            withBusy(() => loadBudgetDetails(event.target.value));
        }
    });

    panel.addEventListener('submit', (event) => {
        const form = event.target;
        if (form.id === 'accounting-department-create-form') {
            event.preventDefault();
            withBusy(() => createDepartment(form), 'Department created.');
        } else if (form.id === 'budget-create-form') {
            event.preventDefault();
            withBusy(() => createBudget(form), 'Budget created.');
        } else if (form.id === 'budget-new-line-form') {
            event.preventDefault();
            withBusy(() => saveLine(form), 'Budget line saved.');
        } else if (form.matches('[data-line-form]')) {
            event.preventDefault();
            withBusy(() => saveLine(form, form.getAttribute('data-line-form')), 'Budget line updated.');
        }
    });

    panel.addEventListener('click', (event) => {
        const button = event.target.closest('[data-action]');
        if (!button || button.disabled) return;
        const action = button.dataset.action;
        if (action === 'refresh-budgets') {
            withBusy(refreshSelected, 'Budget list refreshed.');
        } else if (action === 'save-allocation') {
            withBusy(() => saveAllocation(button.dataset.lineId, button.dataset.periodId), 'Monthly allocation saved.');
        } else if (action === 'delete-line') {
            if (!window.confirm('Delete this budget line? This is only possible while the budget is editable.')) return;
            withBusy(async () => {
                await rpc('accounting_delete_budget_line', { p_line_id: button.dataset.lineId });
                await loadBudgetDetails(state.selectedBudget.id);
            }, 'Budget line deleted.');
        } else if (action === 'load-actuals') {
            withBusy(loadActuals);
        } else if (['submit-budget', 'approve-budget', 'return-budget', 'reject-budget', 'cancel-budget', 'create-revision'].includes(action)) {
            withBusy(() => workflowAction(action), 'Budget workflow updated.');
        }
    });

    async function init() {
        panel.innerHTML = '<div class="py-5 text-sm text-slate-400">Verifying budget permissions and loading your Finance workspace…</div>';
        try {
            await authorize();
            await loadLookups();
            await loadBudgets(false);
            if (!state.currencyMeta) {
                setMessage('Currency precision metadata is unavailable. Budget amounts remain readable, but allocation editing is disabled.', 'warning');
            } else if (!hasPermission('accounting.budgets.manage')) {
                setMessage('You have read-only budget access. Editing controls are hidden.', 'info');
            }
        } catch (error) {
            console.error('Budget workspace initialization failed:', error);
            panel.innerHTML = `<div class="rounded-lg border border-rose-800 bg-rose-950/25 p-4 text-sm text-rose-200">Budget workspace unavailable: ${escapeHtml(error.message || 'Access could not be verified.')}</div>`;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
