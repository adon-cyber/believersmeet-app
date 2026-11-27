/*
 * BelieversMeet Accounting Dashboard
 * Read-only first release. Financial writes remain behind the accounting RPCs.
 * The database's RLS policies are the authority for all accounting data access.
 */
(() => {
    'use strict';

    const state = {
        client: null,
        user: null,
        profile: null,
        churchId: null,
        isSuperAdmin: false,
        settings: null,
        currencyMeta: null,
        accounts: [],
        funds: [],
        periods: [],
        journals: [],
        sourceEvents: [],
        errors: [],
        permissions: {}
    };

    const $ = (id) => document.getElementById(id);

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[character]);
    }

    function localDateISO(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function currencyFormatter(currency) {
        const code = String(currency || '').trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(code)) throw new Error('Currency code is unavailable.');
        const digits = state.currencyMeta?.minorUnit(code);
        if (!Number.isInteger(digits)) throw new Error(`ISO minor-unit precision is unavailable for ${code}.`);
        return new Intl.NumberFormat(undefined, {
            style: 'currency', currency: code,
            minimumFractionDigits: digits, maximumFractionDigits: digits
        });
    }

    function formatMoney(amount, currency) {
        if (amount === null || amount === undefined || !Number.isFinite(Number(amount))) return '—';
        const code = String(currency || '').trim().toUpperCase();
        if (!/^[A-Z]{3}$/.test(code)) return `${Number(amount).toLocaleString()} (currency unavailable)`;
        try {
            return state.currencyMeta ? state.currencyMeta.format(Number(amount), code) : currencyFormatter(code).format(Number(amount));
        } catch (_) {
            return `${Number(amount).toLocaleString()} ${code}`.trim();
        }
    }

    function churchToday(timezoneName) {
        const validTimezone = timezoneName || 'UTC';
        const parts = new Intl.DateTimeFormat('en-CA', {
            timeZone: validTimezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit'
        }).formatToParts(new Date());
        const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
        return {
            iso: `${values.year}-${values.month}-${values.day}`,
            monthStart: `${values.year}-${values.month}-01`
        };
    }

    function formatDate(value) {
        if (!value) return '—';
        const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
        return Number.isNaN(date.getTime())
            ? '—'
            : new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
    }

    function setAlert(message, kind = 'info') {
        const element = $('page-alert');
        if (!element) return;
        if (!message) {
            element.className = 'mb-6 hidden rounded-xl border px-4 py-3 text-sm';
            element.textContent = '';
            return;
        }
        const classes = kind === 'error'
            ? 'border-rose-900/70 bg-rose-950/30 text-rose-100'
            : kind === 'warning'
                ? 'border-amber-900/70 bg-amber-950/25 text-amber-100'
                : 'border-blue-900/70 bg-blue-950/25 text-blue-100';
        element.className = `mb-6 rounded-xl border px-4 py-3 text-sm ${classes}`;
        element.textContent = message;
    }

    function denyAccess(message) {
        $('access-loading')?.classList.add('hidden');
        $('dashboard-content')?.classList.add('hidden');
        $('access-denied-message').textContent = message;
        $('access-denied')?.classList.remove('hidden');
        $('refresh-button').disabled = true;
    }

    async function waitForSupabaseClient() {
        for (let attempt = 0; attempt < 30; attempt += 1) {
            const client = window.sbClient || window.supabaseClient;
            if (client?.auth && typeof client.from === 'function') return client;
            await new Promise((resolve) => window.setTimeout(resolve, 100));
        }
        throw new Error('The Supabase client did not initialize. Check js/supabase-config.js and the browser console.');
    }

    const FINANCIAL_PERMISSION_KEYS = Object.freeze([
        'accounting.accounts.read',
        'accounting.accounts.manage',
        'accounting.accounts.currency.manage',
        'accounting.funds.read',
        'accounting.funds.manage',
        'accounting.periods.read',
        'accounting.periods.manage',
        'accounting.settings.read',
        'accounting.settings.manage',
        'accounting.journals.read',
        'accounting.reports.read',
        'accounting.journals.create',
        'accounting.journals.approve',
        'accounting.journals.post',
        'accounting.journals.reverse',
        'accounting.reconciliation.read',
        'accounting.reconciliation.manage',
        'accounting.reconciliation.approve',
        'accounting.currencies.read',
        'accounting.currencies.manage',
        'accounting.exchange_rates.read',
        'accounting.exchange_rates.manage',
        'accounting.exchange_rates.approve',
        'accounting.fx_valuation.read',
        'accounting.fx_valuation.manage',
        'accounting.fx_valuation.approve',
        'accounting.budgets.read',
        'accounting.budgets.manage',
        'accounting.budgets.submit',
        'accounting.budgets.approve',
        'accounting.departments.read',
        'accounting.departments.manage',
        'accounting.audit.read'
    ]);

    function hasPermission(permissionKey) {
        return state.permissions[permissionKey] === true;
    }

    function applyResponsiveDashboardLayout() {
        const fitGrid = (grid, minWidth, maxWidth = null) => {
            if (!grid) return;

            const visible = Array.from(grid.children).filter(
                (item) => !item.classList.contains('hidden')
            );

            if (!visible.length) return;

            grid.style.gridTemplateColumns = maxWidth
                ? `repeat(auto-fit, minmax(min(100%, ${minWidth}px), ${maxWidth}px))`
                : `repeat(auto-fit, minmax(min(100%, ${minWidth}px), 1fr))`;

            grid.style.justifyContent = maxWidth ? 'start' : 'stretch';
            grid.style.alignItems = 'stretch';
        };

        const summaryGrid = document.querySelector(
            'section[aria-label="Financial summary"]'
        );

        const fundsCard = $('metric-funds')?.closest('article');
        const periodCard = $('current-period')?.closest('article');
        const periodGrid = periodCard?.parentElement;

        const visibleMetrics = summaryGrid
            ? Array.from(summaryGrid.children).filter(
                (item) => !item.classList.contains('hidden')
            )
            : [];

        // Identify the restricted Finance layout: only the funds metric is visible.
        const pairFundsWithPeriod = Boolean(
            summaryGrid &&
            fundsCard &&
            periodCard &&
            periodGrid &&
            visibleMetrics.length === 1 &&
            visibleMetrics[0] === fundsCard &&
            !fundsCard.classList.contains('hidden') &&
            !periodCard.classList.contains('hidden')
        );

        if (summaryGrid) {
            summaryGrid.querySelectorAll(':scope > article').forEach((card) => {
                card.classList.toggle(
                    'bm-wide-metric',
                    visibleMetrics.length === 1 &&
                    card === visibleMetrics[0] &&
                    !pairFundsWithPeriod
                );
            });
        }

        if (pairFundsWithPeriod) {
            // Put the two visible overview cards into the same responsive grid.
            periodGrid.appendChild(fundsCard);
            fundsCard.classList.remove('bm-wide-metric');
            summaryGrid.classList.add('hidden');

            fitGrid(periodGrid, 360);
        } else {
            summaryGrid?.classList.remove('hidden');
            fitGrid(summaryGrid, 260, 340);

            if (periodGrid) {
                fitGrid(periodGrid, 420, 680);
            }
        }

        if (periodGrid) {
            const visiblePanels = Array.from(periodGrid.children).filter(
                (item) => !item.classList.contains('hidden')
            );

            periodCard?.classList.toggle(
                'bm-wide-period',
                visiblePanels.length === 1 &&
                visiblePanels[0] === periodCard
            );
        }

        // Accounts and funds retain a balanced responsive two-column layout.
        const accountsGrid = $('accounts')?.parentElement;
        fitGrid(accountsGrid, 420);

        // The visible reconciliation or budget panel uses available width.
        fitGrid($('reviews'), 620);
    }

    function applyPermissionVisibility() {
        const sectionRules = [
            ['trial-balance-workspace', 'accounting.reports.read'],
            ['financial-position-workspace', 'accounting.reports.read'],
            ['journals', 'accounting.journals.read'],
            ['accounts', 'accounting.accounts.read'],
            ['funds', 'accounting.funds.read']
        ];

        sectionRules.forEach(([elementId, permissionKey]) => {
            const element = $(elementId);
            if (element) {
                element.classList.toggle('hidden', !hasPermission(permissionKey));
            }
        });

        const reviewSection = $('reviews');

        if (reviewSection) {
            const sourceReviewPanel = reviewSection.children[0];
            const budgetPanel = reviewSection.children[1];

            const canReadReconciliation = hasPermission('accounting.reconciliation.read');
            const canReadBudgets =
                hasPermission('accounting.budgets.read') ||
                hasPermission('accounting.budgets.manage') ||
                hasPermission('accounting.budgets.submit') ||
                hasPermission('accounting.budgets.approve');

            sourceReviewPanel?.classList.toggle('hidden', !canReadReconciliation);
            budgetPanel?.classList.toggle('hidden', !canReadBudgets);
            reviewSection.classList.toggle('hidden', !canReadReconciliation && !canReadBudgets);

            // Use two columns only when both panels are visible.
            reviewSection.classList.toggle(
                'xl:grid-cols-2',
                canReadReconciliation && canReadBudgets
            );
        }
        applyResponsiveDashboardLayout();
    }

    async function authorizePage() {
        state.client = await waitForSupabaseClient();

        const { data: userResult, error: userError } = await state.client.auth.getUser();

        if (userError || !userResult?.user) {
            window.location.replace('login.html');
            return false;
        }

        state.user = userResult.user;

        const { data: profile, error: profileError } = await state.client
            .from('profiles')
            .select('id, role, church_id')
            .eq('id', state.user.id)
            .maybeSingle();

        if (profileError) {
            throw new Error(`Could not verify your church profile: ${profileError.message}`);
        }

        if (!profile) {
            denyAccess('Your account does not have a readable BelieversMeet profile. Please contact your church administrator.');
            return false;
        }

        state.profile = profile;

        // Financial staff use the accounting workspace, not Church Admin navigation.
        const churchAdminLink = $('accounting-admin-link');
        if (churchAdminLink) {
            churchAdminLink.classList.toggle('hidden', profile.role !== 'church_admin');
        }

        // Super Admin status is verified, but it does not grant financial access.
        const { data: isSuperAdmin, error: adminCheckError } =
            await state.client.rpc('is_super_admin');

        state.isSuperAdmin = !adminCheckError && isSuperAdmin === true;

        const requestedChurchId = new URLSearchParams(window.location.search).get('church_id');

        // A Super Admin may select a church context, but must still pass that
        // church's financial permission checks below.
        state.churchId = requestedChurchId && state.isSuperAdmin
            ? requestedChurchId
            : profile.church_id || null;

        if (!state.churchId) {
            denyAccess('Your account has no church context for accounting. Contact your church administrator.');
            return false;
        }

        // The database validates profile status, church approval, assignment,
        // role status and permission mapping. Any verification error fails closed.
        const permissionResults = await Promise.all(
            FINANCIAL_PERMISSION_KEYS.map(async (permissionKey) => {
                const { data, error } = await state.client.rpc(
                    'has_church_financial_permission',
                    {
                        p_church_id: state.churchId,
                        p_permission_key: permissionKey
                    }
                );

                if (error) {
                    throw new Error(
                        `Could not verify ${permissionKey}: ${error.message}`
                    );
                }

                return [permissionKey, data === true];
            })
        );

        state.permissions = Object.fromEntries(permissionResults);

        const hasAccountingAccess = Object.values(state.permissions).some(Boolean);

        if (!hasAccountingAccess) {
            denyAccess('Your account does not have an active Finance permission for this church. Ask your Church Admin to assign or review your Finance role.');
            return false;
        }

        applyPermissionVisibility();

        $('church-context').textContent =
            state.isSuperAdmin && requestedChurchId
                ? `Selected church financial workspace · ${state.churchId}`
                : 'Your church financial workspace';

        $('access-loading')?.classList.add('hidden');
        $('dashboard-content')?.classList.remove('hidden');
        $('refresh-button').disabled = false;

        return true;
    }
    async function readRows(table, columns, configure = () => {}) {
        let query = state.client.from(table).select(columns);
        query = query.eq('church_id', state.churchId);
        query = configure(query);
        const { data, error } = await query;
        if (error) {
            state.errors.push(`${table}: ${error.message}`);
            console.warn(`Accounting dashboard: ${table} query unavailable`, error);
            return { data: [], error };
        }
        return { data: data || [], error: null };
    }

    async function readPendingApprovalCount() {
        const { count, error } = await state.client
            .from('accounting_journals')
            .select('id', { count: 'exact', head: true })
            .eq('church_id', state.churchId)
            .eq('status', 'submitted')
            .eq('approval_required', true);
        if (error) {
            state.errors.push(`Pending approvals: ${error.message}`);
            console.warn('Accounting dashboard: approval count unavailable', error);
            return null;
        }
        return Number(count || 0);
    }

    async function calculatePostedMonthTotals(accounts, settings) {
        const churchDates = churchToday(settings?.timezone_name);
        const startDate = churchDates.monthStart;
        const endDate = churchDates.iso;

        const journalResult = await state.client
            .from('accounting_journals')
            .select('id')
            .eq('church_id', state.churchId)
            .eq('status', 'posted')
            .gte('journal_date', startDate)
            .lte('journal_date', endDate)
            .limit(5000);

        if (journalResult.error) {
            state.errors.push(`Posted journals: ${journalResult.error.message}`);
            return { income: null, expenses: null };
        }

        const journalIds = (journalResult.data || []).map((row) => row.id).filter(Boolean);
        if (!journalIds.length) return { income: 0, expenses: 0 };
        if (!accounts.length) {
            state.errors.push('Income/expense totals: no account records are visible to this user.');
            return { income: null, expenses: null };
        }

        const accountMap = new Map(accounts.map((account) => [account.id, account]));
        let income = 0;
        let expenses = 0;

        // Keep each IN request modest; large churches may have many journals.
        for (let offset = 0; offset < journalIds.length; offset += 100) {
            const batch = journalIds.slice(offset, offset + 100);
            const { data: lines, error } = await state.client
                .from('accounting_journal_lines')
                .select('journal_id, account_id, debit_amount, credit_amount')
                .eq('church_id', state.churchId)
                .in('journal_id', batch);

            if (error) {
                state.errors.push(`Posted journal lines: ${error.message}`);
                return { income: null, expenses: null };
            }

            for (const line of lines || []) {
                const account = accountMap.get(line.account_id);
                if (!account) continue;
                const debit = Number(line.debit_amount || 0);
                const credit = Number(line.credit_amount || 0);
                if (account.account_type === 'income') {
                    income += account.normal_balance === 'debit' ? debit - credit : credit - debit;
                } else if (account.account_type === 'expense') {
                    expenses += account.normal_balance === 'credit' ? credit - debit : debit - credit;
                }
            }
        }

        return {
            income: Math.max(0, income),
            expenses: Math.max(0, expenses),
            startDate,
            endDate,
            currency: settings?.functional_currency || 'UGX'
        };
    }

    function statusBadge(status) {
        const value = String(status || 'unknown').toLowerCase();
        const color = value === 'posted' || value === 'approved' || value === 'journal_created'
            ? 'border-emerald-800 bg-emerald-950/50 text-emerald-300'
            : value === 'submitted' || value === 'requires_review'
                ? 'border-amber-800 bg-amber-950/40 text-amber-200'
                : value === 'voided' || value === 'reversed'
                    ? 'border-rose-900 bg-rose-950/40 text-rose-200'
                    : 'border-slate-700 bg-slate-800 text-slate-300';
        return `<span class="inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${color}">${escapeHtml(value.replaceAll('_', ' '))}</span>`;
    }

    function renderJournals(rows, currency) {
        const target = $('journal-rows');
        if (!rows.length) {
            target.innerHTML = '<tr><td colspan="6" class="py-6 text-center text-slate-400">No recent journals are visible for this church.</td></tr>';
            return;
        }
        target.innerHTML = rows.map((journal) => `
            <tr>
                <td class="font-semibold text-white">${escapeHtml(journal.journal_number || '—')}</td>
                <td class="text-slate-300">${escapeHtml(formatDate(journal.journal_date))}</td>
                <td class="max-w-[260px] truncate text-slate-300" title="${escapeHtml(journal.description || '')}">${escapeHtml(journal.description || '—')}</td>
                <td>${statusBadge(journal.status)}</td>
                <td class="text-right tabular-nums text-slate-300">${escapeHtml(formatMoney(journal.total_debits, currency))}</td>
                <td class="text-right tabular-nums text-slate-300">${escapeHtml(formatMoney(journal.total_credits, currency))}</td>
            </tr>
        `).join('');
    }

    function renderAccounts(rows) {
        const target = $('account-list');
        if (!rows.length) {
            target.innerHTML = '<p class="py-6 text-sm text-slate-400">No active accounts are visible. Check your accounting.accounts.read permission or complete accounting setup.</p>';
            return;
        }
        target.innerHTML = rows.slice(0, 12).map((account) => `
            <div class="flex items-center justify-between gap-3 py-3">
                <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-slate-100">${escapeHtml(account.account_name)}</p>
                    <p class="mt-0.5 text-xs text-slate-500">${escapeHtml(account.account_code)} · ${escapeHtml(account.account_type)} · ${escapeHtml(account.currency_code || 'currency unavailable')}${account.is_monetary_account ? ` · ${escapeHtml(account.monetary_account_kind || 'monetary')}` : ''}</p>
                </div>
                <span class="shrink-0 text-xs text-slate-500">${escapeHtml(account.normal_balance)} normal</span>
            </div>
        `).join('');
        if (rows.length > 12) {
            target.insertAdjacentHTML('beforeend', `<p class="py-3 text-xs text-slate-500">Showing 12 of ${rows.length} active accounts.</p>`);
        }
    }

    function renderFunds(rows) {
        const target = $('fund-list');
        if (!rows.length) {
            target.innerHTML = '<p class="py-6 text-sm text-slate-400">No active funds are visible. Check your accounting.funds.read permission or complete accounting setup.</p>';
            return;
        }
        target.innerHTML = rows.slice(0, 10).map((fund) => `
            <div class="flex items-center justify-between gap-3 py-3">
                <div class="min-w-0">
                    <p class="truncate text-sm font-semibold text-slate-100">${escapeHtml(fund.fund_name)}</p>
                    <p class="mt-0.5 text-xs text-slate-500">${escapeHtml(fund.fund_code)} · ${escapeHtml(fund.fund_type)}</p>
                </div>
                ${fund.is_default ? '<span class="shrink-0 rounded-full border border-blue-800 px-2 py-1 text-xs text-blue-300">Default</span>' : ''}
            </div>
        `).join('');
    }

    function renderReviews(rows, currency) {
        const target = $('review-list');
        if (!rows.length) {
            target.innerHTML = '<p class="py-6 text-sm text-slate-400">No source events requiring review are visible.</p>';
            return;
        }
        target.innerHTML = rows.map((event) => `
            <div class="flex flex-col gap-2 py-4 sm:flex-row sm:items-start sm:justify-between">
                <div class="min-w-0">
                    <p class="text-sm font-semibold text-slate-100">${escapeHtml(event.source_reference || event.event_type || 'Accounting source event')}</p>
                    <p class="mt-1 text-xs text-slate-500">${escapeHtml(event.event_type || '—')} · ${escapeHtml(formatDate(event.created_at))}</p>
                    ${event.error_message ? `<p class="mt-2 text-xs leading-5 text-amber-200/80">${escapeHtml(event.error_message)}</p>` : ''}
                </div>
                <div class="flex shrink-0 items-center gap-2 sm:flex-col sm:items-end">
                    <div class="text-right">
                        <span class="block text-sm font-semibold tabular-nums text-slate-200">Functional: ${escapeHtml(event.functional_amount == null ? 'Not calculated' : formatMoney(event.functional_amount, event.functional_currency || currency))}</span>
                        ${event.source_amount != null ? `<span class="mt-1 block text-[10px] tabular-nums text-slate-500">Source: ${escapeHtml(formatMoney(event.source_amount, event.source_currency || ''))}</span>` : ''}
                    </div>
                    ${statusBadge(event.status)}
                </div>
            </div>
        `).join('');
    }

    function renderCurrentPeriod(periods) {
        const today = churchToday(state.settings?.timezone_name).iso;
        const current = periods.find((period) => period.status === 'open' && period.start_date <= today && period.end_date >= today);
        const target = $('current-period');
        if (!current) {
            target.innerHTML = '<p class="text-sm text-amber-200">No open accounting period currently covers today.</p><p class="mt-2 text-xs text-slate-500">Check the accounting period setup before entering or posting journals.</p>';
            return;
        }
        target.innerHTML = `
            <p class="text-base font-semibold text-white">${escapeHtml(current.period_name || current.period_code)}</p>
            <p class="mt-1 text-sm text-slate-400">${escapeHtml(formatDate(current.start_date))} – ${escapeHtml(formatDate(current.end_date))}</p>
            <span class="mt-3 inline-flex rounded-full border border-emerald-800 bg-emerald-950/40 px-2.5 py-1 text-xs font-semibold text-emerald-300">Open</span>
        `;
    }

    function renderActivity(totals, currency) {
        const income = totals.income;
        const expenses = totals.expenses;
        $('metric-income').textContent = income === null ? 'Unavailable' : formatMoney(income, currency);
        $('metric-expenses').textContent = expenses === null ? 'Unavailable' : formatMoney(expenses, currency);
        $('activity-income').textContent = income === null ? 'Unavailable' : formatMoney(income, currency);
        $('activity-expenses').textContent = expenses === null ? 'Unavailable' : formatMoney(expenses, currency);

        if (income === null || expenses === null) {
            $('activity-caption').textContent = 'Monthly totals could not be loaded. Check your journal and account read permissions.';
            $('income-bar').style.width = '0%';
            $('expenses-bar').style.width = '0%';
            return;
        }
        const total = income + expenses;
        const incomeShare = total > 0 ? (income / total) * 100 : 0;
        const expenseShare = total > 0 ? (expenses / total) * 100 : 0;
        $('income-bar').style.width = `${incomeShare.toFixed(1)}%`;
        $('expenses-bar').style.width = `${expenseShare.toFixed(1)}%`;
        $('activity-caption').textContent = 'Based on posted journals dated from the first day of this month through today. Draft and submitted journals are excluded.';
    }

    async function loadDashboard() {
        state.errors = [];
        $('refresh-button').disabled = true;
        $('refresh-button').textContent = 'Loading…';

        const canReadSettings = hasPermission('accounting.settings.read');
        const canReadPeriods = hasPermission('accounting.periods.read');
        const canReadAccounts = hasPermission('accounting.accounts.read');
        const canReadFunds = hasPermission('accounting.funds.read');
        const canReadJournals = hasPermission('accounting.journals.read');
        const canReadReconciliation = hasPermission('accounting.reconciliation.read');
        const canReadLedger = canReadJournals && canReadAccounts;

        // Hide dashboard components the current Finance role cannot access.
        $('metric-income')?.closest('article')?.classList.toggle('hidden', !canReadLedger);
        $('metric-expenses')?.closest('article')?.classList.toggle('hidden', !canReadLedger);
        $('metric-approvals')?.closest('article')?.classList.toggle('hidden', !canReadJournals);
        $('metric-funds')?.closest('article')?.classList.toggle('hidden', !canReadFunds);
        $('activity-income')?.closest('article')?.classList.toggle('hidden', !canReadLedger);

        try {
            const [
                settingsResult,
                periodsResult,
                accountsResult,
                fundsResult,
                journalsResult,
                sourceEventsResult,
                pendingCount
            ] = await Promise.all([
                canReadSettings
                    ? state.client.from('accounting_settings')
                        .select('functional_currency, reporting_currency, native_multicurrency_journals_enabled, timezone_name, fiscal_year_start_month, setup_completed_at, journal_approval_threshold')
                        .eq('church_id', state.churchId)
                        .maybeSingle()
                    : Promise.resolve({ data: null, error: null }),

                canReadPeriods
                    ? readRows('accounting_periods',
                        'id, period_code, period_name, start_date, end_date, status',
                        (q) => q.eq('status', 'open')
                            .order('start_date', { ascending: false }).limit(24))
                    : Promise.resolve({ data: [], error: null }),

                canReadAccounts
                    ? readRows('accounting_accounts',
                        'id, account_code, account_name, account_type, normal_balance, is_active, currency_code, is_monetary_account, monetary_account_kind',
                        (q) => q.eq('is_active', true)
                            .order('account_code', { ascending: true }).limit(500))
                    : Promise.resolve({ data: [], error: null }),

                canReadFunds
                    ? readRows('accounting_funds',
                        'id, fund_code, fund_name, fund_type, is_default, is_active',
                        (q) => q.eq('is_active', true)
                            .order('fund_code', { ascending: true }).limit(200))
                    : Promise.resolve({ data: [], error: null }),

                canReadJournals
                    ? readRows('accounting_journals',
                        'id, journal_number, journal_date, description, status, total_debits, total_credits, approval_required, created_at',
                        (q) => q.order('created_at', { ascending: false }).limit(8))
                    : Promise.resolve({ data: [], error: null }),

                canReadReconciliation
                    ? readRows('accounting_source_events',
                        'id, event_type, status, source_reference, source_amount, source_currency, functional_amount, functional_currency, error_message, created_at',
                        (q) => q.eq('status', 'requires_review')
                            .order('created_at', { ascending: false }).limit(8))
                    : Promise.resolve({ data: [], error: null }),

                canReadJournals
                    ? readPendingApprovalCount()
                    : Promise.resolve(null)
            ]);

            if (canReadSettings) {
                if (settingsResult.error) {
                    state.errors.push(`Accounting settings: ${settingsResult.error.message}`);
                    console.warn('Accounting dashboard: settings unavailable', settingsResult.error);
                } else if (!settingsResult.data) {
                    state.errors.push('Accounting settings were not returned.');
                }
            }

            state.settings = settingsResult.data || null;
            state.currencyMeta = null;
            if (hasPermission('accounting.currencies.read') && window.BelieversMeetAccountingCurrency?.loadForChurch) {
                try {
                    state.currencyMeta = await window.BelieversMeetAccountingCurrency.loadForChurch({
                        client: state.client, churchId: state.churchId
                    });
                } catch (currencyError) {
                    state.errors.push(`Currency metadata: ${currencyError.message}`);
                    console.warn('Accounting currency metadata unavailable; currency-sensitive entry is disabled.', currencyError);
                }
            }
            state.periods = periodsResult.data;
            state.accounts = accountsResult.data;
            state.funds = fundsResult.data;
            state.journals = journalsResult.data;
            state.sourceEvents = sourceEventsResult.data;

            const currency = state.settings?.functional_currency || null;

            $('currency-label').textContent = canReadSettings
                ? (currency ? `Currency ${currency}` : 'Currency unavailable')
                : 'Currency restricted';

            $('functional-currency').textContent = canReadSettings
                ? (currency || 'Unavailable')
                : 'Not available to this role';

            $('timezone-label').textContent = canReadSettings
                ? (state.settings?.timezone_name || 'Church timezone not available')
                : 'Settings visibility restricted';

            $('metric-funds').textContent = !canReadFunds
                ? 'Restricted'
                : (fundsResult.error ? 'Unavailable' : String(state.funds.length));

            $('metric-approvals').textContent =
                pendingCount === null ? 'Unavailable' : String(pendingCount);

            renderJournals(state.journals, currency);
            renderAccounts(state.accounts);
            renderFunds(state.funds);
            renderReviews(state.sourceEvents, currency);

            if (canReadPeriods) {
                renderCurrentPeriod(state.periods);
            } else {
                $('current-period').innerHTML =
                    '<p class="text-sm text-slate-400">Accounting period details are not available to your Finance role.</p>';
            }

            // Posted ledger totals require both journal and account read access.
            const totals = canReadLedger
                ? await calculatePostedMonthTotals(state.accounts, state.settings)
                : { income: null, expenses: null };

            renderActivity(totals, currency);

            if (state.errors.length) {
                setAlert(
                    'Some sections you are authorized to view could not be loaded. Please check the affected accounting permissions or try refreshing.',
                    'warning'
                );
            } else {
                setAlert(
                    'Dashboard refreshed. Sections and information are limited to your assigned Finance permissions.',
                    'info'
                );
            }

            $('last-updated').textContent =
                `Updated ${new Intl.DateTimeFormat(undefined, {
                    hour: 'numeric',
                    minute: '2-digit'
                }).format(new Date())}`;

        } catch (error) {
            console.error('Accounting dashboard load failed:', error);
            setAlert(
                'The accounting dashboard could not finish loading. Refresh the page or check the browser console for details.',
                'error'
            );
        } finally {
            $('refresh-button').disabled = false;
            $('refresh-button').innerHTML =
                '<span aria-hidden="true">↻</span> Refresh';
        }
    }

    async function logout() {
        if (!state.client) return;
        const { error } = await state.client.auth.signOut();
        if (error) {
            console.error('Accounting page sign-out failed:', error);
            setAlert('Could not sign out. Please try again.', 'error');
            return;
        }
        window.location.replace('login.html');
    }

    async function init() {
        $('logout-button')?.addEventListener('click', logout);
        $('refresh-button')?.addEventListener('click', loadDashboard);

        try {
            const authorized = await authorizePage();
            if (authorized) {
                await loadDashboard();

                const journalModule = window.BelieversMeetAccountingJournals;

                if (journalModule && typeof journalModule.init === 'function') {
                    try {
                        await journalModule.init({
                            client: state.client,
                            userId: state.user.id,
                            churchId: state.churchId,
                            permissions: state.permissions,
                            currency: state.settings?.functional_currency || null,
                            functionalCurrency: state.settings?.functional_currency || null,
                            currencyMeta: state.currencyMeta,
                            nativeMulticurrencyEnabled: state.settings?.native_multicurrency_journals_enabled === true
                        });
                    } catch (journalError) {
                        console.error(
                            'Accounting journal module initialization failed:',
                            journalError
                        );
                    }
                } else {
                    console.error(
                        'Accounting journal module is not loaded. Check accounting.html.'
                    );
                }
                const reconciliationModule = window.BelieversMeetAccountingReconciliation;

                if (reconciliationModule && typeof reconciliationModule.init === 'function') {
                    try {
                        await reconciliationModule.init({
                            client: state.client,
                            userId: state.user.id,
                            churchId: state.churchId,
                            permissions: state.permissions,
                            currency: state.settings?.functional_currency || null,
                            functionalCurrency: state.settings?.functional_currency || null,
                            currencyMeta: state.currencyMeta
                        });
                    } catch (reconciliationError) {
                        console.error(
                            'Accounting reconciliation module initialization failed:',
                            reconciliationError
                        );
                    }
                } else {
                    console.error(
                        'Accounting reconciliation module is not loaded. Check accounting.html.'
                    );
                }
                const exchangeRateModule = window.BelieversMeetAccountingExchangeRates;

                if (exchangeRateModule && typeof exchangeRateModule.init === 'function') {
                    try {
                        await exchangeRateModule.init({
                            client: state.client,
                            userId: state.user.id,
                            churchId: state.churchId,
                            permissions: state.permissions,
                            functionalCurrency: state.settings?.functional_currency || null,
                            reportingCurrency: state.settings?.reporting_currency || null,
                            currencyMeta: state.currencyMeta
                        });
                    } catch (exchangeRateError) {
                        console.error(
                            'Accounting exchange-rate module initialization failed:',
                            exchangeRateError
                        );
                    }
                } else {
                    console.error(
                        'Accounting exchange-rate module is not loaded. Check accounting.html.'
                    );
                }
                const reportsModule = window.BelieversMeetAccountingReports;
                if (reportsModule && typeof reportsModule.init === 'function') {
                    try {
                        await reportsModule.init({
                            client: state.client,
                            userId: state.user.id,
                            churchId: state.churchId,
                            permissions: state.permissions,
                            currency: state.settings?.functional_currency || null,
                            functionalCurrency: state.settings?.functional_currency || null,
                            currencyMeta: state.currencyMeta,
                            timezoneName: state.settings?.timezone_name || null,
                            fiscalYearStartMonth: state.settings?.fiscal_year_start_month || 1
                        });
                    } catch (reportsError) {
                        console.error('Accounting reports module initialization failed:', reportsError);
                    }
                } else {
                    console.error('Accounting reports module is not loaded. Check accounting.html.');
                }
                const incomeExpenditureModule = window.BelieversMeetAccountingIncomeExpenditure;
                if (incomeExpenditureModule && typeof incomeExpenditureModule.init === 'function') {
                    try {
                        await incomeExpenditureModule.init({
                            client: state.client,
                            userId: state.user.id,
                            churchId: state.churchId,
                            permissions: state.permissions,
                            currency: state.settings?.functional_currency || null,
                            functionalCurrency: state.settings?.functional_currency || null,
                            currencyMeta: state.currencyMeta,
                            timezoneName: state.settings?.timezone_name || null,
                            fiscalYearStartMonth: state.settings?.fiscal_year_start_month || 1
                        });
                    } catch (incomeExpenditureError) {
                        console.error('Income & Expenditure module initialization failed:', incomeExpenditureError);
                    }
                } else {
                    console.error('Income & Expenditure module is not loaded. Check accounting.html.');
                }
                const financialPositionModule = window.BelieversMeetAccountingFinancialPosition;
                if (financialPositionModule && typeof financialPositionModule.init === 'function') {
                    try {
                        await financialPositionModule.init({
                            client: state.client,
                            userId: state.user.id,
                            churchId: state.churchId,
                            permissions: state.permissions,
                            currency: state.settings?.functional_currency || null,
                            functionalCurrency: state.settings?.functional_currency || null,
                            currencyMeta: state.currencyMeta,
                            timezoneName: state.settings?.timezone_name || null
                        });
                    } catch (financialPositionError) {
                        console.error('Statement of Financial Position module initialization failed:', financialPositionError);
                    }
                } else {
                    console.error('Statement of Financial Position module is not loaded. Check accounting.html.');
                }
                const fxValuationModule = window.BelieversMeetAccountingFxValuation;

                if (fxValuationModule && typeof fxValuationModule.init === 'function') {
                    try {
                        await fxValuationModule.init({
                            client: state.client,
                            userId: state.user.id,
                            churchId: state.churchId,
                            permissions: state.permissions,
                            functionalCurrency: state.settings?.functional_currency || null,
                            nativeMulticurrencyEnabled: state.settings?.native_multicurrency_journals_enabled === true,
                            currencyMeta: state.currencyMeta
                        });
                    } catch (fxValuationError) {
                        console.error(
                            'Accounting FX valuation module initialization failed:',
                            fxValuationError
                        );
                    }
                } else {
                    console.error(
                        'Accounting FX valuation module is not loaded. Check accounting.html.'
                    );
                }
            }
        } catch (error) {
            console.error('Accounting page initialization failed:', error);
            denyAccess(error.message || 'The accounting page could not initialize securely.');
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init, { once: true });
    } else {
        init();
    }
})();
