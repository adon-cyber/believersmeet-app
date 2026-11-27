/*
 * BelieversMeet Accounting — period-end FX valuation workspace.
 * Reads immutable run/item snapshots through church-scoped RLS. All state
 * transitions use the reviewed Tranche 5 RPCs; journal posting/reversal use
 * the existing Tranche 4B journal lifecycle RPCs.
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
        nativeMulticurrencyEnabled: false,
        runs: [],
        periods: [],
        selectedRunId: null,
        items: [],
        busy: false
    };

    const RUN_COLUMNS = [
        'id', 'church_id', 'accounting_period_id', 'valuation_date', 'functional_currency',
        'status', 'revision', 'prepared_by', 'submitted_by', 'approved_by',
        'generated_journal_id', 'reversal_journal_id', 'supersedes_run_id',
        'superseded_by_run_id', 'reason', 'calculated_at', 'calculated_by',
        'submitted_at', 'approved_at', 'posted_at', 'cancelled_at', 'created_at', 'updated_at'
    ].join(',');

    const ITEM_COLUMNS = [
        'id', 'church_id', 'valuation_run_id', 'position_id', 'position_version_snapshot',
        'ledger_account_id', 'fund_id', 'currency_code', 'native_balance',
        'functional_carrying_amount', 'unrealized_gain_account_id', 'unrealized_loss_account_id',
        'closing_rate_id', 'closing_rate_snapshot', 'closing_rate_effective_date',
        'target_functional_amount', 'adjustment_amount', 'generated_journal_line_id', 'created_at'
    ].join(',');

    const hasPermission = (key) => state.permissions[key] === true;
    const root = () => document.getElementById('fx-valuation-workspace');

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[char]);
    }

    function formatDate(value) {
        if (!value) return '—';
        const date = new Date(`${String(value).slice(0, 10)}T00:00:00`);
        return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, {
            day: 'numeric', month: 'short', year: 'numeric'
        }).format(date);
    }

    function isValidISODate(value) {
        if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
        const [year, month, day] = value.split('-').map(Number);
        if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
        const candidate = new Date(0);
        candidate.setUTCHours(0, 0, 0, 0);
        candidate.setUTCFullYear(year, month - 1, day);
        return candidate.getUTCFullYear() === year
            && candidate.getUTCMonth() === month - 1
            && candidate.getUTCDate() === day;
    }

    function formatDateTime(value) {
        if (!value) return '—';
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? '—' : new Intl.DateTimeFormat(undefined, {
            day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit'
        }).format(date);
    }

    function money(value, currency) {
        if (!state.currencyMeta) return `${Number(value || 0).toLocaleString()} ${currency || ''}`.trim();
        return state.currencyMeta.format(value, currency);
    }

    function shortId(value) {
        return value ? `${String(value).slice(0, 8)}…` : '—';
    }

    function setMessage(message, kind = 'info') {
        const host = root()?.querySelector('[data-fxv-message]');
        if (!host) return;
        const styles = {
            info: 'border-slate-700 bg-slate-900/70 text-slate-300',
            success: 'border-emerald-800 bg-emerald-950/30 text-emerald-200',
            warning: 'border-amber-800 bg-amber-950/30 text-amber-200',
            error: 'border-rose-800 bg-rose-950/30 text-rose-200'
        };
        host.className = `mb-4 rounded-lg border px-4 py-3 text-sm ${styles[kind] || styles.info}`;
        host.textContent = message;
        host.hidden = !message;
    }

    function selectedRun() {
        return state.runs.find((run) => run.id === state.selectedRunId) || null;
    }

    function canManage() {
        return hasPermission('accounting.fx_valuation.manage');
    }

    function canPrepare() {
        return canManage() && state.nativeMulticurrencyEnabled;
    }

    function renderShell() {
        const section = document.createElement('section');
        section.id = 'fx-valuation-workspace';
        section.className = 'bm-card rounded-2xl p-5 sm:p-6';
        section.innerHTML = `<div class="mb-5 flex flex-wrap items-start justify-between gap-3">
            <div><p class="bm-kicker">Period-end controls</p><h2 class="mt-1 text-lg font-bold text-white">Foreign-currency valuation</h2>
                <p class="mt-2 max-w-3xl text-sm leading-6 text-slate-400">Review foreign cash, bank and mobile-money positions at period end. Each run snapshots native balances, functional carrying values, fund mappings and approved closing rates. Posted valuation journals remain immutable; corrections use later revisions.</p>
            </div>
            <button type="button" data-fxv-action="refresh" class="rounded-lg border border-slate-700 px-3 py-2 text-xs font-semibold text-slate-200 hover:bg-slate-800">Refresh valuations</button>
        </div>
        <div data-fxv-message hidden class="mb-4 rounded-lg border px-4 py-3 text-sm" role="status" aria-live="polite"></div>
        <div data-fxv-gate class="mb-4"></div>
        <div class="mb-5 grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
            <form data-fxv-prepare-form class="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
                <h3 class="text-sm font-bold text-white">Prepare period-end run</h3>
                <label class="mt-3 block text-xs font-semibold text-slate-300">Open accounting period
                    <select name="period_id" required class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white"><option value="">Loading open periods…</option></select>
                </label>
                <label class="mt-3 block text-xs font-semibold text-slate-300">Reason <span class="font-normal text-slate-500">(10–500 characters)</span>
                    <textarea name="reason" required minlength="10" maxlength="500" rows="3" class="mt-1 w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2.5 text-sm text-white" placeholder="Period-end revaluation for the approved closing rates…"></textarea>
                </label>
                <button type="submit" class="mt-3 rounded-lg bg-blue-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-blue-500 disabled:opacity-50">Prepare valuation</button>
                <p class="mt-2 text-xs leading-5 text-slate-500">The selected period must remain open. The valuation date is fixed to that period’s end date.</p>
            </form>
            <div class="rounded-xl border border-slate-700 bg-slate-900/60 p-4">
                <h3 class="text-sm font-bold text-white">Workflow and controls</h3>
                <ol class="mt-3 grid gap-2 text-xs leading-5 text-slate-400 sm:grid-cols-2">
                    <li><span class="font-semibold text-slate-200">1. Prepare & calculate</span><br>Snapshot ledger positions and approved closing rates.</li>
                    <li><span class="font-semibold text-slate-200">2. Submit & approve</span><br>Approver must differ from preparer and submitter.</li>
                    <li><span class="font-semibold text-slate-200">3. Generate & post</span><br>Generated journal is approved by the server; posting is separate.</li>
                    <li><span class="font-semibold text-slate-200">4. Restate or reverse</span><br>Use append-only revisions and exact-snapshot reversal workflow.</li>
                </ol>
                <p class="mt-4 border-t border-slate-800 pt-3 text-xs leading-5 text-slate-500">A zero-adjustment run completes without a journal. A posted valuation may only be reversed through the existing journal reversal permission and approval process.</p>
            </div>
        </div>
        <div class="overflow-hidden rounded-xl border border-slate-800">
            <div class="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 bg-slate-900/60 px-4 py-3"><h3 class="text-sm font-semibold text-white">Valuation history</h3><span data-fxv-count class="text-xs text-slate-500">Loading…</span></div>
            <div class="bm-scroll overflow-x-auto"><table class="bm-table min-w-full text-sm"><thead class="bg-slate-950/80"><tr><th>Period end</th><th>Revision</th><th>Status</th><th>Functional currency</th><th>Prepared / approved</th><th>Generated journal</th><th>Action</th></tr></thead><tbody data-fxv-runs><tr><td colspan="7" class="px-4 py-8 text-center text-sm text-slate-500">Loading valuation history…</td></tr></tbody></table></div>
        </div>
        <div data-fxv-detail class="mt-5"></div>
        <p class="mt-4 text-xs leading-5 text-slate-500">Run and item snapshots are read-only in the browser. All status changes use the Tranche 5 valuation RPCs or existing Tranche 4B journal lifecycle RPCs. This workspace does not calculate or post accounting entries in the browser.</p>`;
        const footer = document.querySelector('#dashboard-content footer');
        if (footer?.parentNode) footer.parentNode.insertBefore(section, footer);
        else document.getElementById('dashboard-content')?.appendChild(section);
    }

    async function loadPeriods() {
        if (!hasPermission('accounting.periods.read')) {
            state.periods = [];
            return;
        }
        const { data, error } = await state.client.from('accounting_periods')
            .select('id,start_date,end_date,status')
            .eq('church_id', state.churchId)
            .eq('status', 'open')
            .order('end_date', { ascending: false });
        if (error) throw new Error(`Open accounting periods could not be loaded: ${error.message}`);
        state.periods = Array.isArray(data) ? data : [];
        renderPeriods();
    }

    function renderPeriods() {
        const select = root()?.querySelector('[name="period_id"]');
        if (!select) return;
        const options = state.periods.map((period) => `<option value="${escapeHtml(period.id)}">${escapeHtml(formatDate(period.start_date))} – ${escapeHtml(formatDate(period.end_date))}</option>`).join('');
        select.innerHTML = `<option value="">${state.periods.length ? 'Choose an open period' : 'No open periods available'}</option>${options}`;
        select.disabled = !canPrepare() || !state.periods.length;
        const submit = root()?.querySelector('[data-fxv-prepare-form] button[type="submit"]');
        if (submit) submit.disabled = !canPrepare() || !state.periods.length;
    }

    function renderGate() {
        const host = root()?.querySelector('[data-fxv-gate]');
        if (!host) return;
        if (!state.nativeMulticurrencyEnabled) {
            host.innerHTML = '<div class="rounded-lg border border-amber-800 bg-amber-950/25 px-4 py-3 text-sm text-amber-100">The native multicurrency feature gate is currently disabled. New valuation runs cannot be prepared; authorized users can still finish or cancel already-created runs according to their permissions.</div>';
        } else if (!hasPermission('accounting.fx_valuation.manage') && !hasPermission('accounting.fx_valuation.approve')) {
            host.innerHTML = '<div class="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">You have read-only access to FX valuation history.</div>';
        } else {
            host.innerHTML = '<div class="rounded-lg border border-slate-700 bg-slate-900/60 px-4 py-3 text-sm text-slate-300">Valuation actions are permission-checked again by the server. Separate preparer, approver and journal-poster duties are preserved.</div>';
        }
        const form = root()?.querySelector('[data-fxv-prepare-form]');
        if (form) form.hidden = !hasPermission('accounting.fx_valuation.manage');
        renderPeriods();
    }

    function runActions(run) {
        const actions = [];
        if (run.status === 'draft' && run.prepared_by === state.userId && canManage()) {
            actions.push(['calculate', 'Calculate', 'blue']);
        }
        if (run.status === 'calculated' && run.prepared_by === state.userId && canManage()) {
            actions.push(['submit', 'Submit for approval', 'blue']);
        }
        if (run.status === 'submitted' && hasPermission('accounting.fx_valuation.approve') && run.prepared_by !== state.userId && run.submitted_by !== state.userId) {
            actions.push(['approve', 'Approve', 'green']);
        }
        if (run.status === 'approved' && canManage()) {
            const items = state.selectedRunId === run.id ? state.items : [];
            if (items.length && items.every((item) => Number(item.adjustment_amount) === 0)) {
                actions.push(['complete-zero', 'Complete · no adjustment', 'green']);
            } else if (!items.length) {
                actions.push(['open', 'Review items', 'slate']);
            } else {
                actions.push(['generate-journal', 'Generate journal', 'blue']);
            }
        }
        if (run.status === 'journal_created' && run.generated_journal_id && hasPermission('accounting.journals.post')) {
            actions.push(['post-journal', 'Post generated journal', 'green']);
        }
        if (['draft', 'calculated', 'submitted', 'approved', 'journal_created'].includes(run.status) && canManage()) {
            actions.push(['cancel', 'Cancel run', 'rose']);
        }
        if (run.status === 'posted' && run.generated_journal_id && hasPermission('accounting.journals.reverse')) {
            actions.push(['reverse', 'Request reversal', 'amber']);
        }
        return actions.map(([action, label, tone]) => `<button type="button" data-fxv-action="${action}" data-run-id="${escapeHtml(run.id)}" class="rounded-md border px-2.5 py-1.5 text-xs font-semibold ${tone === 'green' ? 'border-emerald-800 text-emerald-200 hover:bg-emerald-950/40' : tone === 'rose' ? 'border-rose-900 text-rose-200 hover:bg-rose-950/40' : tone === 'amber' ? 'border-amber-800 text-amber-200 hover:bg-amber-950/40' : tone === 'blue' ? 'border-blue-700 text-blue-200 hover:bg-blue-950/40' : 'border-slate-600 text-slate-200 hover:bg-slate-800'}">${label}</button>`).join(' ');
    }

    function renderRuns() {
        const body = root()?.querySelector('[data-fxv-runs]');
        const count = root()?.querySelector('[data-fxv-count]');
        if (!body) return;
        if (count) count.textContent = `${state.runs.length} run${state.runs.length === 1 ? '' : 's'} loaded`;
        if (!state.runs.length) {
            body.innerHTML = '<tr><td colspan="7" class="px-4 py-8 text-center text-sm text-slate-500">No period-end FX valuations are recorded for this church.</td></tr>';
            return;
        }
        body.innerHTML = state.runs.map((run) => `<tr class="border-t border-slate-800 ${run.id === state.selectedRunId ? 'bg-slate-900/70' : ''}">
            <td class="px-3 py-3"><button type="button" data-fxv-action="open" data-run-id="${escapeHtml(run.id)}" class="font-semibold text-blue-200 hover:underline">${escapeHtml(formatDate(run.valuation_date))}</button><div class="mt-1 text-xs text-slate-500">Period ${escapeHtml(shortId(run.accounting_period_id))}</div></td>
            <td class="px-3 py-3 text-slate-200">${escapeHtml(run.revision)}</td>
            <td class="px-3 py-3"><span class="rounded-full border border-slate-700 px-2 py-1 text-xs text-slate-200">${escapeHtml(run.status.replaceAll('_', ' '))}</span></td>
            <td class="px-3 py-3 text-slate-200">${escapeHtml(run.functional_currency)}</td>
            <td class="px-3 py-3 text-xs text-slate-400">Maker ${escapeHtml(shortId(run.prepared_by))}<br>Checker ${escapeHtml(shortId(run.approved_by))}</td>
            <td class="px-3 py-3 text-xs text-slate-300">${run.generated_journal_id ? escapeHtml(shortId(run.generated_journal_id)) : '—'}${run.reversal_journal_id ? `<div class="text-slate-500">Reversal ${escapeHtml(shortId(run.reversal_journal_id))}</div>` : ''}</td>
            <td class="px-3 py-3"><div class="flex flex-wrap gap-1.5">${runActions(run) || '<span class="text-xs text-slate-500">No action</span>'}</div></td>
        </tr>`).join('');
    }

    function renderDetail() {
        const host = root()?.querySelector('[data-fxv-detail]');
        if (!host) return;
        const run = selectedRun();
        if (!run) {
            host.innerHTML = '';
            return;
        }
        const totals = state.items.reduce((acc, item) => {
            acc.adjustment += Number(item.adjustment_amount || 0);
            acc.nativeCount += 1;
            return acc;
        }, { adjustment: 0, nativeCount: 0 });
        const rows = state.items.map((item) => `<tr class="border-t border-slate-800">
            <td class="px-3 py-3"><span class="font-semibold text-white">${escapeHtml(item.currency_code)}</span><div class="mt-1 text-xs text-slate-500">Account ${escapeHtml(shortId(item.ledger_account_id))} · Fund ${escapeHtml(shortId(item.fund_id))}</div></td>
            <td class="px-3 py-3 text-right tabular-nums text-slate-200">${escapeHtml(money(item.native_balance, item.currency_code))}</td>
            <td class="px-3 py-3 text-right tabular-nums text-slate-300">${escapeHtml(money(item.functional_carrying_amount, run.functional_currency))}</td>
            <td class="px-3 py-3 text-right tabular-nums text-slate-300">${escapeHtml(String(item.closing_rate_snapshot))}<div class="text-xs text-slate-500">${escapeHtml(formatDate(item.closing_rate_effective_date))}</div></td>
            <td class="px-3 py-3 text-right tabular-nums text-slate-300">${escapeHtml(money(item.target_functional_amount, run.functional_currency))}</td>
            <td class="px-3 py-3 text-right tabular-nums ${Number(item.adjustment_amount) < 0 ? 'text-amber-200' : Number(item.adjustment_amount) > 0 ? 'text-emerald-200' : 'text-slate-400'}">${escapeHtml(money(item.adjustment_amount, run.functional_currency))}</td>
        </tr>`).join('');
        host.innerHTML = `<div class="rounded-xl border border-slate-800">
            <div class="flex flex-wrap items-start justify-between gap-3 border-b border-slate-800 bg-slate-900/60 px-4 py-3"><div><p class="text-xs font-bold uppercase tracking-widest text-slate-500">Valuation run · revision ${escapeHtml(run.revision)}</p><h3 class="mt-1 text-base font-bold text-white">${escapeHtml(formatDate(run.valuation_date))} · ${escapeHtml(run.functional_currency)}</h3><p class="mt-1 text-xs text-slate-400">Status: ${escapeHtml(run.status.replaceAll('_', ' '))} · Reason: ${escapeHtml(run.reason)}</p></div><div class="text-right text-xs text-slate-500">Calculated ${escapeHtml(formatDateTime(run.calculated_at))}<br>Approved ${escapeHtml(formatDateTime(run.approved_at))}<br>Posted ${escapeHtml(formatDateTime(run.posted_at))}</div></div>
            <div class="grid gap-3 border-b border-slate-800 p-4 sm:grid-cols-3"><div><p class="text-xs text-slate-500">Positions included</p><p class="mt-1 text-lg font-bold text-white">${totals.nativeCount}</p></div><div><p class="text-xs text-slate-500">Net adjustment · informational total</p><p class="mt-1 text-lg font-bold text-white">${escapeHtml(money(totals.adjustment, run.functional_currency))}</p></div><div><p class="text-xs text-slate-500">Supersedes</p><p class="mt-1 text-sm font-semibold text-white">${escapeHtml(shortId(run.supersedes_run_id))}</p></div></div>
            <div class="bm-scroll overflow-x-auto"><table class="bm-table min-w-full text-sm"><thead class="bg-slate-950/80"><tr><th>Position</th><th class="text-right">Native balance</th><th class="text-right">Functional carrying</th><th class="text-right">Closing rate</th><th class="text-right">Target functional</th><th class="text-right">Adjustment</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="px-4 py-8 text-center text-sm text-slate-500">No valuation items have been calculated yet.</td></tr>'}</tbody></table></div>
            <div class="border-t border-slate-800 px-4 py-3 text-xs leading-5 text-slate-500">The net adjustment shown is informational only. Posting creates separately mapped gain/loss lines per account and fund; do not post or book this aggregate manually.</div>
        </div>`;
    }

    async function loadRuns() {
        const { data, error } = await state.client.from('accounting_fx_valuation_runs')
            .select(RUN_COLUMNS)
            .eq('church_id', state.churchId)
            .order('valuation_date', { ascending: false })
            .order('revision', { ascending: false })
            .limit(100);
        if (error) throw new Error(`FX valuation history could not be loaded: ${error.message}`);
        state.runs = Array.isArray(data) ? data : [];
        if (state.selectedRunId && !state.runs.some((run) => run.id === state.selectedRunId)) {
            state.selectedRunId = null;
            state.items = [];
        }
        renderRuns();
        renderDetail();
    }

    async function loadItems(runId) {
        const { data, error } = await state.client.from('accounting_fx_valuation_items')
            .select(ITEM_COLUMNS)
            .eq('church_id', state.churchId)
            .eq('valuation_run_id', runId)
            .order('currency_code', { ascending: true })
            .order('ledger_account_id', { ascending: true })
            .order('fund_id', { ascending: true });
        if (error) throw new Error(`FX valuation item snapshots could not be loaded: ${error.message}`);
        state.items = Array.isArray(data) ? data : [];
        state.selectedRunId = runId;
        renderRuns();
        renderDetail();
    }

    async function refreshAll() {
        await Promise.all([loadPeriods(), loadRuns()]);
        if (state.selectedRunId) await loadItems(state.selectedRunId);
    }

    async function rpc(name, args) {
        const { data, error } = await state.client.rpc(name, args);
        if (error) throw new Error(error.message);
        return data;
    }

    async function promptReason(title) {
        const reason = window.prompt(title);
        if (reason === null) return null;
        const clean = reason.trim();
        if (clean.length < 10 || clean.length > 500) throw new Error('Reason must contain 10–500 characters.');
        return clean;
    }

    async function handleAction(button) {
        const action = button.dataset.fxvAction;
        const runId = button.dataset.runId;
        if (action === 'refresh') {
            await refreshAll();
            setMessage('FX valuation history and open periods refreshed.', 'info');
            return;
        }
        if (!runId) throw new Error('The selected valuation run is missing.');
        const run = state.runs.find((item) => item.id === runId);
        if (!run) throw new Error('The selected valuation run is no longer available. Refresh and try again.');
        if (action === 'open') {
            await loadItems(runId);
            return;
        }
        if (action === 'calculate') {
            const count = await rpc('accounting_calculate_fx_valuation', { p_run_id: runId });
            await loadRuns();
            await loadItems(runId);
            setMessage(`Valuation calculated for ${Number(count)} foreign account/fund position(s). Review every snapshot before submitting.`, 'success');
        } else if (action === 'submit') {
            if (!window.confirm('Submit this calculated valuation for independent approval?')) return;
            await rpc('accounting_submit_fx_valuation', { p_run_id: runId });
            await loadRuns();
            setMessage('Valuation submitted for independent approval.', 'success');
        } else if (action === 'approve') {
            if (!window.confirm('Approve this valuation after reviewing the immutable position and rate snapshots?')) return;
            await rpc('accounting_approve_fx_valuation', { p_run_id: runId });
            await loadRuns();
            setMessage('Valuation approved. The next step is journal generation or no-adjustment completion.', 'success');
        } else if (action === 'generate-journal') {
            const journalId = await rpc('accounting_create_fx_valuation_journal', { p_run_id: runId });
            await loadRuns();
            await loadItems(runId);
            setMessage(`Approved valuation journal created (${shortId(journalId)}). It is server-approved; authorized journal posting is a separate step.`, 'success');
        } else if (action === 'complete-zero') {
            if (!window.confirm('Complete this approved valuation without a journal because every position adjustment is zero?')) return;
            await rpc('accounting_complete_fx_valuation_no_adjustment', { p_run_id: runId });
            await loadRuns();
            setMessage('Valuation completed with no adjustment journal.', 'success');
        } else if (action === 'post-journal') {
            if (!run.generated_journal_id) throw new Error('The generated journal identifier is unavailable.');
            if (!window.confirm('Post the approved FX valuation journal? This updates the functional carrying values of the foreign account/fund positions.')) return;
            await rpc('accounting_post_journal', { p_journal_id: run.generated_journal_id });
            await loadRuns();
            await loadItems(runId);
            setMessage('FX valuation journal posted. The server has updated the position carrying values and run status.', 'success');
        } else if (action === 'cancel') {
            const reason = await promptReason('Why is this unposted valuation run being cancelled? (10–500 characters)');
            if (!reason) return;
            if (!window.confirm('Cancel this unposted valuation? Any generated but unposted valuation journal will be voided by the server.')) return;
            await rpc('accounting_cancel_fx_valuation', { p_run_id: runId, p_reason: reason });
            await loadRuns();
            setMessage('Unposted valuation run cancelled. Its history has been retained.', 'success');
        } else if (action === 'reverse') {
            if (run.status !== 'posted' || !run.generated_journal_id) throw new Error('Only the current posted valuation journal can be reversed.');
            const date = window.prompt('Reversal date (YYYY-MM-DD). Must be on or after the valuation date and inside an open accounting period:');
            if (date === null) return;
            if (!isValidISODate(date)) throw new Error('Enter a real calendar date in YYYY-MM-DD format.');
            if (date < String(run.valuation_date).slice(0, 10)) throw new Error('Reversal date cannot precede the original valuation date.');
            const reason = await promptReason('Why is this posted FX valuation being reversed? (10–500 characters)');
            if (!reason) return;
            if (!window.confirm('Request an exact-snapshot reversal of this posted valuation journal? The reversal journal will require independent approval and posting before the valuation is marked reversed.')) return;
            const reversalId = await rpc('accounting_reverse_journal', {
                p_journal_id: run.generated_journal_id,
                p_reversal_date: date,
                p_reason: reason
            });
            await loadRuns();
            setMessage(`Exact-snapshot reversal submitted (${shortId(reversalId)}). The valuation remains posted until the reversal journal is independently approved and posted.`, 'success');
        }
    }

    async function prepareRun(form) {
        if (!canPrepare()) throw new Error('FX valuation preparation requires the manage permission and an enabled native multicurrency feature gate.');
        const formData = new FormData(form);
        const periodId = String(formData.get('period_id') || '');
        const reason = String(formData.get('reason') || '').trim();
        if (!periodId) throw new Error('Choose an open accounting period.');
        if (reason.length < 10 || reason.length > 500) throw new Error('Reason must contain 10–500 characters.');
        const period = state.periods.find((item) => item.id === periodId);
        if (!period || period.status !== 'open') throw new Error('The selected period is no longer open. Refresh and choose an open period.');
        if (!window.confirm(`Prepare a new period-end FX valuation for ${formatDate(period.end_date)}? The server will snapshot foreign-currency cash, bank and mobile-money positions.`)) return;
        const runId = await rpc('accounting_prepare_fx_valuation', {
            p_church_id: state.churchId,
            p_period_id: periodId,
            p_reason: reason
        });
        form.reset();
        await loadRuns();
        await loadItems(runId);
        setMessage('Draft valuation prepared. The next step is to calculate and review the immutable snapshots.', 'success');
    }

    function bindEvents() {
        const host = root();
        if (!host || host.dataset.bound === 'true') return;
        host.dataset.bound = 'true';
        host.addEventListener('submit', async (event) => {
            if (!event.target.matches('[data-fxv-prepare-form]') || state.busy) return;
            event.preventDefault();
            state.busy = true;
            try {
                await prepareRun(event.target);
            } catch (error) {
                setMessage(error.message || 'Valuation preparation failed.', 'error');
            } finally {
                state.busy = false;
            }
        });
        host.addEventListener('click', async (event) => {
            const button = event.target.closest('[data-fxv-action]');
            if (!button || button.disabled || state.busy) return;
            state.busy = true;
            button.disabled = true;
            try {
                await handleAction(button);
            } catch (error) {
                setMessage(error.message || 'FX valuation action failed.', 'error');
            } finally {
                state.busy = false;
                button.disabled = false;
            }
        });
    }

    async function init(context) {
        if (!context?.client || !context?.churchId || !context?.userId || !context?.permissions) {
            throw new Error('FX valuation requires verified Accounting context.');
        }
        state.client = context.client;
        state.userId = context.userId;
        state.churchId = context.churchId;
        state.permissions = { ...context.permissions };
        state.currencyMeta = context.currencyMeta || null;
        state.functionalCurrency = String(context.functionalCurrency || '').toUpperCase() || null;
        state.nativeMulticurrencyEnabled = context.nativeMulticurrencyEnabled === true;
        if (!hasPermission('accounting.fx_valuation.read')) return false;
        if (!state.currencyMeta) throw new Error('ISO precision metadata is unavailable; FX valuation display is disabled.');
        renderShell();
        bindEvents();
        renderGate();
        try {
            await refreshAll();
        } catch (error) {
            setMessage(error.message || 'FX valuation workspace could not be loaded.', 'error');
            throw error;
        }
        return true;
    }

    window.BelieversMeetAccountingFxValuation = Object.freeze({ init });
})();
