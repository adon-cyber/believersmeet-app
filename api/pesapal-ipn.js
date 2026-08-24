const { createClient } = require('@supabase/supabase-js');

const getPesapalBaseUrl = (env) => {
    return env === 'live' 
        ? 'https://pay.pesapal.com/v3' 
        : 'https://cybqa.pesapal.com/pesapalv3';
};

const getSupabaseAdmin = () => {
    const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
    const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!supabaseUrl || !supabaseServiceKey) {
        throw new Error('Missing Supabase environment variables (SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)');
    }

    return createClient(supabaseUrl, supabaseServiceKey, {
        auth: { persistSession: false }
    });
};

async function getPesapalToken(consumerKey, consumerSecret, baseUrl) {
    if (!consumerKey || !consumerSecret) {
        throw new Error('Missing Pesapal Consumer Key or Consumer Secret for this church');
    }

    const response = await fetch(`${baseUrl}/api/Auth/RequestToken`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            consumer_key: consumerKey.trim(),
            consumer_secret: consumerSecret.trim()
        })
    });

    const data = await response.json();
    if (!response.ok || data.status !== "200" || !data.token) {
        throw new Error(data.message || 'Failed to authenticate with Pesapal using church credentials');
    }

    return data.token;
}

export default async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Credentials', true);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
    res.setHeader(
        'Access-Control-Allow-Headers',
        'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
    );

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    // Pesapal IPN sends GET request containing OrderTrackingId and OrderMerchantReference
    const orderTrackingId = req.query.OrderTrackingId || req.body?.OrderTrackingId;
    const orderMerchantReference = req.query.OrderMerchantReference || req.body?.OrderMerchantReference;
    const notificationType = req.query.OrderNotificationType || req.body?.OrderNotificationType;

    if (!orderTrackingId) {
        return res.status(400).json({ status: 400, message: 'OrderTrackingId is required' });
    }

    try {
        const supabaseAdmin = getSupabaseAdmin();

        let churchId = null;

        // 1. Query the transactions table using orderMerchantReference to get the transaction's church_id
        if (orderMerchantReference) {
            const { data: txData, error: txError } = await supabaseAdmin
                .from('transactions')
                .select('church_id')
                .eq('merchant_reference', orderMerchantReference)
                .single();

            if (txData && txData.church_id) {
                churchId = txData.church_id;
            }
        }

        // Fallback: If not found by merchant_reference, try querying by pesapal_tracking_id
        if (!churchId) {
            const { data: txData, error: txError } = await supabaseAdmin
                .from('transactions')
                .select('church_id')
                .eq('pesapal_tracking_id', orderTrackingId)
                .single();

            if (txData && txData.church_id) {
                churchId = txData.church_id;
            }
        }

        let pesapal_consumer_key = null;
        let pesapal_consumer_secret = null;
        let pesapal_env = 'sandbox';

        if (churchId) {
            // 2. Query the churches table with that church_id to retrieve pesapal credentials
            const { data: churchData, error: churchError } = await supabaseAdmin
                .from('churches')
                .select('pesapal_consumer_key, pesapal_consumer_secret, pesapal_env')
                .eq('id', churchId)
                .single();

            if (churchData) {
                pesapal_consumer_key = churchData.pesapal_consumer_key;
                pesapal_consumer_secret = churchData.pesapal_consumer_secret;
                pesapal_env = churchData.pesapal_env || 'sandbox';
            }
        }

        // Fallback to environment variables if church credentials are not found
        if (!pesapal_consumer_key || !pesapal_consumer_secret) {
            pesapal_consumer_key = process.env.PESAPAL_CONSUMER_KEY;
            pesapal_consumer_secret = process.env.PESAPAL_CONSUMER_SECRET;
            pesapal_env = process.env.PESAPAL_ENV || 'sandbox';
        }

        const baseUrl = getPesapalBaseUrl(pesapal_env);

        // 3. Use those church credentials dynamically to authenticate with Pesapal
        const token = await getPesapalToken(pesapal_consumer_key, pesapal_consumer_secret, baseUrl);

        // 4. Query transaction status from Pesapal API
        const statusResponse = await fetch(`${baseUrl}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`, {
            method: 'GET',
            headers: {
                'Accept': 'application/json',
                'Authorization': `Bearer ${token}`
            }
        });

        const statusData = await statusResponse.json();

        if (!statusResponse.ok) {
            throw new Error(statusData.message || 'Failed to retrieve transaction status from Pesapal');
        }

        const paymentStatus = statusData.payment_status_description || statusData.status; 
        
        let dbStatus = 'PENDING';
        if (paymentStatus && paymentStatus.toLowerCase() === 'completed') {
            dbStatus = 'COMPLETED';
        } else if (['failed', 'invalid', 'reversed'].includes(paymentStatus?.toLowerCase())) {
            dbStatus = 'FAILED';
        }

        // 5. Update Supabase transactions table using Admin client (bypassing RLS)
        const updateQuery = orderMerchantReference 
            ? supabaseAdmin.from('transactions').update({ status: dbStatus, pesapal_tracking_id: orderTrackingId }).eq('merchant_reference', orderMerchantReference)
            : supabaseAdmin.from('transactions').update({ status: dbStatus }).eq('pesapal_tracking_id', orderTrackingId);

        const { error: dbError } = await updateQuery;

        if (dbError) {
            console.error('Failed to update transaction status in Supabase:', dbError);
            throw new Error('Database update failed');
        }

        // Pesapal IPN expects a specific JSON response format acknowledging receipt
        return res.status(200).json({
            order_tracking_id: orderTrackingId,
            order_merchant_reference: orderMerchantReference,
            status: dbStatus
        });

    } catch (error) {
        console.error('Pesapal IPN handler error:', error);
        return res.status(500).json({
            status: 500,
            message: error.message || 'Internal server error processing IPN'
        });
    }
}
