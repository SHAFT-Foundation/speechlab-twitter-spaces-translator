#!/usr/bin/env tsx
/**
 * Backfill custom_category field based on category_mappings table
 * This maps Twitter's context annotations to the 16 custom categories
 */

import { createClient } from '@supabase/supabase-js';
import logger from '../src/utils/logger';

const SUPABASE_URL = 'https://cemuqqzmamjmtefodbqs.supabase.co';
const SUPABASE_SERVICE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNlbXVxcXptYW1qbXRlZm9kYnFzIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc1NjA3NTE3NCwiZXhwIjoyMDcxNjUxMTc0fQ.oyab1F0RzduXtHKPHuzocvvM0tHRtFFmWtNDh1cDtio';

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function backfillCustomCategories() {
    try {
        logger.info('[Backfill Custom Categories] Starting custom category backfill...');

        // First, ensure category_mappings table exists
        const { error: mappingCheckError } = await supabase
            .from('category_mappings')
            .select('count')
            .limit(1);

        if (mappingCheckError) {
            logger.error('[Backfill Custom Categories] Error: category_mappings table does not exist. Run migration 005_create_category_mapping.sql first.');
            logger.error(mappingCheckError);
            return;
        }

        // Fetch all mentions with parent_tweet_domains but no custom_category
        const { data: mentions, error } = await supabase
            .from('mentions')
            .select('tweet_id, parent_tweet_domains')
            .not('parent_tweet_domains', 'is', null)
            .order('created_at', { ascending: true });

        if (error) {
            logger.error('[Backfill Custom Categories] Error fetching mentions:', error);
            return;
        }

        if (!mentions || mentions.length === 0) {
            logger.info('[Backfill Custom Categories] No mentions to process');
            return;
        }

        logger.info(`[Backfill Custom Categories] Found ${mentions.length} mentions to process`);

        let updatedCount = 0;
        let skippedCount = 0;
        let errorCount = 0;

        for (const mention of mentions) {
            try {
                const domains = mention.parent_tweet_domains as any[];

                if (!domains || domains.length === 0) {
                    skippedCount++;
                    continue;
                }

                // Get all Twitter category names from the domains
                const twitterCategories = domains
                    .filter(d => d.domain_name)
                    .map(d => d.domain_name);

                if (twitterCategories.length === 0) {
                    skippedCount++;
                    continue;
                }

                // Look up mappings for all Twitter categories
                const { data: mappings, error: mappingError } = await supabase
                    .from('category_mappings')
                    .select('custom_category, priority')
                    .in('twitter_category', twitterCategories)
                    .order('priority', { ascending: true });

                if (mappingError) {
                    logger.error(`[Backfill Custom Categories] Error looking up mappings for ${mention.tweet_id}:`, mappingError);
                    errorCount++;
                    continue;
                }

                if (!mappings || mappings.length === 0) {
                    logger.warn(`[Backfill Custom Categories] No mapping found for ${mention.tweet_id} categories: ${twitterCategories.join(', ')}`);
                    skippedCount++;
                    continue;
                }

                // Get the highest priority (lowest number) custom category
                const customCategory = mappings[0].custom_category;

                logger.info(`[Backfill Custom Categories] Mapping ${mention.tweet_id}: ${twitterCategories[0]} → ${customCategory}`);

                // Update the mention with custom category
                const { error: updateError } = await supabase
                    .from('mentions')
                    .update({
                        custom_category: customCategory,
                        updated_at: new Date().toISOString()
                    })
                    .eq('tweet_id', mention.tweet_id);

                if (updateError) {
                    logger.error(`[Backfill Custom Categories] Error updating ${mention.tweet_id}:`, updateError);
                    errorCount++;
                } else {
                    updatedCount++;
                }

            } catch (error: any) {
                logger.error(`[Backfill Custom Categories] Error processing ${mention.tweet_id}:`, error);
                errorCount++;
            }
        }

        logger.info('\n[Backfill Custom Categories] ========================================');
        logger.info('[Backfill Custom Categories] Custom Category Backfill Complete!');
        logger.info(`[Backfill Custom Categories] Total processed: ${mentions.length}`);
        logger.info(`[Backfill Custom Categories] Updated: ${updatedCount}`);
        logger.info(`[Backfill Custom Categories] Skipped (no mapping): ${skippedCount}`);
        logger.info(`[Backfill Custom Categories] Errors: ${errorCount}`);
        logger.info('[Backfill Custom Categories] ========================================');

        // Show category distribution
        const { data: distribution, error: distError } = await supabase
            .from('mentions')
            .select('custom_category')
            .not('custom_category', 'is', null);

        if (!distError && distribution) {
            const counts: Record<string, number> = {};
            distribution.forEach(m => {
                const cat = m.custom_category;
                counts[cat] = (counts[cat] || 0) + 1;
            });

            logger.info('\n[Backfill Custom Categories] Category Distribution:');
            Object.entries(counts)
                .sort(([, a], [, b]) => b - a)
                .forEach(([category, count]) => {
                    logger.info(`  ${category}: ${count}`);
                });
        }

    } catch (error) {
        logger.error('[Backfill Custom Categories] Fatal error:', error);
        process.exit(1);
    }
}

backfillCustomCategories()
    .then(() => {
        logger.info('[Backfill Custom Categories] Script completed');
        process.exit(0);
    })
    .catch((error) => {
        logger.error('[Backfill Custom Categories] Script failed:', error);
        process.exit(1);
    });
