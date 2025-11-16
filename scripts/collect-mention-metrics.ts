#!/usr/bin/env tsx
/**
 * Collect Metrics for Mention Tweets
 *
 * Collects view/engagement metrics for:
 * 1. The mention tweets (user requests)
 * 2. The parent tweets being dubbed
 * 3. Sibling comments on the parent (for comparison)
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

interface TweetMetrics {
    tweet_id: string;
    impression_count: number;
    like_count: number;
    reply_count: number;
    retweet_count: number;
    quote_count: number;
}

async function fetchTweetMetrics(tweetId: string): Promise<TweetMetrics | null> {
    try {
        const tweet = await rwClient.v2.singleTweet(tweetId, {
            'tweet.fields': 'public_metrics'
        });

        if (!tweet.data) {
            return null;
        }

        const metrics = tweet.data.public_metrics;
        return {
            tweet_id: tweetId,
            impression_count: metrics?.impression_count || 0,
            like_count: metrics?.like_count || 0,
            reply_count: metrics?.reply_count || 0,
            retweet_count: metrics?.retweet_count || 0,
            quote_count: metrics?.quote_count || 0
        };
    } catch (error: any) {
        if (error.code === 429) {
            throw error; // Re-throw rate limits to be handled by caller
        }
        logger.error(`[📊 Metrics] Error fetching metrics for ${tweetId}:`, error);
        return null;
    }
}

async function saveTweetMetrics(
    tweetId: string,
    tweetType: 'mention' | 'parent' | 'sibling_comment',
    mentionId: string,
    metrics: TweetMetrics
): Promise<void> {
    const { error } = await supabase
        .from('tweet_metrics')
        .insert({
            tweet_id: tweetId,
            tweet_type: tweetType,
            mention_id: mentionId,
            impression_count: metrics.impression_count,
            like_count: metrics.like_count,
            reply_count: metrics.reply_count,
            retweet_count: metrics.retweet_count,
            quote_count: metrics.quote_count,
            collected_at: new Date().toISOString()
        });

    if (error) {
        logger.error(`[📊 Metrics] Error saving metrics for ${tweetId}:`, error);
    }
}

async function collectSiblingComments(
    parentTweetId: string,
    mentionId: string,
    sampleSize: number = 10
): Promise<number> {
    try {
        logger.info(`[📊 Metrics] Fetching sibling comments for parent ${parentTweetId}...`);

        // Search for replies to the parent tweet
        const searchQuery = `conversation_id:${parentTweetId}`;
        const searchResults = await rwClient.v2.search(searchQuery, {
            'tweet.fields': 'public_metrics,author_id,referenced_tweets',
            max_results: 100
        });

        if (!searchResults.data?.data) {
            logger.warn(`[📊 Metrics] No replies found for parent ${parentTweetId}`);
            return 0;
        }

        // Filter for direct replies to parent (not replies to replies)
        const directReplies = searchResults.data.data.filter(tweet =>
            tweet.referenced_tweets?.some(ref =>
                ref.type === 'replied_to' && ref.id === parentTweetId
            )
        );

        logger.info(`[📊 Metrics] Found ${directReplies.length} direct replies to parent`);

        // Sample random comments (up to sampleSize)
        const sampled = directReplies
            .sort(() => Math.random() - 0.5)
            .slice(0, sampleSize);

        let collectedCount = 0;
        for (const reply of sampled) {
            const metrics = reply.public_metrics;
            if (metrics) {
                await saveTweetMetrics(
                    reply.id,
                    'sibling_comment',
                    mentionId,
                    {
                        tweet_id: reply.id,
                        impression_count: metrics.impression_count || 0,
                        like_count: metrics.like_count || 0,
                        reply_count: metrics.reply_count || 0,
                        retweet_count: metrics.retweet_count || 0,
                        quote_count: metrics.quote_count || 0
                    }
                );
                collectedCount++;
            }
        }

        logger.info(`[📊 Metrics] Collected ${collectedCount} sibling comment metrics`);
        return collectedCount;
    } catch (error: any) {
        if (error.code === 429) {
            throw error;
        }
        logger.error(`[📊 Metrics] Error collecting sibling comments:`, error);
        return 0;
    }
}

async function collectMentionMetrics() {
    try {
        logger.info('[📊 Metrics] Starting mention metrics collection...');

        // Get all completed mentions
        const { data: mentions, error } = await supabase
            .from('mentions')
            .select('tweet_id, parent_tweet_url')
            .eq('status', 'complete')
            .not('parent_tweet_url', 'is', null)
            .order('created_at', { ascending: false })
            .limit(50); // Start with 50 most recent

        if (error) {
            logger.error('[📊 Metrics] Error fetching mentions:', error);
            return;
        }

        if (!mentions || mentions.length === 0) {
            logger.info('[📊 Metrics] No mentions found');
            return;
        }

        logger.info(`[📊 Metrics] Found ${mentions.length} mentions to process`);

        let processedCount = 0;
        let errorCount = 0;
        let rateLimitHits = 0;

        for (const mention of mentions) {
            try {
                // Extract parent tweet ID from URL
                const parentTweetId = mention.parent_tweet_url.match(/status\/(\d+)/)?.[1];
                if (!parentTweetId) {
                    logger.warn(`[📊 Metrics] Could not extract parent tweet ID from ${mention.parent_tweet_url}`);
                    errorCount++;
                    continue;
                }

                logger.info(`\n[📊 Metrics] Processing mention ${mention.tweet_id}...`);

                // 1. Fetch mention tweet metrics
                logger.info(`[📊 Metrics] Fetching mention tweet metrics...`);
                const mentionMetrics = await fetchTweetMetrics(mention.tweet_id);
                if (mentionMetrics) {
                    await saveTweetMetrics(mention.tweet_id, 'mention', mention.tweet_id, mentionMetrics);
                    logger.info(`[📊 Metrics] ✅ Mention views: ${mentionMetrics.impression_count.toLocaleString()}`);
                }
                await sleep(1000); // Rate limit protection

                // 2. Fetch parent tweet metrics
                logger.info(`[📊 Metrics] Fetching parent tweet metrics...`);
                const parentMetrics = await fetchTweetMetrics(parentTweetId);
                if (parentMetrics) {
                    await saveTweetMetrics(parentTweetId, 'parent', mention.tweet_id, parentMetrics);
                    logger.info(`[📊 Metrics] ✅ Parent views: ${parentMetrics.impression_count.toLocaleString()}`);
                }
                await sleep(1000);

                // 3. Collect sibling comment metrics (sample 10)
                logger.info(`[📊 Metrics] Collecting sibling comment metrics...`);
                const siblingCount = await collectSiblingComments(parentTweetId, mention.tweet_id, 10);
                logger.info(`[📊 Metrics] ✅ Collected ${siblingCount} sibling comments`);
                await sleep(2000); // Extra delay for search API

                processedCount++;
                logger.info(`[📊 Metrics] Progress: ${processedCount}/${mentions.length}`);

            } catch (error: any) {
                if (error.code === 429) {
                    logger.warn('[📊 Metrics] Rate limited! Waiting 15 minutes...');
                    rateLimitHits++;
                    await sleep(15 * 60 * 1000);
                    continue;
                }
                logger.error(`[📊 Metrics] Error processing ${mention.tweet_id}:`, error);
                errorCount++;
            }
        }

        logger.info('\n========================================');
        logger.info('[📊 Metrics] Mention Metrics Collection Complete!');
        logger.info('========================================');
        logger.info(`Processed: ${processedCount}/${mentions.length}`);
        logger.info(`Errors: ${errorCount}`);
        logger.info(`Rate limit hits: ${rateLimitHits}`);
        logger.info('========================================');

        if (processedCount > 0) {
            logger.info('\n✅ Next steps:');
            logger.info('  Run: npx tsx scripts/generate-mention-engagement-report.ts');
        }

    } catch (error) {
        logger.error('[📊 Metrics] Fatal error:', error);
        process.exit(1);
    }
}

collectMentionMetrics()
    .then(() => {
        logger.info('[📊 Metrics] Script completed');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[📊 Metrics] Script failed:', error);
        process.exit(1);
    });
