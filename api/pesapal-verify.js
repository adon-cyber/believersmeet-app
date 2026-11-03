import { getSupabaseAdmin } from '../lib/supabase-admin.js';

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

function getPesapalBaseUrl(environment) {
    if (environment === 'live') return 'https://pay.pesapal.com/v3';

    if (environment === 'sandbox' || !environment) {
        return 'https://cybqa.pesapal.com/pesapalv3';
    }

    throw new Error('Unsupported Pesapal environment setting.');
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
        const message =
            payload?.error?.message ||
            payload?.message ||
            `${label} request failed.`;

        throw new Error(message);
    }

    return payload;
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

    if (!data.token) {
        throw new Error('Pesapal authentication did not return an access token.');
    }

    return data.token;
}

function toMinorUnits(value, currency) {
    const amount = Number(value);

    if (!Number.isFinite(amount)) return null;

    const decimals = currency === 'UGX' ? 0 : 2;
    const factor = 10 ** decimals;
    const scaled = amount * factor;

    if (!Number.isSafeInteger(Math.round(scaled))) return null;
    if (Math.abs(scaled - Math.round(scaled)) > 0.000001) return null;

    return Math.round(scaled);
}

function mapPesapalStatus(value) {
    const status = String(value || '').trim().toUpperCase();

    if (status === 'COMPLETED') return 'COMPLETED';
    if (status === 'FAILED' || status === 'INVALID') return 'FAILED';
    if (status === 'REVERSED') return 'REVERSED';
    if (status === 'PENDING' || status === 'PROCESSING') return 'PENDING';

    return null;
}

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');

        return res.status(405).json({
            success: false,
            error: 'Method not allowed.'
        });
    }

    try {
        const body = getRequestBody(req);

        if (!body) {
            return res.status(400).json({
                success: false,
                error: 'A valid JSON request body is required.'
            });
        }

        const merchantReference = String(body.merchant_reference || '').trim();
        const orderTrackingId = String(body.order_tracking_id || '').trim();

        if (!/^BM-GIVE-[0-9a-f-]{36}$/i.test(merchantReference)) {
            return res.status(400).json({
                success: false,
                error: 'A valid merchant reference is required.'
            });
        }

        if (
            orderTrackingId.length < 8 ||
            orderTrackingId.length > 120 ||
            !/^[a-zA-Z0-9-]+$/.test(orderTrackingId)
        ) {
            return res.status(400).json({
                success: false,
                error: 'A valid Pesapal tracking ID is required.'
            });
        }

        const supabaseAdmin = getSupabaseAdmin();

        const { data: transaction, error: transactionError } =
            await supabaseAdmin
                .from('transactions')
                .select(
                    'id, church_id, merchant_reference, pesapal_tracking_id, amount, currency, status'
                )
                .eq('merchant_reference', merchantReference)
                .maybeSingle();

        if (transactionError) {
            console.error('Transaction lookup failed:', transactionError.message);

            return res.status(500).json({
                success: false,
                error: 'Could not look up this donation.'
            });
        }

        if (!transaction) {
            return res.status(404).json({
                success: false,
                error: 'Donation reference was not found.'
            });
        }

        if (
            transaction.pesapal_tracking_id &&
            transaction.pesapal_tracking_id !== orderTrackingId
        ) {
            return res.status(409).json({
                success: false,
                error: 'The tracking ID does not match this donation.'
            });
        }

        const { data: church, error: churchError } = await supabaseAdmin
            .from('churches')
            .select(
                'id, pesapal_consumer_key, pesapal_consumer_secret, pesapal_env'
            )
            .eq('id', transaction.church_id)
            .maybeSingle();

        if (churchError) {
            console.error('Church lookup failed:', churchError.message);

            return res.status(500).json({
                success: false,
                error: 'Could not verify the payment account for this donation.'
            });
        }

        if (
            !church?.pesapal_consumer_key ||
            !church?.pesapal_consumer_secret
        ) {
            return res.status(400).json({
                success: false,
                error: 'The church payment account is not configured.'
            });
        }

        const baseUrl = getPesapalBaseUrl(church.pesapal_env || 'sandbox');

        const token = await getPesapalToken(
            church.pesapal_consumer_key.trim(),
            church.pesapal_consumer_secret.trim(),
            baseUrl
        );

        const statusUrl = new URL(
            `${baseUrl}/api/Transactions/GetTransactionStatus`
        );

        statusUrl.searchParams.set('orderTrackingId', orderTrackingId);

        const statusResponse = await fetch(statusUrl.toString(), {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            }
        });

        const statusData = await readPesapalJson(
            statusResponse,
            'Pesapal transaction status'
        );

        // Verify the returned merchant reference.
        if (
            String(statusData.merchant_reference || '') !==
            transaction.merchant_reference
        ) {
            return res.status(409).json({
                success: false,
                error: 'Pesapal returned a merchant reference that does not match this donation.'
            });
        }

        // Verify the returned tracking ID when Pesapal supplies it.
        if (
            statusData.order_tracking_id &&
            String(statusData.order_tracking_id) !== orderTrackingId
        ) {
            return res.status(409).json({
                success: false,
                error: 'Pesapal returned a tracking ID that does not match this donation.'
            });
        }

        // Verify currency.
        const transactionCurrency = String(
            transaction.currency || 'UGX'
        ).toUpperCase();

        const returnedCurrency = String(
            statusData.currency || ''
        ).toUpperCase();

        if (returnedCurrency !== transactionCurrency) {
            return res.status(409).json({
                success: false,
                error: 'The currency returned by Pesapal does not match this donation.'
            });
        }

        // Verify amount.
        const storedAmountMinor = toMinorUnits(
            transaction.amount,
            transactionCurrency
        );

        const returnedAmountMinor = toMinorUnits(
            statusData.amount,
            transactionCurrency
        );

        if (
            storedAmountMinor === null ||
            returnedAmountMinor === null ||
            storedAmountMinor !== returnedAmountMinor
        ) {
            return res.status(409).json({
                success: false,
                error: 'The amount returned by Pesapal does not match this donation.'
            });
        }

        const verifiedStatus = mapPesapalStatus(
            statusData.payment_status_description
        );

        if (!verifiedStatus) {
            console.warn(
                'Unrecognized Pesapal payment status:',
                statusData.payment_status_description
            );

            return res.status(502).json({
                success: false,
                error: 'Pesapal returned an unrecognized payment status. Please contact the church finance team.'
            });
        }

        // Do not let a stale pending response overwrite COMPLETED.
        let nextStatus = verifiedStatus;

        if (
            transaction.status === 'COMPLETED' &&
            verifiedStatus !== 'REVERSED'
        ) {
            nextStatus = 'COMPLETED';
        } else if (transaction.status === 'REVERSED') {
            nextStatus = 'REVERSED';
        }

        const { error: updateError } = await supabaseAdmin
            .from('transactions')
            .update({
                status: nextStatus,
                pesapal_tracking_id: orderTrackingId,
                updated_at: new Date().toISOString()
            })
            .eq('id', transaction.id);

        if (updateError) {
            console.error(
                'Verified status could not be saved:',
                updateError.message
            );

            return res.status(500).json({
                success: false,
                error: 'Payment was checked, but its status could not be saved. Please refresh or contact the church.'
            });
        }

        return res.status(200).json({
            success: true,
            verified: true,
            status: nextStatus,
            merchant_reference: transaction.merchant_reference,
            order_tracking_id: orderTrackingId,
            amount: Number(transaction.amount),
            currency: transactionCurrency
        });

    } catch (error) {
        console.error('Pesapal verification error:', error.message);

        return res.status(500).json({
            success: false,
            error: 'Unable to verify this payment right now. Please try again shortly or contact your church.'
        });
    }
}
