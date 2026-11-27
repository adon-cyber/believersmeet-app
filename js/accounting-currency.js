/*
 * BelieversMeet Accounting — shared ISO 4217 currency metadata.
 * Read-only browser helper. Currency eligibility and church enablement are
 * separate sources; monetary precision always comes from the catalogue.
 */
(() => {
    'use strict';

    const cache = new Map();

    function normalizeCode(value) {
        const code = String(value || '').trim().toUpperCase();
        return /^[A-Z]{3}$/.test(code) ? code : null;
    }

    function decimalParts(value) {
        const raw = String(value ?? '').trim();
        const match = /^(?:0|[1-9]\d*)(?:\.(\d+))?$/.exec(raw);
        return match ? { raw, fraction: match[1] || '' } : null;
    }

    function createContext(catalogueRows, enabledRows) {
        const catalogue = new Map((catalogueRows || []).map((row) => [row.currency_code, Object.freeze({
            currencyCode: row.currency_code,
            currencyName: row.currency_name,
            minorUnit: row.minor_unit_exponent == null ? null : Number(row.minor_unit_exponent),
            isoItemType: row.iso_item_type
        })]));
        const enabledCurrencies = new Set((enabledRows || [])
            .filter((row) => row.is_enabled === true)
            .map((row) => row.currency_code));

        function get(code) {
            const normalized = normalizeCode(code);
            return normalized ? catalogue.get(normalized) || null : null;
        }

        function minorUnit(code) {
            const normalized = normalizeCode(code);
            const meta = get(normalized);
            if (!meta || !Number.isInteger(meta.minorUnit) || meta.minorUnit < 0 || meta.minorUnit > 4) {
                throw new Error(`ISO minor-unit precision is unavailable for ${normalized || 'this currency'}.`);
            }
            return meta.minorUnit;
        }

        function step(code) {
            const precision = minorUnit(code);
            return precision === 0 ? '1' : `0.${'0'.repeat(precision - 1)}1`;
        }

        function parseAmount(value, code, label = 'Amount', allowZero = true) {
            const precision = minorUnit(code);
            const parsed = decimalParts(value);
            if (!parsed || parsed.fraction.length > precision) {
                const precisionText = precision === 0 ? 'whole units' : `up to ${precision} decimal place${precision === 1 ? '' : 's'}`;
                throw new Error(`${label} must be a non-negative amount using ${precisionText} for ${normalizeCode(code)}.`);
            }
            const numeric = Number(parsed.raw);
            if (!Number.isFinite(numeric) || numeric < 0 || (!allowZero && numeric === 0)) {
                throw new Error(`${label} must be a valid ${allowZero ? 'non-negative' : 'positive'} amount.`);
            }
            return numeric;
        }

        function minorUnits(value, code, label = 'Amount', allowZero = true) {
            const parsed = decimalParts(value);
            const precision = minorUnit(code);
            if (!parsed || parsed.fraction.length > precision) {
                const precisionText = precision === 0 ? 'whole units' : `up to ${precision} decimal place${precision === 1 ? '' : 's'}`;
                throw new Error(`${label} must use ${precisionText} for ${normalizeCode(code)}.`);
            }
            const whole = parsed.raw.split('.')[0];
            const fraction = (parsed.fraction + '0'.repeat(precision)).slice(0, precision);
            const units = BigInt(whole) * (10n ** BigInt(precision)) + BigInt(fraction || '0');
            if (!allowZero && units === 0n) throw new Error(`${label} must be greater than zero.`);
            return units;
        }

        function format(value, code) {
            const normalized = normalizeCode(code);
            const amount = Number(value ?? 0);
            if (!Number.isFinite(amount)) return '—';
            if (!normalized) return `${amount.toLocaleString()} (currency unavailable)`;
            let precision;
            try { precision = minorUnit(normalized); } catch (_) {
                return `${amount.toLocaleString()} ${normalized}`;
            }
            try {
                return new Intl.NumberFormat(undefined, {
                    style: 'currency', currency: normalized,
                    minimumFractionDigits: precision, maximumFractionDigits: precision
                }).format(amount);
            } catch (_) {
                return `${amount.toLocaleString(undefined, { minimumFractionDigits: precision, maximumFractionDigits: precision })} ${normalized}`;
            }
        }

        function isEnabled(code) {
            const normalized = normalizeCode(code);
            return Boolean(normalized && catalogue.has(normalized) && enabledCurrencies.has(normalized));
        }

        function options({ enabledOnly = true } = {}) {
            return Array.from(catalogue.values())
                .filter((item) => !enabledOnly || enabledCurrencies.has(item.currencyCode))
                .sort((a, b) => a.currencyCode.localeCompare(b.currencyCode));
        }

        return Object.freeze({
            catalogue,
            enabledCurrencies,
            get,
            minorUnit,
            step,
            parseAmount,
            minorUnits,
            format,
            isEnabled,
            options
        });
    }

    async function loadForChurch({ client, churchId, force = false }) {
        if (!client || !churchId) throw new Error('A verified Supabase client and church are required to load currency metadata.');
        if (!force && cache.has(churchId)) return cache.get(churchId);
        const [catalogueResult, enabledResult] = await Promise.all([
            client.from('accounting_currency_catalog')
                .select('currency_code,currency_name,minor_unit_exponent,iso_item_type')
                .eq('is_current', true).eq('is_platform_supported', true)
                .order('currency_code', { ascending: true }),
            client.from('accounting_church_currencies')
                .select('currency_code,is_enabled')
                .eq('church_id', churchId)
        ]);
        if (catalogueResult.error) throw new Error(`Currency catalogue could not be loaded: ${catalogueResult.error.message}`);
        if (enabledResult.error) throw new Error(`Church-enabled currencies could not be loaded: ${enabledResult.error.message}`);
        if (!Array.isArray(catalogueResult.data) || !catalogueResult.data.length) {
            throw new Error('The supported ISO currency catalogue returned no current currencies.');
        }
        const context = createContext(catalogueResult.data, enabledResult.data || []);
        cache.set(churchId, context);
        return context;
    }

    window.BelieversMeetAccountingCurrency = Object.freeze({ loadForChurch, createContext, normalizeCode });
})();
