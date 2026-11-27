(() => {
    "use strict";

    let loading = false;

    let latestSubscriptionRows = [];
    let trialExtensionRpcAvailable = false;
    let activeTrialExtension = null;
    let trialExtensionSubmitting = false;
    let trialExtensionPreviousFocus = null;

    const getElement = (id) => document.getElementById(id);

    const escapeHTML = (value) => String(value ?? "").replace(
        /[&<>"']/g,
        (character) => ({
            "&": "&amp;",
            "<": "&lt;",
            ">": "&gt;",
            '"': "&quot;",
            "'": "&#39;"
        })[character]
    );

    const setText = (id, value) => {
        const element = getElement(id);
        if (element) element.textContent = String(value ?? "—");
    };

    const formatDate = (value) => {
        if (!value) return "—";

        const date = new Date(value);
        if (Number.isNaN(date.getTime())) return "—";

        return new Intl.DateTimeFormat("en-UG", {
            dateStyle: "medium",
            timeStyle: "short",
            timeZone: "Africa/Kampala"
        }).format(date);
    };

    const formatPeriodEnd = (row) => {
        if (row.current_period_end) {
            return formatDate(row.current_period_end);
        }

        if (
            String(row.subscription_status || "").toLowerCase() === "trial"
        ) {
            return "Not started (trial)";
        }

        return "Not recorded";
    };
    const formatMoney = (value, currency) => {
        if (value === null || value === undefined || value === "") {
            return "—";
        }

        const amount = Number(value);
        if (!Number.isFinite(amount)) return "—";

        const digits = currency === "UGX" || currency === "TZS" ? 0 : 2;

        return `${escapeHTML(currency || "")} ${new Intl.NumberFormat(
            "en-UG",
            {
                minimumFractionDigits: digits,
                maximumFractionDigits: digits
            }
        ).format(amount)}`;
    };

    const statusBadge = (value) => {
        const status = String(value || "unknown").toLowerCase();

        const styles = {
            trial: "bg-blue-100 text-blue-800",
            active: "bg-green-100 text-green-800",
            completed: "bg-green-100 text-green-800",
            paid: "bg-green-100 text-green-800",
            exempt: "bg-purple-100 text-purple-800",
            past_due: "bg-amber-100 text-amber-800",
            overdue: "bg-amber-100 text-amber-800",
            issued: "bg-blue-100 text-blue-800",
            pending: "bg-amber-100 text-amber-800",
            suspended: "bg-red-100 text-red-800",
            cancelled: "bg-gray-100 text-gray-700",
            failed: "bg-red-100 text-red-800",
            refunded: "bg-purple-100 text-purple-800",
            void: "bg-gray-100 text-gray-700",
            draft: "bg-gray-100 text-gray-700"
        };

        return `<span class="inline-flex px-2.5 py-1 rounded-full text-xs font-bold ${
            styles[status] || "bg-gray-100 text-gray-700"
        }">${escapeHTML(status.replaceAll("_", " ").toUpperCase())}</span>`;
    };

    const environmentBadge = (isTest) => isTest
        ? '<span class="inline-flex px-2 py-1 rounded-full bg-amber-100 text-amber-800 text-xs font-bold">TEST</span>'
        : '<span class="inline-flex px-2 py-1 rounded-full bg-green-100 text-green-800 text-xs font-bold">LIVE</span>';

    const showTableMessage = (id, columns, message) => {
        const body = getElement(id);
        if (!body) return;

        body.innerHTML = `<tr><td colspan="${columns}" class="px-5 py-8 text-center text-sm text-gray-500">${escapeHTML(message)}</td></tr>`;
    };

    const countRecords = (rows, recordType, predicate = () => true) => {
        return rows
            .filter(row => row.record_type === recordType && predicate(row))
            .reduce((total, row) => total + Number(row.record_count || 0), 0);
    };

    const renderSummary = (rows) => {
        const liveRows = rows.filter(row => row.is_internal_test !== true);

        setText(
            "billing-stat-subscriptions",
            countRecords(liveRows, "subscriptions")
        );

        setText(
            "billing-stat-trials",
            countRecords(liveRows, "subscriptions", row => row.status === "trial")
        );

        setText(
            "billing-stat-active",
            countRecords(liveRows, "subscriptions", row => row.status === "active")
        );

        setText(
            "billing-stat-past-due",
            countRecords(liveRows, "subscriptions", row => row.status === "past_due")
        );

        setText(
            "billing-stat-open-invoices",
            countRecords(liveRows, "invoices", row =>
                ["issued", "overdue"].includes(row.status)
            )
        );

        setText(
            "billing-stat-completed-payments",
            countRecords(liveRows, "payments", row => row.status === "completed")
        );

        const completedByCurrency = {};
        liveRows
            .filter(row => row.record_type === "payments" && row.status === "completed")
            .forEach(row => {
                const currency = row.currency || "Unknown";
                completedByCurrency[currency] =
                    (completedByCurrency[currency] || 0) + Number(row.total_amount || 0);
            });

        const revenueContainer = getElement("billing-revenue-summary");

        if (revenueContainer) {
            const entries = Object.entries(completedByCurrency);

            revenueContainer.innerHTML = entries.length
                ? entries.map(([currency, amount]) => `
                    <div class="flex items-center justify-between gap-3 py-2 border-b border-gray-100 last:border-0">
                        <span class="text-sm text-gray-600">${escapeHTML(currency)}</span>
                        <span class="font-bold text-gray-900">${formatMoney(amount, currency)}</span>
                    </div>
                `).join("")
                : '<p class="text-sm text-gray-500 py-2">No completed subscription payments recorded yet.</p>';
        }

        const testCount = rows
            .filter(row => row.is_internal_test === true)
            .reduce((total, row) => total + Number(row.record_count || 0), 0);

        setText(
            "billing-test-record-note",
            `${testCount} internal test records excluded from headline figures.`
        );
    };

    const renderSubscriptions = (rows) => {
        const body = getElement("billing-subscriptions-tbody");
        if (!body) return;

        latestSubscriptionRows = Array.isArray(rows) ? rows : [];

        if (!latestSubscriptionRows.length) {
            showTableMessage(
                "billing-subscriptions-tbody",
                8,
                "No subscription records found."
            );
            return;
        }

        body.innerHTML = latestSubscriptionRows.map(row => {
            const isTrial =
                String(row.subscription_status || "").toLowerCase() === "trial";

            const action = isTrial
                ? `<button
                       type="button"
                       data-trial-extend
                       data-church-id="${escapeHTML(row.church_id)}"
                       ${trialExtensionRpcAvailable ? "" : "disabled"}
                       title="${trialExtensionRpcAvailable
                           ? "Manually extend this church trial"
                           : "Install the reviewed Staging migration first"}"
                       class="px-3 py-2 rounded-lg text-xs font-semibold border transition ${
                           trialExtensionRpcAvailable
                               ? "bg-indigo-50 hover:bg-indigo-100 text-indigo-700 border-indigo-200"
                               : "bg-gray-100 text-gray-400 border-gray-200 cursor-not-allowed"
                       }">
                       ${trialExtensionRpcAvailable ? "Extend Trial" : "Unavailable"}
                   </button>`
                : '<span class="text-xs text-gray-400">Not eligible</span>';

            return `
                <tr class="hover:bg-gray-50 transition-colors">
                    <td class="px-5 py-4">
                        <div class="font-semibold text-gray-900">${escapeHTML(row.church_name)}</div>
                        <div class="text-xs text-gray-400">${escapeHTML(row.church_id)}</div>
                    </td>
                    <td class="px-5 py-4 text-sm text-gray-700">
                        ${escapeHTML(row.plan_name)}
                        <div class="text-xs text-gray-400">${escapeHTML(row.billing_interval)}</div>
                    </td>
                    <td class="px-5 py-4 text-sm text-gray-700">
                        <div>${formatMoney(row.base_fee, row.currency)}</div>
                        <div class="text-xs text-gray-400">${escapeHTML(row.included_members)} included members</div>
                        <div class="text-xs text-gray-400">${formatMoney(row.additional_member_fee, row.currency)} per additional member</div>
                    </td>
                    <td class="px-5 py-4">${statusBadge(row.subscription_status)}</td>
                    <td class="px-5 py-4 text-sm text-gray-600">${formatDate(row.trial_ends_at)}</td>
                    <td class="px-5 py-4 text-sm text-gray-600">${formatPeriodEnd(row)}</td>
                    <td class="px-5 py-4">${environmentBadge(row.is_internal_test)}</td>
                    <td class="px-5 py-4">${action}</td>
                </tr>
            `;
        }).join("");
    };
    const renderInvoices = (rows) => {
        const body = getElement("billing-invoices-tbody");
        if (!body) return;

        if (!rows.length) {
            showTableMessage("billing-invoices-tbody", 8, "No invoices have been generated yet.");
            return;
        }

        body.innerHTML = rows.map(row => `
            <tr class="hover:bg-gray-50 transition-colors">
                <td class="px-5 py-4">
                    <div class="font-semibold text-gray-900">${escapeHTML(row.invoice_number)}</div>
                    <div class="text-xs text-gray-400">${escapeHTML(row.church_name)}</div>
                </td>
                <td class="px-5 py-4 text-sm text-gray-600">${escapeHTML(row.billing_interval)}</td>
                <td class="px-5 py-4 text-sm font-bold text-gray-900">${formatMoney(row.total_amount, row.currency)}</td>
                <td class="px-5 py-4 text-sm text-gray-600">
                    ${formatMoney(row.subtotal_amount, row.currency)}
                    <div class="text-xs text-gray-400">${escapeHTML(row.discount_percentage)}% discount</div>
                    <div class="text-xs text-gray-400">Saved: ${formatMoney(row.discount_amount, row.currency)}</div>
                </td>
                <td class="px-5 py-4">${statusBadge(row.invoice_status)}</td>
                <td class="px-5 py-4 text-xs text-gray-600">
                    <div>Issued: ${formatDate(row.issued_at)}</div>
                    <div>Due: ${formatDate(row.due_at)}</div>
                </td>
                <td class="px-5 py-4 text-xs text-gray-600">
                    <div>Grace: ${formatDate(row.grace_expires_at)}</div>
                    <div>Paid: ${formatDate(row.paid_at)}</div>
                </td>
                <td class="px-5 py-4">${environmentBadge(row.is_internal_test)}</td>
            </tr>
        `).join("");
    };

    const renderPayments = (rows) => {
        const body = getElement("billing-payments-tbody");
        if (!body) return;

        if (!rows.length) {
            showTableMessage("billing-payments-tbody", 7, "No subscription payment records found.");
            return;
        }

        body.innerHTML = rows.map(row => `
            <tr class="hover:bg-gray-50 transition-colors">
                <td class="px-5 py-4">
                    <div class="font-semibold text-gray-900">${escapeHTML(row.church_name)}</div>
                    <div class="text-xs text-gray-400">${escapeHTML(row.invoice_number)}</div>
                </td>
                <td class="px-5 py-4 text-sm text-gray-600">${escapeHTML(row.provider)}</td>
                <td class="px-5 py-4 text-sm text-gray-600">${escapeHTML(row.payment_method || "—")}</td>
                <td class="px-5 py-4 text-sm font-bold text-gray-900">${formatMoney(row.amount, row.currency)}</td>
                <td class="px-5 py-4">${statusBadge(row.payment_status)}</td>
                <td class="px-5 py-4 text-xs text-gray-600">
                    <div>${escapeHTML(row.provider_status || "Provider status unavailable")}</div>
                    <div class="mt-1">Verified: ${formatDate(row.verified_at)}</div>
                </td>
                <td class="px-5 py-4">${environmentBadge(row.is_internal_test)}</td>
            </tr>
        `).join("");
    };

    const showLoadError = (message) => {
        showTableMessage("billing-subscriptions-tbody", 7, message);
        showTableMessage("billing-invoices-tbody", 8, message);
        showTableMessage("billing-payments-tbody", 7, message);

        const revenue = getElement("billing-revenue-summary");
        if (revenue) revenue.textContent = message;
    };

    // =====================================================
    // MANUAL TRIAL EXTENSION WORKFLOW
    // =====================================================

    const extensionTimezone = "Africa/Kampala";

    const notifyTrialExtension = (message, type = "success") => {
        if (typeof window.showNotification === "function") {
            window.showNotification(message, type);
        } else {
            console[type === "error" ? "error" : "log"](message);
        }
    };

    const setExtensionStatus = (message, type = "info") => {
        const status = getElement("trial-extension-status");
        if (!status) return;

        status.textContent = message;

        status.className =
            "text-sm rounded-lg p-3 " +
            (type === "error"
                ? "bg-red-50 text-red-700"
                : type === "success"
                    ? "bg-green-50 text-green-700"
                    : "bg-blue-50 text-blue-700");

        status.classList.remove("hidden");
    };

    const formatKampalaInput = (date) => {
        if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
            return "";
        }

        const parts = new Intl.DateTimeFormat("en-CA", {
            timeZone: extensionTimezone,
            year: "numeric",
            month: "2-digit",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hourCycle: "h23"
        }).formatToParts(date);

        const values = {};

        parts.forEach(part => {
            values[part.type] = part.value;
        });

        return `${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}`;
    };

    // Kampala time is UTC+03:00.
    const parseKampalaInput = (value) => {
        if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value || "")) {
            return null;
        }

        const date = new Date(`${value}:00+03:00`);

        if (Number.isNaN(date.getTime())) return null;

        if (formatKampalaInput(date) !== value) return null;

        return date;
    };

    const getTrialExtensionProposal = () => {
        if (!activeTrialExtension) return null;

        const currentEnd = activeTrialExtension.currentExpiry;
        const baseTime = Math.max(Date.now(), currentEnd.getTime());

        const mode = getElement("trial-extension-mode")?.value;

        if (mode === "days") {
            const days = Number(
                getElement("trial-extension-days")?.value
            );

            if (
                !Number.isInteger(days) ||
                days < 1 ||
                days > 3650
            ) {
                return null;
            }

            return new Date(baseTime + days * 86400000);
        }

        if (mode === "date") {
            return parseKampalaInput(
                getElement("trial-extension-new-date")?.value
            );
        }

        return null;
    };

    const syncTrialExtensionSubmitButton = (validDate) => {
        const button = getElement("trial-extension-submit");
        if (!button) return;

        const reason = String(
            getElement("trial-extension-reason")?.value || ""
        ).trim();

        const validReason =
            reason.length >= 10 && reason.length <= 500;

        const enabled =
            trialExtensionRpcAvailable &&
            validDate &&
            validReason &&
            !trialExtensionSubmitting;

        button.type = trialExtensionRpcAvailable ? "submit" : "button";
        button.disabled = !enabled;

        button.title = !trialExtensionRpcAvailable
            ? "Trial extension submission will be enabled after the secure RPC is connected."
            : trialExtensionSubmitting
                ? "A trial extension is being saved."
                : !validDate && !validReason
                    ? "Choose a valid future expiry and enter a reason between 10 and 500 characters."
                    : !validDate
                        ? "Choose a valid future expiry."
                        : !validReason
                            ? "Enter a reason between 10 and 500 characters."
                            : "Ready to submit the trial extension.";

        button.textContent = trialExtensionSubmitting
            ? "Saving Extension..."
            : trialExtensionRpcAvailable
                ? "Confirm Trial Extension"
                : "Secure Extension — Pending Connection";
    };

    const updateTrialExtensionPreview = () => {
        if (!activeTrialExtension) return;

        const proposal = getTrialExtensionProposal();
        const preview = getElement("trial-extension-preview");
        const help = getElement("trial-extension-preview-help");

        const currentEnd = activeTrialExtension.currentExpiry.getTime();

        const maximumExpiry = currentEnd + (3650 * 86400000);
        const validDate = Boolean(
            proposal &&
            proposal.getTime() > Date.now() &&
            proposal.getTime() > currentEnd &&
            proposal.getTime() <= maximumExpiry
        );

        const reason = String(
            getElement("trial-extension-reason")?.value || ""
        ).trim();

        const validReason =
            reason.length >= 10 && reason.length <= 500;

        if (preview) {
            preview.textContent = validDate
                ? formatDate(proposal.toISOString())
                : "Choose a valid future expiry";
        }

        if (help) {
            help.textContent = !validDate
                ? "New expiry must be later than current trial expiry and current time."
                : !validReason
                    ? "Enter a reason between 10 and 500 characters."
                    : "Review this Kampala-time expiry before confirming.";
        }

        syncTrialExtensionSubmitButton(validDate);
    };

    const updateTrialExtensionMode = () => {
        const mode = getElement("trial-extension-mode")?.value;

        const daysContainer = getElement("trial-extension-days-container");
        const dateContainer = getElement("trial-extension-date-container");

        const daysInput = getElement("trial-extension-days");
        const dateInput = getElement("trial-extension-new-date");

        const useDays = mode === "days";

        daysContainer?.classList.toggle("hidden", !useDays);
        dateContainer?.classList.toggle("hidden", useDays);

        if (daysInput) {
            daysInput.disabled = !useDays;
            daysInput.required = useDays;
        }

        if (dateInput) {
            dateInput.disabled = useDays;
            dateInput.required = !useDays;
        }

        updateTrialExtensionPreview();
    };

    const renderTrialExtensionHistory = (rows) => {
        const body = getElement("billing-trial-extensions-tbody");
        if (!body) return;

        if (!Array.isArray(rows) || !rows.length) {
            showTableMessage(
                "billing-trial-extensions-tbody",
                6,
                "No trial extensions have been recorded."
            );
            return;
        }

        body.innerHTML = rows.map(row => `
            <tr class="hover:bg-gray-50">
                <td class="px-5 py-4">
                    <div class="font-semibold text-gray-900">${escapeHTML(row.church_name)}</div>
                    <div class="text-xs text-gray-400">${escapeHTML(row.church_id)}</div>
                </td>
                <td class="px-5 py-4 text-sm text-gray-600">${formatDate(row.previous_trial_ends_at)}</td>
                <td class="px-5 py-4 text-sm font-semibold text-gray-800">${formatDate(row.new_trial_ends_at)}</td>
                <td class="px-5 py-4 text-sm text-gray-600">
                    <div class="max-w-xs whitespace-normal break-words">${escapeHTML(row.reason)}</div>
                </td>
                <td class="px-5 py-4 text-sm text-gray-600">${escapeHTML(row.actor_name)}</td>
                <td class="px-5 py-4 text-sm text-gray-600">${formatDate(row.created_at)}</td>
            </tr>
        `).join("");
    };

    const loadTrialExtensionHistory = async (client) => {
        trialExtensionRpcAvailable = false;
        syncTrialExtensionSubmitButton(false);

        try {
            const { data, error } = await client.rpc(
                "super_admin_list_trial_extensions",
                { p_limit: 20 }
            );

            if (error) throw error;

            trialExtensionRpcAvailable = true;

            renderTrialExtensionHistory(data || []);
            renderSubscriptions(latestSubscriptionRows);

            return true;

        } catch (error) {
            trialExtensionRpcAvailable = false;

            const missingFunction =
                error.code === "PGRST202" ||
                error.code === "42883" ||
                /schema cache|function.+not found|does not exist/i.test(
                    error.message || ""
                );

            showTableMessage(
                "billing-trial-extensions-tbody",
                6,
                missingFunction
                    ? "Trial extension tools are awaiting the reviewed Staging database migration."
                    : `Unable to load trial extension history: ${error.message}`
            );

            renderSubscriptions(latestSubscriptionRows);

            console.warn(
                "Trial extension history is not currently available:",
                error
            );

            return false;
        }
    };

    const closeTrialExtensionDialog = () => {
        const modal = getElement("trial-extension-modal");

        if (!modal || trialExtensionSubmitting) return;

        modal.classList.add("hidden");
        modal.setAttribute("aria-hidden", "true");

        getElement("trial-extension-form")?.reset();
        getElement("trial-extension-status")?.classList.add("hidden");

        activeTrialExtension = null;

        syncTrialExtensionSubmitButton(false);

        if (trialExtensionPreviousFocus?.isConnected) {
            trialExtensionPreviousFocus.focus();
        }

        trialExtensionPreviousFocus = null;
    };

    const showTrialExtensionDialog = (row) => {
        if (!trialExtensionRpcAvailable) {
            notifyTrialExtension(
                "Trial extension is not enabled on this Staging database yet.",
                "error"
            );
            return;
        }

        if (
            !row ||
            String(row.subscription_status || "").toLowerCase() !== "trial"
        ) {
            notifyTrialExtension(
                "Only subscriptions currently on trial can be extended.",
                "error"
            );
            return;
        }

        const currentExpiry = new Date(row.trial_ends_at);

        if (
            !row.trial_ends_at ||
            Number.isNaN(currentExpiry.getTime())
        ) {
            notifyTrialExtension(
                "This subscription has no valid trial expiry date.",
                "error"
            );
            return;
        }

        activeTrialExtension = {
            churchId: row.church_id,
            churchName: row.church_name,
            currentExpiry
        };

        const modal = getElement("trial-extension-modal");
        const form = getElement("trial-extension-form");

        if (!modal || !form) {
            notifyTrialExtension(
                "The trial extension dialog is unavailable.",
                "error"
            );
            return;
        }

        trialExtensionPreviousFocus = document.activeElement;

        form.reset();

        getElement("trial-extension-church-name").textContent =
            row.church_name || "Selected church";

        getElement("trial-extension-current-expiry").textContent =
            formatDate(row.trial_ends_at);

        getElement("trial-extension-mode").value = "days";
        getElement("trial-extension-days").value = "30";

        const minimumTime = Math.max(
            Date.now(),
            currentExpiry.getTime()
        );

        const dateInput = getElement("trial-extension-new-date");

        dateInput.min = formatKampalaInput(
            new Date(minimumTime + 60000)
        );

        dateInput.value = formatKampalaInput(
            new Date(minimumTime + 30 * 86400000)
        );

        updateTrialExtensionMode();

        modal.classList.remove("hidden");
        modal.setAttribute("aria-hidden", "false");

        getElement("trial-extension-days")?.focus();
    };

    window.openSuperAdminTrialExtension = async function (churchId) {
        if (!trialExtensionRpcAvailable) {
            notifyTrialExtension(
                "Trial extensions are not enabled on this Staging database yet.",
                "error"
            );
            return;
        }

        try {
            let row = latestSubscriptionRows.find(
                item => item.church_id === churchId
            );

            if (!row) {
                const client = window.sbClient;

                if (!client) {
                    throw new Error("Supabase client is unavailable.");
                }

                const { data, error } = await client.rpc(
                    "super_admin_list_subscription_dashboard",
                    { p_limit: 200 }
                );

                if (error) throw error;

                latestSubscriptionRows = Array.isArray(data) ? data : [];

                row = latestSubscriptionRows.find(
                    item => item.church_id === churchId
                );
            }

            if (!row) {
                throw new Error("No subscription was found for this church.");
            }

            showTrialExtensionDialog(row);

        } catch (error) {
            notifyTrialExtension(
                `Unable to open trial extension: ${error.message}`,
                "error"
            );
        }
    };

    const initTrialExtensionUI = () => {
        const body = getElement("billing-subscriptions-tbody");

        const mode = getElement("trial-extension-mode");
        const days = getElement("trial-extension-days");
        const date = getElement("trial-extension-new-date");
        const reason = getElement("trial-extension-reason");

        const form = getElement("trial-extension-form");
        const modal = getElement("trial-extension-modal");

        body?.addEventListener("click", event => {
            const button = event.target.closest("[data-trial-extend]");

            if (!button || button.disabled) return;

            window.openSuperAdminTrialExtension(
                button.getAttribute("data-church-id")
            );
        });

        mode?.addEventListener("change", updateTrialExtensionMode);
        days?.addEventListener("input", updateTrialExtensionPreview);
        date?.addEventListener("input", updateTrialExtensionPreview);
        reason?.addEventListener("input", updateTrialExtensionPreview);

        form?.addEventListener("submit", async event => {
            event.preventDefault();

            if (
                trialExtensionSubmitting ||
                !activeTrialExtension ||
                !trialExtensionRpcAvailable
            ) {
                return;
            }

            const proposal = getTrialExtensionProposal();
            const reasonText = String(reason?.value || "").trim();

            const currentExpiry = activeTrialExtension.currentExpiry.getTime();
            const maxExpiry = currentExpiry + (3650 * 86400000);
            const validDate = Boolean(
                proposal &&
                proposal.getTime() > Date.now() &&
                proposal.getTime() > currentExpiry &&
                proposal.getTime() <= maxExpiry
            );

            if (!validDate) {
                setExtensionStatus(
                    "Choose a new expiry later than the current trial expiry.",
                    "error"
                );
                return;
            }

            if (reasonText.length < 10 || reasonText.length > 500) {
                setExtensionStatus(
                    "Please enter a reason between 10 and 500 characters.",
                    "error"
                );
                return;
            }

            const client = window.sbClient;

            if (!client) {
                setExtensionStatus(
                    "Supabase client is unavailable.",
                    "error"
                );
                return;
            }

            const churchId = activeTrialExtension.churchId;
            const churchName = activeTrialExtension.churchName;

            trialExtensionSubmitting = true;

            syncTrialExtensionSubmitButton(true);

            setExtensionStatus(
                "Submitting the secure trial extension...",
                "info"
            );

            try {
                const { data, error } = await client.rpc(
                    "super_admin_extend_church_trial",
                    {
                        p_church_id: churchId,
                        p_new_expiry: proposal.toISOString(),
                        p_reason: reasonText
                    }
                );

                if (error) throw error;

                const result = Array.isArray(data) ? data[0] : data;

                if (!result?.event_id) {
                    throw new Error(
                        "The server did not return a trial extension confirmation."
                    );
                }

                trialExtensionSubmitting = false;
                closeTrialExtensionDialog();

                notifyTrialExtension(
                    `${churchName} trial successfully extended to ${formatDate(result.new_trial_ends_at)}.`,
                    "success"
                );

                await window.loadSuperAdminBillingDashboard();

                if (typeof window.loadAllUsersAndChurches === "function") {
                    await window.loadAllUsersAndChurches();
                }

            } catch (error) {
                setExtensionStatus(
                    `Trial extension failed: ${error.message}`,
                    "error"
                );

            } finally {
                trialExtensionSubmitting = false;
                updateTrialExtensionPreview();
            }
        });

        document.querySelectorAll("[data-close-trial-extension]").forEach(button => {
            button.addEventListener("click", closeTrialExtensionDialog);
        });

        modal?.addEventListener("click", event => {
            if (event.target === modal) {
                closeTrialExtensionDialog();
            }
        });

        document.addEventListener("keydown", event => {
            if (
                event.key === "Escape" &&
                modal &&
                !modal.classList.contains("hidden")
            ) {
                closeTrialExtensionDialog();
            }
        });
    };
    window.loadSuperAdminBillingDashboard = async function () {
        if (loading) return;

        loading = true;

        const refreshButton = getElement("billing-refresh-btn");
        if (refreshButton) {
            refreshButton.disabled = true;
            refreshButton.classList.add("opacity-60", "cursor-not-allowed");
        }

        try {
            let attempts = 0;
            while (!window.sbClient && attempts < 30) {
                await new Promise(resolve => setTimeout(resolve, 200));
                attempts++;
            }

            const client = window.sbClient;

            if (!client) {
                throw new Error("Supabase client is unavailable.");
            }

            const { data: sessionData, error: sessionError } =
                await client.auth.getSession();

            if (sessionError || !sessionData?.session?.user) {
                throw new Error("An authenticated session is required.");
            }

            const { data: isSuperAdmin, error: authError } =
                await client.rpc("is_super_admin");

            if (authError || isSuperAdmin !== true) {
                throw new Error("Super Admin authorization could not be verified.");
            }

            const results = await Promise.all([
                client.rpc("super_admin_get_billing_dashboard_summary"),
                client.rpc("super_admin_list_subscription_dashboard", { p_limit: 100 }),
                client.rpc("super_admin_list_billing_invoices", { p_limit: 50 }),
                client.rpc("super_admin_list_billing_payments", { p_limit: 50 })
            ]);

            const labels = [
                "Billing summary",
                "Subscription list",
                "Invoice list",
                "Payment list"
            ];

            results.forEach((result, index) => {
                if (result.error) {
                    throw new Error(`${labels[index]} failed: ${result.error.message}`);
                }
            });

            const summary = results[0].data || [];
            const subscriptions = results[1].data || [];
            const invoices = results[2].data || [];
            const payments = results[3].data || [];

            renderSummary(summary);
            renderSubscriptions(subscriptions);
            renderInvoices(invoices);
            renderPayments(payments);

            // Optional until the reviewed Staging migration is applied.
            await loadTrialExtensionHistory(client);

            setText(
                "billing-last-updated",
                `Updated ${new Intl.DateTimeFormat("en-UG", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Kampala" }).format(new Date())}`
            );

            const status = getElement("billing-load-status");
            if (status) {
                status.textContent = "Billing reports loaded successfully.";
                status.className = "text-xs text-green-700";
            }

        } catch (error) {
            console.error("Super Admin billing dashboard:", error);
            showLoadError(`Unable to load billing records: ${error.message}`);

            const status = getElement("billing-load-status");
            if (status) {
                status.textContent = "Billing reports could not be loaded.";
                status.className = "text-xs text-red-600";
            }

        } finally {
            loading = false;

            if (refreshButton) {
                refreshButton.disabled = false;
                refreshButton.classList.remove("opacity-60", "cursor-not-allowed");
            }
        }
    };

    window.logoutSuperAdmin = async function (event) {
        if (event && typeof event.preventDefault === "function") {
            event.preventDefault();
        }

        try {
            const client = window.sbClient || window.supabaseClient;
            if (client?.auth) await client.auth.signOut();
        } catch (error) {
            console.error("Super Admin sign-out error:", error);
        }

        window.location.replace("login.html");
    };

    document.addEventListener("DOMContentLoaded", () => {
        initTrialExtensionUI();
        window.loadSuperAdminBillingDashboard();
    });
})();