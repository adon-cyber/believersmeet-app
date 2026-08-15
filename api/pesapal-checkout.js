const { createClient } = require('@supabase/supabase-js');

const BASE_URL = process.env.PESAPAL_ENV === 'live' 
  ? 'https://pay.pesapal.com/v3' 
  : 'https://cybqa.pesapal.com/pesapalv3';

// Initialize Supabase Admin Client using service role key to bypass RLS securely in serverless function
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

// Helper to get Pesapal Bearer Token
async function getPesapalToken() {
    const consumerKey = process.env.PESAPAL_CONSUMER_KEY?.trim();
    const consumerSecret = process.env.PESAPAL_CONSUMER_SECRET?.trim();

    if (!consumerKey || !consumerSecret) {
        throw new Error('Missing PESAPAL_CONSUMER_KEY or PESAPAL_CONSUMER_SECRET environment variables');
    }

    const authRes = await fetch(`${BASE_URL}/api/Auth/RequestToken`, {
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

    const authData = await authRes.json();
    console.log("Pesapal Auth Response Status:", authRes.status);
    console.log("Pesapal Auth Response Data:", JSON.stringify(authData));

    if (!authRes.ok || authData.status !== "200" || !authData.token) {
        throw new Error(authData.message || 'Failed to authenticate with Pesapal');
    }

    return authData.token;
}

// Helper to register IPN URL if not already registered or cached
async function registerIPN(token, callbackUrl) {
    const pesapalRes = await fetch(`${BASE_URL}/api/URLSetup/RegisterIPN`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json',
            'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
            url: callbackUrl,
            ipn_notification_type: 'GET'
        })
    });

    const pesapalText = await pesapalRes.text();

    let pesapalData;
    try {
        pesapalData = JSON.parse(pesapalText);
    } catch (e) {
        console.error("Pesapal returned non-JSON response:", pesapalText);
        throw new Error("Pesapal API Error: " + pesapalText);
    }

    if (!pesapalRes.ok || pesapalData.status !== "200") {
        throw new Error(pesapalData.message || 'Failed to register Pesapal IPN URL');
    }

    return pesapalData.ipn_id;
}

export default async function handler(req, res) {
    console.log("Using Pesapal Base URL:", BASE_URL);

    // Enable CORS
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

    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Method not allowed' });
    }

    try {
        const { amount, currency = 'KES', email, userId, description = 'Church Donation', phone_number } = req.body;

        if (!amount) {
            return res.status(400).json({ error: 'Missing required field: amount' });
        }

        const donorEmail = email || process.env.DEFAULT_CHURCH_EMAIL || 'giving@believersmeet.org';
        const merchantReference = 'BM-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);

        // 1. Authenticate with Pesapal
        const token = await getPesapalToken();

        // 2. Register IPN URL
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const ipnUrl = process.env.PESAPAL_IPN_URL || `${protocol}://${host}/api/pesapal-ipn`;
        const callbackUrl = process.env.PESAPAL_CALLBACK_URL || `${protocol}://${host}/payment-success.html`;

        const ipnId = await registerIPN(token, ipnUrl);

        // 3. Submit Order Request
        const orderPayload = {
            id: merchantReference,
            currency: currency,
            amount: parseFloat(amount),
            description: description,
            callback_url: callbackUrl,
            notification_id: ipnId,
            billing_address: {
                email_address: donorEmail,
                phone_number: phone_number || '0712345678',
                country_code: 'KE',
                first_name: 'Church',
                last_name: 'Donor',
            }
        };

        const pesapalRes = await fetch(`${BASE_URL}/api/Transactions/SubmitOrderRequest`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify(orderPayload)
        });

        const pesapalText = await pesapalRes.text();

        let orderData;
        try {
            orderData = JSON.parse(pesapalText);
        } catch (e) {
            console.error("Pesapal returned non-JSON response:", pesapalText);
            return res.status(502).json({ 
                error: "Pesapal API Error", 
                details: pesapalText 
            });
        }

        if (!pesapalRes.ok || orderData.status !== "200" || !orderData.redirect_url) {
            return res.status(pesapalRes.status || 400).json(orderData);
        }

        // Return redirect_url, order_tracking_id, and merchant_reference to frontend
        return res.status(200).json({
            success: true,
            redirect_url: orderData.redirect_url,
            order_tracking_id: orderData.order_tracking_id,
            merchant_reference: merchantReference
        });

    } catch (error) {
        console.error('Pesapal checkout error:', error);
        return res.status(500).json({
            success: false,
            error: error.message || 'Internal server error during checkout'
        });
    }
}
