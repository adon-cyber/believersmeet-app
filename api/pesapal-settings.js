import {
    getSupabaseAdmin,
    getSupabaseUserContext
} from '../lib/supabase-admin.js';

function getRequestBody(req) {
    if (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) {
        return req.body;
    }

    if (typeof req.body === 'string') {
        try {
            const parsed = JSON.parse(req.body);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
                ? parsed
                : null;
        } catch {
            return null;
        }
    }

    return {};
}

function getQueryValue(value) {
    return Array.isArray(value) ? value[0] : value;
}

function getBearerToken(req) {
    const authorization =
        req.headers?.authorization ||
        req.headers?.Authorization ||
        '';

    const match = /^Bearer\s+(.+)$/i.exec(String(authorization).trim());
    return match ? match[1].trim() : null;
}

function makeError(statusCode, message, diagnosticCode = null) {
    const error = new Error(message);
    error.statusCode = statusCode;
    if (diagnosticCode) error.diagnosticCode = diagnosticCode;
    return error;
}

function getPesapalBaseUrl(environment) {
    if (environment === 'live') return 'https://pay.pesapal.com/v3';
    if (environment === 'sandbox') return 'https://cybqa.pesapal.com/pesapalv3';
    throw makeError(400, 'Choose a valid Pesapal environment.');
}

function getConfiguredPublicUrl(variableName, label) {
    const value = String(process.env[variableName] || '').trim();
    if (!value) {
        throw makeError(503, `The Preview/Production server is missing its ${variableName} configuration.`, `${label}_url_missing`);
    }

    let parsed;
    try {
        parsed = new URL(value);
    } catch {
        throw makeError(503, `The server ${label} URL is invalid.`, `${label}_url_invalid`);
    }

    if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
        throw makeError(503, `The server ${label} URL must be a public HTTPS URL.`, `${label}_url_invalid`);
    }

    return parsed;
}

function getConfiguredIpnUrl() {
    const url = getConfiguredPublicUrl('PESAPAL_IPN_URL', 'ipn');
    if (url.pathname.replace(/\/+$/, '') !== '/api/pesapal-ipn' || url.search) {
        throw makeError(503, 'PESAPAL_IPN_URL must point to this deployment’s /api/pesapal-ipn endpoint without query parameters.', 'ipn_url_invalid');
    }
    return url;
}

function getConfiguredCallbackUrl() {
    const url = getConfiguredPublicUrl('PESAPAL_CALLBACK_URL', 'callback');
    if (url.pathname.replace(/\/+$/, '') !== '/giving.html' || url.search) {
        throw makeError(503, 'PESAPAL_CALLBACK_URL must point to this deployment’s /giving.html page.', 'callback_url_invalid');
    }
    return url;
}

function assertGatewayUrlsShareOrigin(ipnUrl, callbackUrl) {
    if (ipnUrl.origin !== callbackUrl.origin) {
        throw makeError(
            503,
            'The Pesapal callback and IPN URLs must belong to the same Preview/Production deployment.',
            'gateway_url_origin_mismatch'
        );
    }
}

function sameIpnEndpoint(candidateValue, expectedUrl) {
    if (typeof candidateValue !== 'string' || !candidateValue.trim()) return false;

    try {
        const candidate = new URL(candidateValue);
        return candidate.origin === expectedUrl.origin &&
            candidate.pathname.replace(/\/+$/, '') === expectedUrl.pathname.replace(/\/+$/, '') &&
            candidate.search === expectedUrl.search;
    } catch {
        return false;
    }
}

function isActiveIpn(entry) {
    const responseStatus = String(entry?.status ?? '');
    const ipnStatus = entry?.ipn_status;
    const acceptedResponseStatus = responseStatus === '200' ||
        (responseStatus === '1' && Number(ipnStatus) === 1);
    const acceptedIpnStatus = ipnStatus === null || ipnStatus === undefined || Number(ipnStatus) === 1;

    return acceptedResponseStatus &&
        acceptedIpnStatus &&
        (entry?.error === null || entry?.error === undefined) &&
        typeof entry?.ipn_id === 'string' &&
        Boolean(entry.ipn_id.trim()) &&
        typeof entry?.url === 'string';
}

async function readPesapalJson(response, label) {
    const responseText = await response.text();
    let payload;

    try {
        payload = JSON.parse(responseText);
    } catch {
        throw makeError(502, `${label} returned an unreadable response.`, 'pesapal_invalid_response');
    }

    if (!response.ok || String(payload?.status) !== '200') {
        throw makeError(422, `${label} failed. Check the Pesapal credentials and environment.`, 'pesapal_request_failed');
    }

    return payload;
}

async function getPesapalToken(consumerKey, consumerSecret, baseUrl) {
    let response;
    try {
        response = await fetch(`${baseUrl}/api/Auth/RequestToken`, {
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
    } catch {
        throw makeError(502, 'Could not reach Pesapal. Please try again.', 'pesapal_network_error');
    }

    const data = await readPesapalJson(response, 'Pesapal authentication');
    if (typeof data.token !== 'string' || !data.token.trim()) {
        throw makeError(502, 'Pesapal did not return an access token.', 'pesapal_token_missing');
    }

    return data.token;
}

async function getRegisteredPesapalIpns(token, baseUrl) {
    let response;
    try {
        response = await fetch(`${baseUrl}/api/URLSetup/GetIpnList`, {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                Authorization: `Bearer ${token}`
            }
        });
    } catch {
        throw makeError(502, 'Could not retrieve the Pesapal IPN registrations.', 'ipn_list_network_error');
    }

    const responseText = await response.text();
    let payload;
    try {
        payload = JSON.parse(responseText);
    } catch {
        throw makeError(502, 'Pesapal returned an unreadable IPN list.', 'ipn_list_invalid_response');
    }

    if (!response.ok || !Array.isArray(payload)) {
        throw makeError(502, 'Could not retrieve the Pesapal IPN registrations.', 'ipn_list_failed');
    }

    return payload;
}

async function registerPesapalIpn(token, ipnUrl, baseUrl) {
    let response;
    try {
        response = await fetch(`${baseUrl}/api/URLSetup/RegisterIPN`, {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
                url: ipnUrl.toString(),
                ipn_notification_type: 'GET'
            })
        });
    } catch {
        throw makeError(502, 'Could not register the Pesapal notification URL. Please retry.', 'ipn_register_network_error');
    }

    const data = await readPesapalJson(response, 'Pesapal IPN registration');
    if (typeof data.ipn_id !== 'string' || !data.ipn_id.trim()) {
        throw makeError(502, 'Pesapal did not return an IPN registration ID.', 'ipn_id_missing');
    }
    if (Number(data.ipn_status) !== 1 || (data.error !== null && data.error !== undefined)) {
        throw makeError(502, 'Pesapal returned an IPN registration that is not active.', 'ipn_registration_inactive');
    }
    if (!sameIpnEndpoint(data.url, ipnUrl)) {
        throw makeError(502, 'Pesapal returned an IPN registration for a different notification URL.', 'ipn_registration_url_mismatch');
    }

    return data.ipn_id.trim();
}

async function inspectIpnRegistration(token, ipnUrl, baseUrl, preferredIpnId = null) {
    const registered = await getRegisteredPesapalIpns(token, baseUrl);
    const matches = registered.filter((entry) =>
        isActiveIpn(entry) && sameIpnEndpoint(entry.url, ipnUrl)
    );

    const preferred = preferredIpnId
        ? matches.find((entry) => entry.ipn_id.trim() === preferredIpnId)
        : null;

    if (preferred) {
        return { ipnId: preferred.ipn_id.trim(), matchCount: matches.length, created: false };
    }

    if (matches.length === 1) {
        return { ipnId: matches[0].ipn_id.trim(), matchCount: 1, created: false };
    }

    if (matches.length > 1) {
        throw makeError(
            409,
            'Multiple active Pesapal IPN registrations match this server URL. Manual review is required before saving.',
            'ipn_duplicate_registrations'
        );
    }

    return { ipnId: null, matchCount: 0, created: false };
}

async function ensureIpnRegistration(token, ipnUrl, baseUrl, preferredIpnId = null) {
    const inspected = await inspectIpnRegistration(token, ipnUrl, baseUrl, preferredIpnId);
    if (inspected.ipnId) return inspected;

    const ipnId = await registerPesapalIpn(token, ipnUrl, baseUrl);
    return { ipnId, matchCount: 0, created: true };
}

async function verifyPlatformAdmin(userContext) {
    const { data, error } = await userContext.rpc('is_super_admin');
    if (error) {
        console.error('Super Admin verification failed:', error.message);
        throw makeError(503, 'Super Admin access could not be verified.', 'platform_admin_check_failed');
    }
    return data === true;
}

async function authorizeChurchSettings(supabaseAdmin, userContext, userId, churchId, setDiagnosticStage) {
    setDiagnosticStage('profile_authorization_lookup');
    const { data: profile, error } = await supabaseAdmin
        .from('profiles')
        .select('role, church_id, status, is_blocked')
        .eq('id', userId)
        .maybeSingle();

    if (error) throw error;
    if (!profile || String(profile.status || '').toLowerCase() !== 'active' || profile.is_blocked !== false) {
        return false;
    }

    setDiagnosticStage('platform_admin_rpc');
    const isPlatformAdmin = await verifyPlatformAdmin(userContext);
    if (isPlatformAdmin) return true;

    const role = String(profile.role || '').trim().toLowerCase();
    return ['admin', 'church_admin'].includes(role) && profile.church_id === churchId;
}

function normalizeEnvironment(value) {
    return String(value || 'sandbox').trim().toLowerCase();
}

function enforcePreviewEnvironment(environment) {
    if ((process.env.VERCEL_ENV || '').toLowerCase() === 'preview' && environment !== 'sandbox') {
        throw makeError(403, 'Preview deployments are restricted to Pesapal Sandbox.', 'preview_live_blocked');
    }
}

export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    let diagnosticStage = 'request_validation';
    if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({ error: 'Method not allowed.' });
    }

    try {
        const token = getBearerToken(req);
        if (!token) return res.status(401).json({ error: 'Authentication required.' });

        diagnosticStage = 'supabase_admin_init';
        const supabaseAdmin = getSupabaseAdmin();

        diagnosticStage = 'user_session_validation';
        const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
        if (authError || !user) {
            return res.status(401).json({ error: 'Invalid or expired session.' });
        }

        const body = req.method === 'POST' ? getRequestBody(req) : {};
        if (!body) return res.status(400).json({ error: 'A valid JSON request body is required.' });

        const churchId = String(
            req.method === 'GET'
                ? getQueryValue(req.query?.church_id) || ''
                : body.church_id || ''
        ).trim();

        if (!churchId) return res.status(400).json({ error: 'A valid church_id is required.' });

        diagnosticStage = 'user_context_init';
        const userContext = getSupabaseUserContext(token);
        const authorized = await authorizeChurchSettings(
            supabaseAdmin,
            userContext,
            user.id,
            churchId,
            (stage) => { diagnosticStage = stage; }
        );

        if (!authorized) {
            return res.status(403).json({ error: 'An active Church Admin or authorized Platform Super Admin is required.' });
        }

        diagnosticStage = 'church_settings_read';
        const { data: church, error: churchError } = await supabaseAdmin
            .from('churches')
            .select('id, name, status, pesapal_consumer_key, pesapal_consumer_secret, pesapal_env, pesapal_ipn_id, latitude, longitude, trial_ends_at')
            .eq('id', churchId)
            .maybeSingle();

        if (churchError) throw churchError;
        if (!church) return res.status(404).json({ error: 'Church not found.' });

        if (req.method === 'GET') {
            return res.status(200).json({
                pesapal_consumer_key: church.pesapal_consumer_key || '',
                pesapal_env: church.pesapal_env || 'sandbox',
                secret_configured: Boolean(church.pesapal_consumer_secret),
                ipn_configured: Boolean(church.pesapal_ipn_id),
                callback_url_configured: Boolean(String(process.env.PESAPAL_CALLBACK_URL || '').trim()),
                ipn_url_configured: Boolean(String(process.env.PESAPAL_IPN_URL || '').trim()),
                church_approved: String(church.status || '').toLowerCase() === 'approved',
                latitude: church.latitude,
                longitude: church.longitude,
                trial_ends_at: church.trial_ends_at
            });
        }

        if (body.action === 'update_location') {
            if (
                body.latitude === null || body.latitude === undefined || String(body.latitude).trim() === '' ||
                body.longitude === null || body.longitude === undefined || String(body.longitude).trim() === ''
            ) {
                return res.status(400).json({ error: 'Both latitude and longitude are required.' });
            }

            const latitude = Number(body.latitude);
            const longitude = Number(body.longitude);
            if (!Number.isFinite(latitude) || !Number.isFinite(longitude) ||
                latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
                return res.status(400).json({ error: 'Enter valid latitude and longitude coordinates.' });
            }

            const { error } = await supabaseAdmin
                .from('churches')
                .update({ latitude, longitude })
                .eq('id', churchId);
            if (error) throw error;
            return res.status(200).json({ success: true });
        }

        if (String(church.status || '').toLowerCase() !== 'approved') {
            return res.status(409).json({ error: 'Only approved churches can configure Pesapal payments.' });
        }

        const action = String(body.action || 'save_settings').trim().toLowerCase();
        if (!['save_settings', 'test_connection'].includes(action)) {
            return res.status(400).json({ error: 'Unsupported Pesapal settings action.' });
        }

        const keyInput = typeof body.pesapal_consumer_key === 'string'
            ? body.pesapal_consumer_key.trim()
            : '';
        const secretInput = typeof body.pesapal_consumer_secret === 'string'
            ? body.pesapal_consumer_secret.trim()
            : '';
        const key = keyInput || String(church.pesapal_consumer_key || '').trim();
        const secret = secretInput || String(church.pesapal_consumer_secret || '').trim();
        const environment = normalizeEnvironment(body.pesapal_env || church.pesapal_env || 'sandbox');

        if (!key) return res.status(400).json({ error: 'Enter the Pesapal Consumer Key.' });
        if (!secret) return res.status(400).json({ error: 'Enter the Pesapal Consumer Secret.' });
        if (!['sandbox', 'live'].includes(environment)) {
            return res.status(400).json({ error: 'Environment must be sandbox or live.' });
        }
        enforcePreviewEnvironment(environment);

        const baseUrl = getPesapalBaseUrl(environment);
        diagnosticStage = 'pesapal_authentication';
        const accessToken = await getPesapalToken(key, secret, baseUrl);

        if (action === 'test_connection') {
            let ipnStatus = 'server_url_missing';
            let callbackUrlConfigured = Boolean(String(process.env.PESAPAL_CALLBACK_URL || '').trim());
            let matchingCount = 0;

            if (String(process.env.PESAPAL_IPN_URL || '').trim()) {
                diagnosticStage = 'pesapal_ipn_inspection';
                const ipnUrl = getConfiguredIpnUrl();
                if (callbackUrlConfigured) {
                    assertGatewayUrlsShareOrigin(ipnUrl, getConfiguredCallbackUrl());
                }
                const inspected = await inspectIpnRegistration(
                    accessToken,
                    ipnUrl,
                    baseUrl,
                    church.pesapal_ipn_id
                );
                matchingCount = inspected.matchCount;
                ipnStatus = inspected.ipnId ? 'registered' : 'missing';
            }

            if (callbackUrlConfigured) {
                getConfiguredCallbackUrl();
            }

            return res.status(200).json({
                success: true,
                connection_status: 'connected',
                ipn_status: ipnStatus,
                callback_url_configured: callbackUrlConfigured,
                matching_ipn_count: matchingCount,
                environment
            });
        }

        diagnosticStage = 'pending_payments_check';
        const configurationChanged =
            key !== String(church.pesapal_consumer_key || '').trim() ||
            secret !== String(church.pesapal_consumer_secret || '').trim() ||
            environment !== normalizeEnvironment(church.pesapal_env || 'sandbox');

        if (configurationChanged) {
            const { count, error: pendingError } = await supabaseAdmin
                .from('transactions')
                .select('id', { count: 'exact', head: true })
                .eq('church_id', churchId)
                .eq('payment_method', 'pesapal')
                .in('status', ['PENDING', 'pending', 'PROCESSING', 'processing']);

            if (pendingError) throw pendingError;
            if (Number(count || 0) > 0) {
                throw makeError(
                    409,
                    'This church has pending Pesapal payments. Verify or reconcile them before changing the Consumer Key, Secret or environment.',
                    'pending_payments_block_configuration_change'
                );
            }
        }

        diagnosticStage = 'pesapal_ipn_registration';
        const ipnUrl = getConfiguredIpnUrl();
        const callbackUrl = getConfiguredCallbackUrl();
        assertGatewayUrlsShareOrigin(ipnUrl, callbackUrl);
        const ipn = await ensureIpnRegistration(
            accessToken,
            ipnUrl,
            baseUrl,
            church.pesapal_ipn_id
        );

        const updates = {
            pesapal_consumer_key: key,
            pesapal_consumer_secret: secret,
            pesapal_env: environment,
            pesapal_ipn_id: ipn.ipnId
        };

        diagnosticStage = 'church_pesapal_settings_save';
        const { data: savedChurch, error: saveError } = await supabaseAdmin
            .from('churches')
            .update(updates)
            .eq('id', churchId)
            .eq('status', 'approved')
            .select('id')
            .maybeSingle();

        if (saveError) throw saveError;
        if (!savedChurch) {
            throw makeError(409, 'Church settings were not saved because the church is no longer approved. Refresh and try again.', 'church_status_changed');
        }

        return res.status(200).json({
            success: true,
            secret_configured: true,
            connection_status: 'connected',
            ipn_status: 'registered',
            ipn_created: ipn.created,
            environment
        });

    } catch (error) {
        console.error('Pesapal settings API error:', {
            stage: diagnosticStage,
            code: error?.diagnosticCode || null,
            message: error?.message || 'Unknown error'
        });

        const statusCode = Number(error?.statusCode) || 500;
        const diagnosticCode = String(error?.diagnosticCode || '');
        const safeConfigurationError = diagnosticCode.startsWith('ipn_') ||
            diagnosticCode.startsWith('callback_') ||
            diagnosticCode.startsWith('gateway_') ||
            diagnosticCode.startsWith('pending_payments_');
        const safeMessage = statusCode < 500 || safeConfigurationError
            ? error.message
            : 'Unable to process Pesapal settings. Please retry or contact support.';

        return res.status(statusCode).json({
            error: safeMessage,
            diagnostic_stage: diagnosticStage,
            ...( (process.env.VERCEL_ENV || '').toLowerCase() === 'preview' && error?.diagnosticCode
                ? { diagnostic_code: error.diagnosticCode }
                : {})
        });
    }
}
