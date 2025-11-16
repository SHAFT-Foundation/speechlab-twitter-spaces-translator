#!/usr/bin/env tsx
/**
 * Backfill Dub Reply Tweet IDs (Timeline Method)
 *
 * Fetches @dubbingagent's recent tweets and matches them to mentions
 * More reliable than search API for finding recent replies
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

async function backfillFromTimeline() {
    try {
        logger.info('[🔍 Timeline Backfill] Starting dub reply tweet ID backfill from timeline...');

        // Get @dubbingagent user ID
        logger.info('[🔍 Timeline Backfill] Getting @dubbingagent user ID...');
        const botUser = await rwClient.v2.userByUsername('dubbingagent');
        const botUserId = botUser.data.id;
        logger.info(`[🔍 Timeline Backfill] Bot user ID: ${botUserId}`);

        // Fetch up to 3200 recent tweets from @dubbingagent (API limit)
        logger.info('[🔍 Timeline Backfill] Fetching recent tweets from @dubbingagent timeline...');

        const allTweets: any[] = [];
        let paginationToken: string | undefined;
        let fetchCount = 0;
        const maxFetches = 32; // 32 pages * 100 tweets = 3200 tweets max

        while (fetchCount < maxFetches) {
            try {
                const response = await rwClient.v2.userTimeline(botUserId, {
                    max_results: 100,
                    'tweet.fields': 'referenced_tweets,created_at',
                    pagination_token: paginationToken
                });

                if (response.data.data) {
                    allTweets.push(...response.data.data);
                    logger.info(`[🔍 Timeline Backfill] Fetched ${response.data.data.length} tweets (total: ${allTweets.length})`);
                }

                if (!response.data.meta?.next_token) {
                    break;
                }

                paginationToken = response.data.meta.next_token;
                fetchCount++;
            } catch (error: any) {
                if (error.code === 429) {
                    logger.warn(`[🔍 Timeline Backfill] Rate limited after fetching ${allTweets.length} tweets. Waiting 15 minutes...`);
                    await sleep(15 * 60 * 1000);
                    continue;
                }
                throw error;
            }
        }

        logger.info(`[🔍 Timeline Backfill] Total tweets fetched: ${allTweets.length}`);

        // Filter for reply tweets only
        const replyTweets = allTweets.filter(tweet =>
            tweet.referenced_tweets?.some((ref: any) => ref.type === 'replied_to')
        );

        logger.info(`[🔍 Timeline Backfill] Found ${replyTweets.length} reply tweets`);

        // Create a map of parent_tweet_id -> dub_reply_tweet_id
        const replyMap = new Map<string, string>();
        replyTweets.forEach(tweet => {
            const parentTweetRef = tweet.referenced_tweets?.find((ref: any) => ref.type === 'replied_to');
            if (parentTweetRef) {
                replyMap.set(parentTweetRef.id, tweet.id);
            }
        });

        logger.info(`[🔍 Timeline Backfill] Created reply map with ${replyMap.size} entries`);

        // Get mentions without dub_reply_tweet_id
        const { data: mentions, error } = await supabase
            .from('mentions')
            .select('tweet_id')
            .eq('status', 'complete')
            .is('dub_reply_tweet_id', null)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('[🔍 Timeline Backfill] Error fetching mentions:', error);
            return;
        }

        if (!mentions || mentions.length === 0) {
            logger.info('[🔍 Timeline Backfill] No mentions found needing backfill');
            return;
        }

        logger.info(`[🔍 Timeline Backfill] Found ${mentions.length} mentions to match`);

        let foundCount = 0;
        let notFoundCount = 0;

        // Match mentions to replies
        for (const mention of mentions) {
            const dubReplyTweetId = replyMap.get(mention.tweet_id);

            if (dubReplyTweetId) {
                logger.info(`[🔍 Timeline Backfill] ✅ Found reply ${dubReplyTweetId} for mention ${mention.tweet_id}`);

                // Update database
                const { error: updateError } = await supabase
                    .from('mentions')
                    .update({
                        dub_reply_tweet_id: dubReplyTweetId,
                        dub_reply_tweet_url: `https://twitter.com/dubbingagent/status/${dubReplyTweetId}`,
                        updated_at: new Date().toISOString()
                    })
                    .eq('tweet_id', mention.tweet_id);

                if (updateError) {
                    logger.error(`[🔍 Timeline Backfill] Error updating ${mention.tweet_id}:`, updateError);
                } else {
                    foundCount++;
                }
            } else {
                notFoundCount++;
            }
        }

        logger.info('\n[🔍 Timeline Backfill] ========================================');
        logger.info('[🔍 Timeline Backfill] Dub Reply Tweet ID Backfill Complete!');
        logger.info(`[🔍 Timeline Backfill] Total mentions checked: ${mentions.length}`);
        logger.info(`[🔍 Timeline Backfill] Found and updated: ${foundCount}`);
        logger.info(`[🔍 Timeline Backfill] Not found in timeline: ${notFoundCount}`);
        logger.info('[🔍 Timeline Backfill] ========================================');

        if (notFoundCount > 0) {
            logger.info('\n[🔍 Timeline Backfill] Note: Mentions not found may be:');
            logger.info('  - Older than ~3200 tweets ago (Twitter API limit)');
            logger.info('  - Never had a reply posted');
            logger.info('  - Reply was deleted');
        }

        if (foundCount > 0) {
            logger.info('\n[🔍 Timeline Backfill] ✅ Success! Next steps:');
            logger.info('  1. Run: npx tsx scripts/collect-metrics.ts --include-siblings');
            logger.info('  2. Run: npx tsx scripts/generate-verification-report.ts');
            logger.info('  3. Open: reports/verification-report.html');
        }

    } catch (error) {
        logger.error('[🔍 Timeline Backfill] Fatal error:', error);
        process.exit(1);
    }
}

backfillFromTimeline()
    .then(() => {
        logger.info('[🔍 Timeline Backfill] Script completed');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[🔍 Timeline Backfill] Script failed:', error);
        process.exit(1);
    });
