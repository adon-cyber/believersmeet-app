/*
 * BelieversMeet Accounting — maker/checker exchange-rate workspace.
 * Reads the protected exchange-rate table through RLS and performs every
 * mutation through the reviewed Phase 2 RPCs. Rates are directional:
 * quote currency units per one base currency unit. Never invert implicitly.
 */
(() => {
    'use strict';

    const state = {
        client: null,
        userId: null,
        churchId: null,
        permissions: {},
        currencyMeta: null,
        functionalCurrency: null,
        reportingCurrency: null,
        monetaryAccounts: [],
        rows: [],
        offset: 0,
        pageSize: 50,
        total: 0,
        busy: false,
        mode: 'create',
        selected: null
    };

    const TABLE_COLUMNS = [
        'id', 'church_id', 'base_currency', 'quote_currency', 'effective_date',
        'rate_type', 'rate_value', 'rate_source', 'source_reference', 'notes',
        'revision_no', 'supersedes_rate_id', 'change_reason', 'status',
        'created_by', 'created_at', 'approved_by', 'approved_at', 'updated_at'
    ].join(',');

    const hasPermission = (key) => state.permissions[key] === true;
    const root = () => document.getElementById('exchange-rate-workspace');

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    }

    function localDate() {
        const now = new Date();
        return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    }

    function rateText(value) {
        const raw = String(value ?? '').trim();
        if (!raw) return '—';
        const match = /^(\d+)(?:\.(\d+))?$/.exec(raw);
        if (!match) return raw;
        const integer = match[1].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
        return `${integer}${match[2] ? `.${match[2]}` : ''}`;
    }

    function validateRate(rawValue) {
        const value = String(rawValue ?? '').trim();
        // NUMERIC(28,12): at most 16 integer digits and 12 fractional digits.
        if (!/^(?:0|[1-9]\d{0,15})(?:\.\d{1,12})?$/.test(value)) {
            throw new Error('Enter a positive rate with no more than 16 integer digits and 12 decimal places. Do not use commas or scientific notation.');
        }
        const [whole, fraction = ''] = value.split('.');
        if (BigInt(whole) === 0n && !/[1-9]/.test(fraction)) {
            throw new Error('The exchange rate must be greater than zero.');
        }
        return value;
    }

    function currencyOptions(selected = '') {
        const options = state.currencyMeta?.options?.({ enabledOnly: true }) || [];
        return options.map((item) => `<option value="${escapeHtml(item.currencyCode)}" ${item.currencyCode === selected ? 'selected' : ''}>${escapeHtml(item.currencyCode)} — ${escapeHtml(item.currencyName || item.currencyCode)}</option>`).join('');
    }

    function setMessage(message, type = 'info') {
        const host = root()?.querySelector('[data-rate-message]');
        if (!host) return;
        const styles = {
            info: 'border-slate-700 bg-slate-900/70 text-slate-300',
            success: 'border-emerald-800 bg-emerald-950/30 text-emerald-200',
            warning: 'border-amber-800 bg-amber-950/30 text-amber-200',
            error: 'border-rose-800 bg-rose-950/30 text-rose-200'
        };
        host.className = `mb-4 rounded-lg border px-4 py-3 text-sm ${styles[type] || styles.info}`;
        host.textContent = message;
        host.hidden = !message;
    }

    function contextMarkup(rate) {
        return `<div class="rounded-lg border border-slate-700 bg-slate-900/60 p-3 text-sm text-slate-300">
            <div class="font-semibold text-white">${escapeHtml(rate.base_currency)} → ${escapeHtml(rate.quote_currency)}</div>
            <div class="mt-1">${escapeHtml(rate.effective_date)} · ${escapeHtml(rate.rate_type)} · revision ${escapeHtml(rate.revision_no)}</div>
            <p class="mt-2 text-xs text-slate-500">Identity is immutable. A correction appends a new revision; it never edits this approved record.</p>
        </div>`;
    }

    function formMarkup() {
        const selected = state.selected;
        const mode = state.mode;
        const isCreate = mode === 'create';
        const isEdit = mode === 'edit';
        const isCorrection = mode === 'correct';
        const defaultBase = selected?.base_currency || state.functionalCurrency || '';
        const defaultQuote = selected?.quote_currency || (state.currencyMeta?.options?.({ enabledOnly: true }) || []).find((c) => c.currencyCode !== defaultBase)?.currencyCode || '';
        const title = isCreate ? 'Propose exchange rate' : isEdit ? 'Amend your draft rate' : 'Append rate correction';
        const saveLabel = isCreate ? 'Create draft' : isEdit ? 'Save draft changes' : 'Create correction draft';

        return `<div class="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
            <div class="mb-4 flex items-start justify-between gap-3">
                <div><p class="text-xs font-bold uppercase tracking-widest text-slate-400">Maker / checker</p><h3 class="mt-1 text-base font-bold text-white">${title}</h3></div>
                ${!isCreate ? '<button type="button" data-rate-action="cancel-form" class="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-300 hover:bg-slate-800">Close</button>' : ''}
            </div>
            <form id="exchange-rate-form" data-mode="${mode}" class="space-y-3">
                ${isCreate ? `<div class="grid gap-3 sm:grid-cols-2">
                    <label class="block text-xs font-semibold text-slate-300">Base currency
                        <select name="base_currency" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white">${currencyOptions(defaultBase)}</select>
                    </label>
                    <label class="block text-xs font-semibold text-slate-300">Quote currency
                        <select name="quote_currency" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white">${currencyOptions(defaultQuote)}</select>
                    </label>
                    <label class="block text-xs font-semibold text-slate-300">Effective date
                        <input name="effective_date" type="date" required value="${localDate()}" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white">
                    </label>
                    <label class="block text-xs font-semibold text-slate-300">Rate type
                        <select name="rate_type" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white"><option value="spot">Spot</option><option value="closing">Closing</option><option value="historical">Historical</option></select>
                    </label>
                </div>` : contextMarkup(selected)}
                <label class="block text-xs font-semibold text-slate-300">Rate value <span class="font-normal text-slate-500">(quote units for 1 base unit; up to 12 decimal places)</span>
                    <input name="rate_value" type="text" inputmode="decimal" autocomplete="off" required value="${escapeHtml(isCreate ? '' : selected.rate_value)}" placeholder="e.g. 3825.125" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white" maxlength="29">
                </label>
                <label class="block text-xs font-semibold text-slate-300">Rate source
                    <input name="rate_source" type="text" required minlength="2" maxlength="100" value="${escapeHtml(isCreate ? '' : selected.rate_source)}" placeholder="e.g. Bank of Uganda, bank statement, approved provider" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white">
                </label>
                <label class="block text-xs font-semibold text-slate-300">Source reference <span class="font-normal text-slate-500">(optional, max 500 characters)</span>
                    <input name="source_reference" type="text" maxlength="500" value="${escapeHtml(isCreate ? '' : selected.source_reference || '')}" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white">
                </label>
                ${isCorrection ? `<label class="block text-xs font-semibold text-slate-300">Correction reason <span class="font-normal text-slate-500">(required, 10–500 characters)</span>
                    <textarea name="reason" required minlength="10" maxlength="500" rows="2" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white" placeholder="Explain why the approved rate must be corrected."></textarea>
                </label>` : ''}
                <label class="block text-xs font-semibold text-slate-300">Notes <span class="font-normal text-slate-500">(optional, max 2,000 characters)</span>
                    <textarea name="notes" maxlength="2000" rows="2" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white">${escapeHtml(isCreate ? '' : selected.notes || '')}</textarea>
                </label>
                <div class="flex flex-wrap items-center gap-2 pt-1">
                    <button type="submit" class="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">${saveLabel}</button>
                    <span class="text-xs text-slate-500">Approval must be performed by a different authorized user.</span>
                </div>
            </form>
        </div>`;
    }

    function rowActions(row) {
        const actions = [];
        if (row.status === 'draft' && row.created_by === state.userId && hasPermission('accounting.exchange_rates.manage')) {
            actions.push(`<button type="button" data-rate-action="edit" data-rate-id="${escapeHtml(row.id)}" class="rounded-md border border-slate-600 px-2.5 py-1.5 text-xs font-semibold text-slate-200 hover:bg-slate-700">Edit draft</button>`);
        }
        if (row.status === 'draft' && row.created_by !== state.userId && hasPermission('accounting.exchange_rates.approve')) {
            actions.push(`<button type="button" data-rate-action="approve" data-rate-id="${escapeHtml(row.id)}" class="rounded-md border border-emerald-800 px-2.5 py-1.5 text-xs font-semibold text-emerald-200 hover:bg-emerald-950/50">Approve</button>`);
        }
        const hasApprovedOrDraftChild = state.rows.some((candidate) => candidate.supersedes_rate_id === row.id);
        if (row.status === 'approved' && !hasApprovedOrDraftChild && hasPermission('accounting.exchange_rates.manage')) {
            actions.push(`<button type="button" data-rate-action="correct" data-rate-id="${escapeHtml(row.id)}" class="rounded-md border border-amber-800 px-2.5 py-1.5 text-xs font-semibold text-amber-200 hover:bg-amber-950/50">Correct</button>`);
        }
        return actions.length ? `<div class="flex flex-wrap gap-2">${actions.join('')}</div>` : '<span class="text-xs text-slate-500">No action</span>';
    }

    function renderCurrencySetup() {
        const host = root()?.querySelector('[data-currency-setup]');
        if (!host) return;
        const allCurrencies = state.currencyMeta?.options?.({ enabledOnly: false }) || [];
        const enabledCurrencies = allCurrencies.filter((item) => state.currencyMeta.isEnabled(item.currencyCode));
        const availableCurrencies = allCurrencies.filter((item) => !state.currencyMeta.isEnabled(item.currencyCode));
        const canManageCurrencies = hasPermission('accounting.currencies.manage');
        const canSetReporting = hasPermission('accounting.settings.manage');
        host.innerHTML = `<div class="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
            <div class="mb-4"><p class="text-xs font-bold uppercase tracking-widest text-slate-400">Church currency configuration</p><h3 class="mt-1 text-base font-bold text-white">Enabled currencies</h3>
                <p class="mt-1 text-sm text-slate-400">The functional currency is the immutable ledger and budget basis. Native currencies may be enabled for supported monetary cash, bank and mobile-money accounts. Reporting currency is optional and does not change posted ledger amounts.</p>
            </div>
            <div class="mb-4 grid gap-3 sm:grid-cols-2">
                <div class="rounded-lg border border-slate-800 bg-slate-950/50 p-3"><p class="text-xs text-slate-500">Functional currency · locked</p><p class="mt-1 text-lg font-bold text-white">${escapeHtml(state.functionalCurrency || 'Unavailable')}</p><p class="mt-1 text-xs text-slate-500">Changing this requires a separate formal translation project.</p></div>
                <div class="rounded-lg border border-slate-800 bg-slate-950/50 p-3"><p class="text-xs text-slate-500">Reporting currency · optional</p><p class="mt-1 text-lg font-bold text-white">${escapeHtml(state.reportingCurrency || 'Not set')}</p><p class="mt-1 text-xs text-slate-500">Reporting translation is not yet applied to dashboard totals or budgets.</p></div>
            </div>
            ${canManageCurrencies ? `<div class="mb-4 flex flex-col gap-2 sm:flex-row sm:items-end"><label class="flex-1 text-xs font-semibold text-slate-300">Enable an ISO currency
                <select id="rate-currency-enable" ${availableCurrencies.length ? '' : 'disabled'} class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white"><option value="">${availableCurrencies.length ? 'Choose a supported currency' : 'All supported currencies are enabled'}</option>${availableCurrencies.map((item) => `<option value="${escapeHtml(item.currencyCode)}">${escapeHtml(item.currencyCode)} — ${escapeHtml(item.currencyName || item.currencyCode)} (${item.minorUnit == null ? 'precision unavailable' : `${item.minorUnit} decimals`})</option>`).join('')}</select>
            </label><button type="button" data-rate-action="enable-currency" ${availableCurrencies.length ? '' : 'disabled'} class="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">Enable currency</button></div>` : ''}
            <div class="overflow-hidden rounded-lg border border-slate-800"><div class="bm-scroll overflow-x-auto"><table class="min-w-full text-sm"><thead class="bg-slate-950/80 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th class="px-3 py-2">Currency</th><th class="px-3 py-2">ISO minor unit</th><th class="px-3 py-2">Role</th><th class="px-3 py-2">Status</th><th class="px-3 py-2">Action</th></tr></thead><tbody>${enabledCurrencies.map((item) => {
                const isFunctional = item.currencyCode === state.functionalCurrency;
                const isReporting = item.currencyCode === state.reportingCurrency;
                return `<tr class="border-t border-slate-800"><td class="px-3 py-2"><span class="font-semibold text-white">${escapeHtml(item.currencyCode)}</span><span class="ml-2 text-xs text-slate-400">${escapeHtml(item.currencyName || '')}</span></td><td class="px-3 py-2 text-slate-300">${item.minorUnit == null ? 'N/A' : `${escapeHtml(item.minorUnit)} decimals`}</td><td class="px-3 py-2 text-slate-300">${isFunctional ? 'Functional · locked' : isReporting ? 'Reporting' : 'Additional/native'}</td><td class="px-3 py-2"><span class="rounded-full border border-emerald-800 px-2 py-1 text-xs text-emerald-200">Enabled</span></td><td class="px-3 py-2">${canManageCurrencies && !isFunctional && !isReporting ? `<button type="button" data-rate-action="disable-currency" data-currency-code="${escapeHtml(item.currencyCode)}" class="rounded-md border border-rose-900 px-2.5 py-1.5 text-xs font-semibold text-rose-200 hover:bg-rose-950/40">Disable</button>` : '<span class="text-xs text-slate-500">Protected</span>'}</td></tr>`;
            }).join('')}</tbody></table></div></div>
            ${canSetReporting ? `<div class="mt-4 flex flex-col gap-2 sm:flex-row sm:items-end"><label class="flex-1 text-xs font-semibold text-slate-300">Optional reporting currency
                <select id="rate-reporting-currency" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white"><option value="">No reporting currency</option>${enabledCurrencies.map((item) => `<option value="${escapeHtml(item.currencyCode)}" ${item.currencyCode === state.reportingCurrency ? 'selected' : ''}>${escapeHtml(item.currencyCode)} — ${escapeHtml(item.currencyName || item.currencyCode)}</option>`).join('')}</select>
            </label><button type="button" data-rate-action="save-reporting-currency" class="rounded-lg border border-slate-600 px-4 py-2.5 text-sm font-semibold text-slate-200 hover:bg-slate-800">Save reporting setting</button></div>` : ''}
            <p class="mt-3 text-xs leading-5 text-slate-500">Currency enablement is separate from payment-provider support. Enabling an ISO currency does not imply Pesapal or any other provider can charge or settle it. Disabling is blocked by server-side history and native-account safeguards.</p>
        </div><div data-native-account-setup-host class="mt-5"></div>`;
        renderMonetaryAccountSetup();
    }

    function renderMonetaryAccountSetup() {
        const host = root()?.querySelector('[data-native-account-setup-host]');
        if (!host) return;
        const canConfigure = hasPermission('accounting.accounts.currency.manage');
        const accountOptions = state.monetaryAccounts.map((account) => {
            const label = `${account.account_code} — ${account.account_name} · ${account.currency_code || '—'}${account.is_monetary_account ? ` · ${account.monetary_account_kind}` : ''}`;
            return `<option value="${escapeHtml(account.id)}">${escapeHtml(label)}</option>`;
        }).join('');
        host.innerHTML = `<div class="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
            <div class="mb-4"><p class="text-xs font-bold uppercase tracking-widest text-slate-400">Ledger account denomination</p><h3 class="mt-1 text-base font-bold text-white">Configure cash, bank and mobile-money accounts</h3>
                <p class="mt-1 text-sm leading-6 text-slate-400">Only active, debit-normal, direct-posting asset accounts can be designated as monetary cash, bank or mobile-money accounts. A foreign denomination is not allowed for income, expense, equity, receivable, payable or fixed-asset accounts.</p></div>
            ${canConfigure ? `<form data-monetary-account-form class="grid gap-3 lg:grid-cols-2">
                <label class="block text-xs font-semibold text-slate-300">Eligible ledger account
                    <select name="account_id" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white"><option value="">Choose an account</option>${accountOptions}</select>
                </label>
                <label class="block text-xs font-semibold text-slate-300">Native currency
                    <select name="currency_code" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white"><option value="">Choose an enabled currency</option>${currencyOptions()}</select>
                </label>
                <label class="block text-xs font-semibold text-slate-300">Monetary account type
                    <select name="monetary_kind" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white"><option value="">Choose account type</option><option value="cash">Cash</option><option value="bank">Bank</option><option value="mobile_money">Mobile money</option></select>
                </label>
                <label class="block text-xs font-semibold text-slate-300">Reason <span class="font-normal text-slate-500">(10–500 characters)</span>
                    <textarea name="reason" required minlength="10" maxlength="500" rows="2" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white" placeholder="Reason for configuring this account denomination…"></textarea>
                </label>
                <div class="lg:col-span-2"><button type="submit" ${state.monetaryAccounts.length ? '' : 'disabled'} class="rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">Save monetary account configuration</button></div>
            </form>` : '<p class="text-sm text-slate-400">Your role does not have permission to configure ledger account currencies.</p>'}
            <div class="mt-4 overflow-hidden rounded-lg border border-slate-800"><div class="bm-scroll overflow-x-auto"><table class="min-w-full text-sm"><thead class="bg-slate-950/80 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th class="px-3 py-2">Account</th><th class="px-3 py-2">Native currency</th><th class="px-3 py-2">Classification</th><th class="px-3 py-2">Eligibility</th></tr></thead><tbody>${state.monetaryAccounts.map((account) => `<tr class="border-t border-slate-800"><td class="px-3 py-2"><span class="font-semibold text-white">${escapeHtml(account.account_code)}</span><span class="ml-2 text-slate-400">${escapeHtml(account.account_name)}</span></td><td class="px-3 py-2 text-slate-300">${escapeHtml(account.currency_code || '—')}</td><td class="px-3 py-2 text-slate-300">${account.is_monetary_account ? escapeHtml(account.monetary_account_kind || 'monetary') : 'Not configured'}</td><td class="px-3 py-2 text-xs text-slate-400">Active · asset · debit-normal · direct posting</td></tr>`).join('') || '<tr><td colspan="4" class="px-3 py-4 text-center text-slate-500">No eligible asset accounts are currently visible.</td></tr>'}</tbody></table></div></div>
            <p class="mt-3 text-xs leading-5 text-slate-500">The server blocks denomination changes after journal history exists. Configure a new ledger subaccount instead. Every change is audited; the browser does not write directly to the accounts table. Reload this page after saving so journal and reconciliation account selectors refresh.</p>
        </div>`;
    }

    async function loadMonetaryAccounts() {
        if (!hasPermission('accounting.accounts.read')) {
            state.monetaryAccounts = [];
            renderMonetaryAccountSetup();
            return;
        }
        const { data, error } = await state.client.from('accounting_accounts')
            .select('id,account_code,account_name,account_type,normal_balance,allow_direct_posting,is_active,currency_code,is_monetary_account,monetary_account_kind')
            .eq('church_id', state.churchId)
            .eq('is_active', true)
            .eq('account_type', 'asset')
            .eq('normal_balance', 'debit')
            .eq('allow_direct_posting', true)
            .order('account_code', { ascending: true })
            .limit(500);
        if (error) throw new Error(`Eligible monetary accounts could not be loaded: ${error.message}`);
        state.monetaryAccounts = Array.isArray(data) ? data : [];
        renderMonetaryAccountSetup();
    }

    async function configureMonetaryAccount(form) {
        if (!hasPermission('accounting.accounts.currency.manage')) throw new Error('You do not have permission to configure native ledger-account currencies.');
        const values = new FormData(form);
        const accountId = String(values.get('account_id') || '');
        const currency = String(values.get('currency_code') || '').toUpperCase();
        const kind = String(values.get('monetary_kind') || '').toLowerCase();
        const reason = String(values.get('reason') || '').trim();
        if (!accountId || !currency || !['cash', 'bank', 'mobile_money'].includes(kind)) throw new Error('Choose an eligible account, enabled currency and valid monetary account type.');
        if (!state.currencyMeta?.isEnabled(currency)) throw new Error('The selected currency is not enabled for this church.');
        if (reason.length < 10 || reason.length > 500) throw new Error('Reason must contain 10–500 characters.');
        const account = state.monetaryAccounts.find((item) => item.id === accountId);
        if (!account) throw new Error('The selected account is no longer eligible. Refresh and try again.');
        if (!window.confirm(`Configure ${account.account_code} — ${account.account_name} as ${kind.replaceAll('_', ' ')} in ${currency}? If it has journal history, the server will prevent changing its denomination.`)) return;
        const { error } = await state.client.rpc('accounting_configure_monetary_account', {
            p_church_id: state.churchId,
            p_account_id: accountId,
            p_currency_code: currency,
            p_monetary_kind: kind,
            p_reason: reason
        });
        if (error) throw new Error(error.message);
        await loadMonetaryAccounts();
        setMessage(`Account ${account.account_code} was configured as ${kind.replaceAll('_', ' ')} in ${currency}. Reload this page to refresh journal and reconciliation account selectors.`, 'success');
    }

    async function refreshCurrencySetup() {
        state.currencyMeta = await window.BelieversMeetAccountingCurrency.loadForChurch({
            client: state.client, churchId: state.churchId, force: true
        });
        renderCurrencySetup();
    }

    async function manageCurrency(action, button) {
        if (action === 'enable-currency') {
            if (!hasPermission('accounting.currencies.manage')) throw new Error('You do not have permission to enable church currencies.');
            const code = String(root()?.querySelector('#rate-currency-enable')?.value || '').toUpperCase();
            if (!code || state.currencyMeta.isEnabled(code)) throw new Error('Choose a currently disabled platform-supported currency.');
            const reason = window.prompt(`Why should ${code} be enabled for this church? (10–500 characters)`);
            if (!reason) return;
            if (reason.trim().length < 10 || reason.trim().length > 500) throw new Error('Reason must contain 10–500 characters.');
            const { error } = await state.client.rpc('accounting_enable_church_currency', {
                p_church_id: state.churchId, p_currency_code: code, p_reason: reason.trim()
            });
            if (error) throw new Error(error.message);
            await refreshCurrencySetup();
            setMessage(`${code} is now enabled for this church. This does not enable provider payments in that currency. Reload this browser page to refresh currency metadata in the journal, budget and reconciliation workspaces.`, 'success');
        } else if (action === 'disable-currency') {
            if (!hasPermission('accounting.currencies.manage')) throw new Error('You do not have permission to disable church currencies.');
            const code = String(button.dataset.currencyCode || '').toUpperCase();
            if (!code || code === state.functionalCurrency || code === state.reportingCurrency) throw new Error('The functional and current reporting currencies cannot be disabled.');
            const reason = window.prompt(`Why should ${code} be disabled? The server will block this if accounting history or native accounts still depend on it. (10–500 characters)`);
            if (!reason) return;
            if (reason.trim().length < 10 || reason.trim().length > 500) throw new Error('Reason must contain 10–500 characters.');
            const { error } = await state.client.rpc('accounting_disable_church_currency', {
                p_church_id: state.churchId, p_currency_code: code, p_reason: reason.trim()
            });
            if (error) throw new Error(error.message);
            await refreshCurrencySetup();
            setMessage(`${code} has been disabled for new church accounting activity. Reload this browser page to refresh currency metadata in the journal, budget and reconciliation workspaces.`, 'success');
        } else if (action === 'save-reporting-currency') {
            if (!hasPermission('accounting.settings.manage')) throw new Error('You do not have permission to change reporting-currency settings.');
            const code = String(root()?.querySelector('#rate-reporting-currency')?.value || '').toUpperCase() || null;
            if (code && !state.currencyMeta.isEnabled(code)) throw new Error('The reporting currency must already be enabled for this church.');
            if (code === state.reportingCurrency) { setMessage('The reporting-currency setting has not changed.', 'info'); return; }
            const reason = window.prompt(`Why should the reporting currency be ${code || 'cleared'}? (10–500 characters)`);
            if (!reason) return;
            if (reason.trim().length < 10 || reason.trim().length > 500) throw new Error('Reason must contain 10–500 characters.');
            const { error } = await state.client.rpc('accounting_update_reporting_currency', {
                p_church_id: state.churchId, p_reporting_currency: code, p_reason: reason.trim()
            });
            if (error) throw new Error(error.message);
            state.reportingCurrency = code;
            renderCurrencySetup();
            setMessage(`Reporting currency ${code || 'cleared'}. This setting does not alter functional ledger or budget values. Reload this browser page to refresh accounting settings.`, 'success');
        }
    }

    function renderRows() {
        const tbody = root()?.querySelector('[data-rate-rows]');
        if (!tbody) return;
        if (!state.rows.length) {
            tbody.innerHTML = '<tr><td colspan="8" class="px-4 py-8 text-center text-sm text-slate-500">No exchange-rate records are visible for this church.</td></tr>';
        } else {
            tbody.innerHTML = state.rows.map((row) => `<tr>
                <td><div class="font-semibold text-white">${escapeHtml(row.base_currency)} → ${escapeHtml(row.quote_currency)}</div><div class="mt-1 text-xs text-slate-500">${escapeHtml(row.rate_type)}</div></td>
                <td class="font-mono text-sm text-slate-200">${escapeHtml(rateText(row.rate_value))}</td>
                <td>${escapeHtml(row.effective_date)}</td>
                <td><span class="rounded-full border ${row.status === 'approved' ? 'border-emerald-800 text-emerald-200' : 'border-amber-800 text-amber-200'} px-2 py-1 text-xs font-semibold">${escapeHtml(row.status)}</span><div class="mt-1 text-xs text-slate-500">Rev ${escapeHtml(row.revision_no)}</div></td>
                <td>${escapeHtml(row.rate_source)}</td>
                <td><div class="text-xs text-slate-300">${escapeHtml(row.created_by === state.userId ? 'You' : 'Other maker')}</div><div class="mt-1 text-xs text-slate-500">${row.approved_at ? `Approved ${escapeHtml(new Date(row.approved_at).toLocaleDateString())} · checker ${escapeHtml(String(row.approved_by || '').slice(0, 8))}` : 'Awaiting approval'}</div></td>
                <td>${row.supersedes_rate_id ? `<span class="text-xs text-slate-400">Correction of ${escapeHtml(row.supersedes_rate_id.slice(0, 8))}</span>` : '<span class="text-xs text-slate-500">Original</span>'}${row.change_reason ? `<p class="mt-1 max-w-xs whitespace-normal text-xs text-slate-500">${escapeHtml(row.change_reason)}</p>` : ''}</td>
                <td>${rowActions(row)}</td>
            </tr>`).join('');
        }
        const count = root()?.querySelector('[data-rate-count]');
        if (count) count.textContent = `Showing ${state.rows.length} of ${state.total} rate record${state.total === 1 ? '' : 's'}`;
        const more = root()?.querySelector('[data-rate-action="load-more"]');
        if (more) more.hidden = state.rows.length >= state.total;
    }

    async function loadRates({ reset = true } = {}) {
        if (reset) {
            state.offset = 0;
            state.rows = [];
        }
        const { data, error, count } = await state.client.from('accounting_exchange_rates')
            .select(TABLE_COLUMNS, { count: 'exact' })
            .eq('church_id', state.churchId)
            .order('effective_date', { ascending: false })
            .order('revision_no', { ascending: false })
            .order('created_at', { ascending: false })
            .range(state.offset, state.offset + state.pageSize - 1);
        if (error) throw new Error(`Exchange-rate history could not be loaded: ${error.message}`);
        const batch = Array.isArray(data) ? data : [];
        state.rows = reset ? batch : state.rows.concat(batch);
        state.total = Number(count ?? state.rows.length);
        renderRows();
    }

    function openForm(mode, row = null) {
        state.mode = mode;
        state.selected = row;
        const host = root()?.querySelector('[data-rate-form-host]');
        if (!host) return;
        host.innerHTML = formMarkup();
        host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function submitForm(form) {
        const formData = new FormData(form);
        const mode = form.dataset.mode;
        const rateValue = validateRate(formData.get('rate_value'));
        const source = String(formData.get('rate_source') || '').trim();
        const reference = String(formData.get('source_reference') || '').trim() || null;
        const notes = String(formData.get('notes') || '').trim() || null;
        if (source.length < 2 || source.length > 100) throw new Error('Rate source must contain 2–100 characters.');
        if (reference && reference.length > 500) throw new Error('Source reference cannot exceed 500 characters.');
        if (notes && notes.length > 2000) throw new Error('Notes cannot exceed 2,000 characters.');

        if (mode === 'create') {
            const base = String(formData.get('base_currency') || '').toUpperCase();
            const quote = String(formData.get('quote_currency') || '').toUpperCase();
            const effectiveDate = String(formData.get('effective_date') || '');
            const rateType = String(formData.get('rate_type') || '');
            if (!state.currencyMeta?.isEnabled(base) || !state.currencyMeta?.isEnabled(quote)) throw new Error('Both currencies must be enabled for this church.');
            if (base === quote) throw new Error('Base and quote currencies must be different.');
            const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(effectiveDate);
            const dateRoundTrip = dateParts ? new Date(Number(dateParts[1]), Number(dateParts[2]) - 1, Number(dateParts[3])) : null;
            if (!dateParts || !dateRoundTrip || dateRoundTrip.getFullYear() !== Number(dateParts[1])
                || dateRoundTrip.getMonth() !== Number(dateParts[2]) - 1
                || dateRoundTrip.getDate() !== Number(dateParts[3])) throw new Error('Choose a valid effective date.');
            if (!['spot', 'closing', 'historical'].includes(rateType)) throw new Error('Choose a valid rate type.');
            const { error } = await state.client.rpc('accounting_create_exchange_rate', {
                p_church_id: state.churchId,
                p_base_currency: base,
                p_quote_currency: quote,
                p_effective_date: effectiveDate,
                p_rate_type: rateType,
                p_rate: rateValue,
                p_rate_source: source,
                p_source_reference: reference,
                p_notes: notes
            });
            if (error) throw new Error(error.message);
            setMessage('Exchange-rate draft created. A different authorized approver must approve it before it can be used.', 'success');
        } else if (mode === 'edit') {
            const { error } = await state.client.rpc('accounting_update_draft_exchange_rate', {
                p_rate_id: state.selected.id,
                p_rate: rateValue,
                p_rate_source: source,
                p_source_reference: reference,
                p_notes: notes
            });
            if (error) throw new Error(error.message);
            setMessage('Your draft exchange rate was updated. Its pair, effective date and type remain unchanged.', 'success');
        } else if (mode === 'correct') {
            const reason = String(formData.get('reason') || '').trim();
            if (reason.length < 10 || reason.length > 500) throw new Error('Correction reason must contain 10–500 characters.');
            const { error } = await state.client.rpc('accounting_correct_exchange_rate', {
                p_rate_id: state.selected.id,
                p_corrected_rate: rateValue,
                p_rate_source: source,
                p_source_reference: reference,
                p_reason: reason,
                p_notes: notes
            });
            if (error) throw new Error(error.message);
            setMessage('A correction draft was appended. The approved parent remains unchanged; independent approval is required.', 'success');
        } else {
            throw new Error('Unknown exchange-rate form operation.');
        }
        openForm('create');
        await loadRates();
    }

    async function approveRate(id) {
        const row = state.rows.find((item) => item.id === id);
        if (!row || row.status !== 'draft' || row.created_by === state.userId) throw new Error('This rate is not eligible for your independent approval.');
        if (!window.confirm(`Approve ${row.base_currency} → ${row.quote_currency} at ${rateText(row.rate_value)} effective ${row.effective_date}?`)) return;
        const { error } = await state.client.rpc('accounting_approve_exchange_rate', { p_rate_id: id });
        if (error) throw new Error(error.message);
        setMessage('Exchange rate approved. Approved rates are immutable and can only be corrected by appending a new revision.', 'success');
        await loadRates();
    }

    async function handleAction(button) {
        const action = button.dataset.rateAction;
        if (['enable-currency', 'disable-currency', 'save-reporting-currency'].includes(action)) {
            await manageCurrency(action, button);
        } else if (action === 'load-more') {
            state.offset = state.rows.length;
            await loadRates({ reset: false });
        } else if (action === 'cancel-form') {
            openForm('create');
        } else if (action === 'edit' || action === 'correct' || action === 'approve') {
            const row = state.rows.find((item) => item.id === button.dataset.rateId);
            if (!row) throw new Error('The selected exchange-rate record is no longer in the loaded list. Refresh and try again.');
            if (action === 'approve') await approveRate(row.id);
            else openForm(action, row);
        } else if (action === 'refresh') {
            await loadRates();
            setMessage('Exchange-rate history refreshed.', 'info');
        }
    }

    function renderShell() {
        const section = document.createElement('section');
        section.id = 'exchange-rate-workspace';
        section.className = 'bm-card rounded-2xl p-5 sm:p-6';
        section.innerHTML = `<div class="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div><p class="bm-kicker">Foreign exchange controls</p><h2 class="mt-1 text-lg font-bold text-white">Exchange rates</h2>
                <p class="mt-2 max-w-3xl text-sm leading-6 text-slate-400">Rates are stored as quote-currency units for one base-currency unit. For example, USD → UGX means how many UGX equal one USD. The system never assumes or creates the inverse rate automatically.</p>
            </div>
            <button type="button" data-rate-action="refresh" class="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800">Refresh rates</button>
        </div>
        <div data-rate-message hidden class="mb-4 rounded-lg border px-4 py-3 text-sm" role="status" aria-live="polite"></div>
        <div data-currency-setup class="mb-5"></div>
        <div data-rate-form-host class="mb-5"></div>
        <div class="overflow-hidden rounded-xl border border-slate-800">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/60 px-4 py-3"><h3 class="text-sm font-semibold text-white">Rate history and revisions</h3><span data-rate-count class="text-xs text-slate-500">Loading…</span></div>
            <div class="bm-scroll overflow-x-auto"><table class="bm-table min-w-full text-sm"><thead class="bg-slate-950/80"><tr><th>Pair / type</th><th>Rate</th><th>Effective</th><th>Status / revision</th><th>Source</th><th>Maker / checker</th><th>Revision lineage</th><th>Action</th></tr></thead><tbody data-rate-rows><tr><td colspan="8" class="px-4 py-8 text-center text-sm text-slate-500">Loading exchange-rate history…</td></tr></tbody></table></div>
            <div class="flex justify-center border-t border-slate-800 p-3"><button type="button" data-rate-action="load-more" hidden class="rounded-lg border border-slate-700 px-4 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800">Load next 50 rates</button></div>
        </div>
        <p class="mt-4 text-xs leading-5 text-slate-500">Draft creation/correction and approval use server-side permission checks and immutable revisions. Approved rates are read-only. A correction does not replace the historical parent; it becomes effective only after independent approval.</p>`;
        const footer = document.querySelector('#dashboard-content footer');
        const existing = document.getElementById('exchange-rate-workspace');
        if (existing) existing.remove();
        if (footer?.parentNode) footer.parentNode.insertBefore(section, footer);
        else document.getElementById('dashboard-content')?.appendChild(section);
    }

    function bindEvents() {
        const host = root();
        if (!host || host.dataset.bound === 'true') return;
        host.dataset.bound = 'true';
        host.addEventListener('submit', async (event) => {
            const isRateForm = event.target.id === 'exchange-rate-form';
            const isMonetaryAccountForm = event.target.matches('[data-monetary-account-form]');
            if (!isRateForm && !isMonetaryAccountForm) return;
            event.preventDefault();
            if (state.busy) return;
            state.busy = true;
            const submit = event.target.querySelector('button[type="submit"]');
            if (submit) submit.disabled = true;
            try {
                if (isRateForm) await submitForm(event.target);
                else await configureMonetaryAccount(event.target);
            } catch (error) {
                setMessage(error.message || (isRateForm ? 'Exchange-rate change failed.' : 'Monetary account configuration failed.'), 'error');
            } finally {
                state.busy = false;
                const active = root()?.querySelector('#exchange-rate-form button[type="submit"]');
                if (active) active.disabled = false;
                const accountButton = root()?.querySelector('[data-monetary-account-form] button[type="submit"]');
                if (accountButton) accountButton.disabled = !hasPermission('accounting.accounts.currency.manage') || !state.monetaryAccounts.length;
            }
        });
        host.addEventListener('click', async (event) => {
            const button = event.target.closest('[data-rate-action]');
            if (!button || button.disabled || state.busy) return;
            state.busy = true;
            button.disabled = true;
            try {
                await handleAction(button);
            } catch (error) {
                setMessage(error.message || 'Exchange-rate action failed.', 'error');
            } finally {
                state.busy = false;
                const active = root()?.querySelector('[data-rate-action="load-more"]');
                if (active) active.disabled = false;
            }
        });
    }

    async function init(context) {
        if (!context?.client || !context?.churchId || !context?.userId || !context?.permissions) {
            throw new Error('Exchange-rate management requires verified accounting context.');
        }
        state.client = context.client;
        state.userId = context.userId;
        state.churchId = context.churchId;
        state.permissions = { ...context.permissions };
        state.currencyMeta = context.currencyMeta || null;
        state.functionalCurrency = String(context.functionalCurrency || '').toUpperCase() || null;
        if (!hasPermission('accounting.exchange_rates.read')) return false;
        if (!state.currencyMeta) throw new Error('ISO currency metadata is unavailable; exchange-rate management is disabled.');
        renderShell();
        renderCurrencySetup();
        bindEvents();
        openForm('create');
        try {
            await Promise.all([loadMonetaryAccounts(), loadRates()]);
        } catch (error) {
            setMessage(error.message || 'Exchange-rate history could not be loaded.', 'error');
            throw error;
        }
        return true;
    }

    window.BelieversMeetAccountingExchangeRates = Object.freeze({ init });
})();
