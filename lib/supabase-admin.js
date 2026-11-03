import { createClient } from '@supabase/supabase-js';

const EXPECTED_PROJECTS = {
    preview: 'namosoubpvwbspuczzqj',
    production: 'tgwbhvutozgcmnthxhzo'
};

function resolveSupabaseConfiguration() {
    const environment = (process.env.VERCEL_ENV || 'development')
        .trim()
        .toLowerCase();

    let supabaseUrl;
    let serviceRoleKey;
    let expectedProjectRef = null;

    if (environment === 'preview') {
        supabaseUrl = process.env.SUPABASE_PREVIEW_URL;
        serviceRoleKey = process.env.SUPABASE_PREVIEW_SERVICE_ROLE_KEY;
        expectedProjectRef = EXPECTED_PROJECTS.preview;
    } else if (environment === 'production') {
        supabaseUrl = process.env.SUPABASE_URL;
        serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
        expectedProjectRef = EXPECTED_PROJECTS.production;
    } else if (environment === 'development') {
        supabaseUrl =
            process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
        serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
    } else {
        throw new Error('Unsupported Vercel deployment environment.');
    }

    if (!supabaseUrl || !serviceRoleKey) {
        throw new Error(
            `Supabase server configuration is incomplete for ${environment}.`
        );
    }

    let parsedUrl;

    try {
        parsedUrl = new URL(supabaseUrl);
    } catch {
        throw new Error('Supabase server URL is invalid.');
    }

    if (expectedProjectRef) {
        const expectedHost = `${expectedProjectRef}.supabase.co`;

        if (
            parsedUrl.protocol !== 'https:' ||
            parsedUrl.hostname !== expectedHost
        ) {
            throw new Error(
                `Supabase environment mismatch: ${environment} must use ${expectedHost}.`
            );
        }
    }

    if (serviceRoleKey.startsWith('sb_publishable_')) {
        throw new Error(
            'A publishable key cannot be used as the server service-role key.'
        );
    }

    return { supabaseUrl, serviceRoleKey };
}

export function getSupabaseAdmin() {
    const { supabaseUrl, serviceRoleKey } =
        resolveSupabaseConfiguration();

    return createClient(supabaseUrl, serviceRoleKey, {
        auth: {
            persistSession: false,
            autoRefreshToken: false
        }
    });
}