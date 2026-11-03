
import { getSupabaseAdmin } from '../lib/supabase-admin.js';

export default async function handler(req, res) {
    if (req.method !== 'GET' && req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const authorization = req.headers.authorization || '';
        const token = authorization.startsWith('Bearer ')
            ? authorization.slice(7).trim()
            : '';

        if (!token) {
            return res.status(401).json({ error: 'Authentication required.' });
        }

        const supabaseAdmin = getSupabaseAdmin();

        // Verify the actual signed-in Supabase user.
        const {
            data: { user },
            error: authError
        } = await supabaseAdmin.auth.getUser(token);
        if (authError || !user) {
            return res.status(401).json({ error: 'Invalid or expired session.' });
        }

        const churchId = req.method === 'GET'
            ? req.query.church_id
            : req.body?.church_id;

        if (!churchId || typeof churchId !== 'string') {
            return res.status(400).json({ error: 'A valid church_id is required.' });
        }

        // Read the user's actual role and church assignment from Supabase.
        const { data: profile, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('role, church_id')
            .eq('id', user.id)
            .maybeSingle();

        if (profileError) {
            throw profileError;
        }

        // A Church Admin may manage only their own church.
        if (
            !profile ||
            profile.role !== 'church_admin' ||
            profile.church_id !== churchId
        ) {
            return res.status(403).json({
                error: 'You are not authorized to manage these Pesapal settings.'
            });
        }

        if (req.method === 'GET') {
            const { data: church, error } = await supabaseAdmin
                .from('churches')
                .select('pesapal_consumer_key, pesapal_consumer_secret, pesapal_env')
                .eq('id', churchId)
                .maybeSingle();

            if (error) throw error;

            if (!church) {
                return res.status(404).json({ error: 'Church not found.' });
            }

            // Never return the actual consumer secret to the browser.
            return res.status(200).json({
                pesapal_consumer_key: church.pesapal_consumer_key || '',
                pesapal_env: church.pesapal_env || 'sandbox',
                secret_configured: Boolean(church.pesapal_consumer_secret)
            });
        }

        const {
            pesapal_consumer_key,
            pesapal_consumer_secret,
            pesapal_env
        } = req.body || {};

        const key = typeof pesapal_consumer_key === 'string'
            ? pesapal_consumer_key.trim()
            : '';

        const secret = typeof pesapal_consumer_secret === 'string'
            ? pesapal_consumer_secret.trim()
            : '';

        if (!key) {
            return res.status(400).json({
                error: 'Pesapal Consumer Key is required.'
            });
        }

        if (!['sandbox', 'live'].includes(pesapal_env)) {
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
            return res.status(404).json({ error: 'Church not found.' });
        }

        // An empty secret means keep the existing secret.
        if (!secret && !existingChurch.pesapal_consumer_secret) {
            return res.status(400).json({
                error: 'Please enter the Pesapal Consumer Secret.'
            });
        }

        const updates = {
            pesapal_consumer_key: key,
            pesapal_env
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

        return res.status(500).json({
            error: 'Unable to process Pesapal settings.'
        });
    }
}
