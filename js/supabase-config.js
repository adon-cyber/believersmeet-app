// supabase-config.js
const SUPABASE_URL = 'https://tgwbhvutozgcmnthxhzo.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRnd2JodnV0b3pnY21udGh4aHpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE4NTkwOTQsImV4cCI6MjA5NzQzNTA5NH0.4pDoAZU8nHxGyE8ad3DCfhJEQCPrWA148QERjtE_ooQ';

window.supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
window.sbClient = window.supabaseClient;
console.log("Supabase Client initialized and attached to window.supabaseClient.");