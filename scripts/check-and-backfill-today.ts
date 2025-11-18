#!/usr/bin/env tsx
/**
 * Check and Backfill Today's Mentions
 *
 * Checks for mentions from today and backfills any missing data:
 * - Translated parent text
 * - Engagement metrics
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function checkAndBackfillToday() {
    try {
        logger.info('[🔍 Backfill] Checking today\'s mentions...');

        // Get start of today (UTC)
        const today = new Date();
        today.setUTCHours(0, 0, 0, 0);

        // Get all complete mentions from today
        const { data: todayMentions, error: fetchError } = await supabase
            .from('mentions')
            .select('tweet_id, username, parent_username, parent_tweet_url, parent_tweet_text, parent_tweet_text_translated, target_language, status, created_at')
            .eq('status', 'complete')
            .gte('created_at', today.toISOString())
            .order('created_at', { ascending: false });

        if (fetchError) {
            logger.error('[🔍 Backfill] Error fetching mentions:', fetchError);
            return;
        }

        if (!todayMentions || todayMentions.length === 0) {
            logger.info('[🔍 Backfill] No mentions found for today');
            return;
        }

        logger.info(`[🔍 Backfill] Found ${todayMentions.length} mentions from today`);

        // Count mentions needing translation
        const needsTranslation = todayMentions.filter(m =>
            !m.parent_tweet_text_translated && m.parent_tweet_text && m.target_language
        );

        // Check which mentions have metrics
        const { data: existingMetrics, error: metricsError } = await supabase
            .from('tweet_metrics')
            .select('mention_id')
            .in('mention_id', todayMentions.map(m => m.tweet_id));

        if (metricsError) {
            logger.error('[🔍 Backfill] Error checking metrics:', metricsError);
            return;
        }

        const mentionsWithMetrics = new Set(existingMetrics?.map(m => m.mention_id) || []);
        const needsMetrics = todayMentions.filter(m => !mentionsWithMetrics.has(m.tweet_id));

        // Print summary
        console.log('\n========================================');
        console.log('📊 Today\'s Mentions Summary');
        console.log('========================================');
        console.log(`Total mentions today: ${todayMentions.length}`);
        console.log(`\nBy status:`);
        console.log(`  - Complete: ${todayMentions.length}`);
        console.log(`\nBy parent user:`);

        // Group by parent username
        const byParent = todayMentions.reduce((acc, m) => {
            const parent = m.parent_username || 'Unknown';
            acc[parent] = (acc[parent] || 0) + 1;
            return acc;
        }, {} as Record<string, number>);

        Object.entries(byParent)
            .sort((a, b) => b[1] - a[1])
            .forEach(([parent, count]) => {
                console.log(`  - @${parent}: ${count}`);
            });

        console.log(`\nTranslation status:`);
        console.log(`  - Translated: ${todayMentions.length - needsTranslation.length}`);
        console.log(`  - Need translation: ${needsTranslation.length}`);

        console.log(`\nMetrics status:`);
        console.log(`  - Have metrics: ${todayMentions.length - needsMetrics.length}`);
        console.log(`  - Need metrics: ${needsMetrics.length}`);

        console.log('\n========================================');

        // Show mentions needing translation
        if (needsTranslation.length > 0) {
            console.log('\n🌐 Mentions needing translation:');
            needsTranslation.forEach(m => {
                console.log(`  - ${m.tweet_id} (@${m.username} -> @${m.parent_username}) [${m.target_language}]`);
            });
            console.log(`\nTo backfill translations, run:`);
            console.log(`  npx tsx scripts/translate-parent-tweets.ts`);
        }

        // Show mentions needing metrics
        if (needsMetrics.length > 0) {
            console.log('\n📊 Mentions needing metrics:');
            needsMetrics.slice(0, 10).forEach(m => {
                console.log(`  - ${m.tweet_id} (@${m.username} -> @${m.parent_username})`);
            });
            if (needsMetrics.length > 10) {
                console.log(`  ... and ${needsMetrics.length - 10} more`);
            }
            console.log(`\nTo collect metrics, run:`);
            console.log(`  npx tsx scripts/collect-mention-metrics.ts`);
        }

        console.log('\n========================================\n');

    } catch (error) {
        logger.error('[🔍 Backfill] Fatal error:', error);
        process.exit(1);
    }
}

checkAndBackfillToday()
    .then(() => {
        logger.info('[🔍 Backfill] Check complete');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[🔍 Backfill] Script failed:', error);
        process.exit(1);
    });
