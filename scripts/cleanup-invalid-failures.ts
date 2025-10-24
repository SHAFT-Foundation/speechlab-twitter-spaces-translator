import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

async function cleanup() {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    console.log('Cleaning up invalid final_failure mentions from database...\n');

    // Delete mentions with "Invalid dubbing request format" error
    const { data, error } = await supabase
        .from('mentions')
        .delete()
        .eq('status', 'final_failure')
        .eq('error_message', 'Invalid dubbing request format')
        .select();

    if (error) {
        console.error('Error deleting invalid mentions:', error);
        process.exit(1);
    }

    console.log(`✅ Deleted ${data?.length || 0} invalid final_failure mentions`);
    console.log('These were not real failures - just invalid mention formats that should not have been saved.\n');
}

cleanup().then(() => process.exit(0)).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
