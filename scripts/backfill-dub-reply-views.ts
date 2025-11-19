#!/usr/bin/env tsx
/**
 * Backfill Dub Reply View Counts
 *
 * Fetches current view counts for all completed mentions with dub_reply_tweet_id
 * and stores them in tweet_metrics table
 */

import { createClient } from '@supabase/supabase-js';
import { config } from '../src/utils/config';
import logger from '../src/utils/logger';
import { trackDubReplyMetrics } from '../src/services/tweetMetricsService';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function backfillDubReplyViews() {
    try {
        logger.info('[📊 Backfill] Starting backfill of dub reply view counts...');

        // Get all completed mentions with dub_reply_tweet_id
        const { data: mentions, error } = await supabase
            .from('mentions')
            .select('tweet_id, dub_reply_tweet_id, username, created_at')
            .eq('status', 'complete')
            .not('dub_reply_tweet_id', 'is', null)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('[📊 Backfill] Error fetching mentions:', error);
            return;
        }

        if (!mentions || mentions.length === 0) {
            logger.info('[📊 Backfill] No mentions with dub replies found');
            return;
        }

        logger.info(`[📊 Backfill] Found ${mentions.length} mentions with dub replies`);

        let successCount = 0;
        let errorCount = 0;
        let skippedCount = 0;

        for (const mention of mentions) {
            try {
                logger.info(`\n[📊 Backfill] Processing mention ${mention.tweet_id} by @${mention.username}...`);
                logger.info(`[📊 Backfill] Dub reply: ${mention.dub_reply_tweet_id}`);

                // Check if we already have recent metrics (within last hour)
                const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
                const { data: existing, error: checkError } = await supabase
                    .from('tweet_metrics')
                    .select('collected_at')
                    .eq('tweet_id', mention.dub_reply_tweet_id)
                    .gte('collected_at', oneHourAgo.toISOString())
                    .order('collected_at', { ascending: false })
                    .limit(1)
                    .single();

                if (!checkError && existing) {
                    logger.info(`[📊 Backfill] ⏭️  Skipping - metrics collected recently at ${existing.collected_at}`);
                    skippedCount++;
                    continue;
                }

                // Fetch and save metrics
                await trackDubReplyMetrics(mention.dub_reply_tweet_id, mention.tweet_id);
                successCount++;

                logger.info(`[📊 Backfill] ✅ Tracked metrics for ${mention.dub_reply_tweet_id}`);

                // Rate limiting: 300 requests per 15 min window = 1 request per 3 seconds
                // Being conservative with 5 seconds
                await sleep(5000);

            } catch (error: any) {
                if (error.code === 429) {
                    logger.warn('[📊 Backfill] Rate limited! Waiting 15 minutes...');
                    await sleep(15 * 60 * 1000);
                    continue;
                }
                logger.error(`[📊 Backfill] Error processing ${mention.tweet_id}:`, error);
                errorCount++;
            }
        }

        logger.info('\n========================================');
        logger.info('[📊 Backfill] Backfill Complete!');
        logger.info('========================================');
        logger.info(`Total mentions: ${mentions.length}`);
        logger.info(`Successfully tracked: ${successCount}`);
        logger.info(`Skipped (recent data): ${skippedCount}`);
        logger.info(`Errors: ${errorCount}`);
        logger.info('========================================');

        if (successCount > 0) {
            logger.info('\n✅ Next steps:');
            logger.info('  1. Start metrics daemon: npx tsx src/metricsDaemon.ts');
            logger.info('  2. View top videos: npx tsx scripts/show-top-dub-videos.ts');
        }

    } catch (error) {
        logger.error('[📊 Backfill] Fatal error:', error);
        process.exit(1);
    }
}

backfillDubReplyViews()
    .then(() => {
        logger.info('[📊 Backfill] Script completed');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[📊 Backfill] Script failed:', error);
        process.exit(1);
    });
