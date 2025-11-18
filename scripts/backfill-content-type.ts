#!/usr/bin/env tsx
/**
 * Backfill content_type for last 3 weeks of mentions
 *
 * Detects whether each mention is a Twitter Space or Video based on M3U8 URL patterns
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';
import { config } from '../src/utils/config';
import { detectContentType } from '../src/services/supabaseService';

const supabase = createClient(config.SUPABASE_URL, config.SUPABASE_SERVICE_KEY);

async function backfillContentType() {
    try {
        logger.info('[🔄 Backfill] Starting content_type backfill for last 3 weeks...');

        // Get date 3 weeks ago
        const threeWeeksAgo = new Date();
        threeWeeksAgo.setDate(threeWeeksAgo.getDate() - 21);

        // Fetch all mentions from last 3 weeks
        const { data: mentions, error: fetchError } = await supabase
            .from('mentions')
            .select('tweet_id, m3u8_url, content_type')
            .gte('created_at', threeWeeksAgo.toISOString())
            .order('created_at', { ascending: false });

        if (fetchError) {
            logger.error('[🔄 Backfill] Error fetching mentions:', fetchError);
            process.exit(1);
        }

        if (!mentions || mentions.length === 0) {
            logger.info('[🔄 Backfill] No mentions found in last 3 weeks');
            process.exit(0);
        }

        logger.info(`[🔄 Backfill] Found ${mentions.length} mentions from last 3 weeks`);

        // Stats
        let updated = 0;
        let alreadySet = 0;
        let noM3u8 = 0;
        const typeStats = {
            space: 0,
            video: 0,
            unknown: 0
        };

        // Update each mention
        for (const mention of mentions) {
            if (mention.content_type) {
                alreadySet++;
                typeStats[mention.content_type]++;
                continue;
            }

            if (!mention.m3u8_url) {
                noM3u8++;
                // Set to unknown if no M3U8 URL
                const { error: updateError } = await supabase
                    .from('mentions')
                    .update({ content_type: 'unknown' })
                    .eq('tweet_id', mention.tweet_id);

                if (updateError) {
                    logger.error(`[🔄 Backfill] Error updating ${mention.tweet_id}:`, updateError);
                } else {
                    typeStats.unknown++;
                    updated++;
                }
                continue;
            }

            // Detect content type from M3U8 URL
            const contentType = detectContentType(mention.m3u8_url);

            // Update in database
            const { error: updateError } = await supabase
                .from('mentions')
                .update({ content_type: contentType })
                .eq('tweet_id', mention.tweet_id);

            if (updateError) {
                logger.error(`[🔄 Backfill] Error updating ${mention.tweet_id}:`, updateError);
            } else {
                logger.debug(`[🔄 Backfill] Updated ${mention.tweet_id}: ${contentType}`);
                typeStats[contentType]++;
                updated++;
            }
        }

        // Print summary
        console.log('\n========================================');
        console.log('🔄 Content Type Backfill Summary');
        console.log('========================================');
        console.log(`Total mentions processed: ${mentions.length}`);
        console.log(`\nUpdates:`);
        console.log(`  - Updated: ${updated}`);
        console.log(`  - Already set: ${alreadySet}`);
        console.log(`  - No M3U8 URL: ${noM3u8}`);
        console.log(`\nContent Type Breakdown:`);
        console.log(`  - Spaces: ${typeStats.space}`);
        console.log(`  - Videos: ${typeStats.video}`);
        console.log(`  - Unknown: ${typeStats.unknown}`);
        console.log('========================================\n');

        logger.info('[🔄 Backfill] Backfill complete');
        process.exit(0);

    } catch (error) {
        logger.error('[🔄 Backfill] Fatal error:', error);
        process.exit(1);
    }
}

backfillContentType();
