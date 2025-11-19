#!/usr/bin/env tsx
/**
 * Metrics Daemon
 *
 * Continuously polls and tracks engagement metrics for dub reply tweets
 * Runs every 30 minutes to capture view count changes over time
 */

import { createClient } from '@supabase/supabase-js';
import { config } from './utils/config';
import logger from './utils/logger';
import { trackDubReplyMetrics } from './services/tweetMetricsService';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

// Poll interval: 30 minutes (in milliseconds)
const POLL_INTERVAL_MS = 30 * 60 * 1000;

// Rate limiting: Wait 5 seconds between API calls
const RATE_LIMIT_DELAY_MS = 5000;

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Collect metrics for all dub replies
 */
async function collectMetrics() {
    try {
        logger.info('\n========================================');
        logger.info('[📊 Metrics Daemon] Starting metrics collection cycle...');
        logger.info('========================================');

        // Get all completed mentions with dub_reply_tweet_id
        const { data: mentions, error } = await supabase
            .from('mentions')
            .select('tweet_id, dub_reply_tweet_id, username')
            .eq('status', 'complete')
            .not('dub_reply_tweet_id', 'is', null)
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('[📊 Metrics Daemon] Error fetching mentions:', error);
            return;
        }

        if (!mentions || mentions.length === 0) {
            logger.info('[📊 Metrics Daemon] No mentions with dub replies found');
            return;
        }

        logger.info(`[📊 Metrics Daemon] Found ${mentions.length} dub replies to track`);

        let successCount = 0;
        let errorCount = 0;

        for (const mention of mentions) {
            try {
                logger.info(`[📊 Metrics Daemon] Tracking metrics for @${mention.username}'s dub reply ${mention.dub_reply_tweet_id}...`);

                await trackDubReplyMetrics(mention.dub_reply_tweet_id, mention.tweet_id);
                successCount++;

                // Rate limiting
                await sleep(RATE_LIMIT_DELAY_MS);

            } catch (error: any) {
                if (error.code === 429) {
                    logger.warn('[📊 Metrics Daemon] Rate limited! Waiting 15 minutes...');
                    await sleep(15 * 60 * 1000);
                    continue;
                }
                logger.error(`[📊 Metrics Daemon] Error tracking metrics for ${mention.dub_reply_tweet_id}:`, error);
                errorCount++;
            }
        }

        logger.info('\n========================================');
        logger.info('[📊 Metrics Daemon] Collection cycle complete');
        logger.info('========================================');
        logger.info(`Successfully tracked: ${successCount}/${mentions.length}`);
        logger.info(`Errors: ${errorCount}`);
        logger.info('========================================\n');

    } catch (error) {
        logger.error('[📊 Metrics Daemon] Fatal error during collection:', error);
    }
}

/**
 * Main daemon loop
 */
async function runDaemon() {
    logger.info('╔════════════════════════════════════════╗');
    logger.info('║     METRICS DAEMON STARTED             ║');
    logger.info('╚════════════════════════════════════════╝');
    logger.info(`Poll interval: ${POLL_INTERVAL_MS / 1000 / 60} minutes`);
    logger.info(`Rate limit delay: ${RATE_LIMIT_DELAY_MS / 1000} seconds between requests`);

    // Run immediately on startup
    await collectMetrics();

    // Then run on interval
    setInterval(async () => {
        await collectMetrics();
    }, POLL_INTERVAL_MS);

    logger.info('[📊 Metrics Daemon] Daemon running... Press Ctrl+C to stop.');
}

// Handle graceful shutdown
process.on('SIGINT', () => {
    logger.info('\n[📊 Metrics Daemon] Shutting down gracefully...');
    process.exit(0);
});

process.on('SIGTERM', () => {
    logger.info('\n[📊 Metrics Daemon] Shutting down gracefully...');
    process.exit(0);
});

// Start the daemon
runDaemon().catch((error) => {
    logger.error('[📊 Metrics Daemon] Fatal error:', error);
    process.exit(1);
});
