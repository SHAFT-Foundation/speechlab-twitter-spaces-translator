#!/usr/bin/env tsx
/**
 * Check for Twitter Spaces Dubbing Failures
 *
 * Diagnoses issues with Spaces M3U8 extraction and provides details
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';
import { config } from '../src/utils/config';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

async function checkSpacesFailures() {
    try {
        logger.info('[🔍 Spaces Check] Checking for Spaces-related failures...');

        // Get failures from last 7 days
        const sevenDaysAgo = new Date();
        sevenDaysAgo.setDate(sevenDaysAgo.getDate() - 7);

        const { data: failures, error } = await supabase
            .from('mentions')
            .select('tweet_id, username, tweet_text, tweet_url, error_message, parent_tweet_url, m3u8_url, status, retry_count, created_at')
            .in('status', ['failed', 'final_failure', 'processing'])
            .gte('created_at', sevenDaysAgo.toISOString())
            .order('created_at', { ascending: false });

        if (error) {
            logger.error('[🔍 Spaces Check] Error fetching failures:', error);
            return;
        }

        if (!failures || failures.length === 0) {
            logger.info('[🔍 Spaces Check] ✅ No failures found in last 7 days');
            return;
        }

        // Categorize failures
        const spacesFailures: any[] = [];
        const videoFailures: any[] = [];
        const m3u8Failures: any[] = [];
        const otherFailures: any[] = [];
        const stillProcessing: any[] = [];

        failures.forEach(f => {
            if (f.status === 'processing') {
                stillProcessing.push(f);
                return;
            }

            const errorMsg = (f.error_message || '').toLowerCase();
            const tweetText = (f.tweet_text || '').toLowerCase();

            if (errorMsg.includes('space') || tweetText.includes('space') || (f.tweet_url && f.tweet_url.includes('/spaces/'))) {
                spacesFailures.push(f);
            } else if (errorMsg.includes('m3u8')) {
                m3u8Failures.push(f);
            } else if (errorMsg.includes('video')) {
                videoFailures.push(f);
            } else {
                otherFailures.push(f);
            }
        });

        console.log('\n========================================');
        console.log('🔍 Twitter Spaces Failure Analysis');
        console.log('========================================');
        console.log(`Total failures (7 days): ${failures.length}`);
        console.log(`\nBreakdown:`);
        console.log(`  - Spaces-related: ${spacesFailures.length}`);
        console.log(`  - M3U8 extraction: ${m3u8Failures.length}`);
        console.log(`  - Video-related: ${videoFailures.length}`);
        console.log(`  - Still processing: ${stillProcessing.length}`);
        console.log(`  - Other: ${otherFailures.length}`);
        console.log('========================================\n');

        // Show Spaces failures
        if (spacesFailures.length > 0) {
            console.log('📡 Spaces-Related Failures:\n');
            spacesFailures.forEach((f, i) => {
                console.log(`${i + 1}. Tweet ID: ${f.tweet_id}`);
                console.log(`   User: @${f.username}`);
                console.log(`   Created: ${new Date(f.created_at).toLocaleString()}`);
                console.log(`   Status: ${f.status} (${f.retry_count} retries)`);
                console.log(`   Error: ${f.error_message || 'No error message'}`);
                console.log(`   Tweet: ${f.tweet_url}`);
                if (f.parent_tweet_url) {
                    console.log(`   Parent: ${f.parent_tweet_url}`);
                }
                if (f.m3u8_url) {
                    console.log(`   M3U8: ${f.m3u8_url}`);
                }
                console.log('');
            });
        }

        // Show M3U8 extraction failures
        if (m3u8Failures.length > 0) {
            console.log('🎬 M3U8 Extraction Failures:\n');
            m3u8Failures.forEach((f, i) => {
                console.log(`${i + 1}. Tweet ID: ${f.tweet_id}`);
                console.log(`   User: @${f.username}`);
                console.log(`   Error: ${f.error_message}`);
                console.log(`   Tweet: ${f.tweet_url}`);
                console.log('');
            });
        }

        // Show stuck processing
        if (stillProcessing.length > 0) {
            console.log('⏳ Still Processing (may be stuck):\n');
            stillProcessing.forEach((f, i) => {
                const age = Math.floor((Date.now() - new Date(f.created_at).getTime()) / (1000 * 60));
                console.log(`${i + 1}. Tweet ID: ${f.tweet_id}`);
                console.log(`   User: @${f.username}`);
                console.log(`   Age: ${age} minutes`);
                console.log(`   Status: ${f.status}`);
                console.log(`   Tweet: ${f.tweet_url}`);
                if (f.m3u8_url) {
                    console.log(`   M3U8: ${f.m3u8_url}`);
                }
                console.log('');
            });
        }

        console.log('========================================');
        console.log('💡 Recommendations:');
        console.log('========================================');

        if (spacesFailures.length > 0) {
            console.log('\n⚠️  Twitter Spaces Detection Issues:');
            console.log('   - Twitter may have changed Spaces UI/structure');
            console.log('   - Check Playwright selectors in mentionDaemon.ts');
            console.log('   - Test with: npx playwright test --headed');
            console.log('   - Check if spaces/*.com URLs have changed');
        }

        if (m3u8Failures.length > 0) {
            console.log('\n⚠️  M3U8 Extraction Failures:');
            console.log('   - Check network interception in Playwright');
            console.log('   - Verify M3U8 URL patterns still match');
            console.log('   - Check if Twitter CDN URLs changed');
        }

        if (stillProcessing.length > 0) {
            console.log('\n⚠️  Stuck in Processing:');
            console.log('   - These may need manual intervention');
            console.log('   - Check ElevenLabs project status');
            console.log('   - Consider resetting to pending if >2 hours old');
        }

        console.log('\n========================================\n');

    } catch (error) {
        logger.error('[🔍 Spaces Check] Fatal error:', error);
        process.exit(1);
    }
}

checkSpacesFailures()
    .then(() => {
        logger.info('[🔍 Spaces Check] Check complete');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[🔍 Spaces Check] Script failed:', error);
        process.exit(1);
    });
