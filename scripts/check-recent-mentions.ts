#!/usr/bin/env tsx
/**
 * Check Recent Mentions
 *
 * Shows detailed breakdown of recent mentions and their data completeness
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function checkRecentMentions() {
    try {
        logger.info('[🔍 Check] Fetching recent mentions...');

        // Get last 7 days of mentions
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const { data: recentMentions, error: fetchError } = await supabase
            .from('mentions')
            .select('tweet_id, username, parent_username, parent_tweet_text_translated, target_language, status, created_at')
            .gte('created_at', sevenDaysAgo.toISOString())
            .order('created_at', { ascending: false });

        if (fetchError) {
            logger.error('[🔍 Check] Error fetching mentions:', fetchError);
            return;
        }

        if (!recentMentions || recentMentions.length === 0) {
            logger.info('[🔍 Check] No mentions found in last 7 days');
            return;
        }

        // Get metrics for these mentions
        const { data: existingMetrics, error: metricsError } = await supabase
            .from('tweet_metrics')
            .select('mention_id')
            .in('mention_id', recentMentions.map(m => m.tweet_id));

        if (metricsError) {
            logger.error('[🔍 Check] Error checking metrics:', metricsError);
            return;
        }

        const mentionsWithMetrics = new Set(existingMetrics?.map(m => m.mention_id) || []);

        // Group by day
        const byDay = recentMentions.reduce((acc, m) => {
            const date = new Date(m.created_at).toISOString().split('T')[0];
            if (!acc[date]) {
                acc[date] = {
                    total: 0,
                    byStatus: {} as Record<string, number>,
                    translated: 0,
                    hasMetrics: 0,
                    byParent: {} as Record<string, number>
                };
            }
            acc[date].total++;
            acc[date].byStatus[m.status] = (acc[date].byStatus[m.status] || 0) + 1;
            if (m.parent_tweet_text_translated) acc[date].translated++;
            if (mentionsWithMetrics.has(m.tweet_id)) acc[date].hasMetrics++;

            const parent = m.parent_username || 'Unknown';
            acc[date].byParent[parent] = (acc[date].byParent[parent] || 0) + 1;

            return acc;
        }, {} as Record<string, any>);

        console.log('\n========================================');
        console.log('📊 Recent Mentions (Last 7 Days)');
        console.log('========================================');
        console.log(`Total mentions: ${recentMentions.length}`);
        console.log(`\nBreakdown by day:`);
        console.log('========================================\n');

        Object.entries(byDay)
            .sort((a, b) => b[0].localeCompare(a[0]))
            .forEach(([date, data]) => {
                console.log(`📅 ${date}`);
                console.log(`   Total: ${data.total}`);
                console.log(`   Status: ${Object.entries(data.byStatus).map(([s, c]) => `${s}=${c}`).join(', ')}`);
                console.log(`   Translated: ${data.translated}/${data.total} (${Math.round(data.translated / data.total * 100)}%)`);
                console.log(`   Has Metrics: ${data.hasMetrics}/${data.total} (${Math.round(data.hasMetrics / data.total * 100)}%)`);

                const topParents = Object.entries(data.byParent)
                    .sort((a: any, b: any) => b[1] - a[1])
                    .slice(0, 3)
                    .map(([p, c]) => `@${p}:${c}`)
                    .join(', ');
                console.log(`   Top parents: ${topParents}`);
                console.log('');
            });

        // Show specific mentions needing backfill
        const needsTranslation = recentMentions.filter(m =>
            m.status === 'complete' && !m.parent_tweet_text_translated && m.target_language
        );

        const needsMetrics = recentMentions.filter(m =>
            m.status === 'complete' && !mentionsWithMetrics.has(m.tweet_id)
        );

        console.log('========================================');
        console.log('🔧 Backfill Needed');
        console.log('========================================');
        console.log(`Mentions needing translation: ${needsTranslation.length}`);
        console.log(`Mentions needing metrics: ${needsMetrics.length}`);

        if (needsTranslation.length > 0) {
            console.log('\n🌐 To backfill translations:');
            console.log('   npx tsx scripts/translate-parent-tweets.ts');
        }

        if (needsMetrics.length > 0) {
            console.log('\n📊 To collect metrics:');
            console.log('   npx tsx scripts/collect-mention-metrics.ts');
        }

        console.log('\n========================================\n');

    } catch (error) {
        logger.error('[🔍 Check] Fatal error:', error);
        process.exit(1);
    }
}

checkRecentMentions()
    .then(() => {
        logger.info('[🔍 Check] Check complete');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[🔍 Check] Script failed:', error);
        process.exit(1);
    });
