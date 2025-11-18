#!/usr/bin/env tsx
/**
 * System Health Check
 *
 * Monitors key system metrics and alerts on issues
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';
import { config } from '../src/utils/config';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

interface HealthStatus {
    database: boolean;
    recent_mentions: boolean;
    failed_mentions: number;
    translation_rate: number;
    metrics_rate: number;
    avg_processing_time: number;
    pending_count: number;
    processing_count: number;
}

async function healthCheck(): Promise<void> {
    const checks: HealthStatus = {
        database: false,
        recent_mentions: false,
        failed_mentions: 0,
        translation_rate: 0,
        metrics_rate: 0,
        avg_processing_time: 0,
        pending_count: 0,
        processing_count: 0
    };

    try {
        logger.info('[🏥 Health Check] Starting system health check...');

        // 1. Database connectivity
        const { error: dbError } = await supabase
            .from('mentions')
            .select('count')
            .limit(1);

        checks.database = !dbError;

        if (!checks.database) {
            logger.error('[🏥 Health Check] ❌ Database connection failed:', dbError);
            printReport(checks, false);
            process.exit(1);
        }

        // 2. Recent mentions (last hour)
        const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
        const { data: recentMentions } = await supabase
            .from('mentions')
            .select('tweet_id')
            .gte('created_at', oneHourAgo);

        checks.recent_mentions = (recentMentions?.length || 0) > 0;

        // 3. Failed mentions (last 24 hours)
        const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
        const { data: failedMentions } = await supabase
            .from('mentions')
            .select('tweet_id')
            .in('status', ['failed', 'final_failure'])
            .gte('created_at', oneDayAgo);

        checks.failed_mentions = failedMentions?.length || 0;

        // 4. Pending and processing counts
        const { data: pendingMentions } = await supabase
            .from('mentions')
            .select('tweet_id')
            .eq('status', 'pending');

        checks.pending_count = pendingMentions?.length || 0;

        const { data: processingMentions } = await supabase
            .from('mentions')
            .select('tweet_id')
            .eq('status', 'processing');

        checks.processing_count = processingMentions?.length || 0;

        // 5. Translation coverage (last 24 hours)
        const { data: completeMentions } = await supabase
            .from('mentions')
            .select('tweet_id, parent_tweet_text_translated')
            .eq('status', 'complete')
            .gte('created_at', oneDayAgo);

        if (completeMentions && completeMentions.length > 0) {
            const translatedCount = completeMentions.filter(m => m.parent_tweet_text_translated).length;
            checks.translation_rate = (translatedCount / completeMentions.length) * 100;
        }

        // 6. Metrics coverage (last 7 days)
        const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
        const { data: recentComplete } = await supabase
            .from('mentions')
            .select('tweet_id')
            .eq('status', 'complete')
            .gte('created_at', sevenDaysAgo);

        if (recentComplete && recentComplete.length > 0) {
            const { data: metricsData } = await supabase
                .from('tweet_metrics')
                .select('mention_id')
                .in('mention_id', recentComplete.map(m => m.tweet_id));

            const uniqueMentionsWithMetrics = new Set(metricsData?.map(m => m.mention_id) || []);
            checks.metrics_rate = (uniqueMentionsWithMetrics.size / recentComplete.length) * 100;
        }

        // 7. Average processing time (last 24 hours)
        const { data: recentCompleteWithTimes } = await supabase
            .from('mentions')
            .select('created_at, updated_at')
            .eq('status', 'complete')
            .gte('created_at', oneDayAgo);

        if (recentCompleteWithTimes && recentCompleteWithTimes.length > 0) {
            const processingTimes = recentCompleteWithTimes.map(m => {
                const created = new Date(m.created_at).getTime();
                const updated = new Date(m.updated_at).getTime();
                return (updated - created) / (1000 * 60); // minutes
            });
            checks.avg_processing_time = processingTimes.reduce((a, b) => a + b, 0) / processingTimes.length;
        }

        // Print report
        printReport(checks, true);

        // Determine exit code based on critical issues
        const hasCriticalIssues =
            !checks.database ||
            checks.failed_mentions > 20 ||
            (checks.pending_count + checks.processing_count) > 100;

        if (hasCriticalIssues) {
            logger.warn('[🏥 Health Check] ⚠️  Critical issues detected!');
            process.exit(1);
        }

        logger.info('[🏥 Health Check] ✅ System health check passed');
        process.exit(0);

    } catch (error) {
        logger.error('[🏥 Health Check] Fatal error during health check:', error);
        printReport(checks, false);
        process.exit(1);
    }
}

function printReport(checks: HealthStatus, showDetails: boolean): void {
    console.log('\n========================================');
    console.log('🏥 System Health Check Report');
    console.log('========================================');
    console.log(`Timestamp: ${new Date().toISOString()}`);
    console.log('');

    // Database
    console.log(`Database Connection: ${checks.database ? '✅ Connected' : '❌ Failed'}`);

    if (!showDetails) {
        console.log('⚠️  Unable to retrieve additional metrics');
        console.log('========================================\n');
        return;
    }

    // Recent Activity
    console.log(`Recent Activity (1h): ${checks.recent_mentions ? '✅ Active' : '⚠️  No new mentions'}`);

    // Pending Queue
    const pendingStatus = checks.pending_count > 50 ? '⚠️' : checks.pending_count > 0 ? '📋' : '✅';
    console.log(`Pending Mentions: ${pendingStatus} ${checks.pending_count}`);

    const processingStatus = checks.processing_count > 20 ? '⚠️' : checks.processing_count > 0 ? '⚙️' : '✅';
    console.log(`Processing Mentions: ${processingStatus} ${checks.processing_count}`);

    // Failures
    const failureStatus = checks.failed_mentions > 10 ? '❌' : checks.failed_mentions > 5 ? '⚠️' : '✅';
    console.log(`Failed Mentions (24h): ${failureStatus} ${checks.failed_mentions}`);

    // Translation Coverage
    const translationStatus = checks.translation_rate > 90 ? '✅' : checks.translation_rate > 70 ? '⚠️' : '❌';
    console.log(`Translation Coverage: ${translationStatus} ${checks.translation_rate.toFixed(1)}%`);

    // Metrics Coverage
    const metricsStatus = checks.metrics_rate > 50 ? '✅' : checks.metrics_rate > 25 ? '⚠️' : '❌';
    console.log(`Metrics Coverage (7d): ${metricsStatus} ${checks.metrics_rate.toFixed(1)}%`);

    // Processing Time
    if (checks.avg_processing_time > 0) {
        const timeStatus = checks.avg_processing_time < 15 ? '✅' : checks.avg_processing_time < 30 ? '⚠️' : '❌';
        console.log(`Avg Processing Time: ${timeStatus} ${checks.avg_processing_time.toFixed(1)} min`);
    }

    console.log('========================================');

    // Recommendations
    const recommendations: string[] = [];

    if (checks.failed_mentions > 10) {
        recommendations.push('⚠️  High failure rate - investigate error messages');
    }
    if (checks.pending_count > 50) {
        recommendations.push('⚠️  Large pending queue - check daemon is running');
    }
    if (checks.translation_rate < 80) {
        recommendations.push('📝 Run translation backfill: npx tsx scripts/translate-parent-tweets.ts');
    }
    if (checks.metrics_rate < 50) {
        recommendations.push('📊 Run metrics collection: npx tsx scripts/collect-mention-metrics.ts');
    }
    if (checks.avg_processing_time > 20) {
        recommendations.push('🐌 Slow processing - check ElevenLabs API performance');
    }

    if (recommendations.length > 0) {
        console.log('\n💡 Recommendations:');
        recommendations.forEach(rec => console.log(`   ${rec}`));
        console.log('');
    }

    console.log('========================================\n');
}

// Run health check
healthCheck();
