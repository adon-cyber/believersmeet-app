const { createClient } = require('@supabase/supabase-js');

const getPesapalBaseUrl = () => {
    const env = process.env.PESAPAL_ENV || 'sandbox';
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

async function getPesapalToken() {
    const consumerKey = process.env.PESAPAL_CONSUMER_KEY;
    const consumerSecret = process.env.PESAPAL_CONSUMER_SECRET;

    if (!consumerKey || !consumerSecret) {
        throw new Error('Missing PESAPAL_CONSUMER_KEY or PESAPAL_CONSUMER_SECRET environment variables');
    }

    const response = await fetch(`${getPesapalBaseUrl()}/api/Auth/RequestToken`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
        },
        body: JSON.stringify({
            consumer_key: consumerKey,
            consumer_secret: consumerSecret
        })
    });

    const data = await response.json();
    if (!response.ok || !data.token) {
        throw new Error(data.message || 'Failed to authenticate with Pesapal');
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
        // 1. Authenticate with Pesapal
        const token = await getPesapalToken();

        // 2. Query transaction status from Pesapal API
        const statusResponse = await fetch(`${getPesapalBaseUrl()}/api/Transactions/GetTransactionStatus?orderTrackingId=${orderTrackingId}`, {
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
        // Pesapal payment_status_description can be 'Completed', 'Failed', 'Invalid', etc.
        
        let dbStatus = 'pending';
        if (paymentStatus && paymentStatus.toLowerCase() === 'completed') {
            dbStatus = 'successful';
        } else if (['failed', 'invalid', 'reversed'].includes(paymentStatus?.toLowerCase())) {
            dbStatus = 'failed';
        }

        // 3. Update Supabase donations table using Admin client (bypassing RLS)
        const supabaseAdmin = getSupabaseAdmin();

        const updateQuery = orderMerchantReference 
            ? supabaseAdmin.from('donations').update({ status: dbStatus, pesapal_tracking_id: orderTrackingId }).eq('transaction_reference', orderMerchantReference)
            : supabaseAdmin.from('donations').update({ status: dbStatus }).eq('pesapal_tracking_id', orderTrackingId);

        const { error: dbError } = await updateQuery;

        if (dbError) {
            console.error('Failed to update donation status in Supabase:', dbError);
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
