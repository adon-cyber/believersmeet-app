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

async function verifyPlatformAdmin(userContext) {
    // The zero-argument database function checks the private
    // platform_admins allowlist against auth.uid().
    const { data, error } = await userContext.rpc('is_super_admin');

    if (error) {
        console.error('Super Admin verification failed:', error);

        const verificationError = new Error(
            'Super Admin access could not be verified.'
        );
        verificationError.statusCode = 503;
        throw verificationError;
    }

    return data === true;
}
async function authorizeChurchSettings(
    supabaseAdmin,
    userContext,
    userId,
    churchId
) {
    // The private platform-admin allowlist is the authority.
    // It is independent of the profile's displayed role.
    const isPlatformAdmin = await verifyPlatformAdmin(userContext);

    if (isPlatformAdmin) {
        return true;
    }

    const { data: profile, error } = await supabaseAdmin
        .from('profiles')
        .select('role, church_id')
        .eq('id', userId)
        .maybeSingle();

    if (error) throw error;
    if (!profile) return false;

    // Church administrators may manage only their assigned church.
    const role = String(profile.role || '').trim().toLowerCase();

    if (['admin', 'church_admin'].includes(role)) {
        return profile.church_id === churchId;
    }

    return false;
}
export default async function handler(req, res) {
    res.setHeader('Cache-Control', 'no-store');

    if (req.method !== 'GET' && req.method !== 'POST') {
        res.setHeader('Allow', 'GET, POST');
        return res.status(405).json({
            error: 'Method not allowed.'
        });
    }

    try {
        const token = getBearerToken(req);

        if (!token) {
            return res.status(401).json({
                error: 'Authentication required.'
            });
        }

        const supabaseAdmin = getSupabaseAdmin();

        const {
            data: { user },
            error: authError
        } = await supabaseAdmin.auth.getUser(token);

        if (authError || !user) {
            return res.status(401).json({
                error: 'Invalid or expired session.'
            });
        }

        const body = req.method === 'POST'
            ? getRequestBody(req)
            : {};

        if (!body) {
            return res.status(400).json({
                error: 'A valid JSON request body is required.'
            });
        }

        const churchId = String(
            req.method === 'GET'
                ? getQueryValue(req.query?.church_id) || ''
                : body.church_id || ''
        ).trim();

        if (!churchId) {
            return res.status(400).json({
                error: 'A valid church_id is required.'
            });
        }

        const userContext = getSupabaseUserContext(token);

        const authorized = await authorizeChurchSettings(
            supabaseAdmin,
            userContext,
            user.id,
            churchId
        );

        if (!authorized) {
            return res.status(403).json({
                error: 'You are not authorized to manage this church.'
            });
        }

        // Return safe settings only. Never return the actual secret.
        if (req.method === 'GET') {
            const { data: church, error } = await supabaseAdmin
                .from('churches')
                .select(
                    'pesapal_consumer_key, pesapal_consumer_secret, pesapal_env, latitude, longitude, trial_ends_at'
                )
                .eq('id', churchId)
                .maybeSingle();

            if (error) throw error;

            if (!church) {
                return res.status(404).json({
                    error: 'Church not found.'
                });
            }

            return res.status(200).json({
                pesapal_consumer_key: church.pesapal_consumer_key || '',
                pesapal_env: church.pesapal_env || 'sandbox',
                secret_configured: Boolean(church.pesapal_consumer_secret),
                latitude: church.latitude,
                longitude: church.longitude,
                trial_ends_at: church.trial_ends_at
            });
        }

        // Secure location update for manual coordinates and GPS.
        if (body.action === 'update_location') {
            if (
                body.latitude === null ||
                body.latitude === undefined ||
                String(body.latitude).trim() === '' ||
                body.longitude === null ||
                body.longitude === undefined ||
                String(body.longitude).trim() === ''
            ) {
                return res.status(400).json({
                    error: 'Both latitude and longitude are required.'
                });
            }

            const latitude = Number(body.latitude);
            const longitude = Number(body.longitude);

            if (
                !Number.isFinite(latitude) ||
                !Number.isFinite(longitude) ||
                latitude < -90 ||
                latitude > 90 ||
                longitude < -180 ||
                longitude > 180
            ) {
                return res.status(400).json({
                    error: 'Enter valid latitude and longitude coordinates.'
                });
            }

            const { error } = await supabaseAdmin
                .from('churches')
                .update({ latitude, longitude })
                .eq('id', churchId);

            if (error) throw error;

            return res.status(200).json({ success: true });
        }

        // Save Pesapal settings.
        const key = typeof body.pesapal_consumer_key === 'string'
            ? body.pesapal_consumer_key.trim()
            : '';

        const secret = typeof body.pesapal_consumer_secret === 'string'
            ? body.pesapal_consumer_secret.trim()
            : '';

        const environment = body.pesapal_env;

        // Preview deployments must never configure live Pesapal payments.
        if ((process.env.VERCEL_ENV || '').toLowerCase() === 'preview' && environment !== 'sandbox') {
            return res.status(403).json({
                error: 'Preview deployments are restricted to Pesapal Sandbox.'
            });
        }

        if (!key) {
            return res.status(400).json({
                error: 'Pesapal Consumer Key is required.'
            });
        }

        if (!['sandbox', 'live'].includes(environment)) {
            return res.status(400).json({
                error: 'Environment must be sandbox or live.'
            });
        }

        const { data: existingChurch, error: existingError } =
            await supabaseAdmin
                .from('churches')
                .select('pesapal_consumer_secret')
                .eq('id', churchId)
                .maybeSingle();

        if (existingError) throw existingError;

        if (!existingChurch) {
            return res.status(404).json({
                error: 'Church not found.'
            });
        }

        if (!secret && !existingChurch.pesapal_consumer_secret) {
            return res.status(400).json({
                error: 'Please enter the Pesapal Consumer Secret.'
            });
        }

        const updates = {
            pesapal_consumer_key: key,
            pesapal_env: environment
        };

        if (secret) {
            updates.pesapal_consumer_secret = secret;
        }

        const { error: updateError } = await supabaseAdmin
            .from('churches')
            .update(updates)
            .eq('id', churchId);

        if (updateError) throw updateError;

        return res.status(200).json({
            success: true,
            secret_configured: true
        });

    } catch (error) {
        console.error('Pesapal settings API error:', error);

        return res.status(error.statusCode || 500).json({
            error: error.statusCode === 503
                ? error.message
                : 'Unable to process the request.'
        });
    }
}