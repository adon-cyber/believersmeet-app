const { createClient } = require('@supabase/supabase-js');

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

// Helper to get Pesapal Bearer Token for a specific church and environment
async function getPesapalToken(consumerKey, consumerSecret, baseUrl) {
    if (!consumerKey || !consumerSecret) {
        throw new Error('Missing Pesapal Consumer Key or Consumer Secret for this church');
    }

    const authRes = await fetch(`${baseUrl}/api/Auth/RequestToken`, {
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

    const authData = await authRes.json();
    console.log("Pesapal Auth Response Status:", authRes.status);

    if (!authRes.ok || authData.status !== "200" || !authData.token) {
        throw new Error(authData.message || 'Failed to authenticate with Pesapal using church credentials');
    }

    return authData.token;
}

// Helper to register IPN URL
async function registerIPN(token, callbackUrl, baseUrl) {
    const pesapalRes = await fetch(`${baseUrl}/api/URLSetup/RegisterIPN`, {
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
        const { amount, currency = 'KES', email, userId, church_id, description = 'Church Donation', phone_number } = req.body;

        if (!church_id) {
            return res.status(400).json({ error: "church_id is required" });
        }

        if (!amount) {
            return res.status(400).json({ error: 'Missing required field: amount' });
        }

        // 1. Query Supabase using SUPABASE_SERVICE_ROLE_KEY to fetch church's Pesapal settings
        const supabaseAdmin = getSupabaseAdmin();
        const { data: churchRecord, error: churchError } = await supabaseAdmin
            .from('churches')
            .select('pesapal_consumer_key, pesapal_consumer_secret, pesapal_ipn_id, pesapal_env')
            .eq('id', church_id)
            .single();

        if (churchError || !churchRecord || !churchRecord.pesapal_consumer_key || !churchRecord.pesapal_consumer_secret) {
            return res.status(400).json({ error: "This church has not configured their Pesapal credentials yet." });
        }

        const { pesapal_consumer_key, pesapal_consumer_secret, pesapal_env } = churchRecord;
        let { pesapal_ipn_id } = churchRecord;

        const BASE_URL = pesapal_env === 'live' ? 'https://pay.pesapal.com/v3' : 'https://cybqa.pesapal.com/pesapalv3';

        console.log(`Using Pesapal Base URL (${pesapal_env}):`, BASE_URL);

        // 2. Authenticate with Pesapal using church credentials
        const token = await getPesapalToken(pesapal_consumer_key, pesapal_consumer_secret, BASE_URL);

        // 3. If pesapal_ipn_id is missing, register IPN URL with Pesapal using the church token, and update the church row in Supabase with the generated ipn_id. Use that ipn_id for the transaction.
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        const protocol = req.headers['x-forwarded-proto'] || 'https';
        const ipnUrl = process.env.PESAPAL_IPN_URL || `${protocol}://${host}/api/pesapal-ipn`;
        const callbackUrl = process.env.PESAPAL_CALLBACK_URL || `${protocol}://${host}/payment-success.html`;

        if (!pesapal_ipn_id) {
            console.log("Registering new IPN ID for church:", church_id);
            pesapal_ipn_id = await registerIPN(token, ipnUrl, BASE_URL);

            // Save back to Supabase
            await supabaseAdmin
                .from('churches')
                .update({ pesapal_ipn_id })
                .eq('id', church_id);
        }

        const merchantReference = 'BM-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
        const donorEmail = email || process.env.DEFAULT_CHURCH_EMAIL || 'giving@believersmeet.org';

        // 4. Submit Order Request and return redirect_url to the client
        const orderPayload = {
            id: merchantReference,
            currency: currency,
            amount: parseFloat(amount),
            description: description,
            callback_url: callbackUrl,
            notification_id: pesapal_ipn_id,
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

        // Return redirect_url to the client
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
