#!/usr/bin/env tsx
/**
 * Backfill Dub Reply Tweet IDs
 *
 * Finds @dubbingagent's reply tweets for past mentions and saves their tweet IDs
 * This enables metrics tracking for historical dubs
 */

import { createClient } from '@supabase/supabase-js';
import { TwitterApi } from 'twitter-api-v2';
import { config } from '../src/utils/config';
import logger from '../src/utils/logger';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

const twitterClient = new TwitterApi({
    appKey: config.TWITTER_API_KEY,
    appSecret: config.TWITTER_API_SECRET,
    accessToken: config.TWITTER_ACCESS_TOKEN,
    accessSecret: config.TWITTER_ACCESS_SECRET,
});
const rwClient = twitterClient.readWrite;

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfillDubReplyTweetIds() {
    try {
        logger.info('[🔍 Backfill] Starting dub reply tweet ID backfill...');

        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

        // Get completed mentions without dub_reply_tweet_id
        const { data: mentions, error } = await supabase
            .from('mentions')
            .select('tweet_id, username, created_at')
            .eq('status', 'complete')
            .gte('created_at', twoWeeksAgo.toISOString())
            .is('dub_reply_tweet_id', null)
            .order('created_at', { ascending: true });

        if (error) {
            logger.error('[🔍 Backfill] Error fetching mentions:', error);
            return;
        }

        if (!mentions || mentions.length === 0) {
            logger.info('[🔍 Backfill] No mentions found needing backfill');
            return;
        }

        logger.info(`[🔍 Backfill] Found ${mentions.length} mentions to backfill`);

        let foundCount = 0;
        let notFoundCount = 0;
        let errorCount = 0;

        // Get @dubbingagent user ID
        logger.info('[🔍 Backfill] Getting @dubbingagent user ID...');
        const botUser = await rwClient.v2.userByUsername('dubbingagent');
        const botUserId = botUser.data.id;
        logger.info(`[🔍 Backfill] Bot user ID: ${botUserId}`);

        for (const mention of mentions) {
            try {
                logger.info(`[🔍 Backfill] Searching for reply to ${mention.tweet_id} (@${mention.username})...`);

                // Search for @dubbingagent's replies to this specific tweet
                // Using conversation_id to find all tweets in the conversation
                const searchQuery = `from:dubbingagent to:${mention.username} conversation_id:${mention.tweet_id}`;

                logger.debug(`[🔍 Backfill] Search query: ${searchQuery}`);

                const searchResults = await rwClient.v2.search(searchQuery, {
                    'tweet.fields': 'conversation_id,referenced_tweets,created_at',
                    max_results: 10
                });

                if (searchResults.data && searchResults.data.data && searchResults.data.data.length > 0) {
                    // Find the reply that references the mention tweet
                    const replyTweet = searchResults.data.data.find(tweet =>
                        tweet.referenced_tweets?.some(ref =>
                            ref.type === 'replied_to' && ref.id === mention.tweet_id
                        )
                    );

                    if (replyTweet) {
                        logger.info(`[🔍 Backfill] ✅ Found reply tweet: ${replyTweet.id}`);

                        // Update database
                        const { error: updateError } = await supabase
                            .from('mentions')
                            .update({
                                dub_reply_tweet_id: replyTweet.id,
                                dub_reply_tweet_url: `https://twitter.com/dubbingagent/status/${replyTweet.id}`,
                                updated_at: new Date().toISOString()
                            })
                            .eq('tweet_id', mention.tweet_id);

                        if (updateError) {
                            logger.error(`[🔍 Backfill] Error updating ${mention.tweet_id}:`, updateError);
                            errorCount++;
                        } else {
                            foundCount++;
                            logger.info(`[🔍 Backfill] Updated mention ${mention.tweet_id} with reply ID ${replyTweet.id}`);
                        }
                    } else {
                        logger.warn(`[🔍 Backfill] No direct reply found in search results for ${mention.tweet_id}`);
                        notFoundCount++;
                    }
                } else {
                    logger.warn(`[🔍 Backfill] No search results for ${mention.tweet_id}`);
                    notFoundCount++;
                }

                // Rate limit: 450 requests per 15 min = 1 per 2 seconds
                await sleep(2000);

            } catch (error: any) {
                if (error.code === 429) {
                    logger.warn('[🔍 Backfill] Rate limited. Waiting 15 minutes...');
                    await sleep(15 * 60 * 1000);
                    continue;
                }
                logger.error(`[🔍 Backfill] Error processing ${mention.tweet_id}:`, error);
                errorCount++;
            }
        }

        logger.info('\n[🔍 Backfill] ========================================');
        logger.info('[🔍 Backfill] Dub Reply Tweet ID Backfill Complete!');
        logger.info(`[🔍 Backfill] Total processed: ${mentions.length}`);
        logger.info(`[🔍 Backfill] Found and updated: ${foundCount}`);
        logger.info(`[🔍 Backfill] Not found: ${notFoundCount}`);
        logger.info(`[🔍 Backfill] Errors: ${errorCount}`);
        logger.info('[🔍 Backfill] ========================================');

        if (notFoundCount > 0) {
            logger.info('\n[🔍 Backfill] Note: Some replies may not be found if:');
            logger.info('  - The reply was deleted');
            logger.info('  - The reply was never posted');
            logger.info('  - Twitter search API limitations (tweets older than 7 days may not appear)');
        }

        if (foundCount > 0) {
            logger.info('\n[🔍 Backfill] Next steps:');
            logger.info('  1. Run: npx tsx scripts/collect-metrics.ts --include-siblings');
            logger.info('  2. Run: npx tsx scripts/generate-verification-report.ts');
        }

    } catch (error) {
        logger.error('[🔍 Backfill] Fatal error:', error);
        process.exit(1);
    }
}

backfillDubReplyTweetIds()
    .then(() => {
        logger.info('[🔍 Backfill] Script completed');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[🔍 Backfill] Script failed:', error);
        process.exit(1);
    });
