/*
 * BelieversMeet Accounting - Bank & Cash Reconciliation
 * Staging-first frontend module. All writes use secured database RPCs.
 * Direct INSERT/UPDATE/DELETE against reconciliation tables are not used.
 */
(() => {
    'use strict';

    const PERMISSIONS = Object.freeze({
        read: 'accounting.reconciliation.read',
        manage: 'accounting.reconciliation.manage',
        approve: 'accounting.reconciliation.approve'
    });

    const state = {
        client: null,
        userId: null,
        churchId: null,
        permissions: {},
        currency: null,
        accounts: [],
        ledgerAccounts: [],
        periods: [],
        statements: [],
        reconciliations: [],
        selectedReconciliation: null,
        statementLines: [],
        matches: [],
        candidateLines: [],
        selectedStatementLineId: null,
        root: null,
        busy: false,
        initialized: false,
        cashItems: []
    };

    const $ = (id) => document.getElementById(id);
    const hasPermission = (key) => state.permissions[key] === true;
    const canManage = () => hasPermission(PERMISSIONS.manage);
    const canApprove = () => hasPermission(PERMISSIONS.approve);

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    function formatDate(value) {
        if (!value) return '—';
        const parsed = new Date(`${String(value).slice(0, 10)}T00:00:00`);
        if (Number.isNaN(parsed.getTime())) return String(value);
        return new Intl.DateTimeFormat(undefined, {
            year: 'numeric', month: 'short', day: '2-digit'
        }).format(parsed);
    }

    function formatMoney(value, currency = state.currency) {
        const amount = Number(value ?? 0);
        if (!Number.isFinite(amount)) return '—';
        const code = String(currency || '').trim().toUpperCase();
        if (/^[A-Z]{3}$/.test(code)) {
            try {
                return new Intl.NumberFormat(undefined, {
                    style: 'currency',
                    currency: code
                }).format(amount);
            } catch (_) {
                return `${amount.toLocaleString()} ${code}`;
            }
        }
        return amount.toLocaleString(undefined, { maximumFractionDigits: 2 });
    }

    function dateInputValue(date = new Date()) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function statusMarkup(status) {
        const value = String(status || 'unknown').toLowerCase();
        const styles = {
            imported: 'border-sky-800 bg-sky-950/40 text-sky-300',
            active: 'border-emerald-800 bg-emerald-950/30 text-emerald-300',
            inactive: 'border-slate-700 bg-slate-900 text-slate-400',
            draft: 'border-slate-700 bg-slate-900 text-slate-300',
            submitted: 'border-amber-800 bg-amber-950/40 text-amber-300',
            returned: 'border-orange-800 bg-orange-950/40 text-orange-300',
            approved: 'border-indigo-800 bg-indigo-950/40 text-indigo-300',
            completed: 'border-emerald-800 bg-emerald-950/40 text-emerald-300',
            reconciled: 'border-emerald-800 bg-emerald-950/40 text-emerald-300',
            voided: 'border-rose-800 bg-rose-950/40 text-rose-300',
            cancelled: 'border-rose-800 bg-rose-950/40 text-rose-300'
        };
        const css = styles[value] || 'border-slate-700 bg-slate-900 text-slate-400';
        return `<span class="inline-flex rounded-full border px-2.5 py-1 text-xs font-semibold ${css}">${escapeHtml(value.replaceAll('_', ' '))}</span>`;
    }

    function showMessage(message, type = 'info') {
        const target = $('rc-message');
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
        state.root.querySelectorAll('button, input, select, textarea').forEach((control) => {
            if (control.dataset.allowDuringBusy === 'true') return;
            control.disabled = state.busy;
        });
        const refresh = $('rc-refresh');
        if (refresh) refresh.textContent = state.busy ? 'Working…' : 'Refresh';
    }

    function accountLabel(accountId) {
        const account = state.accounts.find((item) => item.id === accountId);
        return account ? `${account.display_name} · ${account.account_kind.replaceAll('_', ' ')}` : 'Unknown account';
    }

    function accountOptions(selected = '') {
        return `<option value="">Select reconciliation account</option>` + state.accounts
            .filter((account) => account.is_active)
            .map((account) => `<option value="${escapeHtml(account.id)}" ${account.id === selected ? 'selected' : ''}>${escapeHtml(account.display_name)} · ${escapeHtml(account.account_kind.replaceAll('_', ' '))}</option>`)
            .join('');
    }

    function ledgerAccountOptions() {
        const kind = $('rc-account-kind')?.value || 'bank';
        const prefixByKind = { bank: '112', cash: '111', mobile_money: '113' };
        const prefix = prefixByKind[kind];
        const eligible = state.ledgerAccounts.filter((account) =>
            prefix && String(account.account_code || '').startsWith(prefix)
        );
        return `<option value="">${eligible.length ? 'Select matching ledger asset account' : 'No eligible ledger accounts in this category'}</option>` + eligible
            .map((account) => `<option value="${escapeHtml(account.id)}">${escapeHtml(`${account.account_code} · ${account.account_name}`)}</option>`)
            .join('');
    }

    function periodOptions(statementId = '') {
        const statement = state.statements.find((item) => item.id === statementId);
        const eligible = statement ? state.periods.filter((period) =>
            period.start_date <= statement.statement_start_date && period.end_date >= statement.statement_end_date
        ) : state.periods;
        return `<option value="">Select accounting period</option>` + eligible.map((period) =>
            `<option value="${escapeHtml(period.id)}">${escapeHtml(`${period.period_code} · ${period.period_name} (${period.start_date} to ${period.end_date})`)}</option>`
        ).join('');
    }

    function createShell() {
        const existing = $('reconciliation-management');
        if (existing) {
            state.root = existing;
            return existing;
        }

        const anchor = $('journal-management') || $('journals');
        if (!anchor) throw new Error('The Journal Management or Recent Journals section was not found in accounting.html.');

        const section = document.createElement('section');
        section.id = 'reconciliation-management';
        section.className = 'bm-card mt-6 overflow-hidden rounded-2xl';
        section.innerHTML = `
            <div class="flex flex-wrap items-center justify-between gap-3 border-b border-slate-800 px-5 py-4">
                <div>
                    <p class="bm-kicker">Cash controls</p>
                    <h2 class="mt-1 text-lg font-bold text-white">Bank &amp; cash reconciliation</h2>
                    <p class="mt-1 text-xs text-slate-500">Import statements, match posted ledger entries and complete independent review.</p>
                </div>
                <div class="flex flex-wrap gap-2">
                    <button id="rc-refresh" type="button" class="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800">Refresh</button>
                    <button id="rc-new-account" type="button" class="rounded-lg border border-slate-700 px-3 py-2 text-sm font-semibold text-slate-200 hover:bg-slate-800" ${canManage() ? '' : 'hidden'}>Register account</button>
                    <button id="rc-new-import" type="button" class="rounded-lg bg-blue-600 px-3 py-2 text-sm font-semibold text-white hover:bg-blue-500" ${canManage() ? '' : 'hidden'}>Import statement / cash count</button>
                </div>
            </div>
            <div class="p-5">
                <div id="rc-message" class="mb-4 rounded-xl border px-4 py-3 text-sm" role="status" hidden></div>

                <div id="rc-account-panel" class="mb-5 rounded-xl border border-slate-700 bg-slate-950/40 p-4" hidden>
                    <div class="mb-3 flex items-center justify-between gap-2">
                        <div><p class="bm-kicker">Account setup</p><h3 class="mt-1 text-base font-bold text-white">Register reconciliation account</h3></div>
                        <button type="button" data-action="close-panels" class="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300">Close</button>
                    </div>
                    <form id="rc-account-form" class="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <label class="text-sm text-slate-300">Account type
                            <select id="rc-account-kind" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white">
                                <option value="bank">Bank</option><option value="cash">Cash on hand</option><option value="mobile_money">Mobile money</option>
                            </select>
                        </label>
                        <label class="text-sm text-slate-300">Ledger asset account
                            <select id="rc-ledger-account" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white">${ledgerAccountOptions()}</select>
                        </label>
                        <label class="text-sm text-slate-300">Display name
                            <input id="rc-account-name" maxlength="120" required placeholder="e.g. Main operating bank account" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white placeholder:text-slate-500" />
                        </label>
                        <label class="text-sm text-slate-300">Currency
                            <input value="${escapeHtml(state.currency || '')}" readonly class="mt-1 w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 text-slate-400" />
                        </label>
                        <label id="rc-institution-wrap" class="text-sm text-slate-300">Bank / institution name
                            <input id="rc-institution" maxlength="120" placeholder="Bank or provider name" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white placeholder:text-slate-500" />
                        </label>
                        <label id="rc-last4-wrap" class="text-sm text-slate-300">Account final four digits
                            <input id="rc-last4" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" placeholder="0000" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white placeholder:text-slate-500" />
                        </label>
                        <div class="flex justify-end gap-2 md:col-span-2">
                            <button type="button" data-action="close-panels" class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300">Cancel</button>
                            <button type="submit" class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Save account</button>
                        </div>
                    </form>
                    <p id="rc-account-warning" class="mt-3 text-xs text-amber-300">Only a masked final-four identifier is stored. Do not enter full account numbers, PINs or banking passwords.</p>
                </div>

                <div id="rc-import-panel" class="mb-5 rounded-xl border border-slate-700 bg-slate-950/40 p-4" hidden>
                    <div class="mb-3 flex items-center justify-between gap-2">
                        <div><p class="bm-kicker">Statement intake</p><h3 class="mt-1 text-base font-bold text-white">Import statement or record a cash count</h3></div>
                        <button type="button" data-action="close-panels" class="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300">Close</button>
                    </div>
                    <form id="rc-import-form" class="space-y-3">
                        <div class="grid grid-cols-1 gap-3 md:grid-cols-2">
                            <label class="text-sm text-slate-300">Reconciliation account
                                <select id="rc-import-account" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white">${accountOptions()}</select>
                            </label>
                            <label class="text-sm text-slate-300">Statement / count reference
                                <input id="rc-statement-number" maxlength="120" required placeholder="Bank statement reference or count ID" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white placeholder:text-slate-500" />
                            </label>
                            <label class="text-sm text-slate-300">Start date
                                <input id="rc-start-date" type="date" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white" />
                            </label>
                            <label class="text-sm text-slate-300">End date
                                <input id="rc-end-date" type="date" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white" />
                            </label>
                            <label id="rc-opening-wrap" class="text-sm text-slate-300">Opening balance (${escapeHtml(state.currency || '')})
                                <input id="rc-opening-balance" type="number" step="${state.currency === 'UGX' ? '1' : '0.01'}" required value="0" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white" />
                            </label>
                            <label id="rc-closing-wrap" class="text-sm text-slate-300">Closing balance (${escapeHtml(state.currency || '')})
                                <input id="rc-closing-balance" type="number" step="${state.currency === 'UGX' ? '1' : '0.01'}" required value="0" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white" />
                            </label>
                        </div>
                        <div id="rc-file-wrap" class="rounded-lg border border-slate-800 p-3">
                            <label class="block text-sm text-slate-300">Normalized CSV file
                                <input id="rc-csv-file" type="file" accept=".csv,text/csv" class="mt-2 block w-full text-sm text-slate-300 file:mr-3 file:rounded-lg file:border-0 file:bg-slate-800 file:px-3 file:py-2 file:text-sm file:font-semibold file:text-white" />
                            </label>
                            <p class="mt-2 text-xs text-slate-500">Required columns: transaction_date, direction, description, amount. Optional: value_date, reference, running_balance, source_line_key, line_number, is_opening_balance. Direction must normalize to credit or debit.</p>
                        </div>
                        <div id="rc-cash-wrap" class="rounded-lg border border-slate-800 p-3" hidden>
                            <div class="mb-2 flex items-center justify-between gap-2"><div><h4 class="text-sm font-semibold text-white">Cash denominations</h4><p class="text-xs text-slate-500">Enter the counted quantity for each denomination.</p></div><button type="button" data-action="add-denomination" class="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300">Add denomination</button></div>
                            <div class="overflow-x-auto"><table class="w-full text-sm"><thead><tr class="text-left text-xs text-slate-500"><th class="py-2">Denomination</th><th>Quantity</th><th class="text-right">Subtotal</th><th></th></tr></thead><tbody id="rc-cash-rows"></tbody></table></div>
                            <div class="mt-3 flex justify-end text-sm text-slate-300">Physical total: <strong id="rc-cash-total" class="ml-2 text-white">${formatMoney(0)}</strong></div>
                            <label class="mt-3 block text-sm text-slate-300">Count notes (optional)
                                <textarea id="rc-cash-notes" maxlength="1000" rows="2" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"></textarea>
                            </label>
                        </div>
                        <div class="flex justify-end gap-2 border-t border-slate-800 pt-3">
                            <button type="button" data-action="close-panels" class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300">Cancel</button>
                            <button type="submit" class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Import / save count</button>
                        </div>
                    </form>
                </div>

                <div id="rc-create-panel" class="mb-5 rounded-xl border border-slate-700 bg-slate-950/40 p-4" hidden>
                    <div class="mb-3 flex items-center justify-between gap-2"><div><p class="bm-kicker">Reconciliation setup</p><h3 class="mt-1 text-base font-bold text-white">Create reconciliation draft</h3></div><button type="button" data-action="close-panels" class="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300">Close</button></div>
                    <form id="rc-create-form" class="grid grid-cols-1 gap-3 md:grid-cols-2">
                        <label class="text-sm text-slate-300">Imported statement
                            <select id="rc-create-statement" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"></select>
                        </label>
                        <label class="text-sm text-slate-300">Accounting period
                            <select id="rc-create-period" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"></select>
                        </label>
                        <label class="text-sm text-slate-300 md:col-span-2">Preparation notes (optional)
                            <textarea id="rc-create-notes" rows="2" maxlength="2000" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-900 px-3 py-2 text-white"></textarea>
                        </label>
                        <div class="flex justify-end gap-2 md:col-span-2"><button type="button" data-action="close-panels" class="rounded-lg border border-slate-700 px-4 py-2 text-sm text-slate-300">Cancel</button><button type="submit" class="rounded-lg bg-blue-600 px-4 py-2 text-sm font-semibold text-white">Create draft</button></div>
                    </form>
                </div>

                <div class="mb-6">
                    <div class="mb-3 flex items-center justify-between gap-2"><div><h3 class="text-sm font-semibold text-white">Registered accounts</h3><p class="text-xs text-slate-500">Only masked account identifiers are displayed.</p></div><span id="rc-account-count" class="text-xs text-slate-500">—</span></div>
                    <div class="overflow-x-auto rounded-xl border border-slate-800"><table class="w-full min-w-[760px] text-sm"><thead class="bg-slate-900 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th class="p-3">Account</th><th>Type</th><th>Institution</th><th>Ledger account</th><th>Currency</th><th>Status</th></tr></thead><tbody id="rc-account-rows"><tr><td colspan="6" class="p-5 text-center text-slate-400">Loading accounts…</td></tr></tbody></table></div>
                </div>

                <div class="mb-6">
                    <div class="mb-3 flex items-center justify-between gap-2"><div><h3 class="text-sm font-semibold text-white">Imported statements / cash counts</h3><p class="text-xs text-slate-500">Complete or void an import before importing the next statement for that account.</p></div><span id="rc-statement-count" class="text-xs text-slate-500">—</span></div>
                    <div class="overflow-x-auto rounded-xl border border-slate-800"><table class="w-full min-w-[900px] text-sm"><thead class="bg-slate-900 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th class="p-3">Account</th><th>Type</th><th>Reference</th><th>Date range</th><th class="text-right">Closing</th><th>Status</th><th>Action</th></tr></thead><tbody id="rc-statement-rows"><tr><td colspan="7" class="p-5 text-center text-slate-400">Loading statements…</td></tr></tbody></table></div>
                </div>

                <div class="mb-6">
                    <div class="mb-3 flex items-center justify-between gap-2"><div><h3 class="text-sm font-semibold text-white">Reconciliation workflow</h3><p class="text-xs text-slate-500">Preparers, independent approvers and finalizers are recorded separately.</p></div><span id="rc-reconciliation-count" class="text-xs text-slate-500">—</span></div>
                    <div class="overflow-x-auto rounded-xl border border-slate-800"><table class="w-full min-w-[1000px] text-sm"><thead class="bg-slate-900 text-left text-xs uppercase tracking-wide text-slate-500"><tr><th class="p-3">Account</th><th>Statement</th><th>Prepared</th><th>Status</th><th class="text-right">Statement closing</th><th class="text-right">Ledger closing</th><th>Action</th></tr></thead><tbody id="rc-reconciliation-rows"><tr><td colspan="7" class="p-5 text-center text-slate-400">Loading reconciliations…</td></tr></tbody></table></div>
                </div>

                <div id="rc-workspace" class="rounded-xl border border-slate-700 bg-slate-950/40 p-4" hidden></div>
            </div>`;
        anchor.insertAdjacentElement('afterend', section);
        state.root = section;
        return section;
    }

    function closePanels() {
        ['rc-account-panel', 'rc-import-panel', 'rc-create-panel'].forEach((id) => { if ($(id)) $(id).hidden = true; });
    }

    function renderCashRows() {
        const body = $('rc-cash-rows');
        if (!body) return;
        body.innerHTML = state.cashItems.map((item, index) => `
            <tr data-cash-index="${index}" class="border-t border-slate-800">
                <td class="py-2"><input data-field="denomination" type="number" min="${state.currency === 'UGX' ? '1' : '0.01'}" step="${state.currency === 'UGX' ? '1' : '0.01'}" value="${escapeHtml(item.denomination)}" class="w-32 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-white" /></td>
                <td><input data-field="quantity" type="number" min="0" step="1" value="${escapeHtml(item.quantity)}" class="w-28 rounded-lg border border-slate-700 bg-slate-900 px-2 py-2 text-white" /></td>
                <td class="text-right tabular-nums text-slate-300">${formatMoney(Number(item.denomination) * Number(item.quantity))}</td>
                <td class="text-right"><button type="button" data-action="remove-denomination" class="rounded px-2 py-1 text-xs text-rose-300 hover:bg-rose-950/30">Remove</button></td>
            </tr>`).join('');
        updateCashTotal();
    }

    function updateCashTotal() {
        let total = 0;
        state.cashItems.forEach((item) => { total += Number(item.denomination || 0) * Number(item.quantity || 0); });
        if ($('rc-cash-total')) $('rc-cash-total').textContent = formatMoney(total);
        return total;
    }

    function resetCashItems() {
        state.cashItems = state.currency === 'USD'
            ? [100, 50, 20, 10, 5, 1, 0.5, 0.25, 0.1, 0.05].map((denomination) => ({ denomination, quantity: 0 }))
            : [50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100, 50].map((denomination) => ({ denomination, quantity: 0 }));
        renderCashRows();
    }

    function toggleImportType() {
        const accountId = $('rc-import-account')?.value;
        const account = state.accounts.find((item) => item.id === accountId);
        const isCash = account?.account_kind === 'cash';
        if ($('rc-file-wrap')) $('rc-file-wrap').hidden = isCash;
        if ($('rc-cash-wrap')) $('rc-cash-wrap').hidden = !isCash;
        if ($('rc-opening-wrap')) $('rc-opening-wrap').hidden = isCash;
        if ($('rc-closing-wrap')) $('rc-closing-wrap').hidden = isCash;
        if (isCash) {
            if ($('rc-start-date')) $('rc-start-date').value = dateInputValue();
            if ($('rc-end-date')) $('rc-end-date').value = $('rc-start-date')?.value || dateInputValue();
        }
    }

    async function loadData() {
        const [accountsResult, statementsResult, reconciliationsResult] = await Promise.all([
            state.client.from('accounting_reconciliation_accounts')
                .select('id,church_id,ledger_account_id,account_kind,display_name,institution_name,account_identifier_last4,currency,is_active,created_at')
                .eq('church_id', state.churchId).order('display_name', { ascending: true }),
            state.client.from('accounting_reconciliation_statements')
                .select('id,church_id,reconciliation_account_id,statement_type,statement_number,statement_start_date,statement_end_date,opening_balance,closing_balance,currency,status,import_file_name,imported_by,imported_at,cash_count_details')
                .eq('church_id', state.churchId).order('statement_start_date', { ascending: false }).limit(100),
            state.client.from('accounting_reconciliations')
                .select('id,church_id,reconciliation_account_id,statement_id,period_id,status,statement_opening_balance,statement_closing_balance,ledger_opening_balance,ledger_closing_balance,prepared_by,submitted_by,approved_by,completed_by,prepared_at,submitted_at,approved_at,completed_at,return_reason,notes')
                .eq('church_id', state.churchId).order('prepared_at', { ascending: false }).limit(100)
        ]);

        if (accountsResult.error) throw accountsResult.error;
        if (statementsResult.error) throw statementsResult.error;
        if (reconciliationsResult.error) throw reconciliationsResult.error;
        state.accounts = accountsResult.data || [];
        state.statements = statementsResult.data || [];
        state.reconciliations = reconciliationsResult.data || [];

        if (canManage()) {
            const [ledgerResult, periodsResult] = await Promise.all([
                state.client.from('accounting_accounts')
                    .select('id,account_code,account_name,account_type,normal_balance,allow_direct_posting,is_active')
                    .eq('church_id', state.churchId).eq('account_type', 'asset')
                    .eq('normal_balance', 'debit').eq('allow_direct_posting', true)
                    .eq('is_active', true).order('account_code', { ascending: true }),
                state.client.from('accounting_periods')
                    .select('id,period_code,period_name,start_date,end_date,status')
                    .eq('church_id', state.churchId).order('start_date', { ascending: false })
            ]);
            if (ledgerResult.error) throw new Error(`Eligible ledger accounts could not be loaded: ${ledgerResult.error.message}`);
            if (periodsResult.error) throw new Error(`Accounting periods could not be loaded: ${periodsResult.error.message}`);
            state.ledgerAccounts = ledgerResult.data || [];
            state.periods = periodsResult.data || [];
        }

        renderAll();
        if ($('rc-import-account')) $('rc-import-account').innerHTML = accountOptions($('rc-import-account').value);
        if ($('rc-ledger-account')) $('rc-ledger-account').innerHTML = ledgerAccountOptions();
        if ($('rc-import-account')) toggleImportType();
        if ($('rc-workspace') && !state.selectedReconciliation) $('rc-workspace').hidden = true;
    }

    function renderAll() {
        const accountMap = new Map(state.accounts.map((account) => [account.id, account]));
        const ledgerMap = new Map(state.ledgerAccounts.map((account) => [account.id, account]));

        $('rc-account-count').textContent = `${state.accounts.length} account(s)`;
        $('rc-account-rows').innerHTML = state.accounts.length ? state.accounts.map((account) => {
            const ledger = ledgerMap.get(account.ledger_account_id);
            const ledgerLabel = ledger ? `${ledger.account_code} · ${ledger.account_name}` : account.ledger_account_id;
            return `<tr class="border-t border-slate-800"><td class="p-3 font-semibold text-white">${escapeHtml(account.display_name)}${account.account_identifier_last4 ? `<span class="ml-2 text-xs text-slate-500">•••• ${escapeHtml(account.account_identifier_last4)}</span>` : ''}</td><td class="text-slate-300">${escapeHtml(account.account_kind.replaceAll('_', ' '))}</td><td class="text-slate-300">${escapeHtml(account.institution_name || '—')}</td><td class="text-slate-400">${escapeHtml(ledgerLabel)}</td><td class="text-slate-300">${escapeHtml(account.currency)}</td><td>${statusMarkup(account.is_active ? 'active' : 'inactive')}</td></tr>`;
        }).join('') : '<tr><td colspan="6" class="p-5 text-center text-slate-400">No reconciliation accounts registered yet.</td></tr>';

        $('rc-statement-count').textContent = `${state.statements.length} statement(s)`;
        $('rc-statement-rows').innerHTML = state.statements.length ? state.statements.map((statement) => {
            const relatedRec = state.reconciliations.find((item) => item.statement_id === statement.id);
            const account = accountMap.get(statement.reconciliation_account_id);
            let action = '—';
            if (statement.status === 'imported' && !relatedRec && canManage()) {
                action = `<button type="button" data-action="create-reconciliation" data-statement-id="${escapeHtml(statement.id)}" class="rounded-lg bg-blue-600 px-3 py-1.5 text-xs font-semibold text-white">Create draft</button><button type="button" data-action="void-statement" data-statement-id="${escapeHtml(statement.id)}" class="ml-1 rounded-lg border border-slate-700 px-3 py-1.5 text-xs text-slate-300">Void</button>`;
            } else if (relatedRec) {
                action = `<button type="button" data-action="open-reconciliation" data-reconciliation-id="${escapeHtml(relatedRec.id)}" class="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200">Open workflow</button>`;
            }
            return `<tr class="border-t border-slate-800"><td class="p-3 text-white">${escapeHtml(account?.display_name || 'Unknown account')}</td><td class="text-slate-300">${escapeHtml(statement.statement_type.replaceAll('_', ' '))}</td><td class="text-slate-300">${escapeHtml(statement.statement_number)}</td><td class="text-slate-400">${formatDate(statement.statement_start_date)} – ${formatDate(statement.statement_end_date)}</td><td class="text-right tabular-nums text-slate-200">${formatMoney(statement.closing_balance, statement.currency || account?.currency || state.currency)}</td><td>${statusMarkup(statement.status)}</td><td>${action}</td></tr>`;
        }).join('') : '<tr><td colspan="7" class="p-5 text-center text-slate-400">No statements or cash counts imported yet.</td></tr>';

        $('rc-reconciliation-count').textContent = `${state.reconciliations.length} workflow(s)`;
        $('rc-reconciliation-rows').innerHTML = state.reconciliations.length ? state.reconciliations.map((rec) => {
            const account = accountMap.get(rec.reconciliation_account_id);
            const statement = state.statements.find((item) => item.id === rec.statement_id);
            let actions = `<button type="button" data-action="open-reconciliation" data-reconciliation-id="${escapeHtml(rec.id)}" class="rounded-lg border border-slate-700 px-3 py-1.5 text-xs font-semibold text-slate-200">Open</button>`;
            if (rec.status === 'submitted' && canApprove() && rec.prepared_by !== state.userId && rec.submitted_by !== state.userId) {
                actions += `<button type="button" data-action="approve-reconciliation" data-reconciliation-id="${escapeHtml(rec.id)}" class="ml-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white">Approve</button><button type="button" data-action="return-reconciliation" data-reconciliation-id="${escapeHtml(rec.id)}" class="ml-1 rounded-lg border border-amber-800 px-3 py-1.5 text-xs text-amber-300">Return</button>`;
            }
            if (rec.status === 'approved' && rec.prepared_by !== state.userId && (canManage() || (canApprove() && rec.approved_by === state.userId))) actions += `<button type="button" data-action="complete-reconciliation" data-reconciliation-id="${escapeHtml(rec.id)}" class="ml-1 rounded-lg bg-emerald-700 px-3 py-1.5 text-xs font-semibold text-white">Complete</button>`;
            if (['draft', 'returned'].includes(rec.status) && canManage()) actions += `<button type="button" data-action="cancel-reconciliation" data-reconciliation-id="${escapeHtml(rec.id)}" class="ml-1 rounded-lg border border-rose-900 px-3 py-1.5 text-xs text-rose-300">Cancel</button>`;
            return `<tr class="border-t border-slate-800"><td class="p-3 text-white">${escapeHtml(account?.display_name || 'Unknown account')}</td><td class="text-slate-300">${escapeHtml(statement?.statement_number || rec.statement_id)}</td><td class="text-slate-400">${formatDate(rec.prepared_at?.slice(0, 10))}</td><td>${statusMarkup(rec.status)}</td><td class="text-right tabular-nums text-slate-200">${formatMoney(rec.statement_closing_balance, statement?.currency || account?.currency || state.currency)}</td><td class="text-right tabular-nums text-slate-200">${rec.ledger_closing_balance == null ? '—' : formatMoney(rec.ledger_closing_balance, statement?.currency || account?.currency || state.currency)}</td><td>${actions}</td></tr>`;
        }).join('') : '<tr><td colspan="7" class="p-5 text-center text-slate-400">No reconciliation workflows created yet.</td></tr>';
    }

    function parseCsv(text) {
        const rows = [];
        let row = [];
        let field = '';
        let quoted = false;
        const input = String(text || '').replace(/^\uFEFF/, '');
        for (let index = 0; index < input.length; index += 1) {
            const character = input[index];
            if (quoted) {
                if (character === '"' && input[index + 1] === '"') { field += '"'; index += 1; }
                else if (character === '"') quoted = false;
                else field += character;
            } else if (character === '"') quoted = true;
            else if (character === ',') { row.push(field); field = ''; }
            else if (character === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
            else field += character;
        }
        if (quoted) throw new Error('The CSV file contains an unterminated quoted field.');
        if (field.length || row.length) { row.push(field.replace(/\r$/, '')); rows.push(row); }
        return rows.filter((item) => item.some((value) => String(value).trim() !== ''));
    }

    function parseAmount(value, fieldName) {
        const normalized = String(value ?? '').trim().replace(/,/g, '');
        if (!normalized) throw new Error(`${fieldName} is required in the CSV file.`);
        const number = Number(normalized);
        if (!Number.isFinite(number)) throw new Error(`${fieldName} must be numeric in the CSV file.`);
        return number;
    }

    function parseStatementCsv(text) {
        const rows = parseCsv(text);
        if (rows.length < 1) throw new Error('The CSV file is empty.');
        const headers = rows[0].map((value) => String(value).trim().toLowerCase());
        const required = ['transaction_date', 'direction', 'description', 'amount'];
        const missing = required.filter((name) => !headers.includes(name));
        if (missing.length) throw new Error(`CSV is missing required column(s): ${missing.join(', ')}.`);
        const get = (row, name) => {
            const index = headers.indexOf(name);
            return index < 0 ? '' : String(row[index] ?? '').trim();
        };
        const lines = [];
        for (let index = 1; index < rows.length; index += 1) {
            const row = rows[index];
            const date = get(row, 'transaction_date');
            const directionRaw = get(row, 'direction').toLowerCase();
            const directionMap = {
                credit: 'credit', cr: 'credit', deposit: 'credit', deposit_in: 'credit', inflow: 'credit',
                debit: 'debit', dr: 'debit', withdrawal: 'debit', withdraw: 'debit', outflow: 'debit'
            };
            const direction = directionMap[directionRaw];
            if (!direction) throw new Error(`CSV row ${index + 1}: direction must be credit/debit (or a supported deposit/withdrawal label).`);
            const openingRaw = get(row, 'is_opening_balance').toLowerCase();
            const isOpening = ['true', '1', 'yes'].includes(openingRaw);
            const lineNumberRaw = get(row, 'line_number');
            const lineNumber = lineNumberRaw ? Number(lineNumberRaw) : index;
            if (!Number.isInteger(lineNumber) || lineNumber < 1) throw new Error(`CSV row ${index + 1}: line_number must be a positive whole number.`);
            lines.push({
                line_number: lineNumber,
                transaction_date: date,
                value_date: get(row, 'value_date') || null,
                direction,
                description: get(row, 'description'),
                reference: get(row, 'reference') || null,
                amount: parseAmount(get(row, 'amount'), `CSV row ${index + 1} amount`),
                running_balance: get(row, 'running_balance') ? parseAmount(get(row, 'running_balance'), `CSV row ${index + 1} running_balance`) : null,
                source_line_key: get(row, 'source_line_key') || null,
                is_opening_balance: isOpening
            });
        }
        // An empty statement is valid when opening and closing balances are
        // equal; the database RPC verifies that relationship.
        return lines;
    }

    async function fileSha256(file) {
        if (!window.crypto?.subtle || !file?.arrayBuffer) return null;
        try {
            const bytes = await file.arrayBuffer();
            const digest = await window.crypto.subtle.digest('SHA-256', bytes);
            return Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, '0')).join('');
        } catch (_) {
            return null;
        }
    }

    async function hasCompletedReconciliation(accountId) {
        const { data, error } = await state.client.from('accounting_reconciliations')
            .select('id').eq('church_id', state.churchId)
            .eq('reconciliation_account_id', accountId).eq('status', 'completed').limit(1);
        if (error) throw error;
        return Array.isArray(data) && data.length > 0;
    }

    async function saveAccount(event) {
        event.preventDefault();
        if (!canManage()) throw new Error('You do not have permission to register reconciliation accounts.');
        const kind = $('rc-account-kind').value;
        const payload = {
            p_church_id: state.churchId,
            p_ledger_account_id: $('rc-ledger-account').value,
            p_account_kind: kind,
            p_display_name: $('rc-account-name').value.trim(),
            p_institution_name: kind === 'bank' ? $('rc-institution').value.trim() : null,
            p_account_identifier_last4: kind === 'bank' ? $('rc-last4').value.trim() : null,
            p_currency: state.currency
        };
        const { data, error } = await state.client.rpc('accounting_create_reconciliation_account', payload);
        if (error) throw error;
        closePanels();
        showMessage(`Reconciliation account registered (${String(data).slice(0, 8)}…).`, 'success');
        await loadData();
    }

    async function saveStatement(event) {
        event.preventDefault();
        if (!canManage()) throw new Error('You do not have permission to import statements or cash counts.');
        const accountId = $('rc-import-account').value;
        const account = state.accounts.find((item) => item.id === accountId);
        if (!account) throw new Error('Select an active reconciliation account.');
        const startDate = $('rc-start-date').value;
        const endDate = account.account_kind === 'cash' ? startDate : $('rc-end-date').value;
        const statementNumber = $('rc-statement-number').value.trim();
        if (!startDate || !endDate || !statementNumber) throw new Error('Statement reference and valid dates are required.');

        let lines = [];
        let cashDetails = null;
        let openingBalance = 0;
        let closingBalance = 0;
        let fileName = null;
        let sha256 = null;
        let type = 'cash_count';

        if (account.account_kind === 'cash') {
            const items = state.cashItems.map((item) => ({
                denomination: Number(item.denomination), quantity: Number(item.quantity)
            }));
            if (items.some((item) => !Number.isFinite(item.denomination) || item.denomination <= 0 || !Number.isInteger(item.quantity) || item.quantity < 0)) {
                throw new Error('Each cash denomination must be positive and each quantity must be a whole non-negative number.');
            }
            closingBalance = items.reduce((sum, item) => sum + item.denomination * item.quantity, 0);
            cashDetails = { items, notes: $('rc-cash-notes').value.trim(), counted_at: new Date().toISOString() };
            type = 'cash_count';
        } else {
            const file = $('rc-csv-file').files?.[0];
            if (!file) throw new Error('Choose a normalized CSV file to import.');
            openingBalance = parseAmount($('rc-opening-balance').value, 'Opening balance');
            closingBalance = parseAmount($('rc-closing-balance').value, 'Closing balance');
            const csvText = await file.text();
            lines = parseStatementCsv(csvText);
            const alreadyHasOpening = lines.some((line) => line.is_opening_balance);
            const hasPrior = await hasCompletedReconciliation(accountId);
            if (!hasPrior && openingBalance !== 0 && !alreadyHasOpening) {
                lines = lines.map((line) => ({ ...line, line_number: line.line_number + 1 }));
                const openingDate = new Date(`${startDate}T00:00:00.000Z`);
                openingDate.setUTCDate(openingDate.getUTCDate() - 1);
                lines.unshift({
                    line_number: 1,
                    transaction_date: openingDate.toISOString().slice(0, 10),
                    value_date: null,
                    direction: openingBalance > 0 ? 'credit' : 'debit',
                    description: 'Opening balance',
                    reference: 'OPENING',
                    amount: Math.abs(openingBalance),
                    running_balance: null,
                    source_line_key: 'OPENING_BALANCE',
                    is_opening_balance: true
                });
            }
            type = account.account_kind === 'bank' ? 'bank_statement' : 'mobile_money_statement';
            fileName = file.name;
            sha256 = await fileSha256(file);
        }

        const payload = {
            p_church_id: state.churchId,
            p_reconciliation_account_id: accountId,
            p_statement_type: type,
            p_statement_number: statementNumber,
            p_statement_start_date: startDate,
            p_statement_end_date: endDate,
            p_opening_balance: openingBalance,
            p_closing_balance: closingBalance,
            p_currency: state.currency,
            p_import_file_name: fileName,
            p_import_sha256: sha256,
            p_cash_count_details: cashDetails,
            p_lines: lines
        };
        const { data, error } = await state.client.rpc('accounting_import_reconciliation_statement', payload);
        if (error) throw error;
        closePanels();
        showMessage(`Statement imported successfully (${String(data).slice(0, 8)}…). Create its reconciliation draft next.`, 'success');
        await loadData();
    }

    function showCreatePanel(statementId) {
        if (!canManage()) return;
        const statement = state.statements.find((item) => item.id === statementId);
        if (!statement) return;
        closePanels();
        $('rc-create-statement').innerHTML = `<option value="${escapeHtml(statement.id)}">${escapeHtml(`${accountLabel(statement.reconciliation_account_id)} · ${statement.statement_number} · ${statement.statement_start_date} to ${statement.statement_end_date}`)}</option>`;
        $('rc-create-period').innerHTML = periodOptions(statementId);
        $('rc-create-notes').value = '';
        $('rc-create-panel').hidden = false;
        $('rc-create-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function createReconciliation(event) {
        event.preventDefault();
        if (!canManage()) throw new Error('You do not have permission to create reconciliations.');
        const statementId = $('rc-create-statement').value;
        const periodId = $('rc-create-period').value;
        if (!statementId || !periodId) throw new Error('Select the accounting period that contains the full statement date range.');
        const { data, error } = await state.client.rpc('accounting_create_reconciliation', {
            p_statement_id: statementId,
            p_period_id: periodId,
            p_notes: $('rc-create-notes').value.trim() || null
        });
        if (error) throw error;
        closePanels();
        showMessage('Reconciliation draft created. Open it to match statement lines.', 'success');
        await loadData();
        await openReconciliation(data);
    }

    function currentRec() {
        return state.reconciliations.find((item) => item.id === state.selectedReconciliation);
    }

    function renderWorkspace() {
        const panel = $('rc-workspace');
        const rec = currentRec();
        if (!rec || !panel) { if (panel) panel.hidden = true; return; }
        const statement = state.statements.find((item) => item.id === rec.statement_id);
        const account = state.accounts.find((item) => item.id === rec.reconciliation_account_id);
        const statementCurrency = statement?.currency || account?.currency || state.currency;
        const formatStatementMoney = (value) => formatMoney(value, statementCurrency);
        const editable = canManage() && ['draft', 'returned'].includes(rec.status);
        const isPreparer = rec.prepared_by === state.userId;
        const canAccept = canApprove() && rec.status === 'submitted' && !isPreparer && rec.submitted_by !== state.userId;
        const canComplete = !isPreparer && (canManage() || (canApprove() && rec.approved_by === state.userId)) && rec.status === 'approved';
        const canCancel = editable;
        const lineMatchTotals = new Map();
        state.matches.forEach((match) => lineMatchTotals.set(
            match.statement_line_id,
            (lineMatchTotals.get(match.statement_line_id) || 0) + Number(match.matched_amount)
        ));
        const selectedLine = state.statementLines.find((line) => line.id === state.selectedStatementLineId);
        const selectedMatched = selectedLine ? (lineMatchTotals.get(selectedLine.id) || 0) : 0;
        const selectedRemaining = selectedLine ? Math.max(0, Number(selectedLine.amount) - selectedMatched) : 0;
        const matchingCandidates = selectedLine ? state.candidateLines.filter((candidate) => {
            const directionFits = selectedLine.direction === 'credit'
                ? Number(candidate.debit_amount) > 0
                : Number(candidate.credit_amount) > 0;
            return directionFits && Number(candidate.remaining_amount) > 0;
        }) : [];
        const openingDifference = rec.ledger_opening_balance == null ? null
            : Number(rec.ledger_opening_balance) - Number(rec.statement_opening_balance);
        const ledgerDifference = rec.ledger_closing_balance == null ? null
            : Number(rec.ledger_closing_balance) - Number(rec.statement_closing_balance);
        const outstandingLedgerNetPreview = state.candidateLines.reduce((sum, candidate) => {
            const sign = Number(candidate.debit_amount) > 0 ? 1 : -1;
            return sum + sign * Number(candidate.remaining_amount || 0);
        }, 0);
        const candidatePreviewCapped = state.candidateLines.length >= 1000;

        let workflowActions = '';
        if (rec.status === 'submitted' && canAccept) {
            workflowActions = `<button type="button" data-action="approve-reconciliation" data-reconciliation-id="${escapeHtml(rec.id)}" class="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white">Approve</button><button type="button" data-action="return-reconciliation" data-reconciliation-id="${escapeHtml(rec.id)}" class="rounded-lg border border-amber-800 px-3 py-2 text-xs text-amber-300">Return with reason</button>`;
        } else if (rec.status === 'approved' && canComplete) {
            workflowActions = `<button type="button" data-action="complete-reconciliation" data-reconciliation-id="${escapeHtml(rec.id)}" class="rounded-lg bg-emerald-700 px-3 py-2 text-xs font-semibold text-white">Complete reconciliation</button>`;
        } else if (editable) {
            workflowActions = `${isPreparer ? `<button type="button" data-action="submit-reconciliation" data-reconciliation-id="${escapeHtml(rec.id)}" class="rounded-lg bg-blue-600 px-3 py-2 text-xs font-semibold text-white">Submit for approval</button>` : ''}<button type="button" data-action="cancel-reconciliation" data-reconciliation-id="${escapeHtml(rec.id)}" class="rounded-lg border border-rose-900 px-3 py-2 text-xs text-rose-300">Cancel draft</button>`;
        }

        const lineRows = statement?.statement_type === 'cash_count' ? '' : state.statementLines.map((line) => {
            const matched = lineMatchTotals.get(line.id) || 0;
            const remaining = Math.max(0, Number(line.amount) - matched);
            const selected = state.selectedStatementLineId === line.id;
            return `<tr class="border-t border-slate-800 ${selected ? 'bg-blue-950/20' : ''}"><td class="p-2">${line.is_opening_balance ? '<span class="text-amber-300">Opening balance</span>' : escapeHtml(line.line_number)}</td><td class="text-slate-300">${formatDate(line.transaction_date)}</td><td class="text-slate-300">${escapeHtml(line.direction)}</td><td class="max-w-[280px] truncate text-slate-200" title="${escapeHtml(line.description)}">${escapeHtml(line.description)}</td><td class="text-right tabular-nums text-slate-200">${formatStatementMoney(line.amount)}</td><td class="text-right tabular-nums text-slate-300">${formatStatementMoney(matched)}</td><td class="text-right tabular-nums ${remaining > 0 ? 'text-amber-300' : 'text-emerald-300'}">${formatStatementMoney(remaining)}</td><td>${editable && remaining > 0 ? `<button type="button" data-action="select-statement-line" data-line-id="${escapeHtml(line.id)}" class="rounded border border-slate-700 px-2 py-1 text-xs ${selected ? 'text-blue-300' : 'text-slate-300'}">${selected ? 'Selected' : 'Match'}</button>` : '—'}</td></tr>`;
        }).join('');

        const matchRows = state.matches.length ? state.matches.map((match) => {
            const line = state.statementLines.find((item) => item.id === match.statement_line_id);
            return `<tr class="border-t border-slate-800"><td class="p-2 text-slate-300">${escapeHtml(line?.description || match.statement_line_id.slice(0, 8))}</td><td class="font-mono text-xs text-slate-400">${escapeHtml(match.journal_line_id.slice(0, 8))}…</td><td class="text-right tabular-nums text-slate-200">${formatStatementMoney(match.matched_amount)}</td><td>${editable ? `<button type="button" data-action="unmatch" data-match-id="${escapeHtml(match.id)}" class="rounded border border-rose-900 px-2 py-1 text-xs text-rose-300">Remove</button>` : '—'}</td></tr>`;
        }).join('') : '<tr><td colspan="4" class="p-4 text-center text-slate-500">No matches recorded.</td></tr>';

        const candidateRowMarkup = (candidate, showMatchControl) => {
            const amount = Math.min(selectedRemaining, Number(candidate.remaining_amount));
            const side = Number(candidate.debit_amount) > 0 ? 'Ledger debit' : 'Ledger credit';
            return `<tr class="border-t border-slate-800"><td class="p-2"><div class="font-semibold text-white">${escapeHtml(candidate.journal_number)}</div><div class="text-xs text-slate-500">${formatDate(candidate.journal_date)} · line ${escapeHtml(candidate.line_number)}</div></td><td class="max-w-[260px] truncate text-slate-300" title="${escapeHtml(candidate.line_description || candidate.journal_description)}">${escapeHtml(candidate.line_description || candidate.journal_description || '—')}</td><td class="text-slate-400">${side}</td><td class="text-right tabular-nums text-slate-200">${formatStatementMoney(candidate.remaining_amount)}</td><td>${showMatchControl ? `<div class="flex items-center gap-1"><input data-match-amount="${escapeHtml(candidate.journal_line_id)}" type="number" min="${state.currency === 'UGX' ? '1' : '0.01'}" step="${state.currency === 'UGX' ? '1' : '0.01'}" value="${escapeHtml(amount)}" class="w-28 rounded border border-slate-700 bg-slate-900 px-2 py-1 text-xs text-white"/><button type="button" data-action="match" data-journal-line-id="${escapeHtml(candidate.journal_line_id)}" class="rounded bg-blue-600 px-2 py-1 text-xs font-semibold text-white">Match</button></div>` : '—'}</td></tr>`;
        };
        const candidateRows = matchingCandidates.length ? matchingCandidates.map((candidate) => candidateRowMarkup(candidate, editable)).join('') : '<tr><td colspan="5" class="p-4 text-center text-slate-500">No eligible unmatched ledger lines for this statement line.</td></tr>';
        const reviewOutstandingRows = state.candidateLines.length ? state.candidateLines.map((candidate) => candidateRowMarkup(candidate, false)).join('') : '<tr><td colspan="5" class="p-4 text-center text-slate-500">No unmatched posted ledger entries remain for this account through the statement end date.</td></tr>';
        const showCandidateReview = canApprove() && rec.status === 'submitted';

        const cashCountItems = Array.isArray(statement?.cash_count_details?.items)
            ? statement.cash_count_details.items
            : [];

        const cashCountRows = cashCountItems.length
            ? cashCountItems.map((item) => {
                const denomination = Number(item.denomination);
                const quantity = Number(item.quantity);

                return `<tr class="border-t border-slate-800">
                    <td class="p-2">${formatStatementMoney(denomination)}</td>
                    <td class="p-2 text-right">${escapeHtml(quantity)}</td>
                    <td class="p-2 text-right">${formatStatementMoney(denomination * quantity)}</td>
                </tr>`;
            }).join('')
            : '<tr><td colspan="3" class="p-3 text-center text-slate-500">No denomination details were returned.</td></tr>';

        const cashCountTotal = cashCountItems.reduce(
            (sum, item) => sum + Number(item.denomination || 0) * Number(item.quantity || 0),
            0
        );

        const cashCountNotes = String(statement?.cash_count_details?.notes || '').trim();
        const statementContentMarkup = statement?.statement_type === 'cash_count'
            ? `<div class="rounded-lg border border-slate-800 p-3"><p class="text-xs uppercase tracking-wide text-slate-500">Physical count details</p><div class="mt-2 overflow-x-auto rounded-lg border border-slate-800">
    <table class="w-full text-sm">
        <thead class="bg-slate-900 text-left text-xs text-slate-500">
            <tr>
                <th class="p-2">Denomination</th>
                <th class="p-2 text-right">Quantity</th>
                <th class="p-2 text-right">Subtotal</th>
            </tr>
        </thead>
        <tbody>${cashCountRows}</tbody>
        <tfoot class="border-t border-slate-700">
            <tr>
                <td colspan="2" class="p-2 font-semibold text-white">Physical total</td>
                <td class="p-2 text-right font-bold text-white">${formatStatementMoney(cashCountTotal)}</td>
            </tr>
        </tfoot>
    </table>
</div>
${cashCountNotes ? `<p class="mt-3 text-sm text-slate-400">Count notes: ${escapeHtml(cashCountNotes)}</p>` : ''}<p class="mt-2 text-xs text-slate-400">Cash count must equal the posted ledger closing balance before it can be submitted.</p></div>`
            : `<div class="overflow-x-auto rounded-lg border border-slate-800"><table class="w-full min-w-[980px] text-sm"><thead class="bg-slate-900 text-left text-xs text-slate-500"><tr><th class="p-2">Line</th><th>Date</th><th>Direction</th><th>Description</th><th class="text-right">Amount</th><th class="text-right">Matched</th><th class="text-right">Remaining</th><th>Action</th></tr></thead><tbody>${lineRows || '<tr><td colspan="8" class="p-4 text-center text-slate-500">No statement lines.</td></tr>'}</tbody></table></div>`;

        panel.innerHTML = `
            <div class="mb-4 flex flex-wrap items-start justify-between gap-3">
                <div><p class="bm-kicker">Selected workflow</p><h3 class="mt-1 text-base font-bold text-white">${escapeHtml(account?.display_name || 'Reconciliation')}</h3><p class="mt-1 text-xs text-slate-400">${escapeHtml(statement?.statement_number || '')} · ${formatDate(statement?.statement_start_date)} – ${formatDate(statement?.statement_end_date)}</p><div class="mt-2">${statusMarkup(rec.status)}</div></div>
                <div class="flex flex-wrap gap-2"><button type="button" data-action="close-workspace" class="rounded-lg border border-slate-700 px-3 py-2 text-xs text-slate-300">Close</button>${workflowActions}</div>
            </div>
            ${rec.return_reason ? `<div class="mb-3 rounded-lg border border-amber-900 bg-amber-950/20 p-3 text-sm text-amber-200"><strong>Returned:</strong> ${escapeHtml(rec.return_reason)}</div>` : ''}
            <div class="mb-4 grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4"><div class="rounded-lg bg-slate-900/70 p-3"><p class="text-xs text-slate-500">Statement opening</p><p class="mt-1 text-lg font-bold text-white">${formatStatementMoney(rec.statement_opening_balance)}</p></div><div class="rounded-lg bg-slate-900/70 p-3"><p class="text-xs text-slate-500">Ledger opening</p><p class="mt-1 text-lg font-bold text-white">${rec.ledger_opening_balance == null ? 'Not yet submitted' : formatStatementMoney(rec.ledger_opening_balance)}</p><p class="mt-1 text-xs ${openingDifference == null ? 'text-slate-500' : Math.abs(openingDifference) < 0.0001 ? 'text-emerald-300' : 'text-amber-300'}">Opening difference: ${openingDifference == null ? '—' : formatStatementMoney(openingDifference)}</p></div><div class="rounded-lg bg-slate-900/70 p-3"><p class="text-xs text-slate-500">Statement closing</p><p class="mt-1 text-lg font-bold text-white">${formatStatementMoney(rec.statement_closing_balance)}</p></div><div class="rounded-lg bg-slate-900/70 p-3"><p class="text-xs text-slate-500">Ledger closing</p><p class="mt-1 text-lg font-bold text-white">${rec.ledger_closing_balance == null ? 'Not yet submitted' : formatStatementMoney(rec.ledger_closing_balance)}</p><p class="mt-1 text-xs ${ledgerDifference == null ? 'text-slate-500' : Math.abs(ledgerDifference) < 0.0001 ? 'text-emerald-300' : 'text-amber-300'}">Closing difference: ${ledgerDifference == null ? '—' : formatStatementMoney(ledgerDifference)}</p></div></div>
            <div class="mt-5"><h4 class="mb-2 text-sm font-semibold text-white">${statement?.statement_type === 'cash_count' ? 'Physical cash count' : 'Statement lines'}</h4>${statementContentMarkup}</div>
            ${statement?.statement_type === 'cash_count' ? '' : `<div class="mt-5"><h4 class="mb-2 text-sm font-semibold text-white">Existing matches</h4><div class="overflow-x-auto rounded-lg border border-slate-800"><table class="w-full text-sm"><thead class="bg-slate-900 text-left text-xs text-slate-500"><tr><th class="p-2">Statement line</th><th>Journal line ID</th><th class="text-right">Matched amount</th><th>Action</th></tr></thead><tbody>${matchRows}</tbody></table></div></div>`}
            ${editable && statement?.statement_type !== 'cash_count' ? `<div class="mt-5"><h4 class="mb-1 text-sm font-semibold text-white">Match to posted ledger line</h4><p class="mb-2 text-xs text-slate-500">Select a statement line above, then match it to a posted ledger entry with the same bank movement direction. Unmatched entries from earlier completed periods may clear in this statement.</p><div class="mb-2 text-xs text-slate-400">Selected line remaining: <strong class="text-white">${selectedLine ? formatStatementMoney(selectedRemaining) : 'Select a statement line'}</strong></div><div class="overflow-x-auto rounded-lg border border-slate-800"><table class="w-full min-w-[850px] text-sm"><thead class="bg-slate-900 text-left text-xs text-slate-500"><tr><th class="p-2">Journal</th><th>Description</th><th>Side</th><th class="text-right">Available</th><th>Match amount</th></tr></thead><tbody>${candidateRows}</tbody></table></div>${state.candidateLines.length >= 1000 ? '<p class="mt-2 text-xs text-amber-300">Candidate list is capped at 1,000 rows. Refine account history or add pagination before production rollout.</p>' : ''}</div>` : ''}
            ${showCandidateReview && statement?.statement_type !== 'cash_count' ? `<div class="mt-5"><h4 class="mb-1 text-sm font-semibold text-white">Unmatched ledger entries — outstanding items</h4><p class="mb-2 text-xs text-slate-500">These posted ledger movements have not been matched to the imported bank/mobile-money statement. Their signed net should equal the ledger closing balance minus the statement closing balance. The database enforces this at approval.</p><div class="mb-3 rounded-lg border border-slate-800 bg-slate-900/50 p-3 text-xs text-slate-300"><span>Net outstanding ledger items (preview): <strong class="text-white">${formatStatementMoney(outstandingLedgerNetPreview)}</strong></span>${candidatePreviewCapped ? '<p class="mt-1 text-amber-300">This preview is incomplete because the candidate list is capped at 1,000 rows. The server-side approval calculation uses the full ledger.</p>' : `<p class="mt-1">Closing difference: <strong class="text-white">${ledgerDifference == null ? 'Not yet submitted' : formatStatementMoney(ledgerDifference)}</strong></p>`}</div><div class="overflow-x-auto rounded-lg border border-slate-800"><table class="w-full min-w-[850px] text-sm"><thead class="bg-slate-900 text-left text-xs text-slate-500"><tr><th class="p-2">Journal</th><th>Description</th><th>Side</th><th class="text-right">Unmatched amount</th><th>Review</th></tr></thead><tbody>${reviewOutstandingRows}</tbody></table></div>${state.candidateLines.length >= 1000 ? '<p class="mt-2 text-xs text-amber-300">Outstanding items are capped at 1,000 rows. Pagination is required before production rollout for high-volume accounts.</p>' : ''}</div>` : ''}
            <div class="mt-5 flex flex-wrap justify-end gap-2 text-xs text-slate-500"><span>Prepared: ${escapeHtml(rec.prepared_by || '—')}</span><span>Approved: ${escapeHtml(rec.approved_by || '—')}</span><span>Completed: ${escapeHtml(rec.completed_by || '—')}</span></div>`;
        panel.hidden = false;
    }

    async function openReconciliation(reconciliationId) {
        const rec = state.reconciliations.find((item) => item.id === reconciliationId);
        if (!rec) throw new Error('Reconciliation was not found in the current list. Refresh and try again.');
        state.selectedReconciliation = reconciliationId;
        const [statementLinesResult, matchesResult, candidatesResult] = await Promise.all([
            state.client.from('accounting_reconciliation_statement_lines')
                .select('*').eq('church_id', state.churchId).eq('statement_id', rec.statement_id).order('line_number', { ascending: true }),
            state.client.from('accounting_reconciliation_matches')
                .select('id,church_id,reconciliation_id,statement_line_id,journal_line_id,matched_amount,matched_by,created_at')
                .eq('church_id', state.churchId).eq('reconciliation_id', reconciliationId).order('created_at', { ascending: true }),
            (canManage() || canApprove())
                ? state.client.rpc('accounting_list_reconciliation_candidate_lines', { p_reconciliation_id: reconciliationId })
                : Promise.resolve({ data: [], error: null })
        ]);
        if (statementLinesResult.error) throw statementLinesResult.error;
        if (matchesResult.error) throw matchesResult.error;
        if (candidatesResult.error) throw candidatesResult.error;
        state.statementLines = statementLinesResult.data || [];
        state.matches = matchesResult.data || [];
        state.candidateLines = candidatesResult.data || [];
        const totals = new Map();
        state.matches.forEach((match) => totals.set(match.statement_line_id, (totals.get(match.statement_line_id) || 0) + Number(match.matched_amount)));
        const firstOpenLine = state.statementLines.find((line) => Number(line.amount) > (totals.get(line.id) || 0));
        state.selectedStatementLineId = firstOpenLine?.id || state.statementLines[0]?.id || null;
        renderWorkspace();
        $('rc-workspace')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    async function refreshOpenReconciliation() {
        const id = state.selectedReconciliation;
        await loadData();
        if (id && state.reconciliations.some((item) => item.id === id)) await openReconciliation(id);
    }

    async function runAction(action, id, button) {
        if (state.busy) return;
        setBusy(true);
        try {
            if (action === 'open-reconciliation') {
                await openReconciliation(id);
                return;
            }
            if (action === 'select-statement-line') {
                state.selectedStatementLineId = button.dataset.lineId;
                renderWorkspace();
                return;
            }
            if (action === 'close-workspace') {
                state.selectedReconciliation = null;
                $('rc-workspace').hidden = true;
                return;
            }
            if (action === 'create-reconciliation') {
                showCreatePanel(button.dataset.statementId);
                return;
            }
            if (action === 'void-statement') {
                const reason = window.prompt('Enter the reason for voiding this imported statement (10–500 characters):');
                if (!reason) return;
                const { error } = await state.client.rpc('accounting_void_reconciliation_statement', {
                    p_statement_id: button.dataset.statementId, p_reason: reason.trim()
                });
                if (error) throw error;
                showMessage('Imported statement voided.', 'success');
                await loadData();
                return;
            }
            if (action === 'match') {
                if (!canManage()) throw new Error('You do not have permission to match statement lines.');
                if (!state.selectedStatementLineId) throw new Error('Select a statement line first.');
                const amountInput = state.root.querySelector(`[data-match-amount="${CSS.escape(button.dataset.journalLineId)}"]`);
                const amount = Number(amountInput?.value);
                if (!Number.isFinite(amount) || amount <= 0) throw new Error('Enter a positive matching amount.');
                const { error } = await state.client.rpc('accounting_match_reconciliation_line', {
                    p_reconciliation_id: state.selectedReconciliation,
                    p_statement_line_id: state.selectedStatementLineId,
                    p_journal_line_id: button.dataset.journalLineId,
                    p_matched_amount: amount
                });
                if (error) throw error;
                await openReconciliation(state.selectedReconciliation);
                showMessage('Statement line matched to the posted ledger entry.', 'success');
                return;
            }
            if (action === 'unmatch') {
                const { error } = await state.client.rpc('accounting_unmatch_reconciliation_line', { p_match_id: button.dataset.matchId });
                if (error) throw error;
                await openReconciliation(state.selectedReconciliation);
                showMessage('Match removed.', 'success');
                return;
            }
            if (action === 'submit-reconciliation') {
                const { error } = await state.client.rpc('accounting_submit_reconciliation', { p_reconciliation_id: id });
                if (error) throw error;
                showMessage('Reconciliation submitted for independent approval.', 'success');
                await loadData(); await openReconciliation(id);
                return;
            }
            if (action === 'approve-reconciliation') {
                if (!window.confirm('Approve this reconciliation? The action will be recorded in the audit log.')) return;
                const { error } = await state.client.rpc('accounting_approve_reconciliation', { p_reconciliation_id: id });
                if (error) throw error;
                showMessage('Reconciliation approved.', 'success');
                await loadData(); await openReconciliation(id);
                return;
            }
            if (action === 'return-reconciliation') {
                const reason = window.prompt('Enter the reason for returning this reconciliation (10–500 characters):');
                if (!reason) return;
                const { error } = await state.client.rpc('accounting_return_reconciliation', {
                    p_reconciliation_id: id, p_reason: reason.trim()
                });
                if (error) throw error;
                showMessage('Reconciliation returned to its preparer.', 'success');
                await loadData(); await openReconciliation(id);
                return;
            }
            if (action === 'complete-reconciliation') {
                if (!window.confirm('Finalize this approved reconciliation?')) return;
                const { error } = await state.client.rpc('accounting_complete_reconciliation', { p_reconciliation_id: id });
                if (error) throw error;
                showMessage('Reconciliation completed and locked.', 'success');
                await loadData(); await openReconciliation(id);
                return;
            }
            if (action === 'cancel-reconciliation') {
                const reason = window.prompt('Enter the reason for cancelling this draft/returned reconciliation (10–500 characters):');
                if (!reason) return;
                const { error } = await state.client.rpc('accounting_cancel_reconciliation', {
                    p_reconciliation_id: id, p_reason: reason.trim()
                });
                if (error) throw error;
                showMessage('Reconciliation cancelled; its statement has been voided.', 'success');
                await loadData();
                if (state.selectedReconciliation === id) { state.selectedReconciliation = null; $('rc-workspace').hidden = true; }
                return;
            }
        } finally {
            setBusy(false);
        }
    }

    function bindEvents() {
        if (state.initialized) return;
        state.root.addEventListener('click', async (event) => {
            const button = event.target.closest('button[data-action], button[id]');
            if (!button || !state.root.contains(button)) return;
            try {
                if (button.id === 'rc-refresh') {
                    setBusy(true); await refreshOpenReconciliation(); setBusy(false); return;
                }
                if (button.id === 'rc-new-account') {
                    closePanels(); $('rc-account-panel').hidden = false; $('rc-account-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return;
                }
                if (button.id === 'rc-new-import') {
                    closePanels(); $('rc-import-panel').hidden = false; toggleImportType(); $('rc-import-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' }); return;
                }
                if (button.dataset.action === 'close-panels') { closePanels(); return; }
                if (button.dataset.action === 'add-denomination') {
                    state.cashItems.push({ denomination: 0, quantity: 0 }); renderCashRows(); return;
                }
                if (button.dataset.action === 'remove-denomination') {
                    const index = Number(button.closest('tr')?.dataset.cashIndex);
                    if (Number.isInteger(index)) state.cashItems.splice(index, 1);
                    renderCashRows(); return;
                }
                const id = button.dataset.reconciliationId;
                await runAction(button.dataset.action, id, button);
            } catch (error) {
                console.error('Reconciliation action failed:', error);
                showMessage(error.message || 'The reconciliation action could not be completed.', 'error');
                setBusy(false);
            }
        });

        state.root.addEventListener('submit', async (event) => {
            try {
                if (event.target.id === 'rc-account-form') { setBusy(true); await saveAccount(event); }
                else if (event.target.id === 'rc-import-form') { setBusy(true); await saveStatement(event); }
                else if (event.target.id === 'rc-create-form') { setBusy(true); await createReconciliation(event); }
            } catch (error) {
                console.error('Reconciliation form failed:', error);
                showMessage(error.message || 'The requested reconciliation data could not be saved.', 'error');
            } finally {
                setBusy(false);
            }
        });

        state.root.addEventListener('change', (event) => {
            if (event.target.id === 'rc-import-account') toggleImportType();
            if (event.target.matches('#rc-cash-rows input')) {
                const row = event.target.closest('tr[data-cash-index]');
                const index = Number(row?.dataset.cashIndex);
                if (Number.isInteger(index) && state.cashItems[index]) {
                    const field = event.target.dataset.field;
                    state.cashItems[index][field] = Number(event.target.value);
                    renderCashRows();
                }
            }
            if (event.target.id === 'rc-start-date' && state.accounts.find((item) => item.id === $('rc-import-account').value)?.account_kind === 'cash') {
                $('rc-end-date').value = event.target.value;
            }
            if (event.target.id === 'rc-create-statement') $('rc-create-period').innerHTML = periodOptions(event.target.value);
            if (event.target.id === 'rc-account-kind') {
                const isBank = event.target.value === 'bank';
                $('rc-institution-wrap').hidden = !isBank;
                $('rc-last4-wrap').hidden = !isBank;
                $('rc-ledger-account').innerHTML = ledgerAccountOptions();
            }
        });

        state.initialized = true;
    }

    async function init(context) {
        if (!context || !context.client || !context.churchId || !context.userId || !context.permissions) {
            throw new Error('Bank & cash reconciliation requires verified accounting context from the authorized dashboard.');
        }
        state.client = context.client;
        state.userId = context.userId;
        state.churchId = context.churchId;
        state.permissions = { ...context.permissions };
        state.currency = context.currency || null;

        if (!hasPermission(PERMISSIONS.read)) return false;
        createShell();
        if (!canManage()) {
            $('rc-new-account').hidden = true;
            $('rc-new-import').hidden = true;
        }
        bindEvents();
        resetCashItems();
        try {
            await loadData();
        } catch (error) {
            console.error('Reconciliation data failed to load:', error);
            showMessage(error.message || 'Reconciliation data could not be loaded. Check the database migration and assigned financial permissions.', 'error');
        }
        return true;
    }

    window.BelieversMeetAccountingReconciliation = Object.freeze({ init });
})();
