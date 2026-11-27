/*
 * BelieversMeet Accounting - Statement of Financial Position
 * Read-only report built from the secured accounting_trial_balance RPC.
 * Includes ledger net assets plus operating results not yet transferred by a formal closing journal.
 */
(() => {
    'use strict';

    const panel = document.getElementById('financial-position-workspace');
    if (!panel) return;

    const $ = (id) => document.getElementById(id);
    const state = {
        client: null,
        churchId: null,
        permissions: {},
        functionalCurrency: null,
        currencyMeta: null,
        timezoneName: null,
        funds: [],
        accountMap: new Map(),
        rows: [],
        report: null,
        lastParams: null,
        initialized: false,
        loading: false,
        fundWarning: null
    };

    const EPSILON = 0.000001;
    const ALL_HISTORY_START = '0001-01-01';

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, (character) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        })[character]);
    }

    function hasPermission(key) {
        return state.permissions[key] === true;
    }

    function localDateISO(date) {
        const year = date.getFullYear();
        const month = String(date.getMonth() + 1).padStart(2, '0');
        const day = String(date.getDate()).padStart(2, '0');
        return `${year}-${month}-${day}`;
    }

    function todayISO(timezoneName) {
        if (timezoneName) {
            try {
                const parts = new Intl.DateTimeFormat('en-CA', {
                    timeZone: timezoneName,
                    year: 'numeric', month: '2-digit', day: '2-digit'
                }).formatToParts(new Date());
                const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
                return `${values.year}-${values.month}-${values.day}`;
            } catch (_) {
                // Fall back to the browser's local date if the church timezone is unavailable.
            }
        }
        return localDateISO(new Date());
    }

    function formatMoney(value) {
        const amount = Number(value ?? 0);
        const currency = String(state.functionalCurrency || '').trim().toUpperCase();
        if (!Number.isFinite(amount)) return '—';
        if (!/^[A-Z]{3}$/.test(currency)) return amount.toLocaleString();
        try {
            if (state.currencyMeta && typeof state.currencyMeta.format === 'function') {
                return state.currencyMeta.format(amount, currency);
            }
            return new Intl.NumberFormat(undefined, { style: 'currency', currency }).format(amount);
        } catch (_) {
            return `${amount.toLocaleString()} ${currency}`;
        }
    }

    function setMessage(message, kind = 'info') {
        const target = $('financial-position-message');
        if (!target) return;
        if (!message) {
            target.className = 'hidden';
            target.textContent = '';
            return;
        }
        const classes = kind === 'error'
            ? 'border-rose-800 bg-rose-950/30 text-rose-200'
            : kind === 'warning'
                ? 'border-amber-800 bg-amber-950/25 text-amber-100'
                : kind === 'success'
                    ? 'border-emerald-800 bg-emerald-950/25 text-emerald-200'
                    : 'border-blue-800 bg-blue-950/25 text-blue-100';
        target.className = `mt-4 rounded-lg border px-3 py-2 text-sm ${classes}`;
        target.textContent = message;
    }

    function setBusy(busy) {
        state.loading = busy;
        const runButton = $('financial-position-run');
        const exportButton = $('financial-position-export');
        if (runButton) {
            runButton.disabled = busy;
            runButton.textContent = busy ? 'Loading statement…' : 'Run statement';
        }
        if (exportButton) exportButton.disabled = busy || !state.report;
    }

    function signedBalance(row, accountType) {
        const debit = Number(row.closing_debit || 0);
        const credit = Number(row.closing_credit || 0);
        if (accountType === 'asset' || accountType === 'expense') return debit - credit;
        return credit - debit;
    }

    function sum(rows) {
        return rows.reduce((total, row) => total + row.balance, 0);
    }

    function accountPath(accountId) {
        if (!state.accountMap.size || !accountId) return '';
        const parts = [];
        let current = state.accountMap.get(accountId);
        const seen = new Set();
        while (current?.parent_account_id && !seen.has(current.id)) {
            seen.add(current.id);
            const parent = state.accountMap.get(current.parent_account_id);
            if (!parent) break;
            parts.unshift(`${parent.account_code} ${parent.account_name}`);
            current = parent;
        }
        return parts.join(' / ');
    }

    function prepareRows(accountRows) {
        const mapRows = (type) => accountRows
            .filter((row) => row.account_type === type)
            .map((row) => ({
                account_id: row.account_id,
                account_code: row.account_code,
                account_name: row.account_name,
                balance: signedBalance(row, type),
                path: accountPath(row.account_id)
            }))
            .filter((row) => Math.abs(row.balance) > EPSILON)
            .sort((a, b) => String(a.account_code || '').localeCompare(String(b.account_code || '')));

        const assets = mapRows('asset');
        const liabilities = mapRows('liability');
        const netAssetAccounts = mapRows('net_assets');
        const incomeAccounts = mapRows('income');
        const expenseAccounts = mapRows('expense');

        const totalAssets = sum(assets);
        const totalLiabilities = sum(liabilities);
        const recordedNetAssets = sum(netAssetAccounts);
        const unclosedIncome = sum(incomeAccounts);
        const unclosedExpenditure = sum(expenseAccounts);
        const unclosedOperatingResult = unclosedIncome - unclosedExpenditure;
        const totalNetAssets = recordedNetAssets + unclosedOperatingResult;
        const liabilitiesAndNetAssets = totalLiabilities + totalNetAssets;
        const difference = totalAssets - liabilitiesAndNetAssets;
        const totalRow = state.rows.find((row) => row.row_kind === 'total') || null;
        const trialBalanceBalanced = totalRow?.is_balanced === true;
        const statementBalanced = Math.abs(difference) <= EPSILON;

        return {
            assets,
            liabilities,
            netAssetAccounts,
            incomeAccounts,
            expenseAccounts,
            totalAssets,
            totalLiabilities,
            recordedNetAssets,
            unclosedIncome,
            unclosedExpenditure,
            unclosedOperatingResult,
            totalNetAssets,
            liabilitiesAndNetAssets,
            difference,
            trialBalanceBalanced,
            statementBalanced,
            isBalanced: trialBalanceBalanced && statementBalanced
        };
    }

    function renderAccountRows(targetId, rows, emptyText) {
        const target = $(targetId);
        if (!target) return;
        if (!rows.length) {
            target.innerHTML = `<tr><td colspan="3" class="px-3 py-5 text-center text-sm text-slate-400">${escapeHtml(emptyText)}</td></tr>`;
            return;
        }
        target.innerHTML = rows.map((row) => `
            <tr class="border-t border-slate-800/80 hover:bg-slate-800/30">
                <td class="whitespace-nowrap px-3 py-3 font-mono text-xs text-slate-300">${escapeHtml(row.account_code)}</td>
                <td class="min-w-48 px-3 py-3 font-medium text-white">
                    ${escapeHtml(row.account_name)}
                    ${row.path ? `<span class="mt-1 block text-xs font-normal text-slate-500">${escapeHtml(row.path)}</span>` : ''}
                </td>
                <td class="whitespace-nowrap px-3 py-3 text-right tabular-nums">${escapeHtml(formatMoney(row.balance))}</td>
            </tr>`).join('');
    }

    function render() {
        const report = state.report;
        if (!report) {
            renderAccountRows('financial-position-asset-rows', [], 'Run the statement to view asset balances.');
            renderAccountRows('financial-position-liability-rows', [], 'No liability balances were returned.');
            renderAccountRows('financial-position-net-asset-rows', [], 'No recorded net asset balances were returned.');
            return;
        }

        renderAccountRows('financial-position-asset-rows', report.assets, 'No asset balances at this date.');
        renderAccountRows('financial-position-liability-rows', report.liabilities, 'No liability balances at this date.');

        const netRows = report.netAssetAccounts.slice();
        if (Math.abs(report.unclosedOperatingResult) > EPSILON) {
            netRows.push({
                account_code: '—',
                account_name: 'Unclosed operating results (income less expenditure)',
                path: 'Not yet transferred through a formal closing journal',
                balance: report.unclosedOperatingResult
            });
        }
        renderAccountRows('financial-position-net-asset-rows', netRows, 'No recorded net asset balances or unclosed operating results.');

        const setText = (id, value) => {
            const target = $(id);
            if (target) target.textContent = formatMoney(value);
        };
        setText('financial-position-assets-total', report.totalAssets);
        setText('financial-position-liabilities-total', report.totalLiabilities);
        setText('financial-position-net-assets-total', report.totalNetAssets);
        setText('financial-position-liabilities-net-assets-total', report.liabilitiesAndNetAssets);
        setText('financial-position-difference', report.difference);
        setText('financial-position-operating-income', report.unclosedIncome);
        setText('financial-position-operating-expenditure', report.unclosedExpenditure);
        setText('financial-position-operating-result', report.unclosedOperatingResult);

        const badge = $('financial-position-status');
        if (badge) {
            if (report.isBalanced) {
                badge.className = 'inline-flex rounded-full border border-emerald-800 bg-emerald-950/30 px-3 py-1 text-xs font-semibold text-emerald-200';
                badge.textContent = 'Statement reconciles';
            } else {
                badge.className = 'inline-flex rounded-full border border-rose-800 bg-rose-950/30 px-3 py-1 text-xs font-semibold text-rose-200';
                badge.textContent = 'Reconciliation requires review';
            }
        }

        const summary = $('financial-position-summary');
        if (summary) {
            summary.innerHTML = `
                <div class="mb-4 flex flex-wrap items-center justify-between gap-3">
                    <div class="text-sm text-slate-300">
                        <span class="font-semibold text-white">Statement as at ${escapeHtml(state.lastParams?.asOfDate)}</span>
                        <span class="mx-2 text-slate-600">·</span>${escapeHtml(state.functionalCurrency || 'Currency unavailable')}
                        <span class="mx-2 text-slate-600">·</span>${escapeHtml(state.lastParams?.fundLabel || 'All funds')}
                    </div>
                    <span id="financial-position-status-copy" class="text-xs text-slate-400">${report.trialBalanceBalanced ? 'Underlying Trial Balance is balanced.' : 'Underlying Trial Balance did not confirm balanced totals.'}</span>
                </div>
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
                    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><p class="text-xs font-medium text-slate-400">Total assets</p><p class="mt-2 text-xl font-bold tabular-nums text-white">${escapeHtml(formatMoney(report.totalAssets))}</p></div>
                    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><p class="text-xs font-medium text-slate-400">Total liabilities</p><p class="mt-2 text-xl font-bold tabular-nums text-white">${escapeHtml(formatMoney(report.totalLiabilities))}</p></div>
                    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><p class="text-xs font-medium text-slate-400">Net assets incl. unclosed results</p><p class="mt-2 text-xl font-bold tabular-nums text-white">${escapeHtml(formatMoney(report.totalNetAssets))}</p></div>
                    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4"><p class="text-xs font-medium text-slate-400">Difference</p><p class="mt-2 text-xl font-bold tabular-nums ${report.isBalanced ? 'text-emerald-300' : 'text-rose-300'}">${escapeHtml(formatMoney(report.difference))}</p></div>
                </div>`;
        }

        const exportButton = $('financial-position-export');
        if (exportButton) exportButton.disabled = state.loading || !state.rows.length;
    }

    async function loadFunds() {
        const wrapper = $('financial-position-fund-filter');
        if (!hasPermission('accounting.funds.read')) {
            if (wrapper) wrapper.classList.add('hidden');
            return;
        }
        const { data, error } = await state.client
            .from('accounting_funds')
            .select('id, fund_code, fund_name')
            .eq('church_id', state.churchId)
            .eq('is_active', true)
            .order('fund_code', { ascending: true });
        if (error) {
            state.fundWarning = `Fund filter could not be loaded (${error.message}). The statement can still be run for all funds.`;
            return;
        }
        state.funds = Array.isArray(data) ? data : [];
        const select = $('financial-position-fund');
        if (select) {
            select.innerHTML = '<option value="">All funds</option>' + state.funds.map((fund) =>
                `<option value="${escapeHtml(fund.id)}">${escapeHtml(fund.fund_code)} — ${escapeHtml(fund.fund_name)}</option>`
            ).join('');
        }
    }

    async function loadAccountHierarchy() {
        if (!hasPermission('accounting.accounts.read')) return;
        const { data, error } = await state.client
            .from('accounting_accounts')
            .select('id, parent_account_id, account_code, account_name')
            .eq('church_id', state.churchId);
        if (!error && Array.isArray(data)) {
            state.accountMap = new Map(data.map((account) => [account.id, account]));
        }
    }

    function selectedFundInfo(fundId) {
        if (!fundId) return { fundLabel: 'All funds', fundCode: '', fundName: '' };
        const fund = state.funds.find((item) => item.id === fundId);
        if (!fund) return { fundLabel: 'Selected fund', fundCode: '', fundName: '' };
        return {
            fundLabel: `${fund.fund_code} — ${fund.fund_name}`,
            fundCode: fund.fund_code || '',
            fundName: fund.fund_name || ''
        };
    }

    async function loadStatement() {
        if (state.loading) return;
        const asOfDate = $('financial-position-as-of')?.value || '';
        const fundId = hasPermission('accounting.funds.read') ? ($('financial-position-fund')?.value || null) : null;
        if (!/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
            setMessage('Choose a valid statement date.', 'error');
            return;
        }
        const selectedFund = selectedFundInfo(fundId);
        setBusy(true);
        setMessage('Loading posted journal activity and reversal history through the statement date…');
        try {
            const { data, error } = await state.client.rpc('accounting_trial_balance', {
                p_church_id: state.churchId,
                p_start_date: ALL_HISTORY_START,
                p_end_date: asOfDate,
                p_fund_id: fundId
            });
            if (error) throw error;
            state.rows = Array.isArray(data) ? data : [];
            const accountRows = state.rows.filter((row) => row.row_kind === 'account');
            const totalRow = state.rows.find((row) => row.row_kind === 'total') || null;
            if (!totalRow) throw new Error('The underlying Trial Balance did not return its totals row.');

            state.report = prepareRows(accountRows);
            state.lastParams = { asOfDate, fundId, ...selectedFund };
            render();

            if (state.fundWarning) {
                setMessage(state.fundWarning, 'warning');
            } else if (!state.report.trialBalanceBalanced || !state.report.statementBalanced) {
                setMessage('The Statement of Financial Position does not reconcile. Review the account balances and underlying Trial Balance before relying on this statement.', 'error');
            } else {
                setMessage('Statement of Financial Position loaded and reconciled successfully.', 'success');
            }
        } catch (error) {
            state.rows = [];
            state.report = null;
            state.lastParams = null;
            render();
            setMessage(`Statement of Financial Position could not be loaded: ${error?.message || 'Unknown error'}`, 'error');
        } finally {
            setBusy(false);
            if (state.report) render();
        }
    }

    function csvCell(value) {
        // Preserve numeric negatives as numeric CSV values; sanitize only text cells against formula injection.
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        if (typeof value === 'boolean') return value ? 'TRUE' : 'FALSE';
        let text = String(value ?? '');
        if (/^[\s\t\r]*[=+@-]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
    }

    function exportCsv() {
        if (!state.report || !state.lastParams) return;
        const meta = state.lastParams;
        const headers = [
            'statement_as_of', 'fund_scope', 'fund_id', 'fund_code', 'fund_name',
            'functional_currency', 'section', 'account_code', 'account_name', 'balance',
            'total_assets', 'total_liabilities', 'recorded_net_assets',
            'unclosed_income', 'unclosed_expenditure', 'unclosed_operating_result',
            'total_net_assets_including_unclosed_results', 'liabilities_and_net_assets',
            'difference', 'trial_balance_balanced', 'statement_balanced'
        ];
        const metadata = [
            meta.asOfDate, meta.fundLabel, meta.fundId || '', meta.fundCode, meta.fundName,
            state.functionalCurrency || ''
        ];
        const lines = [headers.map(csvCell).join(',')];
        const append = (section, rows) => rows.forEach((row) => {
            const values = [
                ...metadata, section, row.account_code, row.account_name, row.balance,
                state.report.totalAssets, state.report.totalLiabilities, state.report.recordedNetAssets,
                state.report.unclosedIncome, state.report.unclosedExpenditure,
                state.report.unclosedOperatingResult, state.report.totalNetAssets,
                state.report.liabilitiesAndNetAssets, state.report.difference,
                state.report.trialBalanceBalanced, state.report.isBalanced
            ];
            lines.push(values.map(csvCell).join(','));
        });
        append('Assets', state.report.assets);
        append('Liabilities', state.report.liabilities);
        append('Net assets', state.report.netAssetAccounts);
        if (Math.abs(state.report.unclosedOperatingResult) > EPSILON) {
            append('Unclosed operating results', [{
                account_code: '',
                account_name: 'Income less expenditure not transferred through a formal closing journal',
                balance: state.report.unclosedOperatingResult
            }]);
        }
        const summaryRows = [
            ['TOTAL ASSETS', state.report.totalAssets],
            ['TOTAL LIABILITIES', state.report.totalLiabilities],
            ['RECORDED NET ASSETS', state.report.recordedNetAssets],
            ['UNCLOSED OPERATING RESULT', state.report.unclosedOperatingResult],
            ['TOTAL NET ASSETS INCLUDING UNCLOSED RESULTS', state.report.totalNetAssets],
            ['TOTAL LIABILITIES AND NET ASSETS', state.report.liabilitiesAndNetAssets],
            ['BALANCE DIFFERENCE', state.report.difference]
        ];
        summaryRows.forEach(([label, amount]) => {
            const values = [
                ...metadata, 'Summary', '', label, amount,
                state.report.totalAssets, state.report.totalLiabilities, state.report.recordedNetAssets,
                state.report.unclosedIncome, state.report.unclosedExpenditure,
                state.report.unclosedOperatingResult, state.report.totalNetAssets,
                state.report.liabilitiesAndNetAssets, state.report.difference,
                state.report.trialBalanceBalanced, state.report.isBalanced
            ];
            lines.push(values.map(csvCell).join(','));
        });
        const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `statement-of-financial-position-as-at-${meta.asOfDate}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    async function init(context) {
        if (state.initialized) return;
        if (!context?.client || typeof context.client.rpc !== 'function' || !context.churchId) {
            throw new Error('The authenticated accounting context was not supplied to the Financial Position module.');
        }
        state.client = context.client;
        state.churchId = context.churchId;
        state.permissions = context.permissions || {};
        state.functionalCurrency = context.functionalCurrency || context.currency || null;
        state.currencyMeta = context.currencyMeta || null;
        state.timezoneName = context.timezoneName || null;

        if (!hasPermission('accounting.reports.read')) {
            panel.classList.add('hidden');
            return;
        }

        $('financial-position-as-of').value = todayISO(state.timezoneName);
        $('financial-position-form')?.addEventListener('submit', (event) => {
            event.preventDefault();
            loadStatement();
        });
        $('financial-position-export')?.addEventListener('click', exportCsv);

        try {
            await Promise.all([loadFunds(), loadAccountHierarchy()]);
        } catch (error) {
            state.fundWarning = `Optional report lookups could not be loaded (${error?.message || 'Unknown error'}). The statement can still be run.`;
        }
        state.initialized = true;
        setMessage(state.fundWarning || 'Choose an as-of date and run the statement. Posted journal activity and reversal history are included.', state.fundWarning ? 'warning' : 'info');
    }

    window.BelieversMeetAccountingFinancialPosition = Object.freeze({ init });
})();
