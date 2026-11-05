import { getSupabaseAdmin } from '../lib/supabase-admin.js';

function getBaseUrl(environment) {
    if (environment === 'live') {
        return 'https://pay.pesapal.com/v3';
    }

    if (environment === 'sandbox' || !environment) {
        return 'https://cybqa.pesapal.com/pesapalv3';
    }

    throw new Error('Unsupported Pesapal environment.');
}

async function readJson(response, label) {
    const text = await response.text();

    let data;
    try {
        data = JSON.parse(text);
    } catch {
        throw new Error(`${label} returned an invalid response.`);
    }

    if (!response.ok || String(data?.status) !== '200') {
        throw new Error(
            data?.message || `${label} request failed.`
        );
    }

    return data;
}

async function getPesapalToken(key, secret, baseUrl) {
    const response = await fetch(
        `${baseUrl}/api/Auth/RequestToken`,
        {
            method: 'POST',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                consumer_key: key,
                consumer_secret: secret
            })
        }
    );

    const data = await readJson(response, 'Pesapal authentication');

    if (!data.token) {
        throw new Error('Pesapal did not return an access token.');
    }

    return data.token;
}

function getValue(value) {
    if (Array.isArray(value)) return value[0];
    return value;
}

function getMinorUnits(value, currency) {
    const amount = Number(value);

    if (!Number.isFinite(amount) || amount <= 0) {
        return null;
    }

    const decimals = currency === 'UGX' ? 0 : 2;
    const scaled = amount * (10 ** decimals);

    if (Math.abs(scaled - Math.round(scaled)) > 0.000001) {
        return null;
    }

    return Math.round(scaled);
}

function mapPaymentStatus(value) {
    const status = String(value || '').trim().toUpperCase();

    if (status === 'COMPLETED') return 'COMPLETED';
    if (status === 'FAILED' || status === 'INVALID') return 'FAILED';
    if (status === 'REVERSED') return 'REVERSED';

    return null;
}

function acknowledgement(type, trackingId, reference, status) {
    return {
        orderNotificationType: type || 'IPNCHANGE',
        orderTrackingId: trackingId || '',
        orderMerchantReference: reference || '',
        status
    };
}

export default async function handler(req, res) {
    if (!['GET', 'POST'].includes(req.method)) {
        res.setHeader('Allow', 'GET, POST');

        return res.status(405).json({
            success: false,
            error: 'Method not allowed.'
        });
    }

    const body = req.body && typeof req.body === 'object'
        ? req.body
        : {};

    const query = req.query || {};

    const notificationType = String(
        getValue(query.OrderNotificationType) ||
        getValue(body.OrderNotificationType) ||
        ''
    ).trim();

    const trackingId = String(
        getValue(query.OrderTrackingId) ||
        getValue(body.OrderTrackingId) ||
        ''
    ).trim();

    const merchantReference = String(
        getValue(query.OrderMerchantReference) ||
        getValue(body.OrderMerchantReference) ||
        ''
    ).trim();

    if (
        notificationType !== 'IPNCHANGE' ||
        !trackingId ||
        !merchantReference ||
        trackingId.length > 120 ||
        merchantReference.length > 120 ||
        !/^[a-zA-Z0-9-]+$/.test(trackingId) ||
        !/^[a-zA-Z0-9._-]+$/.test(merchantReference)
    ) {
        return res.status(400).json({
            ...acknowledgement(
                notificationType,
                trackingId,
                merchantReference,
                400
            ),
            message: 'Invalid Pesapal IPN parameters.'
        });
    }

    try {
        const supabase = getSupabaseAdmin();

        // Find the exact pending transaction using both identifiers.
        const { data: transaction, error: lookupError } =
            await supabase
                .from('transactions')
                .select(
                    'id, church_id, merchant_reference, pesapal_tracking_id, amount, currency, status'
                )
                .eq('merchant_reference', merchantReference)
                .maybeSingle();

        if (lookupError) {
            console.error('IPN transaction lookup failed:', lookupError.message);
            throw new Error('Transaction lookup failed.');
        }

        if (!transaction) {
            throw new Error('Transaction reference was not found.');
        }

        // Do not associate a different tracking ID with this transaction.
        if (
            transaction.pesapal_tracking_id &&
            transaction.pesapal_tracking_id !== trackingId
        ) {
            throw new Error('Pesapal tracking ID does not match the transaction.');
        }

        // Obtain payment credentials only from this transaction's church.
        const { data: church, error: churchError } = await supabase
            .from('churches')
            .select(
                'id, pesapal_consumer_key, pesapal_consumer_secret, pesapal_env'
            )
            .eq('id', transaction.church_id)
            .maybeSingle();

        if (churchError) {
            console.error('IPN church lookup failed:', churchError.message);
            throw new Error('Church lookup failed.');
        }

        if (
            !church?.pesapal_consumer_key ||
            !church?.pesapal_consumer_secret
        ) {
            throw new Error('Church Pesapal credentials are not configured.');
        }

        const baseUrl = getBaseUrl((process.env.VERCEL_ENV || '').toLowerCase() === 'preview' ? 'sandbox' : (church.pesapal_env || 'sandbox'));

        const token = await getPesapalToken(
            church.pesapal_consumer_key.trim(),
            church.pesapal_consumer_secret.trim(),
            baseUrl
        );

        // Never trust the IPN itself as proof of payment.
        const statusUrl = new URL(
            `${baseUrl}/api/Transactions/GetTransactionStatus`
        );
        statusUrl.searchParams.set('orderTrackingId', trackingId);

        const statusResponse = await fetch(statusUrl.toString(), {
            method: 'GET',
            headers: {
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`
            }
        });

        const payment = await readJson(
            statusResponse,
            'Pesapal transaction verification'
        );

        // Verify the reference returned by Pesapal.
        if (
            String(payment.merchant_reference || '') !==
            transaction.merchant_reference
        ) {
            throw new Error('Pesapal merchant reference mismatch.');
        }

        // Verify the original amount and currency.
        const storedCurrency = String(
            transaction.currency || 'UGX'
        ).toUpperCase();

        const returnedCurrency = String(
            payment.currency || ''
        ).toUpperCase();

        if (storedCurrency !== returnedCurrency) {
            throw new Error('Pesapal currency does not match the transaction.');
        }

        if (!['UGX', 'USD'].includes(storedCurrency)) {
            throw new Error('Unsupported transaction currency.');
        }

        const storedAmount = getMinorUnits(
            transaction.amount,
            storedCurrency
        );

        const returnedAmount = getMinorUnits(
            payment.amount,
            storedCurrency
        );

        if (
            storedAmount === null ||
            returnedAmount === null ||
            storedAmount !== returnedAmount
        ) {
            throw new Error('Pesapal amount does not match the transaction.');
        }

        const verifiedStatus = mapPaymentStatus(
            payment.payment_status_description
        );

        if (!verifiedStatus) {
            throw new Error(
                'Pesapal returned an unrecognized payment status.'
            );
        }

        // Preserve a completed payment against stale notifications.
        let nextStatus = verifiedStatus;

        if (
            transaction.status === 'COMPLETED' &&
            verifiedStatus !== 'REVERSED'
        ) {
            nextStatus = 'COMPLETED';
        }

        if (transaction.status === 'REVERSED') {
            nextStatus = 'REVERSED';
        }

        const { error: updateError } = await supabase
            .from('transactions')
            .update({
                status: nextStatus,
                pesapal_tracking_id: trackingId,
                updated_at: new Date().toISOString()
            })
            .eq('id', transaction.id);

        if (updateError) {
            console.error('IPN transaction update failed:', updateError.message);
            throw new Error('Could not save the verified payment status.');
        }

        return res.status(200).json(
            acknowledgement(
                notificationType,
                trackingId,
                merchantReference,
                200
            )
        );

    } catch (error) {
        console.error('Pesapal IPN processing error:', error.message);

        // A 500 acknowledgement allows Pesapal to retry the notification.
        return res.status(500).json(
            acknowledgement(
                notificationType,
                trackingId,
                merchantReference,
                500
            )
        );
    }
}
