#!/usr/bin/env tsx
/**
 * Retry a specific failed mention by resetting its status to 'pending'
 * This allows the daemon to pick it up and try again
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../src/utils/config';
import logger from '../src/utils/logger';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

async function retryMention() {
    const tweetId = process.argv[2];

    if (!tweetId) {
        console.error('Usage: npx tsx scripts/retry-failed-mention.ts <tweet_id>');
        process.exit(1);
    }

    console.log(`\n🔄 Retrying mention: ${tweetId}\n`);

    // First, check current status
    const { data: current, error: fetchError } = await supabase
        .from('mentions')
        .select('*')
        .eq('tweet_id', tweetId)
        .single();

    if (fetchError) {
        console.error('❌ Error fetching mention:', fetchError);
        process.exit(1);
    }

    if (!current) {
        console.error('❌ Mention not found in database');
        process.exit(1);
    }

    console.log('📊 Current Status:');
    console.log('─'.repeat(80));
    console.log(`Tweet ID: ${current.tweet_id}`);
    console.log(`Username: ${current.username}`);
    console.log(`Status: ${current.status}`);
    console.log(`Retry Count: ${current.retry_count || 0}`);
    console.log(`Error: ${current.error_message || 'none'}`);
    console.log(`Created: ${current.created_at}`);
    console.log(`Updated: ${current.updated_at}`);
    console.log('─'.repeat(80));

    // Reset to pending to allow retry
    const { data: updated, error: updateError } = await supabase
        .from('mentions')
        .update({
            status: 'pending',
            error_message: null,
            updated_at: new Date().toISOString()
        })
        .eq('tweet_id', tweetId)
        .select()
        .single();

    if (updateError) {
        console.error('❌ Error updating mention:', updateError);
        process.exit(1);
    }

    console.log('\n✅ Mention status reset to "pending"');
    console.log('The daemon will pick it up on the next cycle and retry processing.');
    console.log('\n💡 Monitor progress with:');
    console.log(`   npx tsx scripts/check-specific-tweet.ts ${tweetId}`);
}

retryMention()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error('Script failed:', error);
        process.exit(1);
    });
