#!/usr/bin/env tsx
/**
 * Backfill parent tweet categories using Twitter API context annotations
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

async function backfillCategories() {
    try {
        logger.info('[Backfill Categories] Starting category backfill...');

        const twoWeeksAgo = new Date();
        twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

        // Fetch mentions with parent tweet URL but missing category
        const { data: mentions, error } = await supabase
            .from('mentions')
            .select('tweet_id, parent_tweet_url')
            .gte('created_at', twoWeeksAgo.toISOString())
            .not('parent_tweet_url', 'is', null)
            .is('parent_tweet_category', null)
            .order('created_at', { ascending: true });

        if (error) {
            logger.error('[Backfill Categories] Error:', error);
            return;
        }

        if (!mentions || mentions.length === 0) {
            logger.info('[Backfill Categories] No mentions missing categories');
            return;
        }

        logger.info(`[Backfill Categories] Found ${mentions.length} mentions to process`);

        let updatedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const mention of mentions) {
            try {
                // Extract parent tweet ID from URL
                const urlMatch = mention.parent_tweet_url?.match(/status\/(\d+)/);
                if (!urlMatch) {
                    logger.warn(`[Backfill Categories] Invalid URL for ${mention.tweet_id}`);
                    skippedCount++;
                    continue;
                }

                const parentTweetId = urlMatch[1];
                logger.info(`[Backfill Categories] Fetching tweet ${parentTweetId}...`);

                // Fetch parent tweet with context annotations
                const tweet = await rwClient.v2.singleTweet(parentTweetId, {
                    'tweet.fields': 'context_annotations'
                });

                if (tweet.data.context_annotations && tweet.data.context_annotations.length > 0) {
                    const primaryAnnotation = tweet.data.context_annotations[0];

                    if (primaryAnnotation.domain) {
                        const category = primaryAnnotation.domain.name;
                        const categoryId = primaryAnnotation.domain.id;
                        const domains = tweet.data.context_annotations.map((a: any) => ({
                            domain_id: a.domain?.id,
                            domain_name: a.domain?.name,
                            entity_id: a.entity?.id,
                            entity_name: a.entity?.name
                        }));

                        logger.info(`[Backfill Categories] ✅ Found category: ${category}`);

                        // Update database
                        const { error: updateError } = await supabase
                            .from('mentions')
                            .update({
                                parent_tweet_category: category,
                                parent_tweet_category_id: categoryId,
                                parent_tweet_domains: domains,
                                updated_at: new Date().toISOString()
                            })
                            .eq('tweet_id', mention.tweet_id);

                        if (updateError) {
                            logger.error(`[Backfill Categories] Error updating ${mention.tweet_id}:`, updateError);
                            errorCount++;
                        } else {
                            updatedCount++;
                        }
                    } else {
                        logger.warn(`[Backfill Categories] No domain in annotations for ${parentTweetId}`);
                        skippedCount++;
                    }
                } else {
                    logger.warn(`[Backfill Categories] No context annotations for ${parentTweetId}`);
                    skippedCount++;
                }

                // Rate limit: 900 requests per 15 min = 1 per second
                await sleep(1100);

            } catch (error: any) {
                if (error.code === 429) {
                    logger.warn('[Backfill Categories] Rate limited. Waiting 15 minutes...');
                    await sleep(15 * 60 * 1000);
                    continue;
                }
                logger.error(`[Backfill Categories] Error processing ${mention.tweet_id}:`, error);
                errorCount++;
            }
        }

        logger.info('\n[Backfill Categories] ========================================');
        logger.info('[Backfill Categories] Category Backfill Complete!');
        logger.info(`[Backfill Categories] Total processed: ${mentions.length}`);
        logger.info(`[Backfill Categories] Updated: ${updatedCount}`);
        logger.info(`[Backfill Categories] Skipped (no category): ${skippedCount}`);
        logger.info(`[Backfill Categories] Errors: ${errorCount}`);
        logger.info('[Backfill Categories] ========================================');

    } catch (error) {
        logger.error('[Backfill Categories] Fatal error:', error);
        process.exit(1);
    }
}

backfillCategories()
    .then(() => {
        logger.info('[Backfill Categories] Script completed');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[Backfill Categories] Script failed:', error);
        process.exit(1);
    });
