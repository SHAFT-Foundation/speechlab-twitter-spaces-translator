#!/usr/bin/env tsx
/**
 * Collect Tweet Metrics
 *
 * Fetches public metrics (views, likes, retweets) for:
 * - Mention tweets
 * - Dub reply tweets
 * - Parent tweets
 * - Sibling comments (for comparison)
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';
import {
    collectMentionMetrics,
    collectSiblingCommentMetrics
} from '../src/services/twitterMetricsService';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function collectMetrics(options: {
    includesiblings?: boolean;
    sampleSize?: number;
    mentionId?: string;
}) {
    try {
        logger.info('[📊 Metrics Collection] Starting metrics collection...');

        // Get completed mentions to collect metrics for
        let query = supabase
            .from('mentions')
            .select('tweet_id, dub_reply_tweet_id, parent_tweet_url, status')
            .eq('status', 'complete')
            .not('dub_reply_tweet_id', 'is', null);

        if (options.mentionId) {
            query = query.eq('tweet_id', options.mentionId);
        }

        const { data: mentions, error } = await query.order('created_at', { ascending: false });

        if (error) {
            logger.error('[📊 Metrics Collection] Error fetching mentions:', error);
            return;
        }

        if (!mentions || mentions.length === 0) {
            logger.warn('[📊 Metrics Collection] No completed mentions found');
            return;
        }

        logger.info(`[📊 Metrics Collection] Found ${mentions.length} completed mentions to process`);

        let successCount = 0;
        let errorCount = 0;
        let siblingCount = 0;

        for (const mention of mentions) {
            try {
                logger.info(`[📊 Metrics Collection] Collecting metrics for ${mention.tweet_id}...`);

                // Collect mention + dub reply + parent metrics
                const success = await collectMentionMetrics(mention.tweet_id);

                if (success) {
                    successCount++;

                    // Optionally collect sibling comment metrics for comparison
                    if (options.includesiblings && mention.parent_tweet_url) {
                        const sampleSize = options.sampleSize || 10;
                        const collected = await collectSiblingCommentMetrics(
                            mention.parent_tweet_url,
                            mention.tweet_id,
                            sampleSize
                        );
                        siblingCount += collected;
                    }
                } else {
                    errorCount++;
                }

                // Rate limit: 900 requests per 15 min = 1 per second
                // Being conservative with 2 second delay
                await sleep(2000);

            } catch (error: any) {
                if (error.code === 429) {
                    logger.warn('[📊 Metrics Collection] Rate limited. Waiting 15 minutes...');
                    await sleep(15 * 60 * 1000);
                    continue;
                }
                logger.error(`[📊 Metrics Collection] Error processing ${mention.tweet_id}:`, error);
                errorCount++;
            }
        }

        logger.info('\n[📊 Metrics Collection] ========================================');
        logger.info('[📊 Metrics Collection] Metrics Collection Complete!');
        logger.info(`[📊 Metrics Collection] Total processed: ${mentions.length}`);
        logger.info(`[📊 Metrics Collection] Successful: ${successCount}`);
        logger.info(`[📊 Metrics Collection] Errors: ${errorCount}`);
        if (options.includesiblings) {
            logger.info(`[📊 Metrics Collection] Sibling comments collected: ${siblingCount}`);
        }
        logger.info('[📊 Metrics Collection] ========================================');

        // Show preview of collected data
        const { data: previewData } = await supabase
            .from('tweet_metrics_latest')
            .select('tweet_type, impression_count, like_count')
            .limit(10);

        if (previewData && previewData.length > 0) {
            logger.info('\n[📊 Metrics Collection] Sample of collected metrics:');
            previewData.forEach(m => {
                logger.info(`  ${m.tweet_type}: ${m.impression_count} views, ${m.like_count} likes`);
            });
        }

        logger.info('\n[📊 Metrics Collection] Next steps:');
        logger.info('  1. Run: npx tsx scripts/generate-engagement-report.ts');
        logger.info('  2. View report in: reports/engagement-report.md');

    } catch (error) {
        logger.error('[📊 Metrics Collection] Fatal error:', error);
        process.exit(1);
    }
}

// Parse command line arguments
const args = process.argv.slice(2);
const options: any = {
    includeSiblings: false,
    sampleSize: 10
};

for (let i = 0; i < args.length; i++) {
    if (args[i] === '--include-siblings') {
        options.includeSiblings = true;
    } else if (args[i] === '--sample-size' && args[i + 1]) {
        options.sampleSize = parseInt(args[i + 1], 10);
        i++;
    } else if (args[i] === '--mention-id' && args[i + 1]) {
        options.mentionId = args[i + 1];
        i++;
    } else if (args[i] === '--help') {
        console.log(`
Collect Tweet Metrics

Usage:
  npx tsx scripts/collect-metrics.ts [options]

Options:
  --include-siblings    Also collect metrics for other comments on parent tweets (for comparison)
  --sample-size N       Number of sibling comments to sample (default: 10)
  --mention-id ID       Collect metrics for specific mention only
  --help                Show this help message

Examples:
  # Collect basic metrics for all completed dubs
  npx tsx scripts/collect-metrics.ts

  # Include sibling comment metrics for comparison
  npx tsx scripts/collect-metrics.ts --include-siblings

  # Collect for specific mention
  npx tsx scripts/collect-metrics.ts --mention-id 1989787665672388880

  # Collect with more sibling samples
  npx tsx scripts/collect-metrics.ts --include-siblings --sample-size 20
        `);
        process.exit(0);
    }
}

collectMetrics(options)
    .then(() => {
        logger.info('[📊 Metrics Collection] Script completed');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[📊 Metrics Collection] Script failed:', error);
        process.exit(1);
    });
