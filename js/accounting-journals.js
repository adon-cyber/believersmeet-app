/*
 * BelieversMeet Accounting - Journal Management
 * Staging-first frontend module. All journal writes use secured database RPCs.
 * Direct table writes are intentionally not used.
 */
(() => {
    'use strict';

    const PERMISSIONS = Object.freeze({
        read: 'accounting.journals.read',
        create: 'accounting.journals.create',
        approve: 'accounting.journals.approve',
        post: 'accounting.journals.post',
        reverse: 'accounting.journals.reverse'
    });

    const state = {
        client: null,
        userId: null,
        churchId: null,
        permissions: {},
        accounts: [],
        funds: [],
        departments: [],
        periods: [],
        journals: [],
        currency: null,
        currencyMeta: null,
        nativeMulticurrencyEnabled: false,
        root: null,
        referencesReady: false,
        initialized: false,
        busy: false,
        editingJournal: null
    };

    const $ = (id) => document.getElementById(id);
    const hasPermission = (key) => state.permissions[key] === true;

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;'
        })[character]);
    }

    function localDateISO(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function currencyScale(code = state.currency) {
        if (!state.currencyMeta) throw new Error('ISO currency precision metadata is unavailable.');
        return state.currencyMeta.minorUnit(code);
    }

    function currencyStep(code = state.currency) {
        if (!state.currencyMeta) return '1';
        return state.currencyMeta.step(code);
    }

    function formatDate(value) {
        if (!value) return '—';
        const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) return String(value);
        return new Intl.DateTimeFormat(undefined, {
            year: 'numeric', month: 'short', day: '2-digit'
        }).format(parsed);
    }

    function formatMoney(value, currency) {
        const amount = Number(value ?? 0);
        if (!Number.isFinite(amount)) return '—';
        const code = String(currency || '').toUpperCase();
        if (/^[A-Z]{3}$/.test(code)) {
            if (state.currencyMeta) return state.currencyMeta.format(amount, code);
            return `${amount.toLocaleString()} ${code} (precision metadata unavailable)`;
        }
        return amount.toLocaleString();
    }

    function statusMarkup(status) {
        const value = String(status || 'unknown').toLowerCase();
        const styles = {
            draft: 'border-slate-700 bg-slate-900 text-slate-300',
            submitted: 'border-amber-800 bg-amber-950/40 text-amber-300',
            approved: 'border-sky-800 bg-sky-950/40 text-sky-300',
            posted: 'border-emerald-800 bg-emerald-950/40 text-emerald-300',
            reversed: 'border-violet-800 bg-violet-950/40 text-violet-300',
            voided: 'border-rose-800 bg-rose-950/40 text-rose-300'
        };
        const css = styles[value] || 'border-slate-700 bg-slate-900 text-slate-400';
        return `<span class="inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${css}">${escapeHtml(value.replaceAll('_', ' '))}</span>`;
    }

    function setMessage(message, type = 'info') {
        const target = $('jm-message');
        if (!target) return;
        const styles = {
            info: 'border-sky-800 bg-sky-950/40 text-sky-200',
            success: 'border-emerald-800 bg-emerald-950/40 text-emerald-200',
            warning: 'border-amber-800 bg-amber-950/40 text-amber-200',
            error: 'border-rose-800 bg-rose-950/40 text-rose-200'
        };
        target.className = `mb-4 rounded-xl border px-4 py-3 text-sm ${styles[type] || styles.info}`;
        target.textContent = message;
        target.hidden = !message;
    }

    function setBusy(value) {
        state.busy = value === true;
        if (!state.root) return;
        state.root.querySelectorAll('button').forEach((button) => {
            if (button.dataset.allowDuringBusy === 'true') return;
            button.disabled = state.busy;
        });
        const save = $('jm-save');
        if (save) save.textContent = state.busy ? 'Working…' : (state.editingJournal ? 'Save changes' : 'Save draft');
    }

    function createShell() {
        const existing = $('journal-management');
        if (existing) {
            state.root = existing;
            return existing;
        }

        const anchor = $('journals');
        if (!anchor) throw new Error('The Recent journals section was not found in accounting.html.');

        const section = document.createElement('section');
        section.id = 'journal-management';
        section.className = 'bm-card mt-6 overflow-hidden rounded-2xl';
        section.innerHTML = `
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
                <div>
                    <p class="bm-kicker">Ledger workflow</p>
                    <h2 class="mt-1 text-lg font-bold text-white">Journal management</h2>
                    <p class="mt-1 text-xs text-slate-500">Create, review and process journals using the church's secured accounting workflow.</p>
                </div>
                <div class="flex flex-wrap gap-2">
                    <button id="jm-refresh" type="button" class="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Refresh journals</button>
                    <button id="jm-new" type="button" class="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500" hidden>New journal</button>
                </div>
            </div>
            <div class="p-5">
                <div id="jm-message" class="mb-4 rounded-xl border px-4 py-3 text-sm" role="status" hidden></div>
                <div id="jm-form-panel" class="mb-6 rounded-xl border border-slate-700 bg-slate-950/40 p-4" hidden>
                    <div class="mb-4 flex flex-wrap items-center justify-between gap-2">
                        <div>
                            <p class="bm-kicker">Journal entry</p>
                            <h3 id="jm-form-title" class="mt-1 text-base font-bold text-white">Create draft journal</h3>
                        </div>
                        <button type="button" data-action="close-form" class="rounded-lg border border-slate-700 px-3 py-2 text-sm text-slate-300 hover:bg-slate-800">Close</button>
                    </div>
                    <form id="jm-form" class="space-y-4">
                        <div class="grid grid-cols-1 gap-3 md:grid-cols-3">
                            <label class="block text-sm text-slate-300">Journal date
                                <input id="jm-date" type="date" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white" />
                            </label>
                            <label class="block text-sm text-slate-300 md:col-span-2">Accounting period
                                <select id="jm-period" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"></select>
                            </label>
                        </div>
                        <label class="block text-sm text-slate-300">Journal description
                            <textarea id="jm-description" rows="2" maxlength="500" required placeholder="Describe the accounting transaction" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white placeholder:text-slate-500"></textarea>
                        </label>
                        <div>
                            <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                                <div>
                                    <h4 class="text-sm font-semibold text-white">Journal lines</h4>
                                    <p class="text-xs text-slate-500">Each line must contain one debit or one credit. Every fund must balance independently.</p>
                                </div>
                                <button id="jm-add-line" type="button" class="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Add line</button>
                            </div>
                            <div class="overflow-x-auto rounded-lg border border-slate-800">
                                <div class="min-w-[1050px]">
                                    <div class="grid grid-cols-[2fr_1.5fr_1.5fr_1.5fr_1fr_1fr_36px] gap-2 border-b border-slate-800 bg-slate-900 px-3 py-2 text-xs font-semibold uppercase tracking-wide text-slate-500">
                                        <span>Account</span><span>Fund</span><span>Department</span><span>Line description</span><span>Debit</span><span>Credit</span><span></span>
                                    </div>
                                    <div id="jm-line-list" class="divide-y divide-slate-800"></div>
                                </div>
                            </div>
                            <div class="mt-3 flex flex-wrap items-center justify-between gap-3 rounded-lg bg-slate-900/70 px-3 py-3">
                                <p id="jm-balance-status" class="text-sm text-slate-400">Enter at least two balanced journal lines.</p>
                                <div class="flex gap-5 text-sm tabular-nums">
                                    <span class="text-slate-400">Debits: <strong id="jm-total-debits" class="text-white">0</strong></span>
                                    <span class="text-slate-400">Credits: <strong id="jm-total-credits" class="text-white">0</strong></span>
                                </div>
                            </div>
                        </div>
                        <div class="flex flex-wrap justify-end gap-2 border-t border-slate-800 pt-4">
                            <button type="button" data-action="close-form" class="rounded-lg border border-slate-700 px-4 py-2 text-sm font-semibold text-slate-300 hover:bg-slate-800">Cancel</button>
                            <button id="jm-save" type="submit" class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white hover:bg-blue-500">Save draft</button>
                        </div>
                    </form>
                </div>
                <div class="mb-3 flex flex-wrap items-center justify-between gap-2">
                    <div>
                        <h3 class="text-sm font-semibold text-white">Church journals</h3>
                        <p class="text-xs text-slate-500">Latest 50 journals visible to your assigned financial permissions.</p>
                    </div>
                    <span id="jm-count" class="text-xs text-slate-500">Loading…</span>
                </div>
                <div class="overflow-x-auto rounded-xl border border-slate-800">
                    <table class="bm-table w-full min-w-[980px] text-sm">
                        <thead><tr><th>Journal</th><th>Date</th><th>Description</th><th>Status</th><th class="text-right">Debits</th><th class="text-right">Credits</th><th>Actions</th></tr></thead>
                        <tbody id="jm-rows"><tr><td colspan="7" class="py-6 text-center text-slate-400">Loading journals…</td></tr></tbody>
                    </table>
                </div>
            </div>`;
        anchor.insertAdjacentElement('afterend', section);
        state.root = section;
        return section;
    }

    function accountOptions(selected = '') {
        return `<option value="">Select account</option>` + state.accounts.map((account) => {
            const value = escapeHtml(account.id);
            const label = `${account.account_code} · ${account.account_name}`;
            return `<option value="${value}" data-currency-code="${escapeHtml(account.currency_code || '')}" data-monetary="${account.is_monetary_account === true ? 'true' : 'false'}" data-monetary-kind="${escapeHtml(account.monetary_account_kind || '')}" ${account.id === selected ? 'selected' : ''}>${escapeHtml(label)} · ${escapeHtml(account.currency_code || 'currency unavailable')}</option>`;
        }).join('');
    }

    function fundOptions(selected = '') {
        return `<option value="">Select fund</option>` + state.funds.map((fund) => {
            const value = escapeHtml(fund.id);
            const label = `${fund.fund_code} · ${fund.fund_name}`;
            return `<option value="${value}" ${fund.id === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('');
    }

    function departmentOptions(selected = '') {
        return `<option value="">No department</option>` + state.departments.map((department) => {
            const value = escapeHtml(department.id);
            const label = department.department_code
                ? `${department.department_code} · ${department.department_name}`
                : department.department_name;
            return `<option value="${value}" ${department.id === selected ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('');
    }

    function lineMarkup(line = {}) {
        return `
            <div class="jm-line grid min-w-[1050px] grid-cols-[2fr_1.5fr_1.5fr_1.5fr_1fr_1fr_36px] items-center gap-2 px-3 py-2">
                <div class="min-w-0"><select data-field="account_id" required aria-label="Account" class="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-white">${accountOptions(line.account_id || '')}</select><p data-account-currency-label class="mt-1 text-[10px] text-slate-500"></p></div>
                <select data-field="fund_id" required aria-label="Fund" class="min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-white">${fundOptions(line.fund_id || '')}</select>
                <select data-field="department_id" aria-label="Department" class="min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-white">${departmentOptions(line.department_id || '')}</select>
                <input data-field="description" maxlength="500" aria-label="Line description" value="${escapeHtml(line.description ?? line.line_description ?? '')}" placeholder="Optional details" class="min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-xs text-white placeholder:text-slate-600" />
                <div class="min-w-0"><div class="jm-functional-entry"><span class="block text-[10px] text-slate-500">Functional ${escapeHtml(state.currency || '')}</span><input data-field="debit_amount" type="number" min="0" step="${currencyStep()}" inputmode="decimal" aria-label="Functional debit" value="${escapeHtml(line.debit_amount ?? '0')}" class="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-right text-xs tabular-nums text-white" /></div><div class="jm-native-entry hidden"><span data-native-debit-label class="block text-[10px] text-slate-500">Native debit</span><input data-field="account_debit_amount" type="number" min="0" step="0.01" inputmode="decimal" aria-label="Native debit" value="${escapeHtml(line.account_debit_amount ?? '0')}" class="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-right text-xs tabular-nums text-white" /></div></div>
                <div class="min-w-0"><div class="jm-functional-entry"><span class="block text-[10px] text-slate-500">Functional ${escapeHtml(state.currency || '')}</span><input data-field="credit_amount" type="number" min="0" step="${currencyStep()}" inputmode="decimal" aria-label="Functional credit" value="${escapeHtml(line.credit_amount ?? '0')}" class="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-right text-xs tabular-nums text-white" /></div><div class="jm-native-entry hidden"><span data-native-credit-label class="block text-[10px] text-slate-500">Native credit</span><input data-field="account_credit_amount" type="number" min="0" step="0.01" inputmode="decimal" aria-label="Native credit" value="${escapeHtml(line.account_credit_amount ?? '0')}" class="w-full min-w-0 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-right text-xs tabular-nums text-white" /></div></div>
                <button type="button" data-action="remove-line" aria-label="Remove journal line" title="Remove line" class="rounded-lg border border-slate-700 px-2 py-2 text-slate-400 hover:border-rose-700 hover:text-rose-300">×</button>
                <p data-rate-preview class="col-span-7 -mt-1 text-[10px] text-slate-500"></p>
            </div>`;
    }

    function accountForRow(row) {
        const id = row?.querySelector('[data-field="account_id"]')?.value;
        return state.accounts.find((account) => account.id === id) || null;
    }

    async function refreshSpotRatePreview(row, currency) {
        const target = row?.querySelector('[data-rate-preview]');
        if (!target) return;
        if (!currency || currency === state.currency) { target.textContent = ''; return; }
        if (!state.nativeMulticurrencyEnabled) { target.textContent = "Foreign-currency posting is disabled by this church's accounting feature gate."; return; }
        if (!hasPermission('accounting.exchange_rates.read')) { target.textContent = 'Approved spot-rate preview is restricted for this Finance role.'; return; }
        const journalDate = $('jm-date')?.value;
        if (!journalDate || !state.currencyMeta?.isEnabled(currency)) { target.textContent = 'This account currency is not enabled or currency metadata is unavailable.'; return; }
        target.textContent = 'Checking approved transaction-date spot rate…';
        const { data, error } = await state.client.from('accounting_exchange_rates')
            .select('rate_value,effective_date,revision_no,rate_source')
            .eq('church_id', state.churchId).eq('base_currency', currency)
            .eq('quote_currency', state.currency).eq('rate_type', 'spot').eq('status', 'approved')
            .lte('effective_date', journalDate)
            .order('effective_date', { ascending: false }).order('revision_no', { ascending: false }).limit(1).maybeSingle();
        if (error) { target.textContent = `Rate preview unavailable: ${error.message}`; return; }
        if (!data) { target.textContent = `No approved ${currency} → ${state.currency} spot rate is effective on or before ${journalDate}.`; return; }
        target.textContent = `Approved spot preview: 1 ${currency} = ${Number(data.rate_value).toLocaleString(undefined, { maximumFractionDigits: 12 })} ${state.currency} · effective ${data.effective_date} · ${data.rate_source}. Outflows use moving-average carrying value for the asset credit.`;
    }

    function syncLineCurrency(row) {
        const account = accountForRow(row);
        const code = account?.currency_code || '';
        const isFunctional = Boolean(account && code === state.currency);
        row.querySelectorAll('.jm-functional-entry').forEach((node) => node.classList.toggle('hidden', !isFunctional));
        row.querySelectorAll('.jm-native-entry').forEach((node) => node.classList.toggle('hidden', isFunctional));
        const label = row.querySelector('[data-account-currency-label]');
        if (label) label.textContent = account ? `${code || 'Unknown currency'}${isFunctional ? ' · functional ledger' : ' · native monetary account'}` : 'Select an account';
        const debitLabel = row.querySelector('[data-native-debit-label]');
        const creditLabel = row.querySelector('[data-native-credit-label]');
        if (debitLabel) debitLabel.textContent = `Native ${code || 'currency'} debit`;
        if (creditLabel) creditLabel.textContent = `Native ${code || 'currency'} credit`;
        const validForeign = account && !isFunctional && account.is_monetary_account === true
            && ['cash', 'bank', 'mobile_money'].includes(account.monetary_account_kind)
            && state.currencyMeta?.isEnabled(code);
        const nativeInputs = row.querySelectorAll('[data-field="account_debit_amount"], [data-field="account_credit_amount"]');
        nativeInputs.forEach((input) => {
            input.step = code ? currencyStep(code) : '1';
            input.disabled = !validForeign || !state.nativeMulticurrencyEnabled;
        });
        const functionalInputs = row.querySelectorAll('[data-field="debit_amount"], [data-field="credit_amount"]');
        functionalInputs.forEach((input) => { input.step = currencyStep(state.currency); input.disabled = !isFunctional; });
        refreshSpotRatePreview(row, isFunctional ? null : code).catch((error) => console.warn('Spot-rate preview failed:', error));
    }

    async function loadReferenceData() {
        const requests = await Promise.all([
            state.client.from('accounting_accounts')
                .select('id, account_code, account_name, allow_direct_posting, is_active, currency_code, is_monetary_account, monetary_account_kind')
                .eq('church_id', state.churchId).eq('is_active', true)
                .eq('allow_direct_posting', true).order('account_code'),
            state.client.from('accounting_funds')
                .select('id, fund_code, fund_name, is_active')
                .eq('church_id', state.churchId).eq('is_active', true).order('fund_code'),
            state.client.from('accounting_departments')
                .select('id, department_code, department_name, is_active')
                .eq('church_id', state.churchId).eq('is_active', true).order('department_name'),
            state.client.from('accounting_periods')
                .select('id, period_code, period_name, start_date, end_date, status')
                .eq('church_id', state.churchId).eq('status', 'open').order('start_date')
        ]);
        const labels = ['accounts', 'funds', 'departments', 'accounting periods'];
        requests.forEach((result, index) => {
            if (result.error) throw new Error(`Could not load ${labels[index]}: ${result.error.message}`);
        });
        state.accounts = requests[0].data || [];
        state.funds = requests[1].data || [];
        state.departments = requests[2].data || [];
        state.periods = requests[3].data || [];
        state.referencesReady = state.accounts.length > 0 && state.funds.length > 0 && state.periods.length > 0 && Boolean(state.currencyMeta);
        state.root.querySelectorAll('.jm-line').forEach(syncLineCurrency);
    }

    async function loadJournals() {
        const { data, error } = await state.client
            .from('accounting_journals')
            .select('id, journal_number, period_id, journal_date, description, functional_currency, source_type, source_event_id, reversal_of_journal_id, status, total_debits, total_credits, approval_required, created_by, submitted_by, approved_by, posted_by, created_at')
            .eq('church_id', state.churchId)
            .order('created_at', { ascending: false })
            .limit(50);
        if (error) throw new Error(`Could not load journals: ${error.message}`);
        state.journals = data || [];
        if (!state.currency && state.journals.length) state.currency = state.journals[0].functional_currency || null;
        renderJournals();
    }

    function actionButton(action, label, color = 'border-slate-700 text-slate-200') {
        return `<button type="button" data-action="${action}" class="mr-1 mb-1 rounded-lg border ${color} px-2.5 py-1.5 text-xs font-semibold hover:bg-slate-800">${label}</button>`;
    }

    function actionsFor(journal) {
        const actions = [actionButton('details', 'View')];
        const isOwner = journal.created_by === state.userId;
        const isDraft = journal.status === 'draft';

        if (isDraft && isOwner && hasPermission(PERMISSIONS.create) && state.referencesReady) {
            actions.push(actionButton('edit', 'Edit'));
            actions.push(actionButton('submit', 'Submit', 'border-amber-800 text-amber-300'));
        }
        if (journal.status === 'submitted' && hasPermission(PERMISSIONS.approve) && !isOwner) {
            actions.push(actionButton('approve', 'Approve', 'border-emerald-800 text-emerald-300'));
            if (journal.source_type === 'manual' && !journal.source_event_id) {
                actions.push(actionButton('return', 'Return', 'border-amber-800 text-amber-300'));
            }
        }
        const canPostSubmitted = journal.status === 'submitted' && journal.approval_required === false;
        if ((journal.status === 'approved' || canPostSubmitted) && hasPermission(PERMISSIONS.post)) {
            actions.push(actionButton('post', 'Post', 'border-emerald-800 text-emerald-300'));
        }
        if (journal.status === 'posted' && hasPermission(PERMISSIONS.reverse)) {
            actions.push(actionButton('reverse', 'Reverse', 'border-rose-800 text-rose-300'));
        }
        return actions.join('');
    }

    function renderJournals() {
        const target = $('jm-rows');
        if (!target) return;
        $('jm-count').textContent = `${state.journals.length} journal${state.journals.length === 1 ? '' : 's'}`;
        if (!state.journals.length) {
            target.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-slate-400">No journals are visible for this church yet.</td></tr>';
            return;
        }
        target.innerHTML = state.journals.map((journal) => `
            <tr data-journal-row="${escapeHtml(journal.id)}">
                <td class="whitespace-nowrap font-semibold text-white">${escapeHtml(journal.journal_number || '—')}</td>
                <td class="whitespace-nowrap text-slate-300">${escapeHtml(formatDate(journal.journal_date))}</td>
                <td class="max-w-[260px] truncate text-slate-300" title="${escapeHtml(journal.description)}">${escapeHtml(journal.description || '—')}</td>
                <td>${statusMarkup(journal.status)}${journal.approval_required ? '<p class="mt-1 text-[10px] text-amber-300">Approval required</p>' : ''}</td>
                <td class="whitespace-nowrap text-right tabular-nums text-slate-300">${escapeHtml(formatMoney(journal.total_debits, journal.functional_currency))}</td>
                <td class="whitespace-nowrap text-right tabular-nums text-slate-300">${escapeHtml(formatMoney(journal.total_credits, journal.functional_currency))}</td>
                <td class="min-w-[230px]">${actionsFor(journal)}</td>
            </tr>`).join('');
    }

    function showForm(show) {
        const panel = $('jm-form-panel');
        if (!panel) return;
        panel.hidden = !show;
        if (show) panel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function populatePeriodOptions(selectedId = '') {
        const select = $('jm-period');
        if (!select) return;
        select.innerHTML = state.periods.map((period) => {
            const label = `${period.period_name} (${period.start_date} – ${period.end_date})`;
            return `<option value="${escapeHtml(period.id)}" ${period.id === selectedId ? 'selected' : ''}>${escapeHtml(label)}</option>`;
        }).join('');
        if (!state.periods.length) select.innerHTML = '<option value="">No open accounting periods</option>';
    }

    function choosePeriodForDate(dateValue) {
        const date = String(dateValue || '');
        const match = state.periods.find((period) => period.start_date <= date && period.end_date >= date);
        if (match) $('jm-period').value = match.id;
    }

    function resetForm() {
        state.editingJournal = null;
        $('jm-form-title').textContent = 'Create draft journal';
        $('jm-date').value = localDateISO();
        $('jm-description').value = '';
        populatePeriodOptions();
        choosePeriodForDate($('jm-date').value);
        $('jm-line-list').innerHTML = lineMarkup() + lineMarkup();
        state.root.querySelectorAll('.jm-line').forEach(syncLineCurrency);
        $('jm-save').textContent = 'Save draft';
        updateBalancePreview();
        setMessage('', 'info');
    }

    async function openCreateForm() {
        if (!hasPermission(PERMISSIONS.create)) return;
        if (!state.currency) {
            setMessage('The church functional currency could not be loaded. Journal creation is disabled until accounting settings are available.', 'warning');
            return;
        }
        if (!state.referencesReady) {
            setMessage('Journal creation is unavailable because active accounts, funds or open accounting periods could not be loaded.', 'warning');
            return;
        }
        resetForm();
        showForm(true);
    }

    async function openEditForm(journal) {
        if (!journal || journal.status !== 'draft' || journal.created_by !== state.userId || !hasPermission(PERMISSIONS.create)) return;
        if (!state.referencesReady) {
            setMessage('Draft editing is unavailable because the required accounting reference data could not be loaded.', 'warning');
            return;
        }
        const { data: lines, error } = await state.client
            .from('accounting_journal_lines')
            .select('line_number, account_id, fund_id, department_id, line_description, debit_amount, credit_amount, account_currency, account_debit_amount, account_credit_amount, account_movement_basis, account_rate_basis, account_rate_to_functional, account_rate_effective_date, transaction_currency, transaction_debit_amount, transaction_credit_amount, transaction_rate_to_functional')
            .eq('church_id', state.churchId)
            .eq('journal_id', journal.id)
            .order('line_number');
        if (error) throw new Error(`Could not load draft journal lines: ${error.message}`);
        state.editingJournal = journal;
        $('jm-form-title').textContent = `Edit ${journal.journal_number}`;
        $('jm-date').value = String(journal.journal_date).slice(0, 10);
        $('jm-description').value = journal.description || '';
        populatePeriodOptions(journal.period_id);
        $('jm-line-list').innerHTML = (lines || []).map((line) => lineMarkup(line)).join('') || (lineMarkup() + lineMarkup());
        state.root.querySelectorAll('.jm-line').forEach(syncLineCurrency);
        $('jm-save').textContent = 'Save changes';
        updateBalancePreview();
        showForm(true);
    }

    function addLine() {
        $('jm-line-list').insertAdjacentHTML('beforeend', lineMarkup());
        const row = $('jm-line-list').lastElementChild;
        if (row) syncLineCurrency(row);
        updateBalancePreview();
    }

    function readAmount(value, label, currency = state.currency) {
        if (!state.currencyMeta) throw new Error('ISO currency precision metadata is unavailable. Journal entry is disabled.');
        return state.currencyMeta.parseAmount(value, currency, label);
    }

    function scaledAmount(value, currency = state.currency) {
        return state.currencyMeta.minorUnits(String(value), currency);
    }

    function collectLines() {
        const rows = Array.from(state.root.querySelectorAll('.jm-line'));
        if (rows.length < 2 || rows.length > 500) throw new Error('A journal must contain between 2 and 500 lines.');
        const foreignPositions = new Set();
        let containsForeign = false;
        const lines = rows.map((row, index) => {
            const value = (field) => row.querySelector(`[data-field="${field}"]`)?.value ?? '';
            const accountId = value('account_id');
            const fundId = value('fund_id');
            const departmentId = value('department_id') || null;
            const account = state.accounts.find((item) => item.id === accountId);
            if (!account) throw new Error(`Select an active ledger account for line ${index + 1}.`);
            if (!fundId) throw new Error(`Select a fund for line ${index + 1}.`);
            const isFunctional = account.currency_code === state.currency;
            const common = {
                account_id: accountId,
                fund_id: fundId,
                department_id: departmentId,
                description: String(value('description')).trim() || null
            };
            if (isFunctional) {
                const debit = readAmount(value('debit_amount'), `Line ${index + 1} functional debit`, state.currency);
                const credit = readAmount(value('credit_amount'), `Line ${index + 1} functional credit`, state.currency);
                if ((debit > 0) === (credit > 0)) throw new Error(`Line ${index + 1} must contain exactly one positive debit or credit.`);
                return { ...common, debit_amount: debit, credit_amount: credit };
            }
            containsForeign = true;
            if (!state.nativeMulticurrencyEnabled) throw new Error('Foreign-currency posting is still disabled by the church feature gate. Do not enable it until the integrated release is separately approved.');
            if (account.is_monetary_account !== true || !['cash', 'bank', 'mobile_money'].includes(account.monetary_account_kind)) {
                throw new Error(`Line ${index + 1} uses a foreign-currency account outside the Phase 1 cash/bank/mobile-money scope.`);
            }
            if (!state.currencyMeta?.isEnabled(account.currency_code)) throw new Error(`${account.currency_code} is not enabled for this church.`);
            const debitNative = readAmount(value('account_debit_amount'), `Line ${index + 1} ${account.currency_code} native debit`, account.currency_code);
            const creditNative = readAmount(value('account_credit_amount'), `Line ${index + 1} ${account.currency_code} native credit`, account.currency_code);
            if ((debitNative > 0) === (creditNative > 0)) throw new Error(`Line ${index + 1} must contain exactly one positive native debit or credit.`);
            const positionKey = `${accountId}:${fundId}`;
            if (foreignPositions.has(positionKey)) throw new Error('A journal can contain only one foreign movement for each account/fund position. Split sequential foreign movements into separate journals.');
            foreignPositions.add(positionKey);
            return { ...common, debit_amount: 0, credit_amount: 0, account_debit_amount: debitNative, account_credit_amount: creditNative };
        });

        const functionalLines = lines.filter((line) => !Object.prototype.hasOwnProperty.call(line, 'account_debit_amount'));
        const totalDebit = functionalLines.reduce((sum, line) => sum + scaledAmount(line.debit_amount), 0n);
        const totalCredit = functionalLines.reduce((sum, line) => sum + scaledAmount(line.credit_amount), 0n);
        if (!containsForeign && (totalDebit <= 0n || totalDebit !== totalCredit)) {
            throw new Error('The journal is not balanced. Total functional debits must equal total functional credits and be greater than zero.');
        }
        if (!containsForeign) {
            const byFund = new Map();
            lines.forEach((line) => {
                const totals = byFund.get(line.fund_id) || { debit: 0n, credit: 0n };
                totals.debit += scaledAmount(line.debit_amount);
                totals.credit += scaledAmount(line.credit_amount);
                byFund.set(line.fund_id, totals);
            });
            for (const [fundId, totals] of byFund.entries()) {
                if (totals.debit !== totals.credit) {
                    const fund = state.funds.find((item) => item.id === fundId);
                    throw new Error(`Fund ${fund?.fund_name || 'selected fund'} must balance independently.`);
                }
            }
        }
        return lines;
    }

    function updateBalancePreview() {
        const rows = Array.from((state.root || document).querySelectorAll('.jm-line'));
        let debit = 0;
        let credit = 0;
        let hasForeign = false;
        rows.forEach((row) => {
            const account = accountForRow(row);
            if (account && account.currency_code !== state.currency) { hasForeign = true; return; }
            debit += Number(row.querySelector('[data-field="debit_amount"]')?.value || 0) || 0;
            credit += Number(row.querySelector('[data-field="credit_amount"]')?.value || 0) || 0;
        });
        $('jm-total-debits').textContent = formatMoney(debit, state.currency);
        $('jm-total-credits').textContent = formatMoney(credit, state.currency);
        const balanced = rows.length >= 2 && Math.abs(debit - credit) < (10 ** -(currencyScale() + 1)) && debit > 0;
        const status = $('jm-balance-status');
        if (hasForeign) {
            status.textContent = 'Foreign native amounts are included. The server will calculate approved FX values, moving-average carrying amounts and fund-level FX lines, then validate the final functional journal balance.';
            status.className = 'text-sm text-amber-300';
        } else {
            status.textContent = balanced ? 'Functional-currency debits and credits balance. The database will validate each fund and account again.' : 'Not balanced yet. Total debits must equal total credits.';
            status.className = `text-sm ${balanced ? 'text-emerald-300' : 'text-amber-300'}`;
        }
    }

    async function saveDraft(event) {
        event.preventDefault();
        if (!hasPermission(PERMISSIONS.create)) throw new Error('You do not have permission to create accounting journals.');
        const journalDate = $('jm-date').value;
        const periodId = $('jm-period').value;
        const description = $('jm-description').value.trim();
        if (!journalDate || !periodId) throw new Error('Select a journal date and an open accounting period.');
        if (description.length < 1 || description.length > 500) throw new Error('Journal description must contain 1 to 500 characters.');
        const period = state.periods.find((item) => item.id === periodId);
        if (!period || period.status !== 'open' || journalDate < period.start_date || journalDate > period.end_date) {
            throw new Error('The journal date must fall within the selected open accounting period.');
        }
        const lines = collectLines();
        const editingId = state.editingJournal?.id || null;
        const rpcName = editingId ? 'accounting_update_draft_journal' : 'accounting_create_journal';
        const args = editingId
            ? { p_journal_id: editingId, p_period_id: periodId, p_journal_date: journalDate, p_description: description, p_lines: lines }
            : { p_church_id: state.churchId, p_period_id: periodId, p_journal_date: journalDate, p_description: description, p_lines: lines };

        setBusy(true);
        try {
            const { data, error } = await state.client.rpc(rpcName, args);
            if (error) throw error;
            const createdId = editingId || data;
            state.editingJournal = null;
            showForm(false);
            setMessage(editingId ? 'Draft journal updated successfully.' : `Draft journal created successfully${createdId ? ` (${createdId})` : ''}.`, 'success');
            await loadJournals();
        } finally {
            setBusy(false);
        }
    }

    async function fetchJournal(journalId) {
        return state.journals.find((item) => item.id === journalId) || null;
    }

    async function showDetails(journalId) {
        const row = state.root.querySelector(`[data-journal-row="${CSS.escape(journalId)}"]`);
        if (!row) return;
        const existing = state.root.querySelector(`[data-journal-details="${CSS.escape(journalId)}"]`);
        if (existing) {
            existing.remove();
            return;
        }
        const { data: lines, error } = await state.client
            .from('accounting_journal_lines')
            .select('line_number, account_id, fund_id, department_id, line_description, debit_amount, credit_amount, account_currency, account_debit_amount, account_credit_amount, account_movement_basis, account_rate_basis, account_rate_to_functional, account_rate_effective_date, transaction_currency, transaction_debit_amount, transaction_credit_amount, transaction_rate_to_functional')
            .eq('church_id', state.churchId).eq('journal_id', journalId).order('line_number');
        if (error) throw new Error(`Could not load journal details: ${error.message}`);
        const journal = await fetchJournal(journalId);
        const accountById = new Map(state.accounts.map((item) => [item.id, item]));
        const fundById = new Map(state.funds.map((item) => [item.id, item]));
        const departmentById = new Map(state.departments.map((item) => [item.id, item]));
        const detailRow = document.createElement('tr');
        detailRow.dataset.journalDetails = journalId;
        detailRow.innerHTML = `<td colspan="7" class="bg-slate-950/50 px-4 py-4">
            <div class="mb-2 flex flex-wrap items-center justify-between gap-2"><strong class="text-sm text-white">${escapeHtml(journal?.journal_number || 'Journal details')}</strong><span class="text-xs text-slate-500">${(lines || []).length} lines</span></div>
            <div class="overflow-x-auto"><table class="w-full min-w-[750px] text-xs"><thead><tr class="text-left text-slate-500"><th class="py-2">#</th><th>Account</th><th>Fund</th><th>Department</th><th>Description</th><th class="text-right">Debit</th><th class="text-right">Credit</th></tr></thead><tbody>
            ${(lines || []).map((line) => {
                const account = accountById.get(line.account_id);
                const fund = fundById.get(line.fund_id);
                const department = departmentById.get(line.department_id);
                const accountLabel = account ? `${account.account_code} · ${account.account_name}` : line.account_id;
                const fundLabel = fund ? `${fund.fund_code} · ${fund.fund_name}` : line.fund_id;
                const departmentLabel = department ? (department.department_code ? `${department.department_code} · ${department.department_name}` : department.department_name) : '—';
                const nativeCode = line.account_currency || account?.currency_code || journal?.functional_currency;
                const isForeign = nativeCode && nativeCode !== journal?.functional_currency;
                const nativeSide = Number(line.account_debit_amount || 0) > 0
                    ? `Debit ${formatMoney(line.account_debit_amount, nativeCode)}`
                    : Number(line.account_credit_amount || 0) > 0
                        ? `Credit ${formatMoney(line.account_credit_amount, nativeCode)}` : 'Identity movement';
                const rateText = isForeign && line.account_rate_to_functional
                    ? `1 ${nativeCode} = ${Number(line.account_rate_to_functional).toLocaleString(undefined, { maximumFractionDigits: 12 })} ${journal?.functional_currency} · ${line.account_rate_basis || 'rate'} · ${line.account_rate_effective_date || 'date unavailable'}` : '';
                return `<tr class="border-t border-slate-800 text-slate-300"><td class="py-2">${line.line_number}</td><td>${escapeHtml(accountLabel)}<div class="text-[10px] text-slate-500">${escapeHtml(nativeCode || '')}</div></td><td>${escapeHtml(fundLabel)}</td><td>${escapeHtml(departmentLabel)}</td><td>${escapeHtml(line.line_description || '—')}<div class="text-[10px] text-slate-500">${escapeHtml(line.account_movement_basis || 'functional_identity')} ${escapeHtml(rateText)}</div></td><td class="text-right tabular-nums">${escapeHtml(formatMoney(line.debit_amount, journal?.functional_currency))}${isForeign && Number(line.account_debit_amount || 0) > 0 ? `<div class="text-[10px] text-slate-400">${escapeHtml(nativeSide)}</div>` : ''}</td><td class="text-right tabular-nums">${escapeHtml(formatMoney(line.credit_amount, journal?.functional_currency))}${isForeign && Number(line.account_credit_amount || 0) > 0 ? `<div class="text-[10px] text-slate-400">${escapeHtml(nativeSide)}</div>` : ''}</td></tr>`;
            }).join('')}
            </tbody></table></div>
        </td>`;
        row.insertAdjacentElement('afterend', detailRow);
    }

    async function runJournalAction(action, journalId) {
        const journal = await fetchJournal(journalId);
        if (!journal) throw new Error('The selected journal is no longer in the current list. Refresh and try again.');
        let rpcName;
        let args = { p_journal_id: journalId };

        if (action === 'submit') {
            if (!hasPermission(PERMISSIONS.create) || journal.status !== 'draft' || journal.created_by !== state.userId) throw new Error('Only the creator with journal-create permission may submit this draft.');
            if (!window.confirm(`Submit ${journal.journal_number} for review?`)) return;
            rpcName = 'accounting_submit_journal';
        } else if (action === 'approve') {
            if (!hasPermission(PERMISSIONS.approve) || journal.status !== 'submitted' || journal.created_by === state.userId) throw new Error('You are not authorized to approve this journal.');
            if (!window.confirm(`Approve ${journal.journal_number}?`)) return;
            rpcName = 'accounting_approve_journal';
        } else if (action === 'return') {
            if (!hasPermission(PERMISSIONS.approve) || journal.status !== 'submitted' || journal.created_by === state.userId || journal.source_type !== 'manual' || journal.source_event_id) throw new Error('You are not authorized to return this journal.');
            const reason = window.prompt('Enter the reason for returning this journal (10–500 characters):');
            if (reason === null) return;
            if (reason.trim().length < 10 || reason.trim().length > 500) throw new Error('The return reason must contain 10–500 characters.');
            rpcName = 'accounting_return_journal_to_draft';
            args.p_reason = reason.trim();
        } else if (action === 'post') {
            const eligible = journal.status === 'approved' || (journal.status === 'submitted' && journal.approval_required === false);
            if (!hasPermission(PERMISSIONS.post) || !eligible) throw new Error('This journal is not eligible for posting with your permissions.');
            if (!window.confirm(`Post ${journal.journal_number} to the accounting ledger? This action updates the ledger.`)) return;
            rpcName = 'accounting_post_journal';
        } else if (action === 'reverse') {
            if (!hasPermission(PERMISSIONS.reverse) || journal.status !== 'posted') throw new Error('Only an authorized user can request reversal of a posted journal.');
            const reversalDate = window.prompt('Reversal date (YYYY-MM-DD). The date must fall in an open accounting period:', localDateISO());
            if (reversalDate === null) return;
            if (!/^\d{4}-\d{2}-\d{2}$/.test(reversalDate) || Number.isNaN(new Date(`${reversalDate}T00:00:00`).getTime())) throw new Error('Enter a valid reversal date in YYYY-MM-DD format.');
            const reason = window.prompt('Enter the reason for reversing this journal (10–500 characters):');
            if (reason === null) return;
            if (reason.trim().length < 10 || reason.trim().length > 500) throw new Error('The reversal reason must contain 10–500 characters.');
            if (!window.confirm(`Request a reversal of ${journal.journal_number} dated ${reversalDate}? The reversal will require independent approval.`)) return;
            rpcName = 'accounting_reverse_journal';
            args = { p_journal_id: journalId, p_reversal_date: reversalDate, p_reason: reason.trim() };
        } else {
            throw new Error('Unsupported journal action.');
        }

        setBusy(true);
        try {
            const { data, error } = await state.client.rpc(rpcName, args);
            if (error) throw error;
            const messages = {
                submit: 'Journal submitted for review.',
                approve: 'Journal approved. Posting remains a separate action.',
                return: 'Journal returned to its creator as a draft.',
                post: 'Journal posted successfully to the accounting ledger.',
                reverse: `Reversal journal created and submitted for independent approval${data ? ` (${data})` : ''}.`
            };
            setMessage(messages[action] || 'Journal action completed.', 'success');
            await loadJournals();
        } finally {
            setBusy(false);
        }
    }

    function bindEvents() {
        if (state.initialized) return;
        state.root.addEventListener('click', async (event) => {
            const button = event.target.closest('[data-action], #jm-new, #jm-refresh, #jm-add-line');
            if (!button || !state.root.contains(button) || state.busy) return;
            try {
                if (button.id === 'jm-new') {
                    await openCreateForm();
                    return;
                }
                if (button.id === 'jm-refresh') {
                    setBusy(true);
                    await loadJournals();
                    setMessage('Journal list refreshed.', 'info');
                    setBusy(false);
                    return;
                }
                if (button.id === 'jm-add-line') {
                    addLine();
                    return;
                }
                const action = button.dataset.action;
                if (action === 'close-form') {
                    showForm(false);
                    state.editingJournal = null;
                    return;
                }
                if (action === 'remove-line') {
                    const rows = state.root.querySelectorAll('.jm-line');
                    if (rows.length <= 2) throw new Error('A journal must contain at least two lines.');
                    button.closest('.jm-line')?.remove();
                    updateBalancePreview();
                    return;
                }
                const journalId = button.closest('[data-journal-row]')?.dataset.journalRow;
                if (!journalId && action !== 'close-form') return;
                if (action === 'details') await showDetails(journalId);
                else if (action === 'edit') {
                    const journal = await fetchJournal(journalId);
                    await openEditForm(journal);
                } else {
                    await runJournalAction(action, journalId);
                }
            } catch (error) {
                console.error('Journal management action failed:', error);
                setMessage(error.message || 'The journal action could not be completed.', 'error');
                setBusy(false);
            }
        });

        state.root.addEventListener('submit', async (event) => {
            if (event.target?.id !== 'jm-form') return;
            try {
                await saveDraft(event);
            } catch (error) {
                console.error('Journal draft save failed:', error);
                setMessage(error.message || 'The draft could not be saved.', 'error');
                setBusy(false);
            }
        });

        state.root.addEventListener('input', (event) => {
            if (event.target.matches('[data-field="debit_amount"], [data-field="credit_amount"]')) updateBalancePreview();
        });

        state.root.addEventListener('change', (event) => {
            if (event.target.id === 'jm-date') {
                choosePeriodForDate(event.target.value);
                state.root.querySelectorAll('.jm-line').forEach((row) => {
                    const account = accountForRow(row);
                    if (account && account.currency_code !== state.currency) refreshSpotRatePreview(row, account.currency_code);
                });
            }
            if (event.target.matches('[data-field="account_id"]')) {
                const row = event.target.closest('.jm-line');
                if (row) syncLineCurrency(row);
                updateBalancePreview();
            }
        });
        state.initialized = true;
    }

    async function init(context) {
        if (!context || !context.client || !context.churchId || !context.userId || !context.permissions) {
            throw new Error('Journal management requires verified accounting context from the authorized dashboard.');
        }
        state.client = context.client;
        state.userId = context.userId;
        state.churchId = context.churchId;
        state.permissions = { ...context.permissions };
        state.currencyMeta = context.currencyMeta || null;
        state.nativeMulticurrencyEnabled = context.nativeMulticurrencyEnabled === true;
        const currency = String(context.currency || '').trim().toUpperCase();
        state.currency = /^[A-Z]{3}$/.test(currency) ? currency : null;
        if (!state.currencyMeta) console.warn('Journal editor: ISO currency metadata is unavailable; journal creation/editing will be blocked.');

        if (!hasPermission(PERMISSIONS.read)) return false;
        createShell();
        $('jm-new').hidden = !hasPermission(PERMISSIONS.create);
        bindEvents();

        try {
            await loadReferenceData();
        } catch (error) {
            console.warn('Journal reference data unavailable:', error);
            state.referencesReady = false;
            setMessage(`${error.message} Journal viewing remains available; draft creation and editing are disabled until reference data can be loaded.`, 'warning');
        }

        try {
            await loadJournals();
        } catch (error) {
            console.error('Journal list failed to load:', error);
            setMessage(error.message || 'Journals could not be loaded.', 'error');
        }
        return true;
    }

    window.BelieversMeetAccountingJournals = Object.freeze({ init });
})();
