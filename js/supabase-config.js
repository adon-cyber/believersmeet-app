const SUPABASE_URL =
    'https://tgwbhvutozgcmnthxhzo.supabase.co';

const SUPABASE_PUBLISHABLE_KEY =
    'sb_publishable_TtkT0BYradKEYlBjeqLVkA_7uSAv0lM';

if (typeof supabase !== 'undefined') {
    try {
        if (!window.supabaseClient) {
            window.supabaseClient = supabase.createClient(
                SUPABASE_URL,
                SUPABASE_PUBLISHABLE_KEY
            );
        }

        window.sbClient = window.supabaseClient;

        console.log('Supabase client initialized successfully.');
    } catch (error) {
        console.error('Supabase initialization failed:', error);
    }
} else {
    console.error('Supabase SDK has not loaded.');
}
