/*
 * BelieversMeet Accounting - Income & Expenditure Statement
 * Read-only presentation derived from the installed accounting_trial_balance RPC.
 * The RPC enforces church-scoped accounting.reports.read authorization and
 * returns functional-currency posted/reversal journal movements.
 */
(() => {
    'use strict';

    const panel = document.getElementById('income-expenditure-workspace');
    if (!panel) return;

    const $ = (id) => document.getElementById(id);
    const state = {
        client: null,
        churchId: null,
        permissions: {},
        functionalCurrency: null,
        currencyMeta: null,
        funds: [],
        rows: [],
        incomeRows: [],
        expenseRows: [],
        totalIncome: 0,
        totalExpense: 0,
        netResult: 0,
        lastParams: null,
        initialized: false,
        loading: false,
        fundWarning: null,
        isBalanced: null
    };

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
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit'
                }).formatToParts(new Date());
                const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
                return `${values.year}-${values.month}-${values.day}`;
            } catch (_) {
                // Use the browser's local date if the church timezone is unavailable.
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
        const target = $('income-expenditure-message');
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
        const runButton = $('income-expenditure-run');
        const exportButton = $('income-expenditure-export');
        if (runButton) {
            runButton.disabled = busy;
            runButton.textContent = busy ? 'Loading statement…' : 'Run statement';
        }
        if (exportButton) exportButton.disabled = busy || !state.rows.length;
    }

    function renderRows(targetId, rows, emptyMessage) {
        const target = $(targetId);
        if (!target) return;
        if (!rows.length) {
            target.innerHTML = `<tr><td colspan="3" class="px-3 py-5 text-center text-sm text-slate-400">${escapeHtml(emptyMessage)}</td></tr>`;
            return;
        }
        target.innerHTML = rows.map((row) => `
            <tr class="border-t border-slate-800/80 hover:bg-slate-800/30">
                <td class="whitespace-nowrap px-3 py-3 font-mono text-xs text-slate-300">${escapeHtml(row.account_code)}</td>
                <td class="min-w-40 px-3 py-3 font-medium text-white">${escapeHtml(row.account_name)}</td>
                <td class="whitespace-nowrap px-3 py-3 text-right tabular-nums text-slate-200">${escapeHtml(formatMoney(row.statement_amount))}</td>
            </tr>`).join('');
    }

    function render() {
        const currency = state.functionalCurrency || 'functional currency';
        const incomeTotal = $('income-expenditure-income-total');
        const expenseTotal = $('income-expenditure-expense-total');
        const resultAmount = $('income-expenditure-net-result');
        const resultLabel = $('income-expenditure-result-label');
        const summary = $('income-expenditure-summary');

        renderRows('income-expenditure-income-rows', state.incomeRows, 'No income activity for this period.');
        renderRows('income-expenditure-expense-rows', state.expenseRows, 'No expenditure activity for this period.');

        if (incomeTotal) incomeTotal.textContent = formatMoney(state.totalIncome);
        if (expenseTotal) expenseTotal.textContent = formatMoney(state.totalExpense);
        if (resultAmount) resultAmount.textContent = formatMoney(state.netResult);
        if (resultLabel) {
            resultLabel.textContent = state.netResult > 0
                ? 'Net surplus'
                : state.netResult < 0
                    ? 'Net deficit'
                    : 'Break-even';
        }

        if (summary) {
            const balanceText = state.isBalanced === true
                ? 'Underlying Trial Balance is balanced'
                : state.isBalanced === false
                    ? 'Warning: underlying Trial Balance is out of balance'
                    : 'Trial Balance balance status unavailable';
            const balanceClass = state.isBalanced === true
                ? 'text-emerald-300'
                : state.isBalanced === false
                    ? 'text-rose-300'
                    : 'text-slate-400';
            summary.innerHTML = `
                <div class="grid grid-cols-1 gap-3 sm:grid-cols-3">
                    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                        <p class="text-xs font-medium text-slate-400">Total income</p>
                        <p class="mt-2 text-xl font-bold tabular-nums text-white">${escapeHtml(formatMoney(state.totalIncome))}</p>
                    </div>
                    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                        <p class="text-xs font-medium text-slate-400">Total expenditure</p>
                        <p class="mt-2 text-xl font-bold tabular-nums text-white">${escapeHtml(formatMoney(state.totalExpense))}</p>
                    </div>
                    <div class="rounded-xl border border-slate-800 bg-slate-900/60 p-4">
                        <p class="text-xs font-medium text-slate-400">Net result · ${escapeHtml(currency)}</p>
                        <p class="mt-2 text-xl font-bold tabular-nums ${state.netResult >= 0 ? 'text-emerald-300' : 'text-rose-300'}">${escapeHtml(formatMoney(state.netResult))}</p>
                    </div>
                </div>
                <p class="mt-3 text-xs ${balanceClass}">${balanceText}</p>`;
        }

        const exportButton = $('income-expenditure-export');
        if (exportButton) exportButton.disabled = !state.rows.length || state.loading;
    }

    async function loadFunds() {
        const filterWrap = $('income-expenditure-fund-filter');
        if (!hasPermission('accounting.funds.read')) {
            if (filterWrap) filterWrap.classList.add('hidden');
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
        const select = $('income-expenditure-fund');
        if (!select) return;
        select.innerHTML = '<option value="">All funds</option>' + state.funds.map((fund) =>
            `<option value="${escapeHtml(fund.id)}">${escapeHtml(fund.fund_code)} — ${escapeHtml(fund.fund_name)}</option>`
        ).join('');
    }

    async function loadStatement() {
        if (state.loading) return;
        const startDate = $('income-expenditure-start')?.value || '';
        const endDate = $('income-expenditure-end')?.value || '';
        const fundId = hasPermission('accounting.funds.read')
            ? ($('income-expenditure-fund')?.value || null)
            : null;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
            setMessage('Choose a valid start date and end date.', 'error');
            return;
        }
        if (startDate > endDate) {
            setMessage('The start date must be on or before the end date.', 'error');
            return;
        }

        setBusy(true);
        setMessage('Calculating income and expenditure from posted journal activity…');
        try {
            const { data, error } = await state.client.rpc('accounting_trial_balance', {
                p_church_id: state.churchId,
                p_start_date: startDate,
                p_end_date: endDate,
                p_fund_id: fundId
            });
            if (error) throw error;

            state.rows = Array.isArray(data) ? data : [];
            const accounts = state.rows.filter((row) => row.row_kind === 'account');
            const totalRow = state.rows.find((row) => row.row_kind === 'total') || null;
            state.incomeRows = accounts
                .filter((row) => row.account_type === 'income')
                .map((row) => ({
                    ...row,
                    statement_amount: Number(row.period_credits || 0) - Number(row.period_debits || 0)
                }))
                .filter((row) => row.statement_amount !== 0);
            state.expenseRows = accounts
                .filter((row) => row.account_type === 'expense')
                .map((row) => ({
                    ...row,
                    statement_amount: Number(row.period_debits || 0) - Number(row.period_credits || 0)
                }))
                .filter((row) => row.statement_amount !== 0);

            state.totalIncome = state.incomeRows.reduce((sum, row) => sum + row.statement_amount, 0);
            state.totalExpense = state.expenseRows.reduce((sum, row) => sum + row.statement_amount, 0);
            state.netResult = state.totalIncome - state.totalExpense;
            state.isBalanced = typeof totalRow?.is_balanced === 'boolean' ? totalRow.is_balanced : null;
            state.lastParams = { startDate, endDate, fundId };
            render();

            if (state.fundWarning) {
                setMessage(state.fundWarning, 'warning');
            } else if (state.isBalanced === false) {
                setMessage('Statement calculated, but the underlying Trial Balance is out of balance. Review the ledger before relying on this report.', 'error');
            } else {
                setMessage('Income & Expenditure Statement loaded successfully.', 'success');
            }
        } catch (error) {
            state.rows = [];
            state.incomeRows = [];
            state.expenseRows = [];
            state.totalIncome = 0;
            state.totalExpense = 0;
            state.netResult = 0;
            state.isBalanced = null;
            state.lastParams = null;
            render();
            setMessage(`Income & Expenditure Statement could not be loaded: ${error?.message || 'Unknown error'}`, 'error');
        } finally {
            setBusy(false);
        }
    }

    function csvCell(value) {
        if (typeof value === 'number' && Number.isFinite(value)) return String(value);
        let text = String(value ?? '');
        if (/^[\s\t\r]*[=+\-@]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
    }

    function exportCsv() {
        if (!state.rows.length || !state.lastParams) return;

        const totalRow = state.rows.find((row) => row.row_kind === 'total') || null;
        const firstAccountRow = state.rows.find((row) => row.row_kind === 'account') || null;
        const functionalCurrency = totalRow?.functional_currency
            || firstAccountRow?.functional_currency
            || state.functionalCurrency
            || '';
        const selectedFund = state.lastParams.fundId
            ? state.funds.find((fund) => String(fund.id) === String(state.lastParams.fundId)) || null
            : null;
        const fundScope = state.lastParams.fundId
            ? (selectedFund
                ? `${selectedFund.fund_code} — ${selectedFund.fund_name}`
                : 'Selected fund (metadata unavailable)')
            : 'All funds';

        // Repeat report context on every row so the CSV remains self-describing
        // when filtered, sorted, or imported into another accounting tool.
        const reportMetadata = [
            state.lastParams.startDate,
            state.lastParams.endDate,
            fundScope,
            state.lastParams.fundId || '',
            selectedFund?.fund_code || '',
            selectedFund?.fund_name || '',
            functionalCurrency
        ];
        const headers = [
            'report_start_date', 'report_end_date', 'fund_scope', 'fund_id',
            'fund_code', 'fund_name', 'functional_currency', 'section',
            'account_code', 'account_name', 'account_type',
            'period_debits', 'period_credits', 'statement_amount'
        ];
        const lines = [headers.map(csvCell).join(',')];
        const appendRows = (section, rows) => rows.forEach((row) => {
            lines.push([
                ...reportMetadata,
                section,
                row.account_code,
                row.account_name,
                row.account_type,
                Number(row.period_debits || 0),
                Number(row.period_credits || 0),
                row.statement_amount
            ].map(csvCell).join(','));
        });
        const appendSummary = (section, amount) => {
            lines.push([
                ...reportMetadata,
                section,
                '', '', '', '', '', amount
            ].map(csvCell).join(','));
        };

        appendRows('Income', state.incomeRows);
        appendRows('Expenditure', state.expenseRows);
        appendSummary('Total income', state.totalIncome);
        appendSummary('Total expenditure', state.totalExpense);
        appendSummary(
            state.netResult > 0 ? 'Net surplus'
                : state.netResult < 0 ? 'Net deficit' : 'Break-even',
            state.netResult
        );

        const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `income-expenditure-${state.lastParams.startDate}-to-${state.lastParams.endDate}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    async function init(context) {
        if (state.initialized) return;
        if (!context?.client || typeof context.client.rpc !== 'function' || !context.churchId) {
            throw new Error('The authenticated accounting context was not supplied to the Income & Expenditure module.');
        }
        state.client = context.client;
        state.churchId = context.churchId;
        state.permissions = context.permissions || {};
        state.functionalCurrency = context.functionalCurrency || context.currency || null;
        state.currencyMeta = context.currencyMeta || null;

        if (!hasPermission('accounting.reports.read')) {
            panel.classList.add('hidden');
            return;
        }

        const today = todayISO(context.timezoneName);
        const fiscalStartMonthValue = Number(context.fiscalYearStartMonth || 1);
        const fiscalStartMonth = Number.isInteger(fiscalStartMonthValue) && fiscalStartMonthValue >= 1 && fiscalStartMonthValue <= 12
            ? fiscalStartMonthValue
            : 1;
        const currentMonth = Number(today.slice(5, 7));
        const fiscalStartYear = Number(today.slice(0, 4)) - (currentMonth < fiscalStartMonth ? 1 : 0);
        const yearStart = `${fiscalStartYear}-${String(fiscalStartMonth).padStart(2, '0')}-01`;
        $('income-expenditure-start').value = yearStart;
        $('income-expenditure-end').value = today;

        $('income-expenditure-form')?.addEventListener('submit', (event) => {
            event.preventDefault();
            loadStatement();
        });
        $('income-expenditure-export')?.addEventListener('click', exportCsv);

        try {
            await loadFunds();
        } catch (error) {
            state.fundWarning = `Fund filter could not be loaded (${error?.message || 'Unknown error'}). The statement can still be run for all funds.`;
        }

        state.initialized = true;
        setMessage(state.fundWarning || 'Choose a date range and run the statement. The installed report function includes posted and reversed journals, so posted reversal entries are reflected in period movements.', state.fundWarning ? 'warning' : 'info');
    }

    window.BelieversMeetAccountingIncomeExpenditure = Object.freeze({ init });
})();
