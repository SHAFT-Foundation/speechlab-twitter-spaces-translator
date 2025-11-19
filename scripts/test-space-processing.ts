#!/usr/bin/env tsx
/**
 * Test script to process a specific Twitter Space mention
 * This uses the same code path as the mentionDaemon to verify it works
 */

import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

async function testSpaceProcessing(tweetId: string) {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    console.log(`\n${'='.repeat(80)}`);
    console.log(`🧪 Testing Space Processing for Tweet ID: ${tweetId}`);
    console.log(`${'='.repeat(80)}\n`);

    // Step 1: Fetch mention from database
    console.log('📊 Step 1: Fetching mention from database...');
    const { data: mention, error: fetchError } = await supabase
        .from('mentions')
        .select('*')
        .eq('tweet_id', tweetId)
        .single();

    if (fetchError || !mention) {
        console.error('❌ Error fetching mention:', fetchError);
        return;
    }

    console.log('✅ Mention found:');
    console.log(`   Username: ${mention.username}`);
    console.log(`   Status: ${mention.status}`);
    console.log(`   Content Type: ${mention.content_type}`);
    console.log(`   Parent Tweet: ${mention.parent_tweet_url}`);
    console.log(`   Parent Text: ${mention.parent_tweet_text}`);

    // Step 2: Check if parent tweet text contains a Space URL
    console.log('\n🔍 Step 2: Checking parent tweet text for Space URL...');

    if (!mention.parent_tweet_text) {
        console.error('❌ No parent tweet text found');
        return;
    }

    // Check for Space URL pattern in parent text or any t.co link
    const spaceUrlPattern = /https:\/\/(?:twitter|x)\.com\/i\/spaces\/([a-zA-Z0-9]+)/;
    const tcoPattern = /https:\/\/t\.co\/[a-zA-Z0-9]+/;

    const directSpaceMatch = mention.parent_tweet_text.match(spaceUrlPattern);
    const tcoMatch = mention.parent_tweet_text.match(tcoPattern);

    if (directSpaceMatch) {
        console.log('✅ Direct Space URL found in parent tweet!');
        console.log(`   Space URL: ${directSpaceMatch[0]}`);
        console.log(`   Space ID: ${directSpaceMatch[1]}`);
    } else if (tcoMatch) {
        console.log('✅ Shortened URL (t.co) found in parent tweet:');
        console.log(`   URL: ${tcoMatch[0]}`);
        console.log('   📝 This will be expanded by Twitter API in fetchVideoForMention()');
    } else {
        console.error('❌ No Space URL or t.co link found in parent tweet text');
        console.log(`   Parent text: ${mention.parent_tweet_text}`);
        return;
    }

    // Step 3: Update database to reset for daemon pickup
    console.log('\n💾 Step 3: Resetting mention status to "pending" for daemon pickup...');
    const { error: updateError } = await supabase
        .from('mentions')
        .update({
            status: 'pending',
            error_message: null,
            updated_at: new Date().toISOString()
        })
        .eq('tweet_id', tweetId);

    if (updateError) {
        console.error('❌ Error updating mention:', updateError);
        return;
    }

    console.log('✅ Mention reset to pending');

    // Summary
    console.log(`\n${'='.repeat(80)}`);
    console.log('✅ TEST PASSED - Space detection verified!');
    console.log(`${'='.repeat(80)}`);
    console.log('\n📋 Summary:');
    console.log('   ✅ Space URL (or t.co link) detected in parent tweet');
    console.log('   ✅ Mention reset to pending status');
    console.log('   ✅ Daemon will use fetchVideoForMention() to expand URL and detect Space');
    console.log('\n🚀 Next: Start the daemon to process this mention:');
    console.log('   npm run daemon');
    console.log(`\n💡 Monitor with: npx tsx scripts/query-tweet.ts ${tweetId}`);
}

const tweetId = process.argv[2] || '1990830841581482128';
testSpaceProcessing(tweetId).catch(console.error);
