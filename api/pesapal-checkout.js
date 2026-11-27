import { getSupabaseAdmin } from '../lib/supabase-admin.js';
import { randomUUID } from 'node:crypto';

const ALLOWED_CURRENCIES = new Set(['UGX', 'USD']);
const ALLOWED_CATEGORIES = new Set([
    'Tithes',
    'Offerings',
    'Building Fund',
    'Missions & Outreach',
    'Special Seed'
]);
const ALLOWED_COUNTRIES = new Set([
    'UG', 'US', 'GB', 'CA', 'AU', 'DE', 'FR', 'NL', 'IE',
    'ZA', 'KE', 'TZ', 'RW', 'NG', 'GH'
]);

function getRequestBody(req) {
    if (req.body && typeof req.body === 'object') return req.body;
    if (typeof req.body === 'string') {
        try {
            return JSON.parse(req.body);
        } catch {
            return null;
        }
    }
    return null;
}

function getBearerToken(req) {
    const header = req.headers?.authorization || req.headers?.Authorization;
    if (!header) return null;
    const match = /^Bearer\s+(.+)$/i.exec(String(header).trim());
    if (!match) throw new Error('Invalid authorization header.');
    return match[1].trim();
}

function requireHttpsUrl(value, variableName) {
    if (!value) {
        throw new Error(`Missing server configuration: ${variableName}.`);
    }

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error(`${variableName} must be a valid HTTPS URL.`);
    }

    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
        throw new Error(`${variableName} must be a public HTTPS URL.`);
    }

    return parsed.toString();
}

async function readPesapalJson(response, label) {
    const responseText = await response.text();
    let payload;

    try {
        payload = JSON.parse(responseText);
    } catch {
        throw new Error(`${label} returned an unreadable response.`);
    }

    if (!response.ok || String(payload?.status) !== '200') {
        const message = payload?.error?.message || payload?.message || `${label} request failed.`;
        throw new Error(message);
    }

    return payload;
}

function getPesapalBaseUrl(environment) {
    if (environment === 'live') return 'https://pay.pesapal.com/v3';
    if (environment === 'sandbox' || !environment) return 'https://cybqa.pesapal.com/pesapalv3';
    throw new Error('This church has an unsupported Pesapal environment setting.');
}

async function getPesapalToken(consumerKey, consumerSecret, baseUrl) {
    const response = await fetch(`${baseUrl}/api/Auth/RequestToken`, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            consumer_key: consumerKey,
            consumer_secret: consumerSecret
        })
    });

    const data = await readPesapalJson(response, 'Pesapal authentication');
    if (!data.token) throw new Error('Pesapal authentication did not return an access token.');
    return data.token;
}

async function registerPesapalIpn(token, ipnUrl, baseUrl) {
    const response = await fetch(`${baseUrl}/api/URLSetup/RegisterIPN`, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`
        },
        body: JSON.stringify({
            url: ipnUrl,
            ipn_notification_type: 'GET'
        })
    });

    const data = await readPesapalJson(response, 'Pesapal IPN registration');
    if (typeof data.ipn_id !== 'string' || !data.ipn_id.trim()) {
        throw new Error('Pesapal IPN registration did not return an IPN ID.');
    }
    if (Number(data.ipn_status) !== 1 || (data.error !== null && data.error !== undefined)) {
        throw new Error('Pesapal returned an IPN registration that is not active.');
    }

    let returnedUrl;
    let requestedUrl;
    try {
        returnedUrl = new URL(data.url);
        requestedUrl = new URL(ipnUrl);
    } catch {
        throw new Error('Pesapal returned an invalid IPN registration URL.');
    }
    if (
        returnedUrl.origin !== requestedUrl.origin ||
        returnedUrl.pathname.replace(/\/+$/, '') !== requestedUrl.pathname.replace(/\/+$/, '') ||
        returnedUrl.search !== requestedUrl.search
    ) {
        throw new Error('Pesapal returned an IPN registration for a different notification URL.');
    }

    return data.ipn_id.trim();
}

async function getRegisteredPesapalIpns(token, baseUrl) {
    const response = await fetch(`${baseUrl}/api/URLSetup/GetIpnList`, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${token}`
        }
    });

    const responseText = await response.text();
    let payload;

    try {
        payload = JSON.parse(responseText);
    } catch {
        throw new Error('Pesapal registered IPN list returned an unreadable response.');
    }

    if (!response.ok) {
        const message =
            payload?.error?.message ||
            payload?.message ||
            `Pesapal registered IPN lookup failed (${response.status}).`;

        throw new Error(message);
    }

    if (!Array.isArray(payload)) {
        throw new Error('Pesapal registered IPN list returned an unexpected response.');
    }

    return payload;
}

function normalizeAmount(value, currency) {
    const amount = Number(value);
    if (!Number.isFinite(amount) || amount <= 0 || amount > 1000000000) {
        throw new Error('Enter a valid donation amount greater than zero.');
    }

    const decimalPlaces = currency === 'UGX' ? 0 : 2;
    const multiplier = 10 ** decimalPlaces;
    if (Math.round(amount * multiplier) !== amount * multiplier) {
        throw new Error(currency === 'UGX'
            ? 'UGX donations must be whole shillings.'
            : 'USD donations can have no more than two decimal places.');
    }

    return Number(amount.toFixed(decimalPlaces));
}

function splitDonorName(fullName) {
    const parts = fullName.trim().split(/\s+/);
    return {
        first_name: parts[0] || '',
        last_name: parts.slice(1).join(' ')
    };
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ success: false, error: 'Method not allowed.' });
    }

    let supabaseAdmin;
    let transactionId = null;
    let orderSubmissionMayHaveReachedPesapal = false;

    try {
        const body = getRequestBody(req);
        if (!body) {
            return res.status(400).json({ success: false, error: 'A valid JSON request body is required.' });
        }

        const currency = String(body.currency || 'UGX').trim().toUpperCase();
        if (!ALLOWED_CURRENCIES.has(currency)) {
            return res.status(400).json({ success: false, error: 'Only UGX and USD donations are currently supported.' });
        }

        const amount = normalizeAmount(body.amount, currency);
        const category = String(body.category || '').trim();
        if (!ALLOWED_CATEGORIES.has(category)) {
            return res.status(400).json({ success: false, error: 'Choose a valid giving category.' });
        }

        const payerName = String(body.payer_name || '').trim().replace(/\s+/g, ' ');
        const payerEmail = String(body.payer_email || '').trim().toLowerCase();
        const payerPhone = String(body.payer_phone || '').trim();
        const payerCountry = String(body.payer_country || '').trim().toUpperCase();

        if (payerName.length < 2 || payerName.length > 100) {
            return res.status(400).json({ success: false, error: 'Enter your name (2–100 characters).' });
        }
        if (payerEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(payerEmail)) {
            return res.status(400).json({ success: false, error: 'Enter a valid email address.' });
        }
        const phoneDigits = payerPhone.replace(/\D/g, '');
        if (payerPhone.length > 20 || phoneDigits.length < 7 || phoneDigits.length > 15 || !/^[+\d\s().-]+$/.test(payerPhone)) {
            return res.status(400).json({ success: false, error: 'Enter a valid phone number.' });
        }
        if (!ALLOWED_COUNTRIES.has(payerCountry)) {
            return res.status(400).json({ success: false, error: 'Choose a country from the country list.' });
        }

        const ipnUrl = requireHttpsUrl(process.env.PESAPAL_IPN_URL, 'PESAPAL_IPN_URL');
        const callbackUrl = requireHttpsUrl(process.env.PESAPAL_CALLBACK_URL, 'PESAPAL_CALLBACK_URL');
        const parsedIpnUrl = new URL(ipnUrl);
        const parsedCallbackUrl = new URL(callbackUrl);

        if (
            parsedIpnUrl.pathname.replace(/\/+$/, '') !== '/api/pesapal-ipn' ||
            parsedIpnUrl.search ||
            parsedCallbackUrl.pathname.replace(/\/+$/, '') !== '/giving.html' ||
            parsedCallbackUrl.search ||
            parsedIpnUrl.origin !== parsedCallbackUrl.origin
        ) {
            throw new Error('Pesapal callback/IPN server URLs must use this same deployment: /giving.html and /api/pesapal-ipn.');
        }

        supabaseAdmin = getSupabaseAdmin();

        // If a bearer token is supplied, verify it with Supabase Auth. Never trust a user ID from the browser.
        const accessToken = getBearerToken(req);
        let authenticatedUser = null;
        let profile = null;

        if (accessToken) {
            const { data: authData, error: authError } = await supabaseAdmin.auth.getUser(accessToken);
            if (authError || !authData?.user) {
                return res.status(401).json({ success: false, error: 'Your sign-in session has expired. Please sign in again.' });
            }
            authenticatedUser = authData.user;

            const { data: profileData, error: profileError } = await supabaseAdmin
                .from('profiles')
                .select('id, church_id, full_name, email, phone')
                .eq('id', authenticatedUser.id)
                .maybeSingle();

            if (profileError) {
                const diagnostic = {
                    code: profileError.code || null,
                    message: profileError.message || 'Unknown Supabase profile lookup error'
                };

                console.error('[pesapal-checkout] donor profile lookup failed:', diagnostic);

                const responseBody = {
                    success: false,
                    error: 'Could not verify your member profile. Please try again.'
                };

                // Temporary diagnostics are returned only to Preview callers.
                if ((process.env.VERCEL_ENV || '').toLowerCase() === 'preview') {
                    responseBody.diagnostic = {
                        stage: 'profile_lookup',
                        code: diagnostic.code,
                        message: diagnostic.message
                    };
                }

                return res.status(500).json(responseBody);
            }
            profile = profileData;
        }

        const requestedChurchId = String(body.church_id || '').trim();

let churchId;

if (authenticatedUser) {
    // Signed-in donors must have a church affiliation.
    if (!profile?.church_id) {
        return res.status(403).json({
            success: false,
            error: 'Your account is not linked to a church. Please join a church before donating.'
        });
    }

    // Never allow an authenticated member to select another church.
    churchId = String(profile.church_id).trim();

} else {
    // Only unauthenticated guests may select a receiving church.
    churchId = requestedChurchId;
}

        // Attached members are always charged to their own church, regardless of browser input.
        const { data: church, error: churchError } = await supabaseAdmin
            .from('churches')
            .select('id, name, status, pesapal_consumer_key, pesapal_consumer_secret, pesapal_ipn_id, pesapal_env')
            .eq('id', churchId)
            .maybeSingle();

        if (churchError) {
            console.error('Church lookup failed:', churchError.message);
            return res.status(500).json({ success: false, error: 'Unable to verify the selected church.' });
        }
        if (!church || String(church.status || '').toLowerCase() !== 'approved') {
            return res.status(400).json({ success: false, error: 'This church is not currently approved to receive online donations.' });
        }
        if (!church.pesapal_consumer_key || !church.pesapal_consumer_secret) {
            return res.status(400).json({ success: false, error: 'This church has not completed its Pesapal payment setup.' });
        }

        const baseUrl = getPesapalBaseUrl((process.env.VERCEL_ENV || '').toLowerCase() === 'preview' ? 'sandbox' : (church.pesapal_env || 'sandbox'));
        const token = await getPesapalToken(
            church.pesapal_consumer_key.trim(),
            church.pesapal_consumer_secret.trim(),
            baseUrl
        );

        // Validate the saved notification ID against the current merchant and exact server URL.
        // This prevents an ID from an old Consumer Key/Secret or environment being reused.
        const registeredIpns = await getRegisteredPesapalIpns(token, baseUrl);
        const expectedUrl = new URL(ipnUrl);

        const matchingIpns = registeredIpns.filter((entry) => {
            const responseStatus = String(entry?.status ?? '');
            const ipnStatus = entry?.ipn_status;
            const acceptedResponseStatus = responseStatus === '200' ||
                (responseStatus === '1' && Number(ipnStatus) === 1);
            const acceptedIpnStatus = ipnStatus === null ||
                ipnStatus === undefined || Number(ipnStatus) === 1;

            if (
                !acceptedResponseStatus ||
                !acceptedIpnStatus ||
                (entry?.error !== null && entry?.error !== undefined) ||
                typeof entry?.url !== 'string' ||
                typeof entry?.ipn_id !== 'string' ||
                !entry.ipn_id.trim()
            ) {
                return false;
            }

            try {
                const candidateUrl = new URL(entry.url);
                return candidateUrl.origin === expectedUrl.origin &&
                    candidateUrl.pathname.replace(/\/+$/, '') === expectedUrl.pathname.replace(/\/+$/, '') &&
                    candidateUrl.search === expectedUrl.search;
            } catch {
                return false;
            }
        });

        const savedIpnId = String(church.pesapal_ipn_id || '').trim();
        const savedIpnMatch = savedIpnId
            ? matchingIpns.find((entry) => entry.ipn_id.trim() === savedIpnId)
            : null;

        let ipnId;
        let createdIpn = false;

        if (savedIpnMatch) {
            ipnId = savedIpnMatch.ipn_id.trim();
        } else if (matchingIpns.length === 1) {
            ipnId = matchingIpns[0].ipn_id.trim();
        } else if (matchingIpns.length > 1) {
            const diagnosticError = new Error(
                'Multiple active Pesapal IPN registrations match this URL. Manual review is required.'
            );
            if ((process.env.VERCEL_ENV || '').toLowerCase() === 'preview') {
                diagnosticError.previewDiagnostic = {
                    stage: 'ipn_list',
                    returned_count: registeredIpns.length,
                    matching_count: matchingIpns.length,
                    has_saved_ipn_id: Boolean(savedIpnId),
                    saved_ipn_id_matches: false
                };
            }
            throw diagnosticError;
        } else {
            // Initial setup and stale/deleted registrations are repaired automatically.
            ipnId = await registerPesapalIpn(token, ipnUrl, baseUrl);
            createdIpn = true;
            console.log('[pesapal-checkout] Registered a new Pesapal IPN endpoint for this merchant.');
        }

        if (ipnId !== savedIpnId) {
            const { data: savedIpnRow, error: ipnSaveError } = await supabaseAdmin
                .from('churches')
                .update({ pesapal_ipn_id: ipnId })
                .eq('id', church.id)
                .select('id')
                .maybeSingle();

            if (ipnSaveError || !savedIpnRow) {
                console.error('Failed to save church Pesapal IPN ID:', {
                    code: ipnSaveError?.code || null,
                    message: ipnSaveError?.message || 'Church row was not updated.'
                });
                throw new Error(
                    createdIpn
                        ? 'Pesapal registered the notification endpoint, but BelieversMeet could not save its ID. Retry checkout; the existing registration will be recovered.'
                        : 'Pesapal IPN recovery succeeded, but saving its ID failed. Please retry.'
                );
            }
        }

        const merchantReference = `BM-GIVE-${randomUUID()}`;
        const description = `BelieversMeet Giving - ${category}`.slice(0, 100);
        const { first_name: firstName, last_name: lastName } = splitDonorName(payerName);

        // Store a server-created PENDING transaction before sending the order to Pesapal.
        const { data: transaction, error: insertError } = await supabaseAdmin
            .from('transactions')
            .insert({
                user_id: authenticatedUser?.id || null,
                church_id: church.id,
                merchant_reference: merchantReference,
                amount,
                currency,
                payment_type: category,
                payment_method: 'pesapal',
                status: 'PENDING',
                payer_name: payerName,
                payer_email: payerEmail,
                payer_phone: payerPhone,
                payer_country: payerCountry,
                description
            })
            .select('id')
            .single();

        if (insertError || !transaction) {
            console.error('Could not create pending transaction:', insertError?.message);
            return res.status(500).json({ success: false, error: 'Could not create your donation record. Please try again.' });
        }
        transactionId = transaction.id;

        const orderPayload = {
            id: merchantReference,
            currency,
            amount,
            description,
            callback_url: callbackUrl,
            redirect_mode: 'TOP_WINDOW',
            notification_id: ipnId,
            billing_address: {
                email_address: payerEmail,
                phone_number: payerPhone,
                country_code: payerCountry,
                first_name: firstName,
                last_name: lastName
            }
        };

        orderSubmissionMayHaveReachedPesapal = true;
        const orderResponse = await fetch(`${baseUrl}/api/Transactions/SubmitOrderRequest`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify(orderPayload)
        });

        const orderData = await readPesapalJson(orderResponse, 'Pesapal order submission');
        if (!orderData.redirect_url || !orderData.order_tracking_id) {
            throw new Error('Pesapal did not return a payment URL and tracking ID. The transaction remains pending for reconciliation.');
        }
        if (orderData.merchant_reference && orderData.merchant_reference !== merchantReference) {
            throw new Error('Pesapal returned a merchant reference that did not match this donation. The transaction remains pending for reconciliation.');
        }

        const { error: trackingSaveError } = await supabaseAdmin
            .from('transactions')
            .update({ pesapal_tracking_id: orderData.order_tracking_id })
            .eq('id', transactionId);

        if (trackingSaveError) {
            // Keep the transaction pending. The IPN can still locate it by merchant reference.
            console.error('Could not save Pesapal tracking ID:', trackingSaveError.message);
        }

        let redirectUrl;
        try {
            redirectUrl = new URL(orderData.redirect_url);
        } catch {
            throw new Error('Pesapal returned an invalid payment URL. The transaction remains pending for reconciliation.');
        }
        if (redirectUrl.protocol !== 'https:' || !(redirectUrl.hostname === 'pesapal.com' || redirectUrl.hostname.endsWith('.pesapal.com'))) {
            throw new Error('Pesapal returned an untrusted payment URL. The transaction remains pending for reconciliation.');
        }

        return res.status(200).json({
            success: true,
            redirect_url: redirectUrl.toString(),
            order_tracking_id: orderData.order_tracking_id,
            merchant_reference: merchantReference,
            amount,
            currency
        });
    } catch (error) {
        console.error('Pesapal checkout error:', error.message);

        // If Pesapal was not contacted, the pending row cannot represent an active order.
        // If the request may have reached Pesapal, keep it PENDING until verified/reconciled.
        if (transactionId && !orderSubmissionMayHaveReachedPesapal && supabaseAdmin) {
            const { error: updateError } = await supabaseAdmin
                .from('transactions')
                .update({ status: 'FAILED' })
                .eq('id', transactionId)
                .eq('status', 'PENDING');
            if (updateError) console.error('Could not mark pre-submission transaction failed:', updateError.message);
        }

        return res.status(500).json({
            success: false,
            error: error.message || 'Unable to initialize the payment. Please try again.',
            ...( (process.env.VERCEL_ENV || '').toLowerCase() === 'preview' && error?.previewDiagnostic
                ? { diagnostic: error.previewDiagnostic }
                : {})
        });
    }
}
