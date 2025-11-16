#!/usr/bin/env tsx
/**
 * Check Backfill Status
 *
 * Shows how many mentions have reply tweet IDs
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function checkStatus() {
    // Get total complete mentions
    const { data: all, error: allError } = await supabase
        .from('mentions')
        .select('tweet_id')
        .eq('status', 'complete');

    if (allError) {
        logger.error('Error fetching all:', allError);
        return;
    }

    // Get mentions with reply IDs
    const { data: withReply, error: replyError } = await supabase
        .from('mentions')
        .select('tweet_id')
        .eq('status', 'complete')
        .not('dub_reply_tweet_id', 'is', null);

    if (replyError) {
        logger.error('Error fetching with reply:', replyError);
        return;
    }

    const total = all?.length || 0;
    const haveReply = withReply?.length || 0;
    const missing = total - haveReply;

    console.log('\n========================================');
    console.log('Backfill Status Report');
    console.log('========================================');
    console.log(`Total complete mentions: ${total}`);
    console.log(`Have reply tweet ID: ${haveReply}`);
    console.log(`Missing reply tweet ID: ${missing}`);
    console.log(`Completion: ${total > 0 ? Math.round((haveReply / total) * 100) : 0}%`);
    console.log('========================================\n');
}

checkStatus().then(() => process.exit(0));
