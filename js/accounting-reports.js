/*
 * BelieversMeet Accounting - Financial Reports
 * Trial Balance read-only report. The installed RPC enforces church/report access.
 */
(() => {
    'use strict';

    const panel = document.getElementById('trial-balance-workspace');
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
        lastParams: null,
        initialized: false,
        loading: false,
        fundWarning: null
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
                // Fall back to the browser's local date when the church timezone is unavailable.
            }
        }
        return localDateISO(new Date());
    }

    function formatMoney(value, currency) {
        const amount = Number(value ?? 0);
        const code = String(currency || state.functionalCurrency || '').trim().toUpperCase();
        if (!Number.isFinite(amount)) return '—';
        if (!/^[A-Z]{3}$/.test(code)) return amount.toLocaleString();
        try {
            if (state.currencyMeta && typeof state.currencyMeta.format === 'function') {
                return state.currencyMeta.format(amount, code);
            }
            // Intl uses the currency's ISO 4217 minor-unit precision; no local precision table.
            return new Intl.NumberFormat(undefined, {
                style: 'currency',
                currency: code
            }).format(amount);
        } catch (_) {
            return `${amount.toLocaleString()} ${code}`;
        }
    }

    function setMessage(message, kind = 'info') {
        const target = $('trial-balance-message');
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
        target.className = `mb-4 rounded-lg border px-3 py-2 text-sm ${classes}`;
        target.textContent = message;
    }

    function setBusy(busy) {
        state.loading = busy;
        const runButton = $('trial-balance-run');
        const exportButton = $('trial-balance-export');
        if (runButton) {
            runButton.disabled = busy;
            runButton.textContent = busy ? 'Loading report…' : 'Run report';
        }
        if (exportButton) exportButton.disabled = busy || !state.rows.length;
    }

    function render() {
        const body = $('trial-balance-rows');
        const summary = $('trial-balance-summary');
        if (!body || !summary) return;

        const accountRows = state.rows.filter((row) => row.row_kind !== 'total');
        const totalRow = state.rows.find((row) => row.row_kind === 'total') || null;
        const currency = totalRow?.functional_currency
            || accountRows[0]?.functional_currency
            || state.functionalCurrency;

        if (!state.rows.length) {
            body.innerHTML = '<tr><td colspan="9" class="px-4 py-8 text-center text-slate-400">No Trial Balance rows were returned for this date range.</td></tr>';
            summary.textContent = 'No report data';
            if ($('trial-balance-export')) $('trial-balance-export').disabled = true;
            return;
        }

        const balanced = totalRow?.is_balanced;
        const balanceLabel = balanced === true
            ? '<span class="rounded-full border border-emerald-800 bg-emerald-950/30 px-3 py-1 text-xs font-semibold text-emerald-200">Debits equal credits</span>'
            : balanced === false
                ? '<span class="rounded-full border border-rose-800 bg-rose-950/30 px-3 py-1 text-xs font-semibold text-rose-200">Out of balance</span>'
                : '<span class="rounded-full border border-slate-700 px-3 py-1 text-xs text-slate-300">Balance status unavailable</span>';

        summary.innerHTML = `
            <div class="flex flex-wrap items-center justify-between gap-3">
                <div class="text-sm text-slate-300">
                    <span class="font-semibold text-white">${accountRows.length}</span> accounts
                    <span class="mx-2 text-slate-600">·</span>
                    ${escapeHtml(state.lastParams?.startDate)} to ${escapeHtml(state.lastParams?.endDate)}
                    <span class="mx-2 text-slate-600">·</span>
                    ${escapeHtml(currency || 'Currency unavailable')}
                </div>
                ${balanceLabel}
            </div>`;

        const cell = (value) => `<td class="whitespace-nowrap px-3 py-3 text-right tabular-nums">${escapeHtml(formatMoney(value, currency))}</td>`;
        const accountHtml = accountRows.map((row) => `
            <tr class="border-t border-slate-800/80 hover:bg-slate-800/30">
                <td class="whitespace-nowrap px-3 py-3 font-mono text-xs text-slate-300">${escapeHtml(row.account_code)}</td>
                <td class="min-w-48 px-3 py-3 font-medium text-white">${escapeHtml(row.account_name)}</td>
                <td class="whitespace-nowrap px-3 py-3 text-xs capitalize text-slate-400">${escapeHtml(String(row.account_type || '').replaceAll('_', ' '))}</td>
                ${cell(row.opening_debit)}
                ${cell(row.opening_credit)}
                ${cell(row.period_debits)}
                ${cell(row.period_credits)}
                ${cell(row.closing_debit)}
                ${cell(row.closing_credit)}
            </tr>`).join('');

        const totalHtml = totalRow ? `
            <tr class="border-t-2 border-slate-600 bg-slate-800/70 font-bold text-white">
                <td colspan="3" class="px-3 py-3">Total</td>
                ${cell(totalRow.opening_debit)}
                ${cell(totalRow.opening_credit)}
                ${cell(totalRow.period_debits)}
                ${cell(totalRow.period_credits)}
                ${cell(totalRow.closing_debit)}
                ${cell(totalRow.closing_credit)}
            </tr>` : '';

        body.innerHTML = accountHtml + totalHtml;
        if ($('trial-balance-export')) $('trial-balance-export').disabled = false;
    }

    async function loadFunds() {
        const filterWrap = $('trial-balance-fund-filter');
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
            state.fundWarning = `Fund filter could not be loaded (${error.message}). The report can still be run for all funds.`;
            return;
        }

        state.funds = Array.isArray(data) ? data : [];
        const select = $('trial-balance-fund');
        if (!select) return;
        select.innerHTML = '<option value="">All funds</option>' + state.funds.map((fund) =>
            `<option value="${escapeHtml(fund.id)}">${escapeHtml(fund.fund_code)} — ${escapeHtml(fund.fund_name)}</option>`
        ).join('');
    }

    async function loadReport() {
        if (state.loading) return;
        const startDate = $('trial-balance-start')?.value || '';
        const endDate = $('trial-balance-end')?.value || '';
        const fundId = hasPermission('accounting.funds.read') ? ($('trial-balance-fund')?.value || null) : null;

        if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate) || !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) {
            setMessage('Choose a valid start date and end date.', 'error');
            return;
        }
        if (startDate > endDate) {
            setMessage('The start date must be on or before the end date.', 'error');
            return;
        }

        setBusy(true);
        setMessage('Loading the Trial Balance from posted journal activity…');
        try {
            const { data, error } = await state.client.rpc('accounting_trial_balance', {
                p_church_id: state.churchId,
                p_start_date: startDate,
                p_end_date: endDate,
                p_fund_id: fundId
            });
            if (error) throw error;
            state.rows = Array.isArray(data) ? data : [];
            state.lastParams = { startDate, endDate, fundId };
            render();
            const totalRow = state.rows.find((row) => row.row_kind === 'total');
            if (state.fundWarning) {
                setMessage(state.fundWarning, 'warning');
            } else if (!state.rows.length) {
                setMessage('The report returned no rows for this date range.', 'info');
            } else if (totalRow?.is_balanced === false) {
                setMessage('The Trial Balance is not balanced. Review the returned balances before relying on this report.', 'error');
            } else {
                setMessage('Trial Balance loaded successfully.', 'success');
            }
        } catch (error) {
            state.rows = [];
            state.lastParams = null;
            render();
            setMessage(`Trial Balance could not be loaded: ${error?.message || 'Unknown error'}`, 'error');
        } finally {
            setBusy(false);
        }
    }

    function csvText(value) {
        let text = String(value ?? '');
        if (/^[\s\t\r]*[=+@-]/.test(text)) text = `'${text}`;
        return `"${text.replace(/"/g, '""')}"`;
    }

    function exportCsv() {
        if (!state.rows.length || !state.lastParams) return;
        const headers = [
            'row_kind', 'account_code', 'account_name', 'account_type', 'normal_balance',
            'functional_currency', 'opening_debit', 'opening_credit', 'period_debits',
            'period_credits', 'closing_debit', 'closing_credit', 'is_balanced'
        ];
        const lines = [headers.map(csvText).join(',')];
        state.rows.forEach((row) => {
            lines.push(headers.map((key) => {
                const value = row[key];
                return typeof value === 'number' ? String(value) : csvText(value);
            }).join(','));
        });
        const blob = new Blob(['\uFEFF' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `trial-balance-${state.lastParams.startDate}-to-${state.lastParams.endDate}.csv`;
        document.body.appendChild(anchor);
        anchor.click();
        anchor.remove();
        URL.revokeObjectURL(url);
    }

    async function init(context) {
        if (state.initialized) return;
        if (!context?.client || typeof context.client.rpc !== 'function' || !context.churchId) {
            throw new Error('The authenticated accounting context was not supplied to the reports module.');
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
        const fiscalStartMonth = Number(context.fiscalYearStartMonth || 1);
        const currentMonth = Number(today.slice(5, 7));
        const fiscalStartYear = Number(today.slice(0, 4)) - (currentMonth < fiscalStartMonth ? 1 : 0);
        const yearStart = `${fiscalStartYear}-${String(fiscalStartMonth).padStart(2, '0')}-01`;
        $('trial-balance-start').value = yearStart;
        $('trial-balance-end').value = today;

        $('trial-balance-form')?.addEventListener('submit', (event) => {
            event.preventDefault();
            loadReport();
        });
        $('trial-balance-export')?.addEventListener('click', exportCsv);

        try {
            await loadFunds();
        } catch (error) {
            state.fundWarning = `Fund filter could not be loaded (${error?.message || 'Unknown error'}). The report can still be run for all funds.`;
        }

        state.initialized = true;
        setMessage(state.fundWarning || 'Select a date range and run the report. Only posted journal activity is included.', state.fundWarning ? 'warning' : 'info');
    }

    window.BelieversMeetAccountingReports = Object.freeze({ init });
})();
