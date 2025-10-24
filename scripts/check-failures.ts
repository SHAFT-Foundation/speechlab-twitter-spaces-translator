import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

async function checkFailures() {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Check final_failure mentions
    console.log('\n=== FINAL FAILURES ===');
    const { data: finalFailures, error: ffError } = await supabase
        .from('mentions')
        .select('tweet_id, username, status, error_message, retry_count, created_at, updated_at')
        .eq('status', 'final_failure')
        .order('updated_at', { ascending: false })
        .limit(20);

    if (ffError) {
        console.error('Error fetching final failures:', ffError);
    } else {
        console.log(`Total final_failure mentions found: ${finalFailures?.length || 0}\n`);
        finalFailures?.forEach((m, idx) => {
            console.log(`${idx + 1}. Tweet: ${m.tweet_id} (@${m.username})`);
            console.log(`   Retry count: ${m.retry_count || 0}`);
            console.log(`   Error: ${m.error_message || 'No error message'}`);
            console.log(`   Updated: ${m.updated_at}`);
            console.log('');
        });
    }

    // Check failed mentions (eligible for retry)
    console.log('\n=== FAILED (RETRYABLE) ===');
    const { data: failed, error: fError } = await supabase
        .from('mentions')
        .select('tweet_id, username, status, error_message, retry_count, created_at, updated_at')
        .eq('status', 'failed')
        .order('updated_at', { ascending: false })
        .limit(10);

    if (fError) {
        console.error('Error fetching failed:', fError);
    } else {
        console.log(`Total failed mentions found: ${failed?.length || 0}\n`);
        failed?.forEach((m, idx) => {
            console.log(`${idx + 1}. Tweet: ${m.tweet_id} (@${m.username})`);
            console.log(`   Retry count: ${m.retry_count || 0}`);
            console.log(`   Error: ${m.error_message || 'No error message'}`);
            console.log(`   Updated: ${m.updated_at}`);
            console.log('');
        });
    }

    // Check status distribution
    console.log('\n=== STATUS DISTRIBUTION ===');
    const { data: stats, error: sError } = await supabase
        .from('mentions')
        .select('status');

    if (sError) {
        console.error('Error fetching stats:', sError);
    } else {
        const distribution: Record<string, number> = {};
        stats?.forEach(m => {
            distribution[m.status] = (distribution[m.status] || 0) + 1;
        });
        console.log(distribution);
    }
}

checkFailures().then(() => process.exit(0)).catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});
